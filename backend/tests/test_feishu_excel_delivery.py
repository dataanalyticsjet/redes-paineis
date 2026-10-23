from __future__ import annotations

import io
import json
import uuid
import zipfile
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from app.api import data_foundation as data_foundation_api
from app.core.config import Settings
from app.services import feishu_excel_delivery as delivery


def _xlsx() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as workbook:
        workbook.writestr("[Content_Types].xml", "<Types/>")
        workbook.writestr("xl/workbook.xml", "<workbook/>")
        workbook.writestr("xl/worksheets/sheet1.xml", "<worksheet/>")
    return output.getvalue()


def _engine(content: bytes | None = None, *, source_id: str = "collection_rate", state: str = "PUBLISHED"):
    engine = create_engine("sqlite://")
    content = content if content is not None else _xlsx()
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE source_publications (
                publication_id BLOB PRIMARY KEY, source_id TEXT, version_no INTEGER,
                publication_state TEXT, file_sha256 BLOB
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE data_audit_events (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER,
                action_code TEXT, object_type TEXT, object_id BLOB, request_id TEXT,
                event_context TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        publication_id = uuid.uuid4()
        connection.execute(text("""
            INSERT INTO source_publications
                (publication_id, source_id, version_no, publication_state, file_sha256)
            VALUES (:id, :source_id, 1, :state, :sha256)
        """), {
            "id": publication_id.bytes,
            "source_id": source_id,
            "state": state,
            "sha256": __import__("hashlib").sha256(content).digest(),
        })
    return engine, publication_id, content


class _Response:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("http error")

    def json(self):
        return self.payload


class _FeishuClient:
    calls = []
    upload_payload = {"code": 0, "data": {"file_key": "file_key_test"}}
    message_payload = {"code": 0, "data": {"message_id": "om_excel_test"}}

    def __init__(self, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url == delivery.TOKEN_URL:
            return _Response({"code": 0, "tenant_access_token": "mock-token"})
        if url == delivery.FILES_URL:
            return _Response(self.upload_payload)
        return _Response(self.message_payload)


def _settings(enabled=True):
    return Settings(
        feishu_excel_test_delivery_enabled=enabled,
        feishu_oauth_app_id="app-id-test",
        feishu_oauth_app_secret="app-secret-test",
    )


def _send(engine, publication_id, content, **kwargs):
    return delivery.send_test_group_excel(
        engine,
        source_id=kwargs.pop("source_id", "collection_rate"),
        publication_id=str(publication_id),
        file_name=kwargs.pop("file_name", "taxa_coleta.xlsx"),
        content=content,
        actor_user_id=42,
        settings=kwargs.pop("settings", _settings()),
        **kwargs,
    )


def test_upload_and_file_message_use_fixed_test_group_and_audit_result(monkeypatch):
    engine, publication_id, content = _engine()
    _FeishuClient.calls = []
    monkeypatch.setattr(delivery.httpx, "Client", _FeishuClient)

    result = _send(engine, publication_id, content)

    assert result["status"] == "SENT"
    assert result["recipient"] == delivery.TEST_GROUP_CHAT_ID
    assert result["recipientName"] == delivery.TEST_GROUP_NAME
    assert result["messageId"] == "om_excel_test"
    token_call, upload_call, message_call = _FeishuClient.calls
    assert token_call[0] == delivery.TOKEN_URL
    assert upload_call[0] == delivery.FILES_URL
    assert upload_call[1]["data"] == {"file_type": "stream", "file_name": "taxa_coleta.xlsx"}
    assert upload_call[1]["headers"] == {"Authorization": "Bearer mock-token"}
    assert upload_call[1]["files"]["file"][0] == "taxa_coleta.xlsx"
    assert upload_call[1]["files"]["file"][1].read() == content
    assert message_call[0] == delivery.MESSAGE_URL
    assert message_call[1]["params"] == {"receive_id_type": "chat_id"}
    assert message_call[1]["json"]["receive_id"] == delivery.TEST_GROUP_CHAT_ID
    assert message_call[1]["json"]["msg_type"] == "file"
    assert json.loads(message_call[1]["json"]["content"]) == {"file_key": "file_key_test"}
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT action_code, event_context FROM data_audit_events ORDER BY audit_id")).all()
    assert [row.action_code for row in rows] == [delivery.ACTION_RESERVED, delivery.ACTION_SENT]
    audit = json.loads(rows[-1].event_context)
    assert audit["sourceId"] == "collection_rate"
    assert audit["fileName"] == "taxa_coleta.xlsx"
    assert audit["publicationId"] == str(publication_id)
    assert audit["uploadResult"] == audit["sendResult"] == "SUCCEEDED"
    assert audit["messageId"] == "om_excel_test"
    assert "mock-token" not in rows[-1].event_context


@pytest.mark.parametrize(
    ("file_name", "content", "error_code"),
    [
        ("taxa_coleta.csv", b"not xlsx", "xlsx_file_extension_required"),
        ("taxa_coleta.xlsx", b"", "xlsx_file_empty"),
        ("taxa_coleta.xlsx", b"PK\x03\x04broken", "xlsx_integrity_invalid"),
    ],
)
def test_invalid_files_are_rejected_before_reservation(monkeypatch, file_name, content, error_code):
    engine, publication_id, _ = _engine()
    _FeishuClient.calls = []
    monkeypatch.setattr(delivery.httpx, "Client", _FeishuClient)

    with pytest.raises(delivery.FeishuExcelDeliveryError, match=error_code):
        _send(engine, publication_id, content, file_name=file_name)

    assert _FeishuClient.calls == []
    with engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM data_audit_events")).scalar_one() == 0


def test_file_above_30mb_is_rejected(monkeypatch):
    engine, publication_id, _ = _engine()
    _FeishuClient.calls = []
    monkeypatch.setattr(delivery.httpx, "Client", _FeishuClient)

    with pytest.raises(delivery.FeishuExcelDeliveryError, match="xlsx_file_too_large"):
        _send(engine, publication_id, b"x" * (delivery.MAX_FILE_BYTES + 1))

    assert _FeishuClient.calls == []


def test_disabled_flag_and_unsupported_source_do_not_call_feishu(monkeypatch):
    engine, publication_id, content = _engine()
    _FeishuClient.calls = []
    monkeypatch.setattr(delivery.httpx, "Client", _FeishuClient)

    with pytest.raises(delivery.FeishuExcelDeliveryError, match="feishu_excel_delivery_disabled"):
        _send(engine, publication_id, content, settings=_settings(False))
    with pytest.raises(delivery.FeishuExcelDeliveryError, match="feishu_excel_source_not_supported"):
        _send(engine, publication_id, content, source_id="collection_monitoring")

    assert _FeishuClient.calls == []


def test_publication_hash_and_state_are_verified(monkeypatch):
    engine, publication_id, content = _engine()
    _FeishuClient.calls = []
    monkeypatch.setattr(delivery.httpx, "Client", _FeishuClient)

    with pytest.raises(delivery.FeishuExcelDeliveryError, match="xlsx_does_not_match_publication"):
        _send(engine, publication_id, _xlsx() + b"different")
    aborted_engine, aborted_id, aborted_content = _engine(state="ABORTED")
    with pytest.raises(delivery.FeishuExcelDeliveryError, match="publication_not_published"):
        _send(aborted_engine, aborted_id, aborted_content)

    assert _FeishuClient.calls == []


def test_failed_or_ambiguous_delivery_is_never_resent(monkeypatch):
    engine, publication_id, content = _engine()
    _FeishuClient.calls = []

    class AmbiguousClient(_FeishuClient):
        def post(self, url, **kwargs):
            self.calls.append((url, kwargs))
            if url == delivery.TOKEN_URL:
                return _Response({"code": 0, "tenant_access_token": "mock-token"})
            raise TimeoutError("simulated timeout")

    monkeypatch.setattr(delivery.httpx, "Client", AmbiguousClient)
    with pytest.raises(delivery.FeishuExcelDeliveryError, match="feishu_excel_delivery_pending"):
        _send(engine, publication_id, content)
    call_count = len(AmbiguousClient.calls)
    with pytest.raises(delivery.FeishuExcelDeliveryError, match="feishu_excel_delivery_already_attempted"):
        _send(engine, publication_id, content)
    assert len(AmbiguousClient.calls) == call_count
    with engine.connect() as connection:
        actions = connection.execute(text("SELECT action_code FROM data_audit_events ORDER BY audit_id")).scalars().all()
    assert actions == [delivery.ACTION_RESERVED, delivery.ACTION_PENDING]


def test_feishu_api_rejection_is_sanitized_and_audited(monkeypatch):
    engine, publication_id, content = _engine()
    _FeishuClient.calls = []

    class RejectedClient(_FeishuClient):
        def post(self, url, **kwargs):
            self.calls.append((url, kwargs))
            if url == delivery.TOKEN_URL:
                return _Response({"code": 0, "tenant_access_token": "mock-token"})
            return _Response({"code": 999, "msg": "private provider details"})

    monkeypatch.setattr(delivery.httpx, "Client", RejectedClient)
    with pytest.raises(delivery.FeishuExcelDeliveryError, match="feishu_excel_delivery_pending"):
        _send(engine, publication_id, content)
    with engine.connect() as connection:
        contexts = connection.execute(text("SELECT event_context FROM data_audit_events")).scalars().all()
    assert all("private provider details" not in item for item in contexts)


def test_source_hash_matches_the_publication_not_a_filename_or_client_group():
    # Client-supplied filenames and recipients are never accepted as provenance or routing.
    assert delivery.TEST_GROUP_CHAT_ID == "oc_45fb4ce3efe1c73dc4f3d62a92855bf5"
    assert "recipient" not in delivery.send_test_group_excel.__annotations__


def test_excel_flag_is_disabled_by_default_and_separate_from_publication_alerts():
    settings = Settings()
    assert settings.feishu_excel_test_delivery_enabled is False
    assert settings.feishu_publication_notifications_enabled is False


def test_excel_delivery_flag_is_independent_from_publication_alert_flag(monkeypatch):
    monkeypatch.setenv("FEISHU_EXCEL_TEST_DELIVERY_ENABLED", "true")
    settings = Settings()
    assert settings.feishu_excel_test_delivery_enabled is True
    assert settings.feishu_publication_notifications_enabled is False


def test_manual_endpoint_requires_matrix_admin_and_rejects_missing_file():
    route = next(
        route for route in data_foundation_api.router.routes
        if isinstance(route, APIRoute) and route.path == "/v2/feishu/excel-test-delivery"
    )
    assert any(dependency.call is data_foundation_api.require_matrix_admin for dependency in route.dependant.dependencies)
    assert any(field.name == "file" and field.field_info.is_required() for field in route.dependant.body_params)
    app = FastAPI()
    app.include_router(data_foundation_api.router)
    app.dependency_overrides[data_foundation_api.require_matrix_admin] = lambda: SimpleNamespace(
        user=SimpleNamespace(id=42)
    )
    response = TestClient(app).post(
        "/v2/feishu/excel-test-delivery",
        data={"source_id": "collection_rate", "publication_id": str(uuid.uuid4())},
    )
    assert response.status_code == 422
