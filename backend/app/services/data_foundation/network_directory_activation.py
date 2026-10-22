"""Transactional publication and controlled rollback for the DoomsDay V2 map."""
from __future__ import annotations

import hashlib
import json
import uuid

from sqlalchemy import Engine, inspect, text

from app.services.data_foundation.contracts import NETWORK_DIRECTORY_CONTRACT, contract_sha256
from app.services.data_foundation.repository import DataFoundationError, _for_update_clause, _write_audit

EXPECTED_CANDIDATE_VERSION = 2
EXPECTED_CANDIDATE_ROWS = 1783
EXPECTED_LEGACY_ROWS = 1628
OPERATIONAL_TYPES = {"OWN", "FRANCHISE"}
UNIT_TYPES = {"OWN", "FRANCHISE", "PA", "DC", "SC"}
NAME_MAPPED_SOURCES = ("collection_monitoring", "collection_rate", "jt_monitoring")


def _json_object(value: object) -> dict:
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def _uuid_text(value: object) -> str:
    return str(uuid.UUID(bytes=bytes(value)))


def _table_schema_ready(connection) -> bool:
    schema = inspect(connection)
    try:
        tables = set(schema.get_table_names())
        required = {
            "base_mapping_versions": {"candidate_metadata", "published_by_user_id", "published_at", "source_job_id", "version_no"},
            "base_mapping_entries": {"unit_metadata", "base_code", "base_name", "regional_name", "rm_region", "rm_responsible"},
            "base_mapping_current": {"changed_at", "changed_by_user_id"},
            "data_source_registry": {"source_state", "history_policy"},
            "source_contract_versions": {"contract_state", "contract_sha256", "history_policy"},
            "source_contract_columns": {"column_key", "ordinal_position", "source_header", "semantic_role", "data_type", "is_required", "is_nullable"},
            "base_mapping_name_decisions": {"source_id", "source_base_name", "resolution_state", "target_base_code", "reviewed_by_user_id", "reviewed_at", "review_note"},
            "import_jobs": {"source_id", "contract_version", "validation_map_version_id", "job_state", "file_sha256", "input_row_count", "valid_row_count", "error_count", "finished_at"},
            "data_audit_events": {"actor_user_id", "action_code", "object_type", "object_id", "request_id", "event_context"},
        }
        if not set(required).issubset(tables):
            return False
        for table, expected in required.items():
            actual = {column["name"] for column in schema.get_columns(table)}
            if not expected.issubset(actual):
                return False
        version_columns = {column["name"]: column for column in schema.get_columns("base_mapping_versions")}
        return bool(version_columns["published_by_user_id"].get("nullable", False))
    except Exception:
        return False


def _unit_metadata_stats(connection, map_id: bytes, *, lock: bool = False) -> tuple[int, list[dict[str, object]]]:
    valid_count = 0
    invalid: list[dict[str, object]] = []
    result = connection.execute(text("""
        SELECT base_code,base_name,regional_name,rm_region,rm_responsible,unit_metadata
        FROM base_mapping_entries WHERE map_version_id=:map_id
    """ + (_for_update_clause(connection) if lock else "")), {"map_id": map_id}).mappings()
    for index, row in enumerate(result, start=1):
        metadata = _json_object(row["unit_metadata"])
        unit_type = metadata.get("unit_type")
        state = metadata.get("enabled_state")
        expected_operational = unit_type in OPERATIONAL_TYPES
        core_fields_match = all(metadata.get(key) == row[key] for key in
                                ("base_code", "base_name", "regional_name", "rm_region", "rm_responsible"))
        if (not metadata or unit_type not in UNIT_TYPES or state != "ENABLED"
                or metadata.get("is_operational_base") is not expected_operational or not core_fields_match):
            invalid.append({"row": index, "unitType": unit_type, "enabledState": state})
        else:
            valid_count += 1
    return valid_count, invalid


def _contract_columns_valid(connection, *, lock: bool = False) -> bool:
    registered = connection.execute(text("""
        SELECT column_key, ordinal_position, source_header, semantic_role, data_type,
               is_required, is_nullable
        FROM source_contract_columns
        WHERE source_id='base_mapping_official' AND contract_version=:version
        ORDER BY ordinal_position
    """ + (_for_update_clause(connection) if lock else "")),
        {"version": NETWORK_DIRECTORY_CONTRACT.version}).mappings().all()
    if len(registered) != len(NETWORK_DIRECTORY_CONTRACT.columns):
        return False
    for ordinal, (row, column) in enumerate(zip(registered, NETWORK_DIRECTORY_CONTRACT.columns), start=1):
        if (row["column_key"] != column.key or int(row["ordinal_position"]) != ordinal
                or row["source_header"] != column.header or row["semantic_role"] != column.key
                or row["data_type"] != column.kind or not bool(row["is_required"])
                or bool(row["is_nullable"]) != column.nullable):
            return False
    return True


def _decision_plan(connection, previous_map_id: bytes, candidate_map_id: bytes, *, lock: bool = False) -> tuple[list[dict], list[dict]]:
    previous = [dict(row) for row in connection.execute(text("""
        SELECT source_id, source_base_name, resolution_state, target_base_code,
               reviewed_by_user_id, reviewed_at, review_note
        FROM base_mapping_name_decisions
        WHERE map_version_id=:map_id
        ORDER BY source_id, source_base_name
    """ + (_for_update_clause(connection) if lock else "")), {"map_id": previous_map_id}).mappings()]
    candidate = [dict(row) for row in connection.execute(text("""
        SELECT source_id, source_base_name, resolution_state, target_base_code,
               reviewed_by_user_id, reviewed_at, review_note
        FROM base_mapping_name_decisions
        WHERE map_version_id=:map_id
        ORDER BY source_id, source_base_name
    """ + (_for_update_clause(connection) if lock else "")), {"map_id": candidate_map_id}).mappings()]
    return previous, candidate


def _candidate_state(connection, engine: Engine, *, lock: bool = False) -> dict[str, object]:
    if not _table_schema_ready(connection):
        raise DataFoundationError("mapping_activation_schema_not_ready", 409)

    registration = connection.execute(text("""
        SELECT registry.source_state, registry.history_policy AS registry_history_policy,
               contract.contract_state, contract.contract_sha256, contract.history_policy AS contract_history_policy
        FROM data_source_registry AS registry
        LEFT JOIN source_contract_versions AS contract ON contract.source_id=registry.source_id
          AND contract.contract_version=:version
        WHERE registry.source_id='base_mapping_official'
    """ + (_for_update_clause(connection) if lock else "")), {"version": NETWORK_DIRECTORY_CONTRACT.version}).mappings().first()
    blockers: list[str] = []
    if registration is None:
        blockers.append("source_contract_not_registered")
    else:
        if registration["source_state"] != "ACTIVE":
            blockers.append("base_mapping_source_not_active")
        if registration["registry_history_policy"] != "PENDING":
            blockers.append("base_mapping_history_policy_changed")
        if registration["contract_state"] not in {"DISCOVERED", "APPROVED"}:
            blockers.append("source_contract_not_approvable")
        if registration["contract_history_policy"] != NETWORK_DIRECTORY_CONTRACT.history_policy:
            blockers.append("source_contract_policy_mismatch")
        if bytes(registration["contract_sha256"] or b"") != contract_sha256(NETWORK_DIRECTORY_CONTRACT):
            blockers.append("source_contract_definition_mismatch")
        if not _contract_columns_valid(connection, lock=lock):
            blockers.append("source_contract_columns_mismatch")

    pointer = connection.execute(text("""
        SELECT current_map.map_version_id, current_version.version_no,
               current_version.version_state, current_version.mapping_row_count
        FROM base_mapping_current AS current_map
        JOIN base_mapping_versions AS current_version
          ON current_version.map_version_id=current_map.map_version_id
        WHERE current_map.current_key='OFFICIAL'
    """ + (_for_update_clause(connection) if lock else ""))).mappings().first()
    if pointer is None or pointer["version_state"] != "PUBLISHED":
        raise DataFoundationError("official_mapping_unavailable", 503)
    official_id = bytes(pointer["map_version_id"])
    official_version = int(pointer["version_no"])

    candidate = connection.execute(text("""
        SELECT map_version_id, version_no, source_job_id, contract_version, version_state,
               mapping_row_count, file_sha256, candidate_metadata, published_by_user_id
        FROM base_mapping_versions
        WHERE source_id='base_mapping_official' AND version_no=:version
    """ + (_for_update_clause(connection) if lock else "")), {"version": EXPECTED_CANDIDATE_VERSION}).mappings().first()
    if candidate is None:
        return {
            "officialMapVersionId": _uuid_text(official_id), "officialVersion": official_version,
            "candidate": None, "canPublish": False, "canRollback": False,
            "blockers": ["candidate_not_found"],
        }

    map_id = bytes(candidate["map_version_id"])
    metadata = _json_object(candidate["candidate_metadata"])
    metadata_count, invalid_metadata = _unit_metadata_stats(connection, map_id, lock=lock)
    entry_count = metadata_count + len(invalid_metadata)
    job = connection.execute(text("""
        SELECT source_id, contract_version, validation_map_version_id, job_state,
               file_sha256, input_row_count, valid_row_count, error_count
        FROM import_jobs WHERE job_id=:job_id
    """ + (_for_update_clause(connection) if lock else "")),
        {"job_id": candidate["source_job_id"]}).mappings().first()
    if int(candidate["version_no"]) != EXPECTED_CANDIDATE_VERSION or int(candidate["contract_version"]) != NETWORK_DIRECTORY_CONTRACT.version:
        blockers.append("candidate_version_mismatch")
    if candidate["version_state"] not in {"PREPARED", "PUBLISHED"}:
        blockers.append("candidate_not_prepared")
    if int(candidate["mapping_row_count"] or 0) != EXPECTED_CANDIDATE_ROWS or entry_count != EXPECTED_CANDIDATE_ROWS:
        blockers.append("candidate_row_count_mismatch")
    if metadata_count != EXPECTED_CANDIDATE_ROWS or invalid_metadata:
        blockers.append("candidate_unit_metadata_invalid")
    if not isinstance(candidate["file_sha256"], (bytes, bytearray)) or len(bytes(candidate["file_sha256"])) != 32:
        blockers.append("candidate_file_hash_invalid")
    if metadata.get("approvalState") != "PENDING" and candidate["version_state"] == "PREPARED":
        blockers.append("candidate_metadata_state_invalid")
    review_sha = metadata.get("reviewSha256")
    if (not isinstance(review_sha, str) or len(review_sha) != 64
            or any(char not in "0123456789abcdefABCDEF" for char in review_sha)):
        blockers.append("candidate_review_hash_invalid")
    expected_job_states = {"VALIDATED"} if candidate["version_state"] == "PREPARED" else {"PUBLISHED"}
    if job is None or (job["source_id"] != "base_mapping_official"
                       or int(job["contract_version"]) != NETWORK_DIRECTORY_CONTRACT.version
                       or job["job_state"] not in expected_job_states
                       or bytes(job["file_sha256"] or b"") != bytes(candidate["file_sha256"] or b"")
                       or int(job["input_row_count"] or 0) != EXPECTED_CANDIDATE_ROWS
                       or int(job["valid_row_count"] or 0) != EXPECTED_CANDIDATE_ROWS
                       or int(job["error_count"] or 0) != 0):
        blockers.append("candidate_job_invalid")
    elif official_version == 1 and bytes(job["validation_map_version_id"] or b"") != official_id:
        blockers.append("candidate_review_stale")
    if official_version == 1:
        if metadata.get("basedOnMapVersionId") != _uuid_text(official_id):
            blockers.append("candidate_review_stale")
    elif official_version != EXPECTED_CANDIDATE_VERSION or official_id != map_id:
        blockers.append("official_pointer_changed")

    previous_decisions: list[dict] = []
    candidate_decisions: list[dict] = []
    unresolved_decisions = 0
    copied_decisions = 0
    if official_version == 1:
        previous_decisions, candidate_decisions = _decision_plan(connection, official_id, map_id, lock=lock)
        legacy_entry_count = int(connection.execute(text("""
            SELECT COUNT(*) FROM base_mapping_entries WHERE map_version_id=:map_id
        """), {"map_id": official_id}).scalar_one())
        if int(pointer["mapping_row_count"] or 0) != EXPECTED_LEGACY_ROWS or legacy_entry_count != EXPECTED_LEGACY_ROWS:
            blockers.append("official_v1_row_count_mismatch")
        codes = {str(row[0]) for row in connection.execute(text("""
            SELECT base_code FROM base_mapping_entries WHERE map_version_id=:map_id
        """), {"map_id": map_id})}
        pending_keys: set[tuple[str, str]] = set()
        for decision in previous_decisions:
            state = str(decision["resolution_state"])
            if state in {"UNREVIEWED", "AMBIGUOUS"}:
                pending_keys.add((str(decision["source_id"]), str(decision["source_base_name"])))
            elif state == "LINKED" and str(decision["target_base_code"] or "") not in codes:
                blockers.append("manual_decision_target_missing")
            elif state not in {"LINKED", "REJECTED"}:
                unresolved_decisions += 1
        if unresolved_decisions:
            blockers.append("manual_decisions_pending")
        candidate_codes = {str(row[0]) for row in connection.execute(text("""
            SELECT base_code FROM base_mapping_entries WHERE map_version_id=:map_id
        """), {"map_id": map_id})}
        for decision in candidate_decisions:
            state = str(decision["resolution_state"])
            if state == "LINKED" and str(decision["target_base_code"] or "") not in candidate_codes:
                blockers.append("manual_decision_target_missing")
            elif state not in {"LINKED", "REJECTED"}:
                pending_keys.add((str(decision["source_id"]), str(decision["source_base_name"])))
        unresolved_decisions = len(pending_keys)
        if unresolved_decisions:
            blockers.append("manual_decisions_pending")
        existing = {(d["source_id"], d["source_base_name"]): (d["resolution_state"], d["target_base_code"]) for d in candidate_decisions}
        expected = {(d["source_id"], d["source_base_name"]): (d["resolution_state"], d["target_base_code"]) for d in previous_decisions}
        if any(key not in expected or expected[key] != value for key, value in existing.items()):
            blockers.append("candidate_decision_conflict")
        copied_decisions = len(previous_decisions)

    audit = metadata.get("audit") if isinstance(metadata.get("audit"), dict) else {}
    ambiguous_names = audit.get("duplicateNamesNormalized", {})
    ambiguous_name_groups = len(ambiguous_names) if isinstance(ambiguous_names, dict) else 0
    state = str(candidate["version_state"])
    is_current = official_version == EXPECTED_CANDIDATE_VERSION and official_id == map_id
    can_publish = state == "PREPARED" and official_version == 1 and not blockers
    can_rollback = state == "PUBLISHED" and is_current and official_version == EXPECTED_CANDIDATE_VERSION
    return {
        "officialMapVersionId": _uuid_text(official_id), "officialVersion": official_version,
        "candidate": {
            "mapVersionId": _uuid_text(map_id), "version": int(candidate["version_no"]),
            "state": state, "contractVersion": int(candidate["contract_version"]),
            "rowCount": entry_count, "unitMetadataCount": metadata_count,
            "contractState": str(registration["contract_state"] or "UNAVAILABLE") if registration else "UNAVAILABLE",
            "reviewSha256": metadata.get("reviewSha256"),
            "ambiguousNameGroups": ambiguous_name_groups,
            "manualDecisionCount": len(previous_decisions),
            "pendingManualDecisionCount": unresolved_decisions,
            "manualDecisionsToCarry": copied_decisions,
        },
        "canPublish": can_publish, "canRollback": can_rollback,
        "alreadyPublished": is_current and state == "PUBLISHED",
        "blockers": sorted(set(blockers)),
    }


def get_network_directory_activation_status(engine: Engine) -> dict[str, object]:
    with engine.connect() as connection:
        return _candidate_state(connection, engine)


def _idempotency_hash(value: str) -> str:
    if not 8 <= len(value) <= 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def publish_network_directory_candidate(
    engine: Engine, *, map_version_id: str, expected_official_map_version_id: str,
    review_sha256: str, idempotency_key: str, actor_user_id: int, request_id: str | None,
) -> dict[str, object]:
    request_hash = _idempotency_hash(idempotency_key)
    try:
        candidate_id = uuid.UUID(map_version_id).bytes
        expected_id = uuid.UUID(expected_official_map_version_id).bytes
    except (ValueError, AttributeError):
        raise DataFoundationError("mapping_candidate_not_found", 404) from None
    if len(review_sha256) != 64 or any(char not in "0123456789abcdefABCDEF" for char in review_sha256):
        raise DataFoundationError("mapping_candidate_review_invalid", 422)
    review_sha256 = review_sha256.lower()

    with engine.begin() as connection:
        status = _candidate_state(connection, engine, lock=True)
        candidate = status.get("candidate")
        if not isinstance(candidate, dict) or candidate["mapVersionId"] != str(uuid.UUID(bytes=candidate_id)):
            raise DataFoundationError("mapping_candidate_not_found", 404)
        official_id = uuid.UUID(str(status["officialMapVersionId"])).bytes
        row = connection.execute(text("""
            SELECT version_state, candidate_metadata FROM base_mapping_versions
            WHERE map_version_id=:map_id
        """ + _for_update_clause(connection)), {"map_id": candidate_id}).mappings().one()
        metadata = _json_object(row["candidate_metadata"])
        publication = metadata.get("publication") if isinstance(metadata.get("publication"), dict) else {}
        if row["version_state"] == "PUBLISHED" and official_id == candidate_id:
            if (publication.get("idempotencySha256") == request_hash
                    and publication.get("actorUserId") == actor_user_id
                    and publication.get("expectedOfficialMapVersionId") == str(uuid.UUID(bytes=expected_id))
                    and publication.get("reviewSha256") == review_sha256.lower()):
                return {"mapVersionId": str(uuid.UUID(bytes=candidate_id)), "version": 2,
                        "state": "PUBLISHED", "reused": True, "revision": None}
            raise DataFoundationError("mapping_candidate_already_published", 409)
        if not status["canPublish"]:
            blockers = status.get("blockers", [])
            raise DataFoundationError(str(blockers[0]) if blockers else "mapping_candidate_not_publishable", 409)
        if official_id != expected_id or candidate.get("reviewSha256") != review_sha256:
            raise DataFoundationError("mapping_candidate_review_stale", 409)

        candidate_id_text = str(uuid.UUID(bytes=candidate_id))
        previous_decisions, existing_decisions = _decision_plan(connection, official_id, candidate_id, lock=True)
        existing_keys = {(item["source_id"], item["source_base_name"]): item for item in existing_decisions}
        for decision in previous_decisions:
            key = (decision["source_id"], decision["source_base_name"])
            existing = existing_keys.get(key)
            if existing is not None:
                continue
            connection.execute(text("""
                INSERT INTO base_mapping_name_decisions
                  (map_version_id, source_id, source_base_name, resolution_state, target_base_code,
                   reviewed_by_user_id, reviewed_at, review_note)
                VALUES (:map_id,:source_id,:source_name,:state,:target,:reviewer,:reviewed_at,:note)
            """), {"map_id": candidate_id, "source_id": decision["source_id"],
                   "source_name": decision["source_base_name"], "state": decision["resolution_state"],
                   "target": decision["target_base_code"], "reviewer": decision["reviewed_by_user_id"],
                   "reviewed_at": decision["reviewed_at"], "note": decision["review_note"]})

        contract_state = candidate["contractState"]
        if contract_state == "DISCOVERED":
            connection.execute(text("""
                UPDATE source_contract_versions SET contract_state='APPROVED'
                WHERE source_id='base_mapping_official' AND contract_version=:version AND contract_state='DISCOVERED'
            """), {"version": NETWORK_DIRECTORY_CONTRACT.version})
            _write_audit(connection, actor_user_id=actor_user_id, action_code="NETWORK_DIRECTORY_CONTRACT_APPROVED",
                         object_type="source_contract_version", object_id=candidate_id, request_id=request_id,
                         safe_context={"contractVersion": 2, "contractSha256": contract_sha256(NETWORK_DIRECTORY_CONTRACT).hex(),
                                       "approvedAsPartOfOfficialMapPublication": True})

        metadata["approvalState"] = "APPROVED"
        metadata["activationEnabled"] = True
        metadata["publication"] = {
            "actorUserId": actor_user_id,
            "idempotencySha256": request_hash,
            "expectedOfficialMapVersionId": str(uuid.UUID(bytes=expected_id)),
            "reviewSha256": review_sha256.lower(),
            "manualDecisionsCarried": len(previous_decisions),
        }
        published = connection.execute(text("""
            UPDATE base_mapping_versions
            SET version_state='PUBLISHED', published_by_user_id=:actor,
                published_at=CURRENT_TIMESTAMP, candidate_metadata=:metadata
            WHERE map_version_id=:map_id AND version_state='PREPARED'
        """), {"actor": actor_user_id, "metadata": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
               "map_id": candidate_id})
        if published.rowcount != 1:
            raise DataFoundationError("mapping_candidate_not_publishable", 409)
        job_id = connection.execute(text("""
            SELECT source_job_id FROM base_mapping_versions WHERE map_version_id=:map_id
        """), {"map_id": candidate_id}).scalar_one()
        job_updated = connection.execute(text("""
            UPDATE import_jobs SET job_state='PUBLISHED', finished_at=CURRENT_TIMESTAMP
            WHERE job_id=:job_id AND job_state='VALIDATED'
        """), {"job_id": job_id})
        if job_updated.rowcount != 1:
            raise DataFoundationError("candidate_job_invalid", 409)
        updated = connection.execute(text("""
            UPDATE base_mapping_current
            SET map_version_id=:map_id, changed_by_user_id=:actor, changed_at=CURRENT_TIMESTAMP
            WHERE current_key='OFFICIAL' AND map_version_id=:expected_id
        """), {"map_id": candidate_id, "actor": actor_user_id, "expected_id": expected_id})
        if updated.rowcount != 1:
            raise DataFoundationError("mapping_candidate_review_stale", 409)
        _write_audit(connection, actor_user_id=actor_user_id, action_code="NETWORK_DIRECTORY_PUBLISHED",
                     object_type="base_mapping_version", object_id=candidate_id, request_id=request_id,
                     safe_context={"version": 2, "rowCount": EXPECTED_CANDIDATE_ROWS,
                                   "previousMapVersionId": str(uuid.UUID(bytes=expected_id)),
                                   "manualDecisionsCarried": len(previous_decisions),
                                   "idempotencySha256": request_hash})

    from app.services.data_foundation.mapping_revision import read_revision
    revision = read_revision(engine)["revision"]
    return {"mapVersionId": candidate_id_text, "version": 2, "state": "PUBLISHED",
            "reused": False, "revision": revision}

def rollback_network_directory_candidate(
    engine: Engine, *, map_version_id: str, idempotency_key: str,
    actor_user_id: int, request_id: str | None,
) -> dict[str, object]:
    request_hash = _idempotency_hash(idempotency_key)
    try:
        candidate_id = uuid.UUID(map_version_id).bytes
    except (ValueError, AttributeError):
        raise DataFoundationError("mapping_candidate_not_found", 404) from None
    with engine.begin() as connection:
        status = _candidate_state(connection, engine, lock=True)
        candidate = status.get("candidate")
        if not isinstance(candidate, dict) or candidate["mapVersionId"] != str(uuid.UUID(bytes=candidate_id)):
            raise DataFoundationError("mapping_candidate_not_found", 404)
        row = connection.execute(text("""
            SELECT version_state, candidate_metadata FROM base_mapping_versions
            WHERE map_version_id=:map_id
        """ + _for_update_clause(connection)), {"map_id": candidate_id}).mappings().one()
        metadata = _json_object(row["candidate_metadata"])
        rollback = metadata.get("rollback") if isinstance(metadata.get("rollback"), dict) else {}
        official_id = uuid.UUID(str(status["officialMapVersionId"])).bytes
        if row["version_state"] == "PUBLISHED" and status["officialVersion"] == 1:
            if rollback.get("idempotencySha256") == request_hash and rollback.get("actorUserId") == actor_user_id:
                return {"officialVersion": 1, "reused": True, "revision": None}
            raise DataFoundationError("mapping_candidate_not_official", 409)
        if not status["canRollback"] or official_id != candidate_id:
            raise DataFoundationError("mapping_candidate_not_rollbackable", 409)
        legacy = connection.execute(text("""
            SELECT map_version_id, mapping_row_count, version_state
            FROM base_mapping_versions WHERE source_id='base_mapping_official' AND version_no=1
        """ + _for_update_clause(connection))).mappings().first()
        if legacy is None or legacy["version_state"] != "PUBLISHED" or int(legacy["mapping_row_count"] or 0) != EXPECTED_LEGACY_ROWS:
            raise DataFoundationError("legacy_mapping_not_available", 409)
        legacy_id = bytes(legacy["map_version_id"])
        metadata["rollback"] = {"actorUserId": actor_user_id, "idempotencySha256": request_hash}
        connection.execute(text("""
            UPDATE base_mapping_versions SET candidate_metadata=:metadata WHERE map_version_id=:map_id
        """), {"metadata": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), "map_id": candidate_id})
        updated = connection.execute(text("""
            UPDATE base_mapping_current
            SET map_version_id=:legacy_id, changed_by_user_id=:actor, changed_at=CURRENT_TIMESTAMP
            WHERE current_key='OFFICIAL' AND map_version_id=:candidate_id
        """), {"legacy_id": legacy_id, "actor": actor_user_id, "candidate_id": candidate_id})
        if updated.rowcount != 1:
            raise DataFoundationError("mapping_candidate_not_rollbackable", 409)
        _write_audit(connection, actor_user_id=actor_user_id, action_code="NETWORK_DIRECTORY_ROLLED_BACK",
                     object_type="base_mapping_version", object_id=candidate_id, request_id=request_id,
                     safe_context={"fromMapVersionId": str(uuid.UUID(bytes=candidate_id)),
                                   "toMapVersionId": str(uuid.UUID(bytes=legacy_id)),
                                   "idempotencySha256": request_hash})
    from app.services.data_foundation.mapping_revision import read_revision
    revision = read_revision(engine)["revision"]
    return {"officialVersion": 1, "mapVersionId": str(uuid.UUID(bytes=legacy_id)),
            "reused": False, "revision": revision}
