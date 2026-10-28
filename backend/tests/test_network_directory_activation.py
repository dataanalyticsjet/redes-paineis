from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.main import app
from app.api.dependencies import get_current_viewer
from app.services.data_foundation.contracts import NETWORK_DIRECTORY_CONTRACT, contract_sha256
from app.services.data_foundation.mapping_revision import read_revision
from app.services.data_foundation.network_directory_activation import (
    get_network_directory_activation_status,
    publish_network_directory_candidate,
    rollback_network_directory_candidate,
)
from app.services.data_foundation.repository import DataFoundationError
from test_network_directory_versioning import prepared_schema
from test_collection_monitoring_v2_queries import MAPPING_ID


ACTOR_ID = 91
V2_ID = uuid.UUID("22222222-2222-4222-8222-222222222222").bytes
REVIEW_SHA = "a" * 64
IDEMPOTENCY = "network-directory-activation-001"


def activation_engine(*, candidate_rows: int = 1783):
    engine, _, _ = prepared_schema()
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE base_mapping_current ADD COLUMN changed_by_user_id INTEGER")
        connection.exec_driver_sql("ALTER TABLE base_mapping_name_decisions ADD COLUMN reviewed_by_user_id INTEGER")
        connection.exec_driver_sql("ALTER TABLE base_mapping_name_decisions ADD COLUMN reviewed_at TEXT")
        connection.exec_driver_sql("ALTER TABLE base_mapping_name_decisions ADD COLUMN review_note TEXT")
        connection.exec_driver_sql("ALTER TABLE source_contract_versions ADD COLUMN history_policy TEXT")
        connection.exec_driver_sql("UPDATE source_contract_versions SET history_policy='SNAPSHOT_REPLACE_ALL'")
        connection.exec_driver_sql("ALTER TABLE data_source_registry ADD COLUMN history_policy TEXT")
        connection.exec_driver_sql("UPDATE data_source_registry SET history_policy='PENDING'")
        connection.exec_driver_sql("""CREATE TABLE source_contract_columns (
            source_id TEXT, contract_version INTEGER, column_key TEXT, ordinal_position INTEGER,
            source_header TEXT, semantic_role TEXT, data_type TEXT, is_required INTEGER,
            is_nullable INTEGER, PRIMARY KEY(source_id, contract_version, column_key))""")
        connection.exec_driver_sql("ALTER TABLE import_jobs ADD COLUMN finished_at TEXT")

        connection.execute(text("""
            UPDATE base_mapping_versions SET version_no=1,source_id='base_mapping_official',
              contract_version=1,mapping_row_count=1628,published_by_user_id=1,
              published_at='2026-10-01',file_sha256=:sha
        """), {"sha": b"v" * 32})
        connection.execute(text("""
            UPDATE base_mapping_current SET changed_at='2026-10-01',changed_by_user_id=1
        """))
        connection.execute(text("""
            INSERT INTO base_mapping_entries (map_version_id,base_code,regional_name,base_name)
            VALUES (:map_id,:code,'CE',:name)
        """), [
            {"map_id": MAPPING_ID, "code": f"OLD-{index:04}", "name": f"Old unit {index}"}
            for index in range(2, 1629)
        ])
        for ordinal, column in enumerate(NETWORK_DIRECTORY_CONTRACT.columns, start=1):
            connection.execute(text("""
                INSERT INTO source_contract_columns VALUES
                  ('base_mapping_official',2,:key,:ordinal,:header,:role,:kind,1,:nullable)
            """), {"key": column.key, "ordinal": ordinal, "header": column.header,
                   "role": column.key, "kind": column.kind, "nullable": int(column.nullable)})

        job_id = uuid.UUID("33333333-3333-4333-8333-333333333333").bytes
        metadata = {
            "schemaVersion": 1, "basedOnMapVersionId": str(uuid.UUID(bytes=MAPPING_ID)),
            "reviewSha256": REVIEW_SHA, "approvalState": "PENDING", "activationEnabled": False,
            "audit": {"duplicateNamesNormalized": {"ambiguous label": ["001", "002"]}},
        }
        connection.execute(text("""
            INSERT INTO base_mapping_versions
              (map_version_id,version_no,source_id,source_job_id,contract_version,version_state,
               original_file_name,file_sha256,mapping_row_count,published_by_user_id,published_at,candidate_metadata)
            VALUES (:id,2,'base_mapping_official',:job,2,'PREPARED','contacts.xlsx',:sha,:count,NULL,NULL,:metadata)
        """), {"id": V2_ID, "job": job_id, "sha": b"f" * 32,
               "count": candidate_rows, "metadata": json.dumps(metadata)})
        connection.execute(text("""
            INSERT INTO import_jobs
              (job_id,source_id,contract_version,validation_map_version_id,submitted_by_user_id,job_state,
               original_file_name,stored_file_key,file_size_bytes,file_sha256,input_row_count,valid_row_count,
               error_count,request_id,validated_at)
            VALUES (:job,'base_mapping_official',2,:previous,:actor,'VALIDATED','contacts.xlsx','private.xlsx',1,
                    :sha,:count,:count,0,'request-1','2026-10-21')
        """), {"job": job_id, "previous": MAPPING_ID, "actor": ACTOR_ID, "sha": b"f" * 32,
               "count": candidate_rows})
        connection.execute(text("""
            INSERT INTO base_mapping_entries
              (map_version_id,base_code,base_name,regional_name,rm_region,rm_responsible,source_row_no,unit_metadata)
            VALUES (:map_id,:code,:name,:region,'RM CE','Person',:row_no,:metadata)
        """), [
            {"map_id": V2_ID, "code": "MATCHED-001" if index == 1 else f"NEW-{index:04}",
             "name": f"New unit {index}",
             "row_no": index, "metadata": json.dumps({
                 "unit_type": "OWN" if index % 2 else "PA", "enabled_state": "ENABLED",
                 "is_operational_base": bool(index % 2),
                 "base_code": "MATCHED-001" if index == 1 else f"NEW-{index:04}",
                 "base_name": f"New unit {index}", "regional_name": "SPS" if index == 1 else "CE",
                 "rm_region": "RM CE", "rm_responsible": "Person",
             }), "region": "SPS" if index == 1 else "CE"}
            for index in range(1, candidate_rows + 1)
        ])
    return engine


def publish(engine, *, key=IDEMPOTENCY):
    return publish_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=V2_ID)),
        expected_official_map_version_id=str(uuid.UUID(bytes=MAPPING_ID)),
        review_sha256=REVIEW_SHA, idempotency_key=key, actor_user_id=ACTOR_ID,
        request_id="request-activation",
    )


def insert_follow_up_candidate(engine, *, version: int, rows: int, based_on: bytes, map_id: bytes):
    job_id = uuid.uuid5(uuid.NAMESPACE_OID, f"network-map-job-{version}").bytes
    file_sha = bytes([version]) * 32
    metadata = {
        "schemaVersion": 1, "actorUserId": ACTOR_ID,
        "basedOnMapVersionId": str(uuid.UUID(bytes=based_on)),
        "reviewSha256": REVIEW_SHA, "approvalState": "PENDING", "activationEnabled": False,
        "audit": {"duplicateNamesNormalized": {}},
    }
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO base_mapping_versions
              (map_version_id,version_no,source_id,source_job_id,contract_version,version_state,
               original_file_name,file_sha256,mapping_row_count,published_by_user_id,published_at,candidate_metadata)
            VALUES (:id,:version,'base_mapping_official',:job,2,'PREPARED','contacts.xlsx',:sha,:count,NULL,NULL,:metadata)
        """), {"id": map_id, "version": version, "job": job_id, "sha": file_sha,
               "count": rows, "metadata": json.dumps(metadata)})
        connection.execute(text("""
            INSERT INTO import_jobs
              (job_id,source_id,contract_version,validation_map_version_id,submitted_by_user_id,job_state,
               original_file_name,stored_file_key,file_size_bytes,file_sha256,input_row_count,valid_row_count,
               error_count,request_id,validated_at)
            VALUES (:job,'base_mapping_official',2,:previous,:actor,'VALIDATED','contacts.xlsx','private.xlsx',1,
                    :sha,:count,:count,0,:request,'2026-10-21')
        """), {"job": job_id, "previous": based_on, "actor": ACTOR_ID, "sha": file_sha,
               "count": rows, "request": f"request-{version}"})
        connection.execute(text("""
            INSERT INTO base_mapping_entries
              (map_version_id,base_code,base_name,regional_name,rm_region,rm_responsible,source_row_no,unit_metadata)
            VALUES (:map_id,:code,:name,'CE','RM CE','Person',:row_no,:metadata)
        """), [
            {"map_id": map_id, "code": f"REV{version}-{index:04}", "name": f"Revision {version} unit {index}",
             "row_no": index, "metadata": json.dumps({
                 "unit_type": "OWN", "enabled_state": "ENABLED", "is_operational_base": True,
                 "base_code": f"REV{version}-{index:04}", "base_name": f"Revision {version} unit {index}",
                 "regional_name": "CE", "rm_region": "RM CE", "rm_responsible": "Person",
             })}
            for index in range(1, rows + 1)
        ])


@pytest.mark.parametrize("candidate_rows", [1783, 1820, 1700])
def test_activation_accepts_valid_v2_contract_candidates_with_changed_row_counts(monkeypatch, candidate_rows):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine(candidate_rows=candidate_rows)
    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is True
    assert status["candidate"]["contractVersion"] == 2
    assert status["candidate"]["rowCount"] == candidate_rows
    result = publish(engine)
    assert result["state"] == "PUBLISHED"
    assert result["version"] == 2
    engine.dispose()


def test_follow_up_revision_publishes_atomically_and_rolls_back_to_previous_published_map(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    v3_id = uuid.UUID("44444444-4444-4444-8444-444444444444").bytes
    insert_follow_up_candidate(engine, version=3, rows=1700, based_on=V2_ID, map_id=v3_id)

    status = get_network_directory_activation_status(engine)
    assert status["officialVersion"] == 2
    assert status["candidate"]["version"] == 3
    assert status["candidate"]["contractVersion"] == NETWORK_DIRECTORY_CONTRACT.version == 2
    assert status["candidate"]["rowCount"] == 1700
    assert status["canPublish"] is True

    result = publish_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=v3_id)),
        expected_official_map_version_id=str(uuid.UUID(bytes=V2_ID)),
        review_sha256=REVIEW_SHA, idempotency_key="network-directory-v3-publish",
        actor_user_id=ACTOR_ID, request_id="request-v3-publish",
    )
    assert result["state"] == "PUBLISHED"
    assert result["version"] == 3
    active = get_network_directory_activation_status(engine)
    assert active["officialVersion"] == 3
    assert active["canRollback"] is True
    assert active["rollbackMapVersionId"] == str(uuid.UUID(bytes=v3_id))
    assert active["rollbackTargetVersion"] == 2

    rollback = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=v3_id)),
        idempotency_key="network-directory-v3-rollback", actor_user_id=ACTOR_ID,
        request_id="request-v3-rollback",
    )
    assert rollback["officialVersion"] == 2
    assert rollback["mapVersionId"] == str(uuid.UUID(bytes=V2_ID))
    with engine.connect() as connection:
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == V2_ID
        assert connection.execute(text("SELECT COUNT(*) FROM base_mapping_versions WHERE version_state='PUBLISHED'")).scalar_one() == 3
        assert connection.execute(text("SELECT COUNT(*) FROM base_mapping_entries WHERE map_version_id=:id"), {"id": v3_id}).scalar_one() == 1700
    repeated = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=v3_id)),
        idempotency_key="network-directory-v3-rollback", actor_user_id=ACTOR_ID,
        request_id="request-v3-rollback",
    )
    assert repeated["reused"] is True
    engine.dispose()


def test_follow_up_candidate_bound_to_old_official_map_is_blocked(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    stale_id = uuid.UUID("55555555-5555-4555-8555-555555555555").bytes
    insert_follow_up_candidate(engine, version=3, rows=1800, based_on=MAPPING_ID, map_id=stale_id)
    status = get_network_directory_activation_status(engine)
    assert status["officialVersion"] == 2
    assert status["candidate"]["version"] == 3
    assert status["canPublish"] is False
    assert "candidate_review_stale" in status["blockers"]
    engine.dispose()


def test_official_map_remains_rollbackable_while_newer_candidate_is_prepared(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    pending_id = uuid.UUID("66666666-6666-4666-8666-666666666666").bytes
    insert_follow_up_candidate(engine, version=3, rows=1700, based_on=V2_ID, map_id=pending_id)

    status = get_network_directory_activation_status(engine)
    assert status["candidate"]["version"] == 3
    assert status["canPublish"] is True
    assert status["canRollback"] is True
    assert status["rollbackMapVersionId"] == str(uuid.UUID(bytes=V2_ID))
    assert status["rollbackTargetVersion"] == 1

    rollback = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=V2_ID)),
        idempotency_key="network-directory-v2-rollback-with-v3-prepared",
        actor_user_id=ACTOR_ID, request_id="request-v2-rollback-with-v3-prepared",
    )
    assert rollback["officialVersion"] == 1
    with engine.connect() as connection:
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == MAPPING_ID
        assert connection.execute(text("SELECT version_state FROM base_mapping_versions WHERE map_version_id=:id"),
                                  {"id": pending_id}).scalar_one() == "PREPARED"
    engine.dispose()


def test_status_checks_exact_candidate_contract_metadata_and_preserves_registry_policy(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    status = get_network_directory_activation_status(engine)
    assert status["officialVersion"] == 1
    assert status["candidate"]["rowCount"] == 1783
    assert status["candidate"]["unitMetadataCount"] == 1783
    assert status["candidate"]["contractState"] == "DISCOVERED"
    assert status["candidate"]["ambiguousNameGroups"] == 1
    assert status["canPublish"] is True
    assert "unit_metadata_feature_disabled" not in status["blockers"]
    with engine.connect() as connection:
        assert connection.execute(text("SELECT history_policy FROM data_source_registry")).scalar_one() == "PENDING"


def test_publish_is_atomic_approves_dedicated_contract_updates_official_and_enables_metadata(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    first = publish(engine)
    assert first["state"] == "PUBLISHED" and first["reused"] is False
    assert read_revision(engine)["unitMetadataEnabled"] is True
    with engine.connect() as connection:
        versions = connection.execute(text("SELECT version_no,version_state FROM base_mapping_versions ORDER BY version_no")).all()
        assert versions == [(1, "PUBLISHED"), (2, "PUBLISHED")]
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == V2_ID
        assert connection.execute(text("SELECT contract_state FROM source_contract_versions WHERE contract_version=2")).scalar_one() == "APPROVED"
        assert connection.execute(text("SELECT job_state FROM import_jobs")).scalar_one() == "PUBLISHED"
        assert connection.execute(text("SELECT history_policy FROM data_source_registry")).scalar_one() == "PENDING"
        actions = set(connection.execute(text("SELECT action_code FROM data_audit_events")).scalars())
        assert actions == {"NETWORK_DIRECTORY_CONTRACT_APPROVED", "NETWORK_DIRECTORY_PUBLISHED"}
    repeated = publish(engine)
    assert repeated["reused"] is True
    with pytest.raises(DataFoundationError, match="mapping_candidate_already_published"):
        publish_network_directory_candidate(
            engine, map_version_id=str(uuid.UUID(bytes=V2_ID)),
            expected_official_map_version_id=str(uuid.UUID(bytes=MAPPING_ID)),
            review_sha256="b" * 64, idempotency_key=IDEMPOTENCY, actor_user_id=ACTOR_ID,
            request_id="request-activation-different-payload",
        )


def test_publish_carries_resolved_manual_decisions_and_dashboard_reads_new_official_map(monkeypatch):
    from app.services.data_foundation.queries import get_records
    from app.services.data_foundation.contracts import CONTRACT_VERSIONS
    from app.services.data_foundation.repository import fact_table_for_contract
    from test_collection_monitoring_v2_queries import _insert_day, ADMIN_MATRIX

    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO base_mapping_name_decisions
              (map_version_id,source_id,source_base_name,resolution_state,target_base_code,
               reviewed_by_user_id,reviewed_at,review_note)
            VALUES (:map_id,'collection_monitoring','Legacy PDD','LINKED','MATCHED-001',1,
                    '2026-10-20','Validated target remains present in V2')
        """), {"map_id": MAPPING_ID})
    _insert_day(engine, CONTRACT_VERSIONS[("collection_monitoring", 2)],
                fact_table_for_contract("collection_monitoring", 2), day=22, rows=[(1, True)])
    result = publish(engine)
    assert result["state"] == "PUBLISHED"
    with engine.connect() as connection:
        decision = connection.execute(text("""
            SELECT resolution_state,target_base_code FROM base_mapping_name_decisions
            WHERE map_version_id=:map_id
        """), {"map_id": V2_ID}).one()
        assert tuple(decision) == ("LINKED", "MATCHED-001")
    matrix = get_records(engine, source_id="collection_monitoring", identity=ADMIN_MATRIX,
                         contract_version=2, limit=250, offset=0)
    assert matrix["total"] == 1
    assert matrix["records"][0]["mapped_region"] == "SPS"


def test_publish_failure_rolls_back_contract_map_job_and_pointer(monkeypatch):
    engine = activation_engine()
    monkeypatch.setattr(
        "app.services.data_foundation.network_directory_activation._write_audit",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("audit write failed")),
    )
    with pytest.raises(RuntimeError, match="audit write failed"):
        publish(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == MAPPING_ID
        assert connection.execute(text("SELECT version_state FROM base_mapping_versions WHERE version_no=2")).scalar_one() == "PREPARED"
        assert connection.execute(text("SELECT contract_state FROM source_contract_versions WHERE contract_version=2")).scalar_one() == "DISCOVERED"
        assert connection.execute(text("SELECT job_state FROM import_jobs")).scalar_one() == "VALIDATED"


@pytest.mark.parametrize("decision_state", ["UNREVIEWED", "AMBIGUOUS"])
def test_unresolved_manual_decision_blocks_publication_without_changing_pointer(monkeypatch, decision_state):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO base_mapping_name_decisions
              (map_version_id,source_id,source_base_name,resolution_state,target_base_code)
            VALUES (:map_id,'collection_monitoring','Unknown JMS base',:state,NULL)
        """), {"map_id": MAPPING_ID, "state": decision_state})
    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is False
    assert "manual_decisions_pending" in status["blockers"]
    with pytest.raises(DataFoundationError, match="manual_decisions_pending"):
        publish(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == MAPPING_ID


def test_rollback_returns_pointer_to_v1_and_preserves_both_published_versions(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    reverted = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=V2_ID)), idempotency_key="rollback-request-001",
        actor_user_id=ACTOR_ID, request_id="request-rollback",
    )
    assert reverted["officialVersion"] == 1
    assert read_revision(engine)["unitMetadataEnabled"] is False
    with engine.connect() as connection:
        assert connection.execute(text("SELECT map_version_id FROM base_mapping_current")).scalar_one() == MAPPING_ID
        assert connection.execute(text("SELECT COUNT(*) FROM base_mapping_versions WHERE version_state='PUBLISHED'")).scalar_one() == 2
        assert connection.execute(text("SELECT action_code FROM data_audit_events WHERE action_code='NETWORK_DIRECTORY_ROLLED_BACK'")).scalar_one()
    repeated = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=V2_ID)), idempotency_key="rollback-request-001",
        actor_user_id=ACTOR_ID, request_id="request-rollback",
    )
    assert repeated["reused"] is True


def test_contract_mismatch_blocks_activation_but_does_not_block_controlled_rollback(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    with engine.begin() as connection:
        connection.execute(text("UPDATE source_contract_versions SET contract_state='RETIRED' WHERE contract_version=2"))

    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is False
    assert status["canRollback"] is True
    assert "source_contract_not_approvable" in status["blockers"]

    reverted = rollback_network_directory_candidate(
        engine, map_version_id=str(uuid.UUID(bytes=V2_ID)), idempotency_key="rollback-contract-mismatch-001",
        actor_user_id=ACTOR_ID, request_id="request-rollback-contract-mismatch",
    )
    assert reverted["officialVersion"] == 1
    assert read_revision(engine)["unitMetadataEnabled"] is False


def test_missing_contract_keeps_published_map_rollback_visible(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    publish(engine)
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM source_contract_versions WHERE contract_version=2"))

    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is False
    assert status["canRollback"] is True
    assert "source_contract_not_approvable" in status["blockers"]


@pytest.mark.parametrize("metadata_patch,expected_blocker", [
    ({"reviewSha256": "invalid"}, "candidate_review_hash_invalid"),
    ({"reviewSha256": None}, "candidate_review_hash_invalid"),
])
def test_invalid_candidate_review_hash_blocks_publication(metadata_patch, expected_blocker, monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    with engine.begin() as connection:
        metadata = json.loads(connection.execute(text(
            "SELECT candidate_metadata FROM base_mapping_versions WHERE version_no=2"
        )).scalar_one())
        metadata.update(metadata_patch)
        connection.execute(text(
            "UPDATE base_mapping_versions SET candidate_metadata=:metadata WHERE version_no=2"
        ), {"metadata": json.dumps(metadata)})
    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is False
    assert expected_blocker in status["blockers"]


def test_unit_metadata_must_match_operational_columns_before_publication(monkeypatch):
    monkeypatch.setattr(get_settings(), "data_mapping_unit_metadata_enabled", False)
    engine = activation_engine()
    with engine.begin() as connection:
        connection.execute(text("""
            UPDATE base_mapping_entries SET regional_name='RJ'
            WHERE map_version_id=:map_id AND base_code='MATCHED-001'
        """), {"map_id": V2_ID})
    status = get_network_directory_activation_status(engine)
    assert status["canPublish"] is False
    assert "candidate_unit_metadata_invalid" in status["blockers"]


def test_regional_admin_is_denied_activation_status_endpoint(monkeypatch):
    from types import SimpleNamespace

    viewer = SimpleNamespace(
        user=SimpleNamespace(id=ACTOR_ID, platform_role="ADMIN"),
        identity={"administrative_scope": "regional"},
    )
    monkeypatch.setitem(app.dependency_overrides, get_current_viewer, lambda: viewer)
    monkeypatch.setattr("app.api.data_foundation._require_feature", lambda **_kwargs: None)
    with TestClient(app) as client:
        response = client.get("/api/v2/base-mapping/network-directory/candidates/prepared")
    assert response.status_code == 403
    assert response.json()["detail"] == "matrix_admin_required"


def test_matrix_admin_can_publish_through_dedicated_endpoint(monkeypatch):
    from types import SimpleNamespace

    calls = []
    viewer = SimpleNamespace(
        user=SimpleNamespace(id=ACTOR_ID, platform_role="ADMIN"),
        identity={"administrative_scope": "matrix"},
    )
    monkeypatch.setitem(app.dependency_overrides, get_current_viewer, lambda: viewer)
    monkeypatch.setattr("app.api.data_foundation._require_feature", lambda **_kwargs: None)
    monkeypatch.setattr("app.api.data_foundation._same_origin", lambda _request: None)
    monkeypatch.setattr("app.api.data_foundation._engine", lambda: object())
    monkeypatch.setattr("app.api.data_foundation.publish_network_directory_candidate", lambda *args, **kwargs: (
        calls.append((args, kwargs)) or {"mapVersionId": str(uuid.UUID(bytes=V2_ID)), "version": 2,
                                         "state": "PUBLISHED", "reused": False, "revision": "revision-v2"}
    ))
    payload = {
        "expectedOfficialMapVersionId": str(uuid.UUID(bytes=MAPPING_ID)),
        "reviewSha256": REVIEW_SHA,
    }
    with TestClient(app) as client:
        response = client.post(
            f"/api/v2/base-mapping/network-directory/candidates/{uuid.UUID(bytes=V2_ID)}/publish",
            json=payload,
            headers={"Idempotency-Key": "matrix-admin-publish-001"},
        )
    assert response.status_code == 200, response.text
    assert response.json()["state"] == "PUBLISHED"
    assert len(calls) == 1
    assert calls[0][1]["actor_user_id"] == ACTOR_ID
    assert calls[0][1]["review_sha256"] == REVIEW_SHA
