from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Any

DATE_HEADER = "Data"
BASE_HEADER = "PDD de saida"
REGION_HEADER = "Regional Origem"
ORIGIN_HEADER = "Origem do Pedido"
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SellerMonitoringHistoryError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SellerMonitoringHistoryMerge:
    parsed: dict[str, Any]
    new_dates: list[str]
    replaced_dates: list[str]
    file_period: dict[str, str]
    merged_period: dict[str, str]
    file_row_count: int
    resulting_rows: int


def _normalized_header(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", without_marks.casefold())


def _columns(headers: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for header in headers:
        key = _normalized_header(header)
        if key in result:
            raise SellerMonitoringHistoryError("data_source_seller_duplicate_columns")
        result[key] = header
    return result


def _resolve_column(parsed: dict[str, Any], configured: str, expected: str) -> str:
    headers = parsed.get("headers") or []
    value = parsed.get(configured)
    if isinstance(value, str) and value in headers:
        return value
    column = _columns(headers).get(_normalized_header(expected))
    if not column:
        raise SellerMonitoringHistoryError("data_source_seller_history_schema_mismatch")
    return column


def _dated_rows(source: dict[str, Any], canonical_headers: list[str], canonical_date: str) -> list[tuple[str, dict[str, Any]]]:
    source_headers = source.get("headers") or []
    source_map = _columns(source_headers)
    canonical_map = _columns(canonical_headers)
    if set(source_map) != set(canonical_map):
        raise SellerMonitoringHistoryError("data_source_seller_history_schema_mismatch")
    source_date = _resolve_column(source, "dateColumn", DATE_HEADER)
    output: list[tuple[str, dict[str, Any]]] = []
    for source_row in source.get("rows") or []:
        date = str(source_row.get(source_date) or "").strip()
        if not DATE_PATTERN.fullmatch(date):
            raise SellerMonitoringHistoryError("data_source_seller_invalid_date")
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError as error:
            raise SellerMonitoringHistoryError("data_source_seller_invalid_date") from error
        row = {
            canonical_header: source_row.get(source_map[_normalized_header(canonical_header)])
            for canonical_header in canonical_headers
        }
        row[canonical_date] = date
        output.append((date, row))
    return output


def merge_seller_monitoring_history(
    existing: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> SellerMonitoringHistoryMerge:
    """Replace full incoming dates while preserving all absent dates and regions."""
    incoming_headers = incoming.get("headers") or []
    if not incoming_headers or not incoming.get("rows"):
        raise SellerMonitoringHistoryError("data_source_empty_workbook")
    canonical = existing or incoming
    canonical_headers = list(canonical.get("headers") or [])
    if not canonical_headers:
        raise SellerMonitoringHistoryError("data_source_seller_history_schema_mismatch")
    canonical_date = _resolve_column(canonical, "dateColumn", DATE_HEADER)
    existing_rows = _dated_rows(existing, canonical_headers, canonical_date) if existing else []
    incoming_rows = _dated_rows(incoming, canonical_headers, canonical_date)
    existing_dates = {date for date, _row in existing_rows}
    incoming_dates = {date for date, _row in incoming_rows}
    preserved = [(date, row) for date, row in existing_rows if date not in incoming_dates]
    merged = sorted([*preserved, *incoming_rows], key=lambda item: item[0])
    dates = sorted({date for date, _row in merged})
    file_dates = sorted(incoming_dates)
    metadata = dict(canonical.get("metadata") or {})
    metadata["rowCount"] = len(merged)
    metadata["dateRange"] = {"min": dates[0], "max": dates[-1]}
    warnings = list(dict.fromkeys([
        *(canonical.get("warnings") or []),
        *(incoming.get("warnings") or []),
        "Histórico acumulado: novas cargas substituem as datas reenviadas e preservam as demais.",
    ]))
    parsed = {
        **canonical,
        "headers": canonical_headers,
        "rows": [row for _date, row in merged],
        "dateColumn": canonical_date,
        "baseColumn": _resolve_column(canonical, "baseColumn", BASE_HEADER),
        "regionColumn": _resolve_column(canonical, "regionColumn", REGION_HEADER),
        "originColumn": _resolve_column(canonical, "originColumn", ORIGIN_HEADER),
        "metadata": metadata,
        "warnings": warnings,
    }
    return SellerMonitoringHistoryMerge(
        parsed=parsed,
        new_dates=[date for date in file_dates if date not in existing_dates],
        replaced_dates=[date for date in file_dates if date in existing_dates],
        file_period={"start": file_dates[0], "end": file_dates[-1]},
        merged_period={"start": dates[0], "end": dates[-1]},
        file_row_count=len(incoming_rows),
        resulting_rows=len(merged),
    )
