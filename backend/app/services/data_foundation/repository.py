from __future__ import annotations

import json
import hashlib
import uuid
from collections import Counter
from datetime import date
from pathlib import Path

from sqlalchemy import Engine, text
from sqlalchemy.engine import Connection, RowMapping

from app.services.data_foundation.contracts import (
    CONTRACTS,
    INITIAL_MAPPING_WORKBOOK_SHA256,
    SourceContract,
    contract_sha256,
)
from app.services.data_foundation.xlsx_parser import (
    MappingResolver,
    PreviewSummary,
    ValidImportRow,
    WorkbookValidationError,
    parse_workbook,
)


FACT_TABLES = {
    "collection_monitoring": "fact_collection_monitoring",
    "collection_rate": "fact_collection_rate",
    "jt_monitoring": "fact_jt_monitoring",
    "no_movement": "fact_no_movement_snapshot",
    "pdd_collection_failure": "fact_pdd_collection_failure",
}
DAILY_SOURCES = frozenset({
    "collection_monitoring", "collection_rate", "jt_monitoring", "pdd_collection_failure",
})
NAME_MAPPED_SOURCES = frozenset({"collection_monitoring", "collection_rate", "jt_monitoring"})
FACT_BATCH_SIZE = 1000


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


def current_mapping_version(connection: Connection, *, lock: bool = False) -> bytes | None:
    statement = """
        SELECT map_pointer.map_version_id
        FROM base_mapping_current AS map_pointer
        JOIN base_mapping_versions AS version
          ON version.map_version_id = map_pointer.map_version_id
        WHERE version.version_state = 'PUBLISHED'
        LIMIT 1
    """ + (" FOR UPDATE" if lock else "")
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
    for code, name in mapping_rows:
        code_text = str(code)
        codes.add(code_text)
        exact_names.setdefault(str(name), []).append(code_text)
    decisions: dict[str, tuple[str, str | None]] = {}
    if source_id in NAME_MAPPED_SOURCES:
        for name, state, target in connection.execute(text("""
            SELECT source_base_name, resolution_state, target_base_code
            FROM base_mapping_name_decisions
            WHERE map_version_id = :map_version_id AND source_id = :source_id
        """), {"map_version_id": version_id, "source_id": source_id}):
            decisions[str(name)] = (str(state), str(target) if target is not None else None)
    return MappingResolver(
        map_version_id=version_id,
        base_codes=frozenset(codes),
        exact_base_name_candidates={
            name: tuple(candidate_codes) for name, candidate_codes in exact_names.items()
        },
        name_decisions=decisions,
    )


def get_name_mapping_candidates(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
) -> dict[str, object]:
    """List exact name candidates from one validated upload without approving them."""
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if job["submitted_by_user_id"] != actor_user_id:
            raise DataFoundationError("import_job_not_found", 404)
        source_id = str(job["source_id"])
        if source_id not in NAME_MAPPED_SOURCES:
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
    contract = CONTRACTS[source_id]

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
        decision = resolver.name_decisions.get(source_name)
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
            "decisionState": decision[0] if decision else "UNREVIEWED",
            "approvedTargetBaseCode": decision[1] if decision else None,
        })
    return {
        "jobId": job_id,
        "sourceId": source_id,
        "mappingVersionId": str(uuid.UUID(bytes=map_version_id)),
        "candidates": candidates,
        "candidateNameCount": sum(bool(item["exactTargetCandidates"]) for item in candidates),
        "unmatchedNameCount": sum(not item["exactTargetCandidates"] for item in candidates),
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
        if len(candidate_codes) != 1 or target_base_code != candidate_codes[0]:
            raise DataFoundationError("mapping_target_must_be_unique_exact_match", 422)
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
    actor_user_id: int,
    file_name: str,
    file_size: int,
    stored_file_key: str,
    summary: PreviewSummary,
    request_id: str | None,
) -> str:
    contract = CONTRACTS[source_id]
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
        connection.execute(text("""
            INSERT INTO import_jobs
              (job_id, source_id, contract_version, validation_map_version_id,
               submitted_by_user_id, job_state, original_file_name, stored_file_key,
               file_size_bytes, file_sha256, input_row_count, valid_row_count,
               error_count, request_id, validated_at)
            VALUES
              (:job_id, :source_id, :contract_version, :map_version_id,
               :actor_user_id, :job_state, :file_name, :stored_file_key,
               :file_size, :file_sha256, :input_rows, :valid_rows,
               :error_count, :request_id, CURRENT_TIMESTAMP(6))
        """), {
            "job_id": job_id.bytes,
            "source_id": source_id,
            "contract_version": contract.version,
            "map_version_id": summary_map_version(summary),
            "actor_user_id": actor_user_id,
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


def summary_map_version(summary: PreviewSummary) -> bytes | None:
    return summary.map_version_id


def load_import_job(connection: Connection, job_id: str, *, lock: bool = False) -> RowMapping:
    statement = """
        SELECT job_id, source_id, contract_version, validation_map_version_id,
               job_state, original_file_name, stored_file_key, file_size_bytes,
               file_sha256, input_row_count, valid_row_count, error_count,
               submitted_by_user_id
        FROM import_jobs
        WHERE job_id = :job_id
    """ + (" FOR UPDATE" if lock else "")
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
        FOR UPDATE
    """), {
        "source_id": job["source_id"],
        "contract_version": job["contract_version"],
    }).mappings().first()
    if row is None or row["source_state"] != "ACTIVE":
        raise DataFoundationError("data_source_not_active", 409)
    if row["contract_state"] != "APPROVED":
        raise DataFoundationError("source_contract_not_approved", 409)
    if row["contract_sha256"] is None or bytes(row["contract_sha256"]) != contract_sha256(CONTRACTS[str(job["source_id"])]):
        raise DataFoundationError("source_contract_definition_mismatch", 409)
    if row["history_policy"] not in {"DAILY_REPLACE_DATES", "SNAPSHOT_REPLACE_ALL"}:
        raise DataFoundationError("source_history_policy_not_approved", 409)
    expected_policy = CONTRACTS[str(job["source_id"])].history_policy
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
    values: dict[str, object] = {
        "source_id": source_id,
        "publication_id": publication_id,
        "map_version_id": map_version_id,
        "source_row_no": row.source_row_no,
        "resolved_base_code": row.resolved_base_code,
        "mapping_resolution": row.mapping_resolution,
    }
    values.update(row.values)
    return values


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
    table = FACT_TABLES[source_id]
    fact_columns = [
        "source_id", "publication_id", "map_version_id", "source_row_no",
        *(column.key for column in contract.columns), "resolved_base_code", "mapping_resolution",
    ]
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
    actor_user_id: int,
    action_code: str,
    object_type: str,
    object_id: bytes,
    request_id: str | None,
    safe_context: dict[str, object],
) -> None:
    connection.execute(text("""
        INSERT INTO data_audit_events
          (actor_user_id, action_code, object_type, object_id, request_id, event_context)
        VALUES
          (:actor_user_id, :action_code, :object_type, :object_id, :request_id, :event_context)
    """), {
        "actor_user_id": actor_user_id,
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
    actor_user_id: int,
    staging_directory: Path,
    idempotency_key: str,
    request_id: str | None,
) -> dict[str, object]:
    if not idempotency_key or len(idempotency_key) > 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    binary_job_id = _uuid_bytes(job_id)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        if job["submitted_by_user_id"] != actor_user_id and job["job_state"] not in {"VALIDATED", "PUBLISHED", "REUSED"}:
            raise DataFoundationError("import_job_not_publishable", 409)
        if job["job_state"] not in {"VALIDATED", "PUBLISHED", "REUSED"}:
            raise DataFoundationError("import_job_not_validated", 409)
        source_id = str(job["source_id"])
        contract = CONTRACTS.get(source_id)
        if contract is None or int(job["contract_version"]) != contract.version:
            raise DataFoundationError("source_contract_version_unsupported", 409)
        registry = _validate_contract_for_publication(connection, job)
        map_version_id = bytes(job["validation_map_version_id"] or b"")
        if len(map_version_id) != 16:
            raise DataFoundationError("official_mapping_unavailable", 409)
        if current_mapping_version(connection, lock=True) != map_version_id:
            raise DataFoundationError("official_mapping_changed_repreview", 409)
        resolver = load_mapping_resolver(connection, source_id=source_id, map_version_id=map_version_id)
        content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
        summary = parse_workbook(content, contract, resolver)
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
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, version_no, job_id, contract_version,
               map_version_id, file_sha256, publication_state, history_policy,
               period_start, period_end, snapshot_as_of, row_count, mapped_row_count,
               unmapped_row_count, missing_identifier_row_count, ambiguous_row_count)
            VALUES
              (:publication_id, :source_id, :version_no, :job_id, :contract_version,
               :map_version_id, :file_sha256, 'PREPARED', :history_policy,
               :period_start, :period_end, NULL, :row_count, :mapped_row_count,
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
                "idempotencyKeySha256": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
            },
        )
        return {"publicationId": str(publication_uuid), "version": next_version, "reused": False}


def publish_initial_mapping_migration(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
    request_id: str | None,
) -> dict[str, object]:
    """Publish the untouched legacy 1,628-row map as immutable version 1."""
    contract = CONTRACTS["base_mapping_official"]
    expected_count = 1628
    binary_job_id = _uuid_bytes(job_id)
    with engine.begin() as connection:
        job = load_import_job(connection, job_id, lock=True)
        if job["source_id"] != "base_mapping_official" or job["job_state"] != "VALIDATED":
            raise DataFoundationError("mapping_migration_job_not_validated", 409)
        if int(job["contract_version"]) != contract.version:
            raise DataFoundationError("source_contract_version_unsupported", 409)

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
        if final_check.valid_row_count != expected_count or final_check.invalid_row_count:
            raise DataFoundationError("mapping_migration_validation_changed", 409)
        if batch:
            connection.execute(statement, batch)
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
            safe_context={"version": 1, "mappingRows": expected_count, "originalPreserved": True},
        )
        return {"mapVersionId": str(uuid.UUID(bytes=map_version_id)), "version": 1, "mappingRowCount": expected_count}


def get_job_status(engine: Engine, job_id: str, actor_user_id: int) -> dict[str, object]:
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if job["submitted_by_user_id"] != actor_user_id:
            raise DataFoundationError("import_job_not_found", 404)
        errors = list(connection.execute(text("""
            SELECT source_row_no, column_key, error_code
            FROM import_job_errors
            WHERE job_id = :job_id
            ORDER BY source_row_no, error_id
            LIMIT 1000
        """), {"job_id": _uuid_bytes(job_id)}).mappings())
        return {
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


def validate_job_again(
    engine: Engine,
    *,
    job_id: str,
    actor_user_id: int,
    staging_directory: Path,
) -> dict[str, object]:
    with engine.connect() as connection:
        job = load_import_job(connection, job_id)
        if job["submitted_by_user_id"] != actor_user_id:
            raise DataFoundationError("import_job_not_found", 404)
        source_id = str(job["source_id"])
        contract = CONTRACTS.get(source_id)
        if contract is None or int(job["contract_version"]) != contract.version:
            raise DataFoundationError("source_contract_version_unsupported", 409)
        resolver = MappingResolver() if source_id == "base_mapping_official" else load_mapping_resolver(
            connection, source_id=source_id
        )
    content = read_staged_workbook(staging_directory, str(job["stored_file_key"]))
    summary = parse_workbook(content, contract, resolver)
    if summary.file_sha256 != bytes(job["file_sha256"]).hex():
        raise DataFoundationError("import_source_hash_mismatch", 409)
    summary.map_version_id = resolver.map_version_id
    with engine.begin() as connection:
        connection.execute(text("""
            DELETE FROM import_job_errors WHERE job_id = :job_id
        """), {"job_id": _uuid_bytes(job_id)})
        connection.execute(text("""
            UPDATE import_jobs
            SET validation_map_version_id = :map_version_id,
                job_state = :job_state, input_row_count = :input_rows,
                valid_row_count = :valid_rows, error_count = :error_count,
                validated_at = CURRENT_TIMESTAMP(6)
            WHERE job_id = :job_id AND submitted_by_user_id = :actor_user_id
        """), {
            "map_version_id": resolver.map_version_id,
            "job_state": "VALIDATED" if summary.can_publish else "INVALID",
            "input_rows": summary.input_row_count,
            "valid_rows": summary.valid_row_count,
            "error_count": sum(summary.error_counts.values()),
            "job_id": _uuid_bytes(job_id),
            "actor_user_id": actor_user_id,
        })
        _insert_errors(connection, _uuid_bytes(job_id), summary)
    return {"jobId": job_id, **summary.as_api_dict()}
