from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import text
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from app.api.dependencies import AuthenticatedViewer, get_current_viewer, require_admin, require_matrix_admin
from app.core.config import get_settings
from app.db.session import get_data_database_engine
from app.services.data_foundation.contracts import CONTRACTS, INITIAL_MAPPING_WORKBOOK_SHA256, get_contract
from app.services.data_foundation.queries import (
    export_records,
    get_current_mapping_status,
    get_date_counts,
    get_publications,
    get_records,
)
from app.services.data_foundation.repository import (
    DataFoundationError,
    create_preview_job,
    create_received_import_job,
    get_name_mapping_candidates,
    get_job_status,
    load_mapping_resolver,
    publish_import_job,
    publish_initial_mapping_migration,
    record_name_mapping_decision,
    save_uploaded_workbook,
    save_uploaded_workbook_stream,
    write_preview_manifest,
    process_t4t5_preview_job,
    queue_t4t5_preview_validation,
    queue_t4t5_publication,
    publish_t4t5_import_job,
    validate_job_again,
)
from app.services.data_foundation.xlsx_parser import WorkbookValidationError, parse_workbook
from app.services.collection_monitoring_t4_t5 import (
    MAX_GROUP_PAGE_SIZE,
    MAX_PAGE_SIZE as T4T5_MAX_PAGE_SIZE,
    T4T5Filters,
    create_xlsx_export,
    get_dashboard_summary,
    get_detail_page,
    get_filter_options,
    get_group_page,
    get_seller_outcomes_summary,
)


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


def _require_metadata_feature() -> None:
    settings = get_settings()
    if not (settings.data_queries_enabled or settings.data_import_enabled):
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


def _source_contract(source_id: str, contract_version: int | None = None):
    try:
        return get_contract(source_id, contract_version)
    except KeyError:
        detail = "data_source_contract_version_not_supported" if contract_version is not None else "data_source_not_found"
        raise HTTPException(status_code=404, detail=detail) from None


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


def _t4t5_filters(
    *,
    region: str | None = None,
    rm_regional: str | None = None,
    base_code: str | None = None,
    source_base_name: str | None = None,
    rm_region: str | None = None,
    rm_responsible: str | None = None,
    customer_name: str | None = None,
    store_name: str | None = None,
    seller_id: str | None = None,
    assigned_driver: str | None = None,
    order_origin: str | None = None,
    search: str | None = None,
) -> T4T5Filters:
    return T4T5Filters(
        region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
        rm_region=rm_region, rm_responsible=rm_responsible,
        customer_name=customer_name, store_name=store_name, seller_id=seller_id,
        assigned_driver=assigned_driver, order_origin=order_origin, search=search,
    )


def _unlink_export(path: Path) -> None:
    path.unlink(missing_ok=True)


@router.get("/collection-monitoring-t4-t5/summary")
def collection_monitoring_t4_t5_summary(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    region: str | None = Query(default=None, max_length=64),
    rm_regional: str | None = Query(default=None, max_length=64),
    base_code: str | None = Query(default=None, max_length=64),
    source_base_name: str | None = Query(default=None, max_length=191),
    rm_region: str | None = Query(default=None, max_length=96),
    rm_responsible: str | None = Query(default=None, max_length=160),
    customer_name: str | None = Query(default=None, max_length=191),
    store_name: str | None = Query(default=None, max_length=191),
    seller_id: str | None = Query(default=None, max_length=64),
    assigned_driver: str | None = Query(default=None, max_length=191),
    order_origin: str | None = Query(default=None, max_length=96),
    search: str | None = Query(default=None, max_length=191),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_dashboard_summary(
            _engine(), identity=viewer.identity,
            filters=_t4t5_filters(
                region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
                rm_region=rm_region, rm_responsible=rm_responsible,
                customer_name=customer_name, store_name=store_name, seller_id=seller_id,
                assigned_driver=assigned_driver, order_origin=order_origin, search=search,
            ),
            date_from=date_from, date_to=date_to,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/collection-monitoring-t4-t5/seller-summary")
def collection_monitoring_t4_t5_seller_summary(
    snapshot_date: date = Query(...),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    region: str | None = Query(default=None, max_length=64),
    rm_regional: str | None = Query(default=None, max_length=64),
    base_code: str | None = Query(default=None, max_length=64),
    source_base_name: str | None = Query(default=None, max_length=191),
    rm_region: str | None = Query(default=None, max_length=96),
    rm_responsible: str | None = Query(default=None, max_length=160),
    customer_name: str | None = Query(default=None, max_length=191),
    store_name: str | None = Query(default=None, max_length=191),
    seller_id: str | None = Query(default=None, max_length=64),
    assigned_driver: str | None = Query(default=None, max_length=191),
    order_origin: str | None = Query(default=None, max_length=96),
    search: str | None = Query(default=None, max_length=191),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_seller_outcomes_summary(
            _engine(), identity=viewer.identity, snapshot_date=snapshot_date,
            date_from=date_from, date_to=date_to,
            filters=_t4t5_filters(
                region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
                rm_region=rm_region, rm_responsible=rm_responsible,
                customer_name=customer_name, store_name=store_name, seller_id=seller_id,
                assigned_driver=assigned_driver, order_origin=order_origin, search=search,
            ),
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/collection-monitoring-t4-t5/filters")
def collection_monitoring_t4_t5_filters(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_filter_options(
            _engine(), identity=viewer.identity, filters=T4T5Filters(),
            date_from=date_from, date_to=date_to,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/collection-monitoring-t4-t5/groups")
def collection_monitoring_t4_t5_groups(
    dimension: Literal["region", "rm", "pdd", "customer", "store", "driver"] = Query(...),
    snapshot_date: date = Query(...),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    region: str | None = Query(default=None, max_length=64),
    rm_regional: str | None = Query(default=None, max_length=64),
    base_code: str | None = Query(default=None, max_length=64),
    source_base_name: str | None = Query(default=None, max_length=191),
    rm_region: str | None = Query(default=None, max_length=96),
    rm_responsible: str | None = Query(default=None, max_length=160),
    customer_name: str | None = Query(default=None, max_length=191),
    store_name: str | None = Query(default=None, max_length=191),
    seller_id: str | None = Query(default=None, max_length=64),
    assigned_driver: str | None = Query(default=None, max_length=191),
    order_origin: str | None = Query(default=None, max_length=96),
    search: str | None = Query(default=None, max_length=191),
    limit: int = Query(default=100, ge=1, le=MAX_GROUP_PAGE_SIZE),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_group_page(
            _engine(), identity=viewer.identity, dimension=dimension,
            snapshot_date=snapshot_date,
            filters=_t4t5_filters(
                region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
                rm_region=rm_region, rm_responsible=rm_responsible,
                customer_name=customer_name, store_name=store_name, seller_id=seller_id,
                assigned_driver=assigned_driver, order_origin=order_origin, search=search,
            ),
            limit=limit, offset=offset,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/collection-monitoring-t4-t5/records")
def collection_monitoring_t4_t5_records(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    region: str | None = Query(default=None, max_length=64),
    rm_regional: str | None = Query(default=None, max_length=64),
    base_code: str | None = Query(default=None, max_length=64),
    source_base_name: str | None = Query(default=None, max_length=191),
    rm_region: str | None = Query(default=None, max_length=96),
    rm_responsible: str | None = Query(default=None, max_length=160),
    customer_name: str | None = Query(default=None, max_length=191),
    store_name: str | None = Query(default=None, max_length=191),
    seller_id: str | None = Query(default=None, max_length=64),
    assigned_driver: str | None = Query(default=None, max_length=191),
    order_origin: str | None = Query(default=None, max_length=96),
    search: str | None = Query(default=None, max_length=191),
    limit: int = Query(default=100, ge=1, le=T4T5_MAX_PAGE_SIZE),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_detail_page(
            _engine(), identity=viewer.identity,
            filters=_t4t5_filters(
                region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
                rm_region=rm_region, rm_responsible=rm_responsible,
                customer_name=customer_name, store_name=store_name, seller_id=seller_id,
                assigned_driver=assigned_driver, order_origin=order_origin, search=search,
            ),
            date_from=date_from, date_to=date_to, limit=limit, offset=offset,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/collection-monitoring-t4-t5/export.xlsx")
def collection_monitoring_t4_t5_export(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    region: str | None = Query(default=None, max_length=64),
    rm_regional: str | None = Query(default=None, max_length=64),
    base_code: str | None = Query(default=None, max_length=64),
    source_base_name: str | None = Query(default=None, max_length=191),
    rm_region: str | None = Query(default=None, max_length=96),
    rm_responsible: str | None = Query(default=None, max_length=160),
    customer_name: str | None = Query(default=None, max_length=191),
    store_name: str | None = Query(default=None, max_length=191),
    seller_id: str | None = Query(default=None, max_length=64),
    assigned_driver: str | None = Query(default=None, max_length=191),
    order_origin: str | None = Query(default=None, max_length=96),
    search: str | None = Query(default=None, max_length=191),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> FileResponse:
    _require_feature()
    try:
        path = create_xlsx_export(
            _engine(), identity=viewer.identity,
            filters=_t4t5_filters(
                region=region, rm_regional=rm_regional, base_code=base_code, source_base_name=source_base_name,
                rm_region=rm_region, rm_responsible=rm_responsible,
                customer_name=customer_name, store_name=store_name, seller_id=seller_id,
                assigned_driver=assigned_driver, order_origin=order_origin, search=search,
            ),
            date_from=date_from, date_to=date_to,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="monitoramento-coleta-t4-t5.xlsx",
        headers={"Cache-Control": "no-store"},
        background=BackgroundTask(_unlink_export, path),
    )


@router.get("/data-sources")
def list_data_sources(
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_metadata_feature()
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


@router.get("/base-mapping/current")
def current_base_mapping(
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_metadata_feature()
    try:
        return get_current_mapping_status(_engine(), identity=viewer.identity)
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/contract")
def get_source_contract(
    source_id: str,
    contract_version: int | None = Query(default=None, ge=1, le=65535),
    _admin: AuthenticatedViewer = Depends(require_admin),
) -> dict[str, object]:
    _require_metadata_feature()
    contract = _source_contract(source_id, contract_version)
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
    background_tasks: BackgroundTasks,
    source_id: str = Form(..., min_length=1, max_length=64),
    contract_version: int | None = Form(default=None, ge=1, le=65535),
    file: UploadFile = File(...),
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    contract = _source_contract(source_id, contract_version)
    if source_id == "base_mapping_official":
        raise HTTPException(status_code=422, detail="use_base_mapping_migration_endpoint")
    file_name = _safe_upload_name(file.filename)
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    engine = _engine()

    if source_id == "collection_monitoring_t4_t5":
        stored_key: str | None = None
        try:
            stored_key, file_size, file_sha256 = await run_in_threadpool(
                save_uploaded_workbook_stream,
                settings.data_import_staging_directory,
                file.file,
                max_bytes=MAX_IMPORT_FILE_BYTES,
            )
            write_preview_manifest(settings.data_import_staging_directory, stored_key, {
                "phase": "VALIDATION", "fileSha256": file_sha256,
            })
            with engine.connect() as connection:
                resolver = load_mapping_resolver(connection, source_id=source_id)
                if resolver.map_version_id is None:
                    raise DataFoundationError("official_mapping_unavailable", 409)
                connection.commit()
                job_id = create_received_import_job(
                    connection,
                    source_id=source_id,
                    actor_user_id=admin.user.id,
                    file_name=file_name,
                    file_size=file_size,
                    stored_file_key=stored_key,
                    file_sha256=file_sha256,
                    map_version_id=resolver.map_version_id,
                    request_id=_request_id(request),
                )
            background_tasks.add_task(
                process_t4t5_preview_job,
                engine,
                job_id=job_id,
                actor_user_id=admin.user.id,
                staging_directory=settings.data_import_staging_directory,
            )
        except (DataFoundationError, WorkbookValidationError) as error:
            if stored_key:
                (settings.data_import_staging_directory.expanduser().resolve() / stored_key).unlink(missing_ok=True)
                (settings.data_import_staging_directory.expanduser().resolve() / f"{stored_key}.preview.json").unlink(missing_ok=True)
            raise _error(error) from None
        except SQLAlchemyError:
            if stored_key:
                (settings.data_import_staging_directory.expanduser().resolve() / stored_key).unlink(missing_ok=True)
                (settings.data_import_staging_directory.expanduser().resolve() / f"{stored_key}.preview.json").unlink(missing_ok=True)
            raise HTTPException(status_code=503, detail="data_store_unavailable") from None
        except OSError:
            if stored_key:
                (settings.data_import_staging_directory.expanduser().resolve() / stored_key).unlink(missing_ok=True)
                (settings.data_import_staging_directory.expanduser().resolve() / f"{stored_key}.preview.json").unlink(missing_ok=True)
            raise HTTPException(status_code=503, detail="import_storage_unavailable") from None
        return {
            "jobId": job_id,
            "sourceId": source_id,
            "contractVersion": contract.version,
            "state": "RECEIVED",
            "phase": "VALIDATION",
            "inputRowCount": 0,
            "validRowCount": 0,
        }

    content = await file.read(MAX_IMPORT_FILE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="workbook_empty")
    if len(content) > MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=413, detail="workbook_file_too_large")
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
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
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
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
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
            idempotency_key=idempotency_key,
            request_id=_request_id(request),
        )
    except (DataFoundationError, WorkbookValidationError) as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/base-mapping/name-candidates/{job_id}")
def list_name_mapping_candidates(
    job_id: str,
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
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
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
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
    background_tasks: BackgroundTasks,
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        status = get_job_status(
            _engine(), job_id, admin.user.id,
            staging_directory=settings.data_import_staging_directory,
        )
        if status["sourceId"] == "collection_monitoring_t4_t5":
            queued = queue_t4t5_preview_validation(
                _engine(), job_id=job_id, actor_user_id=admin.user.id,
            )
            background_tasks.add_task(
                process_t4t5_preview_job,
                _engine(),
                job_id=job_id,
                actor_user_id=admin.user.id,
                staging_directory=settings.data_import_staging_directory,
            )
            return queued
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
    background_tasks: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128),
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    _same_origin(request)
    if not idempotency_key:
        raise HTTPException(status_code=422, detail="idempotency_key_required")
    settings = get_settings()
    if settings.data_import_staging_directory is None:
        raise HTTPException(status_code=503, detail="import_storage_unavailable")
    try:
        status = get_job_status(
            _engine(), job_id, admin.user.id,
            staging_directory=settings.data_import_staging_directory,
        )
        if status["sourceId"] == "collection_monitoring_t4_t5":
            queued = queue_t4t5_publication(
                _engine(),
                job_id=job_id,
                actor_user_id=admin.user.id,
                staging_directory=settings.data_import_staging_directory,
            )
            background_tasks.add_task(
                publish_t4t5_import_job,
                _engine(),
                job_id=job_id,
                actor_user_id=admin.user.id,
                staging_directory=settings.data_import_staging_directory,
                idempotency_key=idempotency_key,
                request_id=_request_id(request),
            )
            return queued
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
    admin: AuthenticatedViewer = Depends(require_matrix_admin),
) -> dict[str, object]:
    _require_feature(imports=True)
    settings = get_settings()
    try:
        return get_job_status(
            _engine(), job_id, admin.user.id,
            staging_directory=settings.data_import_staging_directory,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/dates")
def data_source_dates(
    source_id: str,
    contract_version: int | None = Query(default=None, ge=1, le=65535),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    base_code: str | None = Query(default=None, max_length=64),
    region: str | None = Query(default=None, max_length=64),
    publication_id: str | None = Query(default=None, max_length=36),
    latest_only: bool = Query(default=False),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_date_counts(
            _engine(), source_id=source_id, identity=viewer.identity,
            date_from=date_from, date_to=date_to, base_code=base_code, region=region,
            publication_id=publication_id, contract_version=contract_version,
            latest_only=latest_only,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/publications")
def data_source_publications(
    source_id: str,
    contract_version: int | None = Query(default=None, ge=1, le=65535),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000_000),
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> dict[str, object]:
    _require_feature()
    try:
        return get_publications(
            _engine(), source_id=source_id, identity=viewer.identity,
            limit=limit, offset=offset, contract_version=contract_version,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/records")
def data_source_records(
    source_id: str,
    contract_version: int | None = Query(default=None, ge=1, le=65535),
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
            contract_version=contract_version,
        )
    except DataFoundationError as error:
        raise _error(error) from None
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="data_store_unavailable") from None


@router.get("/data-sources/{source_id}/export.csv")
def export_data_source(
    source_id: str,
    contract_version: int | None = Query(default=None, ge=1, le=65535),
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
            contract_version=contract_version,
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
