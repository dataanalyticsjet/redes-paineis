from __future__ import annotations

import hashlib
import hmac
import threading
import time
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.services.data_foundation.contracts import CONTRACT_VERSIONS

_rate_limit_lock = threading.Lock()
_credential_requests: dict[str, list[float]] = {}
_MAX_REQUESTS_PER_MINUTE = 120


@dataclass(frozen=True)
class ServicePrincipal:
    principal_id: str
    credential_id: str


def allowed_bot_contracts() -> frozenset[tuple[str, int]]:
    return frozenset({
        ("no_movement", 2),
        ("pdd_collection_failure", 2),
        ("collection_rate", 3),
        ("collection_monitoring", 2),
    })


def authenticate_service_principal(connection: Connection, bearer_token: str) -> ServicePrincipal | None:
    if not bearer_token or len(bearer_token) > 512:
        return None
    token_hash = hashlib.sha256(bearer_token.encode("utf-8")).digest()
    db_now = "CURRENT_TIMESTAMP(6)" if connection.dialect.name == "mysql" else "CURRENT_TIMESTAMP"
    row = connection.execute(text(f"""
        SELECT credential.credential_id, credential.token_sha256, principal.service_principal_id
        FROM data_service_principal_credentials AS credential
        JOIN data_service_principals AS principal
          ON principal.service_principal_id = credential.service_principal_id
        WHERE credential.token_sha256 = :token_hash
          AND credential.is_active = 1
          AND credential.revoked_at IS NULL
          AND (credential.expires_at IS NULL OR credential.expires_at > {db_now})
          AND principal.is_active = 1
        LIMIT 1
    """), {"token_hash": token_hash}).mappings().first()
    if row is None or not hmac.compare_digest(bytes(row["token_sha256"]), token_hash):
        return None
    now = time.monotonic()
    credential_id = str(row["credential_id"])
    with _rate_limit_lock:
        recent = [stamp for stamp in _credential_requests.get(credential_id, []) if now - stamp < 60]
        if len(recent) >= _MAX_REQUESTS_PER_MINUTE:
            _credential_requests[credential_id] = recent
            return None
        recent.append(now)
        _credential_requests[credential_id] = recent
    connection.execute(text(f"""
        UPDATE data_service_principal_credentials
        SET last_used_at = {db_now}
        WHERE credential_id = :credential_id
    """), {"credential_id": row["credential_id"]})
    return ServicePrincipal(str(row["service_principal_id"]), credential_id)


def principal_can_publish(
    connection: Connection,
    principal_id: str,
    source_id: str,
    contract_version: int,
) -> bool:
    if (source_id, contract_version) not in allowed_bot_contracts():
        return False
    if (source_id, contract_version) not in CONTRACT_VERSIONS:
        return False
    return connection.execute(text("""
        SELECT 1
        FROM data_service_principal_contract_scopes
        WHERE service_principal_id = :principal_id
          AND source_id = :source_id
          AND contract_version = :contract_version
          AND is_active = 1
        LIMIT 1
    """), {
        "principal_id": principal_id,
        "source_id": source_id,
        "contract_version": contract_version,
    }).first() is not None
