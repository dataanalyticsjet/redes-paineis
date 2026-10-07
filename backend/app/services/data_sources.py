from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from app.core.config import get_settings
from app.schemas.data_sources import ParsedWorkbookPayload, PreviewSourceRequest
from app.services.local_workbooks import (
    LocalWorkbookError,
    data_root,
    get_dashboard_source as read_saved_dashboard_source,
    remove_dashboard_source as remove_saved_dashboard_source,
    save_dashboard_source,
)
from app.services.row_scope import scope_parsed_rows
from app.services.taxa_history import TaxaHistoryError, merge_taxa_history

logger = logging.getLogger(__name__)

MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024
PREVIEW_TTL_SECONDS = 10 * 60
ALLOWED_CONTENT_TYPES = {
    "",
    "application/octet-stream",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REGION_HEADERS = {
    "regional responsavel",
    "regional mais recente",
    "regional remetente",
    "regional origem",
    "nome da regional",
    "regional",
    "区域",
}


class DataSourceError(Exception):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class PreviewEntry:
    dashboard_id: str
    owner_key: str
    session_key: str
    parsed: dict[str, Any]
    file_name: str
    file_size_bytes: int
    content_type: str
    period: dict[str, str] | None
    row_count: int
    expires_at: float
    source_bytes: bytes | None


_lock = threading.RLock()
_previews: dict[str, PreviewEntry] = {}
KNOWN_DASHBOARD_IDS = frozenset({"monitoring", "taxa", "epop", "movement", "sellerPerformance", "bipagem", "damage"})

TAXA_REQUIRED_HEADERS = (
    "Horário de término do prazo de coleta",
    "Nome da regional",
    "Nome da base de coleta",
    "Origem do Pedido",
    "Tipo de produto",
    "Quantidade de pedidos",
    "Qtd a coletar",
    "Qtd cancelada",
    "Taxa de coleta",
    "揽收量",
    "未揽收量",
    "Qtd não coletada no prazo",
    "Qtd coletada no prazo",
    "Taxa de coleta no prazo",
    "Pedidos coletados + Tentativas de coleta",
    "Taxa de coleta com tentativas de coleta",
    "Prazo médio demorado para coleta(h)",
    "已做问题件的量",
    "未做问题件的量",
    "Taxa de coleta do vendedor",
    "应上门商家量",
    "未上门商家量",
)


def reset_temporary_data_sources() -> None:
    """Clear short-lived previews; imported datasets live in ignored local files."""
    with _lock:
        _previews.clear()


def _normalized_header(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", without_marks.lower()).strip()


def _safe_file_name(value: str) -> str:
    # Treat both Windows and POSIX separators as path separators, then keep only
    # a printable display name. The original name is never used as a filesystem path.
    base_name = re.split(r"[/\\]", value)[-1]
    base_name = "".join(char for char in base_name if char.isprintable() and char not in "<>:\"|?*")
    base_name = re.sub(r"\s+", " ", base_name).strip(" .")
    if not base_name or len(base_name) > 160:
        raise DataSourceError("data_source_file_name_invalid")
    extension = base_name.rsplit(".", 1)[-1].lower() if "." in base_name else ""
    if extension not in {"xls", "xlsx"}:
        raise DataSourceError("data_source_file_type_invalid")
    return base_name


def _numeric_nonzero(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip().replace(" ", "").replace(",", ".")) != 0
        except ValueError:
            return False
    return False


def _valid_dates(parsed: dict[str, Any]) -> list[str]:
    column = parsed.get("dateColumn")
    if not column:
        return []
    return sorted({
        str(row.get(column, ""))
        for row in parsed.get("rows", [])
        if DATE_PATTERN.fullmatch(str(row.get(column, "")))
    })


def _contract(parsed: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], list[str], dict[str, str] | None]:
    headers = parsed.get("headers", [])
    rows = parsed.get("rows", [])
    present = set(headers)
    date_column = parsed.get("dateColumn")
    base_column = parsed.get("baseColumn")
    status_column = parsed.get("statusColumn")
    metric_columns = [
        column
        for column in parsed.get("statusColumns", [])
        if column != status_column and any(_numeric_nonzero(row.get(column)) for row in rows)
    ]
    valid_dates = _valid_dates(parsed)

    required = [
        {"name": "Data", "classification": "required", "present": bool(date_column and date_column in present and valid_dates)},
        {"name": "Base", "classification": "required", "present": bool(base_column and base_column in present)},
        {"name": "Status numérico", "classification": "required", "present": bool(metric_columns)},
    ]
    optional_columns = [
        ("Regional", parsed.get("regionColumn")),
        ("Origem do pedido", parsed.get("originColumn")),
        ("Status categórico", status_column),
    ]
    optional = [
        {"name": name, "classification": "optional", "present": bool(column and column in present)}
        for name, column in optional_columns
    ]
    recognized = {column for column in [date_column, base_column, parsed.get("regionColumn"), parsed.get("originColumn"), status_column, *metric_columns] if column}
    unknown = [
        {"name": header, "classification": "unrecognized", "present": True}
        for header in headers
        if header not in recognized
    ]
    fields = [*required, *optional, *unknown]
    missing = [field["name"] for field in required if not field["present"]]
    period = {"start": valid_dates[0], "end": valid_dates[-1]} if valid_dates else None
    return fields, missing, metric_columns, period


def _scope_parsed(parsed: dict[str, Any], identity: dict[str, str | None]) -> dict[str, Any]:
    scope = str(identity.get("organizational_scope") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if scope == "matrix" or role == "matrix":
        return parsed
    headers = parsed.get("headers", [])
    region_column = parsed.get("regionColumn")
    if not region_column:
        region_column = next(
            (header for header in headers if _normalized_header(header) in REGION_HEADERS),
            None,
        )
    base_column = parsed.get("baseColumn")
    home_base = str(identity.get("home_base") or identity.get("base") or "").strip()
    extras = identity.get("additional_regions") or []
    if scope == "regional" or (not scope and not home_base):
        if not (identity.get("home_region") or identity.get("region")):
            raise DataSourceError("data_source_scope_unavailable", 403)
    if (scope == "regional" or extras) and not region_column:
        raise DataSourceError("data_source_region_column_required", 422)
    if (scope == "base" or home_base) and not base_column:
        raise DataSourceError("data_source_base_column_required", 422)
    if region_column:
        parsed["regionColumn"] = region_column
    if base_column:
        parsed["baseColumn"] = base_column
    try:
        return scope_parsed_rows(parsed, identity)
    except PermissionError:
        raise DataSourceError("data_source_scope_unavailable", 403) from None


def _source_period(parsed: dict[str, Any]) -> dict[str, str] | None:
    dates = _valid_dates(parsed)
    return {"start": dates[0], "end": dates[-1]} if dates else None


def _validate_upload(request: PreviewSourceRequest) -> tuple[str, str, dict[str, Any]]:
    if request.file_size_bytes > MAX_SOURCE_FILE_BYTES:
        raise DataSourceError("data_source_file_too_large", 413)
    file_name = _safe_file_name(request.file_name)
    content_type = request.content_type.split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise DataSourceError("data_source_mime_invalid")
    extension = file_name.rsplit(".", 1)[-1].lower()
    expected_type = {
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls": "application/vnd.ms-excel",
    }[extension]
    if content_type and content_type not in {expected_type, "application/octet-stream"}:
        raise DataSourceError("data_source_mime_extension_mismatch")
    parsed = request.parsed.model_dump(by_alias=True)
    if not parsed["rows"]:
        raise DataSourceError("data_source_empty_workbook")
    return file_name, content_type, parsed


def _monitoring_adapter(parsed: dict[str, Any], identity: dict[str, str | None]) -> tuple[dict[str, Any], list[dict[str, Any]], list[str], dict[str, str] | None, bool]:
    fields, missing, metric_columns, full_period = _contract(parsed)
    scoped = _scope_parsed(parsed, identity)
    scoped_fields, _scoped_missing, _scoped_metrics, scoped_period = _contract(scoped)
    return scoped, scoped_fields or fields, missing, scoped_period or full_period, not missing and bool(metric_columns)


def _taxa_adapter(parsed: dict[str, Any], identity: dict[str, str | None]) -> tuple[dict[str, Any], list[dict[str, Any]], list[str], dict[str, str] | None, bool]:
    header_by_normalized = {_normalized_header(header): header for header in parsed["headers"]}
    fields = [
        {
            "name": expected_header,
            "classification": "required",
            "present": _normalized_header(expected_header) in header_by_normalized,
        }
        for expected_header in TAXA_REQUIRED_HEADERS
    ]
    missing = [field["name"] for field in fields if not field["present"]]
    recognized = {
        header_by_normalized[_normalized_header(header)]
        for header in TAXA_REQUIRED_HEADERS
        if _normalized_header(header) in header_by_normalized
    }
    fields.extend(
        {"name": header, "classification": "unrecognized", "present": True}
        for header in parsed["headers"]
        if header not in recognized
    )

    date_column = header_by_normalized.get(_normalized_header(TAXA_REQUIRED_HEADERS[0]))
    region_column = header_by_normalized.get(_normalized_header(TAXA_REQUIRED_HEADERS[1]))
    base_column = header_by_normalized.get(_normalized_header(TAXA_REQUIRED_HEADERS[2]))
    origin_column = header_by_normalized.get(_normalized_header(TAXA_REQUIRED_HEADERS[3]))
    parsed.update({
        "dateColumn": date_column,
        "regionColumn": region_column,
        "baseColumn": base_column,
        "originColumn": origin_column,
    })
    if not parsed["rows"]:
        missing.append("Dados da planilha")
    if not _valid_dates(parsed):
        missing.append("Data válida")

    scoped = _scope_parsed(parsed, identity)
    valid_dates = _valid_dates(scoped)
    period = {"start": valid_dates[0], "end": valid_dates[-1]} if valid_dates else None
    missing = sorted(set(missing))
    return scoped, fields, missing, period, not missing and bool(valid_dates)


_DATA_SOURCE_ADAPTERS = {
    "monitoring": _monitoring_adapter,
    "taxa": _taxa_adapter,
}


def ensure_dashboard_source_configured(dashboard_id: str) -> None:
    if dashboard_id not in KNOWN_DASHBOARD_IDS:
        raise DataSourceError("data_source_dashboard_not_found", 404)
    if dashboard_id not in _DATA_SOURCE_ADAPTERS:
        raise DataSourceError("data_source_dashboard_unconfigured", 409)


def create_dashboard_preview(
    dashboard_id: str,
    owner_key: str,
    identity: dict[str, str | None],
    request: PreviewSourceRequest,
    source_bytes: bytes | None = None,
    session_key: str | None = None,
) -> dict[str, Any]:
    ensure_dashboard_source_configured(dashboard_id)
    if source_bytes is not None and len(source_bytes) != request.file_size_bytes:
        raise DataSourceError("data_source_file_size_mismatch")
    file_name, content_type, parsed = _validate_upload(request)
    adapter = _DATA_SOURCE_ADAPTERS[dashboard_id]
    scoped, fields, missing, period, can_import = adapter(parsed, identity)
    history_preview: dict[str, Any] | None = None
    if dashboard_id == "taxa" and can_import:
        try:
            current_source = read_saved_dashboard_source(
                data_root(get_settings().data_directory), dashboard_id, owner_key
            )
            history_merge = merge_taxa_history(
                current_source.get("parsed") if current_source else None,
                parsed,
            )
        except TaxaHistoryError as error:
            raise DataSourceError(error.code, 422) from error
        except LocalWorkbookError as error:
            raise DataSourceError(str(error), 500) from error
        period = history_merge.file_period
        scoped_incoming = _scope_parsed(parsed, identity)
        scoped_history = _scope_parsed(history_merge.parsed, identity)
        scoped_blank_base_rows = sum(
            1
            for row in scoped_incoming["rows"]
            if not str(row.get(scoped_incoming["baseColumn"], "") or "").strip()
        )
        history_preview = {
            "newDates": history_merge.new_dates,
            "replacedDates": history_merge.replaced_dates,
            "fileRowCount": len(scoped_incoming["rows"]),
            "blankBaseRows": scoped_blank_base_rows,
            "resultingRows": len(scoped_history["rows"]),
        }

    preview_id = str(uuid.uuid4())
    now = time.time()
    entry = PreviewEntry(
        dashboard_id=dashboard_id,
        owner_key=owner_key,
        session_key=session_key or owner_key,
        # The preview response is scoped, but the published shared source must
        # retain the validated full workbook. Every subsequent read is scoped
        # independently for the requesting user.
        parsed=parsed,
        file_name=file_name,
        file_size_bytes=request.file_size_bytes,
        content_type=content_type,
        period=period,
        row_count=len(scoped["rows"]),
        expires_at=now + PREVIEW_TTL_SECONDS,
        source_bytes=source_bytes,
    )
    with _lock:
        for key, pending in list(_previews.items()):
            if pending.expires_at <= now:
                _previews.pop(key, None)
        if can_import:
            _previews[preview_id] = entry
    return {
        "previewId": preview_id if can_import else None,
        "fileName": file_name,
        "fileSizeBytes": request.file_size_bytes,
        "contentType": content_type,
        "sheetName": scoped["sheetName"],
        "rowCount": len(scoped["rows"]),
        "period": period,
        "headers": scoped["headers"],
        "fields": fields,
        "missingFields": missing,
        "history": history_preview,
        "canImport": can_import,
        "errors": [] if can_import else ["data_source_required_fields_missing"],
    }


def import_dashboard_preview(
    dashboard_id: str,
    owner_key: str,
    preview_id: str,
    session_key: str | None = None,
) -> dict[str, Any]:
    ensure_dashboard_source_configured(dashboard_id)
    now = time.time()
    with _lock:
        entry = _previews.get(preview_id)
        if (
            not entry
            or entry.owner_key != owner_key
            or entry.dashboard_id != dashboard_id
            or (session_key is not None and entry.session_key != session_key)
        ):
            raise DataSourceError("data_source_preview_not_found", 404)
        if entry.expires_at <= now:
            _previews.pop(preview_id, None)
            raise DataSourceError("data_source_preview_expired", 410)

        imported_at = datetime.now(timezone.utc).isoformat()
        parsed_to_save = entry.parsed
        period_to_save = entry.period
        rows_to_save = entry.row_count
        try:
            if dashboard_id == "taxa":
                current_source = read_saved_dashboard_source(
                    data_root(get_settings().data_directory), dashboard_id, owner_key
                )
                history_merge = merge_taxa_history(
                    current_source.get("parsed") if current_source else None,
                    entry.parsed,
                )
                parsed_to_save = history_merge.parsed
                period_to_save = history_merge.merged_period
                rows_to_save = history_merge.resulting_rows
            source = save_dashboard_source(
                data_root(get_settings().data_directory),
                dashboard_id,
                owner_key,
                entry.file_name,
                parsed_to_save,
                entry.source_bytes,
                imported_at=imported_at,
                file_size_bytes=entry.file_size_bytes,
                content_type=entry.content_type,
                period=period_to_save,
                row_count=rows_to_save,
            )
        except TaxaHistoryError as error:
            raise DataSourceError(error.code, 422) from error
        except LocalWorkbookError as error:
            raise DataSourceError(str(error), 500) from error
        _previews.pop(preview_id, None)

    logger.info("Local dashboard data source imported (dashboard_id=%s, rows=%s)", dashboard_id, rows_to_save)
    return serialize_source(source)


def serialize_source(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "sourceType": "MANUAL_UPLOAD",
        "fileName": source["fileName"],
        "fileSizeBytes": source["fileSizeBytes"],
        "contentType": source["contentType"],
        "importedAt": source["importedAt"],
        "rowCount": source["rowCount"],
        "period": source["period"],
        "status": "loaded",
        "parsed": source["parsed"],
    }


def get_dashboard_source(dashboard_id: str, owner_key: str) -> dict[str, Any] | None:
    ensure_dashboard_source_configured(dashboard_id)
    try:
        source = read_saved_dashboard_source(data_root(get_settings().data_directory), dashboard_id, owner_key)
    except LocalWorkbookError as error:
        raise DataSourceError(str(error), 500) from error
    return serialize_source(source) if source else None


def remove_dashboard_source(dashboard_id: str, owner_key: str) -> None:
    ensure_dashboard_source_configured(dashboard_id)
    try:
        remove_saved_dashboard_source(data_root(get_settings().data_directory), dashboard_id, owner_key)
    except LocalWorkbookError as error:
        raise DataSourceError(str(error), 500) from error
    logger.info("Local dashboard data source removed (dashboard_id=%s)", dashboard_id)


def create_owner_key(identity: dict[str, str | None], session_secret: str) -> str:
    # Persist sources by the private, stable Feishu tenant_key + open_id
    # digest. Display names and regional scope are mutable/non-unique and must
    # not identify the owner. The digest is HMACed again for the disk key.
    stable_subject = (identity.get("_owner_subject") or "").strip()
    if not stable_subject:
        raise DataSourceError("data_source_identity_unavailable", 409)
    return hmac.new(session_secret.encode(), stable_subject.encode(), hashlib.sha256).hexdigest()


def create_published_source_key(dashboard_id: str, session_secret: str) -> str:
    """Stable, private filesystem key shared by every viewer of one dashboard."""
    if dashboard_id not in KNOWN_DASHBOARD_IDS:
        raise DataSourceError("data_source_dashboard_unconfigured", 409)
    value = f"published-dashboard-source:v1:{dashboard_id}"
    return hmac.new(session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def create_preview_key(session_token: str, session_secret: str) -> str:
    return hmac.new(session_secret.encode(), session_token.encode(), hashlib.sha256).hexdigest()
