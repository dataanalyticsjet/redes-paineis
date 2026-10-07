from __future__ import annotations

import logging
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.core.config import get_settings
from app.api.dependencies import AuthenticatedViewer, get_current_viewer
from app.db.session import get_db_session
from app.schemas.data_sources import ImportSourceRequest, PreviewSourceRequest
from app.services.data_sources import (
    MAX_SOURCE_FILE_BYTES,
    DataSourceError,
    create_preview_key,
    create_published_source_key,
    create_dashboard_preview,
    ensure_dashboard_source_configured,
    get_dashboard_source,
    import_dashboard_preview,
    remove_dashboard_source,
)
from app.services.feishu_auth import SESSION_COOKIE
from app.services.row_scope import scope_parsed_rows

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/data-sources", tags=["data sources"])
MAX_PREVIEW_REQUEST_BYTES = 64 * 1024 * 1024


def _data_source_viewer(
    request: Request,
    db: Session = Depends(get_db_session),
) -> AuthenticatedViewer:
    settings = get_settings()
    if not settings.data_sources_enabled:
        raise HTTPException(status_code=404, detail="local_data_sources_only")
    return get_current_viewer(request, db)


def _data_source_admin(
    viewer: AuthenticatedViewer = Depends(_data_source_viewer),
) -> AuthenticatedViewer:
    if viewer.user.platform_role != "ADMIN":
        raise HTTPException(status_code=403, detail="admin_required")
    return viewer


def _published_owner_key(dashboard_id: str) -> str:
    settings = get_settings()
    try:
        ensure_dashboard_source_configured(dashboard_id)
    except DataSourceError as error:
        raise _translate_error(error) from None
    if not settings.feishu_session_secret:
        raise HTTPException(status_code=503, detail="authentication_unavailable")
    try:
        owner_key = create_published_source_key(dashboard_id, settings.feishu_session_secret)
    except DataSourceError as error:
        raise _translate_error(error) from None
    return owner_key


def _session_preview_key(request: Request) -> str:
    token = request.cookies.get(SESSION_COOKIE)
    settings = get_settings()
    if not token or not settings.feishu_session_secret:
        raise HTTPException(status_code=401, detail="authentication_required")
    return create_preview_key(token, settings.feishu_session_secret)


def _scope_source(source: dict[str, object] | None, viewer: AuthenticatedViewer) -> dict[str, object] | None:
    if source is None:
        return None
    parsed_value = source.get("parsed")
    if not isinstance(parsed_value, dict):
        return source
    try:
        parsed = scope_parsed_rows(parsed_value, viewer.identity)
    except PermissionError:
        raise HTTPException(status_code=403, detail="viewer_scope_unavailable") from None
    scoped = {**source, "parsed": parsed, "rowCount": len(parsed.get("rows") or [])}
    return scoped


def _translate_error(error: DataSourceError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.code)


async def _preview_request(request: Request) -> tuple[PreviewSourceRequest, bytes | None]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_PREVIEW_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="data_source_preview_too_large")
        except HTTPException:
            raise
        except ValueError:
            raise HTTPException(status_code=400, detail="data_source_request_invalid") from None

    content_type = request.headers.get("content-type", "")
    source_bytes = None
    if content_type.startswith("multipart/form-data"):
        async with request.form(max_files=1, max_fields=4, max_part_size=MAX_PREVIEW_REQUEST_BYTES) as form:
            raw_payload = form.get("payload")
            if not isinstance(raw_payload, str):
                raise HTTPException(status_code=422, detail="data_source_request_invalid")
            try:
                payload = PreviewSourceRequest.model_validate_json(raw_payload)
            except ValidationError:
                raise HTTPException(status_code=422, detail="data_source_request_invalid") from None
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise HTTPException(status_code=422, detail="data_source_file_missing")
            source_bytes = await upload.read(MAX_SOURCE_FILE_BYTES + 1)
            if len(source_bytes) > MAX_SOURCE_FILE_BYTES:
                raise HTTPException(status_code=413, detail="data_source_file_too_large")
            if len(source_bytes) != payload.file_size_bytes:
                raise HTTPException(status_code=422, detail="data_source_file_size_mismatch")
            if upload.filename != payload.file_name:
                raise HTTPException(status_code=422, detail="data_source_file_name_mismatch")
            if upload.content_type and payload.content_type and upload.content_type != payload.content_type:
                raise HTTPException(status_code=422, detail="data_source_mime_extension_mismatch")
    else:
        body = await request.body()
        if len(body) > MAX_PREVIEW_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="data_source_preview_too_large")
        try:
            payload = PreviewSourceRequest.model_validate_json(body)
        except (ValidationError, json.JSONDecodeError):
            raise HTTPException(status_code=422, detail="data_source_request_invalid") from None
    if payload.file_size_bytes > MAX_SOURCE_FILE_BYTES:
        raise HTTPException(status_code=413, detail="data_source_file_too_large")
    return payload, source_bytes


@router.post("/{dashboard_id}/preview")
async def preview_dashboard_source(
    dashboard_id: str,
    request: Request,
    admin: AuthenticatedViewer = Depends(_data_source_admin),
) -> dict[str, object]:
    owner_key = _published_owner_key(dashboard_id)
    session_key = _session_preview_key(request)
    try:
        ensure_dashboard_source_configured(dashboard_id)
        payload, source_bytes = await _preview_request(request)
        return create_dashboard_preview(dashboard_id, owner_key, admin.identity, payload, source_bytes, session_key)
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.post("/{dashboard_id}/import")
async def import_dashboard_data_source(
    dashboard_id: str,
    payload: ImportSourceRequest,
    request: Request,
    admin: AuthenticatedViewer = Depends(_data_source_admin),
) -> dict[str, object]:
    owner_key = _published_owner_key(dashboard_id)
    session_key = _session_preview_key(request)
    try:
        source = import_dashboard_preview(dashboard_id, owner_key, payload.preview_id, session_key)
        return _scope_source(source, admin) or {"source": None}
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.get("/{dashboard_id}")
async def current_dashboard_source(
    dashboard_id: str,
    viewer: AuthenticatedViewer = Depends(_data_source_viewer),
) -> dict[str, object]:
    owner_key = _published_owner_key(dashboard_id)
    try:
        return {"source": _scope_source(get_dashboard_source(dashboard_id, owner_key), viewer)}
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.delete("/{dashboard_id}", status_code=204)
async def delete_dashboard_source(
    dashboard_id: str,
    _admin: AuthenticatedViewer = Depends(_data_source_admin),
) -> Response:
    owner_key = _published_owner_key(dashboard_id)
    try:
        remove_dashboard_source(dashboard_id, owner_key)
    except DataSourceError as error:
        raise _translate_error(error) from None
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
