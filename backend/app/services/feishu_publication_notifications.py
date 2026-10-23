"""Private, opt-in publication notices sent by the NEW BI Feishu application."""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from sqlalchemy import Engine, text

from app.core.config import Settings, get_settings


logger = logging.getLogger(__name__)

RECIPIENT_EMAIL = "Phelippe.cardoso@jtexpress.com.br"
SUPPORTED_SOURCES = {
    "collection_rate": "Taxa de Coleta",
    "pdd_collection_failure": "Falha na Coleta",
    "no_movement": "Sem Movimentação",
}
TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages"
NOTICE_OBJECT_TYPE = "feishu_publication_notice"
NOTICE_RESERVED = "FEISHU_NOTICE_RESERVED"
NOTICE_SENT = "FEISHU_NOTICE_SENT"
NOTICE_FAILED = "FEISHU_NOTICE_FAILED"
NOTICE_PENDING = "FEISHU_NOTICE_PENDING"
HTTP_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
SAO_PAULO_TIMEZONE = timezone(timedelta(hours=-3))


def _sao_paulo_timezone():
    try:
        return ZoneInfo("America/Sao_Paulo")
    except ZoneInfoNotFoundError:
        # Windows development environments may not ship the IANA database.
        return SAO_PAULO_TIMEZONE


def _publication_bytes(publication_id: str | bytes) -> bytes:
    if isinstance(publication_id, bytes):
        if len(publication_id) != 16:
            raise ValueError("invalid publication id")
        return publication_id
    return UUID(publication_id).bytes


def _notice_request_id(publication_id: bytes) -> str:
    return f"feishu-notice:{publication_id.hex()}"


def _format_publication_time(value: Any) -> str:
    """Keep the exact database timestamp without guessing its timezone."""
    if isinstance(value, (datetime, date)):
        return value.strftime("%d/%m/%Y %H:%M:%S") if isinstance(value, datetime) else value.strftime("%d/%m/%Y")
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).strftime("%d/%m/%Y %H:%M:%S")
        except ValueError:
            return value[:32]
    return "não disponível"


def build_publication_notice(
    *, source_id: str, version: int, published_at: Any, now: datetime | None = None
) -> str:
    source_name = SUPPORTED_SOURCES[source_id]
    sao_paulo = _sao_paulo_timezone()
    local_now = now or datetime.now(sao_paulo)
    local_now = local_now.replace(tzinfo=sao_paulo) if local_now.tzinfo is None else local_now.astimezone(sao_paulo)
    greeting = "Bom dia" if local_now.hour < 12 else "Boa tarde"
    return (
        f"{greeting}, Phelippe!\n\n"
        "NEW BI — Atualização concluída.\n"
        f"Painel: {source_name}\n"
        f"Data/hora da publicação (America/Sao_Paulo): {_format_publication_time(published_at)}\n"
        f"Versão publicada: V{version}\n"
        "Status: Publicada\n\n"
        "Acesse: https://new-bi.universojt.com.br"
    )


def _record_outcome(
    engine: Engine,
    *,
    publication_id: bytes,
    actor_user_id: int,
    action_code: str,
    context: dict[str, object],
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("""
                INSERT INTO data_audit_events
                    (actor_user_id, action_code, object_type, object_id, request_id, event_context)
                VALUES
                    (:actor_user_id, :action_code, :object_type, :object_id, :request_id, :event_context)
            """),
            {
                "actor_user_id": actor_user_id,
                "action_code": action_code,
                "object_type": NOTICE_OBJECT_TYPE,
                "object_id": publication_id,
                "request_id": _notice_request_id(publication_id),
                "event_context": json.dumps(context, separators=(",", ":")),
            },
        )


def _reserve_notice(
    engine: Engine,
    *,
    publication_id: bytes,
    source_id: str,
    version: int,
    actor_user_id: int,
) -> tuple[bool, Any | None]:
    """Reserve at most one send. MySQL locks the publication row to serialize workers."""
    lock_clause = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
    published_at_expression = (
        "CONVERT_TZ(published_at, @@session.time_zone, 'America/Sao_Paulo')"
        if engine.dialect.name == "mysql"
        else "published_at"
    )
    with engine.begin() as connection:
        publication = connection.execute(
            text(
                "SELECT source_id, version_no, publication_state, "
                f"{published_at_expression} AS published_at_sao_paulo "
                "FROM source_publications WHERE publication_id = :publication_id" + lock_clause
            ),
            {"publication_id": publication_id},
        ).mappings().first()
        if (
            publication is None
            or publication["source_id"] != source_id
            or int(publication["version_no"]) != version
            or publication["publication_state"] != "PUBLISHED"
        ):
            return False, None

        previous = connection.execute(
            text("""
                SELECT event_context
                FROM data_audit_events
                WHERE request_id = :request_id
                  AND action_code = :action_code
            """),
            {
                "request_id": _notice_request_id(publication_id),
                "action_code": NOTICE_RESERVED,
            },
        ).first()
        if previous is not None:
            return False, publication["published_at_sao_paulo"]

        context = {
            "sourceId": source_id,
            "version": version,
            "recipient": RECIPIENT_EMAIL,
            "status": "PENDING",
        }
        connection.execute(
            text("""
                INSERT INTO data_audit_events
                    (actor_user_id, action_code, object_type, object_id, request_id, event_context)
                VALUES
                    (:actor_user_id, :action_code, :object_type, :object_id, :request_id, :event_context)
            """),
            {
                "actor_user_id": actor_user_id,
                "action_code": NOTICE_RESERVED,
                "object_type": NOTICE_OBJECT_TYPE,
                "object_id": publication_id,
                "request_id": _notice_request_id(publication_id),
                "event_context": json.dumps(context, separators=(",", ":")),
            },
        )
        return True, publication["published_at_sao_paulo"]


def _response_json(response: httpx.Response) -> dict[str, Any]:
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise ValueError("feishu_api_rejected_request")
    return payload


def _send_private_message(message: str, settings: Settings) -> str | None:
    if not settings.feishu_oauth_app_id or not settings.feishu_oauth_app_secret:
        raise ValueError("feishu_application_not_configured")
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        token_response = client.post(
            TOKEN_URL,
            json={"app_id": settings.feishu_oauth_app_id, "app_secret": settings.feishu_oauth_app_secret},
        )
        token_payload = _response_json(token_response)
        token = token_payload.get("tenant_access_token")
        if not isinstance(token, str) or not token:
            raise ValueError("feishu_token_unavailable")

        response = client.post(
            MESSAGE_URL,
            params={"receive_id_type": "email"},
            headers={"Authorization": f"Bearer {token}"},
            json={
                "receive_id": RECIPIENT_EMAIL,
                "msg_type": "text",
                "content": json.dumps({"text": message}, ensure_ascii=False),
            },
        )
        payload = _response_json(response)
        data = payload.get("data")
        message_id = data.get("message_id") if isinstance(data, dict) else None
        if not isinstance(message_id, str) or not message_id:
            raise ValueError("feishu_message_id_unavailable")
        return message_id


def send_publication_notice(
    engine: Engine,
    *,
    publication_id: str,
    source_id: str,
    version: int,
    actor_user_id: int,
    reused: bool = False,
    settings: Settings | None = None,
) -> None:
    """Best-effort post-commit notice; failures never roll back publication."""
    try:
        config = settings or get_settings()
    except Exception as error:
        logger.warning("Feishu publication notice configuration failed (%s)", type(error).__name__)
        return
    if not config.feishu_publication_notifications_enabled:
        return
    if reused or source_id not in SUPPORTED_SOURCES:
        return

    try:
        publication_key = _publication_bytes(publication_id)
        reserved, published_at = _reserve_notice(
            engine,
            publication_id=publication_key,
            source_id=source_id,
            version=version,
            actor_user_id=actor_user_id,
        )
        if not reserved:
            return
    except Exception as error:  # Notification failures must not affect a committed publication.
        logger.warning("Feishu publication notice reservation failed (%s)", type(error).__name__)
        return

    if published_at is None:
        try:
            _record_outcome(
                engine,
                publication_id=publication_key,
                actor_user_id=actor_user_id,
                action_code=NOTICE_PENDING,
                context={
                    "sourceId": source_id,
                    "version": version,
                    "status": "PENDING",
                    "reason": "publication_timezone_conversion_unavailable",
                },
            )
        except Exception:
            logger.error("Feishu publication notice timezone issue could not be audited")
        logger.warning("Feishu publication notice is pending timezone configuration")
        return

    try:
        message_id = _send_private_message(
            build_publication_notice(source_id=source_id, version=version, published_at=published_at), config
        )
    except Exception as error:  # Never log provider payloads, tokens, email addresses, or message content.
        try:
            _record_outcome(
                engine,
                publication_id=publication_key,
                actor_user_id=actor_user_id,
                action_code=NOTICE_FAILED,
                context={"sourceId": source_id, "version": version, "status": "FAILED", "errorType": type(error).__name__},
            )
        except Exception:
            logger.error("Feishu publication notice failure could not be audited")
        logger.warning("Feishu publication notice failed (%s)", type(error).__name__)
        return

    try:
        _record_outcome(
            engine,
            publication_id=publication_key,
            actor_user_id=actor_user_id,
            action_code=NOTICE_SENT,
            context={"sourceId": source_id, "version": version, "status": "SENT", "messageId": message_id},
        )
    except Exception:
        # Reservation remains durable; don't retry an accepted send and risk duplicates.
        logger.error("Feishu accepted a publication notice but its outcome audit failed")
