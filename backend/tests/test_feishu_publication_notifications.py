from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from fastapi import BackgroundTasks
from starlette.requests import Request
from sqlalchemy import create_engine, text

from app.api import data_foundation as data_foundation_api
from app.core.config import Settings
from app.services import feishu_publication_notifications as notices


def _engine():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE source_publications (
                publication_id BLOB PRIMARY KEY, source_id TEXT, version_no INTEGER,
                publication_state TEXT, published_at TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE data_audit_events (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER,
                action_code TEXT, object_type TEXT, object_id BLOB, request_id TEXT,
                event_context TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
    return engine


def _publication(engine, *, source_id="collection_rate", state="PUBLISHED"):
    publication_id = uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO source_publications
                (publication_id, source_id, version_no, publication_state, published_at)
            VALUES (:id, :source, 7, :state, '2026-10-23 14:32:11')
        """), {"id": publication_id.bytes, "source": source_id, "state": state})
    return publication_id


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("http error")

    def json(self):
        return self._payload


class _FeishuClient:
    calls = []
    message_payload = {"code": 0, "data": {"message_id": "om_test_message"}}

    def __init__(self, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if url == notices.TOKEN_URL:
            return _Response({"code": 0, "tenant_access_token": "test-token"})
        return _Response(self.message_payload)


def _enabled_settings():
    return Settings(
        feishu_publication_notifications_enabled=True,
        feishu_oauth_app_id="test-app-id",
        feishu_oauth_app_secret="test-app-secret",
    )


def test_notice_is_private_to_fixed_email_and_uses_publication_metadata(monkeypatch):
    engine = _engine()
    publication = _publication(engine)
    monkeypatch.setattr(notices.httpx, "Client", _FeishuClient)
    _FeishuClient.calls = []

    notices.send_publication_notice(
        engine,
        publication_id=str(publication),
        source_id="collection_rate",
        version=7,
        actor_user_id=42,
        settings=_enabled_settings(),
    )

    assert len(_FeishuClient.calls) == 2
    token_call, message_call = _FeishuClient.calls
    assert token_call[0] == notices.TOKEN_URL
    assert message_call[0] == notices.MESSAGE_URL
    assert message_call[1]["params"] == {"receive_id_type": "email"}
    assert message_call[1]["json"]["receive_id"] == "Phelippe.cardoso@jtexpress.com.br"
    content = json.loads(message_call[1]["json"]["content"])["text"]
    assert "Taxa de Coleta" in content
    assert "23/10/2026 14:32:11" in content
    assert "Versão publicada: V7" in content
    assert "https://new-bi.universojt.com.br" in content
    assert "tenant_access_token" not in content

    with engine.connect() as connection:
        actions = connection.execute(text("SELECT action_code FROM data_audit_events ORDER BY audit_id")).scalars().all()
        sent = connection.execute(text("SELECT event_context FROM data_audit_events WHERE action_code=:action"), {"action": notices.NOTICE_SENT}).scalar_one()
    assert actions == [notices.NOTICE_RESERVED, notices.NOTICE_SENT]
    assert json.loads(sent)["messageId"] == "om_test_message"


def test_notice_deduplicates_even_when_worker_runs_again(monkeypatch):
    engine = _engine()
    publication = _publication(engine, source_id="no_movement")
    monkeypatch.setattr(notices.httpx, "Client", _FeishuClient)
    _FeishuClient.calls = []
    args = dict(
        publication_id=str(publication), source_id="no_movement", version=7,
        actor_user_id=42, settings=_enabled_settings(),
    )

    notices.send_publication_notice(engine, **args)
    notices.send_publication_notice(engine, **args)

    assert len(_FeishuClient.calls) == 2
    with engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM data_audit_events WHERE action_code=:action"), {"action": notices.NOTICE_RESERVED}).scalar_one() == 1


def test_disabled_or_reused_publications_never_call_feishu(monkeypatch):
    engine = _engine()
    publication = _publication(engine)
    monkeypatch.setattr(notices.httpx, "Client", _FeishuClient)
    _FeishuClient.calls = []
    common = dict(publication_id=str(publication), source_id="collection_rate", version=7, actor_user_id=42)

    disabled = Settings()
    assert disabled.feishu_publication_notifications_enabled is False
    notices.send_publication_notice(engine, **common, settings=disabled)
    notices.send_publication_notice(engine, **common, reused=True, settings=_enabled_settings())

    assert _FeishuClient.calls == []
    with engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM data_audit_events")).scalar_one() == 0


def test_feature_flag_uses_explicit_environment_setting(monkeypatch):
    monkeypatch.setenv("FEISHU_PUBLICATION_NOTIFICATIONS_ENABLED", "true")
    assert Settings().feishu_publication_notifications_enabled is True


def test_unsupported_and_non_published_sources_are_skipped(monkeypatch):
    engine = _engine()
    unsupported = _publication(engine, source_id="collection_monitoring")
    aborted = _publication(engine, source_id="pdd_collection_failure", state="ABORTED")
    monkeypatch.setattr(notices.httpx, "Client", _FeishuClient)
    _FeishuClient.calls = []
    settings = _enabled_settings()

    notices.send_publication_notice(engine, publication_id=str(unsupported), source_id="collection_monitoring", version=7, actor_user_id=42, settings=settings)
    notices.send_publication_notice(engine, publication_id=str(aborted), source_id="pdd_collection_failure", version=7, actor_user_id=42, settings=settings)

    assert _FeishuClient.calls == []


def test_failed_send_is_recorded_and_is_not_retried(monkeypatch):
    engine = _engine()
    publication = _publication(engine, source_id="pdd_collection_failure")

    class FailingClient(_FeishuClient):
        def post(self, url, **kwargs):
            if url == notices.TOKEN_URL:
                self.calls.append((url, kwargs))
                return _Response({"code": 0, "tenant_access_token": "test-token"})
            self.calls.append((url, kwargs))
            return _Response({"code": 999, "msg": "private provider detail"})

    FailingClient.calls = []
    monkeypatch.setattr(notices.httpx, "Client", FailingClient)
    args = dict(
        publication_id=str(publication), source_id="pdd_collection_failure", version=7,
        actor_user_id=42, settings=_enabled_settings(),
    )

    notices.send_publication_notice(engine, **args)
    call_count = len(FailingClient.calls)
    notices.send_publication_notice(engine, **args)

    assert call_count == 2 and len(FailingClient.calls) == call_count
    with engine.connect() as connection:
        contexts = connection.execute(text("SELECT event_context FROM data_audit_events")).scalars().all()
    assert [json.loads(context)["status"] for context in contexts] == ["PENDING", "FAILED"]
    assert all("private provider detail" not in context for context in contexts)


def test_greeting_and_display_name_are_dynamic():
    morning = notices.build_publication_notice(
        source_id="no_movement", version=2, published_at=datetime(2026, 10, 23, 8, 1, 2),
        now=datetime(2026, 10, 23, 9, 0, 0),
    )
    afternoon = notices.build_publication_notice(
        source_id="pdd_collection_failure", version=3, published_at="2026-10-23 13:00:00",
        now=datetime(2026, 10, 23, 14, 0, 0),
    )
    assert morning.startswith("Bom dia, Phelippe!") and "Sem Movimentação" in morning
    assert afternoon.startswith("Boa tarde, Phelippe!") and "Falha na Coleta" in afternoon


def _publish_route(monkeypatch, *, source_id, publication, enabled=True):
    monkeypatch.setattr(data_foundation_api, "_require_feature", lambda **_kwargs: None)
    monkeypatch.setattr(data_foundation_api, "_same_origin", lambda _request: None)
    monkeypatch.setattr(data_foundation_api, "_engine", lambda: object())
    monkeypatch.setattr(data_foundation_api, "get_settings", lambda: SimpleNamespace(
        data_import_staging_directory=Path("/tmp/test-staging"),
        feishu_publication_notifications_enabled=enabled,
    ))
    monkeypatch.setattr(data_foundation_api, "get_job_status", lambda *_args, **_kwargs: {"sourceId": source_id})
    monkeypatch.setattr(data_foundation_api, "publish_import_job", lambda *_args, **_kwargs: publication)
    request = Request({"type": "http", "method": "POST", "path": "/publish", "headers": [], "query_string": b""})
    return data_foundation_api.publish_import(
        "job-id", request, BackgroundTasks(), idempotency_key="test-idempotency-key",
        admin=SimpleNamespace(user=SimpleNamespace(id=42)),
    )


def test_publish_endpoint_schedules_only_fresh_supported_publications(monkeypatch):
    tasks = []
    monkeypatch.setattr(data_foundation_api.BackgroundTasks, "add_task", lambda self, func, *args, **kwargs: tasks.append((func, args, kwargs)))
    response = _publish_route(
        monkeypatch,
        source_id="pdd_collection_failure",
        publication={"publicationId": str(uuid.uuid4()), "version": 8, "reused": False},
    )

    assert response["version"] == 8
    assert len(tasks) == 1
    assert tasks[0][0] is notices.send_publication_notice
    assert tasks[0][2]["source_id"] == "pdd_collection_failure"
    assert tasks[0][2]["actor_user_id"] == 42


def test_publish_endpoint_does_not_schedule_reused_unsupported_or_disabled(monkeypatch):
    tasks = []
    monkeypatch.setattr(data_foundation_api.BackgroundTasks, "add_task", lambda self, func, *args, **kwargs: tasks.append(func))
    monkeypatch.setattr(data_foundation_api, "queue_t4t5_publication", lambda *_args, **_kwargs: {"queued": True})
    for source_id, publication, enabled in (
        ("collection_rate", {"publicationId": str(uuid.uuid4()), "version": 8, "reused": True}, True),
        ("collection_monitoring_t4_t5", {"publicationId": str(uuid.uuid4()), "version": 8, "reused": False}, True),
        ("no_movement", {"publicationId": str(uuid.uuid4()), "version": 8, "reused": False}, False),
    ):
        _publish_route(monkeypatch, source_id=source_id, publication=publication, enabled=enabled)

    assert notices.send_publication_notice not in tasks


def test_timezone_conversion_pending_does_not_send_or_retry(monkeypatch):
    engine = _engine()
    publication = _publication(engine)
    monkeypatch.setattr(notices, "_reserve_notice", lambda *_args, **_kwargs: (True, None))
    monkeypatch.setattr(notices.httpx, "Client", _FeishuClient)
    _FeishuClient.calls = []

    notices.send_publication_notice(
        engine, publication_id=str(publication), source_id="collection_rate", version=7,
        actor_user_id=42, settings=_enabled_settings(),
    )

    assert _FeishuClient.calls == []
    with engine.connect() as connection:
        pending = connection.execute(
            text("SELECT event_context FROM data_audit_events WHERE action_code=:action"),
            {"action": notices.NOTICE_PENDING},
        ).scalar_one()
    assert json.loads(pending)["reason"] == "publication_timezone_conversion_unavailable"
