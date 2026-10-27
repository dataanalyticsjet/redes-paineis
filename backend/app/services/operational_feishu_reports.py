"""Audited Feishu reports for the Collection Rate V3 and PDD V2 dashboards.

This module deliberately keeps source selection and metric rules separate. It
shares only the report lifecycle and the already approved Feishu transport
primitives with the Sem Movimentacao pilot.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import os
import re
import stat
import tempfile
import time as monotonic_clock
import uuid
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import Connection, Engine, text

from app.core.config import PROJECT_ROOT, Settings, get_settings
from app.services.collection_rate_operational_analysis import (
    TARGET_RATE as COLLECTION_RATE_TARGET,
    build_bilingual_analysis as build_collection_rate_analysis,
)
from app.services.data_foundation.contracts import get_contract
from app.services.feishu_publication_notifications import RECIPIENT_EMAIL
from app.services.no_movement_feishu_reports import (
    FILES_URL, HTTP_TIMEOUT, IMAGES_URL, MAX_FEISHU_MESSAGE_BYTES,
    MAX_FILE_BYTES, MESSAGE_URL, RECIPIENT_KEY, RECIPIENT_LABEL, TOKEN_URL,
    _FeishuRejected, _feishu_interactive_content, _feishu_payload,
)
from app.services.pdd_collection_failure_operational_analysis import (
    build_bilingual_analysis as build_pdd_analysis,
)

logger = logging.getLogger(__name__)
TABLE = "operational_feishu_reports"
RULES_VERSION = "feishu-operational-v1"
REPORT_FETCH_BATCH_SIZE = 2_000
MAX_GENERATION_SECONDS = 240.0
SOURCES: dict[str, dict[str, Any]] = {
    "collection_rate": {
        "contract": 3, "table": "fact_collection_rate_v3", "flag": "feishu_collection_rate_report_enabled",
        "date_field": "deadline_at", "sheet_mode": "single", "sheet_name": "Dados",
        "analysis": "collection_rate",
    },
    "pdd_collection_failure": {
        "contract": 2, "table": "fact_pdd_collection_failure_v2", "flag": "feishu_pdd_collection_failure_report_enabled",
        "date_field": "data_date", "sheet_mode": "daily", "analysis": "pdd_collection_failure",
    },
}


class OperationalFeishuReportError(ValueError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _check_generation_deadline(deadline: float) -> None:
    if monotonic_clock.monotonic() > deadline:
        raise OperationalFeishuReportError("operational_feishu_generation_timeout", 504)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _uuid(value: str) -> bytes:
    try:
        return uuid.UUID(value).bytes
    except (ValueError, TypeError, AttributeError):
        raise OperationalFeishuReportError("operational_feishu_report_id_invalid", 422) from None


def _source(source_id: str) -> dict[str, Any]:
    source = SOURCES.get(source_id)
    if source is None:
        raise OperationalFeishuReportError("operational_feishu_source_invalid", 404)
    return source


def _feature_enabled(source_id: str, settings: Settings) -> bool:
    return bool(getattr(settings, _source(source_id)["flag"], False))


def _artifact_root(staging_directory: Path) -> Path:
    root = staging_directory.expanduser().resolve()
    if not root.is_absolute() or root.is_relative_to(PROJECT_ROOT.resolve()):
        raise OperationalFeishuReportError("operational_feishu_storage_unavailable", 503)
    directory = root / ".operational-feishu-reports"
    if directory.is_symlink():
        raise OperationalFeishuReportError("operational_feishu_storage_unavailable", 503)
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory = directory.resolve()
        directory.relative_to(root)
        directory.chmod(0o700)
    except (OSError, ValueError):
        raise OperationalFeishuReportError("operational_feishu_storage_unavailable", 503) from None
    return directory


def _artifact_path(staging_directory: Path, report_id: uuid.UUID, ext: str) -> Path:
    if ext not in {"xlsx", "png"}:
        raise OperationalFeishuReportError("operational_feishu_artifact_invalid", 409)
    return _artifact_root(staging_directory) / f"{report_id.hex}.{ext}"


def _store(staging_directory: Path, report_id: uuid.UUID, artifacts: dict[str, bytes]) -> None:
    try:
        for ext, value in artifacts.items():
            if ext not in {"xlsx", "png"} or not value or len(value) > MAX_FILE_BYTES:
                raise OperationalFeishuReportError("operational_feishu_artifact_size_invalid", 413)
            path = _artifact_path(staging_directory, report_id, ext)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            path.chmod(0o600)
    except Exception as error:
        for ext in ("xlsx", "png"):
            try:
                _artifact_path(staging_directory, report_id, ext).unlink(missing_ok=True)
            except OSError:
                pass
        if isinstance(error, OperationalFeishuReportError):
            raise
        raise OperationalFeishuReportError("operational_feishu_storage_unavailable", 503) from None


def _read_artifact(staging_directory: Path, report_id: uuid.UUID, ext: str, expected: object) -> bytes:
    path = _artifact_path(staging_directory, report_id, ext)
    try:
        info = path.stat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > MAX_FILE_BYTES:
            raise OSError
        content = path.read_bytes()
    except OSError:
        raise OperationalFeishuReportError("operational_feishu_artifacts_changed", 409) from None
    digest = hashlib.sha256(content).hexdigest()
    if not isinstance(expected, str) or not hmac.compare_digest(digest, expected):
        raise OperationalFeishuReportError("operational_feishu_artifacts_changed", 409)
    return content


def _open_verified_artifact(staging_directory: Path, report_id: uuid.UUID, ext: str, expected: object):
    path = _artifact_path(staging_directory, report_id, ext)
    try:
        handle = path.open("rb")
        info = os.fstat(handle.fileno())
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > MAX_FILE_BYTES:
            handle.close()
            raise OSError
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        if not isinstance(expected, str) or not hmac.compare_digest(digest.hexdigest(), expected):
            handle.close()
            raise OperationalFeishuReportError("operational_feishu_artifacts_changed", 409)
        handle.seek(0)
        return handle
    except OperationalFeishuReportError:
        raise
    except OSError:
        raise OperationalFeishuReportError("operational_feishu_artifacts_changed", 409) from None


def _publication(engine: Engine, source_id: str, publication_id: str, connection: Connection | None = None) -> dict[str, Any]:
    source = _source(source_id)
    binary_id = _uuid(publication_id)
    if connection is None:
        with engine.connect() as active:
            return _publication(engine, source_id, publication_id, active)
    row = connection.execute(text("""
        SELECT p.publication_id, p.version_no, p.contract_version, p.map_version_id,
               p.period_start, p.snapshot_as_of, p.published_at, p.publication_state
        FROM source_snapshot_head h
        JOIN source_publications p ON p.source_id=h.source_id AND p.publication_id=h.publication_id
        WHERE h.source_id=:source_id AND h.publication_id=:publication_id
          AND p.publication_state='PUBLISHED' AND p.contract_version=:contract_version
    """), {"source_id": source_id, "publication_id": binary_id, "contract_version": source["contract"]}).mappings().first()
    if row is None:
        raise OperationalFeishuReportError("operational_feishu_publication_not_current", 409)
    result = dict(row)
    map_id = bytes(result.get("map_version_id") or b"")
    if len(map_id) != 16:
        raise OperationalFeishuReportError("operational_feishu_publication_mapping_invalid", 409)
    result["map_version_id"] = map_id
    return result


def _regions(engine: Engine, map_id: bytes, connection: Connection | None = None) -> list[str]:
    if connection is None:
        with engine.connect() as active:
            return _regions(engine, map_id, active)
    rows = connection.execute(text("""
        SELECT DISTINCT regional_name FROM base_mapping_entries
        WHERE map_version_id=:map_id AND regional_name IS NOT NULL AND regional_name<>''
        ORDER BY regional_name
    """), {"map_id": map_id}).scalars().all()
    return [str(value) for value in rows]


def _rows_query(engine: Engine, source_id: str, publication: dict[str, Any], region_code: str | None):
    source = _source(source_id)
    contract = get_contract(source_id, source["contract"])
    columns = [column.key for column in contract.columns]
    selection = ", ".join(f"f.`{key}` AS `{key}`" for key in columns)
    if region_code:
        region_predicate = " AND BINARY m.regional_name=BINARY :region_code" if engine.dialect.name == "mysql" else " AND m.regional_name COLLATE BINARY=:region_code"
    else:
        region_predicate = ""
    sheet_field = "f.source_sheet_name" if source["sheet_mode"] == "daily" else "NULL AS source_sheet_name"
    query = text(f"""
        SELECT {selection}, f.source_row_no, {sheet_field},
               f.resolved_base_code, f.mapping_resolution,
               m.regional_name AS mapped_region, m.base_name AS mapped_base_name,
               m.rm_responsible AS mapped_rm
        FROM {source['table']} f
        LEFT JOIN base_mapping_entries m
          ON m.map_version_id=f.map_version_id AND m.base_code=f.resolved_base_code
        WHERE f.source_id=:source_id AND f.publication_id=:publication_id
          AND f.map_version_id=:map_id {region_predicate}
        ORDER BY {('f.data_date, f.source_row_no' if source['sheet_mode']=='daily' else 'f.deadline_at, f.source_row_no')}
    """)
    params: dict[str, object] = {"source_id": source_id, "publication_id": bytes(publication["publication_id"]), "map_id": bytes(publication["map_version_id"])}
    if region_code:
        params["region_code"] = region_code
    return query, params


def _iter_rows(connection: Connection, query, params: dict[str, object]):
    """Yield ordered fact rows without asking SQLAlchemy to buffer the result."""
    result = connection.execution_options(yield_per=REPORT_FETCH_BATCH_SIZE).execute(query, params).mappings()
    try:
        for row in result:
            yield row
    finally:
        result.close()


def _fetch_rows(engine: Engine, source_id: str, publication: dict[str, Any], region_code: str | None, connection: Connection | None = None) -> list[dict[str, Any]]:
    query, params = _rows_query(engine, source_id, publication, region_code)
    if connection is not None:
        return [dict(row) for row in _iter_rows(connection, query, params)]
    with engine.connect() as active:
        return [dict(row) for row in _iter_rows(active, query, params)]


def _digest_add(digest: Any, row: dict[str, Any], columns: list[str]) -> None:
    payload = json.dumps([_stable(row.get(key)) for key in columns], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest.update(len(payload).to_bytes(8, "big"))
    digest.update(payload)


def _digest_rows(connection: Connection, engine: Engine, source_id: str, publication: dict[str, Any], region_code: str | None) -> tuple[bytes, int]:
    contract = get_contract(source_id, _source(source_id)["contract"])
    columns = [column.key for column in contract.columns]
    digest = hashlib.sha256()
    map_id = bytes(publication["map_version_id"])
    digest.update(map_id)
    query, params = _rows_query(engine, source_id, publication, region_code)
    count = 0
    for row in _iter_rows(connection, query, params):
        _digest_add(digest, row, columns)
        count += 1
    return digest.digest(), count


def get_options(engine: Engine, *, source_id: str, publication_id: str, settings: Settings | None = None) -> dict[str, object]:
    config = settings or get_settings()
    publication = _publication(engine, source_id, publication_id)
    source = _source(source_id)
    published_at = publication.get("published_at")
    if isinstance(published_at, (datetime, date)):
        published_text = published_at.isoformat(sep=" ") if isinstance(published_at, datetime) else published_at.isoformat()
    else:
        published_text = str(published_at) if published_at else None
    return {
        "sourceId": source_id, "publicationId": str(uuid.UUID(bytes=bytes(publication["publication_id"]))),
        "publicationVersion": int(publication["version_no"]), "contractVersion": int(publication["contract_version"]),
        "mapVersionId": str(uuid.UUID(bytes=bytes(publication["map_version_id"]))),
        "publishedAt": published_text, "regions": _regions(engine, bytes(publication["map_version_id"])),
        "recipients": [{"key": RECIPIENT_KEY, "label": RECIPIENT_LABEL}],
        "sendEnabled": _feature_enabled(source_id, config),
    }


def _stable(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, bytes):
        return value.hex()
    return value


def _digest(rows: list[dict[str, Any]], columns: list[str], map_id: bytes) -> bytes:
    digest = hashlib.sha256()
    digest.update(map_id)
    for row in rows:
        _digest_add(digest, row, columns)
    return digest.digest()


def _as_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _percent(value: object) -> str:
    if value is None:
        return "—"
    try:
        amount = Decimal(str(value)) * Decimal(100)
    except Exception:
        return "—"
    return f"{amount.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP):.1f}%"


def _new_analysis_totals(source_id: str) -> dict[str, Any]:
    if source_id == "collection_rate":
        return {"rowCount": 0, "collected": 0, "planned": 0, "totalOrders": 0, "unmappedPlanned": 0, "groups": {}}
    return {"rowCount": 0, "totalOrders": 0, "unscanned": 0, "unmappedTotal": 0, "unmappedUnscanned": 0, "groups": {}}


def _accumulate_analysis_row(source_id: str, totals: dict[str, Any], row: dict[str, Any], operational_date: date) -> None:
    source = _source(source_id)
    value = row.get(source["date_field"])
    if value is None or _as_date(value) != operational_date:
        return
    totals["rowCount"] += 1
    mapped = bool(row.get("resolved_base_code") and row.get("mapped_region") and row.get("mapping_resolution") in {"NAME_APPROVED", "CODE_MATCH"})
    if source_id == "collection_rate":
        collected = int(row.get("collected_quantity") or 0)
        planned = int(row.get("quantity_to_collect") or 0)
        totals["collected"] += collected
        totals["planned"] += planned
        totals["totalOrders"] += int(row.get("order_quantity") or 0)
        if mapped:
            code = str(row["resolved_base_code"])
            item = totals["groups"].setdefault(code, {"code": code, "name": row.get("mapped_base_name") or code, "region": row.get("mapped_region"), "responsible": row.get("mapped_rm"), "collected": 0, "planned": 0})
            item["collected"] += collected
            item["planned"] += planned
        else:
            totals["unmappedPlanned"] += planned
        return
    total = int(row.get("total_orders") or 0)
    unscanned = int(row.get("orders_unscanned_at_collection") or 0)
    totals["totalOrders"] += total
    totals["unscanned"] += unscanned
    if mapped:
        code = str(row["resolved_base_code"])
        item = totals["groups"].setdefault(code, {"code": code, "name": row.get("mapped_base_name") or code, "region": row.get("mapped_region"), "owner": row.get("mapped_rm"), "total": 0, "unscanned": 0})
        item["total"] += total
        item["unscanned"] += unscanned
    else:
        totals["unmappedTotal"] += total
        totals["unmappedUnscanned"] += unscanned


def _finish_analysis(source_id: str, publication: dict[str, Any], region_code: str | None, operational_date: date, totals: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, int]]:
    if not totals["rowCount"]:
        raise OperationalFeishuReportError("operational_feishu_no_records", 404)
    if source_id == "collection_rate":
        message, result = build_collection_rate_analysis(
            operational_date=operational_date, publication_version=int(publication["version_no"]),
            collected=totals["collected"], planned=totals["planned"],
            bases=list(totals["groups"].values()), unmapped_planned=totals["unmappedPlanned"],
        )
        summary = {"collected": totals["collected"], "planned": totals["planned"], "totalOrders": totals["totalOrders"], "rateNumerator": totals["collected"], "rateDenominator": totals["planned"]}
    else:
        message, result = build_pdd_analysis(
            operational_date=operational_date, publication_version=int(publication["version_no"]),
            total_orders=totals["totalOrders"], orders_unscanned=totals["unscanned"],
            bases=list(totals["groups"].values()), unmapped_total=totals["unmappedTotal"],
            unmapped_unscanned=totals["unmappedUnscanned"],
        )
        summary = {"collected": totals["totalOrders"] - totals["unscanned"], "planned": totals["totalOrders"], "totalOrders": totals["totalOrders"], "rateNumerator": totals["unscanned"], "rateDenominator": totals["totalOrders"]}
    if region_code:
        message = f"📍 Regional: **{region_code}** | 区域: **{region_code}**\n\n" + message
    return message, {"operationalDate": operational_date.isoformat(), "result": result}, summary


def _analysis(source_id: str, publication: dict[str, Any], rows: list[dict[str, Any]], region_code: str | None, operational_date: date) -> tuple[str, dict[str, Any], dict[str, int]]:
    totals = _new_analysis_totals(source_id)
    for row in rows:
        _accumulate_analysis_row(source_id, totals, row, operational_date)
    return _finish_analysis(source_id, publication, region_code, operational_date, totals)


def _xlsx(source_id: str, rows: list[dict[str, Any]], operational_date: date, region_code: str | None) -> tuple[str, bytes]:
    from openpyxl import Workbook

    source = _source(source_id)
    contract = get_contract(source_id, source["contract"])
    workbook = Workbook(write_only=True)
    columns = [column.key for column in contract.columns]
    if source["sheet_mode"] == "single":
        grouped = [(source["sheet_name"], rows)]
    else:
        by_day: dict[date, list[dict[str, Any]]] = {}
        for row in rows:
            if row.get("data_date") is not None:
                by_day.setdefault(_as_date(row["data_date"]), []).append(row)
        grouped = [(day.isoformat(), by_day[day]) for day in sorted(by_day)]
    for title, data_rows in grouped:
        sheet = workbook.create_sheet(title=title[:31])
        sheet.append([column.header for column in contract.columns])
        for row in data_rows:
            # Preserve the complete official contract width even when its
            # trailing columns are null in every row of the scoped extract.
            sheet.append([row.get(key) if row.get(key) is not None else "" for key in columns])
    workbook.properties.title = f"{source_id} — relatório oficial"
    workbook.properties.subject = f"Publication scoped report; region={region_code or 'ALL'}"
    stable = datetime.combine(operational_date, time.min)
    workbook.properties.created = stable
    workbook.properties.modified = stable
    buffer = io.BytesIO()
    workbook.save(buffer)
    raw = buffer.getvalue()
    canonical = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source_zip:
        with zipfile.ZipFile(canonical, "w", zipfile.ZIP_DEFLATED) as target_zip:
            for item in source_zip.infolist():
                stable_item = zipfile.ZipInfo(item.filename, date_time=(1980, 1, 1, 0, 0, 0))
                stable_item.compress_type = item.compress_type
                stable_item.external_attr = item.external_attr
                target_zip.writestr(stable_item, source_zip.read(item.filename), compress_type=item.compress_type)
    content = canonical.getvalue()
    if not content or len(content) > MAX_FILE_BYTES or not zipfile.is_zipfile(io.BytesIO(content)):
        raise OperationalFeishuReportError("operational_feishu_xlsx_invalid", 413)
    safe_region = re.sub(r"[^A-Za-z0-9_-]+", "_", region_code or "nacional").strip("_") or "regional"
    prefix = "taxa_coleta" if source_id == "collection_rate" else "falha_coleta_pdd"
    return f"{prefix}_{safe_region}_{operational_date.isoformat()}.xlsx", content


class _OutputTooLarge(Exception):
    pass


class _LimitedWriter:
    """Seekable file wrapper that enforces the attachment ceiling while writing."""
    def __init__(self, handle, limit: int, deadline: float | None = None):
        self._handle = handle
        self._limit = limit
        self._deadline = deadline
        self._max_extent = 0

    def write(self, value: bytes) -> int:
        if self._deadline is not None:
            _check_generation_deadline(self._deadline)
        end = self._handle.tell() + len(value)
        if max(self._max_extent, end) > self._limit:
            raise _OutputTooLarge
        written = self._handle.write(value)
        self._max_extent = max(self._max_extent, end)
        return written

    def __getattr__(self, name: str):
        return getattr(self._handle, name)


def _temp_artifact(root: Path, suffix: str) -> Path:
    handle = tempfile.NamedTemporaryFile(prefix=".operational-feishu-", suffix=suffix, dir=root, delete=False)
    path = Path(handle.name)
    handle.close()
    try:
        path.chmod(0o600)
    except OSError:
        path.unlink(missing_ok=True)
        raise
    return path


def _write_xlsx_stream(source_id: str, rows, operational_date: date, region_code: str | None, raw_path: Path, final_path: Path, deadline: float) -> str:
    from openpyxl import Workbook
    from openpyxl.writer.excel import ExcelWriter
    from openpyxl.worksheet import _writer as worksheet_writer

    source = _source(source_id)
    contract = get_contract(source_id, source["contract"])
    columns = [column.key for column in contract.columns]
    headers = [column.header for column in contract.columns]
    workbook = Workbook(write_only=True)
    workbook.properties.title = f"{source_id} — relatório oficial"
    workbook.properties.subject = f"Publication scoped report; region={region_code or 'ALL'}"
    stable = datetime.combine(operational_date, time.min)
    workbook.properties.created = stable
    workbook.properties.modified = stable
    active_sheet = None
    active_day = None
    if source["sheet_mode"] == "single":
        active_sheet = workbook.create_sheet(title=source["sheet_name"])
        active_sheet.append(headers)
    before_temps = set(worksheet_writer.ALL_TEMP_FILES)
    try:
        for row in rows:
            _check_generation_deadline(deadline)
            if source["sheet_mode"] == "daily":
                if row.get("data_date") is None:
                    continue
                row_day = _as_date(row["data_date"])
                if active_day != row_day:
                    active_day = row_day
                    active_sheet = workbook.create_sheet(title=row_day.isoformat()[:31])
                    active_sheet.append(headers)
            active_sheet.append([row.get(key) if row.get(key) is not None else "" for key in columns])
        if source["sheet_mode"] == "daily" and active_sheet is None:
            raise OperationalFeishuReportError("operational_feishu_no_records", 404)
        with raw_path.open("w+b") as handle:
            archive = zipfile.ZipFile(_LimitedWriter(handle, MAX_FILE_BYTES, deadline), "w", zipfile.ZIP_DEFLATED, allowZip64=True)
            try:
                ExcelWriter(workbook, archive).save()
            except _OutputTooLarge:
                # openpyxl's save_workbook helper does not close its archive if
                # a write fails. Detach it so ZipFile.__del__ cannot seek on a
                # file handle that this context is about to close.
                archive.fp = None
                archive._fileRefCnt = 0
                raise
            except BaseException:
                try:
                    archive.close()
                except Exception:
                    archive.fp = None
                    archive._fileRefCnt = 0
                raise
            handle.flush()
            os.fsync(handle.fileno())
        with zipfile.ZipFile(raw_path, "r") as original:
            with final_path.open("w+b") as target_handle:
                normalized = zipfile.ZipFile(_LimitedWriter(target_handle, MAX_FILE_BYTES, deadline), "w", zipfile.ZIP_DEFLATED)
                try:
                    for item in original.infolist():
                        stable_item = zipfile.ZipInfo(item.filename, date_time=(1980, 1, 1, 0, 0, 0))
                        stable_item.compress_type = item.compress_type
                        stable_item.external_attr = item.external_attr
                        stable_item.internal_attr = item.internal_attr
                        stable_item.create_system = item.create_system
                        with original.open(item, "r") as source_handle, normalized.open(stable_item, "w", force_zip64=True) as target_entry:
                            while chunk := source_handle.read(1024 * 1024):
                                _check_generation_deadline(deadline)
                                target_entry.write(chunk)
                    normalized.close()
                except _OutputTooLarge:
                    normalized.fp = None
                    normalized._fileRefCnt = 0
                    raise
                except BaseException:
                    try:
                        normalized.close()
                    except Exception:
                        normalized.fp = None
                        normalized._fileRefCnt = 0
                    raise
                target_handle.flush()
                os.fsync(target_handle.fileno())
        final_path.chmod(0o600)
        if final_path.stat().st_size <= 0 or not zipfile.is_zipfile(final_path):
            raise OperationalFeishuReportError("operational_feishu_xlsx_invalid", 413)
    except _OutputTooLarge:
        for sheet in workbook.worksheets:
            try:
                sheet.close()
            except Exception:
                pass
        try:
            workbook.close()
        except Exception:
            pass
        raise OperationalFeishuReportError("operational_feishu_xlsx_invalid", 413) from None
    except BaseException:
        if "archive" in locals() and archive.fp is not None:
            try:
                archive.close()
            except Exception:
                archive.fp = None
                archive._fileRefCnt = 0
        for sheet in workbook.worksheets:
            try:
                sheet.close()
            except Exception:
                pass
        try:
            workbook.close()
        except Exception:
            pass
        raise
    finally:
        for temp_name in set(worksheet_writer.ALL_TEMP_FILES) - before_temps:
            try:
                Path(temp_name).unlink(missing_ok=True)
                worksheet_writer.ALL_TEMP_FILES.remove(temp_name)
            except (OSError, ValueError):
                pass
    safe_region = re.sub(r"[^A-Za-z0-9_-]+", "_", region_code or "nacional").strip("_") or "regional"
    prefix = "taxa_coleta" if source_id == "collection_rate" else "falha_coleta_pdd"
    return f"{prefix}_{safe_region}_{operational_date.isoformat()}.xlsx"


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stream_payload(engine: Engine, *, source_id: str, publication_id: str, region_code: str | None,
                    staging_directory: Path, report_id: uuid.UUID) -> dict[str, Any]:
    root = _artifact_root(staging_directory)
    deadline = monotonic_clock.monotonic() + MAX_GENERATION_SECONDS
    raw_path: Path | None = None
    normalized_path: Path | None = None
    xlsx_path = _artifact_path(staging_directory, report_id, "xlsx")
    png_path = _artifact_path(staging_directory, report_id, "png")
    try:
        raw_path = _temp_artifact(root, ".xlsx.raw")
        normalized_path = _temp_artifact(root, ".xlsx.normalized")
        with engine.connect() as connection:
            with connection.begin():
                publication = _publication(engine, source_id, publication_id, connection)
                regions = _regions(engine, bytes(publication["map_version_id"]), connection)
                if region_code is not None and region_code not in regions:
                    raise OperationalFeishuReportError("operational_feishu_region_invalid", 422)
                day_value = connection.execute(text("""
                    SELECT MAX(data_date) FROM source_publication_dates
                    WHERE source_id=:source_id AND publication_id=:publication_id AND row_count>0
                """), {"source_id": source_id, "publication_id": bytes(publication["publication_id"])}).scalar_one_or_none()
                if day_value is None:
                    raise OperationalFeishuReportError("operational_feishu_operational_date_unavailable", 409)
                operational_date = _as_date(day_value)
                contract = get_contract(source_id, _source(source_id)["contract"])
                columns = [column.key for column in contract.columns]
                digest = hashlib.sha256()
                digest.update(bytes(publication["map_version_id"]))
                count = 0
                totals = _new_analysis_totals(source_id)
                query, params = _rows_query(engine, source_id, publication, region_code)

                def rows_and_account():
                    nonlocal count
                    for mapped_row in _iter_rows(connection, query, params):
                        _check_generation_deadline(deadline)
                        row = dict(mapped_row)
                        _digest_add(digest, row, columns)
                        _accumulate_analysis_row(source_id, totals, row, operational_date)
                        count += 1
                        yield row

                file_name = _write_xlsx_stream(source_id, rows_and_account(), operational_date, region_code, raw_path, normalized_path, deadline)
                if count == 0:
                    raise OperationalFeishuReportError("operational_feishu_no_records", 404)
                message, analysis_result, summary = _finish_analysis(source_id, publication, region_code, operational_date, totals)
                dataset_digest = digest.digest()
        os.replace(normalized_path, xlsx_path)
        png = _png(source_id, publication, region_code, summary, analysis_result)
        _check_generation_deadline(deadline)
        _store(staging_directory, report_id, {"png": png})
        return {
            "publication": publication, "analysis": message, "analysisResult": analysis_result,
            "totals": summary, "digest": dataset_digest, "recordCount": count,
            "fileName": file_name, "xlsxBytes": xlsx_path.stat().st_size, "pngBytes": len(png),
            "operationalDate": operational_date, "artifacts": {"xlsxSha256": _file_digest(xlsx_path), "pngSha256": hashlib.sha256(png).hexdigest()},
        }
    except Exception:
        for path in (raw_path, normalized_path, xlsx_path, png_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        for path in (raw_path, normalized_path):
            if path is not None:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass


def _png(source_id: str, publication: dict[str, Any], region_code: str | None, totals: dict[str, int], result: dict[str, Any]) -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    width, height = 1400, 760
    image = Image.new("RGB", (width, height), "#f4f6f9")
    draw = ImageDraw.Draw(image)
    def font(size: int, bold: bool = False):
        candidates = (
            ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/arialbd.ttf"] if bold
            else ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/arial.ttf"]
        ) + [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        for candidate in candidates:
            try:
                return ImageFont.truetype(candidate, size=size)
            except OSError:
                continue
        return ImageFont.load_default()

    title, body, small = font(34, True), font(23), font(18)
    draw.rounded_rectangle((24, 20, width - 24, height - 20), radius=20, fill="white", outline="#e5e8ef", width=2)
    title_text = "TAXA DE COLETA V3" if source_id == "collection_rate" else "FALHA DE COLETA PDD"
    draw.text((58, 48), "J&T EXPRESS  |  RELATÓRIO OPERACIONAL", fill="#d71920", font=small)
    draw.text((58, 84), title_text, fill="#17191f", font=title)
    draw.text((58, 140), f"Data operacional: {result['operationalDate']}    Regional: {region_code or 'Todas as regionais'}", fill="#4d5360", font=body)
    draw.text((58, 180), f"Publicação v{publication['version_no']}    Contrato V{publication['contract_version']}", fill="#4d5360", font=small)
    if source_id == "collection_rate":
        denominator, numerator = totals["rateDenominator"], totals["rateNumerator"]
        rate = Decimal(numerator) / Decimal(denominator) if denominator else None
        rate_text = _percent(rate) if rate is not None else "—"
        cards = [("VOLUME OFICIAL", f"{totals['totalOrders']:,}".replace(",", ".")), ("COLETADO NO PRAZO", f"{numerator:,}".replace(",", ".")), ("TAXA DE COLETA", rate_text), ("META", f"{COLLECTION_RATE_TARGET * 100:.0f}%")]
    else:
        den, num = totals["rateDenominator"], totals["rateNumerator"]
        rate = Decimal(num) / Decimal(den) if den else None
        cards = [("TOTAL DE PEDIDOS", f"{totals['totalOrders']:,}".replace(",", ".")), ("NÃO BIPADOS NA COLETA", f"{num:,}".replace(",", ".")), ("TAXA DE FALHA", _percent(rate) if rate is not None else "—")]
    x = 58
    card_width = 300
    for label, value in cards:
        draw.rounded_rectangle((x, 245, x + card_width, 360), radius=14, fill="#fff2f3", outline="#f1d5d7")
        draw.text((x + 18, 264), label, fill="#6b7079", font=small)
        draw.text((x + 18, 300), value, fill="#d71920", font=title)
        x += card_width + 24
    draw.text((58, 405), "Principais unidades mapeadas", fill="#17191f", font=body)
    base_rows = []
    results = result.get("result", {})
    if source_id == "collection_rate":
        for region in results.get("regions", []):
            for base in region.get("bases", []):
                base_rows.append((base.get("baseName") or base.get("baseCode"), _percent(base.get("rate")), base.get("responsible")))
    else:
        for base in results.get("priorityBases", []):
            base_rows.append((base.get("baseName") or base.get("baseCode"), _percent(base.get("failureRate")), base.get("responsible")))
    for index, (name, ratio, owner) in enumerate(base_rows[:10]):
        draw.text((70, 450 + index * 25), f"• {name} — {ratio or '—'} | {owner or 'Sem responsável'}", fill="#333842", font=small)
    if not base_rows:
        draw.text((70, 452), "Sem unidades prioritárias nesta publicação.", fill="#555b64", font=small)
    draw.text((58, height - 62), "Prévia; o Excel contém todos os registros autorizados do recorte.", fill="#777d87", font=small)
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    data = output.getvalue()
    if not data or len(data) > MAX_FILE_BYTES:
        raise OperationalFeishuReportError("operational_feishu_png_invalid", 413)
    return data


def _payload(engine: Engine, source_id: str, publication_id: str, region_code: str | None, connection: Connection | None = None, include_artifacts: bool = True) -> dict[str, Any]:
    publication = _publication(engine, source_id, publication_id, connection)
    regions = _regions(engine, bytes(publication["map_version_id"]))
    if region_code is not None and region_code not in regions:
        raise OperationalFeishuReportError("operational_feishu_region_invalid", 422)
    rows = _fetch_rows(engine, source_id, publication, region_code, connection)
    if not rows:
        raise OperationalFeishuReportError("operational_feishu_no_records", 404)
    contract = get_contract(source_id, _source(source_id)["contract"])
    columns = [column.key for column in contract.columns]
    digest = _digest(rows, columns, bytes(publication["map_version_id"]))
    analysis = None
    result = None
    totals = None
    file_name = ""
    xlsx = png = None
    operational_date: date | None = None
    if include_artifacts:
        if connection is None:
            with engine.connect() as active:
                day_value = active.execute(text("""
                    SELECT MAX(data_date) FROM source_publication_dates
                    WHERE source_id=:source_id AND publication_id=:publication_id AND row_count>0
                """), {"source_id": source_id, "publication_id": bytes(publication["publication_id"])}).scalar_one_or_none()
        else:
            day_value = connection.execute(text("""
                SELECT MAX(data_date) FROM source_publication_dates
                WHERE source_id=:source_id AND publication_id=:publication_id AND row_count>0
            """), {"source_id": source_id, "publication_id": bytes(publication["publication_id"])}).scalar_one_or_none()
        if day_value is None:
            raise OperationalFeishuReportError("operational_feishu_operational_date_unavailable", 409)
        operational_date = _as_date(day_value)
        analysis, result, totals = _analysis(source_id, publication, rows, region_code, operational_date)
        file_name, xlsx = _xlsx(source_id, rows, operational_date, region_code)
        png = _png(source_id, publication, region_code, totals, result)
    return {"publication": publication, "rows": rows, "regionCode": region_code, "analysis": analysis,
            "analysisResult": result, "totals": totals, "digest": digest, "fileName": file_name,
            "xlsx": xlsx, "png": png, "operationalDate": operational_date, "columns": columns}


def prepare_report(engine: Engine, *, source_id: str, publication_id: str, region_code: str | None,
                   recipient_key: str, actor_user_id: int, staging_directory: Path,
                   settings: Settings | None = None) -> dict[str, object]:
    config = settings or get_settings()
    _source(source_id)
    if recipient_key != RECIPIENT_KEY:
        raise OperationalFeishuReportError("operational_feishu_recipient_invalid", 403)
    report_id = uuid.uuid4()
    payload = _stream_payload(engine, source_id=source_id, publication_id=publication_id,
                              region_code=region_code, staging_directory=staging_directory, report_id=report_id)
    now = _now()
    hashes = payload["artifacts"]
    try:
        with engine.begin() as connection:
            unresolved = connection.execute(text(f"""
                SELECT report_id, report_state FROM {TABLE}
                WHERE source_id=:source_id AND publication_id=:publication_id AND region_key=:region_key
                  AND recipient_key=:recipient_key AND rules_version=:rules_version
                  AND report_state IN ('SENDING','PARTIAL','PENDING') LIMIT 1
            """), {"source_id": source_id, "publication_id": bytes(payload["publication"]["publication_id"]),
                  "region_key": region_code or "ALL", "recipient_key": recipient_key, "rules_version": RULES_VERSION}).mappings().first()
            if unresolved:
                raise OperationalFeishuReportError("operational_feishu_delivery_unresolved", 409)
            connection.execute(text(f"""
                INSERT INTO {TABLE}
                  (report_id,source_id,publication_id,publication_version,contract_version,map_version_id,
                   region_key,recipient_key,recipient_email,actor_user_id,analysis_text,record_count,
                   dataset_sha256,rules_version,report_state,delivery_context,created_at,updated_at)
                VALUES (:report_id,:source_id,:publication_id,:publication_version,:contract_version,:map_version_id,
                   :region_key,:recipient_key,:recipient_email,:actor_user_id,:analysis_text,:record_count,
                   :dataset_sha256,:rules_version,'PREPARED',:delivery_context,:created_at,:updated_at)
            """), {"report_id": report_id.bytes, "source_id": source_id,
                  "publication_id": bytes(payload["publication"]["publication_id"]),
                  "publication_version": int(payload["publication"]["version_no"]),
                  "contract_version": int(payload["publication"]["contract_version"]),
                  "map_version_id": bytes(payload["publication"]["map_version_id"]),
                  "region_key": region_code or "ALL", "recipient_key": recipient_key,
                  "recipient_email": RECIPIENT_EMAIL, "actor_user_id": actor_user_id,
                  "analysis_text": payload["analysis"], "record_count": payload["recordCount"],
                  "dataset_sha256": payload["digest"], "rules_version": RULES_VERSION,
                  "delivery_context": json.dumps({"artifacts": hashes, "fileName": payload["fileName"], "stages": {}}, separators=(",", ":")),
                  "created_at": now, "updated_at": now})
    except Exception:
        for ext in ("xlsx", "png"):
            try:
                _artifact_path(staging_directory, report_id, ext).unlink(missing_ok=True)
            except OSError:
                pass
        raise
    pub = payload["publication"]
    return {"reportId": str(report_id), "sourceId": source_id,
            "publicationId": str(uuid.UUID(bytes=bytes(pub["publication_id"]))),
            "publicationVersion": int(pub["version_no"]), "contractVersion": int(pub["contract_version"]),
            "mapVersionId": str(uuid.UUID(bytes=bytes(pub["map_version_id"]))),
            "publishedAt": pub.get("published_at").isoformat(sep=" ") if isinstance(pub.get("published_at"), datetime) else str(pub.get("published_at") or ""),
            "operationalDate": payload["operationalDate"].isoformat(), "regionCode": region_code,
            "regionLabel": region_code or "Todas as regionais", "recipientKey": RECIPIENT_KEY,
            "recipientLabel": RECIPIENT_LABEL, "analysis": payload["analysis"],
            "recordCount": payload["recordCount"], "excelFileName": payload["fileName"],
            "excelBytes": payload["xlsxBytes"], "pngBytes": payload["pngBytes"], "state": "PREPARED",
            "sendEnabled": _feature_enabled(source_id, config)}


def confirm_report(engine: Engine, *, report_id: str, actor_user_id: int, analysis_text: str, source_id: str) -> dict[str, object]:
    if not analysis_text.strip():
        raise OperationalFeishuReportError("operational_feishu_text_required", 422)
    if len(analysis_text) > 20000:
        raise OperationalFeishuReportError("operational_feishu_text_too_long", 422)
    key, now = _uuid(report_id), _now()
    with engine.begin() as connection:
        lock = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
        row = connection.execute(text(f"SELECT report_id,source_id,publication_id,report_state FROM {TABLE} WHERE report_id=:id AND actor_user_id=:actor" + lock), {"id": key, "actor": actor_user_id}).mappings().first()
        if row is None:
            raise OperationalFeishuReportError("operational_feishu_report_not_found", 404)
        if str(row["source_id"]) != source_id:
            raise OperationalFeishuReportError("operational_feishu_report_not_found", 404)
        if row["report_state"] not in {"PREPARED", "CONFIRMED"}:
            raise OperationalFeishuReportError("operational_feishu_confirmation_invalid", 409)
        _publication(engine, str(row["source_id"]), str(uuid.UUID(bytes=bytes(row["publication_id"]))), connection)
        connection.execute(text(f"UPDATE {TABLE} SET report_state='CONFIRMED',analysis_text=:analysis,confirmed_at=:now,updated_at=:now WHERE report_id=:id AND actor_user_id=:actor"), {"analysis": analysis_text, "now": now, "id": key, "actor": actor_user_id})
    return {"reportId": report_id, "state": "CONFIRMED", "messageSent": False}


def _save_context(engine: Engine, report_id: bytes, state: str, context: dict[str, Any]) -> None:
    now = _now()
    with engine.begin() as connection:
        connection.execute(text(f"UPDATE {TABLE} SET report_state=:state,delivery_context=:context,updated_at=:now,sent_at=CASE WHEN :state='SENT' THEN :now ELSE sent_at END WHERE report_id=:id"), {"state": state, "context": json.dumps(context, separators=(",", ":")), "now": now, "id": report_id})


def send_report(engine: Engine, *, source_id: str, report_id: str, actor_user_id: int, staging_directory: Path,
                settings: Settings | None = None) -> dict[str, object]:
    config = settings or get_settings()
    requested_source_id = source_id
    key, now = _uuid(report_id), _now()
    with engine.begin() as connection:
        lock = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
        row = connection.execute(text(f"SELECT * FROM {TABLE} WHERE report_id=:id AND actor_user_id=:actor" + lock), {"id": key, "actor": actor_user_id}).mappings().first()
        if row is None:
            raise OperationalFeishuReportError("operational_feishu_report_not_found", 404)
        source_id = str(row["source_id"])
        if source_id != requested_source_id:
            raise OperationalFeishuReportError("operational_feishu_report_not_found", 404)
        if str(row["recipient_key"]) != RECIPIENT_KEY or str(row["recipient_email"]) != RECIPIENT_EMAIL:
            raise OperationalFeishuReportError("operational_feishu_recipient_invalid", 403)
        if not _feature_enabled(source_id, config):
            raise OperationalFeishuReportError("operational_feishu_send_disabled", 503)
        if not config.feishu_oauth_app_id or not config.feishu_oauth_app_secret:
            raise OperationalFeishuReportError("feishu_application_not_configured", 503)
        if row["report_state"] != "CONFIRMED":
            raise OperationalFeishuReportError("operational_feishu_report_not_confirmed", 409)
        publication_id = str(uuid.UUID(bytes=bytes(row["publication_id"])))
        if engine.dialect.name == "mysql":
            connection.execute(text("SELECT publication_id FROM source_snapshot_head WHERE source_id=:source AND publication_id=:id FOR UPDATE"), {"source": source_id, "id": bytes(row["publication_id"])}).first()
        publication = _publication(engine, source_id, publication_id, connection)
        if bytes(publication["map_version_id"]) != bytes(row["map_version_id"]):
            raise OperationalFeishuReportError("operational_feishu_mapping_changed", 409)
        duplicate = connection.execute(text(f"SELECT report_id FROM {TABLE} WHERE source_id=:source AND publication_id=:pub AND region_key=:region AND recipient_key=:recipient AND rules_version=:rules AND report_id<>:id AND report_state IN ('SENDING','PARTIAL','PENDING','SENT') LIMIT 1" + lock), {"source": source_id, "pub": bytes(row["publication_id"]), "region": row["region_key"], "recipient": row["recipient_key"], "rules": row["rules_version"], "id": key}).first()
        if duplicate:
            raise OperationalFeishuReportError("operational_feishu_report_already_sent_or_unresolved", 409)
        region = None if row["region_key"] == "ALL" else str(row["region_key"])
        current_digest, current_count = _digest_rows(connection, engine, source_id, publication, region)
        if current_count == 0:
            raise OperationalFeishuReportError("operational_feishu_no_records", 404)
        if not hmac.compare_digest(current_digest, bytes(row["dataset_sha256"])):
            raise OperationalFeishuReportError("operational_feishu_data_changed", 409)
        raw_context = row["delivery_context"]
        context = raw_context if isinstance(raw_context, dict) else json.loads(raw_context or "{}")
        file_name = str(context.get("fileName") or "")
        if not file_name.endswith(".xlsx") or Path(file_name).name != file_name:
            raise OperationalFeishuReportError("operational_feishu_artifacts_changed", 409)
        stages = context.setdefault("stages", {})
        hashes = context.get("artifacts", {})
        report_uuid = uuid.UUID(bytes=key)
        for ext in ("xlsx", "png"):
            with _open_verified_artifact(staging_directory, report_uuid, ext, hashes.get(f"{ext}Sha256")):
                pass
        message_content = _feishu_interactive_content(str(row["analysis_text"]))
        connection.execute(text(f"UPDATE {TABLE} SET report_state='SENDING',updated_at=:now WHERE report_id=:id"), {"now": now, "id": key})
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            token_result = _feishu_payload(client.post(TOKEN_URL, json={"app_id": config.feishu_oauth_app_id, "app_secret": config.feishu_oauth_app_secret}))
            token = token_result.get("tenant_access_token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("feishu_token_unavailable")
            headers = {"Authorization": f"Bearer {token}"}
            if stages.get("text", {}).get("status") != "SENT":
                result = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "interactive", "content": message_content}))
                stages["text"] = {"status": "SENT", "messageId": result["data"]["message_id"]}
                _save_context(engine, key, "SENDING", context)
            xlsx_stage = stages.setdefault("xlsx", {})
            if xlsx_stage.get("status") != "SENT":
                if not xlsx_stage.get("fileKey"):
                    with _open_verified_artifact(staging_directory, report_uuid, "xlsx", hashes.get("xlsxSha256")) as xlsx_file:
                        result = _feishu_payload(client.post(FILES_URL, headers=headers, data={"file_type": "stream", "file_name": file_name}, files={"file": (file_name, xlsx_file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}))
                    xlsx_stage["fileKey"] = result["data"]["file_key"]
                    _save_context(engine, key, "SENDING", context)
                result = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "file", "content": json.dumps({"file_key": xlsx_stage["fileKey"]})}))
                xlsx_stage.update({"status": "SENT", "messageId": result["data"]["message_id"]})
                _save_context(engine, key, "SENDING", context)
            png_stage = stages.setdefault("png", {})
            if png_stage.get("status") != "SENT":
                if not png_stage.get("imageKey"):
                    with _open_verified_artifact(staging_directory, report_uuid, "png", hashes.get("pngSha256")) as png_file:
                        result = _feishu_payload(client.post(IMAGES_URL, headers=headers, data={"image_type": "message"}, files={"image": ("operational_preview.png", png_file, "image/png")}))
                    png_stage["imageKey"] = result["data"]["image_key"]
                    _save_context(engine, key, "SENDING", context)
                result = _feishu_payload(client.post(MESSAGE_URL, params={"receive_id_type": "email"}, headers=headers, json={"receive_id": RECIPIENT_EMAIL, "msg_type": "image", "content": json.dumps({"image_key": png_stage["imageKey"]})}))
                png_stage.update({"status": "SENT", "messageId": result["data"]["message_id"]})
                _save_context(engine, key, "SENDING", context)
    except _FeishuRejected as error:
        _save_context(engine, key, "PARTIAL", context)
        raise OperationalFeishuReportError("operational_feishu_partial_delivery", 502) from error
    except Exception as error:
        _save_context(engine, key, "PENDING", context)
        logger.warning("Operational Feishu delivery needs reconciliation (%s)", type(error).__name__)
        raise OperationalFeishuReportError("operational_feishu_delivery_pending", 502) from None
    _save_context(engine, key, "SENT", context)
    for ext in ("xlsx", "png"):
        try:
            _artifact_path(staging_directory, uuid.UUID(bytes=key), ext).unlink(missing_ok=True)
        except OSError:
            logger.warning("Unable to remove successfully delivered operational report artifact")
    return {"reportId": report_id, "state": "SENT", "recipient": RECIPIENT_LABEL, "messageIds": {name: stage.get("messageId") for name, stage in stages.items()}}
