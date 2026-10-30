from __future__ import annotations

import json
import hashlib
import logging
import os
import uuid
import threading
from contextlib import contextmanager
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import BinaryIO, Callable, Iterator

from sqlalchemy import Engine, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.engine import Connection, RowMapping

from app.services.data_foundation.contracts import (
    CONTRACTS,
    CONTRACT_VERSIONS,
    INITIAL_MAPPING_WORKBOOK_SHA256,
    SourceContract,
    contract_sha256,
    get_contract,
)
from app.services.data_foundation.mapping_resolution import (
    CODE_RESOLUTION_SOURCES,
    NAME_MAPPED_SOURCES,
    code_only_mapping,
    name_mapping_enabled,
    normalize_mapping_name,
    resolve_name_candidates,
)
from app.services.data_foundation.xlsx_parser import (
    MappingResolver,
    PreviewSummary,
    ValidImportRow,
    WorkbookValidationError,
    parse_workbook,
)

logger = logging.getLogger(__name__)


FACT_TABLES = {
    "collection_monitoring": "fact_collection_monitoring",
    "collection_monitoring_t4_t5": "fact_collection_monitoring_t4_t5",
    "collection_rate": "fact_collection_rate",
    "jt_monitoring": "fact_jt_monitoring",
    "no_movement": "fact_no_movement_snapshot",
    "pdd_collection_failure": "fact_pdd_collection_failure",
}
FACT_TABLES_BY_VERSION: dict[tuple[str, int], str] = {
    (source_id, contract.version): FACT_TABLES[source_id]
    for (source_id, _version), contract in CONTRACT_VERSIONS.items()
    if source_id in FACT_TABLES
}
FACT_TABLES_BY_VERSION[("pdd_collection_failure", 2)] = "fact_pdd_collection_failure_v2"
FACT_TABLES_BY_VERSION[("collection_rate", 2)] = "fact_collection_rate_v2"
FACT_TABLES_BY_VERSION[("collection_rate", 3)] = "fact_collection_rate_v3"
FACT_TABLES_BY_VERSION[("collection_monitoring", 2)] = "fact_collection_monitoring_v2"


def fact_table_for_contract(source_id: str, contract_version: int | None = None) -> str:
    contract = get_contract(source_id, contract_version)
    try:
        return FACT_TABLES_BY_VERSION[(source_id, contract.version)]
    except KeyError:
        raise DataFoundationError("data_source_contract_version_not_supported", 404) from None
DAILY_SOURCES = frozenset({
    "collection_monitoring", "collection_monitoring_t4_t5", "collection_rate", "jt_monitoring", "pdd_collection_failure",
})
FACT_BATCH_SIZE = 1000
T4T5_SOURCE = "collection_monitoring_t4_t5"
T4T5_FACT_BATCH_SIZE = 5000
T4T5_PROGRESS_INTERVAL = 10_000
_T4T5_LOCAL_JOB_LOCKS: dict[str, threading.Lock] = {}
_T4T5_LOCAL_JOB_LOCKS_GUARD = threading.Lock()
_NAME_MAPPING_RESOLUTIONS = frozenset({"NAME_APPROVED", "UNMAPPED", "MISSING_IDENTIFIER", "AMBIGUOUS"})
_CODE_MAPPING_RESOLUTIONS = frozenset({"CODE_MATCH", "UNMAPPED"})
_UNAPPROVED_MAPPING_RESOLUTIONS = frozenset({
    "UNAPPROVED_EXACT_NAME", "UNAPPROVED_NORMALIZED_NAME", "REJECTED",
})


class DataFoundationError(RuntimeError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _uuid_bytes(value: str) -> bytes:
    try:
        return uuid.UUID(value).bytes
    except (ValueError, AttributeError):
        raise DataFoundationError("import_job_not_found", 404) from None


def _row_value(row: RowMapping | None, key: str) -> object | None:
    return None if row is None else row.get(key)


def _for_update_clause(connection: Connection) -> str:
    return " FOR UPDATE" if connection.dialect.name == "mysql" else ""


def current_mapping_version(connection: Connection, *, lock: bool = False) -> bytes | None:
    statement = """
        SELECT map_pointer.map_version_id
        FROM base_mapping_current AS map_pointer
        JOIN base_mapping_versions AS version
          ON version.map_version_id = map_pointer.map_version_id
        WHERE version.version_state = 'PUBLISHED'
        LIMIT 1
    """ + (_for_update_clause(connection) if lock else "")
    result = connection.execute(text(statement)).first()
    if result is None:
        return None
    value = result[0]
    return bytes(value)


def load_mapping_resolver(
    connection: Connection,
    *,
    source_id: str,
    map_version_id: bytes | None = None,
) -> MappingResolver:
    version_id = map_version_id or current_mapping_version(connection)
    if version_id is None:
        return MappingResolver()

    mapping_rows = connection.execute(text("""
        SELECT base_code, base_name
        FROM base_mapping_entries
        WHERE map_version_id = :map_version_id
    """), {"map_version_id": version_id})
    codes: set[str] = set()
    exact_names: dict[str, list[str]] = {}
    normalized_names: dict[str, set[str]] = {}
    for code, name in mapping_rows:
        code_text = str(code)
        name_text = str(name)
        codes.add(code_text)
        exact_names.setdefault(name_text, []).append(code_text)
        normalized_names.setdefault(normalize_mapping_name(name_text), set()).add(code_text)
    decisions: dict[str, tuple[str, str | None]] = {}
    if source_id in NAME_MAPPED_SOURCES:
        for name, state, target in connection.execute(text("""
            SELECT source_base_name, resolution_state, target_base_code
            FROM base_mapping_name_decisions
            WHERE map_version_id = :map_version_id AND source_id = :source_id
        """), {"map_version_id": version_id, "source_id": source_id}):
            decisions[str(name)] = (str(state), str(target) if target is not None else None)
    normalized_decision_groups: dict[str, list[tuple[str, tuple[str, str | None]]]] = {}
    for name, decision in decisions.items():
        normalized_decision_groups.setdefault(normalize_mapping_name(name), []).append((name, decision))
    normalized_decisions = {
        key: group[0][1]
        for key, group in normalized_decision_groups.items()
        if len(group) == 1
    }
    return MappingResolver(
        map_version_id=version_id,
        base_codes=frozenset(codes),
        exact_base_name_candidates={
            name: tuple(candidate_codes) for name, candidate_codes in exact_names.items()
        },
        normalized_base_name_candidates={
            name: tuple(sorted(candidate_codes)) for name, candidate_codes in normalized_names.items()
        },
        name_decisions=decisions,
        normalized_name_decisions=normalized_decisions,
    )


def get_name_mapping_candidates(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
) -> dict[str, object]:
    """List exact and conservative normalized candidates without approving them."""
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if job["submitted_by_user_id"] != actor_user_id:
            raise DataFoundationError("import_job_not_found", 404)
        source_id = str(job["source_id"])
        contract_version = int(job["contract_version"])
        if not name_mapping_enabled(source_id, contract_version):
            raise DataFoundationError("name_mapping_not_supported_for_source", 422)
        if job["job_state"] != "VALIDATED":
            raise DataFoundationError("import_job_not_validated", 409)
        map_version_id = bytes(job["validation_map_version_id"] or b"")
        if len(map_version_id) != 16 or current_mapping_version(connection) != map_version_id:
            raise DataFoundationError("official_mapping_changed_repreview", 409)
        resolver = load_mapping_resolver(
            connection, source_id=source_id, map_version_id=map_version_id
        )
        mapping_rows = list(connection.execute(text("""
            SELECT base_code, base_name, regional_name, uf_code
            FROM base_mapping_entries
            WHERE map_version_id = :map_version_id
        """), {"map_version_id": map_version_id}).mappings())

    content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
    if hashlib.sha256(content).digest() != bytes(job["file_sha256"]):
        raise DataFoundationError("import_source_hash_mismatch", 409)
    counts: Counter[str] = Counter()
    contract = get_contract(source_id, int(job["contract_version"]))

    def count_source_name(row: ValidImportRow) -> None:
        source_name = row.values.get("source_base_name")
        if isinstance(source_name, str):
            counts[source_name] += 1

    summary = parse_workbook(
        content,
        contract,
        resolver,
        on_valid_row=count_source_name,
    )
    if summary.invalid_row_count:
        raise DataFoundationError("import_validation_changed", 409)

    mapping_by_code = {str(row["base_code"]): row for row in mapping_rows}
    candidates = []
    for source_name in sorted(counts):
        target_codes = resolver.exact_base_name_candidates.get(source_name, ())
        normalized_target_codes = (
            resolver.normalized_base_name_candidates.get(normalize_mapping_name(source_name), ())
            if not target_codes else ()
        )
        decision = resolver.name_decisions.get(source_name)
        if decision is None and not target_codes:
            decision = resolver.normalized_name_decisions.get(normalize_mapping_name(source_name))
        resolved_code, resolution = resolve_name_candidates(
            exact_candidates=target_codes,
            normalized_candidates=normalized_target_codes,
            decision=decision,
        )
        if resolved_code is not None and decision and decision[0] == "LINKED":
            decision_state = "LINKED"
        elif resolved_code is not None:
            decision_state = "AUTO_MATCH"
        elif decision is not None:
            decision_state = decision[0]
        else:
            decision_state = "UNREVIEWED"
        candidates.append({
            "sourceBaseName": source_name,
            "sourceRowCount": counts[source_name],
            "exactTargetCandidates": [
                {
                    "baseCode": code,
                    "baseName": str(mapping_by_code[code]["base_name"]),
                    "region": mapping_by_code[code]["regional_name"],
                    "uf": mapping_by_code[code]["uf_code"],
                }
                for code in target_codes
                if code in mapping_by_code
            ],
            "normalizedTargetCandidates": [
                {
                    "baseCode": code,
                    "baseName": str(mapping_by_code[code]["base_name"]),
                    "region": mapping_by_code[code]["regional_name"],
                    "uf": mapping_by_code[code]["uf_code"],
                }
                for code in normalized_target_codes
                if code in mapping_by_code
            ],
            "matchMethod": "EXACT" if target_codes else "NORMALIZED" if normalized_target_codes else "NONE",
            "decisionState": decision_state,
            "approvedTargetBaseCode": resolved_code if resolution == "NAME_APPROVED" else None,
        })
    return {
        "jobId": job_id,
        "sourceId": source_id,
        "mappingVersionId": str(uuid.UUID(bytes=map_version_id)),
        "candidates": candidates,
        "candidateNameCount": sum(
            bool(item["exactTargetCandidates"] or item["normalizedTargetCandidates"])
            for item in candidates
        ),
        "unmatchedNameCount": sum(
            not item["exactTargetCandidates"] and not item["normalizedTargetCandidates"]
            for item in candidates
        ),
    }


def validate_name_mapping_decision(
    *,
    source_id: str,
    source_base_name: str,
    resolution_state: str,
    target_base_code: str | None,
    candidate_codes: tuple[str, ...],
    review_note: str,
) -> None:
    if source_id not in NAME_MAPPED_SOURCES:
        raise DataFoundationError("name_mapping_not_supported_for_source", 422)
    if not source_base_name.strip() or len(source_base_name) > 191:
        raise DataFoundationError("source_base_name_invalid", 422)
    if not review_note.strip() or len(review_note) > 500:
        raise DataFoundationError("mapping_review_note_required", 422)
    if resolution_state not in {"LINKED", "AMBIGUOUS", "REJECTED"}:
        raise DataFoundationError("mapping_resolution_state_invalid", 422)
    if resolution_state == "LINKED":
        if not target_base_code or target_base_code not in candidate_codes:
            raise DataFoundationError("mapping_target_must_be_candidate", 422)
    elif target_base_code is not None:
        raise DataFoundationError("mapping_target_not_allowed_for_unlinked_decision", 422)


def record_name_mapping_decision(
    engine: Engine,
    *,
    source_id: str,
    source_base_name: str,
    resolution_state: str,
    target_base_code: str | None,
    review_note: str,
    actor_user_id: int,
    request_id: str | None,
) -> dict[str, object]:
    review_note = review_note.strip()
    with engine.begin() as connection:
        map_version_id = current_mapping_version(connection, lock=True)
        if map_version_id is None:
            raise DataFoundationError("official_mapping_unavailable", 409)
        resolver = load_mapping_resolver(
            connection, source_id=source_id, map_version_id=map_version_id
        )
        candidate_codes = resolver.exact_base_name_candidates.get(source_base_name, ())
        if not candidate_codes:
            candidate_codes = resolver.normalized_base_name_candidates.get(
                normalize_mapping_name(source_base_name), ()
            )
        validate_name_mapping_decision(
            source_id=source_id,
            source_base_name=source_base_name,
            resolution_state=resolution_state,
            target_base_code=target_base_code,
            candidate_codes=candidate_codes,
            review_note=review_note,
        )
        existing = connection.execute(text("""
            SELECT resolution_state, target_base_code, review_note
            FROM base_mapping_name_decisions
            WHERE map_version_id = :map_version_id
              AND source_id = :source_id
              AND source_base_name = :source_base_name
            FOR UPDATE
        """), {
            "map_version_id": map_version_id,
            "source_id": source_id,
            "source_base_name": source_base_name,
        }).mappings().first()
        if existing is not None:
            if (
                existing["resolution_state"] == resolution_state
                and (str(existing["target_base_code"]) if existing["target_base_code"] else None) == target_base_code
                and existing["review_note"] == review_note
            ):
                return {
                    "mappingVersionId": str(uuid.UUID(bytes=map_version_id)),
                    "sourceId": source_id,
                    "sourceBaseName": source_base_name,
                    "resolutionState": resolution_state,
                    "targetBaseCode": target_base_code,
                    "alreadyRecorded": True,
                }
            raise DataFoundationError("mapping_name_decision_immutable", 409)

        connection.execute(text("""
            INSERT INTO base_mapping_name_decisions
              (map_version_id, source_id, source_base_name, resolution_state,
               target_base_code, reviewed_by_user_id, reviewed_at, review_note)
            VALUES
              (:map_version_id, :source_id, :source_base_name, :resolution_state,
               :target_base_code, :actor_user_id, CURRENT_TIMESTAMP(6), :review_note)
        """), {
            "map_version_id": map_version_id,
            "source_id": source_id,
            "source_base_name": source_base_name,
            "resolution_state": resolution_state,
            "target_base_code": target_base_code,
            "actor_user_id": actor_user_id,
            "review_note": review_note.strip(),
        })
        _write_audit(
            connection,
            actor_user_id=actor_user_id,
            action_code="MAPPING_NAME_DECISION_RECORDED",
            object_type="base_mapping_name_decision",
            object_id=map_version_id,
            request_id=request_id,
            safe_context={
                "sourceId": source_id,
                "resolutionState": resolution_state,
                "targetBaseCode": target_base_code,
            },
        )
    return {
        "mappingVersionId": str(uuid.UUID(bytes=map_version_id)),
        "sourceId": source_id,
        "sourceBaseName": source_base_name,
        "resolutionState": resolution_state,
        "targetBaseCode": target_base_code,
        "alreadyRecorded": False,
    }


def save_uploaded_workbook(directory: Path, content: bytes) -> str:
    """Store an opaque source key in a configured private staging directory."""
    root = directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        root.chmod(0o700)
    except OSError:
        raise DataFoundationError("import_storage_unavailable", 503) from None
    key = f"{uuid.uuid4().hex}.xlsx"
    destination = root / key
    try:
        with destination.open("xb") as stream:
            stream.write(content)
        destination.chmod(0o600)
    except OSError:
        destination.unlink(missing_ok=True)
        raise DataFoundationError("import_storage_unavailable", 503) from None
    return key


def read_staged_workbook(directory: Path, key: str) -> bytes:
    if not key.endswith(".xlsx") or Path(key).name != key:
        raise DataFoundationError("import_file_unavailable", 503)
    try:
        return (directory.expanduser().resolve() / key).read_bytes()
    except OSError:
        raise DataFoundationError("import_file_unavailable", 503) from None


def staged_workbook_path(directory: Path, key: str) -> Path:
    if not key.endswith(".xlsx") or Path(key).name != key:
        raise DataFoundationError("import_file_unavailable", 503)
    path = directory.expanduser().resolve() / key
    if not path.is_file():
        raise DataFoundationError("import_file_unavailable", 503)
    return path


def save_uploaded_workbook_stream(
    directory: Path,
    stream: BinaryIO,
    *,
    max_bytes: int,
) -> tuple[str, int, str]:
    """Copy an uploaded XLSX to private staging without buffering the file in RAM."""
    root = directory.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        root.chmod(0o700)
    except OSError:
        raise DataFoundationError("import_storage_unavailable", 503) from None
    key = f"{uuid.uuid4().hex}.xlsx"
    destination = root / key
    digest = hashlib.sha256()
    size = 0
    try:
        stream.seek(0)
        with destination.open("xb") as output:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise DataFoundationError("workbook_file_too_large", 413)
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        destination.chmod(0o600)
    except DataFoundationError:
        destination.unlink(missing_ok=True)
        raise
    except OSError:
        destination.unlink(missing_ok=True)
        raise DataFoundationError("import_storage_unavailable", 503) from None
    if size == 0:
        destination.unlink(missing_ok=True)
        raise DataFoundationError("workbook_empty", 400)
    return key, size, digest.hexdigest()


def _preview_manifest_path(directory: Path, key: str) -> Path:
    if not key.endswith(".xlsx") or Path(key).name != key:
        raise DataFoundationError("import_file_unavailable", 503)
    return directory.expanduser().resolve() / f"{key}.preview.json"


def write_preview_manifest(directory: Path, key: str, payload: dict[str, object]) -> None:
    path = _preview_manifest_path(directory, key)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with temporary.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise DataFoundationError("import_storage_unavailable", 503) from None


def read_preview_manifest(directory: Path, key: str) -> dict[str, object] | None:
    path = _preview_manifest_path(directory, key)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        raise DataFoundationError("import_preview_unavailable", 503) from None
    if not isinstance(payload, dict):
        raise DataFoundationError("import_preview_unavailable", 503)
    return payload


@contextmanager
def _locked_import_connection(engine: Engine, lock_key: str) -> Iterator[Connection | None]:
    """Serialize work for one import across MySQL workers; use a local lock in SQLite tests."""
    local_lock: threading.Lock | None = None
    if engine.dialect.name != "mysql":
        with _T4T5_LOCAL_JOB_LOCKS_GUARD:
            local_lock = _T4T5_LOCAL_JOB_LOCKS.setdefault(lock_key, threading.Lock())
        acquired = local_lock.acquire(blocking=False)
        if not acquired:
            yield None
            return
    try:
        connection = engine.connect()
    except Exception:
        if local_lock is not None:
            local_lock.release()
        raise
    mysql_lock_acquired = False
    try:
        if engine.dialect.name == "mysql":
            mysql_lock_acquired = connection.execute(
                text("SELECT GET_LOCK(:lock_name, 0)"), {"lock_name": lock_key[:64]},
            ).scalar_one_or_none() == 1
            connection.commit()
            if not mysql_lock_acquired:
                yield None
                return
        yield connection
    finally:
        if mysql_lock_acquired:
            try:
                connection.execute(text("SELECT RELEASE_LOCK(:lock_name)"), {"lock_name": lock_key[:64]})
                connection.commit()
            except Exception:
                connection.rollback()
        connection.close()
        if local_lock is not None and local_lock.locked():
            local_lock.release()


def _insert_errors(connection: Connection, job_id: bytes, summary: PreviewSummary) -> None:
    if not summary.errors:
        return
    statement = text("""
        INSERT INTO import_job_errors
          (job_id, source_row_no, column_key, error_code, safe_context)
        VALUES
          (:job_id, :source_row_no, :column_key, :error_code, :safe_context)
    """)
    rows = [{
        "job_id": job_id,
        "source_row_no": error["rowNumber"],
        "column_key": error["column"],
        "error_code": error["code"],
        "safe_context": json.dumps({"code": error["code"]}),
    } for error in summary.errors]
    connection.execute(statement, rows)


def create_preview_job(
    connection: Connection,
    *,
    source_id: str,
    actor_user_id: int | None,
    actor_service_principal_id: str | None = None,
    file_name: str,
    file_size: int,
    stored_file_key: str,
    summary: PreviewSummary,
    request_id: str | None,
) -> str:
    if (actor_user_id is None) == (actor_service_principal_id is None):
        raise DataFoundationError("import_actor_invalid", 403)
    contract = get_contract(source_id, summary.contract_version)
    if source_id == "base_mapping_official" and contract.version >= 2:
        raise DataFoundationError("mapping_candidate_endpoint_required", 409)
    job_id = uuid.uuid4()
    status = "VALIDATED" if summary.can_publish else "INVALID"
    with connection.begin():
        registered = connection.execute(text("""
            SELECT registry.source_state, contract.contract_state, contract.contract_sha256
            FROM data_source_registry AS registry
            JOIN source_contract_versions AS contract
              ON contract.source_id = registry.source_id
            WHERE registry.source_id = :source_id
              AND contract.contract_version = :contract_version
        """), {"source_id": source_id, "contract_version": contract.version}).mappings().first()
        if registered is None:
            raise DataFoundationError("source_contract_not_registered", 409)
        if registered["contract_sha256"] is None or bytes(registered["contract_sha256"]) != contract_sha256(contract):
            raise DataFoundationError("source_contract_definition_mismatch", 409)
        if registered["source_state"] in {"RETIRED", "PAUSED"}:
            raise DataFoundationError("data_source_unavailable", 409)
        actor_columns = (
            "submitted_by_user_id, submitted_by_service_principal_id"
            if actor_service_principal_id else "submitted_by_user_id"
        )
        actor_values = (
            ":actor_user_id, :service_principal_id"
            if actor_service_principal_id else ":actor_user_id"
        )
        connection.execute(text(f"""
            INSERT INTO import_jobs
              (job_id, source_id, contract_version, validation_map_version_id,
               {actor_columns}, job_state, original_file_name, stored_file_key,
               file_size_bytes, file_sha256, input_row_count, valid_row_count,
               error_count, request_id, validated_at)
            VALUES
              (:job_id, :source_id, :contract_version, :map_version_id,
               {actor_values}, :job_state, :file_name, :stored_file_key,
               :file_size, :file_sha256, :input_rows, :valid_rows,
               :error_count, :request_id, CURRENT_TIMESTAMP(6))
        """), {
            "job_id": job_id.bytes,
            "source_id": source_id,
            "contract_version": contract.version,
            "map_version_id": summary_map_version(summary),
            "actor_user_id": actor_user_id,
            "service_principal_id": actor_service_principal_id,
            "job_state": status,
            "file_name": file_name[:255],
            "stored_file_key": stored_file_key,
            "file_size": file_size,
            "file_sha256": bytes.fromhex(summary.file_sha256),
            "input_rows": summary.input_row_count,
            "valid_rows": summary.valid_row_count,
            "error_count": sum(summary.error_counts.values()),
            "request_id": request_id,
        })
        _insert_errors(connection, job_id.bytes, summary)
    return str(job_id)


def create_received_import_job(
    connection: Connection,
    *,
    source_id: str,
    actor_user_id: int,
    file_name: str,
    file_size: int,
    stored_file_key: str,
    file_sha256: str,
    map_version_id: bytes | None,
    request_id: str | None,
) -> str:
    """Persist a large T4/T5 upload before its asynchronous validation begins."""
    contract = get_contract(source_id, 1)
    if source_id != T4T5_SOURCE or map_version_id is None:
        raise DataFoundationError("official_mapping_unavailable", 409)
    job_id = uuid.uuid4()
    with connection.begin():
        registered = connection.execute(text("""
            SELECT registry.source_state, contract.contract_state, contract.contract_sha256
            FROM data_source_registry AS registry
            JOIN source_contract_versions AS contract
              ON contract.source_id = registry.source_id
            WHERE registry.source_id = :source_id
              AND contract.contract_version = :contract_version
        """ + _for_update_clause(connection)), {"source_id": source_id, "contract_version": contract.version}).mappings().first()
        if registered is None:
            raise DataFoundationError("source_contract_not_registered", 409)
        if registered["contract_sha256"] is None or bytes(registered["contract_sha256"]) != contract_sha256(contract):
            raise DataFoundationError("source_contract_definition_mismatch", 409)
        if registered["source_state"] in {"RETIRED", "PAUSED"}:
            raise DataFoundationError("data_source_unavailable", 409)
        _ensure_no_other_active_t4t5_job(connection)
        connection.execute(text("""
            INSERT INTO import_jobs
              (job_id, source_id, contract_version, validation_map_version_id,
               submitted_by_user_id, job_state, original_file_name, stored_file_key,
               file_size_bytes, file_sha256, request_id)
            VALUES
              (:job_id, :source_id, :contract_version, :map_version_id,
               :actor_user_id, 'RECEIVED', :file_name, :stored_file_key,
               :file_size, :file_sha256, :request_id)
        """), {
            "job_id": job_id.bytes,
            "source_id": source_id,
            "contract_version": contract.version,
            "map_version_id": map_version_id,
            "actor_user_id": actor_user_id,
            "file_name": file_name[:255],
            "stored_file_key": stored_file_key,
            "file_size": file_size,
            "file_sha256": bytes.fromhex(file_sha256),
            "request_id": request_id,
        })
    return str(job_id)


def _ensure_no_other_active_t4t5_job(connection: Connection, *, except_job_id: str | None = None) -> None:
    """Admit one T4/T5 validation or publication at a time per source."""
    parameters: dict[str, object] = {"source_id": T4T5_SOURCE}
    exclusion = ""
    if except_job_id is not None:
        exclusion = " AND job_id <> :except_job_id"
        parameters["except_job_id"] = _uuid_bytes(except_job_id)
    active_job = connection.execute(text("""
        SELECT job_id FROM import_jobs
        WHERE source_id = :source_id AND job_state IN ('RECEIVED', 'PARSING')
    """ + exclusion + " LIMIT 1"), parameters).first()
    if active_job is not None:
        raise DataFoundationError("import_job_processing", 409)


def _lock_t4t5_source(connection: Connection) -> None:
    """Serialize import admission decisions on the registered source row."""
    source = connection.execute(text("""
        SELECT source_id FROM data_source_registry
        WHERE source_id = :source_id
    """ + _for_update_clause(connection)), {"source_id": T4T5_SOURCE}).first()
    if source is None:
        raise DataFoundationError("source_contract_not_registered", 409)


def queue_t4t5_preview_validation(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
) -> dict[str, object]:
    with _locked_import_connection(engine, f"df-preview:{job_id}") as connection:
        if connection is None:
            raise DataFoundationError("import_job_processing", 409)
        with connection.begin():
            job = load_import_job(connection, job_id, lock=True)
            if job["submitted_by_user_id"] != actor_user_id:
                raise DataFoundationError("import_job_not_found", 404)
            if str(job["source_id"]) != T4T5_SOURCE or int(job["contract_version"]) != 1:
                raise DataFoundationError("source_contract_version_unsupported", 409)
            _lock_t4t5_source(connection)
            _ensure_no_other_active_t4t5_job(connection, except_job_id=job_id)
            if str(job["job_state"]) not in {"RECEIVED", "PARSING", "FAILED", "INVALID", "VALIDATED"}:
                raise DataFoundationError("import_job_not_validatable", 409)
            prepared = connection.execute(text("""
                SELECT publication_id FROM source_publications
                WHERE source_id = :source_id AND job_id = :job_id
                LIMIT 1
            """), {"source_id": T4T5_SOURCE, "job_id": _uuid_bytes(job_id)}).first()
            if prepared is not None:
                raise DataFoundationError("import_prepared_publication_requires_retry", 409)
            resolver = load_mapping_resolver(connection, source_id=T4T5_SOURCE)
            if resolver.map_version_id is None:
                raise DataFoundationError("official_mapping_unavailable", 409)
            connection.execute(text("""
                UPDATE import_jobs
                SET validation_map_version_id = :map_version_id,
                    job_state = 'RECEIVED', input_row_count = 0, valid_row_count = NULL,
                    error_count = 0, finished_at = NULL
                WHERE job_id = :job_id
            """), {"map_version_id": resolver.map_version_id, "job_id": _uuid_bytes(job_id)})
    return {"jobId": job_id, "sourceId": T4T5_SOURCE, "state": "RECEIVED", "phase": "VALIDATION"}


def summary_map_version(summary: PreviewSummary) -> bytes | None:
    return summary.map_version_id


def process_t4t5_preview_job(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
) -> None:
    """Validate a staged T4/T5 workbook in a worker, with durable row progress."""
    with _locked_import_connection(engine, f"df-preview:{job_id}") as connection:
        if connection is None:
            return
        try:
            with connection.begin():
                job = load_import_job(connection, job_id, lock=True)
                if job["submitted_by_user_id"] != actor_user_id:
                    raise DataFoundationError("import_job_not_found", 404)
                if str(job["source_id"]) != T4T5_SOURCE or int(job["contract_version"]) != 1:
                    raise DataFoundationError("source_contract_version_unsupported", 409)
                if job["job_state"] in {"VALIDATED", "INVALID", "PUBLISHED", "REUSED", "ABORTED"}:
                    return
                prepared = connection.execute(text("""
                    SELECT publication_id FROM source_publications
                    WHERE source_id = :source_id AND job_id = :job_id
                    LIMIT 1
                """), {"source_id": T4T5_SOURCE, "job_id": _uuid_bytes(job_id)}).first()
                if prepared is not None:
                    raise DataFoundationError("import_prepared_publication_requires_retry", 409)
                map_version_id = bytes(job["validation_map_version_id"] or b"")
                if len(map_version_id) != 16:
                    raise DataFoundationError("official_mapping_unavailable", 409)
                connection.execute(text("""
                    UPDATE import_jobs
                    SET job_state = 'PARSING', input_row_count = 0,
                        valid_row_count = NULL, error_count = 0, finished_at = NULL
                    WHERE job_id = :job_id
                """), {"job_id": _uuid_bytes(job_id)})
                stored_key = str(job["stored_file_key"])
                file_sha256 = bytes(job["file_sha256"]).hex()
                source_name = str(job["original_file_name"])
            contract = get_contract(T4T5_SOURCE, 1)
            resolver = load_mapping_resolver(connection, source_id=T4T5_SOURCE, map_version_id=map_version_id)
            connection.commit()
            last_progress = 0

            def record_progress(rows_processed: int) -> None:
                nonlocal last_progress
                if rows_processed - last_progress < T4T5_PROGRESS_INTERVAL:
                    return
                with connection.begin():
                    connection.execute(text("""
                        UPDATE import_jobs SET input_row_count = :rows_processed
                        WHERE job_id = :job_id AND job_state = 'PARSING'
                    """), {"rows_processed": rows_processed, "job_id": _uuid_bytes(job_id)})
                last_progress = rows_processed

            summary = parse_workbook(
                staged_workbook_path(staging_directory, stored_key), contract, resolver,
                trusted_file_sha256=file_sha256,
                on_progress=record_progress,
            )
            if summary.file_sha256 != file_sha256:
                raise DataFoundationError("import_source_hash_mismatch", 409)
            summary.map_version_id = map_version_id
            manifest = summary.as_api_dict()
            manifest.update({"phase": "VALIDATION", "fileName": source_name})
            write_preview_manifest(staging_directory, stored_key, manifest)
            with connection.begin():
                connection.execute(text("""
                    DELETE FROM import_job_errors WHERE job_id = :job_id
                """), {"job_id": _uuid_bytes(job_id)})
                connection.execute(text("""
                    UPDATE import_jobs
                    SET validation_map_version_id = :map_version_id,
                        job_state = :job_state, input_row_count = :input_rows,
                        valid_row_count = :valid_rows, error_count = :error_count,
                        validated_at = CURRENT_TIMESTAMP(6), finished_at = NULL
                    WHERE job_id = :job_id AND submitted_by_user_id = :actor_user_id
                """), {
                    "map_version_id": map_version_id,
                    "job_state": "VALIDATED" if summary.can_publish else "INVALID",
                    "input_rows": summary.input_row_count,
                    "valid_rows": summary.valid_row_count,
                    "error_count": sum(summary.error_counts.values()),
                    "job_id": _uuid_bytes(job_id),
                    "actor_user_id": actor_user_id,
                })
                _insert_errors(connection, _uuid_bytes(job_id), summary)
        except (DataFoundationError, WorkbookValidationError) as error:
            error_code = error.code
            try:
                with connection.begin():
                    job = load_import_job(connection, job_id, lock=True)
                    if job["submitted_by_user_id"] == actor_user_id and job["job_state"] not in {"PUBLISHED", "REUSED"}:
                        connection.execute(text("""
                            UPDATE import_jobs SET job_state = 'FAILED', error_count = 1,
                                finished_at = CURRENT_TIMESTAMP(6)
                            WHERE job_id = :job_id
                        """), {"job_id": _uuid_bytes(job_id)})
                        stored_key = str(job["stored_file_key"])
                write_preview_manifest(staging_directory, stored_key, {
                    "phase": "VALIDATION", "errorCode": error_code,
                })
            except Exception:
                # A missing progress record is recoverable by submitting validation again.
                return
        except Exception:
            try:
                with connection.begin():
                    job = load_import_job(connection, job_id, lock=True)
                    if job["submitted_by_user_id"] == actor_user_id and job["job_state"] not in {"PUBLISHED", "REUSED"}:
                        connection.execute(text("""
                            UPDATE import_jobs SET job_state = 'FAILED', error_count = 1,
                                finished_at = CURRENT_TIMESTAMP(6)
                            WHERE job_id = :job_id
                        """), {"job_id": _uuid_bytes(job_id)})
                        stored_key = str(job["stored_file_key"])
                write_preview_manifest(staging_directory, stored_key, {
                    "phase": "VALIDATION", "errorCode": "import_processing_failed",
                })
            except Exception:
                return


def load_import_job(connection: Connection, job_id: str, *, lock: bool = False) -> RowMapping:
    statement = """
        SELECT job_id, source_id, contract_version, validation_map_version_id, reused_publication_id,
               job_state, original_file_name, stored_file_key, file_size_bytes,
               file_sha256, input_row_count, valid_row_count, error_count,
               submitted_by_user_id, submitted_by_service_principal_id
        FROM import_jobs
        WHERE job_id = :job_id
    """ + (_for_update_clause(connection) if lock else "")
    row = connection.execute(text(statement), {"job_id": _uuid_bytes(job_id)}).mappings().first()
    if row is None:
        raise DataFoundationError("import_job_not_found", 404)
    return row


def _validate_contract_for_publication(connection: Connection, job: RowMapping) -> dict[str, object]:
    row = connection.execute(text("""
        SELECT registry.source_state, registry.history_policy AS registry_history_policy,
               contract.contract_state, contract.expected_sheet,
               contract.header_row, contract.history_policy, contract.contract_sha256
        FROM data_source_registry AS registry
        JOIN source_contract_versions AS contract
          ON contract.source_id = registry.source_id
        WHERE registry.source_id = :source_id
          AND contract.contract_version = :contract_version
    """ + _for_update_clause(connection)), {
        "source_id": job["source_id"],
        "contract_version": job["contract_version"],
    }).mappings().first()
    if row is None or row["source_state"] != "ACTIVE":
        raise DataFoundationError("data_source_not_active", 409)
    if row["contract_state"] != "APPROVED":
        raise DataFoundationError("source_contract_not_approved", 409)
    contract = get_contract(str(job["source_id"]), int(job["contract_version"]))
    if row["contract_sha256"] is None or bytes(row["contract_sha256"]) != contract_sha256(contract):
        raise DataFoundationError("source_contract_definition_mismatch", 409)
    if row["history_policy"] not in {"DAILY_REPLACE_DATES", "SNAPSHOT_REPLACE_ALL"}:
        raise DataFoundationError("source_history_policy_not_approved", 409)
    expected_policy = contract.history_policy
    if row["history_policy"] != expected_policy or row["registry_history_policy"] != expected_policy:
        raise DataFoundationError("source_history_policy_mismatch", 409)
    return dict(row)


def _fact_row(
    source_id: str,
    contract: SourceContract,
    publication_id: bytes,
    map_version_id: bytes,
    row: ValidImportRow,
) -> dict[str, object]:
    mapping_resolution = _persisted_mapping_resolution(source_id, row.mapping_resolution, contract.version)
    uses_code_mapping = source_id in CODE_RESOLUTION_SOURCES or code_only_mapping(source_id, contract.version)
    values: dict[str, object] = {
        "source_id": source_id,
        "publication_id": publication_id,
        "map_version_id": map_version_id,
        "source_row_no": row.source_row_no,
        "resolved_base_code": (
            row.resolved_base_code
            if not uses_code_mapping or row.mapping_resolution == "CODE_MATCH"
            else None
        ),
        "mapping_resolution": mapping_resolution,
    }
    values.update(row.values)
    if source_id == "pdd_collection_failure" and contract.version == 2:
        if row.source_sheet_name is None or row.source_sheet_row_no is None:
            raise DataFoundationError("import_source_lineage_missing", 409)
        values["source_sheet_name"] = row.source_sheet_name
        values["source_sheet_row_no"] = row.source_sheet_row_no
    return values


def _persisted_mapping_resolution(source_id: str, resolution: str, contract_version: int = 1) -> str:
    """Translate parser-only states to the source table's existing ENUM values."""
    if source_id in CODE_RESOLUTION_SOURCES or code_only_mapping(source_id, contract_version):
        if resolution == "CODE_MATCH":
            return resolution
        if resolution in (_NAME_MAPPING_RESOLUTIONS | _UNAPPROVED_MAPPING_RESOLUTIONS | _CODE_MAPPING_RESOLUTIONS):
            return "UNMAPPED"
    elif source_id in NAME_MAPPED_SOURCES:
        if resolution in _NAME_MAPPING_RESOLUTIONS:
            return resolution
        if resolution in _UNAPPROVED_MAPPING_RESOLUTIONS:
            # Preserve the original name and row, but never imply an approved link.
            return "UNMAPPED"
    elif source_id in CODE_RESOLUTION_SOURCES:
        if resolution == "CODE_MATCH":
            return resolution
        if resolution in (_NAME_MAPPING_RESOLUTIONS | _UNAPPROVED_MAPPING_RESOLUTIONS | _CODE_MAPPING_RESOLUTIONS):
            # Code-only fact ENUMs stay unchanged; approved name decisions are
            # reapplied at read time from base_mapping_name_decisions.
            return "UNMAPPED"

    raise DataFoundationError("mapping_resolution_not_persistable", 409)


def _insert_fact_batches(
    connection: Connection,
    *,
    source_id: str,
    contract: SourceContract,
    publication_id: bytes,
    map_version_id: bytes,
    file_content: bytes,
    resolver: MappingResolver,
) -> None:
    table = fact_table_for_contract(source_id, contract.version)
    fact_columns = [
        "source_id", "publication_id", "map_version_id", "source_row_no",
        *(column.key for column in contract.columns), "resolved_base_code", "mapping_resolution",
    ]
    if source_id == "pdd_collection_failure" and contract.version == 2:
        fact_columns[4:4] = ["source_sheet_name", "source_sheet_row_no"]
    column_sql = ", ".join(f"`{column}`" for column in fact_columns)
    value_sql = ", ".join(f":{column}" for column in fact_columns)
    statement = text(f"INSERT INTO `{table}` ({column_sql}) VALUES ({value_sql})")
    batch: list[dict[str, object]] = []

    def add(row: ValidImportRow) -> None:
        batch.append(_fact_row(source_id, contract, publication_id, map_version_id, row))
        if len(batch) >= FACT_BATCH_SIZE:
            connection.execute(statement, batch)
            batch.clear()

    parsed = parse_workbook(file_content, contract, resolver, on_valid_row=add)
    if parsed.invalid_row_count or not parsed.can_publish:
        raise DataFoundationError("import_validation_changed", 409)
    if batch:
        connection.execute(statement, batch)
    if parsed.valid_row_count == 0:
        raise DataFoundationError("import_has_no_valid_rows", 422)


def _date_counts(summary: PreviewSummary) -> list[tuple[date, int]]:
    return [(date.fromisoformat(key), count) for key, count in sorted(summary.per_date_counts.items())]


def _switch_heads(
    connection: Connection,
    *,
    source_id: str,
    publication_id: bytes,
    summary: PreviewSummary,
) -> None:
    if source_id in DAILY_SOURCES:
        statement = text("""
            INSERT INTO source_daily_head (source_id, data_date, publication_id)
            VALUES (:source_id, :data_date, :publication_id)
            ON DUPLICATE KEY UPDATE
              publication_id = VALUES(publication_id),
              changed_at = CURRENT_TIMESTAMP(6)
        """)
        connection.execute(statement, [
            {"source_id": source_id, "data_date": day, "publication_id": publication_id}
            for day, _count in _date_counts(summary)
        ])
    else:
        connection.execute(text("""
            INSERT INTO source_snapshot_head (source_id, publication_id)
            VALUES (:source_id, :publication_id)
            ON DUPLICATE KEY UPDATE
              publication_id = VALUES(publication_id),
              changed_at = CURRENT_TIMESTAMP(6)
        """), {"source_id": source_id, "publication_id": publication_id})


def _write_publication_dates(
    connection: Connection,
    source_id: str,
    publication_id: bytes,
    summary: PreviewSummary,
) -> None:
    dates = _date_counts(summary)
    if dates:
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES (:source_id, :publication_id, :data_date, :row_count)
        """), [
            {"source_id": source_id, "publication_id": publication_id, "data_date": day, "row_count": count}
            for day, count in dates
        ])


def _write_audit(
    connection: Connection,
    *,
    actor_user_id: int | None,
    actor_service_principal_id: str | None = None,
    action_code: str,
    object_type: str,
    object_id: bytes,
    request_id: str | None,
    safe_context: dict[str, object],
) -> None:
    if actor_user_id is None and actor_service_principal_id is None:
        raise DataFoundationError("audit_actor_required", 500)
    if actor_user_id is not None and actor_service_principal_id is not None:
        raise DataFoundationError("audit_actor_ambiguous", 500)
    if actor_service_principal_id:
        safe_context = {**safe_context, "actorType": "service", "servicePrincipalId": actor_service_principal_id}
        statement = """
            INSERT INTO data_audit_events
              (actor_user_id, actor_service_principal_id, action_code, object_type, object_id, request_id, event_context)
            VALUES (NULL, :service_principal_id, :action_code, :object_type, :object_id, :request_id, :event_context)
        """
    else:
        statement = """
        INSERT INTO data_audit_events
          (actor_user_id, action_code, object_type, object_id, request_id, event_context)
        VALUES
          (:actor_user_id, :action_code, :object_type, :object_id, :request_id, :event_context)
        """
    connection.execute(text(statement), {
        "actor_user_id": actor_user_id,
        "service_principal_id": actor_service_principal_id,
        "action_code": action_code,
        "object_type": object_type,
        "object_id": object_id,
        "request_id": request_id,
        "event_context": json.dumps(safe_context, separators=(",", ":")),
    })


def publish_import_job(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int | None,
    actor_service_principal_id: str | None = None,
    staging_directory: Path,
    idempotency_key: str,
    request_id: str | None,
) -> dict[str, object]:
    if not idempotency_key or len(idempotency_key) > 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    binary_job_id = _uuid_bytes(job_id)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        if job["source_id"] == "base_mapping_official":
            raise DataFoundationError("mapping_candidate_publication_not_enabled", 409)
        job_owner_matches = (
            job.get("submitted_by_service_principal_id") == actor_service_principal_id
            if actor_service_principal_id
            else job["submitted_by_user_id"] == actor_user_id
        )
        if actor_service_principal_id and not job_owner_matches:
            raise DataFoundationError("import_job_not_publishable", 409)
        if not actor_service_principal_id and not job_owner_matches and job["job_state"] not in {"VALIDATED", "PUBLISHED", "REUSED"}:
            raise DataFoundationError("import_job_not_publishable", 409)
        if job["job_state"] not in {"VALIDATED", "PUBLISHED", "REUSED"}:
            raise DataFoundationError("import_job_not_validated", 409)
        source_id = str(job["source_id"])
        try:
            contract = get_contract(source_id, int(job["contract_version"]))
        except KeyError:
            raise DataFoundationError("source_contract_version_unsupported", 409)
        registry = _validate_contract_for_publication(connection, job)
        map_version_id = bytes(job["validation_map_version_id"] or b"")
        if len(map_version_id) != 16:
            raise DataFoundationError("official_mapping_unavailable", 409)
        if current_mapping_version(connection, lock=True) != map_version_id:
            raise DataFoundationError("official_mapping_changed_repreview", 409)
        resolver = load_mapping_resolver(connection, source_id=source_id, map_version_id=map_version_id)
        content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
        preview_manifest = read_preview_manifest(staging_directory, str(job["stored_file_key"])) or {}
        manual_export_confirmation = None
        if source_id == "no_movement" and preview_manifest.get("exportMetadataSource") == "ADMIN_CONFIRMATION":
            try:
                confirmer = int(preview_manifest["exportMetadataConfirmedByUserId"])
                if confirmer != actor_user_id:
                    raise ValueError("confirmation actor changed")
                export_date = date.fromisoformat(str(preview_manifest["collectionDate"]))
                export_time = datetime.fromisoformat(str(preview_manifest["botExecutedAt"]))
                confirmed_at = datetime.fromisoformat(str(preview_manifest["exportMetadataConfirmedAt"]))
                manual_export_confirmation = {
                    "export_date": export_date,
                    "export_time": export_time,
                    "confirmed_at": confirmed_at,
                    "user_id": confirmer,
                }
            except (KeyError, TypeError, ValueError):
                raise DataFoundationError("no_movement_export_confirmation_invalid", 409) from None
        summary = parse_workbook(content, contract, resolver, manual_export_confirmation=manual_export_confirmation)
        if summary.file_sha256 != bytes(job["file_sha256"]).hex():
            raise DataFoundationError("import_source_hash_mismatch", 409)
        if not summary.can_publish:
            raise DataFoundationError("import_validation_failed", 422)

        fingerprint = connection.execute(text("""
            SELECT publication_id, version_no
            FROM source_publications
            WHERE source_id = :source_id
              AND contract_version = :contract_version
              AND map_version_id = :map_version_id
              AND file_sha256 = :file_sha256
              AND publication_state = 'PUBLISHED'
            LIMIT 1
            FOR UPDATE
        """), {
            "source_id": source_id,
            "contract_version": contract.version,
            "map_version_id": map_version_id,
            "file_sha256": bytes.fromhex(summary.file_sha256),
        }).mappings().first()
        if fingerprint is not None:
            publication_id = bytes(fingerprint["publication_id"])
            _switch_heads(connection, source_id=source_id, publication_id=publication_id, summary=summary)
            connection.execute(text("""
                UPDATE import_jobs
                SET job_state = 'REUSED', reused_publication_id = :publication_id,
                    finished_at = CURRENT_TIMESTAMP(6)
                WHERE job_id = :job_id
            """), {"publication_id": publication_id, "job_id": binary_job_id})
            _write_audit(
                connection,
                actor_user_id=actor_user_id,
            actor_service_principal_id=actor_service_principal_id,
                action_code="PUBLICATION_REUSED",
                object_type="source_publication",
                object_id=publication_id,
                request_id=request_id,
                safe_context={
                    "sourceId": source_id,
                    "rowCount": summary.valid_row_count,
                    "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
                },
            )
            return {"publicationId": str(uuid.UUID(bytes=publication_id)), "version": int(fingerprint["version_no"]), "reused": True}

        # The existing registry table has no sequence column. The row lock on
        # the source registry serializes this current-read allocation per source.
        last_version = connection.execute(text("""
            SELECT version_no
            FROM source_publications
            WHERE source_id = :source_id
            ORDER BY version_no DESC
            LIMIT 1
            FOR UPDATE
        """), {"source_id": source_id}).scalar_one_or_none()
        next_version = int(last_version or 0) + 1
        publication_uuid = uuid.uuid4()
        publication_id = publication_uuid.bytes
        period_start = min((date.fromisoformat(key) for key in summary.per_date_counts), default=None)
        period_end = max((date.fromisoformat(key) for key in summary.per_date_counts), default=None)
        snapshot_as_of = None
        if source_id == "no_movement":
            # This snapshot has no per-row business date. Keep the Bot_NewBI
            # collection date and execution time as source metadata; publication
            # time remains published_at and is not a substitute for either.
            period_start = summary.collection_date
            period_end = summary.collection_date
            snapshot_as_of = summary.bot_executed_at
        elif source_id == "pdd_collection_failure" and contract.version == 2:
            snapshot_as_of = summary.bot_executed_at
        elif source_id == "collection_rate" and contract.version == 2:
            snapshot_as_of = summary.bot_executed_at
        elif source_id == "collection_rate" and contract.version == 3:
            snapshot_as_of = summary.bot_executed_at
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, version_no, job_id, contract_version,
               map_version_id, file_sha256, publication_state, history_policy,
               period_start, period_end, snapshot_as_of, row_count, mapped_row_count,
               unmapped_row_count, missing_identifier_row_count, ambiguous_row_count)
            VALUES
              (:publication_id, :source_id, :version_no, :job_id, :contract_version,
               :map_version_id, :file_sha256, 'PREPARED', :history_policy,
               :period_start, :period_end, :snapshot_as_of, :row_count, :mapped_row_count,
               :unmapped_row_count, :missing_identifier_row_count, :ambiguous_row_count)
        """), {
            "publication_id": publication_id,
            "source_id": source_id,
            "version_no": next_version,
            "job_id": binary_job_id,
            "contract_version": contract.version,
            "map_version_id": map_version_id,
            "file_sha256": bytes.fromhex(summary.file_sha256),
            "history_policy": registry["history_policy"],
            "period_start": period_start,
            "period_end": period_end,
            "snapshot_as_of": snapshot_as_of,
            "row_count": summary.valid_row_count,
            "mapped_row_count": summary.mapped_row_count,
            "unmapped_row_count": summary.unmapped_row_count,
            "missing_identifier_row_count": summary.missing_identifier_row_count,
            "ambiguous_row_count": summary.ambiguous_row_count,
        })
        _write_publication_dates(connection, source_id, publication_id, summary)
        _insert_fact_batches(
            connection,
            source_id=source_id,
            contract=contract,
            publication_id=publication_id,
            map_version_id=map_version_id,
            file_content=content,
            resolver=resolver,
        )
        connection.execute(text("""
            UPDATE source_publications
            SET publication_state = 'PUBLISHED', published_at = CURRENT_TIMESTAMP(6)
            WHERE publication_id = :publication_id
        """), {"publication_id": publication_id})
        _switch_heads(connection, source_id=source_id, publication_id=publication_id, summary=summary)
        connection.execute(text("""
            UPDATE import_jobs
            SET job_state = 'PUBLISHED', finished_at = CURRENT_TIMESTAMP(6)
            WHERE job_id = :job_id
        """), {"job_id": binary_job_id})
        _write_audit(
            connection,
            actor_user_id=actor_user_id,
            actor_service_principal_id=actor_service_principal_id,
            action_code="PUBLICATION_PUBLISHED",
            object_type="source_publication",
            object_id=publication_id,
            request_id=request_id,
            safe_context={
                "sourceId": source_id,
                "version": next_version,
                "rowCount": summary.valid_row_count,
                "mappedRowCount": summary.mapped_row_count,
                "unmappedRowCount": summary.unmapped_row_count,
                **({
                    "botExecutionId": summary.bot_execution_id,
                    "botExecutedAt": summary.bot_executed_at.isoformat(sep=" ") if summary.bot_executed_at else None,
                    "collectionDate": summary.collection_date.isoformat() if summary.collection_date else None,
                    "exportMetadataSource": "ADMIN_CONFIRMATION" if summary.export_metadata_confirmed_by_user_id else "BOT_METADATA",
                    "exportMetadataConfirmedByUserId": summary.export_metadata_confirmed_by_user_id,
                    "exportMetadataConfirmedAt": summary.export_metadata_confirmed_at.isoformat(sep=" ") if summary.export_metadata_confirmed_at else None,
                    "exportTimeZone": "America/Sao_Paulo",
                } if source_id == "no_movement" else {}),
                "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
            },
        )
        if source_id == "no_movement" and contract.version == 2:
            try:
                with connection.begin_nested():
                    connection.execute(text("""
                        INSERT INTO no_movement_operational_analyses
                          (analysis_id, source_id, publication_id, publication_version, contract_version,
                           map_version_id, operational_date, export_time_local, export_time_zone,
                           export_time_source, confirmation_user_id, confirmed_at, analysis_state, rules_version)
                        VALUES
                          (:analysis_id, :source_id, :publication_id, :publication_version, :contract_version,
                           :map_version_id, :operational_date, :export_time_local, 'America/Sao_Paulo',
                           :export_time_source, :confirmation_user_id, :confirmed_at, 'PENDING', 'v1')
                    """), {
                        "analysis_id": uuid.uuid4().bytes,
                        "source_id": source_id,
                        "publication_id": publication_id,
                        "publication_version": next_version,
                        "contract_version": contract.version,
                        "map_version_id": map_version_id,
                        "operational_date": summary.collection_date,
                        "export_time_local": summary.bot_executed_at,
                        "export_time_source": "ADMIN_CONFIRMATION" if summary.export_metadata_confirmed_by_user_id else "BOT_METADATA" if summary.bot_executed_at else "UNKNOWN",
                        "confirmation_user_id": summary.export_metadata_confirmed_by_user_id,
                        "confirmed_at": summary.export_metadata_confirmed_at,
                    })
            except SQLAlchemyError:
                # The sidecar analysis schema is manually provisioned. Its absence
                # or failure must never roll back a valid source publication.
                logger.exception("Unable to enqueue no-movement operational analysis")
        if source_id == "pdd_collection_failure" and contract.version == 2 and map_version_id is not None:
            try:
                operational_dates = [
                    date.fromisoformat(key)
                    for key, row_count in summary.per_date_counts.items()
                    if int(row_count) > 0
                ]
                if operational_dates:
                    with connection.begin_nested():
                        connection.execute(text("""
                            INSERT INTO pdd_collection_failure_operational_analyses
                              (analysis_id, source_id, publication_id, publication_version, contract_version,
                               map_version_id, operational_date, analysis_state, rules_version)
                            VALUES
                              (:analysis_id, :source_id, :publication_id, :publication_version, :contract_version,
                               :map_version_id, :operational_date, 'PENDING', 'v1')
                        """), {
                            "analysis_id": uuid.uuid4().bytes,
                            "source_id": source_id,
                            "publication_id": publication_id,
                            "publication_version": next_version,
                            "contract_version": contract.version,
                            "map_version_id": map_version_id,
                            "operational_date": max(operational_dates),
                        })
            except SQLAlchemyError:
                # The analysis sidecar is manually provisioned and must not fail a valid publication.
                logger.exception("Unable to enqueue PDD operational analysis")
        publication_result: dict[str, object] = {
            "publicationId": str(publication_uuid), "version": next_version, "reused": False,
        }
        if source_id == "no_movement":
            publication_result.update({
                "exportMetadataConfirmedByUserId": summary.export_metadata_confirmed_by_user_id,
                "exportMetadataConfirmedAt": summary.export_metadata_confirmed_at.isoformat(sep=" ") if summary.export_metadata_confirmed_at else None,
            })
        return publication_result


def _summary_from_preview_manifest(payload: dict[str, object]) -> PreviewSummary:
    try:
        map_id_value = payload.get("mappingVersionId")
        map_version_id = uuid.UUID(str(map_id_value)).bytes if map_id_value else None
        per_date_counts = payload.get("perDateCounts")
        error_counts = payload.get("errorCounts")
        errors = payload.get("errors")
        summary = PreviewSummary(
            source_id=str(payload["sourceId"]),
            contract_version=int(payload["contractVersion"]),
            file_sha256=str(payload["fileSha256"]),
            input_row_count=int(payload["inputRowCount"]),
            valid_row_count=int(payload["validRowCount"]),
            invalid_row_count=int(payload["invalidRowCount"]),
            exact_duplicate_count=int(payload["duplicateCount"]),
            mapped_row_count=int(payload["mappedRowCount"]),
            unmapped_row_count=int(payload["unmappedRowCount"]),
            exact_name_candidate_row_count=int(payload["exactNameCandidateRowCount"]),
            normalized_name_candidate_row_count=int(payload["normalizedNameCandidateRowCount"]),
            no_mapping_match_row_count=int(payload["noMappingMatchRowCount"]),
            missing_identifier_row_count=int(payload["missingIdentifierRowCount"]),
            ambiguous_row_count=int(payload["ambiguousRowCount"]),
            mapping_version_available=bool(payload["mappingVersionAvailable"]),
            map_version_id=map_version_id,
            per_date_counts={str(key): int(value) for key, value in dict(per_date_counts or {}).items()},
            error_counts=Counter({str(key): int(value) for key, value in dict(error_counts or {}).items()}),
            errors=list(errors or []),
        )
        if summary.source_id != T4T5_SOURCE or summary.contract_version != 1:
            raise ValueError("unexpected source")
        return summary
    except (KeyError, TypeError, ValueError, AttributeError):
        raise DataFoundationError("import_preview_unavailable", 503) from None


def queue_t4t5_publication(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
) -> dict[str, object]:
    """Move a validated large job to background publication; it remains invisible until finalization."""
    with _locked_import_connection(engine, f"df-publish:{job_id}") as connection:
        if connection is None:
            raise DataFoundationError("import_job_processing", 409)
        with connection.begin():
            job = load_import_job(connection, job_id, lock=True)
            if job["submitted_by_user_id"] != actor_user_id:
                raise DataFoundationError("import_job_not_found", 404)
            if str(job["source_id"]) != T4T5_SOURCE or int(job["contract_version"]) != 1:
                raise DataFoundationError("source_contract_version_unsupported", 409)
            _lock_t4t5_source(connection)
            _ensure_no_other_active_t4t5_job(connection, except_job_id=job_id)
            state = str(job["job_state"])
            manifest = read_preview_manifest(staging_directory, str(job["stored_file_key"]))
            if manifest is None or not bool(manifest.get("canPublish")):
                raise DataFoundationError("import_job_not_validated", 409)
            prepared = connection.execute(text("""
                SELECT publication_id FROM source_publications
                WHERE source_id = :source_id AND job_id = :job_id
                  AND publication_state = 'PREPARED'
                LIMIT 1
            """), {"source_id": T4T5_SOURCE, "job_id": _uuid_bytes(job_id)}).mappings().first()
            if state == "VALIDATED":
                if prepared is not None:
                    raise DataFoundationError("import_prepared_publication_conflict", 409)
            elif state == "FAILED":
                if prepared is None:
                    raise DataFoundationError("import_job_not_validated", 409)
            elif state != "PARSING" or manifest.get("phase") != "PUBLICATION":
                raise DataFoundationError("import_job_not_validated", 409)
            committed_rows = 0
            if prepared is not None:
                committed_rows = int(connection.execute(text(
                    f"SELECT COUNT(*) FROM `{fact_table_for_contract(T4T5_SOURCE, 1)}` "
                    "WHERE publication_id = :publication_id"
                ), {"publication_id": bytes(prepared["publication_id"])}).scalar_one())
            manifest["publicationProgress"] = {
                "analyzedRowCount": 0,
                "totalExpectedRowCount": int(job["valid_row_count"] or 0),
                "writtenRowCount": committed_rows,
                "committedRowCount": committed_rows,
            }
            manifest["phase"] = "PUBLICATION"
            manifest.pop("errorCode", None)
            write_preview_manifest(staging_directory, str(job["stored_file_key"]), manifest)
            connection.execute(text("""
                UPDATE import_jobs SET job_state = 'PARSING', input_row_count = :committed_rows,
                    finished_at = NULL
                WHERE job_id = :job_id
            """), {"job_id": _uuid_bytes(job_id), "committed_rows": committed_rows})
    return {
        "jobId": job_id,
        "sourceId": T4T5_SOURCE,
        "state": "PARSING",
        "phase": "PUBLICATION",
        "inputRowCount": committed_rows,
        "analyzedRowCount": 0,
        "writtenRowCount": committed_rows,
        "committedRowCount": committed_rows,
        "validRowCount": int(job["valid_row_count"] or 0),
        "totalExpectedRowCount": int(job["valid_row_count"] or 0),
    }


def _switch_t4t5_heads_if_newer(
    connection: Connection,
    *,
    publication_id: bytes,
    version_no: int,
    summary: PreviewSummary,
) -> None:
    # Serialize this source's head updates, and never let an older job finishing
    # later move a date's current pointer backwards.
    connection.execute(text("""
        SELECT source_id FROM data_source_registry
        WHERE source_id = :source_id
    """ + _for_update_clause(connection)), {"source_id": T4T5_SOURCE}).first()
    for day_text in sorted(summary.per_date_counts):
        day = date.fromisoformat(day_text)
        current_version = connection.execute(text("""
            SELECT publication.version_no
            FROM source_daily_head AS head
            JOIN source_publications AS publication
              ON publication.source_id = head.source_id
             AND publication.publication_id = head.publication_id
            WHERE head.source_id = :source_id AND head.data_date = :data_date
        """), {"source_id": T4T5_SOURCE, "data_date": day}).scalar_one_or_none()
        if current_version is None or int(current_version) <= version_no:
            head_upsert = """
                INSERT INTO source_daily_head (source_id, data_date, publication_id)
                VALUES (:source_id, :data_date, :publication_id)
            """
            if connection.dialect.name == "sqlite":
                head_upsert += " ON CONFLICT(source_id, data_date) DO UPDATE SET publication_id = excluded.publication_id, changed_at = CURRENT_TIMESTAMP"
            else:
                head_upsert += " ON DUPLICATE KEY UPDATE publication_id = VALUES(publication_id), changed_at = CURRENT_TIMESTAMP(6)"
            connection.execute(text(head_upsert), {"source_id": T4T5_SOURCE, "data_date": day, "publication_id": publication_id})


def publish_t4t5_import_job(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
    idempotency_key: str,
    request_id: str | None,
) -> None:
    """Insert a T4/T5 publication in committed batches, then atomically expose its daily heads."""
    if not idempotency_key or len(idempotency_key) > 128:
        return
    progress_manifest: dict[str, object] | None = None
    analyzed_rows = 0
    committed_rows = 0

    def persist_progress() -> None:
        if progress_manifest is None:
            return
        progress = progress_manifest.setdefault("publicationProgress", {})
        if isinstance(progress, dict):
            progress.update({
                "analyzedRowCount": analyzed_rows,
                "writtenRowCount": committed_rows,
                "committedRowCount": committed_rows,
            })
        write_preview_manifest(staging_directory, stored_key, progress_manifest)

    with _locked_import_connection(engine, f"df-publish:{job_id}") as connection:
        if connection is None:
            return
        try:
            with connection.begin():
                job = load_import_job(connection, job_id, lock=True)
                if job["submitted_by_user_id"] != actor_user_id or str(job["source_id"]) != T4T5_SOURCE:
                    raise DataFoundationError("import_job_not_found", 404)
                if str(job["job_state"]) != "PARSING":
                    return
                stored_key = str(job["stored_file_key"])
                manifest = read_preview_manifest(staging_directory, stored_key)
                if manifest is None or manifest.get("phase") != "PUBLICATION" or not bool(manifest.get("canPublish")):
                    raise DataFoundationError("import_job_not_validated", 409)
                progress_manifest = manifest
                summary = _summary_from_preview_manifest(manifest)
                contract = get_contract(T4T5_SOURCE, 1)
                map_version_id = bytes(job["validation_map_version_id"] or b"")
                if len(map_version_id) != 16 or map_version_id != bytes(summary.map_version_id or b""):
                    raise DataFoundationError("official_mapping_changed_repreview", 409)
                file_sha256 = bytes(job["file_sha256"]).hex()
                if summary.file_sha256 != file_sha256:
                    raise DataFoundationError("import_source_hash_mismatch", 409)
                registry = _validate_contract_for_publication(connection, job)
                if current_mapping_version(connection, lock=True) != map_version_id:
                    raise DataFoundationError("official_mapping_changed_repreview", 409)
            resolver = load_mapping_resolver(connection, source_id=T4T5_SOURCE, map_version_id=map_version_id)
            connection.commit()
            staged_path = staged_workbook_path(staging_directory, stored_key)
            with connection.begin():
                existing = connection.execute(text("""
                    SELECT publication_id, version_no, publication_state, map_version_id, file_sha256,
                           row_count, period_start, period_end
                    FROM source_publications
                    WHERE source_id = :source_id AND job_id = :job_id
                    LIMIT 1
                """ + _for_update_clause(connection)), {"source_id": T4T5_SOURCE, "job_id": _uuid_bytes(job_id)}).mappings().first()
                if existing is None:
                    fingerprint = connection.execute(text("""
                        SELECT publication_id, version_no
                        FROM source_publications
                        WHERE source_id = :source_id
                          AND contract_version = 1
                          AND map_version_id = :map_version_id
                          AND file_sha256 = :file_sha256
                          AND publication_state = 'PUBLISHED'
                        LIMIT 1
                    """ + _for_update_clause(connection)), {
                        "source_id": T4T5_SOURCE,
                        "map_version_id": map_version_id,
                        "file_sha256": bytes.fromhex(file_sha256),
                    }).mappings().first()
                    if fingerprint is not None:
                        publication_id = bytes(fingerprint["publication_id"])
                        version_no = int(fingerprint["version_no"])
                        _switch_t4t5_heads_if_newer(
                            connection, publication_id=publication_id, version_no=version_no, summary=summary,
                        )
                        connection.execute(text("""
                            UPDATE import_jobs SET job_state = 'REUSED', reused_publication_id = :publication_id,
                                finished_at = CURRENT_TIMESTAMP(6)
                            WHERE job_id = :job_id
                        """), {"publication_id": publication_id, "job_id": _uuid_bytes(job_id)})
                        _write_audit(
                            connection, actor_user_id=actor_user_id, action_code="PUBLICATION_REUSED",
                            object_type="source_publication", object_id=publication_id,
                            request_id=request_id,
                            safe_context={
                                "sourceId": T4T5_SOURCE,
                                "rowCount": summary.valid_row_count,
                                "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
                            },
                        )
                        return
                    last_version = connection.execute(text("""
                        SELECT version_no FROM source_publications
                        WHERE source_id = :source_id
                        ORDER BY version_no DESC LIMIT 1
                    """ + _for_update_clause(connection)), {"source_id": T4T5_SOURCE}).scalar_one_or_none()
                    version_no = int(last_version or 0) + 1
                    publication_id = uuid.uuid4().bytes
                    dates = sorted(summary.per_date_counts)
                    connection.execute(text("""
                        INSERT INTO source_publications
                          (publication_id, source_id, version_no, job_id, contract_version,
                           map_version_id, file_sha256, publication_state, history_policy,
                           period_start, period_end, snapshot_as_of, row_count, mapped_row_count,
                           unmapped_row_count, missing_identifier_row_count, ambiguous_row_count)
                        VALUES
                          (:publication_id, :source_id, :version_no, :job_id, 1,
                           :map_version_id, :file_sha256, 'PREPARED', :history_policy,
                           :period_start, :period_end, NULL, :row_count, :mapped_row_count,
                           :unmapped_row_count, :missing_identifier_row_count, :ambiguous_row_count)
                    """), {
                        "publication_id": publication_id,
                        "source_id": T4T5_SOURCE,
                        "version_no": version_no,
                        "job_id": _uuid_bytes(job_id),
                        "map_version_id": map_version_id,
                        "file_sha256": bytes.fromhex(file_sha256),
                        "history_policy": registry["history_policy"],
                        "period_start": date.fromisoformat(dates[0]) if dates else None,
                        "period_end": date.fromisoformat(dates[-1]) if dates else None,
                        "row_count": summary.valid_row_count,
                        "mapped_row_count": summary.mapped_row_count,
                        "unmapped_row_count": summary.unmapped_row_count,
                        "missing_identifier_row_count": summary.missing_identifier_row_count,
                        "ambiguous_row_count": summary.ambiguous_row_count,
                    })
                    _write_publication_dates(connection, T4T5_SOURCE, publication_id, summary)
                else:
                    if (
                        str(existing["publication_state"]) != "PREPARED"
                        or bytes(existing["map_version_id"]) != map_version_id
                        or bytes(existing["file_sha256"]).hex() != file_sha256
                        or int(existing["row_count"]) != summary.valid_row_count
                        or str(existing["period_start"]) != (min(summary.per_date_counts) if summary.per_date_counts else "None")
                        or str(existing["period_end"]) != (max(summary.per_date_counts) if summary.per_date_counts else "None")
                    ):
                        raise DataFoundationError("import_prepared_publication_conflict", 409)
                    publication_id = bytes(existing["publication_id"])
                    version_no = int(existing["version_no"])
                    prepared_dates = {
                        str(row["data_date"]): int(row["row_count"])
                        for row in connection.execute(text("""
                            SELECT data_date, row_count FROM source_publication_dates
                            WHERE source_id = :source_id AND publication_id = :publication_id
                        """), {"source_id": T4T5_SOURCE, "publication_id": publication_id}).mappings()
                    }
                    if prepared_dates != summary.per_date_counts:
                        raise DataFoundationError("import_prepared_publication_conflict", 409)
                table = fact_table_for_contract(T4T5_SOURCE, 1)
                existing_rows = connection.execute(text(f"""
                    SELECT COALESCE(MAX(source_row_no), 0) AS max_source_row_no, COUNT(*) AS committed_row_count
                    FROM `{table}` WHERE publication_id = :publication_id
                """), {"publication_id": publication_id}).mappings().one()
                start_after_row = int(existing_rows["max_source_row_no"] or 0)
                committed_rows = int(existing_rows["committed_row_count"] or 0)
                progress = manifest.setdefault("publicationProgress", {})
                if not isinstance(progress, dict):
                    progress = {}
                    manifest["publicationProgress"] = progress
                progress.update({
                    "analyzedRowCount": 0,
                    "totalExpectedRowCount": summary.valid_row_count,
                    "writtenRowCount": committed_rows,
                    "committedRowCount": committed_rows,
                })
                connection.execute(text("""
                    UPDATE import_jobs SET input_row_count = :committed_rows
                    WHERE job_id = :job_id AND job_state = 'PARSING'
                """), {"committed_rows": committed_rows, "job_id": _uuid_bytes(job_id)})
                write_preview_manifest(staging_directory, stored_key, manifest)

            fact_columns = [
                "source_id", "publication_id", "map_version_id", "source_row_no",
                *(column.key for column in contract.columns), "resolved_base_code", "mapping_resolution",
            ]
            column_sql = ", ".join(f"`{column}`" for column in fact_columns)
            value_sql = ", ".join(f":{column}" for column in fact_columns)
            insert_statement = text(f"INSERT INTO `{table}` ({column_sql}) VALUES ({value_sql})")
            batch: list[dict[str, object]] = []

            def flush_batch() -> None:
                nonlocal committed_rows
                if not batch:
                    return
                next_committed_rows = committed_rows + len(batch)
                with connection.begin():
                    connection.execute(insert_statement, list(batch))
                    updated = connection.execute(text("""
                        UPDATE import_jobs SET input_row_count = :committed_rows
                        WHERE job_id = :job_id AND job_state = 'PARSING'
                    """), {
                        "committed_rows": next_committed_rows,
                        "job_id": _uuid_bytes(job_id),
                    })
                    if updated.rowcount != 1:
                        raise DataFoundationError("import_job_processing", 409)
                committed_rows = next_committed_rows
                batch.clear()

            def add_row(row: ValidImportRow) -> None:
                if row.source_row_no <= start_after_row:
                    return
                batch.append(_fact_row(T4T5_SOURCE, contract, publication_id, map_version_id, row))
                if len(batch) >= T4T5_FACT_BATCH_SIZE:
                    flush_batch()

            last_progress = 0

            def record_progress(rows_processed: int) -> None:
                nonlocal last_progress, analyzed_rows
                analyzed_rows = rows_processed
                if rows_processed - last_progress < T4T5_PROGRESS_INTERVAL:
                    return
                persist_progress()
                last_progress = rows_processed

            imported = parse_workbook(
                staged_path, contract, resolver, on_valid_row=add_row, on_progress=record_progress,
                expected_file_sha256=file_sha256,
            )
            analyzed_rows = imported.input_row_count
            persist_progress()
            flush_batch()
            if (
                not imported.can_publish
                or imported.file_sha256 != file_sha256
                or imported.input_row_count != summary.input_row_count
                or imported.valid_row_count != summary.valid_row_count
                or imported.invalid_row_count != summary.invalid_row_count
                or imported.exact_duplicate_count != summary.exact_duplicate_count
                or imported.per_date_counts != summary.per_date_counts
                or imported.map_version_id != map_version_id
            ):
                raise DataFoundationError("import_validation_changed", 409)

            with connection.begin():
                job = load_import_job(connection, job_id, lock=True)
                if job["submitted_by_user_id"] != actor_user_id:
                    raise DataFoundationError("import_job_not_found", 404)
                if current_mapping_version(connection, lock=True) != map_version_id:
                    raise DataFoundationError("official_mapping_changed_repreview", 409)
                actual_dates = {
                    str(row["data_date"]): int(row["row_count"])
                    for row in connection.execute(text(f"""
                        SELECT data_date, COUNT(*) AS row_count
                        FROM `{table}` WHERE publication_id = :publication_id
                        GROUP BY data_date
                    """), {"publication_id": publication_id}).mappings()
                }
                actual_count = sum(actual_dates.values())
                if actual_count != summary.valid_row_count or actual_dates != summary.per_date_counts:
                    raise DataFoundationError("import_publication_count_mismatch", 409)
                published_update = connection.execute(text("""
                    UPDATE source_publications SET publication_state = 'PUBLISHED', published_at = CURRENT_TIMESTAMP(6)
                    WHERE publication_id = :publication_id AND publication_state = 'PREPARED'
                """), {"publication_id": publication_id})
                if published_update.rowcount != 1:
                    raise DataFoundationError("import_prepared_publication_conflict", 409)
                _switch_t4t5_heads_if_newer(
                    connection, publication_id=publication_id, version_no=version_no, summary=summary,
                )
                connection.execute(text("""
                    UPDATE import_jobs SET job_state = 'PUBLISHED', input_row_count = :input_rows,
                        valid_row_count = :valid_rows, error_count = 0,
                        finished_at = CURRENT_TIMESTAMP(6)
                    WHERE job_id = :job_id
                """), {
                    "input_rows": summary.input_row_count,
                    "valid_rows": summary.valid_row_count,
                    "job_id": _uuid_bytes(job_id),
                })
                _write_audit(
                    connection, actor_user_id=actor_user_id, action_code="PUBLICATION_PUBLISHED",
                    object_type="source_publication", object_id=publication_id,
                    request_id=request_id,
                    safe_context={
                        "sourceId": T4T5_SOURCE,
                        "version": version_no,
                        "rowCount": summary.valid_row_count,
                        "mappedRowCount": summary.mapped_row_count,
                        "unmappedRowCount": summary.unmapped_row_count,
                        "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
                    },
                )
        except (DataFoundationError, WorkbookValidationError) as error:
            try:
                persist_progress()
            except DataFoundationError:
                pass
            _mark_t4t5_publication_failed(connection, job_id, actor_user_id, staging_directory, error.code)
        except Exception:
            try:
                persist_progress()
            except DataFoundationError:
                pass
            _mark_t4t5_publication_failed(
                connection, job_id, actor_user_id, staging_directory, "import_publication_failed",
            )


def _mark_t4t5_publication_failed(
    connection: Connection,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
    error_code: str,
) -> None:
    if connection.in_transaction():
        connection.rollback()
    stored_key: str | None = None
    try:
        with connection.begin():
            job = load_import_job(connection, job_id, lock=True)
            if job["submitted_by_user_id"] != actor_user_id:
                return
            if job["job_state"] in {"PUBLISHED", "REUSED"}:
                return
            stored_key = str(job["stored_file_key"])
            connection.execute(text("""
                UPDATE import_jobs SET job_state = 'FAILED', error_count = 1,
                    finished_at = CURRENT_TIMESTAMP(6)
                WHERE job_id = :job_id
            """), {"job_id": _uuid_bytes(job_id)})
        if stored_key:
            manifest = read_preview_manifest(staging_directory, stored_key) or {}
            manifest.update({"phase": "PUBLICATION", "errorCode": error_code})
            write_preview_manifest(staging_directory, stored_key, manifest)
    except Exception:
        return


def publish_initial_mapping_migration(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
    idempotency_key: str,
    request_id: str | None,
) -> dict[str, object]:
    """Publish the untouched legacy 1,628-row map as immutable version 1."""
    if not idempotency_key or len(idempotency_key) < 8 or len(idempotency_key) > 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    contract = CONTRACTS["base_mapping_official"]
    expected_count = 1628
    binary_job_id = _uuid_bytes(job_id)
    idempotency_key_hash = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        if job["source_id"] != "base_mapping_official":
            raise DataFoundationError("mapping_migration_job_not_validated", 409)
        if int(job["contract_version"]) != contract.version:
            raise DataFoundationError("source_contract_version_unsupported", 409)

        existing_version = connection.execute(text("""
            SELECT map_version_id, version_no, contract_version, version_state,
                   file_sha256, mapping_row_count
            FROM base_mapping_versions
            WHERE source_id = 'base_mapping_official' AND source_job_id = :job_id
            FOR UPDATE
        """), {"job_id": binary_job_id}).mappings().first()
        if job["job_state"] == "PUBLISHED":
            if existing_version is None:
                raise DataFoundationError("mapping_migration_state_inconsistent", 409)
            map_version_id = bytes(existing_version["map_version_id"])
            entry_count = int(connection.execute(text("""
                SELECT COUNT(*) FROM base_mapping_entries
                WHERE map_version_id = :map_version_id
            """), {"map_version_id": map_version_id}).scalar_one())
            current_version = connection.execute(text("""
                SELECT version.version_state
                FROM base_mapping_current AS current_map
                JOIN base_mapping_versions AS version
                  ON version.map_version_id = current_map.map_version_id
                WHERE current_map.current_key = 'OFFICIAL'
            """)).scalar_one_or_none()
            audit_context_value = connection.execute(text("""
                SELECT event_context
                FROM data_audit_events
                WHERE action_code = 'LEGACY_MAPPING_MIGRATED'
                  AND object_type = 'base_mapping_version'
                  AND object_id = :map_version_id
                ORDER BY audit_id DESC
                LIMIT 1
            """), {"map_version_id": map_version_id}).scalar_one_or_none()
            if isinstance(audit_context_value, bytes):
                audit_context_value = audit_context_value.decode("utf-8")
            if isinstance(audit_context_value, str):
                try:
                    audit_context_value = json.loads(audit_context_value)
                except json.JSONDecodeError:
                    audit_context_value = None
            if (
                int(existing_version["version_no"]) != 1
                or int(existing_version["contract_version"]) != contract.version
                or existing_version["version_state"] != "PUBLISHED"
                or int(existing_version["mapping_row_count"]) != expected_count
                or bytes(existing_version["file_sha256"]) != bytes(job["file_sha256"])
                or bytes(job["file_sha256"]).hex() != INITIAL_MAPPING_WORKBOOK_SHA256
                or entry_count != expected_count
                or current_version != "PUBLISHED"
                or not isinstance(audit_context_value, dict)
                or audit_context_value.get("idempotencyKeySha256") != idempotency_key_hash
            ):
                raise DataFoundationError("mapping_migration_idempotency_conflict", 409)
            return {
                "mapVersionId": str(uuid.UUID(bytes=map_version_id)),
                "version": 1,
                "mappingRowCount": expected_count,
                "reused": True,
            }
        if job["job_state"] != "VALIDATED":
            raise DataFoundationError("mapping_migration_job_not_validated", 409)

        registration = connection.execute(text("""
            SELECT registry.source_state, contract.contract_state,
                   contract.expected_sheet, contract.header_row, contract.contract_sha256
            FROM data_source_registry AS registry
            JOIN source_contract_versions AS contract
              ON contract.source_id = registry.source_id
            WHERE registry.source_id = 'base_mapping_official'
              AND contract.contract_version = :contract_version
            FOR UPDATE
        """), {"contract_version": contract.version}).mappings().first()
        if registration is None or registration["source_state"] != "ACTIVE":
            raise DataFoundationError("base_mapping_source_not_active", 409)
        if registration["contract_state"] != "APPROVED":
            raise DataFoundationError("base_mapping_contract_not_approved", 409)
        if registration["contract_sha256"] is None or bytes(registration["contract_sha256"]) != contract_sha256(contract):
            raise DataFoundationError("base_mapping_contract_mismatch", 409)
        if registration["expected_sheet"] != "Ativas" or int(registration["header_row"] or 0) != 1:
            raise DataFoundationError("base_mapping_contract_mismatch", 409)
        if connection.execute(text("SELECT 1 FROM base_mapping_current LIMIT 1")).first():
            raise DataFoundationError("base_mapping_migration_already_initialized", 409)
        if connection.execute(text("SELECT 1 FROM base_mapping_versions LIMIT 1")).first():
            raise DataFoundationError("base_mapping_version_exists", 409)

        content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
        if bytes(job["file_sha256"]).hex() != hashlib.sha256(content).hexdigest():
            raise DataFoundationError("mapping_source_hash_mismatch", 409)
        if hashlib.sha256(content).hexdigest() != INITIAL_MAPPING_WORKBOOK_SHA256:
            raise DataFoundationError("legacy_mapping_source_hash_not_reviewed", 409)
        summary = parse_workbook(content, contract)
        if (
            summary.input_row_count != expected_count
            or summary.valid_row_count != expected_count
            or summary.invalid_row_count
            or summary.duplicate_base_code_count
        ):
            raise DataFoundationError("legacy_mapping_1628_rows_required", 422)

        map_version_id = uuid.uuid4().bytes
        connection.execute(text("""
            INSERT INTO base_mapping_versions
              (map_version_id, version_no, source_id, source_job_id, contract_version,
               version_state, original_file_name, file_sha256, mapping_row_count,
               published_by_user_id, published_at)
            VALUES
              (:map_version_id, 1, 'base_mapping_official', :job_id, :contract_version,
               'PREPARED', :file_name, :file_sha256, :row_count,
               :actor_user_id, CURRENT_TIMESTAMP(6))
        """), {
            "map_version_id": map_version_id,
            "job_id": binary_job_id,
            "contract_version": contract.version,
            "file_name": str(job["original_file_name"])[:255],
            "file_sha256": bytes(job["file_sha256"]),
            "row_count": expected_count,
            "actor_user_id": actor_user_id,
        })
        columns = [
            "map_version_id", "base_code", "base_name", "regional_name", "uf_code",
            "rm_region", "rm_responsible", "base_description", "source_row_no",
        ]
        statement = text(
            "INSERT INTO base_mapping_entries (" + ", ".join(f"`{column}`" for column in columns) + ") VALUES ("
            + ", ".join(f":{column}" for column in columns) + ")"
        )
        batch: list[dict[str, object]] = []

        def add_entry(row: ValidImportRow) -> None:
            batch.append({
                "map_version_id": map_version_id,
                "base_code": row.values["base_code"],
                "base_name": row.values["base_name"],
                "regional_name": row.values["regional_name"],
                "uf_code": row.values["uf_code"],
                "rm_region": row.values["rm_region"],
                "rm_responsible": row.values["rm_responsible"],
                "base_description": row.values["base_description"],
                "source_row_no": row.source_row_no,
            })
            if len(batch) >= FACT_BATCH_SIZE:
                connection.execute(statement, batch)
                batch.clear()

        final_check = parse_workbook(content, contract, on_valid_row=add_entry)
        if (
            final_check.input_row_count != expected_count
            or final_check.valid_row_count != expected_count
            or final_check.invalid_row_count
            or final_check.duplicate_base_code_count
        ):
            raise DataFoundationError("mapping_migration_validation_changed", 409)
        if batch:
            connection.execute(statement, batch)
        inserted_count = connection.execute(text("""
            SELECT COUNT(*) FROM base_mapping_entries
            WHERE map_version_id = :map_version_id
        """), {"map_version_id": map_version_id}).scalar_one()
        if int(inserted_count) != expected_count:
            raise DataFoundationError("mapping_entry_count_mismatch", 409)
        connection.execute(text("""
            UPDATE base_mapping_versions
            SET version_state = 'PUBLISHED'
            WHERE map_version_id = :map_version_id
        """), {"map_version_id": map_version_id})
        connection.execute(text("""
            INSERT INTO base_mapping_current (current_key, map_version_id, changed_by_user_id)
            VALUES ('OFFICIAL', :map_version_id, :actor_user_id)
        """), {"map_version_id": map_version_id, "actor_user_id": actor_user_id})
        connection.execute(text("""
            UPDATE import_jobs
            SET job_state = 'PUBLISHED', finished_at = CURRENT_TIMESTAMP(6)
            WHERE job_id = :job_id
        """), {"job_id": binary_job_id})
        _write_audit(
            connection,
            actor_user_id=actor_user_id,
            action_code="LEGACY_MAPPING_MIGRATED",
            object_type="base_mapping_version",
            object_id=map_version_id,
            request_id=request_id,
            safe_context={
                "version": 1,
                "mappingRows": expected_count,
                "originalPreserved": True,
                "idempotencyKeySha256": idempotency_key_hash,
            },
        )
        return {
            "mapVersionId": str(uuid.UUID(bytes=map_version_id)),
            "version": 1,
            "mappingRowCount": expected_count,
            "reused": False,
        }


def get_job_status(
    engine: Engine,
    job_id: str,
    actor_user_id: int | None,
    *,
    actor_service_principal_id: str | None = None,
    staging_directory: Path | None = None,
) -> dict[str, object]:
    if (actor_user_id is None) == (actor_service_principal_id is None):
        raise DataFoundationError("import_actor_invalid", 403)
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if actor_service_principal_id:
            owns_job = job.get("submitted_by_service_principal_id") == actor_service_principal_id
        else:
            owns_job = job["submitted_by_user_id"] == actor_user_id
        if not owns_job:
            raise DataFoundationError("import_job_not_found", 404)
        errors = list(connection.execute(text("""
            SELECT source_row_no, column_key, error_code
            FROM import_job_errors
            WHERE job_id = :job_id
            ORDER BY source_row_no, error_id
            LIMIT 1000
        """), {"job_id": _uuid_bytes(job_id)}).mappings())
        result: dict[str, object] = {
            "jobId": job_id,
            "sourceId": str(job["source_id"]),
            "contractVersion": int(job["contract_version"]),
            "state": str(job["job_state"]),
            "inputRowCount": int(job["input_row_count"] or 0),
            "validRowCount": int(job["valid_row_count"] or 0),
            "errorCount": int(job["error_count"] or 0),
            "errors": [
                {"rowNumber": error["source_row_no"], "column": error["column_key"], "code": error["error_code"]}
                for error in errors
            ],
        }
        if str(job["source_id"]) == T4T5_SOURCE and staging_directory is not None:
            manifest = read_preview_manifest(staging_directory, str(job["stored_file_key"]))
            if manifest is not None:
                result["phase"] = manifest.get("phase")
                if manifest.get("errorCode"):
                    result["errorCode"] = manifest["errorCode"]
                if str(job["job_state"]) in {"VALIDATED", "INVALID", "FAILED"}:
                    result.update(manifest)
                    result["jobId"] = job_id
                    result["state"] = str(job["job_state"])
                elif str(job["job_state"]) in {"PUBLISHED", "REUSED"}:
                    result["canPublish"] = False
                if str(job["job_state"]) in {"PUBLISHED", "REUSED"}:
                    publication_id = bytes(job["reused_publication_id"] or b"")
                    if not publication_id:
                        publication_id = bytes(connection.execute(text("""
                            SELECT publication_id FROM source_publications
                            WHERE source_id = :source_id AND job_id = :job_id
                            LIMIT 1
                        """), {"source_id": T4T5_SOURCE, "job_id": _uuid_bytes(job_id)}).scalar_one_or_none() or b"")
                    if publication_id:
                        publication = connection.execute(text("""
                            SELECT publication_id, version_no, publication_state
                            FROM source_publications WHERE publication_id = :publication_id
                        """), {"publication_id": publication_id}).mappings().first()
                        if publication is not None:
                            result.update({
                                "publicationId": str(uuid.UUID(bytes=bytes(publication["publication_id"]))),
                                "version": int(publication["version_no"]),
                                "reused": str(job["job_state"]) == "REUSED",
                            })
            phase = result.get("phase")
            if phase == "PUBLICATION":
                progress = manifest.get("publicationProgress") if manifest is not None else None
                if not isinstance(progress, dict):
                    progress = {}
                result.update({
                    "analyzedRowCount": int(progress.get("analyzedRowCount") or 0),
                    "writtenRowCount": int(job["input_row_count"] or 0),
                    "committedRowCount": int(job["input_row_count"] or 0),
                    "totalExpectedRowCount": int(job["valid_row_count"] or progress.get("totalExpectedRowCount") or 0),
                })
            else:
                result.update({
                    "analyzedRowCount": int(job["input_row_count"] or 0),
                    "writtenRowCount": 0,
                    "committedRowCount": 0,
                    "totalExpectedRowCount": int(job["valid_row_count"] or 0),
                })
        return result


def validate_job_again(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int | None,
    actor_service_principal_id: str | None = None,
    staging_directory: Path,
) -> dict[str, object]:
    if (actor_user_id is None) == (actor_service_principal_id is None):
        raise DataFoundationError("import_actor_invalid", 403)
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if actor_service_principal_id:
            owns_job = job.get("submitted_by_service_principal_id") == actor_service_principal_id
        else:
            owns_job = job["submitted_by_user_id"] == actor_user_id
        if not owns_job:
            raise DataFoundationError("import_job_not_found", 404)
        source_id = str(job["source_id"])
        if source_id == "base_mapping_official" and int(job["contract_version"]) >= 2:
            raise DataFoundationError("mapping_candidate_repreview_required", 409)
        try:
            contract = get_contract(source_id, int(job["contract_version"]))
        except KeyError:
            raise DataFoundationError("source_contract_version_unsupported", 409)
        resolver = MappingResolver() if source_id == "base_mapping_official" else load_mapping_resolver(
            connection, source_id=source_id
        )
    content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
    manual_export_confirmation = None
    preview_manifest = read_preview_manifest(staging_directory, str(job["stored_file_key"])) or {}
    if source_id == "no_movement" and preview_manifest.get("exportMetadataSource") == "ADMIN_CONFIRMATION":
        try:
            confirmer = int(preview_manifest["exportMetadataConfirmedByUserId"])
            if confirmer != actor_user_id:
                raise ValueError("confirmation actor changed")
            manual_export_confirmation = {
                "export_date": date.fromisoformat(str(preview_manifest["collectionDate"])),
                "export_time": datetime.fromisoformat(str(preview_manifest["botExecutedAt"])),
                "confirmed_at": datetime.fromisoformat(str(preview_manifest["exportMetadataConfirmedAt"])),
                "user_id": confirmer,
            }
        except (KeyError, TypeError, ValueError):
            raise DataFoundationError("no_movement_export_confirmation_invalid", 409) from None
    summary = parse_workbook(content, contract, resolver, manual_export_confirmation=manual_export_confirmation)
    if summary.file_sha256 != bytes(job["file_sha256"]).hex():
        raise DataFoundationError("import_source_hash_mismatch", 409)
    summary.map_version_id = resolver.map_version_id
    write_preview_manifest(staging_directory, str(job["stored_file_key"]), summary.as_api_dict())
    with engine.begin() as connection:
        connection.execute(text("""
            DELETE FROM import_job_errors WHERE job_id = :job_id
        """), {"job_id": _uuid_bytes(job_id)})
        owner_predicate = (
            "submitted_by_service_principal_id = :service_principal_id"
            if actor_service_principal_id else "submitted_by_user_id = :actor_user_id"
        )
        connection.execute(text(f"""
            UPDATE import_jobs
            SET validation_map_version_id = :map_version_id,
                job_state = :job_state, input_row_count = :input_rows,
                valid_row_count = :valid_rows, error_count = :error_count,
                validated_at = CURRENT_TIMESTAMP(6)
            WHERE job_id = :job_id AND {owner_predicate}
        """), {
            "map_version_id": resolver.map_version_id,
            "job_state": "VALIDATED" if summary.can_publish else "INVALID",
            "input_rows": summary.input_row_count,
            "valid_rows": summary.valid_row_count,
            "error_count": sum(summary.error_counts.values()),
            "job_id": _uuid_bytes(job_id),
            "actor_user_id": actor_user_id,
            "service_principal_id": actor_service_principal_id,
        })
        _insert_errors(connection, _uuid_bytes(job_id), summary)
    return {"jobId": job_id, **summary.as_api_dict()}
