from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Any


DATE_HEADER = "Horário de término do prazo de coleta"
BASE_HEADER = "Nome da base de coleta"
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class TaxaHistoryError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TaxaHistoryMerge:
    parsed: dict[str, Any]
    new_dates: list[str]
    replaced_dates: list[str]
    file_period: dict[str, str]
    merged_period: dict[str, str]
    file_row_count: int
    blank_base_rows: int
    resulting_rows: int


def _normalized_header(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", without_marks.lower()).strip()


def _header_map(headers: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for header in headers:
        normalized = _normalized_header(header)
        if normalized in result:
            raise TaxaHistoryError("data_source_taxa_duplicate_columns")
        result[normalized] = header
    return result


def _resolve_column(parsed: dict[str, Any], key: str, expected: str) -> str:
    headers = parsed.get("headers") or []
    configured = parsed.get(key)
    if isinstance(configured, str) and configured in headers:
        return configured
    by_normalized = _header_map(headers)
    column = by_normalized.get(_normalized_header(expected))
    if not column:
        raise TaxaHistoryError("data_source_taxa_history_schema_mismatch")
    return column


def _canonicalize_rows(
    source: dict[str, Any],
    canonical_headers: list[str],
    canonical_date_column: str,
) -> list[tuple[str, dict[str, Any]]]:
    source_headers = source.get("headers") or []
    canonical_by_normalized = _header_map(canonical_headers)
    source_by_normalized = _header_map(source_headers)
    missing = [header for header in canonical_headers if _normalized_header(header) not in source_by_normalized]
    extra = [header for header in source_headers if _normalized_header(header) not in canonical_by_normalized]
    if missing or extra:
        raise TaxaHistoryError("data_source_taxa_history_schema_mismatch")

    source_date_column = _resolve_column(source, "dateColumn", DATE_HEADER)
    normalized_date_header = _normalized_header(canonical_date_column)
    if normalized_date_header != _normalized_header(DATE_HEADER):
        raise TaxaHistoryError("data_source_taxa_history_schema_mismatch")

    output: list[tuple[str, dict[str, Any]]] = []
    for source_row in source.get("rows") or []:
        raw_date = str(source_row.get(source_date_column, "") or "").strip()
        if not DATE_PATTERN.fullmatch(raw_date):
            raise TaxaHistoryError("data_source_taxa_invalid_date")
        try:
            datetime.strptime(raw_date, "%Y-%m-%d")
        except ValueError as error:
            raise TaxaHistoryError("data_source_taxa_invalid_date") from error

        row = {
            canonical_header: source_row.get(source_by_normalized[_normalized_header(canonical_header)])
            for canonical_header in canonical_headers
        }
        row[canonical_date_column] = raw_date
        output.append((raw_date, row))
    return output


def merge_taxa_history(
    existing: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> TaxaHistoryMerge:
    """Apply the legacy Taxa snapshot rule: replace complete dates, keep absent dates."""
    incoming_headers = incoming.get("headers") or []
    if not incoming_headers or not incoming.get("rows"):
        raise TaxaHistoryError("data_source_empty_workbook")

    canonical = existing or incoming
    canonical_headers = list(canonical.get("headers") or [])
    if not canonical_headers:
        raise TaxaHistoryError("data_source_taxa_history_schema_mismatch")
    canonical_date_column = _resolve_column(canonical, "dateColumn", DATE_HEADER)

    existing_rows = _canonicalize_rows(existing, canonical_headers, canonical_date_column) if existing else []
    incoming_rows = _canonicalize_rows(incoming, canonical_headers, canonical_date_column)
    existing_dates = {date for date, _row in existing_rows}
    incoming_dates = {date for date, _row in incoming_rows}

    preserved_rows = [(date, row) for date, row in existing_rows if date not in incoming_dates]
    merged_rows = sorted([*preserved_rows, *incoming_rows], key=lambda item: item[0])
    merged_dates = sorted({date for date, _row in merged_rows})
    file_dates = sorted(incoming_dates)

    metadata = dict(canonical.get("metadata") or {})
    metadata["rowCount"] = len(merged_rows)
    metadata["dateRange"] = {"min": merged_dates[0], "max": merged_dates[-1]}
    warnings = list(canonical.get("warnings") or [])
    warnings.extend(incoming.get("warnings") or [])
    history_warning = "Histórico acumulado: novas cargas preservam as datas que não estão no arquivo enviado."
    if history_warning not in warnings:
        warnings.append(history_warning)

    parsed = {
        **canonical,
        "headers": canonical_headers,
        "rows": [row for _date, row in merged_rows],
        "dateColumn": canonical_date_column,
        "baseColumn": _resolve_column(canonical, "baseColumn", BASE_HEADER),
        "regionColumn": _resolve_column(canonical, "regionColumn", "Nome da regional"),
        "originColumn": _resolve_column(canonical, "originColumn", "Origem do Pedido"),
        "metadata": metadata,
        "warnings": list(dict.fromkeys(warnings)),
    }
    blank_base_rows = sum(
        1 for row in incoming.get("rows") or []
        if not str(row.get(_resolve_column(incoming, "baseColumn", BASE_HEADER), "") or "").strip()
    )
    return TaxaHistoryMerge(
        parsed=parsed,
        new_dates=[date for date in file_dates if date not in existing_dates],
        replaced_dates=[date for date in file_dates if date in existing_dates],
        file_period={"start": file_dates[0], "end": file_dates[-1]},
        merged_period={"start": merged_dates[0], "end": merged_dates[-1]},
        file_row_count=len(incoming_rows),
        blank_base_rows=blank_base_rows,
        resulting_rows=len(merged_rows),
    )
