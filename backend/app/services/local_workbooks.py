from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.core.config import BACKEND_ROOT

WORKBOOK_KINDS = frozenset({
    "monitoring", "taxa", "epop", "movement", "sellerList",
    "sellerSpecialList", "sellerPerformance", "responsibilityList", "bipagem", "damage",
})
HISTORY_KINDS = frozenset({"monitoring", "taxa", "epop", "damage"})
SELLER_ID_HEADERS = (
    "Id Seller/remetente", "global_seller_id", "Id Seller", "Seller", "商家ID", "Seller ID",
)
REGION_HEADERS = (
    "Regional responsável", "Regional mais recente", "Regional Remetente",
    "Regional Origem", "Nome da regional", "Regional 区域", "Regional", "区域",
)


class LocalWorkbookError(Exception):
    pass


def data_root(configured: Path) -> Path:
    path = configured if configured.is_absolute() else BACKEND_ROOT.parent / configured
    return path.resolve()


def safe_workbook_name(value: str) -> str:
    name = re.split(r"[/\\]", value)[-1]
    name = "".join(char for char in name if char.isprintable() and char not in '<>:"|?*')
    name = re.sub(r"\s+", " ", name).strip(" .")
    if not name or len(name) > 180 or name.rsplit(".", 1)[-1].lower() not in {"xlsx", "xls"}:
        raise LocalWorkbookError("workbook_file_name_invalid")
    return name


def _directory(root: Path, category: str, key: str) -> Path:
    if category == "workbooks" and key not in WORKBOOK_KINDS:
        raise LocalWorkbookError("workbook_kind_invalid")
    if category == "sources" and not re.fullmatch(r"[A-Za-z0-9-]{1,64}", key):
        raise LocalWorkbookError("data_source_dashboard_invalid")
    return root / category / key


def _write_json(path: Path, value: Any) -> None:
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    with path.open("w", encoding="utf-8", newline="") as stream:
        for chunk in encoder.iterencode(value):
            stream.write(chunk)


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        _write_json(temporary, value)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _save_version(
    parent: Path,
    file_name: str,
    parsed: dict[str, Any],
    source_files: Iterable[tuple[str, bytes]],
    *,
    updated_at: str | None = None,
) -> tuple[str, str]:
    safe_name = safe_workbook_name(file_name)
    version_id = uuid.uuid4().hex
    updated = updated_at or datetime.now(timezone.utc).isoformat()
    versions = parent / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    destination = versions / version_id
    # A uniquely named version is not visible to readers until current.json is
    # atomically replaced, so writing it in place avoids non-portable directory
    # rename behavior on Windows while retaining atomic publication.
    destination.mkdir()
    try:
        _write_json(destination / "parsed.json", parsed)
        stored_sources = []
        for index, (original_name, content) in enumerate(source_files):
            source_name = safe_workbook_name(original_name)
            stored_name = f"source-{index:02d}-{source_name}"
            with (destination / stored_name).open("wb") as stream:
                stream.write(content)
            stored_sources.append({"fileName": source_name, "storedAs": stored_name, "sizeBytes": len(content)})
        _write_json(destination / "version.json", {
            "fileName": safe_name,
            "updatedAt": updated,
            "sourceFiles": stored_sources,
        })
        return version_id, updated
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def save_workbook(
    root: Path,
    kind: str,
    file_name: str,
    parsed: dict[str, Any],
    source_files: Iterable[tuple[str, bytes]] = (),
) -> dict[str, Any]:
    parent = _directory(root, "workbooks", kind)
    version_id, updated_at = _save_version(parent, file_name, parsed, source_files)
    current_path = parent / "current.json"
    previous = read_metadata(current_path) or {}
    if kind in HISTORY_KINDS:
        parts = [*previous.get("historyParts", []), version_id]
        pointer = {"fileName": safe_workbook_name(file_name), "updatedAt": updated_at, "latestVersion": version_id, "historyParts": parts}
    else:
        pointer = {"fileName": safe_workbook_name(file_name), "updatedAt": updated_at, "latestVersion": version_id}
    try:
        _atomic_json(current_path, pointer)
    except Exception:
        # Keep the previous pointer valid if publication fails. The new version
        # is an unreachable local snapshot and can be inspected or cleaned later.
        raise
    return pointer


def read_metadata(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise LocalWorkbookError("local_workbook_metadata_unavailable") from error
    return value if isinstance(value, dict) else None


def get_workbook(root: Path, kind: str, part: str | None = None) -> tuple[dict[str, Any], dict[str, Any]] | None:
    parent = _directory(root, "workbooks", kind)
    metadata = read_metadata(parent / "current.json")
    if not metadata:
        return None
    version_id = part or metadata.get("latestVersion")
    allowed_versions = metadata.get("historyParts", []) if kind in HISTORY_KINDS else [metadata.get("latestVersion")]
    if not isinstance(version_id, str) or version_id not in allowed_versions or not re.fullmatch(r"[a-f0-9]{32}", version_id):
        raise LocalWorkbookError("workbook_part_invalid")
    version_dir = parent / "versions" / version_id
    try:
        parsed = json.loads((version_dir / "parsed.json").read_text(encoding="utf-8"))
        version = json.loads((version_dir / "version.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LocalWorkbookError("local_workbook_unavailable") from error
    if not isinstance(parsed, dict) or not isinstance(version, dict):
        raise LocalWorkbookError("local_workbook_unavailable")
    return metadata, parsed


def save_dashboard_source(
    root: Path,
    dashboard_id: str,
    owner_key: str,
    file_name: str,
    parsed: dict[str, Any],
    source_bytes: bytes | None,
    *,
    imported_at: str,
    file_size_bytes: int,
    content_type: str,
    period: dict[str, str] | None,
    row_count: int,
) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", dashboard_id) or not re.fullmatch(r"[a-f0-9]{64}", owner_key):
        raise LocalWorkbookError("data_source_owner_invalid")
    parent = root / "sources" / dashboard_id / owner_key
    source_files = [(file_name, source_bytes)] if source_bytes is not None else []
    version_id, _ = _save_version(parent, file_name, parsed, source_files, updated_at=imported_at)
    pointer = {
        "dashboardId": dashboard_id,
        "ownerKey": owner_key,
        "version": version_id,
        "fileName": safe_workbook_name(file_name),
        "importedAt": imported_at,
        "period": period,
        "rowCount": row_count,
        "fileSizeBytes": file_size_bytes,
        "contentType": content_type,
    }
    _atomic_json(parent / "current.json", pointer)
    return {**pointer, "parsed": parsed}


def get_dashboard_source(root: Path, dashboard_id: str, owner_key: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", dashboard_id) or not re.fullmatch(r"[a-f0-9]{64}", owner_key):
        raise LocalWorkbookError("data_source_owner_invalid")
    parent = root / "sources" / dashboard_id / owner_key
    metadata = read_metadata(parent / "current.json")
    if not metadata:
        return None
    try:
        parsed = json.loads((parent / "versions" / metadata["version"] / "parsed.json").read_text(encoding="utf-8"))
    except (OSError, KeyError, json.JSONDecodeError) as error:
        raise LocalWorkbookError("local_data_source_unavailable") from error
    return {**metadata, "parsed": parsed}


def remove_dashboard_source(root: Path, dashboard_id: str, owner_key: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", dashboard_id) or not re.fullmatch(r"[a-f0-9]{64}", owner_key):
        raise LocalWorkbookError("data_source_owner_invalid")
    parent = root / "sources" / dashboard_id / owner_key
    (parent / "current.json").unlink(missing_ok=True)
    shutil.rmtree(parent / "versions", ignore_errors=True)
