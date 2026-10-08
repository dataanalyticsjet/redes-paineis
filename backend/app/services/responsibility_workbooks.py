from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.local_workbooks import LocalWorkbookError, save_workbook

PREVIEW_TTL_SECONDS = 10 * 60
REQUIRED_COLUMNS = (
    "Regional",
    "UF",
    "Região RM",
    "Responsável Rm",
    "Código da base",
    "Nome da base",
    "Descrição",
)


class ResponsibilityWorkbookError(ValueError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class ResponsibilityWorkbookPreview:
    owner_key: str
    file_name: str
    parsed: dict[str, Any]
    source_files: list[tuple[str, bytes]]
    stats: dict[str, Any]
    expires_at: float


_lock = threading.RLock()
_previews: dict[str, ResponsibilityWorkbookPreview] = {}


def _header_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", str(value or "").casefold())


def _base_key(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"[\u200b-\u200d\u2060\ufeff\u00ad]", "", text)
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s*-\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def validate_responsibility_workbook(parsed: dict[str, Any]) -> dict[str, Any]:
    headers = parsed.get("headers")
    rows = parsed.get("rows")
    if not isinstance(headers, list) or not isinstance(rows, list) or not rows:
        raise ResponsibilityWorkbookError("responsibility_list_empty")
    by_key = {_header_key(header): header for header in headers if isinstance(header, str)}
    columns = {name: by_key.get(_header_key(name)) for name in REQUIRED_COLUMNS}
    missing = [name for name, column in columns.items() if not column]
    if missing:
        raise ResponsibilityWorkbookError("responsibility_list_schema_invalid")

    base_column = columns["Nome da base"]
    region_column = columns["Regional"]
    uf_column = columns["UF"]
    seen: dict[str, dict[str, Any]] = {}
    duplicates: set[str] = set()
    base_count = 0
    regional_counts: dict[str, int] = {}
    uf_counts: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ResponsibilityWorkbookError("responsibility_list_schema_invalid")
        base = str(row.get(base_column) or "").strip()
        if not base:
            continue
        base_count += 1
        key = _base_key(base)
        if key in seen:
            duplicates.add(key)
        else:
            seen[key] = row
        region = str(row.get(region_column) or "").strip().upper()
        uf = str(row.get(uf_column) or "").strip().upper()
        if region:
            regional_counts[region] = regional_counts.get(region, 0) + 1
        if uf:
            uf_counts[uf] = uf_counts.get(uf, 0) + 1
    if base_count == 0:
        raise ResponsibilityWorkbookError("responsibility_list_empty")
    return {
        "rowCount": len(rows),
        "baseCount": len(seen),
        "duplicateBaseCount": len(duplicates),
        "canPublish": not duplicates,
        "regionalCounts": dict(sorted(regional_counts.items())),
        "ufCounts": dict(sorted(uf_counts.items())),
    }


def create_preview(
    owner_key: str,
    file_name: str,
    parsed: dict[str, Any],
    source_files: list[tuple[str, bytes]],
) -> tuple[str | None, dict[str, Any]]:
    stats = validate_responsibility_workbook(parsed)
    if len(source_files) != 1:
        raise ResponsibilityWorkbookError("responsibility_list_file_missing", 400)
    now = time.time()
    preview_id = str(uuid.uuid4()) if stats["canPublish"] else None
    if preview_id:
        with _lock:
            for key, pending in list(_previews.items()):
                if pending.expires_at <= now:
                    _previews.pop(key, None)
            _previews[preview_id] = ResponsibilityWorkbookPreview(
                owner_key=owner_key,
                file_name=file_name,
                parsed=parsed,
                source_files=source_files,
                stats=stats,
                expires_at=now + PREVIEW_TTL_SECONDS,
            )
    return preview_id, stats


def publish_preview(preview_id: str, owner_key: str, root: Path) -> dict[str, Any]:
    now = time.time()
    with _lock:
        entry = _previews.get(preview_id)
        if not entry or entry.owner_key != owner_key:
            raise ResponsibilityWorkbookError("responsibility_list_preview_not_found", 404)
        if entry.expires_at <= now:
            _previews.pop(preview_id, None)
            raise ResponsibilityWorkbookError("responsibility_list_preview_expired", 410)
        metadata = save_workbook(
            root,
            "responsibilityList",
            entry.file_name,
            entry.parsed,
            entry.source_files,
        )
        _previews.pop(preview_id, None)
    return {**metadata, "sheetName": entry.parsed.get("sheetName", ""), **entry.stats}


def reset_temporary_previews() -> None:
    with _lock:
        _previews.clear()
