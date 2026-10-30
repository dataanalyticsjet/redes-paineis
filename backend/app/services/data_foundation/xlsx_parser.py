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
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path, PurePosixPath
from typing import Callable, Iterator
from xml.etree import ElementTree as ET

from app.services.data_foundation.contracts import ContractColumn, SourceContract
from app.services.data_foundation.mapping_resolution import (
    CODE_RESOLUTION_SOURCES,
    code_only_mapping,
    normalize_mapping_name,
    resolve_name_candidates,
)


MAX_UNCOMPRESSED_WORKBOOK_BYTES = 512 * 1024 * 1024
MAX_UNCOMPRESSED_COLLECTION_MONITORING_T4_T5_BYTES = 1024 * 1024 * 1024
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
    source_sheet_name: str | None = None
    source_sheet_row_no: int | None = None


@dataclass
class PreviewSummary:
    source_id: str
    file_sha256: str
    contract_version: int = 1
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
    export_metadata_confirmed_by_user_id: int | None = None
    export_metadata_confirmed_at: datetime | None = None
    execution_period_start: date | None = None
    execution_period_end: date | None = None
    execution_page_count: int | None = None
    semantic_warnings: list[str] = field(default_factory=list)
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
            "contractVersion": self.contract_version,
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
            **({
                "exportMetadataSource": "ADMIN_CONFIRMATION" if self.export_metadata_confirmed_by_user_id else "BOT_METADATA" if self.bot_executed_at else "UNKNOWN",
                "exportMetadataConfirmedByUserId": self.export_metadata_confirmed_by_user_id,
                "exportMetadataConfirmedAt": self.export_metadata_confirmed_at.isoformat(sep=" ") if self.export_metadata_confirmed_at else None,
            } if self.source_id == "no_movement" else {}),
            "executionPeriodStart": self.execution_period_start.isoformat() if self.execution_period_start else None,
            "executionPeriodEnd": self.execution_period_end.isoformat() if self.execution_period_end else None,
            "executionPageCount": self.execution_page_count,
            "semanticWarnings": self.semantic_warnings,
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
    matches = _sheet_paths(archive)
    try:
        return matches[expected_sheet]
    except KeyError:
        raise WorkbookValidationError("workbook_sheet_mismatch") from None


def _sheet_paths(archive: zipfile.ZipFile) -> dict[str, str]:
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
    paths: dict[str, str] = {}
    for item in workbook.findall(f".//{{{_NS_MAIN}}}sheet"):
        name = item.attrib.get("name")
        relationship_id = item.attrib.get(f"{{{_NS_REL_DOC}}}id")
        target = relationship_targets.get(relationship_id or "")
        if not name or not target or name in paths:
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
        paths[name] = path
    return paths


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


def _max_uncompressed_workbook_bytes(contract: SourceContract) -> int:
    if contract.source_id == "collection_monitoring_t4_t5" and contract.version == 1:
        return MAX_UNCOMPRESSED_COLLECTION_MONITORING_T4_T5_BYTES
    if contract.source_id == "collection_monitoring_t4_t5" and contract.version == 2:
        return 256 * 1024 * 1024
    return MAX_UNCOMPRESSED_WORKBOOK_BYTES


def _cell_as_value(
    raw_cell: _RawCell | None,
    column: ContractColumn,
    uses_1904_epoch: bool,
    *,
    allow_numeric_text: bool = False,
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
        if isinstance(value, Decimal) and cell.numeric and allow_numeric_text:
            if not value.is_finite() or value < 0 or value != value.to_integral_value():
                return None, "text_numeric_invalid"
            significant_digits = max(1, value.adjusted() + 1) if value else 1
            if significant_digits > 15:
                return None, "text_numeric_precision_exceeded"
            value = format(value.quantize(Decimal(1)), "f")
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


def _collection_rate_execution_datetime(value: object | None) -> datetime | None:
    if isinstance(value, str) and (value.endswith("Z") or re.search(r"[+-]\d{2}:?\d{2}$", value)):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            return None
    return _parse_metadata_datetime(value)


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

        try:
            executions_path = _sheet_path(archive, "Execucoes")
        except WorkbookValidationError:
            return None, None, None, None, None, "no_movement_execution_metadata_missing"
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
    contract_version: int = 1,
) -> tuple[str | None, str]:
    if source_id == "base_mapping_official":
        return None, "MAP_ENTRY"
    if code_only_mapping(source_id, contract_version):
        code = row.get("source_base_code")
        code_text = str(code).strip() if code is not None else ""
        if code_text == "-":
            code_text = ""
        if code_text and code_text in resolver.base_codes:
            return code_text, "CODE_MATCH"
        if code_text:
            # A supplied but unknown official code is authoritative; do not
            # silently replace it with a name-based candidate.
            return None, "UNMAPPED"
        return None, "MISSING_IDENTIFIER"

    if source_id in CODE_RESOLUTION_SOURCES:
        code = row.get("source_base_code")
        code_text = str(code).strip() if code is not None else ""
        if code_text and code_text in resolver.base_codes:
            return code_text, "CODE_MATCH"
        if code_text:
            # A supplied but unknown official code remains authoritative.
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


def _pdd_date_sheet_name(name: str) -> date | None:
    if not re.fullmatch(r"\d{2}-\d{2}-\d{4}", name):
        return None
    try:
        return datetime.strptime(name, "%d-%m-%Y").date()
    except ValueError:
        raise WorkbookValidationError("pdd_daily_sheet_date_invalid") from None


def _pdd_header_indexes(
    header_cells: dict[int, _RawCell],
    expected_headers: tuple[str, ...],
    *,
    error_code: str,
) -> dict[str, int]:
    actual = [header_cells.get(index, _RawCell(None)).value for index in range(len(expected_headers))]
    if any(not isinstance(value, str) for value in actual):
        raise WorkbookValidationError(error_code)
    if any(index >= len(expected_headers) and cell.value not in (None, "") for index, cell in header_cells.items()):
        raise WorkbookValidationError(error_code)
    if tuple(_normalized_header(value) for value in actual) != tuple(
        _normalized_header(value) for value in expected_headers
    ):
        raise WorkbookValidationError(error_code)
    return {header: index for index, header in enumerate(expected_headers)}


def _pdd_metadata_rows(
    archive: zipfile.ZipFile,
    sheet_path: str,
    shared: list[str],
    date_styles: set[int],
) -> tuple[dict[str, int], list[dict[int, _RawCell]]]:
    rows = iter(_iter_sheet_rows(archive, sheet_path, shared, date_styles))
    try:
        header_row_no, header_cells = next(rows)
    except StopIteration:
        raise WorkbookValidationError("pdd_metadata_sheet_invalid") from None
    if header_row_no != 1:
        raise WorkbookValidationError("pdd_metadata_sheet_invalid")
    headers = {
        _metadata_header_key(cell.value): index
        for index, cell in header_cells.items()
        if isinstance(cell.value, str)
    }
    data_rows = [cells for _row_no, cells in rows if any(cell.value not in (None, "") for cell in cells.values())]
    return headers, data_rows


def _pdd_metadata_integer(cell: _RawCell | None) -> int | None:
    if cell is None or not isinstance(cell.value, Decimal) or not cell.numeric:
        return None
    value = cell.value
    if not value.is_finite() or value < 0 or value != value.to_integral_value() or value > MAX_UNSIGNED_BIGINT:
        return None
    return int(value)


def _pdd_metadata_date(cell: _RawCell | None, uses_1904_epoch: bool) -> date | None:
    if cell is None:
        return None
    if isinstance(cell.value, str):
        try:
            return date.fromisoformat(cell.value[:10])
        except ValueError:
            return None
    value, error = _cell_as_value(cell, ContractColumn("metadata_date", "Data", "DATE"), uses_1904_epoch)
    return value if error is None and isinstance(value, date) else None


def _validate_pdd_v2_metadata(
    archive: zipfile.ZipFile,
    sheet_paths: dict[str, str],
    shared: list[str],
    date_styles: set[int],
    uses_1904_epoch: bool,
    per_date: dict[date, dict[str, int]],
    summary: PreviewSummary,
) -> None:
    normalized_sheet_names = {_metadata_header_key(name): name for name in sheet_paths}
    summary_sheet_name = normalized_sheet_names.get("resumodiario")
    execution_sheet_name = normalized_sheet_names.get("execucao")
    dictionary_sheet_name = normalized_sheet_names.get("dicionario")
    if not summary_sheet_name or not execution_sheet_name or not dictionary_sheet_name:
        summary.add_workbook_error("pdd_required_metadata_sheet_missing")
        return

    summary_headers, summary_rows = _pdd_metadata_rows(
        archive, sheet_paths[summary_sheet_name], shared, date_styles
    )
    required_summary_headers = {
        "dataconsiderada": 0,
        "quantidadederegistros": 1,
        "qtdpedidosabipar": 2,
        "qtdpedidosnaobipadosnorecebimentodacoleta": 3,
        "qtdpedidosnaobipadosnacoleta": 4,
        "qtddepacotescomfaltadebipedeenvio": 5,
    }
    if any(key not in summary_headers for key in required_summary_headers):
        summary.add_workbook_error("pdd_daily_summary_headers_invalid")
        return

    expected_dates: dict[date, dict[str, int]] = {}
    summary_keys = (
        "rows", "total_orders", "orders_unscanned_at_receipt",
        "orders_unscanned_at_collection", "packages_missing_dispatch_scan",
    )
    header_keys = tuple(required_summary_headers)
    for cells in summary_rows:
        data_date = _pdd_metadata_date(cells.get(summary_headers[header_keys[0]]), uses_1904_epoch)
        values = [
            _pdd_metadata_integer(cells.get(summary_headers[key]))
            for key in header_keys[1:]
        ]
        if data_date is None or any(value is None for value in values) or data_date in expected_dates:
            summary.add_workbook_error("pdd_daily_summary_values_invalid")
            return
        expected_dates[data_date] = dict(zip(summary_keys, (int(value) for value in values), strict=True))
    if expected_dates != per_date:
        summary.add_workbook_error("pdd_daily_summary_reconciliation_mismatch")

    execution_headers, execution_rows = _pdd_metadata_rows(
        archive, sheet_paths[execution_sheet_name], shared, date_styles
    )
    execution_columns = {
        "last_update": ("ultim aatualizacao".replace(" ", ""), "ultimaatualizacao"),
        "period_start": ("periodoinicial",),
        "period_end": ("periodofinal",),
        "record_count": ("quantidadederegistros",),
        "page_count": ("quantidadedepaginas",),
        "status": ("situacaodaexecucao",),
    }
    execution_indexes = {
        key: next((execution_headers[alias] for alias in aliases if alias in execution_headers), None)
        for key, aliases in execution_columns.items()
    }
    if any(index is None for index in execution_indexes.values()) or len(execution_rows) != 1:
        summary.add_workbook_error("pdd_execution_metadata_invalid")
        return
    execution = execution_rows[0]
    status_cell = execution.get(int(execution_indexes["status"]))
    status = _metadata_header_key(status_cell.value if status_cell else None)
    record_count = _pdd_metadata_integer(execution.get(int(execution_indexes["record_count"])))
    page_count = _pdd_metadata_integer(execution.get(int(execution_indexes["page_count"])))
    execution_at_cell = execution.get(int(execution_indexes["last_update"]))
    execution_at_value, execution_at_error = _cell_as_value(
        execution_at_cell, ContractColumn("executed_at", "Última atualização", "DATETIME"), uses_1904_epoch
    )
    period_start_cell = execution.get(int(execution_indexes["period_start"]))
    period_end_cell = execution.get(int(execution_indexes["period_end"]))
    period_start = _pdd_metadata_date(period_start_cell, uses_1904_epoch)
    period_end = _pdd_metadata_date(period_end_cell, uses_1904_epoch)
    expected_start = min(per_date) if per_date else None
    expected_end = max(per_date) if per_date else None
    if (
        status not in {"sucesso", "success"}
        or record_count != summary.input_row_count
        or page_count is None or (record_count and page_count < 1)
        or execution_at_error or not isinstance(execution_at_value, datetime)
        or period_start != expected_start or period_end != expected_end
    ):
        summary.add_workbook_error("pdd_execution_reconciliation_mismatch")
        return
    summary.bot_executed_at = execution_at_value
    summary.execution_period_start = period_start
    summary.execution_period_end = period_end
    summary.execution_page_count = page_count

    dictionary_headers, dictionary_rows = _pdd_metadata_rows(
        archive, sheet_paths[dictionary_sheet_name], shared, date_styles
    )
    if not {"campooriginaldaapi", "traducaoutilizada", "statusdaidentificacao"}.issubset(dictionary_headers):
        summary.add_workbook_error("pdd_dictionary_headers_invalid")
        return
    dictionary_fields_index = dictionary_headers["campooriginaldaapi"]
    dictionary_translations_index = dictionary_headers["traducaoutilizada"]
    dictionary_status_index = dictionary_headers["statusdaidentificacao"]
    expected_dictionary = {
        "createtime": "dataconsiderada",
        "agentcode": "codigodaregionaldopddresponsavel",
        "agentname": "nomedaregionaldopddresponsavel",
        "networkcode": "codigodabase",
        "networkname": "nomedopddresponsavel",
        "ordersourcecode": "codigodaorigemdopedido",
        "ordersourcename": "origemdopedido",
        "totalnum": "qtdpedidosabipar",
        "warehousenum": "qtdpedidosnaobipadosnorecebimentodacoleta",
        "warehouseratio": "taxadepedidosnaobipadosnorecebimentodacoleta",
        "takingnum": "qtdpedidosnaobipadosnacoleta",
        "takingratio": "taxadefaltadebipagemnacoleta",
        "sendnum": "qtddepacotescomfaltadebipedeenvio",
        "sendratio": "taxadepedidosnaobipadosnaexpedicao",
        "totalratio": "taxageraldefaltadebipagem",
    }
    dictionary_mapping: dict[str, str] = {}
    dictionary_confirmed = True
    for cells in dictionary_rows:
        source_cell = cells.get(dictionary_fields_index)
        translated_cell = cells.get(dictionary_translations_index)
        status_cell = cells.get(dictionary_status_index)
        source = _metadata_header_key(source_cell.value if source_cell else None)
        translated = _metadata_header_key(translated_cell.value if translated_cell else None)
        status = _metadata_header_key(status_cell.value if status_cell else None)
        if source == "daykey":
            continue
        if not source or not translated or source in dictionary_mapping:
            summary.add_workbook_error("pdd_dictionary_mapping_invalid")
            return
        dictionary_mapping[source] = translated
        dictionary_confirmed = dictionary_confirmed and "confirmad" in status
    if dictionary_mapping != expected_dictionary or not dictionary_confirmed:
        summary.add_workbook_error("pdd_dictionary_identification_unconfirmed")


_COLLECTION_RATE_V2_SOURCE_FIELDS = (
    "datetime", "proxyAreaCode", "proxyAreaName", "pickNetworkCode", "pickNetworkName",
    "orderSourceCode", "orderSourcename", "expressTypeCode", "expressTypeName", "totalCount",
    "shouldTakingNum", "cancelTotalCount", "pickRateTotal", "pickcount", "nopickcount",
    "agingNoTakingNum", "timelyTakingNum", "overtimeNoTakingNum", "overtimeTakingNum",
    "timelyPickRateTotal", "timelyTryTakingNum", "timelyRate", "averageTakingNum",
    "problemNum", "noProblemNum", "shopRate", "shouldShopNum", "noShouldShopNum",
)
_COLLECTION_RATE_V2_PENDING_FIELDS = (
    "agingNoTakingNum", "timelyTryTakingNum", "averageTakingNum",
    "shopRate", "shouldShopNum", "noShouldShopNum",
)
_COLLECTION_RATE_V2_RATE_FIELDS = (
    "collection_rate_reported", "collection_on_time_rate_reported",
    "punctuality_rate_pending", "seller_collection_rate_pending",
)
_COLLECTION_RATE_V3_SOURCE_FIELDS = (
    "datetime", "proxyAreaName", "pickNetworkName", "orderSourcename", "expressTypeName",
    "totalCount", "shouldTakingNum", "cancelTotalCount", "pickRateTotal", "pickcount",
    "nopickcount", "agingNoTakingNum", "timelyTakingNum", "timelyPickRateTotal",
    "timelyTryTakingNum", "timelyRate", "averageTakingNum", "problemNum", "noProblemNum",
    "shopRate", "shouldShopNum", "noShouldShopNum",
)
_COLLECTION_RATE_V3_PENDING_FIELDS = (
    "agingNoTakingNum", "timelyTryTakingNum", "timelyRate", "averageTakingNum",
    "shopRate", "shouldShopNum", "noShouldShopNum",
)
_COLLECTION_RATE_V3_RATE_KEYS = (
    "collection_rate", "collection_on_time_rate", "collection_rate_with_attempts",
    "seller_collection_rate",
)


def _collection_rate_v2_value(
    cell: _RawCell | None,
    column: ContractColumn,
    uses_1904_epoch: bool,
) -> tuple[object | None, str | None]:
    if column.key == "data_date" and cell is not None and isinstance(cell.value, str):
        raw = cell.value.strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return None, "date_type_invalid"
        try:
            parsed = date.fromisoformat(raw)
        except ValueError:
            return None, "date_invalid"
        if parsed.isoformat() != raw:
            return None, "date_invalid"
        return parsed, None
    return _cell_as_value(cell, column, uses_1904_epoch)


def _parse_collection_rate_v2_workbook(
    content: bytes,
    contract: SourceContract,
    mapping: MappingResolver,
    summary: PreviewSummary,
    on_valid_row: Callable[[ValidImportRow], None] | None,
) -> PreviewSummary:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None

    with archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED_WORKBOOK_BYTES:
            raise WorkbookValidationError("workbook_uncompressed_size_exceeded", 413)
        if any(info.filename.startswith("/") or ".." in PurePosixPath(info.filename).parts for info in archive.infolist()):
            raise WorkbookValidationError("workbook_archive_path_invalid")
        sheet_paths = _sheet_paths(archive)
        normalized_sheets = {_metadata_header_key(name): path for name, path in sheet_paths.items()}
        required_sheets = {"dados", "execucao", "dicionario"}
        if set(normalized_sheets) != required_sheets:
            summary.add_workbook_error("collection_rate_required_sheets_invalid")
            return summary
        shared = _shared_strings(archive)
        date_styles = _date_style_ids(archive)
        uses_1904_epoch = _date_1904(archive)

        data_rows = iter(_iter_sheet_rows(archive, normalized_sheets["dados"], shared, date_styles))
        try:
            header_row_no, header_cells = next(data_rows)
        except StopIteration:
            summary.add_workbook_error("workbook_header_missing")
            return summary
        if header_row_no != contract.header_row:
            summary.add_workbook_error("workbook_header_row_mismatch")
            return summary
        try:
            _pdd_header_indexes(
                header_cells, contract.headers, error_code="workbook_header_mismatch"
            )
        except WorkbookValidationError as error:
            summary.add_workbook_error(error.code)
            return summary

        execution_headers, execution_rows = _pdd_metadata_rows(
            archive, normalized_sheets["execucao"], shared, date_styles
        )
        execution_columns = {
            "bot_name": "nomedobot",
            "executed_at": "dataehorariodacoleta",
            "period_start": "datainicialconsultada",
            "period_end": "datafinalconsultada",
            "record_count": "totalderegistros",
            "page_count": "totaldepaginas",
            "status": "status",
            "duration": "duracaosegundos",
        }
        if any(key not in execution_headers for key in execution_columns.values()) or not execution_rows:
            summary.add_workbook_error("collection_rate_execution_metadata_invalid")
            return summary
        execution_records = [
            _metadata_row(
                cells,
                {key: execution_headers[header_key] for key, header_key in execution_columns.items()},
                date_styles,
                uses_1904_epoch,
            )
            for cells in execution_rows
        ]
        parsed_records = [
            (record, _collection_rate_execution_datetime(record["executed_at"]))
            for record in execution_records
        ]
        if any(executed_at is None for _record, executed_at in parsed_records):
            summary.add_workbook_error("collection_rate_execution_metadata_invalid")
            return summary
        latest_execution_at = max(executed_at for _record, executed_at in parsed_records if executed_at is not None)
        if sum(executed_at == latest_execution_at for _record, executed_at in parsed_records) != 1:
            summary.add_workbook_error("collection_rate_execution_metadata_ambiguous")
            return summary
        execution = next(record for record, executed_at in parsed_records if executed_at == latest_execution_at)
        execution_name = _metadata_header_key(execution["bot_name"])
        execution_status = _metadata_header_key(execution["status"])
        execution_count = _nonnegative_metadata_integer(execution["record_count"])
        execution_pages = _nonnegative_metadata_integer(execution["page_count"])
        try:
            execution_duration = Decimal(str(execution["duration"]).strip())
        except (InvalidOperation, ValueError, AttributeError):
            execution_duration = None
        period_start = _parse_metadata_date(execution["period_start"])
        period_end = _parse_metadata_date(execution["period_end"])
        if (
            execution_name != "taxadecoleta"
            or execution_status not in {"sucesso", "success", "concluido", "concluida"}
            or execution_count is None
            or execution_pages is None
            or execution_duration is None
            or not execution_duration.is_finite()
            or execution_duration < 0
            or period_start is None
            or period_end is None
            or period_start > period_end
            or (execution_count > 0 and (execution_pages < 1 or execution_pages > execution_count))
        ):
            summary.add_workbook_error("collection_rate_execution_reconciliation_mismatch")
            return summary

        dictionary_headers, dictionary_rows = _pdd_metadata_rows(
            archive, normalized_sheets["dicionario"], shared, date_styles
        )
        dictionary_columns = {
            "source": "campooriginal",
            "translation": "nometraduzido",
            "description": "descricao",
            "status": "situacaodatraducao",
        }
        if any(key not in dictionary_headers for key in dictionary_columns.values()):
            summary.add_workbook_error("collection_rate_dictionary_headers_invalid")
            return summary
        expected_dictionary = dict(zip(_COLLECTION_RATE_V2_SOURCE_FIELDS, contract.headers, strict=True))
        observed_dictionary: dict[str, str] = {}
        for cells in dictionary_rows:
            source_cell = cells.get(dictionary_headers[dictionary_columns["source"]])
            translation_cell = cells.get(dictionary_headers[dictionary_columns["translation"]])
            source = source_cell.value if source_cell is not None else None
            translation = translation_cell.value if translation_cell is not None else None
            if not isinstance(source, str) or not isinstance(translation, str) or source in observed_dictionary:
                summary.add_workbook_error("collection_rate_dictionary_mapping_invalid")
                return summary
            observed_dictionary[source] = translation
        if list(observed_dictionary.items()) != list(expected_dictionary.items()):
            summary.add_workbook_error("collection_rate_dictionary_mapping_invalid")
            return summary
        summary.semantic_warnings = [
            f"{field}: significado operacional pendente de validação no JMS"
            for field in _COLLECTION_RATE_V2_PENDING_FIELDS
        ]

        seen_row_hashes: set[bytes] = set()
        seen_base_codes: set[str] = set()
        for row_no, cells in data_rows:
            summary.input_row_count += 1
            errors: list[tuple[str | None, str]] = []
            raw_identity = [
                None if cells.get(index) is None else cells[index].value
                for index in range(len(contract.columns))
            ]
            raw_key = json.dumps(
                [str(value) if isinstance(value, Decimal) else value for value in raw_identity],
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
            digest = hashlib.sha256(raw_key).digest()
            if digest in seen_row_hashes:
                summary.exact_duplicate_count += 1
            else:
                seen_row_hashes.add(digest)
            if not cells or all(cell.value in (None, "") for cell in cells.values()):
                errors.append((None, "empty_row"))
            if any(cell.formula for cell in cells.values()):
                errors.append((None, "formula_not_allowed"))
            if any(cell.invalid for cell in cells.values()):
                errors.append((None, "cell_value_invalid"))
            if any(index >= len(contract.columns) and cell.value not in (None, "") for index, cell in cells.items()):
                errors.append((None, "unexpected_column_value"))

            values: dict[str, object] = {}
            for index, column in enumerate(contract.columns):
                value, error = _collection_rate_v2_value(cells.get(index), column, uses_1904_epoch)
                if error:
                    errors.append((column.key, error))
                else:
                    values[column.key] = value
            for rate_key in _COLLECTION_RATE_V2_RATE_FIELDS:
                rate = values.get(rate_key)
                if isinstance(rate, Decimal) and not Decimal(0) <= rate <= Decimal(1):
                    errors.append((rate_key, "rate_out_of_range"))
            data_date = values.get("data_date")
            if isinstance(data_date, date) and (data_date < period_start or data_date > period_end):
                errors.append(("data_date", "collection_rate_row_date_outside_execution_period"))

            source_code = values.get("source_base_code")
            if isinstance(source_code, str):
                if source_code in seen_base_codes:
                    summary.duplicate_base_code_count += 1
                seen_base_codes.add(source_code)
            if errors:
                summary.invalid_row_count += 1
                for column_key, error_code in errors:
                    summary.add_error(row_no, column_key, error_code)
                continue

            summary.valid_row_count += 1
            assert isinstance(data_date, date)
            date_key = data_date.isoformat()
            summary.per_date_counts[date_key] = summary.per_date_counts.get(date_key, 0) + 1
            resolved_code, resolution = _resolve_mapping(
                contract.source_id, values, mapping, contract.version
            )
            if resolved_code is not None:
                summary.mapped_row_count += 1
            else:
                summary.unmapped_row_count += 1
                if resolution == "UNMAPPED":
                    summary.no_mapping_match_row_count += 1
                elif resolution == "MISSING_IDENTIFIER":
                    summary.missing_identifier_row_count += 1
            if on_valid_row:
                on_valid_row(ValidImportRow(
                    source_row_no=row_no,
                    values=values,
                    resolved_base_code=resolved_code,
                    mapping_resolution=resolution,
                ))

        summary.bot_executed_at = latest_execution_at
        summary.execution_period_start = period_start
        summary.execution_period_end = period_end
        summary.execution_page_count = execution_pages
        if execution_count != summary.input_row_count:
            summary.add_workbook_error("collection_rate_execution_row_count_mismatch")
    return summary


def _parse_collection_rate_v3_workbook(
    content: bytes,
    contract: SourceContract,
    mapping: MappingResolver,
    summary: PreviewSummary,
    on_valid_row: Callable[[ValidImportRow], None] | None,
) -> PreviewSummary:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None

    with archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED_WORKBOOK_BYTES:
            raise WorkbookValidationError("workbook_uncompressed_size_exceeded", 413)
        if any(info.filename.startswith("/") or ".." in PurePosixPath(info.filename).parts for info in archive.infolist()):
            raise WorkbookValidationError("workbook_archive_path_invalid")
        sheet_paths = _sheet_paths(archive)
        normalized_sheets = {_metadata_header_key(name): path for name, path in sheet_paths.items()}
        if set(normalized_sheets) != {"dados", "execucao", "dicionario"}:
            summary.add_workbook_error("collection_rate_required_sheets_invalid")
            return summary

        shared = _shared_strings(archive)
        date_styles = _date_style_ids(archive)
        uses_1904_epoch = _date_1904(archive)
        data_rows = iter(_iter_sheet_rows(archive, normalized_sheets["dados"], shared, date_styles))
        try:
            header_row_no, header_cells = next(data_rows)
        except StopIteration:
            summary.add_workbook_error("workbook_header_missing")
            return summary
        if header_row_no != contract.header_row:
            summary.add_workbook_error("workbook_header_row_mismatch")
            return summary
        try:
            _pdd_header_indexes(header_cells, contract.headers, error_code="workbook_header_mismatch")
        except WorkbookValidationError as error:
            summary.add_workbook_error(error.code)
            return summary

        execution_headers, execution_rows = _pdd_metadata_rows(
            archive, normalized_sheets["execucao"], shared, date_styles
        )
        execution_columns = {
            "bot_name": "nomedobot",
            "executed_at": "dataehorariodacoleta",
            "period_start": "datainicialconsultada",
            "period_end": "datafinalconsultada",
            "record_count": "totalderegistros",
            "page_count": "totaldepaginas",
            "status": "status",
            "duration": "duracaosegundos",
            "method": "metododecoleta",
            "task_id": "iddatarefajms",
        }
        required_execution_keys = set(execution_columns) - {"page_count", "task_id"}
        if not execution_rows or any(execution_columns[key] not in execution_headers for key in required_execution_keys):
            summary.add_workbook_error("collection_rate_execution_metadata_invalid")
            return summary
        execution_indexes = {
            key: execution_headers[header_key]
            for key, header_key in execution_columns.items()
            if header_key in execution_headers
        }
        execution_records = [
            _metadata_row(cells, execution_indexes, date_styles, uses_1904_epoch)
            for cells in execution_rows
        ]
        parsed_records = [
            (record, _collection_rate_execution_datetime(record.get("executed_at")))
            for record in execution_records
        ]
        if any(executed_at is None for _record, executed_at in parsed_records):
            summary.add_workbook_error("collection_rate_execution_metadata_invalid")
            return summary
        latest_execution_at = max(
            executed_at for _record, executed_at in parsed_records if executed_at is not None
        )
        if sum(executed_at == latest_execution_at for _record, executed_at in parsed_records) != 1:
            summary.add_workbook_error("collection_rate_execution_metadata_ambiguous")
            return summary
        execution = next(record for record, executed_at in parsed_records if executed_at == latest_execution_at)
        execution_name = _metadata_header_key(execution.get("bot_name"))
        execution_status = _metadata_header_key(execution.get("status"))
        execution_method = _metadata_header_key(execution.get("method"))
        execution_count = _nonnegative_metadata_integer(execution.get("record_count"))
        execution_pages = _nonnegative_metadata_integer(execution.get("page_count"))
        try:
            execution_duration = Decimal(str(execution.get("duration")).strip())
        except (InvalidOperation, ValueError, AttributeError):
            execution_duration = None
        period_start = _parse_metadata_date(execution.get("period_start"))
        period_end = _parse_metadata_date(execution.get("period_end"))
        period_end_datetime = _parse_metadata_datetime(execution.get("period_end"))
        if (
            execution_name != "taxadecoleta"
            or execution_status not in {"sucesso", "success", "concluido", "concluida"}
            or execution_method not in {"exportacaooficialjms", "jms"}
            or execution_count is None
            or execution_duration is None
            or not execution_duration.is_finite()
            or execution_duration < 0
            or period_start is None
            or period_end is None
            or period_start > period_end
            or (execution_pages is not None and execution_count > 0 and (execution_pages < 1 or execution_pages > execution_count))
        ):
            summary.add_workbook_error("collection_rate_execution_reconciliation_mismatch")
            return summary

        task_id = execution.get("task_id")
        if isinstance(task_id, Decimal) and task_id.is_finite() and task_id == task_id.to_integral_value():
            summary.bot_execution_id = format(task_id.quantize(Decimal(1)), "f")
        elif isinstance(task_id, str) and task_id.strip():
            summary.bot_execution_id = task_id.strip()

        dictionary_headers, dictionary_rows = _pdd_metadata_rows(
            archive, normalized_sheets["dicionario"], shared, date_styles
        )
        dictionary_columns = {
            "source": "campoapi",
            "translation": "titulooficialjms",
            "description": "descricaoemportugues",
            "status": "statusdeconfirmacaodacorrespondencia",
        }
        if any(key not in dictionary_headers for key in dictionary_columns.values()):
            summary.add_workbook_error("collection_rate_dictionary_headers_invalid")
            return summary
        expected_dictionary = dict(zip(_COLLECTION_RATE_V3_SOURCE_FIELDS, contract.headers, strict=True))
        observed_dictionary: dict[str, str] = {}
        dictionary_confirmed = True
        for cells in dictionary_rows:
            source_cell = cells.get(dictionary_headers[dictionary_columns["source"]])
            translation_cell = cells.get(dictionary_headers[dictionary_columns["translation"]])
            status_cell = cells.get(dictionary_headers[dictionary_columns["status"]])
            source = source_cell.value if source_cell else None
            translation = translation_cell.value if translation_cell else None
            status = _metadata_header_key(status_cell.value if status_cell else None)
            if not isinstance(source, str) or not isinstance(translation, str) or source in observed_dictionary:
                summary.add_workbook_error("collection_rate_dictionary_mapping_invalid")
                return summary
            observed_dictionary[source] = translation
            dictionary_confirmed = dictionary_confirmed and "confirmad" in status
        if list(observed_dictionary.items()) != list(expected_dictionary.items()):
            summary.add_workbook_error("collection_rate_dictionary_mapping_invalid")
            return summary
        if not dictionary_confirmed:
            summary.add_workbook_error("collection_rate_dictionary_identification_unconfirmed")
            return summary

        summary.semantic_warnings = [
            f"{field}: significado operacional ou agregação pendente de validação no JMS"
            for field in _COLLECTION_RATE_V3_PENDING_FIELDS
        ]
        exact_duplicates: set[bytes] = set()
        negative_average_count = 0
        last_data_date: date | None = None
        for row_no, cells in data_rows:
            summary.input_row_count += 1
            errors: list[tuple[str | None, str]] = []
            raw_identity = [
                None if cells.get(index) is None else cells[index].value
                for index in range(len(contract.columns))
            ]
            raw_key = json.dumps(
                [str(value) if isinstance(value, Decimal) else value for value in raw_identity],
                ensure_ascii=False, separators=(",", ":"), default=str,
            ).encode("utf-8")
            digest = hashlib.sha256(raw_key).digest()
            if digest in exact_duplicates:
                summary.exact_duplicate_count += 1
            else:
                exact_duplicates.add(digest)
            if not cells or all(cell.value in (None, "") for cell in cells.values()):
                errors.append((None, "empty_row"))
            if any(cell.formula for cell in cells.values()):
                errors.append((None, "formula_not_allowed"))
            if any(cell.invalid for cell in cells.values()):
                errors.append((None, "cell_value_invalid"))
            if any(index >= len(contract.columns) and cell.value not in (None, "") for index, cell in cells.items()):
                errors.append((None, "unexpected_column_value"))

            values: dict[str, object] = {}
            for index, column in enumerate(contract.columns):
                value, error = _cell_as_value(cells.get(index), column, uses_1904_epoch)
                if error:
                    errors.append((column.key, error))
                else:
                    values[column.key] = value
            for rate_key in _COLLECTION_RATE_V3_RATE_KEYS:
                rate = values.get(rate_key)
                if isinstance(rate, Decimal) and not Decimal(0) <= rate <= Decimal(1):
                    errors.append((rate_key, "rate_out_of_range"))
            deadline = values.get("deadline_at")
            data_date = deadline.date() if isinstance(deadline, datetime) else None
            if data_date is not None and (data_date < period_start or data_date > period_end):
                errors.append(("deadline_at", "collection_rate_row_date_outside_execution_period"))
            average = values.get("average_collection_delay_hours")
            if isinstance(average, Decimal) and average < 0:
                negative_average_count += 1

            if errors:
                summary.invalid_row_count += 1
                for column_key, error_code in errors:
                    summary.add_error(row_no, column_key, error_code)
                continue

            assert isinstance(deadline, datetime) and data_date is not None
            last_data_date = max(last_data_date, data_date) if last_data_date else data_date
            summary.valid_row_count += 1
            date_key = data_date.isoformat()
            summary.per_date_counts[date_key] = summary.per_date_counts.get(date_key, 0) + 1
            base_name = values.get("source_base_name")
            if isinstance(base_name, str) and base_name.strip():
                exact = mapping.exact_base_name_candidates.get(base_name, ())
                normalized = () if exact else mapping.normalized_base_name_candidates.get(normalize_mapping_name(base_name), ())
                if exact:
                    summary.exact_name_candidate_row_count += 1
                elif normalized:
                    summary.normalized_name_candidate_row_count += 1
            resolved_code, resolution = _resolve_mapping(
                contract.source_id, values, mapping, contract.version
            )
            if resolved_code is not None:
                summary.mapped_row_count += 1
            else:
                summary.unmapped_row_count += 1
                if resolution == "AMBIGUOUS":
                    summary.ambiguous_row_count += 1
                elif resolution == "MISSING_IDENTIFIER":
                    summary.missing_identifier_row_count += 1
                else:
                    summary.no_mapping_match_row_count += 1
            if on_valid_row:
                on_valid_row(ValidImportRow(
                    source_row_no=row_no,
                    values=values,
                    resolved_base_code=resolved_code,
                    mapping_resolution=resolution,
                ))

        summary.bot_executed_at = latest_execution_at
        summary.execution_period_start = period_start
        summary.execution_period_end = period_end
        summary.execution_page_count = execution_pages
        if execution_count != summary.input_row_count:
            summary.add_workbook_error("collection_rate_execution_row_count_mismatch")
        if negative_average_count:
            summary.semantic_warnings.append(
                f"averageTakingNum: {negative_average_count} valor(es) negativo(s) preservado(s) para revisão"
            )
        if (
            period_end_datetime is not None
            and last_data_date == period_end
            and latest_execution_at.date() == period_end
            and period_end_datetime > latest_execution_at
        ):
            summary.semantic_warnings.append(
                f"Último dia {period_end.isoformat()} pode estar incompleto: a execução ocorreu antes do fim da janela consultada"
            )
    return summary


def _parse_pdd_v2_workbook(
    content: bytes,
    contract: SourceContract,
    mapping: MappingResolver,
    summary: PreviewSummary,
    on_valid_row: Callable[[ValidImportRow], None] | None,
) -> PreviewSummary:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None
    with archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED_WORKBOOK_BYTES:
            raise WorkbookValidationError("workbook_uncompressed_size_exceeded", 413)
        if any(info.filename.startswith("/") or ".." in PurePosixPath(info.filename).parts for info in archive.infolist()):
            raise WorkbookValidationError("workbook_archive_path_invalid")
        sheet_paths = _sheet_paths(archive)
        shared = _shared_strings(archive)
        date_styles = _date_style_ids(archive)
        uses_1904_epoch = _date_1904(archive)
        daily_sheets = [
            (sheet_name, _pdd_date_sheet_name(sheet_name), sheet_path)
            for sheet_name, sheet_path in sheet_paths.items()
            if _pdd_date_sheet_name(sheet_name) is not None
        ]
        if not daily_sheets:
            raise WorkbookValidationError("pdd_daily_sheets_missing")
        allowed_names = {"resumodiario", "execucao", "dicionario"}
        if any(_pdd_date_sheet_name(name) is None and _metadata_header_key(name) not in allowed_names for name in sheet_paths):
            raise WorkbookValidationError("pdd_unrecognized_sheet")
        dates = [sheet_date for _name, sheet_date, _path in daily_sheets]
        if len(set(dates)) != len(dates):
            raise WorkbookValidationError("pdd_daily_sheet_date_duplicate")

        seen_row_hashes: set[bytes] = set()
        seen_base_codes: set[str] = set()
        source_row_no = 0
        per_date: dict[date, dict[str, int]] = {}
        for sheet_name, sheet_date, sheet_path in daily_sheets:
            assert sheet_date is not None
            row_iterator = iter(_iter_sheet_rows(archive, sheet_path, shared, date_styles))
            try:
                header_row_no, header_cells = next(row_iterator)
            except StopIteration:
                summary.add_workbook_error("pdd_daily_sheet_empty")
                continue
            if header_row_no != contract.header_row:
                summary.add_workbook_error("workbook_header_row_mismatch")
                continue
            try:
                _pdd_header_indexes(header_cells, contract.headers, error_code="workbook_header_mismatch")
            except WorkbookValidationError as error:
                summary.add_workbook_error(error.code)
                continue

            def process_row(sheet_row_no: int, cells: dict[int, _RawCell]) -> None:
                nonlocal source_row_no
                source_row_no += 1
                summary.input_row_count += 1
                errors: list[tuple[str | None, str]] = []
                raw_identity = [
                    None if cells.get(index) is None else cells[index].value
                    for index in range(len(contract.columns))
                ]
                raw_key = json.dumps(
                    [str(value) if isinstance(value, Decimal) else value for value in raw_identity],
                    ensure_ascii=False, separators=(",", ":"), default=str,
                ).encode("utf-8")
                digest = hashlib.sha256(raw_key).digest()
                if digest in seen_row_hashes:
                    summary.exact_duplicate_count += 1
                else:
                    seen_row_hashes.add(digest)
                if not cells or all(cell.value in (None, "") for cell in cells.values()):
                    errors.append((None, "empty_row"))
                if any(cell.formula for cell in cells.values()):
                    errors.append((None, "formula_not_allowed"))
                if any(cell.invalid for cell in cells.values()):
                    errors.append((None, "cell_value_invalid"))
                if any(index >= len(contract.columns) and cell.value not in (None, "") for index, cell in cells.items()):
                    errors.append((None, "unexpected_column_value"))
                values: dict[str, object] = {}
                for index, column in enumerate(contract.columns):
                    value, error_code = _cell_as_value(cells.get(index), column, uses_1904_epoch)
                    if error_code:
                        errors.append((column.key, error_code))
                    else:
                        values[column.key] = value
                for rate_key in (
                    "rate_unscanned_at_receipt", "collection_failure_rate",
                    "rate_unscanned_at_dispatch", "overall_unscanned_rate",
                ):
                    rate = values.get(rate_key)
                    if isinstance(rate, Decimal) and not Decimal(0) <= rate <= Decimal(1):
                        errors.append((rate_key, "rate_out_of_range"))
                if values.get("data_date") != sheet_date:
                    errors.append(("data_date", "pdd_row_date_does_not_match_sheet"))
                source_code = values.get("source_base_code")
                if source_code is not None:
                    seen_base_codes.add(str(source_code))
                if errors:
                    summary.invalid_row_count += 1
                    for column_key, error_code in errors:
                        summary.add_error(sheet_row_no, column_key, error_code)
                    return

                summary.valid_row_count += 1
                date_key = sheet_date.isoformat()
                summary.per_date_counts[date_key] = summary.per_date_counts.get(date_key, 0) + 1
                aggregate = per_date.setdefault(sheet_date, {
                    "rows": 0,
                    "total_orders": 0,
                    "orders_unscanned_at_receipt": 0,
                    "orders_unscanned_at_collection": 0,
                    "packages_missing_dispatch_scan": 0,
                })
                aggregate["rows"] += 1
                for key in (
                    "total_orders", "orders_unscanned_at_receipt",
                    "orders_unscanned_at_collection", "packages_missing_dispatch_scan",
                ):
                    aggregate[key] += int(values[key])
                resolved_code, resolution = _resolve_mapping(contract.source_id, values, mapping, contract.version)
                if resolved_code is not None:
                    summary.mapped_row_count += 1
                else:
                    summary.unmapped_row_count += 1
                    if resolution == "UNMAPPED":
                        summary.no_mapping_match_row_count += 1
                if on_valid_row:
                    on_valid_row(ValidImportRow(
                        source_row_no=source_row_no,
                        values=values,
                        resolved_base_code=resolved_code,
                        mapping_resolution=resolution,
                        source_sheet_name=sheet_name,
                        source_sheet_row_no=sheet_row_no,
                    ))

            expected_row_no = contract.header_row + 1
            for sheet_row_no, cells in row_iterator:
                while expected_row_no < sheet_row_no:
                    process_row(expected_row_no, {})
                    expected_row_no += 1
                if sheet_row_no < expected_row_no:
                    raise WorkbookValidationError("workbook_row_order_invalid")
                process_row(sheet_row_no, cells)
                expected_row_no = sheet_row_no + 1

        _validate_pdd_v2_metadata(
            archive, sheet_paths, shared, date_styles, uses_1904_epoch, per_date, summary
        )
    return summary


def parse_workbook(
    content: bytes | Path,
    contract: SourceContract,
    resolver: MappingResolver | None = None,
    *,
    on_valid_row: Callable[[ValidImportRow], None] | None = None,
    on_progress: Callable[[int], None] | None = None,
    trusted_file_sha256: str | None = None,
    expected_file_sha256: str | None = None,
    manual_export_confirmation: dict[str, object] | None = None,
) -> PreviewSummary:
    if not content:
        raise WorkbookValidationError("workbook_empty", 400)
    if isinstance(content, Path):
        if contract.source_id != "collection_monitoring_t4_t5" or contract.version not in {1, 2}:
            raise WorkbookValidationError("workbook_path_not_supported")
        if trusted_file_sha256 is not None and expected_file_sha256 is not None:
            raise WorkbookValidationError("workbook_hash_configuration_invalid")
        supplied_hash = trusted_file_sha256 or expected_file_sha256
        if supplied_hash is not None and re.fullmatch(r"[0-9a-f]{64}", supplied_hash) is None:
            raise WorkbookValidationError("workbook_hash_configuration_invalid")
        if trusted_file_sha256 is not None:
            # The upload stream was hashed while it was copied into private staging.
            # Publication re-hashes the staged file before any facts are inserted.
            file_hash = trusted_file_sha256
        else:
            try:
                digest = hashlib.sha256()
                with content.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                file_hash = digest.hexdigest()
            except OSError:
                raise WorkbookValidationError("workbook_file_invalid") from None
            if expected_file_sha256 is not None and file_hash != expected_file_sha256:
                raise WorkbookValidationError("import_source_hash_mismatch", 409)
    else:
        if trusted_file_sha256 is not None or expected_file_sha256 is not None:
            raise WorkbookValidationError("workbook_hash_configuration_invalid")
        file_hash = hashlib.sha256(content).hexdigest()
    summary = PreviewSummary(
        source_id=contract.source_id,
        file_sha256=file_hash,
        contract_version=contract.version,
    )
    mapping = resolver or MappingResolver()
    summary.mapping_version_available = mapping.map_version_id is not None
    summary.map_version_id = mapping.map_version_id

    if contract.source_id == "pdd_collection_failure" and contract.version == 2:
        return _parse_pdd_v2_workbook(content, contract, mapping, summary, on_valid_row)
    if contract.source_id == "collection_rate" and contract.version == 2:
        return _parse_collection_rate_v2_workbook(content, contract, mapping, summary, on_valid_row)
    if contract.source_id == "collection_rate" and contract.version == 3:
        return _parse_collection_rate_v3_workbook(content, contract, mapping, summary, on_valid_row)

    try:
        archive_source = content if isinstance(content, Path) else io.BytesIO(content)
        archive = zipfile.ZipFile(archive_source)
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None
    with archive:
        if sum(info.file_size for info in archive.infolist()) > _max_uncompressed_workbook_bytes(contract):
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
                confirmation_date = (manual_export_confirmation or {}).get("export_date")
                confirmation_time = (manual_export_confirmation or {}).get("export_time")
                confirmer = (manual_export_confirmation or {}).get("user_id")
                if (
                    metadata_error == "no_movement_execution_metadata_missing"
                    and isinstance(confirmation_date, date)
                    and isinstance(confirmation_time, datetime)
                    and isinstance(confirmer, int)
                    and confirmer > 0
                ):
                    summary.collection_date = confirmation_date
                    summary.bot_executed_at = confirmation_time
                    summary.export_metadata_confirmed_by_user_id = confirmer
                    confirmed_at = (manual_export_confirmation or {}).get("confirmed_at")
                    summary.export_metadata_confirmed_at = confirmed_at if isinstance(confirmed_at, datetime) else datetime.now()
                else:
                    summary.add_workbook_error(metadata_error)

        def process_row(row_no: int, cells: dict[int, _RawCell]) -> None:
            nonlocal expected_row_no
            summary.input_row_count += 1
            if on_progress is not None:
                on_progress(summary.input_row_count)
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
                value, error = _cell_as_value(
                    cells.get(index), column, uses_1904_epoch,
                    allow_numeric_text=(
                        contract.source_id == "collection_monitoring_t4_t5"
                        and column.key in {"store_name", "seller_id"}
                    ),
                )
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
            resolved_code, resolution = _resolve_mapping(contract.source_id, values, mapping, contract.version)
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

    if contract.source_id == "no_movement" and contract.version >= 2 and not summary.export_metadata_confirmed_by_user_id:
        if no_movement_received_count != summary.input_row_count:
            summary.add_workbook_error("no_movement_execution_row_count_mismatch")
        if summary.input_row_count > 0 and (no_movement_page_count is None or no_movement_page_count < 1):
            summary.add_workbook_error("no_movement_execution_page_count_invalid")

    return summary
