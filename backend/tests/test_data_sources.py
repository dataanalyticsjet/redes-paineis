from __future__ import annotations

import pytest
import json
from pathlib import Path
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.services import data_sources, feishu_auth
from app.services.local_workbooks import data_root, save_dashboard_source, save_workbook
from app.services.data_sources import TAXA_REQUIRED_HEADERS


@pytest.fixture
def authenticated_client(monkeypatch: pytest.MonkeyPatch, tmp_path, create_user_session) -> TestClient:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    monkeypatch.setenv("FEISHU_SESSION_SECRET", "test-session-secret-with-at-least-32-chars")
    monkeypatch.setenv("FEISHU_OAUTH_ENABLED", "true")
    monkeypatch.setenv("FEISHU_OAUTH_APP_ID", "test-app")
    monkeypatch.setenv("FEISHU_OAUTH_APP_SECRET", "test-secret")
    monkeypatch.setenv("FEISHU_OAUTH_REDIRECT_URI", "http://127.0.0.1:8000/api/auth/feishu/callback")
    monkeypatch.setenv("FEISHU_VIEWER_ACCOUNTS_JSON", "[]")
    monkeypatch.setenv("DATA_DIRECTORY", str(tmp_path / "local-data"))
    get_settings.cache_clear()
    feishu_auth.reset_temporary_auth_state()
    data_sources.reset_temporary_data_sources()

    token, _user = create_user_session(
        name="Example Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="source-admin",
    )
    client = TestClient(app, base_url="http://localhost:3000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    yield client
    data_sources.reset_temporary_data_sources()
    feishu_auth.reset_temporary_auth_state()
    get_settings.cache_clear()


def parsed_monitoring_workbook() -> dict[str, object]:
    headers = ["Data", "Regional Origem", "PDD de saída", "Origem do Pedido", "dorp off应揽收"]
    return {
        "sheetName": "JMS",
        "headers": headers,
        "rows": [
            {"Data": "2026-09-30", "Regional Origem": "SPS", "PDD de saída": "Base SPS 1", "Origem do Pedido": "TikTok", "dorp off应揽收": 25},
            {"Data": "2026-09-30", "Regional Origem": "RJ", "PDD de saída": "Base RJ 1", "Origem do Pedido": "TEMU", "dorp off应揽收": 50},
        ],
        "dateColumn": "Data",
        "baseColumn": "PDD de saída",
        "regionColumn": "Regional Origem",
        "originColumn": "Origem do Pedido",
        "statusColumn": None,
        "statusColumns": ["dorp off应揽收"],
        "metadata": {
            "sheetNames": ["JMS"],
            "headerRow": 1,
            "rowCount": 2,
            "columnCount": len(headers),
            "columns": [],
            "date1904": False,
            "dateRange": {"min": "2026-09-30", "max": "2026-09-30"},
        },
        "warnings": [],
    }


def parsed_taxa_workbook() -> dict[str, object]:
    headers = list(TAXA_REQUIRED_HEADERS)
    rows = []
    for region, base in [("SPS", "Base SPS 1"), ("RJ", "Base RJ 1")]:
        row = {header: 1 for header in headers}
        row.update({
            "Horário de término do prazo de coleta": "2026-09-30",
            "Nome da regional": region,
            "Nome da base de coleta": base,
            "Origem do Pedido": "TikTok",
            "Tipo de produto": "Demonstração",
        })
        rows.append(row)
    return {
        "sheetName": "sheet0",
        "headers": headers,
        "rows": rows,
        "dateColumn": "Horário de término do prazo de coleta",
        "baseColumn": "Nome da base de coleta",
        "regionColumn": "Nome da regional",
        "originColumn": "Origem do Pedido",
        "statusColumn": None,
        "statusColumns": [],
        "metadata": {"sheetNames": ["sheet0"], "headerRow": 1, "rowCount": 2, "columnCount": len(headers), "columns": [], "date1904": False},
        "warnings": [],
    }


def parsed_responsibility_workbook() -> dict[str, object]:
    headers = ["Regional", "UF", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"]
    rows = [
        {"Regional": "SR", "UF": "SC", "Região RM": "SR-SC", "Responsável Rm": "Sean Fan", "Código da base": "SC1", "Nome da base": "BNU -SC", "Descrição": "Ativa"},
        {"Regional": "SR", "UF": "RS", "Região RM": "SR-RS", "Responsável Rm": "Victor", "Código da base": "RS1", "Nome da base": "CQA -RS", "Descrição": "Ativa"},
        {"Regional": "PR", "UF": "PR", "Região RM": "PR-CWB", "Responsável Rm": "Diego", "Código da base": "PR1", "Nome da base": "CWB-PR", "Descrição": "Ativa"},
    ]
    return {"sheetName": "Ativas", "headers": headers, "rows": rows, "metadata": {"rowCount": len(rows)}, "warnings": []}


def parsed_seller_monitoring_workbook() -> dict[str, object]:
    headers = [
        "Data", "Regional Origem", "PDD de saida", "Cliente", "Loja", "Id Seller/remetente",
        "Motorista Designado", "Origem do Pedido", "Status atual – Aguardando coleta",
        "Status atual – Recebido no Drop-off", "Status atual – Coletado", "Status atual – Recebido",
        "Status atual – Recebido na base", "当前状态-网点发件流程中", "Status atual – Chegou ao SC",
    ]
    rows = []
    for region, base, code in [("PR", "BNU -SC", "S"), ("PR", "CQA -RS", "R"), ("PR", "CWB-PR", "P")]:
        row = {header: 0 for header in headers}
        row.update({
            "Data": "2026-10-06", "Regional Origem": region, "PDD de saida": base,
            "Cliente": "Client", "Loja": "Store", "Id Seller/remetente": code,
            "Motorista Designado": "Driver", "Origem do Pedido": "TikTok",
            "Status atual – Aguardando coleta": 5,
            "Status atual – Recebido no Drop-off": 1,
            "Status atual – Coletado": 2,
            "Status atual – Recebido": 0,
            "Status atual – Recebido na base": 3,
            "当前状态-网点发件流程中": 4,
            "Status atual – Chegou ao SC": 6,
        })
        rows.append(row)
    return {
        "sheetName": "sheet1", "headers": headers, "rows": rows,
        "dateColumn": "Data", "baseColumn": "PDD de saida", "regionColumn": "Regional Origem",
        "originColumn": "Origem do Pedido", "statusColumns": headers[8:],
        "metadata": {"rowCount": len(rows)}, "warnings": [],
    }


def test_seller_monitoring_source_keeps_canonical_national_history_before_regional_scope(
    authenticated_client: TestClient,
    create_user_session,
) -> None:
    """A regional admin's preview/read must not truncate the published J&T source."""
    responsibility = parsed_responsibility_workbook()
    save_workbook(data_root(get_settings().data_directory), "responsibilityList", "De_para DoomsDay.xlsx", responsibility)

    pr_token, _pr_user = create_user_session(
        name="PR Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="PR",
        identity_suffix="seller-source-pr-admin",
    )
    pr_client = _session_client(pr_token)
    incoming = parsed_seller_monitoring_workbook()
    payload = {
        "fileName": "monitoramento-jt.xlsx",
        "fileSizeBytes": 4,
        "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "parsed": incoming,
    }
    preview_response = pr_client.post(
        "/api/data-sources/sellerPerformance/preview",
        data={"payload": json.dumps(payload, ensure_ascii=False)},
        files={"file": ("monitoramento-jt.xlsx", b"PK\x03\x04", payload["contentType"])},
    )
    assert preview_response.status_code == 200
    preview_body = preview_response.json()
    assert preview_body["rowCount"] == 1
    assert preview_body["history"]["fileRowCount"] == 1
    assert preview_body["history"]["resultingRows"] == 1

    published = pr_client.post(
        "/api/data-sources/sellerPerformance/import",
        json={"previewId": preview_body["previewId"]},
    )
    assert published.status_code == 200
    assert published.json()["rowCount"] == 1

    owner_key = data_sources.create_published_source_key("sellerPerformance", get_settings().feishu_session_secret)
    canonical = data_sources.get_dashboard_source("sellerPerformance", owner_key)
    assert canonical is not None
    assert canonical["rowCount"] == 3
    assert [row["Regional Origem"] for row in canonical["parsed"]["rows"]] == ["SR", "SR", "PR"]

    pr_read = pr_client.get("/api/data-sources/sellerPerformance").json()["source"]
    assert [row["PDD de saida"] for row in pr_read["parsed"]["rows"]] == ["CWB-PR"]

    sr_token, _sr_user = create_user_session(
        name="SR Viewer",
        organizational_scope="regional",
        home_region="SR",
        identity_suffix="seller-source-sr-viewer",
    )
    sr_source = _session_client(sr_token).get("/api/data-sources/sellerPerformance").json()["source"]
    assert {row["Regional Origem"] for row in sr_source["parsed"]["rows"]} == {"SR"}
    assert {row["PDD de saida"] for row in sr_source["parsed"]["rows"]} == {"BNU -SC", "CQA -RS"}

    matrix_token, _matrix_user = create_user_session(
        name="Matrix Viewer",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="seller-source-matrix-viewer",
    )
    matrix_source = _session_client(matrix_token).get("/api/data-sources/sellerPerformance").json()["source"]
    assert matrix_source["rowCount"] == 3
    assert {row["Regional Origem"] for row in matrix_source["parsed"]["rows"]} == {"PR", "SR"}


def test_seller_monitoring_merge_recanonicalizes_existing_dates_before_import(
    authenticated_client: TestClient,
) -> None:
    responsibility = parsed_responsibility_workbook()
    save_workbook(data_root(get_settings().data_directory), "responsibilityList", "De_para DoomsDay.xlsx", responsibility)

    owner_key = data_sources.create_published_source_key("sellerPerformance", get_settings().feishu_session_secret)
    previous = parsed_seller_monitoring_workbook()
    for row in previous["rows"]:
        row["Data"] = "2026-10-05"
    save_dashboard_source(
        data_root(get_settings().data_directory),
        "sellerPerformance",
        owner_key,
        "legacy-jt.xlsx",
        previous,
        b"PK\x03\x04",
        imported_at="2026-10-05T00:00:00+00:00",
        file_size_bytes=4,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        period={"start": "2026-10-05", "end": "2026-10-05"},
        row_count=3,
    )

    incoming = parsed_seller_monitoring_workbook()
    payload = {
        "fileName": "monitoramento-jt-06.xlsx",
        "fileSizeBytes": 4,
        "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "parsed": incoming,
    }
    preview_response = authenticated_client.post(
        "/api/data-sources/sellerPerformance/preview",
        data={"payload": json.dumps(payload, ensure_ascii=False)},
        files={"file": ("monitoramento-jt-06.xlsx", b"PK\x03\x04", payload["contentType"])},
    )
    assert preview_response.status_code == 200
    imported = authenticated_client.post(
        "/api/data-sources/sellerPerformance/import",
        json={"previewId": preview_response.json()["previewId"]},
    )
    assert imported.status_code == 200

    canonical = data_sources.get_dashboard_source("sellerPerformance", owner_key)
    assert canonical is not None
    assert canonical["rowCount"] == 6
    old_rows = [row for row in canonical["parsed"]["rows"] if row["Data"] == "2026-10-05"]
    assert [(row["PDD de saida"], row["Regional Origem"]) for row in old_rows] == [
        ("BNU -SC", "SR"),
        ("CQA -RS", "SR"),
        ("CWB-PR", "PR"),
    ]


def _session_client(token: str) -> TestClient:
    client = TestClient(app, base_url="http://localhost:3000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    return client


def preview(client: TestClient, parsed: dict[str, object] | None = None, file_name: str = "monitoramento.xlsx"):
    return client.post(
        "/api/data-sources/monitoring/preview",
        json={
            "fileName": file_name,
            "fileSizeBytes": 2048,
            "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "parsed": parsed or parsed_monitoring_workbook(),
        },
    )


def preview_taxa(client: TestClient, parsed: dict[str, object] | None = None):
    return client.post(
        "/api/data-sources/taxa/preview",
        json={
            "fileName": "taxa-coleta.xlsx",
            "fileSizeBytes": 2048,
            "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "parsed": parsed or parsed_taxa_workbook(),
        },
    )


def taxa_with_dates(first_date: str, second_date: str) -> dict[str, object]:
    parsed = parsed_taxa_workbook()
    parsed["rows"][0]["Horário de término do prazo de coleta"] = first_date
    parsed["rows"][1]["Horário de término do prazo de coleta"] = second_date
    return parsed


def taxa_national_snapshot(
    dated_regions: list[tuple[str, str]],
    *,
    base_prefix: str = "Base",
) -> dict[str, object]:
    parsed = parsed_taxa_workbook()
    rows = []
    for date, region in dated_regions:
        row = {header: 1 for header in parsed["headers"]}
        row.update({
            "Horário de término do prazo de coleta": date,
            "Nome da regional": region,
            "Nome da base de coleta": f"{base_prefix} {region} {date}",
            "Origem do Pedido": "TikTok",
            "Tipo de produto": "Pacote",
        })
        rows.append(row)
    parsed["rows"] = rows
    parsed["metadata"]["rowCount"] = len(rows)
    return parsed


def test_data_source_api_requires_feishu_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    monkeypatch.setenv("DEV_AUTH_BYPASS", "true")
    monkeypatch.setenv("DATA_DIRECTORY", str(tmp_path / "production-data"))
    get_settings.cache_clear()
    with TestClient(app, base_url="http://localhost:3000") as client:
        response = client.get("/api/data-sources/monitoring")
    get_settings.cache_clear()

    assert response.status_code == 401


def test_data_sources_disabled_returns_not_found_even_with_a_session(
    authenticated_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "false")
    get_settings.cache_clear()

    response = authenticated_client.get("/api/data-sources/monitoring")

    assert response.status_code == 404
    assert response.json()["detail"] == "local_data_sources_only"


def test_data_sources_can_be_enabled_in_production_with_a_feishu_session(
    authenticated_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    monkeypatch.setenv("DATA_DIRECTORY", str(tmp_path / "production-data"))
    get_settings.cache_clear()

    response = preview(authenticated_client)

    assert response.status_code == 200
    assert response.json()["canImport"] is True


def test_matrix_user_data_source_preview_is_not_region_filtered(
    authenticated_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    create_user_session,
) -> None:
    monkeypatch.setenv("FEISHU_VIEWER_ACCOUNTS_JSON", json.dumps([{
        "email": "matrix@example.test",
        "tenant_key": "tenant-test",
        "role": "regional",
        "region": " matriz ",
    }]))
    monkeypatch.setenv("ALLOWED_CORPORATE_DOMAINS", "example.test")
    get_settings.cache_clear()

    get_settings()
    matrix_token, _user = create_user_session(
        name="Matrix Admin",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="source-matrix",
    )
    authenticated_client.cookies.set(feishu_auth.SESSION_COOKIE, matrix_token)
    me = authenticated_client.get("/api/auth/me")
    response = preview(authenticated_client)

    assert me.status_code == 200
    assert me.json()["role"] == "matrix"
    assert me.json()["region"] is None
    assert me.json()["base"] is None
    assert me.json()["platform_role"] == "ADMIN"
    assert me.json()["organizational_scope"] == "matrix"
    assert response.status_code == 200
    assert response.json()["rowCount"] == 2


def test_regional_user_data_source_preview_keeps_only_its_region(
    authenticated_client: TestClient,
) -> None:
    response = preview(authenticated_client)

    assert response.status_code == 200
    assert response.json()["rowCount"] == 1

    imported = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": response.json()["previewId"]},
    )

    assert imported.status_code == 200
    rows = imported.json()["parsed"]["rows"]
    assert len(rows) == 1
    assert rows[0]["Regional Origem"] == "SPS"


def test_preview_import_get_and_remove_are_local_and_scoped(authenticated_client: TestClient) -> None:
    preview_response = preview(authenticated_client)
    assert preview_response.status_code == 200
    preview_payload = preview_response.json()
    assert preview_payload["canImport"] is True
    assert preview_payload["rowCount"] == 1
    assert preview_payload["period"] == {"start": "2026-09-30", "end": "2026-09-30"}
    assert {field["classification"] for field in preview_payload["fields"]} == {"required", "optional"}

    imported = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": preview_payload["previewId"]},
    )
    assert imported.status_code == 200
    source = imported.json()
    assert source["sourceType"] == "MANUAL_UPLOAD"
    assert source["rowCount"] == 1
    assert source["parsed"]["rows"][0]["Regional Origem"] == "SPS"

    current = authenticated_client.get("/api/data-sources/monitoring")
    assert current.status_code == 200
    assert current.json()["source"]["fileName"] == "monitoramento.xlsx"

    removed = authenticated_client.delete("/api/data-sources/monitoring")
    assert removed.status_code == 204
    assert authenticated_client.get("/api/data-sources/monitoring").json() == {"source": None}


def test_taxa_source_uses_its_own_local_store_and_applies_user_scope(authenticated_client: TestClient) -> None:
    preview_response = preview_taxa(authenticated_client)
    assert preview_response.status_code == 200
    preview_payload = preview_response.json()
    assert preview_payload["canImport"] is True
    assert preview_payload["rowCount"] == 1
    assert preview_payload["period"] == {"start": "2026-09-30", "end": "2026-09-30"}
    assert len([field for field in preview_payload["fields"] if field["classification"] == "required" and field["present"]]) == 22

    imported = authenticated_client.post(
        "/api/data-sources/taxa/import",
        json={"previewId": preview_payload["previewId"]},
    )
    assert imported.status_code == 200
    source = imported.json()
    assert source["fileName"] == "taxa-coleta.xlsx"
    assert len(source["parsed"]["rows"]) == 1
    assert source["parsed"]["rows"][0]["Nome da regional"] == "SPS"
    assert authenticated_client.get("/api/data-sources/taxa").json()["source"]["fileName"] == "taxa-coleta.xlsx"
    assert authenticated_client.get("/api/data-sources/monitoring").json() == {"source": None}

    removed = authenticated_client.delete("/api/data-sources/taxa")
    assert removed.status_code == 204
    assert authenticated_client.get("/api/data-sources/taxa").json() == {"source": None}


def test_unconfigured_and_unknown_dashboards_are_rejected(authenticated_client: TestClient) -> None:
    unconfigured = authenticated_client.get("/api/data-sources/epop")
    unknown = authenticated_client.get("/api/data-sources/not-a-dashboard")

    assert unconfigured.status_code == 409
    assert unconfigured.json()["detail"] == "data_source_dashboard_unconfigured"
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "data_source_dashboard_not_found"


def test_published_data_source_is_shared_but_scoped_for_each_session(
    authenticated_client: TestClient,
    create_user_session,
) -> None:
    preview_payload = preview(authenticated_client).json()
    imported = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": preview_payload["previewId"]},
    )
    cross_dashboard = authenticated_client.post(
        "/api/data-sources/taxa/import",
        json={"previewId": preview_payload["previewId"]},
    )

    other_token, _other_user = create_user_session(
        name="RJ Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="RJ",
        identity_suffix="source-rj-viewer",
    )
    other_client = TestClient(app, base_url="http://localhost:3000")
    other_client.cookies.set(feishu_auth.SESSION_COOKIE, other_token)
    other_source = other_client.get("/api/data-sources/monitoring")
    cross_session = other_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": preview_payload["previewId"]},
    )

    assert imported.status_code == 200
    assert cross_dashboard.status_code == 404
    assert cross_dashboard.json()["detail"] == "data_source_preview_not_found"
    assert other_source.status_code == 200
    assert len(other_source.json()["source"]["parsed"]["rows"]) == 1
    assert other_source.json()["source"]["parsed"]["rows"][0]["Regional Origem"] == "RJ"
    assert cross_session.status_code == 403


def test_import_replaces_only_the_current_dashboard_source(authenticated_client: TestClient) -> None:
    first_preview = preview(authenticated_client).json()
    first_import = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": first_preview["previewId"]},
    )
    second_preview = preview(authenticated_client, file_name="monitoramento-atualizado.xlsx").json()
    second_import = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": second_preview["previewId"]},
    )

    assert first_import.status_code == 200
    assert second_import.status_code == 200
    assert authenticated_client.get("/api/data-sources/monitoring").json()["source"]["fileName"] == "monitoramento-atualizado.xlsx"
    assert authenticated_client.get("/api/data-sources/taxa").json() == {"source": None}


def test_uploaded_xlsx_and_source_survive_preview_service_reset(
    authenticated_client: TestClient,
    tmp_path: Path,
    create_user_session,
) -> None:
    xlsx = bytes([0x50, 0x4B, 0x03, 0x04]) + b"local-xlsx"
    payload = {
        "fileName": "monitoramento.xlsx",
        "fileSizeBytes": len(xlsx),
        "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "parsed": parsed_monitoring_workbook(),
    }
    response = authenticated_client.post(
        "/api/data-sources/monitoring/preview",
        data={"payload": json.dumps(payload, ensure_ascii=False)},
        files={"file": ("monitoramento.xlsx", xlsx, payload["contentType"])},
    )
    assert response.status_code == 200
    preview_payload = response.json()
    same_identity_token, _user = create_user_session(
        name="Example Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="source-admin",
    )
    same_identity_client = TestClient(app, base_url="http://localhost:3000")
    same_identity_client.cookies.set(feishu_auth.SESSION_COOKIE, same_identity_token)
    cross_session_preview = same_identity_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": preview_payload["previewId"]},
    )
    assert cross_session_preview.status_code == 404
    imported = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": preview_payload["previewId"]},
    )
    assert imported.status_code == 200
    # Simulate an API process restart: preview state is cleared, while the
    # committed dataset and source workbook remain available to a new session.
    data_sources.reset_temporary_data_sources()
    new_token, _user = create_user_session(
        name="Example Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="source-admin",
    )
    reauthenticated = TestClient(app, base_url="http://localhost:3000")
    reauthenticated.cookies.set(feishu_auth.SESSION_COOKIE, new_token)
    current = reauthenticated.get("/api/data-sources/monitoring")
    assert current.status_code == 200
    assert current.json()["source"]["parsed"]["rows"][0]["Regional Origem"] == "SPS"
    assert any((tmp_path / "local-data" / "sources").rglob("source-00-monitoramento.xlsx"))


def test_invalid_taxa_contract_keeps_previous_local_source(authenticated_client: TestClient) -> None:
    valid = preview_taxa(authenticated_client).json()
    imported = authenticated_client.post("/api/data-sources/taxa/import", json={"previewId": valid["previewId"]})
    assert imported.status_code == 200

    invalid = parsed_taxa_workbook()
    invalid["headers"] = [header for header in invalid["headers"] if header != "Taxa de coleta no prazo"]
    for row in invalid["rows"]:
        row.pop("Taxa de coleta no prazo", None)
    result = preview_taxa(authenticated_client, invalid)
    assert result.status_code == 200
    assert result.json()["canImport"] is False
    assert "Taxa de coleta no prazo" in result.json()["missingFields"]
    assert authenticated_client.get("/api/data-sources/taxa").json()["source"]["fileName"] == "taxa-coleta.xlsx"


def test_taxa_history_preview_publish_and_reupload_follow_date_snapshot_rules(
    authenticated_client: TestClient,
    create_user_session,
) -> None:
    matrix_token, _matrix_user = create_user_session(
        name="Matrix Admin",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="taxa-history-matrix-admin",
    )
    matrix_client = TestClient(app, base_url="http://localhost:3000")
    matrix_client.cookies.set(feishu_auth.SESSION_COOKIE, matrix_token)

    first_preview = preview_taxa(matrix_client, taxa_with_dates("2026-10-01", "2026-10-02")).json()
    assert first_preview["history"]["newDates"] == ["2026-10-01", "2026-10-02"]
    assert first_preview["history"]["replacedDates"] == []
    assert first_preview["history"]["fileRowCount"] == 2
    assert first_preview["history"]["resultingRows"] == 2
    first_import = matrix_client.post("/api/data-sources/taxa/import", json={"previewId": first_preview["previewId"]})
    assert first_import.status_code == 200
    assert len(first_import.json()["parsed"]["rows"]) == 2

    update = taxa_with_dates("2026-10-02", "2026-10-03")
    second_preview = preview_taxa(matrix_client, update).json()
    assert second_preview["history"]["newDates"] == ["2026-10-03"]
    assert second_preview["history"]["replacedDates"] == ["2026-10-02"]
    assert second_preview["history"]["resultingRows"] == 3
    second_import = matrix_client.post("/api/data-sources/taxa/import", json={"previewId": second_preview["previewId"]})
    assert second_import.status_code == 200
    assert [row["Horário de término do prazo de coleta"] for row in second_import.json()["parsed"]["rows"]] == [
        "2026-10-01", "2026-10-02", "2026-10-03",
    ]

    reupload_preview = preview_taxa(matrix_client, update).json()
    assert reupload_preview["history"]["newDates"] == []
    assert reupload_preview["history"]["replacedDates"] == ["2026-10-02", "2026-10-03"]
    reupload = matrix_client.post("/api/data-sources/taxa/import", json={"previewId": reupload_preview["previewId"]})
    assert reupload.status_code == 200
    assert len(reupload.json()["parsed"]["rows"]) == 3

    regional_token, _regional_user = create_user_session(
        name="SPS Viewer",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="taxa-history-sps-viewer",
    )
    regional_client = TestClient(app, base_url="http://localhost:3000")
    regional_client.cookies.set(feishu_auth.SESSION_COOKIE, regional_token)
    regional_source = regional_client.get("/api/data-sources/taxa").json()["source"]
    assert {row["Nome da regional"] for row in regional_source["parsed"]["rows"]} == {"SPS"}
    assert len(regional_source["parsed"]["rows"]) == 2

    additional_region_token, _additional_user = create_user_session(
        name="SPS and RJ Viewer",
        organizational_scope="regional",
        home_region="SPS",
        additional_regions=["RJ"],
        identity_suffix="taxa-history-sps-rj-viewer",
    )
    additional_region_client = TestClient(app, base_url="http://localhost:3000")
    additional_region_client.cookies.set(feishu_auth.SESSION_COOKIE, additional_region_token)
    additional_source = additional_region_client.get("/api/data-sources/taxa").json()["source"]
    assert {row["Nome da regional"] for row in additional_source["parsed"]["rows"]} == {"SPS", "RJ"}
    assert len(additional_source["parsed"]["rows"]) == 3

    user_token, _user = create_user_session(
        name="Read-only Viewer",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="taxa-history-read-only-viewer",
    )
    user_client = TestClient(app, base_url="http://localhost:3000")
    user_client.cookies.set(feishu_auth.SESSION_COOKIE, user_token)
    assert user_client.get("/api/data-sources/taxa").status_code == 200
    denied_preview = preview_taxa(user_client)
    assert denied_preview.status_code == 403
    assert denied_preview.json()["detail"] == "admin_required"


def test_regional_admin_taxa_publication_and_history_keep_canonical_national_dataset(
    authenticated_client: TestClient,
    create_user_session,
) -> None:
    """Scoped preview/read responses must never truncate the shared published history."""
    admin_token, _admin_user = create_user_session(
        name="São Paulo Leste Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="taxa-history-regional-admin-spe",
    )
    authenticated_client.cookies.set(feishu_auth.SESSION_COOKIE, admin_token)

    first_national_file = taxa_national_snapshot([
        ("2026-10-01", "SPE"),
        ("2026-10-01", "MG"),
        ("2026-10-01", "RJ"),
        ("2026-10-02", "SPE"),
        ("2026-10-02", "MG"),
        ("2026-10-02", "RJ"),
    ])
    first_preview = preview_taxa(authenticated_client, first_national_file).json()
    assert first_preview["rowCount"] == 2
    assert first_preview["history"]["fileRowCount"] == 2
    assert first_preview["history"]["resultingRows"] == 2

    first_import = authenticated_client.post(
        "/api/data-sources/taxa/import",
        json={"previewId": first_preview["previewId"]},
    )
    assert first_import.status_code == 200
    assert {row["Nome da regional"] for row in first_import.json()["parsed"]["rows"]} == {"SPE"}

    replacement_national_file = taxa_national_snapshot([
        ("2026-10-02", "SPE"),
        ("2026-10-02", "MG"),
        ("2026-10-02", "RJ"),
        ("2026-10-03", "SPE"),
        ("2026-10-03", "MG"),
        ("2026-10-03", "RJ"),
    ], base_prefix="Replacement")
    second_preview = preview_taxa(authenticated_client, replacement_national_file).json()
    assert second_preview["rowCount"] == 2
    assert second_preview["history"]["fileRowCount"] == 2
    assert second_preview["history"]["replacedDates"] == ["2026-10-02"]
    assert second_preview["history"]["newDates"] == ["2026-10-03"]
    assert second_preview["history"]["resultingRows"] == 3

    second_import = authenticated_client.post(
        "/api/data-sources/taxa/import",
        json={"previewId": second_preview["previewId"]},
    )
    assert second_import.status_code == 200
    assert len(second_import.json()["parsed"]["rows"]) == 3
    assert {row["Nome da regional"] for row in second_import.json()["parsed"]["rows"]} == {"SPE"}

    owner_key = data_sources.create_published_source_key("taxa", get_settings().feishu_session_secret)
    canonical_source = data_sources.get_dashboard_source("taxa", owner_key)
    assert canonical_source is not None
    canonical_rows = canonical_source["parsed"]["rows"]
    assert len(canonical_rows) == 9
    assert {row["Nome da regional"] for row in canonical_rows} == {"SPE", "MG", "RJ"}
    assert {
        date: sum(row["Horário de término do prazo de coleta"] == date for row in canonical_rows)
        for date in ("2026-10-01", "2026-10-02", "2026-10-03")
    } == {"2026-10-01": 3, "2026-10-02": 3, "2026-10-03": 3}
    assert all(
        row["Nome da base de coleta"].startswith("Replacement")
        for row in canonical_rows
        if row["Horário de término do prazo de coleta"] == "2026-10-02"
    )
    assert all(
        row["Nome da base de coleta"].startswith("Base")
        for row in canonical_rows
        if row["Horário de término do prazo de coleta"] == "2026-10-01"
    )

    scoped_source = authenticated_client.get("/api/data-sources/taxa").json()["source"]
    assert len(scoped_source["parsed"]["rows"]) == 3
    assert {row["Nome da regional"] for row in scoped_source["parsed"]["rows"]} == {"SPE"}


def test_invalid_preview_does_not_replace_previous_source(authenticated_client: TestClient) -> None:
    valid_preview = preview(authenticated_client).json()
    imported = authenticated_client.post(
        "/api/data-sources/monitoring/import",
        json={"previewId": valid_preview["previewId"]},
    )
    assert imported.status_code == 200

    invalid_parsed = parsed_monitoring_workbook()
    invalid_parsed["rows"] = [
        {"Data": "not-a-date", "Regional Origem": "SPS", "PDD de saída": "Base SPS 1", "Origem do Pedido": "TikTok", "dorp off应揽收": 25},
    ]
    result = preview(authenticated_client, invalid_parsed)
    assert result.status_code == 200
    assert result.json()["canImport"] is False
    assert "Data" in result.json()["missingFields"]
    assert authenticated_client.get("/api/data-sources/monitoring").json()["source"]["fileName"] == "monitoramento.xlsx"


def test_unsafe_name_and_wrong_mime_are_rejected(authenticated_client: TestClient) -> None:
    unsafe = authenticated_client.post(
        "/api/data-sources/monitoring/preview",
        json={
            "fileName": "..\\outside.xlsx",
            "fileSizeBytes": 10,
            "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "parsed": parsed_monitoring_workbook(),
        },
    )
    assert unsafe.status_code == 200
    assert unsafe.json()["fileName"] == "outside.xlsx"

    wrong_mime = authenticated_client.post(
        "/api/data-sources/monitoring/preview",
        json={
            "fileName": "monitoramento.xlsx",
            "fileSizeBytes": 10,
            "contentType": "text/plain",
            "parsed": parsed_monitoring_workbook(),
        },
    )
    assert wrong_mime.status_code == 422
    assert wrong_mime.json()["detail"] == "data_source_mime_invalid"
