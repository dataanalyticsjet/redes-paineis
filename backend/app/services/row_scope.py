from __future__ import annotations

import re
import unicodedata
from typing import Any


REGION_HEADERS = (
    "Regional responsável", "Regional mais recente", "Regional Remetente",
    "Regional Origem", "Nome da regional", "Regional 区域", "Regional", "区域",
)
BASE_HEADERS = (
    "Nome da base de coleta", "PDD de saida", "PDD de saída", "Nome da unidade responsável",
    "Nome da unidade responsavel", "Nome da base mais recente", "Nome da Base Remetente",
    "Nome da base", "Base", "网点名称",
)


def _normalized(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", without_marks.lower())


def _column(headers: list[str], candidates: tuple[str, ...]) -> str | None:
    normalized = {_normalized(header): header for header in headers}
    return next(
        (normalized[_normalized(candidate)] for candidate in candidates if _normalized(candidate) in normalized),
        None,
    )


def _normalized_base_name(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff\u00ad]", "", text)
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s*-\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def canonicalize_parsed_regions(
    parsed: dict[str, Any],
    responsibility: dict[str, Any] | None,
) -> dict[str, Any]:
    """Apply the official base -> region mapping before a caller scopes rows."""
    if not responsibility:
        return parsed
    headers = parsed.get("headers") or []
    source_headers = responsibility.get("headers") or []
    region_column = _column(headers, REGION_HEADERS) or parsed.get("regionColumn") or parsed.get("region_column")
    base_column = parsed.get("baseColumn") or parsed.get("base_column") or _column(headers, BASE_HEADERS)
    official_base_column = _column(source_headers, ("Nome da base", "Base", "网点名称"))
    official_region_column = _column(source_headers, ("Regional", "区域"))
    if not region_column or not base_column or not official_base_column or not official_region_column:
        return parsed

    official_regions: dict[str, str] = {}
    for row in responsibility.get("rows") or []:
        key = _normalized_base_name(row.get(official_base_column))
        region = str(row.get(official_region_column) or "").strip()
        if key and region:
            official_regions[key] = region
    if not official_regions:
        return parsed

    changed = False
    rows = []
    for row in parsed.get("rows") or []:
        region = official_regions.get(_normalized_base_name(row.get(base_column)))
        if region and row.get(region_column) != region:
            rows.append({**row, region_column: region})
            changed = True
        else:
            rows.append(row)
    if not changed:
        return parsed
    metadata = dict(parsed.get("metadata") or {})
    return {**parsed, "rows": rows, "metadata": metadata}


def scope_parsed_rows(
    parsed: dict[str, Any],
    identity: dict[str, Any],
    responsibility: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return rows inside the user's Feishu home scope plus explicit grants."""
    parsed = canonicalize_parsed_regions(parsed, responsibility)
    scope = str(identity.get("organizational_scope") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if scope == "matrix" or role == "matrix":
        return parsed

    home_region = str(identity.get("home_region") or identity.get("region") or "").strip().upper()
    home_base = str(identity.get("home_base") or identity.get("base") or "").strip().upper()
    additional_regions = {
        str(region).strip().upper()
        for region in identity.get("additional_regions", [])
        if str(region).strip()
    }
    if not scope:
        scope = "base" if home_base and not home_region else "regional"
    if scope == "base" and not home_base:
        raise PermissionError("viewer_scope_unavailable")
    if scope == "regional" and not home_region:
        raise PermissionError("viewer_scope_unavailable")
    if scope not in {"regional", "base"}:
        raise PermissionError("viewer_scope_unavailable")

    headers = parsed.get("headers") or []
    rows = parsed.get("rows") or []
    region_column = _column(headers, REGION_HEADERS) or parsed.get("regionColumn") or parsed.get("region_column")
    base_column = parsed.get("baseColumn") or parsed.get("base_column") or _column(headers, BASE_HEADERS)

    if scope == "base":
        filtered = [
            row for row in rows
            if (
                base_column
                and _normalized_base_name(row.get(base_column)) == _normalized_base_name(home_base)
            ) or (
                region_column
                and str(row.get(region_column, "")).strip().upper() in additional_regions
            )
        ]
    else:
        allowed_regions = additional_regions | {home_region}
        filtered = [
            row for row in rows
            if region_column
            and str(row.get(region_column, "")).strip().upper() in allowed_regions
        ]

    scoped = {**parsed, "rows": filtered}
    metadata = dict(parsed.get("metadata") or {})
    metadata["rowCount"] = len(filtered)
    scoped["metadata"] = metadata
    return scoped
