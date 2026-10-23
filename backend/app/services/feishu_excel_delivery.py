"""Manual, publication-verified Excel delivery to the approved Feishu test group."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import zipfile
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import Engine, text

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
FILES_URL = "https://open.feishu.cn/open-apis/im/v1/files"
MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages"
TEST_GROUP_NAME = "J&T Data - Third World War"
TEST_GROUP_CHAT_ID = "oc_45fb4ce3efe1c73dc4f3d62a92855bf5"
SUPPORTED_SOURCES = {"collection_rate", "pdd_collection_failure", "no_movement"}
MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
OBJECT_TYPE = "feishu_excel_delivery"
ACTION_RESERVED = "FEISHU_XLSX_RESERVED"
ACTION_SENT = "FEISHU_XLSX_SENT"
ACTION_FAILED = "FEISHU_XLSX_FAILED"
ACTION_PENDING = "FEISHU_XLSX_PENDING"


class FeishuExcelDeliveryError(ValueError):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _publication_bytes(publication_id: str) -> bytes:
    try:
        return UUID(publication_id).bytes
    except (ValueError, TypeError, AttributeError):
        raise FeishuExcelDeliveryError("publication_id_invalid", 422) from None


def _validate_xlsx(file_name: str, content: bytes) -> str:
    if not isinstance(file_name, str):
        raise FeishuExcelDeliveryError("xlsx_file_extension_required", 422)
    basename = file_name.replace("\\", "/").rsplit("/", 1)[-1]
    if (
        basename != file_name
        or len(basename) > 255
        or any(ord(char) < 32 for char in basename)
        or not basename.lower().endswith(".xlsx")
    ):
        raise FeishuExcelDeliveryError("xlsx_file_extension_required", 422)
    if not content:
        raise FeishuExcelDeliveryError("xlsx_file_empty", 400)
    if len(content) > MAX_FILE_BYTES:
        raise FeishuExcelDeliveryError("xlsx_file_too_large", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as workbook:
            names = set(workbook.namelist())
            if (
                "[Content_Types].xml" not in names
                or "xl/workbook.xml" not in names
                or not any(name.startswith("xl/worksheets/") and name.endswith(".xml") for name in names)
                or sum(info.file_size for info in workbook.infolist()) > MAX_UNCOMPRESSED_BYTES
                or workbook.testzip() is not None
            ):
                raise FeishuExcelDeliveryError("xlsx_integrity_invalid", 422)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise FeishuExcelDeliveryError("xlsx_integrity_invalid", 422) from None
    return hashlib.sha256(content).hexdigest()


def _audit(
    engine: Engine,
    *,
    publication_id: bytes,
    actor_user_id: int,
    action: str,
    request_id: str,
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
                "action_code": action,
                "object_type": OBJECT_TYPE,
                "object_id": publication_id,
                "request_id": request_id,
                "event_context": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
            },
        )


def _reserve(
    engine: Engine,
    *,
    publication_id: bytes,
    source_id: str,
    file_name: str,
    file_sha256: str,
    actor_user_id: int,
) -> tuple[bool, str]:
    request_id = f"feishu-xlsx:{publication_id.hex()}:{TEST_GROUP_CHAT_ID}"
    lock_clause = " FOR UPDATE" if engine.dialect.name == "mysql" else ""
    with engine.begin() as connection:
        publication = connection.execute(
            text("""
                SELECT source_id, publication_state, file_sha256
                FROM source_publications
                WHERE publication_id = :publication_id
            """ + lock_clause),
            {"publication_id": publication_id},
        ).mappings().first()
        if publication is None or publication["source_id"] != source_id:
            raise FeishuExcelDeliveryError("published_source_not_found", 404)
        if publication["publication_state"] != "PUBLISHED":
            raise FeishuExcelDeliveryError("publication_not_published", 409)
        expected_hash = publication["file_sha256"]
        expected_hash = bytes(expected_hash).hex() if expected_hash is not None else ""
        if expected_hash != file_sha256:
            raise FeishuExcelDeliveryError("xlsx_does_not_match_publication", 422)
        previous = connection.execute(
            text("""
                SELECT 1 FROM data_audit_events
                WHERE request_id = :request_id AND action_code = :action_code
                LIMIT 1
            """),
            {"request_id": request_id, "action_code": ACTION_RESERVED},
        ).first()
        if previous is not None:
            return False, request_id
        context = {
            "recipient": TEST_GROUP_CHAT_ID,
            "recipientName": TEST_GROUP_NAME,
            "sourceId": source_id,
            "fileName": file_name,
            "publicationId": publication_id.hex(),
            "uploadResult": "PENDING",
            "sendResult": "PENDING",
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
                "action_code": ACTION_RESERVED,
                "object_type": OBJECT_TYPE,
                "object_id": publication_id,
                "request_id": request_id,
                "event_context": json.dumps(context, ensure_ascii=False, separators=(",", ":")),
            },
        )
    return True, request_id


def _response_json(response: httpx.Response) -> dict[str, Any]:
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise ValueError("feishu_api_rejected_request")
    return payload


def send_test_group_excel(
    engine: Engine,
    *,
    source_id: str,
    publication_id: str,
    file_name: str,
    content: bytes,
    actor_user_id: int,
    settings: Settings | None = None,
) -> dict[str, object]:
    """Manually send one publication-matched workbook to the fixed test group.

    This function is never called by publication hooks. A durable reservation is
    written before network calls; uncertain outcomes are not retried automatically.
    """
    config = settings or get_settings()
    if not config.feishu_excel_test_delivery_enabled:
        raise FeishuExcelDeliveryError("feishu_excel_delivery_disabled", 503)
    if not config.feishu_oauth_app_id or not config.feishu_oauth_app_secret:
        raise FeishuExcelDeliveryError("feishu_application_not_configured", 503)
    if source_id not in SUPPORTED_SOURCES:
        raise FeishuExcelDeliveryError("feishu_excel_source_not_supported", 422)

    file_sha256 = _validate_xlsx(file_name, content)
    publication_key = _publication_bytes(publication_id)
    reserved, request_id = _reserve(
        engine,
        publication_id=publication_key,
        source_id=source_id,
        file_name=file_name,
        file_sha256=file_sha256,
        actor_user_id=actor_user_id,
    )
    if not reserved:
        raise FeishuExcelDeliveryError("feishu_excel_delivery_already_attempted", 409)

    phase = "token"
    upload_result = "NOT_STARTED"
    send_result = "NOT_STARTED"
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            token_response = client.post(
                TOKEN_URL,
                json={"app_id": config.feishu_oauth_app_id, "app_secret": config.feishu_oauth_app_secret},
            )
            token_payload = _response_json(token_response)
            token = token_payload.get("tenant_access_token")
            if not isinstance(token, str) or not token:
                raise ValueError("feishu_token_unavailable")
            headers = {"Authorization": f"Bearer {token}"}

            phase = "upload"
            upload_response = client.post(
                FILES_URL,
                headers=headers,
                data={"file_type": "stream", "file_name": file_name},
                files={"file": (file_name, io.BytesIO(content), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
            upload_payload = _response_json(upload_response)
            upload_data = upload_payload.get("data")
            file_key = upload_data.get("file_key") if isinstance(upload_data, dict) else None
            if not isinstance(file_key, str) or not file_key:
                raise ValueError("feishu_file_key_unavailable")
            upload_result = "SUCCEEDED"

            phase = "send"
            message_response = client.post(
                MESSAGE_URL,
                params={"receive_id_type": "chat_id"},
                headers=headers,
                json={
                    "receive_id": TEST_GROUP_CHAT_ID,
                    "msg_type": "file",
                    "content": json.dumps({"file_key": file_key}, separators=(",", ":")),
                },
            )
            message_payload = _response_json(message_response)
            message_data = message_payload.get("data")
            message_id = message_data.get("message_id") if isinstance(message_data, dict) else None
            if not isinstance(message_id, str) or not message_id:
                raise ValueError("feishu_message_id_unavailable")
            send_result = "SUCCEEDED"

        _audit(
            engine,
            publication_id=publication_key,
            actor_user_id=actor_user_id,
            action=ACTION_SENT,
            request_id=request_id,
            context={
                "recipient": TEST_GROUP_CHAT_ID,
                "recipientName": TEST_GROUP_NAME,
                "sourceId": source_id,
                "fileName": file_name,
                "publicationId": str(UUID(publication_id)),
                "uploadResult": upload_result,
                "sendResult": send_result,
                "messageId": message_id,
                "status": "SENT",
            },
        )
        return {
            "status": "SENT",
            "recipient": TEST_GROUP_CHAT_ID,
            "recipientName": TEST_GROUP_NAME,
            "sourceId": source_id,
            "fileName": file_name,
            "publicationId": str(UUID(publication_id)),
            "messageId": message_id,
        }
    except Exception as error:
        # Once upload starts, a timeout/rejection may still have been accepted.
        # Mark it pending and keep the reservation to prevent duplicate messages.
        ambiguous = phase in {"upload", "send"}
        action = ACTION_PENDING if ambiguous else ACTION_FAILED
        try:
            _audit(
                engine,
                publication_id=publication_key,
                actor_user_id=actor_user_id,
                action=action,
                request_id=request_id,
                context={
                    "recipient": TEST_GROUP_CHAT_ID,
                    "recipientName": TEST_GROUP_NAME,
                    "sourceId": source_id,
                    "fileName": file_name,
                    "publicationId": str(UUID(publication_id)),
                    "uploadResult": upload_result if upload_result != "NOT_STARTED" else ("UNKNOWN" if phase == "upload" else "NOT_STARTED"),
                    "sendResult": send_result if send_result != "NOT_STARTED" else ("UNKNOWN" if phase == "send" else "NOT_STARTED"),
                    "status": "PENDING" if ambiguous else "FAILED",
                    "errorType": type(error).__name__,
                },
            )
        except Exception:
            logger.error("Feishu Excel delivery outcome could not be audited")
        logger.warning("Feishu Excel delivery %s (%s)", "pending" if ambiguous else "failed", type(error).__name__)
        raise FeishuExcelDeliveryError(
            "feishu_excel_delivery_pending" if ambiguous else "feishu_excel_delivery_failed", 502
        ) from None
