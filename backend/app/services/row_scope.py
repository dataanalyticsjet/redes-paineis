from __future__ import annotations

import re
import unicodedata
from typing import Any


REGION_HEADERS = (
    "Regional responsável", "Regional mais recente", "Regional Remetente",
    "Regional Origem", "Nome da regional", "Regional 区域", "Regional", "区域",
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


def scope_parsed_rows(parsed: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
    """Return rows inside the user's Feishu home scope plus explicit grants."""
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
    base_column = parsed.get("baseColumn") or parsed.get("base_column") or next(
        (header for header in headers if "base" in _normalized(header)),
        None,
    )

    if scope == "base":
        filtered = [
            row for row in rows
            if (
                base_column
                and str(row.get(base_column, "")).strip().upper() == home_base
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
