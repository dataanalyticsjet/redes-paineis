from __future__ import annotations

import hashlib
import re
import uuid
from datetime import date, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.pool import StaticPool

from app.api import data_foundation as api
from app.services.data_foundation import repository as repo
from app.services.data_foundation.contracts import contract_sha256, get_contract
from app.services.data_foundation.service_principals import ServicePrincipal, allowed_bot_contracts
from app.services.data_foundation.xlsx_parser import MappingResolver, PreviewSummary


PRINCIPAL = "windows-newbi-publisher"
USER_ID = 47
MAP_ID = b"official-map-v2!"
CONTENT = b"synthetic no-movement workbook bytes"


def _engine():
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "before_cursor_execute", retval=True)
    def sqlite_compat(_connection, _cursor, statement, parameters, _context, _executemany):
        statement = statement.replace("CURRENT_TIMESTAMP(6)", "CURRENT_TIMESTAMP")
        statement = re.sub(r"\s+FOR UPDATE\b", "", statement)
        return statement, parameters

    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE import_jobs (
              job_id BLOB PRIMARY KEY, source_id TEXT, contract_version INTEGER,
              validation_map_version_id BLOB, reused_publication_id BLOB,
              job_state TEXT, original_file_name TEXT, stored_file_key TEXT,
              file_size_bytes INTEGER, file_sha256 BLOB, input_row_count INTEGER,
              valid_row_count INTEGER, error_count INTEGER, submitted_by_user_id INTEGER,
              submitted_by_service_principal_id TEXT, request_id TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP, validated_at TEXT, finished_at TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE import_job_errors (
              error_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id BLOB,
              source_row_no INTEGER, column_key TEXT, error_code TEXT, safe_context TEXT
            )
        """)
        connection.exec_driver_sql("CREATE TABLE data_source_registry (source_id TEXT PRIMARY KEY, source_state TEXT, history_policy TEXT)")
        connection.exec_driver_sql("CREATE TABLE data_service_principal_contract_scopes (service_principal_id TEXT, source_id TEXT, contract_version INTEGER, is_active INTEGER)")
        connection.execute(text("INSERT INTO data_service_principal_contract_scopes VALUES (:principal,:source,2,1)"), {"principal": PRINCIPAL, "source": "no_movement"})
        connection.exec_driver_sql("""
            CREATE TABLE source_contract_versions (
              source_id TEXT, contract_version INTEGER, contract_state TEXT,
              expected_sheet TEXT, header_row INTEGER, history_policy TEXT, contract_sha256 BLOB,
              PRIMARY KEY(source_id, contract_version)
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE source_publications (
              publication_id BLOB PRIMARY KEY, source_id TEXT, version_no INTEGER, job_id BLOB,
              contract_version INTEGER, map_version_id BLOB, file_sha256 BLOB,
              publication_state TEXT, history_policy TEXT, period_start TEXT, period_end TEXT,
              snapshot_as_of TEXT, row_count INTEGER, mapped_row_count INTEGER,
              unmapped_row_count INTEGER, missing_identifier_row_count INTEGER,
              ambiguous_row_count INTEGER, published_at TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE data_audit_events (
              audit_id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER,
              actor_service_principal_id TEXT, action_code TEXT, object_type TEXT,
              object_id BLOB, request_id TEXT, event_context TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE no_movement_operational_analyses (
              analysis_id BLOB, source_id TEXT, publication_id BLOB, publication_version INTEGER,
              contract_version INTEGER, map_version_id BLOB, operational_date TEXT,
              export_time_local TEXT, export_time_zone TEXT, export_time_source TEXT,
              confirmation_user_id INTEGER, confirmed_at TEXT, analysis_state TEXT, rules_version TEXT
            )
        """)
        contract = get_contract("no_movement", 2)
        connection.execute(text("INSERT INTO data_source_registry VALUES ('no_movement','ACTIVE',:policy)"), {"policy": contract.history_policy})
        connection.execute(text("""
            INSERT INTO source_contract_versions
              VALUES ('no_movement',2,'APPROVED',:sheet,:header,:policy,:digest)
        """), {
            "sheet": contract.sheet_name, "header": contract.header_row,
            "policy": contract.history_policy, "digest": contract_sha256(contract),
        })
    return engine


def _status_client(engine, monkeypatch):
    monkeypatch.setattr(api, "_engine", lambda: engine)
    monkeypatch.setattr(api, "_require_bot_publishing", lambda: None)
    test_app = FastAPI()
    test_app.include_router(api.router, prefix="/api")
    test_app.dependency_overrides[api.require_service_principal] = lambda: ServicePrincipal(PRINCIPAL, "synthetic-credential")
    return TestClient(test_app)


def _insert_status_job(engine, *, state, owner=PRINCIPAL, reused_publication_id=None, publish_as_job=False):
    job_bytes = uuid.uuid4().bytes
    job_id = str(uuid.UUID(bytes=job_bytes))
    publication_bytes = reused_publication_id or uuid.uuid4().bytes
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO import_jobs (
              job_id, source_id, contract_version, validation_map_version_id, reused_publication_id,
              job_state, original_file_name, stored_file_key, file_size_bytes, file_sha256,
              input_row_count, valid_row_count, error_count, submitted_by_user_id,
              submitted_by_service_principal_id, request_id
            ) VALUES (
              :job, 'no_movement', 2, :map_id, :reused, :state, 'source.xlsx', 'private.xlsx',
              10, :digest, 165, 165, 0, NULL, :owner, 'synthetic-status-test'
            )
        """), {
            "job": job_bytes, "map_id": MAP_ID, "reused": reused_publication_id,
            "state": state, "digest": hashlib.sha256(CONTENT).digest(), "owner": owner,
        })
        if publish_as_job or reused_publication_id is not None:
            connection.execute(text("""
                INSERT INTO source_publications (
                  publication_id, source_id, version_no, job_id, contract_version, map_version_id,
                  file_sha256, publication_state
                ) VALUES (:publication, 'no_movement', 9, :publication_job, 2, :map_id, :digest, 'PUBLISHED')
            """), {
                "publication": publication_bytes,
                "publication_job": job_bytes if publish_as_job else uuid.uuid4().bytes,
                "map_id": MAP_ID, "digest": hashlib.sha256(CONTENT).digest(),
            })
    return job_id, publication_bytes


def _summary(content: bytes = CONTENT) -> PreviewSummary:
    return PreviewSummary(
        source_id="no_movement", file_sha256=hashlib.sha256(content).hexdigest(),
        contract_version=2, input_row_count=1, valid_row_count=1, mapped_row_count=1,
        mapping_version_available=True, map_version_id=MAP_ID,
        bot_execution_id="fixture-execution", bot_executed_at=datetime(2026, 10, 29, 8, 0),
        collection_date=date(2026, 10, 29),
    )


def _configure_flow(monkeypatch, content: bytes = CONTENT):
    summary = _summary(content)
    resolver = MappingResolver(map_version_id=MAP_ID)
    monkeypatch.setattr(repo, "load_mapping_resolver", lambda *_args, **_kwargs: resolver)
    monkeypatch.setattr(repo, "read_staged_workbook", lambda *_args, **_kwargs: content)
    monkeypatch.setattr(repo, "read_preview_manifest", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(repo, "write_preview_manifest", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(repo, "parse_workbook", lambda *_args, **_kwargs: _summary(content))
    monkeypatch.setattr(repo, "_validate_contract_for_publication", lambda *_args, **_kwargs: {"history_policy": get_contract("no_movement", 2).history_policy})
    monkeypatch.setattr(repo, "current_mapping_version", lambda *_args, **_kwargs: MAP_ID)
    monkeypatch.setattr(repo, "_write_publication_dates", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(repo, "_insert_fact_batches", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(repo, "_switch_heads", lambda *_args, **_kwargs: None)
    return summary


def _create_bot_job(engine, summary: PreviewSummary, principal: str = PRINCIPAL) -> str:
    contract = get_contract("no_movement", 2)
    with engine.connect() as connection:
        return repo.create_preview_job(
            connection, source_id="no_movement", actor_user_id=None,
            actor_service_principal_id=principal, file_name="sem_movimentacao.xlsx",
            file_size=len(CONTENT), stored_file_key="fixture.xlsx", summary=summary,
            request_id="synthetic-test",
        )


def test_preview_validate_publish_machine_flow_uses_exact_service_principal_owner(tmp_path, monkeypatch):
    engine = _engine()
    summary = _configure_flow(monkeypatch)
    job_id = _create_bot_job(engine, summary)

    with engine.connect() as connection:
        job = repo.load_import_job(connection, job_id)
    assert job["submitted_by_user_id"] is None
    assert job["submitted_by_service_principal_id"] == PRINCIPAL

    validated = repo.validate_job_again(
        engine, job_id=job_id, actor_user_id=None,
        actor_service_principal_id=PRINCIPAL, staging_directory=tmp_path,
    )
    assert validated["canPublish"] is True

    published = repo.publish_import_job(
        engine, job_id=job_id, actor_user_id=None,
        actor_service_principal_id=PRINCIPAL, staging_directory=tmp_path,
        idempotency_key="synthetic-idempotency", request_id="synthetic-test",
    )
    assert published["version"] == 1
    assert published["reused"] is False
    with engine.connect() as connection:
        assert connection.execute(text("SELECT job_state FROM import_jobs WHERE job_id=:id"), {"id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == "PUBLISHED"
        assert connection.execute(text("SELECT publication_state FROM source_publications WHERE job_id=:id"), {"id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == "PUBLISHED"
        assert connection.execute(text("SELECT actor_service_principal_id FROM data_audit_events WHERE action_code='PUBLICATION_PUBLISHED'")).scalar_one() == PRINCIPAL
    engine.dispose()


def test_validation_rejects_another_service_principal_and_missing_job(tmp_path, monkeypatch):
    engine = _engine()
    summary = _configure_flow(monkeypatch)
    job_id = _create_bot_job(engine, summary)
    for requested_job, actor in ((job_id, "another-publisher"), ("00000000-0000-0000-0000-000000000000", PRINCIPAL)):
        with pytest.raises(repo.DataFoundationError) as error:
            repo.validate_job_again(
                engine, job_id=requested_job, actor_user_id=None,
                actor_service_principal_id=actor, staging_directory=tmp_path,
            )
        assert error.value.code == "import_job_not_found"
    engine.dispose()


def test_publish_rejects_another_service_principal_before_publication(tmp_path, monkeypatch):
    engine = _engine()
    summary = _configure_flow(monkeypatch)
    job_id = _create_bot_job(engine, summary)
    with pytest.raises(repo.DataFoundationError) as error:
        repo.publish_import_job(
            engine, job_id=job_id, actor_user_id=None,
            actor_service_principal_id="another-publisher", staging_directory=tmp_path,
            idempotency_key="synthetic-idempotency", request_id="synthetic-test",
        )
    assert error.value.code == "import_job_not_publishable"
    with engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM source_publications")).scalar_one() == 0
    engine.dispose()


def test_manual_admin_preview_validation_and_publication_remain_supported(tmp_path, monkeypatch):
    engine = _engine()
    content = b"synthetic manual administrator workbook"
    summary = _configure_flow(monkeypatch, content)
    with engine.connect() as connection:
        job_id = repo.create_preview_job(
            connection, source_id="no_movement", actor_user_id=USER_ID,
            actor_service_principal_id=None, file_name="sem_movimentacao.xlsx",
            file_size=len(content), stored_file_key="manual.xlsx", summary=summary,
            request_id="synthetic-admin-test",
        )
    validated = repo.validate_job_again(
        engine, job_id=job_id, actor_user_id=USER_ID,
        actor_service_principal_id=None, staging_directory=tmp_path,
    )
    assert validated["canPublish"] is True
    published = repo.publish_import_job(
        engine, job_id=job_id, actor_user_id=USER_ID,
        actor_service_principal_id=None, staging_directory=tmp_path,
        idempotency_key="synthetic-admin-idempotency", request_id="synthetic-admin-test",
    )
    assert published["reused"] is False
    with engine.connect() as connection:
        assert connection.execute(text("SELECT submitted_by_user_id FROM import_jobs WHERE job_id=:id"), {"id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == USER_ID
        assert connection.execute(text("SELECT submitted_by_service_principal_id FROM import_jobs WHERE job_id=:id"), {"id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() is None
    engine.dispose()


def test_automatic_contract_pair_remains_source_and_version_allowlisted():
    assert ("no_movement", 2) in allowed_bot_contracts()
    assert ("no_movement", 1) not in allowed_bot_contracts()
    assert ("collection_rate", 2) not in allowed_bot_contracts()


@pytest.mark.parametrize("state", ["VALIDATED", "PUBLISHED", "REUSED"])
def test_machine_status_route_returns_success_for_valid_owned_jobs(state, monkeypatch):
    engine = _engine()
    reused_publication = uuid.uuid4().bytes if state == "REUSED" else None
    job_id, publication_id = _insert_status_job(
        engine, state=state, reused_publication_id=reused_publication,
        publish_as_job=state == "PUBLISHED",
    )
    response = _status_client(engine, monkeypatch).get(f"/api/v2/machine/imports/{job_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == state
    assert body["jobId"] == job_id
    if state in {"PUBLISHED", "REUSED"}:
        assert body["publicationId"] == str(uuid.UUID(bytes=publication_id))
        assert body["version"] == 9
        assert body["reused"] is (state == "REUSED")
    else:
        assert "publicationId" not in body
    engine.dispose()


def test_machine_status_route_hides_jobs_owned_by_another_principal_and_missing_jobs(monkeypatch):
    engine = _engine()
    other_job_id, _ = _insert_status_job(engine, state="PUBLISHED", owner="different-publisher")
    client = _status_client(engine, monkeypatch)

    other_response = client.get(f"/api/v2/machine/imports/{other_job_id}")
    missing_response = client.get("/api/v2/machine/imports/00000000-0000-0000-0000-000000000000")

    assert other_response.status_code == 404
    assert other_response.json()["detail"] == "import_job_not_found"
    assert missing_response.status_code == 404
    assert missing_response.json()["detail"] == "import_job_not_found"
    engine.dispose()


def test_machine_status_route_still_enforces_source_contract_scope(monkeypatch):
    engine = _engine()
    job_id, _ = _insert_status_job(engine, state="VALIDATED")
    with engine.begin() as connection:
        connection.execute(text("UPDATE data_service_principal_contract_scopes SET is_active=0 WHERE source_id='no_movement' AND contract_version=2"))

    response = _status_client(engine, monkeypatch).get(f"/api/v2/machine/imports/{job_id}")

    assert response.status_code == 403
    assert response.json()["detail"] == "service_source_contract_forbidden"
    engine.dispose()
