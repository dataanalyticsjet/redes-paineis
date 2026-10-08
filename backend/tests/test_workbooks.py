from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.services import feishu_auth
from app.services.local_workbooks import HISTORY_KINDS, WORKBOOK_KINDS


@pytest.fixture
def workbook_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, create_user_session) -> TestClient:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("FEISHU_SESSION_SECRET", "test-session-secret-with-at-least-32-chars")
    monkeypatch.setenv("UPLOAD_USERNAME", "test-uploader")
    monkeypatch.setenv("UPLOAD_PASSWORD", "test-upload-password")
    monkeypatch.setenv("DATA_DIRECTORY", str(tmp_path / "local-data"))
    get_settings.cache_clear()
    feishu_auth.reset_temporary_auth_state()
    token, _user = create_user_session(
        name="SPS Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="workbook-admin",
    )
    client = TestClient(app, base_url="http://127.0.0.1:3000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    yield client
    feishu_auth.reset_temporary_auth_state()
    get_settings.cache_clear()


def _authorization() -> str:
    encoded = base64.b64encode(b"test-uploader:test-upload-password").decode("ascii")
    return f"Basic {encoded}"


def _parsed() -> dict[str, object]:
    headers = ["Data", "Regional Origem", "PDD de saída", "Qtd"]
    return {
        "sheetName": "Dados",
        "headers": headers,
        "rows": [
            {"Data": "2026-09-30", "Regional Origem": "SPS", "PDD de saída": "Base 1", "Qtd": 12},
            {"Data": "2026-09-30", "Regional Origem": "RJ", "PDD de saída": "Base 2", "Qtd": 34},
        ],
        "dateColumn": "Data",
        "baseColumn": "PDD de saída",
        "regionColumn": "Regional Origem",
        "statusColumns": ["Qtd"],
        "metadata": {"rowCount": 2},
        "warnings": [],
    }


def _upload(client: TestClient, kind: str, name: str = "dados.xlsx", display_name: str | None = None):
    payload = {"kind": kind, "fileName": display_name or name, "parsed": _parsed()}
    return client.post(
        "/api/workbook",
        data={"payload": json.dumps(payload, ensure_ascii=False)},
        files=[("files", (name, b"PK\x03\x04test-xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))],
    )


def _responsibility_parsed() -> dict[str, object]:
    headers = ["Regional", "UF", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"]
    rows = [
        {"Regional": "SR", "UF": "SC", "Região RM": "SR-SC", "Responsável Rm": "Sean Fan", "Código da base": "001", "Nome da base": "BNU -SC", "Descrição": "Ativa"},
        {"Regional": "SR", "UF": "RS", "Região RM": "SR-RS", "Responsável Rm": "Victor", "Código da base": "002", "Nome da base": "CQA -RS", "Descrição": "Ativa"},
        {"Regional": "PR", "UF": "PR", "Região RM": "PR-CWB", "Responsável Rm": "Diego", "Código da base": "003", "Nome da base": "CWB-PR", "Descrição": "Ativa"},
    ]
    return {"sheetName": "Ativas", "headers": headers, "rows": rows, "metadata": {"rowCount": len(rows)}, "warnings": []}


def _responsibility_upload(client: TestClient, parsed: dict[str, object], file_name: str = "De_para DoomsDay.xlsx"):
    payload = {"kind": "responsibilityList", "fileName": file_name, "parsed": parsed}
    return client.post(
        "/api/workbook/responsibility-list/preview",
        data={"payload": json.dumps(payload, ensure_ascii=False)},
        files=[("files", (file_name, b"PK\x03\x04official-map", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))],
    )


def test_workbook_requires_authenticated_admin_session() -> None:
    with TestClient(app, base_url="http://127.0.0.1:3000") as client:
        assert client.get("/api/workbook?kind=movement").status_code == 401
        assert client.post(
            "/api/workbook",
            json={"kind": "movement", "fileName": "x.xlsx", "parsed": _parsed()},
        ).status_code == 401


def test_workbook_upload_persists_source_and_scopes_reads(workbook_client: TestClient, tmp_path: Path) -> None:
    uploaded = _upload(workbook_client, "movement")
    assert uploaded.status_code == 200
    body = uploaded.json()
    assert body["workbook"]["fileName"] == "dados.xlsx"
    assert body["workbook"]["parsed"]["metadata"]["rowCount"] == 2

    stored = workbook_client.get("/api/workbook?kind=movement")
    assert stored.status_code == 200
    payload = stored.json()["workbook"]["parsed"]
    assert [row["Regional Origem"] for row in payload["rows"]] == ["SPS"]
    assert payload["metadata"]["rowCount"] == 1
    raw_files = list((tmp_path / "local-data" / "workbooks" / "movement").rglob("source-00-dados.xlsx"))
    assert len(raw_files) == 1
    assert raw_files[0].read_bytes().startswith(bytes([0x50, 0x4B, 0x03, 0x04]))


def test_history_workbooks_expose_parts_without_merging_server_logic(workbook_client: TestClient) -> None:
    first = _upload(workbook_client, "taxa", "taxa-setembro.xlsx", "Histórico acumulado · taxa-setembro.xlsx")
    second = _upload(workbook_client, "taxa", "taxa-outubro.xlsx", "Histórico acumulado · 2 arquivos · taxa-outubro.xlsx")
    assert first.status_code == 200
    assert second.status_code == 200

    history = workbook_client.get("/api/workbook?kind=taxa")
    assert history.status_code == 200
    parts = history.json()["historyParts"]
    assert len(parts) == 2
    assert history.json()["fileName"] == "Histórico acumulado · 2 arquivos · taxa-outubro.xlsx"

    part = workbook_client.get(f"/api/workbook?kind=taxa&part={parts[0]}")
    assert part.status_code == 200
    assert part.json()["workbook"]["parsed"]["rows"][0]["Regional Origem"] == "SPS"


def test_matrix_viewer_keeps_the_existing_unscoped_viewer_behavior(workbook_client: TestClient, create_user_session) -> None:
    assert _upload(workbook_client, "movement").status_code == 200
    matrix_token, _user = create_user_session(
        name="Matrix Viewer",
        platform_role="USER",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="workbook-matrix",
    )
    matrix_client = TestClient(app, base_url="http://127.0.0.1:3000")
    matrix_client.cookies.set(feishu_auth.SESSION_COOKIE, matrix_token)

    response = matrix_client.get("/api/workbook?kind=movement")
    assert response.status_code == 200
    assert len(response.json()["workbook"]["parsed"]["rows"]) == 2


def test_base_viewer_is_limited_to_the_configured_base(workbook_client: TestClient, create_user_session) -> None:
    assert _upload(workbook_client, "movement").status_code == 200
    base_token, _user = create_user_session(
        name="Base Viewer",
        platform_role="USER",
        organizational_scope="base",
        home_region=None,
        home_base="Base 1",
        identity_suffix="workbook-base",
    )
    base_client = TestClient(app, base_url="http://127.0.0.1:3000")
    base_client.cookies.set(feishu_auth.SESSION_COOKIE, base_token)

    response = base_client.get("/api/workbook?kind=movement")
    assert response.status_code == 200
    rows = response.json()["workbook"]["parsed"]["rows"]
    assert len(rows) == 1
    assert rows[0]["PDD de saída"] == "Base 1"


def test_responsibility_list_preview_and_publish_use_admin_session_without_basic_auth(workbook_client: TestClient, tmp_path: Path) -> None:
    preview_response = _responsibility_upload(workbook_client, _responsibility_parsed())
    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["canPublish"] is True
    assert preview["rowCount"] == 3
    assert preview["baseCount"] == 3
    assert preview["duplicateBaseCount"] == 0

    published = workbook_client.post("/api/workbook/responsibility-list/publish", json={"previewId": preview["previewId"]})
    assert published.status_code == 200
    assert published.json()["source"]["rowCount"] == 3
    assert published.json()["source"]["regionalCounts"] == {"PR": 1, "SR": 2}

    metadata = workbook_client.get("/api/workbook/responsibility-list")
    assert metadata.status_code == 200
    source = metadata.json()["source"]
    assert source["fileName"] == "De_para DoomsDay.xlsx"
    assert source["publishedAt"] == source["updatedAt"]
    assert source["sheetName"] == "Ativas"
    assert source["versionId"]
    assert source["status"] == "ACTIVE"
    assert source["rowCount"] == 3
    assert source["baseCount"] == 3
    assert source["duplicateBaseCount"] == 0
    current = tmp_path / "local-data" / "workbooks" / "responsibilityList" / "current.json"
    assert current.exists()
    pointer = json.loads(current.read_text(encoding="utf-8"))
    assert source["versionId"] == pointer["latestVersion"]
    stored_bytes = list((current.parent / "versions").rglob("source-00-De_para DoomsDay.xlsx"))
    assert len(stored_bytes) == 1

    replacement = _responsibility_parsed()
    replacement["rows"] = [{**replacement["rows"][0], "Nome da base": "NOVA-BASE-SC"}, *replacement["rows"][1:]]
    staged = _responsibility_upload(workbook_client, replacement, "De_para atualizado.xlsx").json()
    assert staged["canPublish"] is True
    still_active = workbook_client.get("/api/workbook/responsibility-list").json()["source"]
    assert still_active == source

    published_replacement = workbook_client.post(
        "/api/workbook/responsibility-list/publish",
        json={"previewId": staged["previewId"]},
    )
    assert published_replacement.status_code == 200
    refreshed = workbook_client.get("/api/workbook/responsibility-list").json()["source"]
    assert refreshed["fileName"] == "De_para atualizado.xlsx"
    assert refreshed["versionId"] != source["versionId"]


def test_responsibility_list_duplicate_bases_block_publishing(workbook_client: TestClient) -> None:
    parsed = _responsibility_parsed()
    parsed["rows"] = [*parsed["rows"], {**parsed["rows"][0], "Nome da base": " BNU-SC "}]
    response = _responsibility_upload(workbook_client, parsed)
    assert response.status_code == 200
    assert response.json()["duplicateBaseCount"] == 1
    assert response.json()["canPublish"] is False
    assert response.json()["previewId"] is None


def test_regular_user_cannot_preview_responsibility_list(create_user_session) -> None:
    token, _user = create_user_session(
        name="Regional Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="responsibility-user",
    )
    client = TestClient(app, base_url="http://127.0.0.1:3000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    response = _responsibility_upload(client, _responsibility_parsed())
    assert response.status_code == 403


def test_all_existing_workbook_kinds_use_local_storage(workbook_client: TestClient, create_user_session) -> None:
    matrix_token, _user = create_user_session(
        name="All kinds matrix",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="workbook-all-matrix",
    )
    matrix_client = TestClient(app, base_url="http://127.0.0.1:3000")
    matrix_client.cookies.set(feishu_auth.SESSION_COOKIE, matrix_token)

    for kind in sorted(WORKBOOK_KINDS):
        assert _upload(matrix_client, kind, f"{kind}.xlsx").status_code == 200
        response = matrix_client.get(f"/api/workbook?kind={kind}")
        assert response.status_code == 200
        if kind in HISTORY_KINDS:
            parts = response.json()["historyParts"]
            assert len(parts) == 1
            response = matrix_client.get(f"/api/workbook?kind={kind}&part={parts[0]}")
        assert response.status_code == 200
        assert len(response.json()["workbook"]["parsed"]["rows"]) == 2


def test_legacy_upload_auth_remains_available_but_admin_session_publishes_without_it(workbook_client: TestClient) -> None:
    response = workbook_client.post("/api/upload-auth", headers={"Authorization": _authorization()})
    assert response.status_code == 200
    assert response.json() == {"authenticated": True}

    published = _upload(workbook_client, "movement")
    assert published.status_code == 200


@pytest.mark.parametrize("authorization", [None, "Bearer invalid", "Basic !!!", "Basic d3Jvbmc6cGFzcw=="])
def test_upload_auth_rejects_missing_malformed_or_wrong_credentials(
    workbook_client: TestClient,
    authorization: str | None,
) -> None:
    headers = {"Authorization": authorization} if authorization else {}
    response = workbook_client.post("/api/upload-auth", headers=headers)
    assert response.status_code == 401


def test_upload_auth_reports_missing_local_configuration(
    workbook_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("UPLOAD_USERNAME")
    monkeypatch.delenv("UPLOAD_PASSWORD")
    get_settings.cache_clear()

    response = workbook_client.post("/api/upload-auth", headers={"Authorization": _authorization()})
    assert response.status_code == 503
