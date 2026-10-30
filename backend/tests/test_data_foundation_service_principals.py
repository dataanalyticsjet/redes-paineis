from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, text

from app.services.data_foundation.service_principals import (
    authenticate_service_principal,
    allowed_bot_contracts,
    principal_can_publish,
)


def _engine():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE data_service_principals (
                service_principal_id TEXT PRIMARY KEY, is_active INTEGER NOT NULL
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE data_service_principal_credentials (
                credential_id TEXT PRIMARY KEY, service_principal_id TEXT,
                token_sha256 BLOB UNIQUE, is_active INTEGER, expires_at TEXT,
                revoked_at TEXT, last_used_at TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE data_service_principal_contract_scopes (
                service_principal_id TEXT, source_id TEXT, contract_version INTEGER,
                is_active INTEGER, PRIMARY KEY(service_principal_id, source_id, contract_version)
            )
        """)
    return engine


def _seed(engine, token="secret-token", *, active=1, principal_active=1, expires_at=None, revoked_at=None):
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO data_service_principals VALUES ('windows-bots', :active)"), {"active": principal_active})
        connection.execute(text("""
            INSERT INTO data_service_principal_credentials
              (credential_id, service_principal_id, token_sha256, is_active, expires_at, revoked_at)
            VALUES ('credential-1', 'windows-bots', :digest, :active, :expires, :revoked)
        """), {
            "digest": hashlib.sha256(token.encode()).digest(), "active": active,
            "expires": expires_at, "revoked": revoked_at,
        })
        for source_id, version in allowed_bot_contracts():
            connection.execute(text("""
                INSERT INTO data_service_principal_contract_scopes VALUES ('windows-bots', :source, :version, 1)
            """), {"source": source_id, "version": version})


def test_active_credential_authenticates_and_records_last_used():
    engine = _engine()
    _seed(engine)
    with engine.begin() as connection:
        principal = authenticate_service_principal(connection, "secret-token")
        assert principal is not None
        assert principal.principal_id == "windows-bots"
        assert connection.execute(text("SELECT last_used_at FROM data_service_principal_credentials")).scalar_one() is not None


def test_invalid_or_rotated_token_is_rejected():
    engine = _engine()
    _seed(engine)
    with engine.begin() as connection:
        assert authenticate_service_principal(connection, "wrong-token") is None
        assert authenticate_service_principal(connection, "") is None


def test_revoked_credential_is_rejected():
    engine = _engine()
    _seed(engine, active=0)
    with engine.begin() as connection:
        assert authenticate_service_principal(connection, "secret-token") is None


def test_revoked_principal_is_rejected():
    engine = _engine()
    _seed(engine, principal_active=0)
    with engine.begin() as connection:
        assert authenticate_service_principal(connection, "secret-token") is None


def test_expired_credential_is_rejected():
    engine = _engine()
    _seed(engine, expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).replace(tzinfo=None).isoformat(sep=" "))
    with engine.begin() as connection:
        assert authenticate_service_principal(connection, "secret-token") is None


def test_only_allowlisted_source_contract_pairs_can_be_granted():
    assert allowed_bot_contracts() == frozenset({
        ("no_movement", 2), ("pdd_collection_failure", 2),
        ("collection_rate", 3), ("collection_monitoring", 2),
        ("collection_monitoring_t4_t5", 2),
    })
    assert ("collection_monitoring_t4_t5", 1) not in allowed_bot_contracts()
    assert ("collection_monitoring_t4_t5", 2) in allowed_bot_contracts()
    assert ("collection_rate", 2) not in allowed_bot_contracts()


def test_scope_requires_exact_source_version_and_active_grant():
    engine = _engine()
    _seed(engine)
    with engine.connect() as connection:
        assert principal_can_publish(connection, "windows-bots", "collection_rate", 3)
        assert not principal_can_publish(connection, "windows-bots", "collection_rate", 2)
        assert not principal_can_publish(connection, "windows-bots", "collection_monitoring_t4_t5", 1)
        assert principal_can_publish(connection, "windows-bots", "collection_monitoring_t4_t5", 2)
    with engine.begin() as connection:
        connection.execute(text("UPDATE data_service_principal_contract_scopes SET is_active=0 WHERE source_id='collection_rate'"))
        connection.execute(text("UPDATE data_service_principal_contract_scopes SET is_active=0 WHERE source_id='collection_monitoring_t4_t5' AND contract_version=2"))
    with engine.connect() as connection:
        assert not principal_can_publish(connection, "windows-bots", "collection_rate", 3)
