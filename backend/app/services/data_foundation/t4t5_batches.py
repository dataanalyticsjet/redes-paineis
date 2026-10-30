from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection

from app.services.data_foundation.contracts import contract_sha256, get_contract
from app.services.data_foundation.repository import (
    DataFoundationError, _fact_row, _for_update_clause, _switch_t4t5_heads_if_newer,
    _uuid_bytes, _validate_contract_for_publication, _write_audit, _write_publication_dates,
    current_mapping_version, fact_table_for_contract, load_import_job, load_mapping_resolver,
)
from app.services.data_foundation.xlsx_parser import MappingResolver, PreviewSummary, ValidImportRow, WorkbookValidationError, parse_workbook

SOURCE = "collection_monitoring_t4_t5"
VERSION = 2
MAX_PARTS = 31
MAX_PART_BYTES = 64 * 1024 * 1024
MAX_BATCH_BYTES = 512 * 1024 * 1024
MAX_BATCH_ROWS = 2_000_000
BATCH_INSERT_SIZE = 5_000
VALIDATION_HEARTBEAT_ROWS = 10_000
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.xlsx$", re.I)


def normalized_manifest(raw_parts: list[dict[str, Any]]) -> tuple[dict[str, Any], bytes]:
    if not isinstance(raw_parts, list) or not raw_parts or len(raw_parts) > MAX_PARTS:
        raise DataFoundationError("t4t5_batch_part_count_invalid", 422)
    parts, seen = [], set()
    for raw in raw_parts:
        try:
            day = date.fromisoformat(str(raw["dataDate"]))
            name, size = str(raw["fileName"]), int(raw["sizeBytes"])
            digest, rows = str(raw["sha256"]).lower(), int(raw["rowCount"])
        except (ValueError, TypeError, KeyError):
            raise DataFoundationError("t4t5_batch_manifest_invalid", 422) from None
        if Path(name).name != name or not _NAME.fullmatch(name):
            raise DataFoundationError("t4t5_batch_file_name_invalid", 422)
        if day in seen or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise DataFoundationError("t4t5_batch_manifest_invalid", 422)
        if not 0 <= size <= MAX_PART_BYTES or not 0 <= rows <= MAX_BATCH_ROWS:
            raise DataFoundationError("t4t5_batch_limit_exceeded", 413)
        seen.add(day)
        parts.append({"dataDate": day.isoformat(), "fileName": name, "sizeBytes": size, "sha256": digest, "rowCount": rows})
    parts.sort(key=lambda part: part["dataDate"])
    days = [date.fromisoformat(part["dataDate"]) for part in parts]
    if any(days[i] != days[i - 1] + timedelta(days=1) for i in range(1, len(days))):
        raise DataFoundationError("t4t5_batch_dates_not_contiguous", 422)
    if sum(part["sizeBytes"] for part in parts) > MAX_BATCH_BYTES or sum(part["rowCount"] for part in parts) > MAX_BATCH_ROWS:
        raise DataFoundationError("t4t5_batch_total_limit_exceeded", 413)
    manifest = {"sourceId": SOURCE, "contractVersion": VERSION, "periodStart": days[0].isoformat(),
                "periodEnd": days[-1].isoformat(), "parts": parts}
    raw = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return manifest, hashlib.sha256(raw).digest()


def validate_part_summary(summary: PreviewSummary, expected_day: str, expected_rows: int) -> None:
    expected_dates = {expected_day: expected_rows} if expected_rows else {}
    if not summary.can_publish or summary.input_row_count != expected_rows or summary.valid_row_count != expected_rows:
        raise DataFoundationError("t4t5_batch_part_rows_mismatch", 409)
    if summary.per_date_counts != expected_dates:
        raise DataFoundationError("t4t5_batch_part_date_mismatch", 409)


def _binary(job_id: str) -> bytes:
    try:
        return uuid.UUID(job_id).bytes
    except (ValueError, TypeError, AttributeError):
        raise DataFoundationError("import_job_not_found", 404) from None


def _owned(job: Any, principal: str) -> None:
    if job["source_id"] != SOURCE or int(job["contract_version"]) != VERSION or job["submitted_by_service_principal_id"] != principal:
        raise DataFoundationError("import_job_not_found", 404)


def _batch_root(directory: Path) -> Path:
    root = directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        root.chmod(0o700)
    except OSError:
        raise DataFoundationError("import_storage_unavailable", 503) from None
    return root


def _part_key(job_id: str, day: str) -> str:
    return f"t4t5-batch-{uuid.UUID(job_id).hex}-{date.fromisoformat(day).isoformat()}.xlsx"


def save_part_stream(directory: Path, key: str, stream: Any, expected_size: int, expected_hash: str) -> tuple[int, str]:
    root = _batch_root(directory)
    if Path(key).name != key or not key.startswith("t4t5-batch-") or not key.endswith(".xlsx"):
        raise DataFoundationError("import_file_unavailable", 503)
    target = root / key
    temporary = root / f".{key}.{uuid.uuid4().hex}.tmp"
    digest, size = hashlib.sha256(), 0
    try:
        with temporary.open("xb") as output:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_PART_BYTES:
                    raise DataFoundationError("t4t5_batch_part_limit_exceeded", 413)
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        actual = digest.hexdigest()
        if size <= 0 or size != expected_size or actual != expected_hash:
            raise DataFoundationError("t4t5_batch_part_integrity_mismatch", 409)
        temporary.chmod(0o600)
        os.replace(temporary, target)
        return size, actual
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _parts(connection: Connection, job_id: str) -> list[Any]:
    return connection.execute(text("""
        SELECT data_date, part_no, original_file_name, expected_size_bytes, expected_sha256,
               expected_row_count, stored_file_key, upload_state, validation_state,
               valid_row_count, mapped_row_count, unmapped_row_count
        FROM data_import_batch_parts WHERE job_id=:job_id ORDER BY data_date
    """), {"job_id": _binary(job_id)}).mappings().all()


def _batch_state_is_stale(connection: Connection, updated_at: Any) -> bool:
    if connection.dialect.name == "sqlite":
        statement = "SELECT julianday('now') - julianday(:updated_at) > 2.0 / 24"
    else:
        statement = "SELECT :updated_at < CURRENT_TIMESTAMP(6) - INTERVAL 2 HOUR"
    return bool(connection.execute(text(statement), {"updated_at": updated_at}).scalar())


def _touch_validation_progress(engine: Engine, job_id: bytes, rows: int) -> None:
    timestamp = "CURRENT_TIMESTAMP" if engine.dialect.name == "sqlite" else "CURRENT_TIMESTAMP(6)"
    with engine.begin() as connection:
        updated = connection.execute(text(
            f"UPDATE data_import_batches SET progress_rows=:rows,updated_at={timestamp} "
            "WHERE job_id=:job AND batch_state='VALIDATING'"
        ), {"job": job_id, "rows": rows})
        if updated.rowcount != 1:
            raise DataFoundationError("t4t5_batch_validation_lease_lost", 409)


def batch_status(engine: Engine, job_id: str, principal: str) -> dict[str, Any]:
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        _owned(job, principal)
        batch = connection.execute(text("""
            SELECT batch.batch_state, batch.manifest_sha256, batch.period_start, batch.period_end, batch.map_version_id,
                   batch.expected_part_count, batch.expected_total_bytes, batch.expected_total_rows,
                   batch.publication_id, batch.progress_rows, batch.validation_error_code,
                   publication.version_no AS publication_version
            FROM data_import_batches batch
            LEFT JOIN source_publications publication ON publication.publication_id=batch.publication_id
            WHERE batch.job_id=:job_id
        """), {"job_id": _binary(job_id)}).mappings().first()
        if not batch:
            raise DataFoundationError("import_job_not_found", 404)
        parts = _parts(connection, job_id)
    return {
        "jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": batch["batch_state"],
        "manifestSha256": bytes(batch["manifest_sha256"]).hex(), "periodStart": str(batch["period_start"]),
        "periodEnd": str(batch["period_end"]), "mapVersionId": str(uuid.UUID(bytes=bytes(batch["map_version_id"]))),
        "publicationId": str(uuid.UUID(bytes=bytes(batch["publication_id"]))) if batch["publication_id"] else None,
        "publicationVersion": int(batch["publication_version"]) if batch["publication_version"] is not None else None,
        "expectedPartCount": int(batch["expected_part_count"]),
        "receivedPartCount": sum(row["upload_state"] == "RECEIVED" for row in parts),
        "validatedPartCount": sum(row["validation_state"] == "VALID" for row in parts),
        "expectedTotalBytes": int(batch["expected_total_bytes"]), "expectedTotalRows": int(batch["expected_total_rows"]),
        "progressRows": int(batch["progress_rows"] or 0), "errorCode": batch["validation_error_code"],
        "parts": [{"dataDate": str(row["data_date"]), "fileName": row["original_file_name"],
                   "sizeBytes": int(row["expected_size_bytes"]), "sha256": bytes(row["expected_sha256"]).hex(),
                   "rowCount": int(row["expected_row_count"]), "uploadState": row["upload_state"],
                   "validationState": row["validation_state"]} for row in parts],
    }


def create_batch(engine: Engine, *, principal: str, idempotency_key: str,
                 raw_parts: list[dict[str, Any]], map_version: bytes, request_id: str | None) -> dict[str, Any]:
    if not 8 <= len(idempotency_key) <= 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    manifest, digest = normalized_manifest(raw_parts)
    key_hash = hashlib.sha256(idempotency_key.encode()).digest()
    contract = get_contract(SOURCE, VERSION)
    job_uuid = uuid.uuid4()
    parts = manifest["parts"]
    stored_manifest = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    with engine.begin() as connection:
        connection.execute(text("SELECT source_id FROM data_source_registry WHERE source_id=:source_id" + _for_update_clause(connection)),
                           {"source_id": SOURCE}).first()
        registration = connection.execute(text("""
            SELECT registry.source_state, registry.history_policy AS registry_policy,
                   contract.contract_state, contract.history_policy, contract.contract_sha256
            FROM data_source_registry registry JOIN source_contract_versions contract
              ON contract.source_id=registry.source_id
            WHERE registry.source_id=:source_id AND contract.contract_version=:version
        """ + _for_update_clause(connection)), {"source_id": SOURCE, "version": VERSION}).mappings().first()
        if (not registration or registration["source_state"] != "ACTIVE" or registration["contract_state"] != "APPROVED"
            or registration["history_policy"] != contract.history_policy or registration["registry_policy"] != contract.history_policy
            or registration["contract_sha256"] is None or bytes(registration["contract_sha256"]) != contract_sha256(contract)):
            raise DataFoundationError("source_contract_not_approved", 409)
        if current_mapping_version(connection, lock=True) != map_version:
            raise DataFoundationError("official_mapping_unavailable", 409)
        existing = connection.execute(text("""
            SELECT job_id, manifest_sha256 FROM data_import_batches
            WHERE service_principal_id=:principal AND source_id=:source_id AND contract_version=:version
              AND idempotency_key_sha256=:key_hash
        """), {"principal": principal, "source_id": SOURCE, "version": VERSION, "key_hash": key_hash}).mappings().first()
        if existing:
            if bytes(existing["manifest_sha256"]) != digest:
                raise DataFoundationError("t4t5_batch_idempotency_conflict", 409)
            existing_job_id = str(uuid.UUID(bytes=bytes(existing["job_id"])))
        else:
            existing_job_id = None
        if existing_job_id is not None:
            # Return after releasing the current transaction to avoid consuming a
            # second pool connection while holding registry/job locks.
            pass
        else:
            active = connection.execute(text("""
                SELECT job_id FROM import_jobs WHERE source_id=:source_id
                  AND (job_state IN ('RECEIVED','PARSING') OR (contract_version=2 AND job_state='VALIDATED')) LIMIT 1
            """), {"source_id": SOURCE}).first()
            if active:
                raise DataFoundationError("import_job_processing", 409)
            job_name = f"t4t5-batch-{manifest['periodStart']}-{manifest['periodEnd']}.manifest"
            connection.execute(text("""
                INSERT INTO import_jobs
                  (job_id,source_id,contract_version,validation_map_version_id,submitted_by_user_id,
                   submitted_by_service_principal_id,job_state,original_file_name,stored_file_key,
                   file_size_bytes,file_sha256,request_id)
                VALUES (:job_id,:source_id,:version,:map_id,NULL,:principal,'RECEIVED',:name,:key,:size,:digest,:request_id)
            """), {"job_id": job_uuid.bytes, "source_id": SOURCE, "version": VERSION, "map_id": map_version,
                   "principal": principal, "name": job_name, "key": f"batch:{job_uuid.hex}",
                   "size": sum(p["sizeBytes"] for p in parts), "digest": digest, "request_id": request_id})
            connection.execute(text("""
                INSERT INTO data_import_batches
                  (job_id,source_id,contract_version,service_principal_id,manifest_json,manifest_sha256,
                   idempotency_key_sha256,period_start,period_end,map_version_id,expected_part_count,
                   expected_total_bytes,expected_total_rows,batch_state)
                VALUES (:job,:source,:version,:principal,:manifest,:digest,:keyhash,:start,:end,:map,
                        :count,:size,:rows,'RECEIVING')
            """), {"job": job_uuid.bytes, "source": SOURCE, "version": VERSION, "principal": principal,
                   "manifest": stored_manifest, "digest": digest, "keyhash": key_hash,
                   "start": date.fromisoformat(manifest["periodStart"]), "end": date.fromisoformat(manifest["periodEnd"]),
                   "map": map_version, "count": len(parts), "size": sum(p["sizeBytes"] for p in parts),
                   "rows": sum(p["rowCount"] for p in parts)})
            connection.execute(text("""
                INSERT INTO data_import_batch_parts
                  (job_id,data_date,part_no,original_file_name,expected_size_bytes,expected_sha256,
                   expected_row_count,upload_state,validation_state)
                VALUES (:job,:day,:part,:name,:size,:digest,:rows,'MISSING','PENDING')
            """), [{"job": job_uuid.bytes, "day": date.fromisoformat(p["dataDate"]), "part": index,
                    "name": p["fileName"], "size": p["sizeBytes"], "digest": bytes.fromhex(p["sha256"]),
                    "rows": p["rowCount"]} for index, p in enumerate(parts, 1)])
            _write_audit(connection, actor_user_id=None, actor_service_principal_id=principal,
                         action_code="T4T5_BATCH_CREATED", object_type="data_import_batch", object_id=job_uuid.bytes,
                         request_id=request_id, safe_context={"periodStart": manifest["periodStart"],
                         "periodEnd": manifest["periodEnd"], "partCount": len(parts), "manifestSha256": digest.hex()})
    return batch_status(engine, existing_job_id or str(job_uuid), principal)


def receive_part(engine: Engine, *, job_id: str, principal: str, day: str,
                 directory: Path, stream: Any) -> dict[str, Any]:
    binary = _binary(job_id)
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        _owned(job, principal)
        batch_state = connection.execute(text("SELECT batch_state FROM data_import_batches WHERE job_id=:job"),
                                         {"job": binary}).scalar_one_or_none()
        part = connection.execute(text("SELECT * FROM data_import_batch_parts WHERE job_id=:job AND data_date=:day"),
                                  {"job": binary, "day": date.fromisoformat(day)}).mappings().first()
        if batch_state is None or not part:
            raise DataFoundationError("t4t5_batch_part_not_found", 404)
        if batch_state not in {"RECEIVING", "FAILED", "INVALID"}:
            raise DataFoundationError("t4t5_batch_not_receiving", 409)
        expected_size, expected_hash = int(part["expected_size_bytes"]), bytes(part["expected_sha256"]).hex()
        stored_key = part["stored_file_key"]
        if part["upload_state"] == "RECEIVED" and stored_key:
            stored_path = directory.expanduser().resolve() / str(stored_key)
            try:
                if stored_path.is_file() and stored_path.stat().st_size == expected_size:
                    digest = hashlib.sha256()
                    with stored_path.open("rb") as existing_stream:
                        while chunk := existing_stream.read(1024 * 1024):
                            digest.update(chunk)
                    if digest.hexdigest() == expected_hash:
                        return {"jobId": job_id, "dataDate": day, "state": "RECEIVED", "reused": True}
            except OSError:
                pass
        if part["upload_state"] == "RECEIVED":
            with engine.begin() as connection:
                connection.execute(text("""
                    UPDATE data_import_batch_parts SET upload_state='MISSING',validation_state='PENDING',
                      stored_file_key=NULL,actual_size_bytes=NULL,actual_sha256=NULL,
                      valid_row_count=NULL,mapped_row_count=NULL,unmapped_row_count=NULL
                    WHERE job_id=:job AND data_date=:day AND upload_state='RECEIVED'
                """), {"job": binary, "day": date.fromisoformat(day)})
    key = _part_key(job_id, day)
    size, actual = save_part_stream(directory, key, stream, expected_size, expected_hash)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        _owned(job, principal)
        result = connection.execute(text("""
            UPDATE data_import_batch_parts SET stored_file_key=:key,actual_size_bytes=:size,
              actual_sha256=:digest,upload_state='RECEIVED'
            WHERE job_id=:job AND data_date=:day AND expected_sha256=:digest
        """), {"key": key, "size": size, "digest": bytes.fromhex(actual), "job": binary, "day": date.fromisoformat(day)})
        if result.rowcount != 1:
            raise DataFoundationError("t4t5_batch_part_integrity_mismatch", 409)
        connection.execute(text("UPDATE data_import_batches SET batch_state='RECEIVING',updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"),
                           {"job": binary})
    return {"jobId": job_id, "dataDate": day, "state": "RECEIVED", "reused": False}


def validate_batch(engine: Engine, *, job_id: str, principal: str, directory: Path) -> dict[str, Any]:
    binary = _binary(job_id)
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        _owned(job, principal)
        map_id = bytes(job["validation_map_version_id"] or b"")
        if len(map_id) != 16:
            raise DataFoundationError("official_mapping_unavailable", 409)
        resolver = load_mapping_resolver(connection, source_id=SOURCE, map_version_id=map_id)
        parts = _parts(connection, job_id)
    if not parts or any(part["upload_state"] != "RECEIVED" for part in parts):
        raise DataFoundationError("t4t5_batch_parts_missing", 409)
    contract = get_contract(SOURCE, VERSION)
    total_rows = mapped_rows = unmapped_rows = 0
    try:
        for part in parts:
            day, expected = str(part["data_date"]), int(part["expected_row_count"])
            part_offset = total_rows
            with engine.begin() as connection:
                connection.execute(text("UPDATE data_import_batches SET updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job AND batch_state='VALIDATING'"),
                                   {"job": binary})
            file_path = directory.expanduser().resolve() / str(part["stored_file_key"])
            last_heartbeat_row = 0

            def heartbeat(rows: int) -> None:
                nonlocal last_heartbeat_row
                if rows - last_heartbeat_row >= VALIDATION_HEARTBEAT_ROWS:
                    _touch_validation_progress(engine, binary, part_offset + rows)
                    last_heartbeat_row = rows

            parsed = parse_workbook(
                file_path, contract, resolver, expected_file_sha256=bytes(part["expected_sha256"]).hex(),
                on_progress=heartbeat,
            )
            validate_part_summary(parsed, day, expected)
            total_rows += expected
            mapped_rows += parsed.mapped_row_count
            unmapped_rows += parsed.unmapped_row_count
            with engine.begin() as connection:
                if current_mapping_version(connection, lock=True) != map_id:
                    raise DataFoundationError("official_mapping_changed_repreview", 409)
                connection.execute(text("""
                    UPDATE data_import_batch_parts SET validation_state='VALID',valid_row_count=:rows,
                      mapped_row_count=:mapped,unmapped_row_count=:unmapped
                    WHERE job_id=:job AND data_date=:day
                """), {"rows": expected, "mapped": parsed.mapped_row_count, "unmapped": parsed.unmapped_row_count,
                       "job": binary, "day": date.fromisoformat(day)})
                timestamp = "CURRENT_TIMESTAMP" if connection.dialect.name == "sqlite" else "CURRENT_TIMESTAMP(6)"
                connection.execute(text(f"UPDATE data_import_batches SET progress_rows=:rows,updated_at={timestamp} WHERE job_id=:job AND batch_state='VALIDATING'"),
                                   {"job": binary, "rows": total_rows})
        with engine.begin() as connection:
            job = load_import_job(connection, job_id, lock=True)
            _owned(job, principal)
            batch = connection.execute(text("SELECT expected_total_rows,expected_part_count FROM data_import_batches WHERE job_id=:job"),
                                       {"job": binary}).mappings().one()
            parts = _parts(connection, job_id)
            if total_rows != int(batch["expected_total_rows"]) or len(parts) != int(batch["expected_part_count"]) or any(p["validation_state"] != "VALID" for p in parts):
                raise DataFoundationError("t4t5_batch_manifest_reconciliation_failed", 409)
            if current_mapping_version(connection, lock=True) != map_id:
                raise DataFoundationError("official_mapping_changed_repreview", 409)
            connection.execute(text("UPDATE data_import_batches SET batch_state='VALIDATED',validation_error_code=NULL,updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"),
                               {"job": binary})
            connection.execute(text("UPDATE import_jobs SET job_state='VALIDATED',input_row_count=:rows,valid_row_count=:rows,error_count=0 WHERE job_id=:job"),
                               {"job": binary, "rows": total_rows})
            _write_audit(connection, actor_user_id=None, actor_service_principal_id=principal,
                         action_code="T4T5_BATCH_VALIDATED", object_type="data_import_batch", object_id=binary,
                         request_id=None, safe_context={"rows": total_rows, "parts": len(parts),
                         "mapVersionId": str(uuid.UUID(bytes=map_id))})
    except (DataFoundationError, WorkbookValidationError):
        with engine.begin() as connection:
            connection.execute(text("UPDATE data_import_batches SET batch_state='INVALID',validation_error_code='t4t5_batch_validation_failed',updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job AND batch_state<>'PUBLISHED'"),
                               {"job": binary})
            connection.execute(text("UPDATE import_jobs SET job_state='INVALID',error_count=1 WHERE job_id=:job"),
                               {"job": binary})
        raise
    return batch_status(engine, job_id, principal)


def queue_batch_publication(engine: Engine, *, job_id: str, principal: str, idempotency_key: str) -> dict[str, Any]:
    if not 8 <= len(idempotency_key) <= 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    key_hash, binary = hashlib.sha256(idempotency_key.encode()).digest(), _binary(job_id)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        _owned(job, principal)
        batch = connection.execute(text("SELECT batch_state,publish_key_sha256,updated_at FROM data_import_batches WHERE job_id=:job"),
                                   {"job": binary}).mappings().one_or_none()
        if not batch:
            raise DataFoundationError("import_job_not_found", 404)
        if batch["batch_state"] == "PUBLISHED":
            return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": "PUBLISHED", "startWorker": False}
        if batch["batch_state"] == "PUBLISHING":
            if batch["publish_key_sha256"] is None or bytes(batch["publish_key_sha256"]) != key_hash:
                raise DataFoundationError("t4t5_batch_idempotency_conflict", 409)
            stale = connection.execute(text("SELECT :updated_at < CURRENT_TIMESTAMP(6) - INTERVAL 2 HOUR"),
                                       {"updated_at": batch["updated_at"]}).scalar()
            if not stale:
                return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": "PUBLISHING", "startWorker": False}
            connection.execute(text("UPDATE data_import_batches SET updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"), {"job": binary})
            connection.execute(text("UPDATE import_jobs SET job_state='PARSING' WHERE job_id=:job"), {"job": binary})
            return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": "PUBLISHING", "startWorker": True}
        if batch["publish_key_sha256"] is not None and bytes(batch["publish_key_sha256"]) != key_hash:
            raise DataFoundationError("t4t5_batch_idempotency_conflict", 409)
        if batch["batch_state"] not in {"VALIDATED", "FAILED"}:
            raise DataFoundationError("import_job_not_validated", 409)
        connection.execute(text("UPDATE data_import_batches SET batch_state='PUBLISHING',publish_key_sha256=:key,updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"),
                           {"job": binary, "key": key_hash})
        connection.execute(text("UPDATE import_jobs SET job_state='PARSING' WHERE job_id=:job"), {"job": binary})
    return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": "PUBLISHING", "startWorker": True}


def publish_batch(engine: Engine, *, job_id: str, principal: str, directory: Path,
                  idempotency_key: str, request_id: str | None) -> None:
    binary, contract = _binary(job_id), get_contract(SOURCE, VERSION)
    table = fact_table_for_contract(SOURCE, VERSION)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        _owned(job, principal)
        batch = connection.execute(text("SELECT * FROM data_import_batches WHERE job_id=:job" + _for_update_clause(connection)),
                                   {"job": binary}).mappings().one()
        if job["job_state"] != "PARSING" or batch["batch_state"] != "PUBLISHING":
            return
        if batch["publish_key_sha256"] is None or bytes(batch["publish_key_sha256"]) != hashlib.sha256(idempotency_key.encode()).digest():
            raise DataFoundationError("t4t5_batch_idempotency_conflict", 409)
        map_id = bytes(job["validation_map_version_id"] or b"")
        if len(map_id) != 16 or current_mapping_version(connection, lock=True) != map_id:
            raise DataFoundationError("official_mapping_changed_repreview", 409)
        registry = _validate_contract_for_publication(connection, job)
        parts = _parts(connection, job_id)
        if not parts or any(part["validation_state"] != "VALID" for part in parts):
            raise DataFoundationError("t4t5_batch_parts_missing", 409)
        digest = bytes(batch["manifest_sha256"])
        counts = {str(part["data_date"]): int(part["valid_row_count"] or 0) for part in parts}
        summary = PreviewSummary(source_id=SOURCE, file_sha256=digest.hex(), contract_version=VERSION,
                                 map_version_id=map_id, mapping_version_available=True, per_date_counts=counts)
        summary.valid_row_count = summary.input_row_count = sum(counts.values())
        summary.mapped_row_count = sum(int(part["mapped_row_count"] or 0) for part in parts)
        summary.unmapped_row_count = max(0, summary.valid_row_count - summary.mapped_row_count)
        existing = connection.execute(text("SELECT publication_id,version_no,publication_state,file_sha256 FROM source_publications WHERE source_id=:source AND job_id=:job LIMIT 1"),
                                      {"source": SOURCE, "job": binary}).mappings().first()
        if existing:
            if existing["publication_state"] != "PREPARED" or bytes(existing["file_sha256"]) != digest:
                raise DataFoundationError("import_prepared_publication_conflict", 409)
            publication_id, version_no = bytes(existing["publication_id"]), int(existing["version_no"])
            prepared_dates = {str(row["data_date"]): int(row["row_count"]) for row in connection.execute(text("""
                SELECT data_date,row_count FROM source_publication_dates
                WHERE source_id=:source AND publication_id=:publication
            """), {"source": SOURCE, "publication": publication_id}).mappings()}
            if prepared_dates != counts:
                raise DataFoundationError("import_prepared_publication_conflict", 409)
            connection.execute(text(f"DELETE FROM {table} WHERE publication_id=:publication"), {"publication": publication_id})
        else:
            last = connection.execute(text("SELECT version_no FROM source_publications WHERE source_id=:source ORDER BY version_no DESC LIMIT 1" + _for_update_clause(connection)),
                                      {"source": SOURCE}).scalar_one_or_none()
            version_no, publication_id = int(last or 0) + 1, uuid.uuid4().bytes
            connection.execute(text("""
                INSERT INTO source_publications
                  (publication_id,source_id,version_no,job_id,contract_version,map_version_id,file_sha256,
                   publication_state,history_policy,period_start,period_end,snapshot_as_of,row_count,
                   mapped_row_count,unmapped_row_count,missing_identifier_row_count,ambiguous_row_count)
                VALUES (:pub,:source,:version,:job,:contract,:map,:hash,'PREPARED',:policy,:start,:end,NULL,
                        :rows,:mapped,:unmapped,:missing,:ambiguous)
            """), {"pub": publication_id, "source": SOURCE, "version": version_no, "job": binary,
                   "contract": VERSION, "map": map_id, "hash": digest, "policy": registry["history_policy"],
                   "start": date.fromisoformat(str(batch["period_start"])), "end": date.fromisoformat(str(batch["period_end"])),
                   "rows": summary.valid_row_count, "mapped": summary.mapped_row_count,
                   "unmapped": summary.unmapped_row_count, "missing": summary.missing_identifier_row_count,
                   "ambiguous": summary.ambiguous_row_count})
            _write_publication_dates(connection, SOURCE, publication_id, summary)
    with engine.connect() as connection:
        resolver = load_mapping_resolver(connection, source_id=SOURCE, map_version_id=map_id)
    fields = ["source_id", "publication_id", "map_version_id", "source_row_no",
              *(column.key for column in contract.columns), "resolved_base_code", "mapping_resolution"]
    statement = text(f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join(':'+field for field in fields)})")
    inserted = 0
    batch_rows: list[dict[str, object]] = []
    def flush() -> None:
        if not batch_rows:
            return
        with engine.begin() as connection:
            connection.execute(statement, list(batch_rows))
            connection.execute(text("""
                UPDATE data_import_batches SET progress_rows=:rows,updated_at=CURRENT_TIMESTAMP(6)
                WHERE job_id=:job AND batch_state='PUBLISHING'
            """), {"rows": inserted, "job": binary})
        batch_rows.clear()
    for part in parts:
        day = str(part["data_date"])
        path = directory.expanduser().resolve() / str(part["stored_file_key"])
        expected_hash = bytes(part["expected_sha256"]).hex()
        local_count = 0
        def add_row(row: ValidImportRow) -> None:
            nonlocal inserted, local_count
            fact = _fact_row(SOURCE, contract, publication_id, map_id, row)
            fact["source_row_no"] = inserted + 1
            batch_rows.append(fact)
            inserted += 1
            local_count += 1
            if len(batch_rows) >= BATCH_INSERT_SIZE:
                flush()
        parsed = parse_workbook(path, contract, resolver, expected_file_sha256=expected_hash, on_valid_row=add_row)
        flush()
        expected_count = int(part["valid_row_count"] or 0)
        if parsed.valid_row_count != expected_count or parsed.per_date_counts != ({day: expected_count} if expected_count else {}):
            raise DataFoundationError("t4t5_batch_validation_changed", 409)
    flush()
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        _owned(job, principal)
        if current_mapping_version(connection, lock=True) != map_id:
            raise DataFoundationError("official_mapping_changed_repreview", 409)
        actual = {str(row["data_date"]): int(row["row_count"]) for row in connection.execute(text(
            f"SELECT data_date,COUNT(*) AS row_count FROM {table} WHERE publication_id=:publication GROUP BY data_date"),
            {"publication": publication_id}).mappings()}
        expected = {day: count for day, count in counts.items() if count}
        if actual != expected or inserted != summary.valid_row_count:
            raise DataFoundationError("import_publication_count_mismatch", 409)
        result = connection.execute(text("UPDATE source_publications SET publication_state='PUBLISHED',published_at=CURRENT_TIMESTAMP(6) WHERE publication_id=:publication AND publication_state='PREPARED'"),
                                    {"publication": publication_id})
        if result.rowcount != 1:
            raise DataFoundationError("import_prepared_publication_conflict", 409)
        _switch_t4t5_heads_if_newer(connection, publication_id=publication_id, version_no=version_no, summary=summary)
        connection.execute(text("UPDATE import_jobs SET job_state='PUBLISHED',input_row_count=:rows,valid_row_count=:rows,error_count=0,finished_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"),
                           {"rows": summary.valid_row_count, "job": binary})
        connection.execute(text("UPDATE data_import_batches SET batch_state='PUBLISHED',publication_id=:pub,progress_rows=:rows,updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job"),
                           {"pub": publication_id, "rows": summary.valid_row_count, "job": binary})
        _write_audit(connection, actor_user_id=None, actor_service_principal_id=principal,
                     action_code="T4T5_BATCH_PUBLISHED", object_type="source_publication", object_id=publication_id,
                     request_id=request_id, safe_context={"version": version_no, "rows": summary.valid_row_count,
                     "parts": len(parts), "manifestSha256": digest.hex(),
                     "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode()).hexdigest()})


def publish_batch_safely(engine: Engine, **kwargs: Any) -> None:
    try:
        publish_batch(engine, **kwargs)
    except (DataFoundationError, WorkbookValidationError) as error:
        _mark_failed(engine, str(kwargs["job_id"]), str(kwargs["principal"]), error.code)
    except Exception:
        _mark_failed(engine, str(kwargs["job_id"]), str(kwargs["principal"]), "t4t5_batch_publication_failed")


def _mark_failed(engine: Engine, job_id: str, principal: str, code: str) -> None:
    safe_code = re.sub(r"[^a-z0-9_]", "", code.lower())[:80] or "batch_failed"
    with engine.begin() as connection:
        try:
            job = load_import_job(connection, job_id, lock=True)
            _owned(job, principal)
        except DataFoundationError:
            return
        connection.execute(text("UPDATE data_import_batches SET batch_state='FAILED',validation_error_code=:code,updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job AND batch_state='PUBLISHING'"),
                           {"code": safe_code, "job": _binary(job_id)})
        connection.execute(text("UPDATE import_jobs SET job_state='FAILED',error_count=1,finished_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job AND job_state='PARSING'"),
                           {"job": _binary(job_id)})



def queue_batch_validation(engine: Engine, *, job_id: str, principal: str) -> dict[str, Any]:
    binary = _binary(job_id)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        _owned(job, principal)
        batch = connection.execute(text("SELECT batch_state,updated_at FROM data_import_batches WHERE job_id=:job"),
                                   {"job": binary}).mappings().one_or_none()
        if not batch:
            raise DataFoundationError("import_job_not_found", 404)
        state = batch["batch_state"]
        if state == "VALIDATED":
            return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": state, "startWorker": False}
        stale_validation = False
        if state == "VALIDATING":
            stale_validation = _batch_state_is_stale(connection, batch["updated_at"])
            if not stale_validation:
                return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": state, "startWorker": False}
        if state not in {"RECEIVING", "INVALID", "FAILED"} and not (state == "VALIDATING" and stale_validation):
            raise DataFoundationError("t4t5_batch_not_validatable", 409)
        parts = _parts(connection, job_id)
        if not parts or any(part["upload_state"] != "RECEIVED" for part in parts):
            raise DataFoundationError("t4t5_batch_parts_missing", 409)
        timestamp = "CURRENT_TIMESTAMP" if connection.dialect.name == "sqlite" else "CURRENT_TIMESTAMP(6)"
        connection.execute(text(f"UPDATE data_import_batches SET batch_state='VALIDATING',progress_rows=0,updated_at={timestamp} WHERE job_id=:job"),
                           {"job": binary})
        connection.execute(text("UPDATE import_jobs SET job_state='PARSING',error_count=0 WHERE job_id=:job"),
                           {"job": binary})
    return {"jobId": job_id, "sourceId": SOURCE, "contractVersion": VERSION, "state": "VALIDATING", "startWorker": True}


def validate_batch_safely(engine: Engine, *, job_id: str, principal: str, directory: Path) -> None:
    try:
        validate_batch(engine, job_id=job_id, principal=principal, directory=directory)
    except Exception as error:
        code = error.code if isinstance(error, (DataFoundationError, WorkbookValidationError)) else "t4t5_batch_validation_failed"
        safe_code = re.sub(r"[^a-z0-9_]", "", code.lower())[:80] or "batch_validation_failed"
        with engine.begin() as connection:
            connection.execute(text("UPDATE data_import_batches SET batch_state='INVALID',validation_error_code=:code,updated_at=CURRENT_TIMESTAMP(6) WHERE job_id=:job AND batch_state='VALIDATING'"),
                               {"code": safe_code, "job": _binary(job_id)})
            connection.execute(text("UPDATE import_jobs SET job_state='INVALID',error_count=1 WHERE job_id=:job AND job_state='PARSING'"),
                               {"job": _binary(job_id)})
