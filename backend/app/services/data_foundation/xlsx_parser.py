from __future__ import annotations

import hashlib
import io
import json
import re
import unicodedata
import zipfile
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from typing import Callable, Iterator
from xml.etree import ElementTree as ET

from app.services.data_foundation.contracts import ContractColumn, SourceContract
from app.services.data_foundation.mapping_resolution import (
    CODE_RESOLUTION_SOURCES,
    normalize_mapping_name,
    resolve_name_candidates,
)


MAX_UNCOMPRESSED_WORKBOOK_BYTES = 512 * 1024 * 1024
MAX_PREVIEW_ERRORS = 1000
MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615
_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_BUILTIN_DATE_FORMATS = {
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32,
    33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
}


class WorkbookValidationError(ValueError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class MappingResolver:
    map_version_id: bytes | None = None
    base_codes: frozenset[str] = frozenset()
    exact_base_name_candidates: dict[str, tuple[str, ...]] = field(default_factory=dict)
    normalized_base_name_candidates: dict[str, tuple[str, ...]] = field(default_factory=dict)
    name_decisions: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    normalized_name_decisions: dict[str, tuple[str, str | None]] = field(default_factory=dict)


@dataclass(frozen=True)
class ValidImportRow:
    source_row_no: int
    values: dict[str, object]
    resolved_base_code: str | None
    mapping_resolution: str


@dataclass
class PreviewSummary:
    source_id: str
    file_sha256: str
    input_row_count: int = 0
    valid_row_count: int = 0
    invalid_row_count: int = 0
    exact_duplicate_count: int = 0
    duplicate_base_code_count: int = 0
    mapped_row_count: int = 0
    unmapped_row_count: int = 0
    exact_name_candidate_row_count: int = 0
    normalized_name_candidate_row_count: int = 0
    no_mapping_match_row_count: int = 0
    missing_identifier_row_count: int = 0
    ambiguous_row_count: int = 0
    mapping_version_available: bool = False
    map_version_id: bytes | None = None
    per_date_counts: dict[str, int] = field(default_factory=dict)
    bot_execution_id: str | None = None
    bot_executed_at: datetime | None = None
    collection_date: date | None = None
    workbook_validation_errors: list[str] = field(default_factory=list)
    error_counts: Counter[str] = field(default_factory=Counter)
    errors: list[dict[str, object]] = field(default_factory=list)

    @property
    def can_publish(self) -> bool:
        map_available = self.mapping_version_available or self.source_id == "base_mapping_official"
        return map_available and self.invalid_row_count == 0 and not self.workbook_validation_errors

    def add_error(self, row_no: int, column_key: str | None, code: str) -> None:
        self.error_counts[code] += 1
        if len(self.errors) < MAX_PREVIEW_ERRORS:
            self.errors.append({"rowNumber": row_no, "column": column_key, "code": code})

    def add_workbook_error(self, code: str) -> None:
        self.workbook_validation_errors.append(code)
        self.error_counts[code] += 1
        if len(self.errors) < MAX_PREVIEW_ERRORS:
            self.errors.append({"rowNumber": 0, "column": "workbook", "code": code})

    def as_api_dict(self) -> dict[str, object]:
        return {
            "sourceId": self.source_id,
            "fileSha256": self.file_sha256,
            "inputRowCount": self.input_row_count,
            "validRowCount": self.valid_row_count,
            "invalidRowCount": self.invalid_row_count,
            "duplicateCount": self.exact_duplicate_count,
            "duplicateBaseCodeCount": self.duplicate_base_code_count,
            "mappedRowCount": self.mapped_row_count,
            "unmappedRowCount": self.unmapped_row_count,
            "exactNameCandidateRowCount": self.exact_name_candidate_row_count,
            "normalizedNameCandidateRowCount": self.normalized_name_candidate_row_count,
            "noMappingMatchRowCount": self.no_mapping_match_row_count,
            "missingIdentifierRowCount": self.missing_identifier_row_count,
            "ambiguousRowCount": self.ambiguous_row_count,
            "mappingVersionAvailable": self.mapping_version_available,
            "mappingVersionId": str(uuid.UUID(bytes=self.map_version_id)) if self.map_version_id else None,
            "perDateCounts": dict(sorted(self.per_date_counts.items())),
            "botExecutionId": self.bot_execution_id,
            "botExecutedAt": self.bot_executed_at.isoformat(sep=" ") if self.bot_executed_at else None,
            "collectionDate": self.collection_date.isoformat() if self.collection_date else None,
            "errorCounts": dict(sorted(self.error_counts.items())),
            "errors": self.errors,
            "canPublish": self.can_publish,
        }


@dataclass(frozen=True)
class _RawCell:
    value: object
    numeric: bool = False
    date_style: bool = False
    formula: bool = False
    invalid: bool = False


def _column_index(reference: str) -> int:
    letters = re.match(r"([A-Z]+)", reference.upper())
    if not letters:
        raise WorkbookValidationError("workbook_cell_reference_invalid")
    value = 0
    for char in letters.group(1):
        value = value * 26 + ord(char) - ord("A") + 1
    return value - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        stream = archive.open("xl/sharedStrings.xml")
    except KeyError:
        return []
    values: list[str] = []
    try:
        for _event, element in ET.iterparse(stream, events=("end",)):
            if element.tag == f"{{{_NS_MAIN}}}si":
                values.append("".join(
                    node.text or ""
                    for node in element.iter(f"{{{_NS_MAIN}}}t")
                ))
                element.clear()
    except ET.ParseError:
        raise WorkbookValidationError("workbook_xml_invalid") from None
    finally:
        stream.close()
    return values


def _is_date_format(format_code: str) -> bool:
    # Remove quoted literals, escaped characters, and color/condition clauses.
    cleaned = re.sub(r'"[^"]*"', "", format_code)
    cleaned = re.sub(r"\\.", "", cleaned)
    cleaned = re.sub(r"\[[^]]*\]", "", cleaned)
    return bool(re.search(r"[ymdhis]", cleaned, flags=re.IGNORECASE))


def _date_style_ids(archive: zipfile.ZipFile) -> set[int]:
    try:
        root = ET.fromstring(archive.read("xl/styles.xml"))
    except KeyError:
        return set()
    except ET.ParseError:
        raise WorkbookValidationError("workbook_xml_invalid") from None
    custom_formats = {
        int(node.attrib["numFmtId"]): node.attrib.get("formatCode", "")
        for node in root.findall(f".//{{{_NS_MAIN}}}numFmt")
        if "numFmtId" in node.attrib
    }
    date_ids = set(_BUILTIN_DATE_FORMATS)
    date_ids.update(fmt_id for fmt_id, code in custom_formats.items() if _is_date_format(code))
    cell_xfs = root.find(f"{{{_NS_MAIN}}}cellXfs")
    if cell_xfs is None:
        return set()
    return {
        index
        for index, xf in enumerate(cell_xfs)
        if int(xf.attrib.get("numFmtId", "0")) in date_ids
    }


def _sheet_path(archive: zipfile.ZipFile, expected_sheet: str) -> str:
    try:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, ET.ParseError):
        raise WorkbookValidationError("workbook_structure_invalid") from None

    relationship_targets = {
        item.attrib["Id"]: item.attrib["Target"]
        for item in relationships.findall(f"{{{_NS_REL_PKG}}}Relationship")
        if item.attrib.get("Id") and item.attrib.get("Target")
    }
    matches = [
        item for item in workbook.findall(f".//{{{_NS_MAIN}}}sheet")
        if item.attrib.get("name") == expected_sheet
    ]
    if len(matches) != 1:
        raise WorkbookValidationError("workbook_sheet_mismatch")
    relationship_id = matches[0].attrib.get(f"{{{_NS_REL_DOC}}}id")
    target = relationship_targets.get(relationship_id or "")
    if not target:
        raise WorkbookValidationError("workbook_sheet_unavailable")
    normalized = PurePosixPath("xl") / PurePosixPath(target)
    if target.startswith("/"):
        normalized = PurePosixPath(target.lstrip("/"))
    path = str(normalized)
    if path.startswith("../") or not path.startswith("xl/"):
        raise WorkbookValidationError("workbook_sheet_unavailable")
    try:
        archive.getinfo(path)
    except KeyError:
        raise WorkbookValidationError("workbook_sheet_unavailable") from None
    return path


def _date_1904(archive: zipfile.ZipFile) -> bool:
    try:
        root = ET.fromstring(archive.read("xl/workbook.xml"))
    except (KeyError, ET.ParseError):
        raise WorkbookValidationError("workbook_structure_invalid") from None
    properties = root.find(f"{{{_NS_MAIN}}}workbookPr")
    return properties is not None and properties.attrib.get("date1904", "0").lower() in {"1", "true"}


def _cell_value(cell: ET.Element, shared: list[str], date_styles: set[int]) -> _RawCell:
    cell_type = cell.attrib.get("t", "n")
    style_id = int(cell.attrib.get("s", "0"))
    formula = cell.find(f"{{{_NS_MAIN}}}f") is not None
    value_element = cell.find(f"{{{_NS_MAIN}}}v")
    raw_value = value_element.text if value_element is not None else None
    if cell_type == "inlineStr":
        inline = cell.find(f"{{{_NS_MAIN}}}is")
        raw: object = "" if inline is None else "".join(
            node.text or "" for node in inline.iter(f"{{{_NS_MAIN}}}t")
        )
    elif raw_value is None:
        raw = None
    elif cell_type == "s":
        try:
            raw = shared[int(raw_value)]
        except (IndexError, ValueError):
            return _RawCell(None, invalid=True)
    elif cell_type in {"str", "e"}:
        raw = raw_value
    elif cell_type == "b":
        raw = raw_value == "1"
    elif cell_type == "n":
        try:
            raw = Decimal(raw_value)
        except InvalidOperation:
            return _RawCell(None, invalid=True)
    else:
        return _RawCell(None, invalid=True)
    return _RawCell(
        value=raw,
        numeric=cell_type == "n" and raw_value is not None,
        date_style=style_id in date_styles,
        formula=formula,
        invalid=False,
    )


def _iter_sheet_rows(
    archive: zipfile.ZipFile,
    sheet_path: str,
    shared: list[str],
    date_styles: set[int],
) -> Iterator[tuple[int, dict[int, _RawCell]]]:
    stream = archive.open(sheet_path)
    implicit_row_no = 0
    try:
        for _event, element in ET.iterparse(stream, events=("end",)):
            if element.tag != f"{{{_NS_MAIN}}}row":
                continue
            implicit_row_no += 1
            try:
                row_no = int(element.attrib.get("r", implicit_row_no))
            except ValueError:
                raise WorkbookValidationError("workbook_row_reference_invalid") from None
            cells: dict[int, _RawCell] = {}
            implicit_column = 0
            for cell in element.findall(f"{{{_NS_MAIN}}}c"):
                reference = cell.attrib.get("r", "")
                column_no = _column_index(reference) if reference else implicit_column
                implicit_column = column_no + 1
                cells[column_no] = _cell_value(cell, shared, date_styles)
            yield row_no, cells
            element.clear()
    except ET.ParseError:
        raise WorkbookValidationError("workbook_xml_invalid") from None
    finally:
        stream.close()


def _excel_datetime(value: Decimal, uses_1904_epoch: bool) -> datetime:
    if not value.is_finite() or value < 0:
        raise ValueError("date_invalid")
    whole_days = int(value)
    fraction = value - Decimal(whole_days)
    microseconds = int((fraction * Decimal(86_400_000_000)).to_integral_value())
    if microseconds >= 86_400_000_000:
        whole_days += 1
        microseconds -= 86_400_000_000
    epoch = datetime(1904, 1, 1) if uses_1904_epoch else datetime(1899, 12, 30)
    try:
        return epoch + timedelta(days=whole_days, microseconds=microseconds)
    except (OverflowError, ValueError):
        raise ValueError("date_invalid") from None


def _normalized_header(value: str) -> str:
    # NFC makes canonically equivalent accents compare the same; it does not
    # remove accents, case, punctuation, or aliases.
    return unicodedata.normalize("NFC", value)


def _cell_as_value(
    raw_cell: _RawCell | None,
    column: ContractColumn,
    uses_1904_epoch: bool,
) -> tuple[object | None, str | None]:
    cell = raw_cell or _RawCell(None)
    if cell.formula:
        return None, "formula_not_allowed"
    if cell.invalid:
        return None, "cell_value_invalid"
    value = cell.value
    if value is None or value == "":
        if column.nullable:
            return None, None
        return None, "value_required"

    if column.kind == "TEXT":
        if not isinstance(value, str):
            return None, "text_type_invalid"
        if not value.strip():
            if column.nullable:
                return None, None
            return None, "value_required"
        if column.max_length and len(value) > column.max_length:
            return None, "text_too_long"
        return value, None

    if column.kind == "BASE_CODE":
        if isinstance(value, Decimal) and cell.numeric and column.numeric_code_allowed:
            if not value.is_finite() or value < 0 or value != value.to_integral_value():
                return None, "base_code_numeric_invalid"
            value = format(value.quantize(Decimal(1)), "f")
        if not isinstance(value, str):
            return None, "base_code_type_invalid"
        if not value.strip():
            return None, "value_required"
        if len(value) > (column.max_length or 64) or any(ord(char) < 32 for char in value):
            return None, "base_code_invalid"
        return value, None

    if column.kind in {"DATE", "DATETIME"}:
        if not isinstance(value, Decimal) or not cell.numeric or not cell.date_style:
            return None, "date_type_invalid"
        try:
            parsed = _excel_datetime(value, uses_1904_epoch)
        except ValueError as error:
            return None, str(error)
        if column.kind == "DATE":
            if parsed.time() != datetime.min.time():
                return None, "date_time_not_allowed"
            return parsed.date(), None
        return parsed, None

    if column.kind == "INTEGER":
        if not isinstance(value, Decimal) or not cell.numeric or not value.is_finite():
            return None, "number_type_invalid"
        if value < 0 or value != value.to_integral_value() or value > MAX_UNSIGNED_BIGINT:
            return None, "integer_out_of_range"
        return int(value), None

    if column.kind == "DECIMAL":
        if not isinstance(value, Decimal) or not cell.numeric or not value.is_finite():
            return None, "number_type_invalid"
        normalized = value.normalize()
        fractional_digits = max(0, -normalized.as_tuple().exponent)
        integer_digits = max(0, normalized.adjusted() + 1) if normalized else 0
        if fractional_digits > 24 or integer_digits > 14:
            return None, "decimal_out_of_range"
        return value, None

    return None, "contract_type_unsupported"


def _date_key(row: dict[str, object]) -> date | None:
    candidate = row.get("data_date")
    if isinstance(candidate, date) and not isinstance(candidate, datetime):
        return candidate
    deadline = row.get("deadline_at")
    if isinstance(deadline, datetime):
        return deadline.date()
    return None


def _metadata_header_key(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    ascii_text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]", "", ascii_text.lower())


def _metadata_row(
    cells: dict[int, _RawCell],
    header_indexes: dict[str, int],
    date_styles: set[int],
    uses_1904_epoch: bool,
) -> dict[str, object | None]:
    result: dict[str, object | None] = {}
    for key, index in header_indexes.items():
        cell = cells.get(index)
        if cell is None or cell.formula or cell.invalid:
            result[key] = None
        else:
            value = cell.value
            if isinstance(value, Decimal) and cell.numeric and cell.date_style:
                try:
                    value = _excel_datetime(value, uses_1904_epoch)
                except ValueError:
                    value = None
            result[key] = value
    return result


def _parse_metadata_datetime(value: object | None) -> datetime | None:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("T", " ")
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime(text, pattern)
        except ValueError:
            continue
    return None


def _parse_metadata_date(value: object | None) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    for pattern in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _nonnegative_metadata_integer(value: object | None) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        return None
    if not number.is_finite() or number < 0 or number != number.to_integral_value():
        return None
    return int(number)


def _metadata_has_errors(value: object | None) -> bool:
    if value is None or value is False or value == 0:
        return False
    if isinstance(value, str):
        normalized = _metadata_header_key(value)
        return normalized not in {"", "0", "false", "nao", "nenhum", "nenhumerro", "[]", "null", "none"}
    return True


def _validate_no_movement_metadata(
    archive: zipfile.ZipFile,
    shared: list[str],
    date_styles: set[int],
    uses_1904_epoch: bool,
) -> tuple[str | None, datetime | None, date | None, int | None, int | None, str | None]:
    expected_dictionary_fields = {
        "scanAgentName", "dutyCode", "dutyName", "total", "halfwayCount", "day1", "day2",
        "day3", "day4", "day5", "day6", "day7", "day10", "day14", "day30",
        "operateTime", "dayRate14", "dayRate30",
    }
    try:
        dictionary_path = _sheet_path(archive, "Dicionario")
        dictionary_rows = iter(_iter_sheet_rows(archive, dictionary_path, shared, date_styles))
        dictionary_header_row, dictionary_header = next(dictionary_rows)
        if dictionary_header_row != 1:
            return None, None, None, None, None, "no_movement_dictionary_invalid"
        dictionary_indexes = {
            _metadata_header_key(cell.value): index
            for index, cell in dictionary_header.items()
            if isinstance(cell.value, str)
        }
        source_field_index = dictionary_indexes.get("nomeoriginaldocampo")
        identification_index = dictionary_indexes.get("statusdaidentificacao")
        if source_field_index is None or identification_index is None:
            return None, None, None, None, None, "no_movement_dictionary_invalid"
        dictionary_fields: set[str] = set()
        dictionary_field_count = 0
        dictionary_confirmed = True
        for _row_no, cells in dictionary_rows:
            field_cell = cells.get(source_field_index)
            status_cell = cells.get(identification_index)
            if field_cell and isinstance(field_cell.value, str) and field_cell.value.strip():
                dictionary_field_count += 1
                dictionary_fields.add(field_cell.value.strip())
                dictionary_confirmed = dictionary_confirmed and bool(
                    status_cell and isinstance(status_cell.value, str)
                    and "confirmado" in _metadata_header_key(status_cell.value)
                )
        if dictionary_field_count != len(expected_dictionary_fields) or dictionary_fields != expected_dictionary_fields or not dictionary_confirmed:
            return None, None, None, None, None, "no_movement_dictionary_invalid"

        executions_path = _sheet_path(archive, "Execucoes")
        execution_rows = iter(_iter_sheet_rows(archive, executions_path, shared, date_styles))
        execution_header_row, execution_header = next(execution_rows)
        if execution_header_row != 1:
            return None, None, None, None, None, "no_movement_execution_metadata_invalid"
        raw_header_indexes = {
            _metadata_header_key(cell.value): index
            for index, cell in execution_header.items()
            if isinstance(cell.value, str)
        }
        aliases = {
            "execution_id": ("iddaexecucao",),
            "executed_at": ("dataehorariodaexecucao",),
            "received_count": ("quantidadederegistrosrecebidos",),
            "page_count": ("quantidadedepaginasconsultadas",),
            "status": ("situacaodaexecucao",),
            "errors": ("erros",),
            "collection_date": ("datadacoleta",),
        }
        execution_indexes = {
            key: next((raw_header_indexes.get(alias) for alias in choices if raw_header_indexes.get(alias) is not None), None)
            for key, choices in aliases.items()
        }
        if any(index is None for index in execution_indexes.values()):
            return None, None, None, None, None, "no_movement_execution_metadata_invalid"
        parsed_executions: list[dict[str, object | None]] = []
        for _row_no, cells in execution_rows:
            if not any(cell.value not in (None, "") for cell in cells.values()):
                continue
            row = _metadata_row(cells, {key: int(index) for key, index in execution_indexes.items()}, date_styles, uses_1904_epoch)
            row["executed_at"] = _parse_metadata_datetime(row.get("executed_at"))
            row["collection_date"] = _parse_metadata_date(row.get("collection_date"))
            parsed_executions.append(row)
        if not parsed_executions:
            return None, None, None, None, None, "no_movement_execution_metadata_missing"
        if any(
            not isinstance(row.get("executed_at"), datetime)
            or not isinstance(row.get("execution_id"), str)
            or not str(row["execution_id"]).strip()
            for row in parsed_executions
        ):
            return None, None, None, None, None, "no_movement_execution_metadata_invalid"
        parsed_executions.sort(key=lambda row: row["executed_at"] if isinstance(row["executed_at"], datetime) else datetime.min)
        latest = parsed_executions[-1]
        execution_at = latest.get("executed_at")
        execution_id = latest.get("execution_id")
        if not isinstance(execution_at, datetime) or not isinstance(execution_id, str) or not execution_id.strip():
            return None, None, None, None, None, "no_movement_execution_metadata_invalid"
        if sum(row.get("executed_at") == execution_at for row in parsed_executions) != 1:
            return None, None, None, None, None, "no_movement_execution_metadata_ambiguous"
        status = _metadata_header_key(latest.get("status"))
        successful = status in {"sucesso", "success", "concluido", "concluida"}
        received_count = _nonnegative_metadata_integer(latest.get("received_count"))
        page_count = _nonnegative_metadata_integer(latest.get("page_count"))
        collection_date = latest.get("collection_date")
        has_errors = _metadata_has_errors(latest.get("errors"))
        failure = (
            "no_movement_execution_not_successful" if not successful
            else "no_movement_execution_has_errors" if has_errors
            else "no_movement_execution_metadata_invalid" if received_count is None or page_count is None or not isinstance(collection_date, date)
            else "no_movement_execution_page_count_invalid" if received_count > 0 and (page_count < 1 or page_count > received_count)
            else None
        )
        return execution_id.strip(), execution_at, collection_date if isinstance(collection_date, date) else None, received_count, page_count, failure
    except (WorkbookValidationError, StopIteration, KeyError, ValueError):
        return None, None, None, None, None, "no_movement_execution_metadata_invalid"


def _resolve_mapping(
    source_id: str,
    row: dict[str, object],
    resolver: MappingResolver,
) -> tuple[str | None, str]:
    if source_id == "base_mapping_official":
        return None, "MAP_ENTRY"
    if source_id in CODE_RESOLUTION_SOURCES:
        code = row.get("source_base_code")
        code_text = str(code).strip() if code is not None else ""
        if code_text and code_text in resolver.base_codes:
            return code_text, "CODE_MATCH"
        if code_text:
            # A supplied but unknown official code is authoritative; do not
            # silently replace it with a name-based candidate.
            return None, "UNMAPPED"

    base_name = row.get("source_base_name")
    if not isinstance(base_name, str) or not base_name.strip():
        return None, "MISSING_IDENTIFIER"
    candidates = resolver.exact_base_name_candidates.get(base_name, ())
    normalized_candidates = resolver.normalized_base_name_candidates.get(
        normalize_mapping_name(base_name), ()
    ) if not candidates else ()
    decision = resolver.name_decisions.get(base_name)
    if decision is None and not candidates:
        decision = resolver.normalized_name_decisions.get(normalize_mapping_name(base_name))
    return resolve_name_candidates(
        exact_candidates=candidates,
        normalized_candidates=normalized_candidates,
        decision=decision,
    )


def parse_workbook(
    content: bytes,
    contract: SourceContract,
    resolver: MappingResolver | None = None,
    *,
    on_valid_row: Callable[[ValidImportRow], None] | None = None,
) -> PreviewSummary:
    if not content:
        raise WorkbookValidationError("workbook_empty", 400)
    file_hash = hashlib.sha256(content).hexdigest()
    summary = PreviewSummary(source_id=contract.source_id, file_sha256=file_hash)
    mapping = resolver or MappingResolver()
    summary.mapping_version_available = mapping.map_version_id is not None
    summary.map_version_id = mapping.map_version_id

    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None
    with archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED_WORKBOOK_BYTES:
            raise WorkbookValidationError("workbook_uncompressed_size_exceeded", 413)
        if any(info.filename.startswith("/") or ".." in PurePosixPath(info.filename).parts for info in archive.infolist()):
            raise WorkbookValidationError("workbook_archive_path_invalid")
        sheet_path = _sheet_path(archive, contract.sheet_name)
        shared = _shared_strings(archive)
        date_styles = _date_style_ids(archive)
        uses_1904_epoch = _date_1904(archive)

        rows = _iter_sheet_rows(archive, sheet_path, shared, date_styles)
        try:
            first_row_no, header_cells = next(rows)
        except StopIteration:
            raise WorkbookValidationError("workbook_header_missing") from None
        if first_row_no != contract.header_row:
            raise WorkbookValidationError("workbook_header_row_mismatch")
        if any(cell.formula or cell.invalid for cell in header_cells.values()):
            raise WorkbookValidationError("workbook_header_invalid")
        actual_headers = [
            header_cells.get(index, _RawCell(None)).value
            for index in range(len(contract.columns))
        ]
        nonempty_extra = any(
            index >= len(contract.columns) and cell.value not in (None, "")
            for index, cell in header_cells.items()
        )
        if nonempty_extra or any(not isinstance(header, str) for header in actual_headers):
            raise WorkbookValidationError("workbook_header_mismatch")
        normalized_actual = tuple(_normalized_header(value) for value in actual_headers)
        normalized_expected = tuple(_normalized_header(value) for value in contract.headers)
        if normalized_actual != normalized_expected:
            raise WorkbookValidationError("workbook_header_mismatch")
        if len(set(normalized_actual)) != len(normalized_actual):
            raise WorkbookValidationError("workbook_header_duplicate")

        seen_row_hashes: set[bytes] = set()
        seen_base_codes: set[str] = set()
        expected_row_no = contract.header_row + 1

        no_movement_received_count: int | None = None
        no_movement_page_count: int | None = None
        if contract.source_id == "no_movement" and contract.version >= 2:
            (
                summary.bot_execution_id,
                summary.bot_executed_at,
                summary.collection_date,
                no_movement_received_count,
                no_movement_page_count,
                metadata_error,
            ) = _validate_no_movement_metadata(archive, shared, date_styles, uses_1904_epoch)
            if metadata_error:
                summary.add_workbook_error(metadata_error)

        def process_row(row_no: int, cells: dict[int, _RawCell]) -> None:
            nonlocal expected_row_no
            summary.input_row_count += 1
            row_errors: list[tuple[str | None, str]] = []
            raw_identity = [
                None if cells.get(index) is None else cells[index].value
                for index in range(len(contract.columns))
            ]
            raw_key = json.dumps(
                [str(value) if isinstance(value, Decimal) else value for value in raw_identity],
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
                default=str,
            ).encode("utf-8")
            row_hash = hashlib.sha256(raw_key).digest()
            if row_hash in seen_row_hashes:
                summary.exact_duplicate_count += 1
            else:
                seen_row_hashes.add(row_hash)

            if not cells or all(cell.value in (None, "") for cell in cells.values()):
                row_errors.append((None, "empty_row"))
            if any(cell.formula for cell in cells.values()):
                row_errors.append((None, "formula_not_allowed"))
            if any(cell.invalid for cell in cells.values()):
                row_errors.append((None, "cell_value_invalid"))
            if any(index >= len(contract.columns) and cell.value not in (None, "") for index, cell in cells.items()):
                row_errors.append((None, "unexpected_column_value"))

            values: dict[str, object] = {}
            for index, column in enumerate(contract.columns):
                value, error = _cell_as_value(cells.get(index), column, uses_1904_epoch)
                if error:
                    row_errors.append((column.key, error))
                else:
                    values[column.key] = value

            code_key = (
                "source_base_code" if contract.source_id == "no_movement"
                else "base_code" if contract.source_id == "base_mapping_official"
                else None
            )
            if code_key and code_key in values:
                code = str(values[code_key])
                if code in seen_base_codes:
                    summary.duplicate_base_code_count += 1
                    if contract.source_id != "no_movement":
                        row_errors.append((code_key, "duplicate_base_code"))
                else:
                    seen_base_codes.add(code)

            if contract.source_id == "no_movement" and contract.version >= 2:
                aging_keys = (
                    "stopped_over_1_day", "stopped_over_2_days", "stopped_over_3_days",
                    "stopped_over_4_days", "stopped_over_5_days", "stopped_over_6_days",
                    "stopped_over_7_days", "stopped_over_10_days", "stopped_over_14_days",
                    "stopped_over_30_days",
                )
                if all(isinstance(values.get(key), int) for key in aging_keys) and isinstance(values.get("stopped_orders"), int):
                    if sum(int(values[key]) for key in aging_keys) != values["stopped_orders"]:
                        row_errors.append(("stopped_orders", "aging_total_mismatch"))

            if row_errors:
                summary.invalid_row_count += 1
                for column_key, code in row_errors:
                    summary.add_error(row_no, column_key, code)
                return

            summary.valid_row_count += 1
            source_code = values.get("source_base_code")
            source_name = values.get("source_base_name")
            has_source_code = source_code is not None and bool(str(source_code).strip())
            if isinstance(source_name, str) and source_name.strip():
                if source_name in mapping.exact_base_name_candidates:
                    summary.exact_name_candidate_row_count += 1
                elif normalize_mapping_name(source_name) in mapping.normalized_base_name_candidates:
                    summary.normalized_name_candidate_row_count += 1
            keyed_date = _date_key(values)
            if keyed_date:
                date_key = keyed_date.isoformat()
                summary.per_date_counts[date_key] = summary.per_date_counts.get(date_key, 0) + 1
            resolved_code, resolution = _resolve_mapping(contract.source_id, values, mapping)
            if resolved_code is not None:
                summary.mapped_row_count += 1
            elif resolution == "UNMAPPED" and (has_source_code or (isinstance(source_name, str) and source_name.strip())):
                summary.no_mapping_match_row_count += 1
                summary.unmapped_row_count += 1
            elif resolution == "MAP_ENTRY":
                pass
            elif resolution == "MISSING_IDENTIFIER":
                summary.missing_identifier_row_count += 1
                summary.unmapped_row_count += 1
            elif resolution == "AMBIGUOUS":
                summary.ambiguous_row_count += 1
                summary.unmapped_row_count += 1
            else:
                summary.unmapped_row_count += 1
            if on_valid_row:
                on_valid_row(ValidImportRow(row_no, values, resolved_code, resolution))

        for row_no, cells in rows:
            while expected_row_no < row_no:
                process_row(expected_row_no, {})
                expected_row_no += 1
            if row_no < expected_row_no:
                raise WorkbookValidationError("workbook_row_order_invalid")
            process_row(row_no, cells)
            expected_row_no = row_no + 1

    if contract.source_id == "no_movement" and contract.version >= 2:
        if no_movement_received_count != summary.input_row_count:
            summary.add_workbook_error("no_movement_execution_row_count_mismatch")
        if summary.input_row_count > 0 and (no_movement_page_count is None or no_movement_page_count < 1):
            summary.add_workbook_error("no_movement_execution_page_count_invalid")

    return summary
