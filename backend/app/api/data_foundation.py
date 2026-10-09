from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import text

from app.api.dependencies import AuthenticatedViewer, get_current_viewer, require_admin
from app.core.config import get_settings
from app.db.session import get_data_database_engine
from app.services.data_foundation.contracts import CONTRACTS, INITIAL_MAPPING_WORKBOOK_SHA256
from app.services.data_foundation.queries import export_records, get_date_counts, get_publications, get_records
from app.services.data_foundation.repository import (
    DataFoundationError,
    create_preview_job,
    get_name_mapping_candidates,
    get_job_status,
    load_mapping_resolver,
    publish_import_job,
    publish_initial_mapping_migration,
    record_name_mapping_decision,
    save_uploaded_workbook,
    validate_job_again,
)
from app.services.data_foundation.xlsx_parser import WorkbookValidationError, parse_workbook


router = APIRouter(prefix="/v2", tags=["data foundation v2"])
MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024
MAX_PAGE_SIZE = 250
MAX_EXPORT_ROWS = 10_000


class NameMappingDecisionPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    source_id: str = Field(alias="sourceId", min_length=1, max_length=64)
    source_base_name: str = Field(alias="sourceBaseName", min_length=1, max_length=191)
    resolution_state: Literal["LINKED", "AMBIGUOUS", "REJECTED"] = Field(alias="resolutionState")
    target_base_code: str | None = Field(default=None, alias="targetBaseCode", max_length=64)
    review_note: str = Field(alias="reviewNote", min_length=1, max_length=500)


def _require_feature(*, imports: bool = False) -> None:
    settings = get_settings()
    enabled = settings.data_import_enabled if imports else settings.data_queries_enabled
    if not enabled:
        raise HTTPException(status_code=503, detail="data_foundation_v2_disabled")


def _engine():
    try:
        return get_data_database_engine()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


def _same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    expected = str(get_settings().frontend_base_url).rstrip("/")
    if not origin or origin.rstrip("/") != expected:
        raise HTTPException(status_code=403, detail="same_origin_required")


def _safe_upload_name(name: str | None) -> str:
    if not name:
        raise HTTPException(status_code=400, detail="workbook_file_name_required")
    basename = Path(name.replace("\\", "/")).name
    if not basename.lower().endswith(".xlsx") or len(basename) > 255:
        raise HTTPException(status_code=422, detail="workbook_file_type_invalid")
    if basename in {".", ".."} or any(ord(char) < 32 for char in basename):
        raise HTTPException(status_code=422, detail="workbook_file_name_invalid")
    return basename


def _request_id(request: Request) -> str | None:
    candidate = request.headers.get("x-request-id", "")
    if re.fullmatch(r"[A-Za-z0-9._:-]{1,96}", candidate):
        return candidate
    return None


def _error(error: DataFoundationError | WorkbookValidationError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.code)


def _source_contract(source_id: str):
    try:
        return CONTRACTS[source_id]
    except KeyError:
        raise HTTPException(status_code=404, detail="data_source_not_found") from None


def _as_csv_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (date,)):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()  # datetime
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


@router.get("/data-sources")
def list_data_sources(
    _viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        with _engine().connect() as connection:
            rows = connection.exec_driver_sql("""
                SELECT source_id, display_name, source_state, history_policy
                FROM data_source_registry
                WHERE source_id <> 'base_mapping_official'
                ORDER BY display_name
            """).mappings()
            sources = [dict(row) for row in rows]
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    return {"sources": sources}


@router.get("/data-sources/{source_id}/contract")
def get_source_contract(
    source_id: str,
    _viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    contract = _source_contract(source_id)
    try:
        with _engine().connect() as connection:
            registered = connection.execute(text("""
                SELECT contract_state, expected_sheet, header_row, history_policy, contract_sha256
                FROM source_contract_versions
                WHERE source_id = :source_id AND contract_version = :contract_version
            """), {"source_id": source_id, "contract_version": contract.version}).mappings().first()
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    if registered is None:
        raise HTTPException(status_code=404, detail="source_contract_not_found")
    return {
        "sourceId": source_id,
        "version": contract.version,
        "state": str(registered["contract_state"]),
        "sheet": registered["expected_sheet"],
        "headerRow": registered["header_row"],
        "historyPolicy": str(registered["history_policy"]),
        "contractSha256": bytes(registered["contract_sha256"]).hex() if registered["contract_sha256"] else None,
        "grain": contract.grain_description,
        "columns": [
            {
                "key": column.key,
                "header": column.header,
                "type": column.kind,
                "required": True,
                "nullable": column.nullable,
            }
            for column in contract.columns
        ],
    }


@router.post("/imports/preview")
async def preview_import(
    request: Request,
    source_id: str = Form(..., min_length=1, max_length=64),
    file: UploadFile = File(...),
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    contract = _source_contract(source_id)
    if source_id == "base_mapping_official":
        raise HTTPException(status_code=422, detail="use_base_mapping_migration_endpoint")
    file_name = _safe_upload_name(file.filename)
    content = await file.read(MAX_IMPORT_FILE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="workbook_empty")
    if len(content) > MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=413, detail="workbook_file_too_large")
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")

    engine = _engine()
    try:
        with engine.connect() as connection:
            resolver = load_mapping_resolver(connection, source_id=source_id)
        summary = parse_workbook(content, contract, resolver)
        stored_key = save_uploaded_workbook(settings.data_import_staging_directory, content)
        try:
            with engine.connect() as connection:
                job_id = create_preview_job(
                    connection,
                    source_id=source_id,
                    actor_user_id=admin.user.id,
                    file_name=file_name,
                    file_size=len(content),
                    stored_file_key=stored_key,
                    summary=summary,
                    request_id=_request_id(request),
                )
        except Exception:
            (settings.data_import_staging_directory.expanduser().resolve() / stored_key).unlink(missing_ok=True)
            raise
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    except OSError:
        raise HTTPException(status_code=503, detail="import_storage_unavailable") from None
    return {"jobId": job_id, **summary.as_api_dict()}


@router.post("/base-mapping/initial-migration/preview")
async def preview_initial_mapping_migration(
    request: Request,
    file: UploadFile = File(...),
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    contract = CONTRACTS["base_mapping_official"]
    file_name = _safe_upload_name(file.filename)
    content = await file.read(MAX_IMPORT_FILE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="workbook_empty")
    if len(content) > MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=413, detail="workbook_file_too_large")
    if hashlib.sha256(content).hexdigest() != INITIAL_MAPPING_WORKBOOK_SHA256:
        raise HTTPException(status_code=422, detail="legacy_mapping_source_hash_not_reviewed")
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    engine = _engine()
    try:
        summary = parse_workbook(content, contract)
        if summary.input_row_count != 1628:
            summary.invalid_row_count += 1
            summary.add_error(0, None, "legacy_mapping_1628_rows_required")
        stored_key = save_uploaded_workbook(settings.data_import_staging_directory, content)
        try:
            with engine.connect() as connection:
                job_id = create_preview_job(
                    connection,
                    source_id="base_mapping_official",
                    actor_user_id=admin.user.id,
                    file_name=file_name,
                    file_size=len(content),
                    stored_file_key=stored_key,
                    summary=summary,
                    request_id=_request_id(request),
                )
        except Exception:
            (settings.data_import_staging_directory.expanduser().resolve() / stored_key).unlink(missing_ok=True)
            raise
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    except OSError:
        raise HTTPException(status_code=503, detail="import_storage_unavailable") from None
    return {
        "jobId": job_id,
        "migrationMode": "preserve_legacy_original_as_version_1",
        "expectedBaseCount": 1628,
        **summary.as_api_dict(),
    }


@router.post("/base-mapping/initial-migration/{job_id}/publish")
def publish_initial_mapping_migration_route(
    job_id: str,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128),
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    if not idempotency_key:
        raise HTTPException(status_code=422, detail="idempotency_key_required")
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        return publish_initial_mapping_migration(
            _engine(),
            job_id=job_id,
            actor_user_id=admin.user.id,
            staging_directory=settings.data_import_staging_directory,
            request_id=_request_id(request),
        )
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/base-mapping/name-candidates/{job_id}")
def list_name_mapping_candidates(
    job_id: str,
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        return get_name_mapping_candidates(
            _engine(),
            job_id=job_id,
            actor_user_id=admin.user.id,
            staging_directory=settings.data_import_staging_directory,
        )
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    except OSError:
        raise HTTPException(status_code=503, detail="import_storage_unavailable") from None


@router.post("/base-mapping/name-decisions")
def create_name_mapping_decision(
    payload: NameMappingDecisionPayload,
    request: Request,
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    try:
        return record_name_mapping_decision(
            _engine(),
            source_id=payload.source_id,
            source_base_name=payload.source_base_name,
            resolution_state=payload.resolution_state,
            target_base_code=payload.target_base_code,
            review_note=payload.review_note,
            actor_user_id=admin.user.id,
            request_id=_request_id(request),
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.post("/imports/{job_id}/validate")
def validate_import(
    job_id: str,
    request: Request,
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        return validate_job_again(
            _engine(),
            job_id=job_id,
            actor_user_id=admin.user.id,
            staging_directory=settings.data_import_staging_directory,
        )
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.post("/imports/{job_id}/publish")
def publish_import(
    job_id: str,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128),
    admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    if not idempotency_key:
        raise HTTPException(status_code=422, detail="idempotency_key_required")
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        publication = publish_import_job(
            _engine(),
            job_id=job_id,
            actor_user_id=admin.user.id,
            staging_directory=settings.data_import_staging_directory,
            idempotency_key=idempotency_key,
            request_id=_request_id(request),
        )
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    return publication


@router.get("/imports/{job_id}")
def import_status(
    job_id: str,
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature(imports=True)
    if viewer.user.platform_role != "ADMIN":
        raise HTTPException(status_code=403, detail="admin_required")
    try:
        return get_job_status(_engine(), job_id, viewer.user.id)
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/dates")
def data_source_dates(
    source_id: str,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    base_code: str | None = Query(default=None, max_length=64),
    region: str | None = Query(default=None, max_length=64),
    publication_id: str | None = Query(default=None, max_length=36),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_date_counts(
            _engine(), source_id=source_id, identity=viewer.identity,
            date_from=date_from, date_to=date_to, base_code=base_code, region=region,
            publication_id=publication_id,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/publications")
def data_source_publications(
    source_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_publications(
            _engine(), source_id=source_id, identity=viewer.identity,
            limit=limit, offset=offset,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/records")
def data_source_records(
    source_id: str,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    base_code: str | None = Query(default=None, max_length=64),
    region: str | None = Query(default=None, max_length=64),
    publication_id: str | None = Query(default=None, max_length=36),
    limit: int = Query(default=100, ge=1, le=MAX_PAGE_SIZE),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_records(
            _engine(), source_id=source_id, identity=viewer.identity,
            limit=limit, offset=offset, date_from=date_from, date_to=date_to,
            base_code=base_code, region=region, publication_id=publication_id,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/export.csv")
def export_data_source(
    source_id: str,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    base_code: str | None = Query(default=None, max_length=64),
    region: str | None = Query(default=None, max_length=64),
    publication_id: str | None = Query(default=None, max_length=36),
    limit: int = Query(default=MAX_EXPORT_ROWS, ge=1, le=MAX_EXPORT_ROWS),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> StreamingResponse:
    _require_feature()
    try:
        headers, records = export_records(
            _engine(), source_id=source_id, identity=viewer.identity,
            limit=limit, offset=offset, date_from=date_from, date_to=date_to,
            base_code=base_code, region=region, publication_id=publication_id,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None

    output = io.StringIO(newline="")
    writer = csv.writer(output)
    if headers:
        writer.writerow(headers)
    for record in records:
        writer.writerow([_as_csv_value(record.get(header)) for header in headers])
    filename = f"{source_id}-dados.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Export-Limit": str(limit),
        },
    )

