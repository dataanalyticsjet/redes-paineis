"""Prepare a Network Directory version in the existing DoomsDay tables.

No approval, publication, pointer update or automatic schema changes exist here.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from sqlalchemy import Engine, inspect, text

from app.services.data_foundation.contracts import NETWORK_DIRECTORY_CONTRACT, contract_sha256
from app.services.data_foundation.network_directory_candidate import parse_network_directory, preview_on_connection
from app.services.data_foundation.repository import (
    DataFoundationError, _for_update_clause, _write_audit, save_uploaded_workbook,
)


def _json(value) -> dict:
    return json.loads(value) if isinstance(value, (str, bytes)) else value or {}


def prepare_network_directory_candidate(
    engine: Engine, *, content: bytes, file_name: str, actor_user_id: int,
    staging_directory: Path, expected_map_version_id: str, review_sha256: str,
    idempotency_key: str, request_id: str | None = None,
) -> dict[str, object]:
    if not 8 <= len(idempotency_key) <= 128:
        raise DataFoundationError("idempotency_key_invalid", 422)
    candidate = parse_network_directory(content)
    if candidate.errors:
        raise DataFoundationError("mapping_candidate_invalid", 422)
    request_hash = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()
    stored_key = None
    contract = NETWORK_DIRECTORY_CONTRACT
    try:
        with engine.begin() as connection:
            # An explicit manual schema review is required. Never ALTER on startup/import.
            schema = inspect(connection)
            version_columns = {c["name"]: c for c in schema.get_columns("base_mapping_versions")}
            entry_columns = {c["name"] for c in schema.get_columns("base_mapping_entries")}
            if ("candidate_metadata" not in version_columns or "unit_metadata" not in entry_columns
                    or not version_columns.get("published_by_user_id", {}).get("nullable", False)):
                raise DataFoundationError("mapping_candidate_schema_not_ready", 409)
            registration = connection.execute(text("""
                SELECT registry.source_state, contract.contract_state, contract.contract_sha256
                FROM data_source_registry AS registry
                JOIN source_contract_versions AS contract ON contract.source_id = registry.source_id
                WHERE registry.source_id = 'base_mapping_official' AND contract.contract_version = :version
            """ + _for_update_clause(connection)), {"version": contract.version}).mappings().first()
            if registration is None or registration["source_state"] in {"PAUSED", "RETIRED"}:
                raise DataFoundationError("source_contract_not_registered", 409)
            if registration["contract_state"] not in {"DISCOVERED", "APPROVED"} or bytes(registration["contract_sha256"] or b"") != contract_sha256(contract):
                raise DataFoundationError("source_contract_definition_mismatch", 409)

            existing_versions = connection.execute(text("""
                SELECT map_version_id, version_no, version_state, file_sha256, candidate_metadata
                FROM base_mapping_versions
                WHERE source_id = 'base_mapping_official' AND candidate_metadata IS NOT NULL
            """)).mappings()
            for existing in existing_versions:
                metadata = _json(existing["candidate_metadata"])
                if metadata.get("idempotencySha256") != request_hash:
                    continue
                if (metadata.get("actorUserId") != actor_user_id
                        or metadata.get("reviewSha256") != review_sha256
                        or bytes(existing["file_sha256"]).hex() != candidate.file_sha256
                        or existing["version_state"] != "PREPARED"):
                    raise DataFoundationError("mapping_candidate_idempotency_conflict", 409)
                return {"mapVersionId":str(uuid.UUID(bytes=bytes(existing["map_version_id"]))),
                        "version":existing["version_no"],"state":"PREPARED","canPublish":False,"reused":True}

            # Lock pointer after source row; same order is mandatory for future activation.
            pointer = connection.execute(text("""
                SELECT map_version_id FROM base_mapping_current WHERE current_key = 'OFFICIAL'
            """ + _for_update_clause(connection))).scalar_one_or_none()
            if pointer is None or str(uuid.UUID(bytes=bytes(pointer))) != expected_map_version_id:
                raise DataFoundationError("mapping_candidate_review_stale", 409)
            preview = preview_on_connection(connection, candidate)
            if preview["reviewSha256"] != review_sha256:
                raise DataFoundationError("mapping_candidate_review_stale", 409)
            version = int(connection.execute(text("SELECT COALESCE(MAX(version_no), 0) FROM base_mapping_versions")).scalar_one()) + 1
            job_id, map_id = uuid.uuid4().bytes, uuid.uuid4().bytes
            stored_key = save_uploaded_workbook(staging_directory, content)
            connection.execute(text("""
                INSERT INTO import_jobs
                (job_id, source_id, contract_version, validation_map_version_id, submitted_by_user_id,
                 job_state, original_file_name, stored_file_key, file_size_bytes, file_sha256,
                 input_row_count, valid_row_count, error_count, request_id, validated_at)
                VALUES (:job, 'base_mapping_official', :contract, :based_on, :actor, 'VALIDATED',
                        :name, :stored, :size, :sha, :count, :count, 0, :request, CURRENT_TIMESTAMP)
            """), {"job":job_id,"contract":contract.version,"based_on":pointer,"actor":actor_user_id,
                   "name":file_name[:255],"stored":stored_key,"size":len(content),
                   "sha":bytes.fromhex(candidate.file_sha256),"count":len(candidate.units),"request":request_id})
            metadata = {
                "schemaVersion":1,"actorUserId":actor_user_id,"idempotencySha256":request_hash,
                "reviewSha256":review_sha256,"basedOnMapVersionId":expected_map_version_id,
                "audit":preview["audit"],"excludedRows":list(candidate.excluded_rows),
                "approvalState":"PENDING","activationEnabled":False,
            }
            connection.execute(text("""
                INSERT INTO base_mapping_versions
                (map_version_id, version_no, source_id, source_job_id, contract_version, version_state,
                 original_file_name, file_sha256, mapping_row_count, published_by_user_id, published_at, candidate_metadata)
                VALUES (:id, :version, 'base_mapping_official', :job, :contract, 'PREPARED', :name,
                        :sha, :count, NULL, NULL, :metadata)
            """), {"id":map_id,"version":version,"job":job_id,"contract":contract.version,"name":file_name[:255],
                   "sha":bytes.fromhex(candidate.file_sha256),"count":len(candidate.units),
                   "metadata":json.dumps(metadata,ensure_ascii=False,separators=(",",":"))})
            statement = text("""
                INSERT INTO base_mapping_entries
                (map_version_id, base_code, base_name, regional_name, uf_code, rm_region, rm_responsible,
                 base_description, source_row_no, unit_metadata)
                VALUES (:id,:base_code,:base_name,:regional_name,NULL,:rm_region,:rm_responsible,NULL,:source_row_no,:metadata)
            """)
            connection.execute(statement, [
                {"id":map_id,**{f:u[f] for f in ("base_code","base_name","regional_name","rm_region","rm_responsible","source_row_no")},
                 "metadata":json.dumps(u,ensure_ascii=False,separators=(",",":"))} for u in candidate.units
            ])
            count = connection.execute(text("SELECT COUNT(*) FROM base_mapping_entries WHERE map_version_id=:id"),{"id":map_id}).scalar_one()
            if count != len(candidate.units):
                raise DataFoundationError("mapping_entry_count_mismatch",409)
            _write_audit(connection,actor_user_id=actor_user_id,action_code="MAPPING_CANDIDATE_PREPARED",
                         object_type="base_mapping_version",object_id=map_id,request_id=request_id,
                         safe_context={"version":version,"rows":count,"sourceSha256":candidate.file_sha256,"reviewSha256":review_sha256})
            # No updates to base_mapping_current, approvals, publication states or manual decisions.
            return {"mapVersionId":str(uuid.UUID(bytes=map_id)),"version":version,"state":"PREPARED",
                    "rowCount":count,"canPublish":False,"reused":False}
    except Exception:
        # Rollback protects DB consistency. Keep private source staging for audit,
        # including uncertain commit outcomes; never delete an existing upload.
        raise
