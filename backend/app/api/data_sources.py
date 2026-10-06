from __future__ import annotations

import logging
import json

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from app.core.config import get_settings
from app.schemas.data_sources import ImportSourceRequest, PreviewSourceRequest
from app.services.data_sources import (
    MAX_SOURCE_FILE_BYTES,
    DataSourceError,
    create_owner_key,
    create_preview_key,
    create_dashboard_preview,
    ensure_dashboard_source_configured,
    get_dashboard_source,
    import_dashboard_preview,
    remove_dashboard_source,
)
from app.services.feishu_auth import SESSION_COOKIE, get_local_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/data-sources", tags=["data sources"])
MAX_PREVIEW_REQUEST_BYTES = 64 * 1024 * 1024


def _authenticated_owner(request: Request) -> tuple[str, str, dict[str, str | None]]:
    settings = get_settings()
    if settings.app_env != "development":
        raise HTTPException(status_code=404, detail="local_data_sources_only")
    token = request.cookies.get(SESSION_COOKIE)
    identity = get_local_session(token, settings)
    if not token or not identity:
        raise HTTPException(status_code=401, detail="authentication_required")
    if not settings.feishu_session_secret:
        raise HTTPException(status_code=503, detail="authentication_unavailable")
    try:
        owner_key = create_owner_key(identity, settings.feishu_session_secret)
    except DataSourceError as error:
        raise _translate_error(error) from None
    return (
        owner_key,
        create_preview_key(token, settings.feishu_session_secret),
        identity,
    )


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
async def preview_dashboard_source(dashboard_id: str, request: Request) -> dict[str, object]:
    owner_key, session_key, identity = _authenticated_owner(request)
    try:
        ensure_dashboard_source_configured(dashboard_id)
        payload, source_bytes = await _preview_request(request)
        return create_dashboard_preview(dashboard_id, owner_key, identity, payload, source_bytes, session_key)
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.post("/{dashboard_id}/import")
async def import_dashboard_data_source(
    dashboard_id: str,
    payload: ImportSourceRequest,
    request: Request,
) -> dict[str, object]:
    owner_key, session_key, _identity = _authenticated_owner(request)
    try:
        return import_dashboard_preview(dashboard_id, owner_key, payload.preview_id, session_key)
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.get("/{dashboard_id}")
async def current_dashboard_source(dashboard_id: str, request: Request) -> dict[str, object]:
    owner_key, _session_key, _identity = _authenticated_owner(request)
    try:
        return {"source": get_dashboard_source(dashboard_id, owner_key)}
    except DataSourceError as error:
        raise _translate_error(error) from None


@router.delete("/{dashboard_id}", status_code=204)
async def delete_dashboard_source(dashboard_id: str, request: Request) -> Response:
    owner_key, _session_key, _identity = _authenticated_owner(request)
    try:
        remove_dashboard_source(dashboard_id, owner_key)
    except DataSourceError as error:
        raise _translate_error(error) from None
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
