from __future__ import annotations

import base64
import binascii
import hmac
import hashlib
import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import UploadFile

from app.core.config import get_settings
from app.api.dependencies import AuthenticatedViewer, get_current_viewer, require_admin
from app.services.row_scope import scope_parsed_rows
from app.services.local_workbooks import (
    HISTORY_KINDS,
    WORKBOOK_KINDS,
    LocalWorkbookError,
    data_root,
    get_workbook,
    save_workbook,
)
from app.services.responsibility_workbooks import (
    ResponsibilityWorkbookError,
    create_preview as create_responsibility_preview,
    publish_preview as publish_responsibility_preview,
    validate_responsibility_workbook,
)
from app.services.feishu_auth import SESSION_COOKIE

logger = logging.getLogger(__name__)
router = APIRouter(tags=["workbooks"])
MAX_REQUEST_BYTES = 320 * 1024 * 1024
MAX_FILE_BYTES = 250 * 1024 * 1024
REGION_HEADERS = (
    "Regional responsável", "Regional mais recente", "Regional Remetente",
    "Regional Origem", "Nome da regional", "Regional 区域", "Regional", "区域",
)
SELLER_ID_HEADERS = ("Id Seller/remetente", "global_seller_id", "Id Seller", "Seller", "商家ID", "Seller ID")


class WorkbookPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    kind: str
    file_name: str = Field(alias="fileName", min_length=1, max_length=512)
    parsed: dict[str, Any]
    merge_history: bool = Field(default=False, alias="mergeHistory")


class ResponsibilityPublishPayload(BaseModel):
    preview_id: str = Field(alias="previewId", pattern=r"^[0-9a-f-]{36}$")


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status, headers={"Cache-Control": "no-store"})


def _normalized(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", without_marks.lower())


def _column(headers: list[str], candidates: tuple[str, ...]) -> str | None:
    normalized = {_normalized(header): header for header in headers}
    return next((normalized[_normalized(candidate)] for candidate in candidates if _normalized(candidate) in normalized), None)


def _responsibility_data(root: Path, kind: str) -> dict[str, Any] | None:
    if kind == "responsibilityList":
        return None
    entry = get_workbook(root, "responsibilityList")
    return entry[1] if entry else None


def _responsibility_owner_key(request: Request) -> str:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="authentication_required")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _responsibility_source_payload(metadata: dict[str, Any], parsed: dict[str, Any], stats: dict[str, Any]) -> dict[str, Any]:
    updated_at = metadata.get("updatedAt")
    return {
        "fileName": metadata.get("fileName"),
        "updatedAt": updated_at,
        "publishedAt": updated_at,
        "sheetName": parsed.get("sheetName", ""),
        "versionId": metadata.get("latestVersion"),
        "status": "ACTIVE",
        **stats,
    }


def _seller_ids(
    performance: dict[str, Any] | None,
    identity: dict[str, str | None],
    responsibility: dict[str, Any] | None = None,
) -> set[str]:
    if not performance:
        return set()
    scoped = scope_parsed_rows(performance, identity, responsibility)
    seller_column = _column(scoped.get("headers", []), SELLER_ID_HEADERS)
    return {
        str(row.get(seller_column, "")).strip()
        for row in scoped.get("rows", [])
        if seller_column and row.get(seller_column) is not None
    }


def _scope_kind(parsed: dict[str, Any], kind: str, identity: dict[str, str | None]) -> dict[str, Any]:
    root = data_root(get_settings().data_directory)
    responsibility = _responsibility_data(root, kind)
    if (identity.get("role") or "").lower() == "matrix":
        return scope_parsed_rows(parsed, identity, responsibility)
    if kind not in {"sellerList", "sellerSpecialList"}:
        return scope_parsed_rows(parsed, identity, responsibility)
    performance_entry = get_workbook(root, "sellerPerformance")
    performance = performance_entry[1] if performance_entry else None
    allowed = _seller_ids(performance, identity, responsibility)
    special = kind == "sellerSpecialList"
    rows: list[dict[str, Any]] = []
    if special:
        codes: set[str] = set()
        for row in parsed.get("rows", []):
            for value in row.values():
                codes.update(re.findall(r"(?<!\d)\d{19}(?!\d)", str(value or "")))
        rows = [{"商家ID": code} for code in sorted(codes & allowed)]
        return {**parsed, "headers": ["商家ID"], "rows": rows}
    seller_column = _column(parsed.get("headers", []), SELLER_ID_HEADERS)
    rows = [row for row in parsed.get("rows", []) if seller_column and str(row.get(seller_column, "")).strip() in allowed]
    return {**parsed, "rows": rows}


def _decode_basic(value: str | None) -> tuple[str, str] | None:
    if not value or not value.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(value[6:], validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    username, separator, password = decoded.partition(":")
    return (username, password) if separator else None


def _upload_authorized(request: Request) -> bool:
    settings = get_settings()
    expected_username = settings.upload_username
    expected_password = settings.upload_password
    actual = _decode_basic(request.headers.get("authorization"))
    if not expected_username or not expected_password or not actual:
        return False
    return hmac.compare_digest(actual[0], expected_username) and hmac.compare_digest(actual[1], expected_password)


def _upload_error(request: Request) -> JSONResponse | None:
    settings = get_settings()
    if not settings.upload_username or not settings.upload_password:
        return _error("upload_auth_not_configured", 503)
    if not _upload_authorized(request):
        return _error("upload_auth_invalid", 401)
    return None


async def _parse_post(request: Request) -> tuple[WorkbookPayload, list[tuple[str, bytes]]]:
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > MAX_REQUEST_BYTES:
                raise ValueError("workbook_request_too_large")
        except ValueError as error:
            if str(error) == "workbook_request_too_large":
                raise
            raise ValueError("workbook_request_invalid") from None
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        async with request.form(max_files=10, max_fields=8, max_part_size=MAX_REQUEST_BYTES) as form:
            raw_payload = form.get("payload")
            if not isinstance(raw_payload, str):
                raise ValueError("workbook_request_invalid")
            if len(raw_payload.encode("utf-8")) > 64 * 1024 * 1024:
                raise ValueError("workbook_request_too_large")
            try:
                payload = WorkbookPayload.model_validate_json(raw_payload)
            except ValidationError as error:
                raise ValueError("workbook_request_invalid") from error
            files: list[tuple[str, bytes]] = []
            total = 0
            for item in form.getlist("files"):
                if not isinstance(item, UploadFile):
                    raise ValueError("workbook_request_invalid")
                if not re.search(r"\.xlsx?$", item.filename or "", re.IGNORECASE):
                    raise ValueError("workbook_file_type_invalid")
                content = await item.read(MAX_FILE_BYTES + 1)
                if len(content) > MAX_FILE_BYTES:
                    raise ValueError("workbook_file_too_large")
                total += len(content)
                files.append((item.filename or "", content))
            if total > MAX_REQUEST_BYTES:
                raise ValueError("workbook_request_too_large")
            return payload, files
    try:
        body = await request.body()
        if len(body) > MAX_REQUEST_BYTES:
            raise ValueError("workbook_request_too_large")
        return WorkbookPayload.model_validate_json(body), []
    except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("workbook_request_invalid") from error


@router.post("/upload-auth")
async def verify_upload_auth(
    request: Request,
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> Response:
    error = _upload_error(request)
    if error:
        return error
    return JSONResponse({"authenticated": True}, headers={"Cache-Control": "no-store"})


@router.get("/workbook/responsibility-list")
async def responsibility_workbook_metadata(
    _viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> Response:
    root = data_root(get_settings().data_directory)
    try:
        stored = get_workbook(root, "responsibilityList")
        if not stored:
            return JSONResponse({"source": None}, headers={"Cache-Control": "no-store"})
        metadata, parsed = stored
        stats = validate_responsibility_workbook(parsed)
        return JSONResponse({
            "source": _responsibility_source_payload(metadata, parsed, stats)
        }, headers={"Cache-Control": "no-store"})
    except ResponsibilityWorkbookError as error:
        return _error(error.code, error.status_code)
    except LocalWorkbookError as error:
        return _error(str(error), 500)


@router.post("/workbook/responsibility-list/preview")
async def preview_responsibility_workbook(
    request: Request,
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> Response:
    try:
        payload, source_files = await _parse_post(request)
        if payload.kind != "responsibilityList":
            return _error("responsibility_list_kind_invalid", 400)
        if len(source_files) != 1 or len(source_files[0][1]) > 20 * 1024 * 1024:
            return _error("responsibility_list_file_invalid", 413)
        preview_id, stats = create_responsibility_preview(
            _responsibility_owner_key(request),
            payload.file_name,
            payload.parsed,
            source_files,
        )
        return JSONResponse({
            "previewId": preview_id,
            "fileName": payload.file_name,
            "sheetName": payload.parsed.get("sheetName", ""),
            **stats,
        }, headers={"Cache-Control": "no-store"})
    except ResponsibilityWorkbookError as error:
        return _error(error.code, error.status_code)
    except ValueError as error:
        code = str(error)
        return _error(code if re.fullmatch(r"[a-z0-9_]+", code) else "workbook_request_invalid", 400)


@router.post("/workbook/responsibility-list/publish")
async def publish_responsibility_workbook(
    request: Request,
    payload: ResponsibilityPublishPayload,
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> Response:
    try:
        published = publish_responsibility_preview(
            payload.preview_id,
            _responsibility_owner_key(request),
            data_root(get_settings().data_directory),
        )
        return JSONResponse({
            "source": _responsibility_source_payload(published, published, published)
        }, headers={"Cache-Control": "no-store"})
    except ResponsibilityWorkbookError as error:
        return _error(error.code, error.status_code)
    except LocalWorkbookError as error:
        return _error(str(error), 500)


@router.get("/workbook")
async def read_workbook(
    request: Request,
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> Response:
    identity = viewer.identity
    params = request.query_params
    kind = params.get("kind", "monitoring")
    if kind not in WORKBOOK_KINDS:
        return _error("workbook_kind_invalid", 400)
    part = params.get("part")
    root = data_root(get_settings().data_directory)
    try:
        stored = get_workbook(root, kind, part)
        if not stored:
            return JSONResponse({"workbook": None}, headers={"Cache-Control": "no-store"})
        metadata, parsed = stored
        if kind in HISTORY_KINDS and not part:
            return JSONResponse({
                "workbook": None,
                "historyParts": metadata["historyParts"],
                "fileName": metadata["fileName"],
                "updatedAt": metadata["updatedAt"],
            }, headers={"Cache-Control": "no-store"})
        assert identity is not None
        scoped = _scope_kind(parsed, kind, identity)
        return JSONResponse({"workbook": {"fileName": metadata["fileName"], "updatedAt": metadata["updatedAt"], "parsed": scoped}}, headers={"Cache-Control": "no-store"})
    except PermissionError:
        return _error("viewer_scope_unavailable", 403)
    except LocalWorkbookError as error:
        return _error(str(error), 400 if "invalid" in str(error) else 500)


@router.post("/workbook")
async def write_workbook(
    request: Request,
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> Response:
    try:
        payload, source_files = await _parse_post(request)
        if payload.kind not in WORKBOOK_KINDS:
            return _error("workbook_kind_invalid", 400)
        if (
            not isinstance(payload.parsed.get("rows"), list)
            or not payload.parsed.get("rows")
            or not isinstance(payload.parsed.get("headers"), list)
            or not all(isinstance(header, str) for header in payload.parsed["headers"])
            or not all(isinstance(row, dict) for row in payload.parsed["rows"])
        ):
            return _error("workbook_payload_invalid", 422)
        try:
            json.dumps(payload.parsed, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            return _error("workbook_payload_invalid", 422)
        metadata = save_workbook(data_root(get_settings().data_directory), payload.kind, payload.file_name, payload.parsed, source_files)
        logger.info("Local workbook published (kind=%s, source_count=%s, rows=%s)", payload.kind, len(source_files), len(payload.parsed.get("rows", [])))
        workbook: dict[str, Any] = {"fileName": metadata["fileName"], "updatedAt": metadata["updatedAt"]}
        if payload.kind not in HISTORY_KINDS:
            workbook["parsed"] = payload.parsed
        response: dict[str, Any] = {"workbook": workbook}
        if payload.kind == "taxa":
            response["historyMerge"] = {"addedDates": 0, "replacedDates": 0, "totalDates": 0, "totalRows": len(payload.parsed.get("rows", []))}
        return JSONResponse(response, headers={"Cache-Control": "no-store"})
    except ValueError as error:
        code = str(error)
        status = 413 if "large" in code or "too_large" in code else 400
        return _error(code if re.fullmatch(r"[a-z0-9_]+", code) else "workbook_request_invalid", status)
    except LocalWorkbookError as error:
        code = str(error)
        return _error(code, 422 if "invalid" in code else 500)
    except Exception as error:
        logger.exception("Local workbook publication failed (error_type=%s)", type(error).__name__)
        return _error("workbook_publish_failed", 500)
