from __future__ import annotations

from datetime import datetime, timedelta, timezone
from app.core.config import Settings
from app.models import PlatformUserFeishuProfile
from app.services.feishu_regions import JT_BRASIL_ID
from app.services.user_access import identity_for_user
from app.services.row_scope import scope_parsed_rows
from app.services.data_foundation.queries import _query_plan
from app.api.dependencies import _refresh_feishu_profile_if_stale
from app.services.feishu_contacts import FeishuContactsError, FeishuOrganizationalProfile
from app.api.dependencies import require_matrix_admin, AuthenticatedViewer
from fastapi import HTTPException


SPS_ID = "od-3ce772781fd5edda748adff1face448e"
PA_ID = "od-efec880285b9a9d7efce49c5563f52ac"
MN_ID = "od-930a0c1d13f1c393e942a8153e560641"
MN_MG_ID = "od-7d5b679dc3564de403ddf11270a3f4ea"


def save_paths(db, user_id: int, paths: list[list[str]], *, synced_at=None, status="RESOLVED"):
    profile = db.get(PlatformUserFeishuProfile, user_id)
    if profile is None:
        profile = PlatformUserFeishuProfile(user_id=user_id)
    profile.department_paths = paths
    profile.region_resolution_status = status
    profile.last_successful_sync_at = synced_at or datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(profile)
    db.commit()
    return profile


def test_v2_regional_scope_is_server_enforced_and_does_not_expand_manual_grants(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-sps",
        organizational_scope="base",
        home_region=None,
        additional_regions=["BA", "MG"],
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(db, user.id, [[JT_BRASIL_ID, SPS_ID, "sps-functional"]])
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
    assert identity["organizational_scope"] == "regional"
    assert identity["home_region"] == "SPS"
    assert identity["effective_regions"] == ["SPS"]
    plan = _query_plan("no_movement", identity)
    assert plan.parameters["scope_region_0"] == "SPS"
    assert "scope_region_1" not in plan.parameters
    scoped = scope_parsed_rows(
        {"headers": ["regional"], "regionColumn": "regional", "baseColumn": None,
         "rows": [{"regional": "SPS"}, {"regional": "BA"}, {"regional": None}]},
        identity,
    )
    assert scoped["rows"] == [{"regional": "SPS"}]


def test_v2_unresolved_mn_is_fail_closed_even_with_manual_grants(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-mn-pending",
        organizational_scope="base",
        home_region=None,
        additional_regions=["MG"],
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(db, user.id, [[JT_BRASIL_ID, MN_ID, "mn-functional"]])
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
    assert identity["organizational_scope"] == "unknown"
    assert identity["effective_regions"] == []
    assert identity["organizational_scope_reason"] == "mn_rule_pending"


def test_v2_scope_expiry_and_sync_failure_revoke_old_matrix_scope(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-expired-matrix",
        organizational_scope="base",
        home_region=None,
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        profile = save_paths(
            db, user.id, [[JT_BRASIL_ID]],
            synced_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1),
        )
        identity = identity_for_user(
            db, db.get(type(user), user.id), org_scope_v2_enabled=True,
            now=datetime.now(timezone.utc),
        )
        assert identity["organizational_scope"] == "unknown"
        assert identity["organizational_scope_reason"] == "profile_expired"

        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        profile.region_resolution_status = "SYNC_FAILED"
        db.commit()
        failed = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
        assert failed["organizational_scope"] == "unknown"
        assert failed["effective_regions"] == []


def test_v2_matrix_data_scope_does_not_promote_user_to_admin(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-matrix-user",
        platform_role="USER",
        organizational_scope="base",
        home_region=None,
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(db, user.id, [[JT_BRASIL_ID]])
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
    assert identity["organizational_scope"] == "matrix"
    assert identity["platform_role"] == "USER"
    try:
        require_matrix_admin(AuthenticatedViewer(user=user, identity=identity))
    except HTTPException as error:
        assert error.status_code == 403 and error.detail == "admin_required"
    else:
        raise AssertionError("matrix data scope must not grant platform administration")


def test_v2_keeps_existing_admin_matrix_authority_separate(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-admin-matrix",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(db, user.id, [[JT_BRASIL_ID]])
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
    require_matrix_admin(AuthenticatedViewer(user=user, identity=identity))
    assert identity["platform_role"] == "ADMIN"
    assert identity["administrative_scope"] == "matrix"


def test_disabled_v2_keeps_legacy_resolver_behavior(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-disabled-legacy",
        organizational_scope="base",
        home_region=None,
        feishu_region_code="MATRIZ",
    )
    with user_test_session_factory() as db:
        save_paths(db, user.id, [[JT_BRASIL_ID, MN_ID]])
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=False)
    assert identity["organizational_scope"] == "matrix"
    assert identity["organizational_scope_policy"] == "LEGACY"


def test_profile_refresh_updates_transfer_before_returning_authorized_identity(
    create_user_session, user_test_session_factory, monkeypatch,
):
    _token, user = create_user_session(
        identity_suffix="v2-transfer-refresh",
        organizational_scope="base",
        home_region=None,
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(
            db, user.id, [[JT_BRASIL_ID, SPS_ID]],
            synced_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1),
        )
        async def fake_fetch(_open_id, _settings, **_kwargs):
            return FeishuOrganizationalProfile(None, None, [[JT_BRASIL_ID, PA_ID, "pa-ops"]])
        monkeypatch.setattr("app.api.dependencies.fetch_feishu_organizational_profile", fake_fetch)
        settings = Settings(
            _env_file=None,
            feishu_allowed_tenant_key="test-tenant",
            feishu_oauth_app_id="mock-app",
            feishu_oauth_app_secret="mock-secret",
            feishu_org_scope_profile_ttl_seconds=900,
        )
        failed = _refresh_feishu_profile_if_stale(db, user, settings)
        identity = identity_for_user(db, db.get(type(user), user.id), org_scope_v2_enabled=True)
    assert failed is False
    assert identity["organizational_scope"] == "regional"
    assert identity["effective_regions"] == ["PA"]
    assert identity["home_region"] != "SPS"


def test_profile_refresh_failure_revokes_scope_and_does_not_fallback_to_manual_grants(
    create_user_session, user_test_session_factory, monkeypatch,
):
    _token, user = create_user_session(
        identity_suffix="v2-api-fail",
        organizational_scope="base",
        home_region=None,
        additional_regions=["SPS"],
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        save_paths(
            db, user.id, [[JT_BRASIL_ID, SPS_ID]],
            synced_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1),
        )
        async def failed_fetch(_open_id, _settings, **_kwargs):
            raise FeishuContactsError("contacts_permission_denied", 403)
        monkeypatch.setattr("app.api.dependencies.fetch_feishu_organizational_profile", failed_fetch)
        settings = Settings(
            _env_file=None,
            feishu_allowed_tenant_key="test-tenant",
            feishu_oauth_app_id="mock-app",
            feishu_oauth_app_secret="mock-secret",
            feishu_org_scope_profile_ttl_seconds=900,
        )
        failed = _refresh_feishu_profile_if_stale(db, user, settings)
        identity = identity_for_user(
            db, db.get(type(user), user.id), org_scope_v2_enabled=True,
            force_feishu_sync_failed=failed,
        )
    assert failed is True
    assert identity["organizational_scope"] == "unknown"
    assert identity["effective_regions"] == []
    assert identity["region_resolution_status"] == "SYNC_FAILED"


def test_v2_does_not_use_retired_spn_department_ids():
    from app.services.feishu_regions import resolve_organizational_region_v2

    retired = "od-3d75c10ce15130e199fc3b42e4e86a04"
    result = resolve_organizational_region_v2([[JT_BRASIL_ID, retired]])
    assert result.region_code is None
    assert result.status == "UNKNOWN"


def _v2_settings(tmp_path):
    return Settings(
        _env_file=None,
        data_directory=tmp_path / "org-scope-data",
        data_sources_enabled=True,
        data_queries_enabled=False,
        data_db_host="127.0.0.1",
        data_db_name="isolated-test-only",
        data_db_user="isolated-test-only",
        data_db_password="unused-test-only",
        feishu_org_scope_v2_enabled=True,
        feishu_org_scope_profile_ttl_seconds=900,
        feishu_session_secret="isolated-test-session-secret-at-least-32-chars",
        feishu_allowed_tenant_key="test-tenant",
        feishu_oauth_app_id="mock-app",
        feishu_oauth_app_secret="mock-secret",
    )


def _install_v2_route_settings(monkeypatch, settings, tmp_path):
    monkeypatch.setattr("app.api.dependencies.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.user_access.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.data_foundation.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.data_sources.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.workbooks.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.workbooks.data_root", lambda _configured: tmp_path / "v2-route-workbooks")


def _set_v2_paths(user_test_session_factory, user_id: int, paths: list[list[str]]) -> None:
    with user_test_session_factory() as db:
        save_paths(db, user_id, paths)


def test_v2_workbook_routes_isolate_regions_and_restrict_global_responsibility_metadata(
    tmp_path, monkeypatch, create_user_session, user_test_session_factory,
):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services import feishu_auth
    from app.services.local_workbooks import save_workbook, save_dashboard_source
    from app.services.data_sources import create_published_source_key
    monkeypatch.setattr("app.services.data_sources.get_settings", lambda: settings)

    settings = _v2_settings(tmp_path)
    _install_v2_route_settings(monkeypatch, settings, tmp_path)
    root = tmp_path / "v2-route-workbooks"
    movement = {
        "sheetName": "Movimento",
        "headers": ["Data", "Regional Origem", "PDD de saída", "Qtd"],
        "regionColumn": "Regional Origem",
        "baseColumn": "PDD de saída",
        "rows": [
            {"Data": "2026-10-22", "Regional Origem": "SPS", "PDD de saída": "SPS Base", "Qtd": 10},
            {"Data": "2026-10-22", "Regional Origem": "PR", "PDD de saída": "PR Base", "Qtd": 20},
            {"Data": "2026-10-22", "Regional Origem": "MG", "PDD de saída": "MG Base", "Qtd": 30},
        ],
    }
    save_workbook(root, "movement", "movement.xlsx", movement)
    source_root = tmp_path / "v2-route-sources"
    monkeypatch.setattr("app.services.data_sources.data_root", lambda _configured: source_root)
    source_owner_key = create_published_source_key("monitoring", settings.feishu_session_secret)
    save_dashboard_source(
        source_root, "monitoring", source_owner_key, "monitoring.xlsx", movement, None,
        imported_at="2026-10-22T12:00:00Z", file_size_bytes=100,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        period={"start": "2026-10-22", "end": "2026-10-22"}, row_count=3,
    )
    sps_taxa = {**movement, "rows": [movement["rows"][0]]}
    pr_taxa = {**movement, "rows": [movement["rows"][1]]}
    save_workbook(root, "taxa", "taxa-sps.xlsx", sps_taxa)
    pr_version = save_workbook(root, "taxa", "taxa-pr.xlsx", pr_taxa)["latestVersion"]
    responsibility = {
        "sheetName": "Responsáveis",
        "headers": ["Regional", "UF", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"],
        "rows": [
            {"Regional": "SPS", "UF": "SP", "Região RM": "SPS-1", "Responsável Rm": "RM SPS", "Código da base": "1", "Nome da base": "SPS Base", "Descrição": "Ativa"},
            {"Regional": "PR", "UF": "PR", "Região RM": "PR-1", "Responsável Rm": "RM PR", "Código da base": "2", "Nome da base": "PR Base", "Descrição": "Ativa"},
        ],
    }
    save_workbook(root, "responsibilityList", "responsibility.xlsx", responsibility)

    sps_token, sps_user = create_user_session(
        identity_suffix="v2-route-sps", organizational_scope="base", home_region=None, feishu_region_code=None,
    )
    _set_v2_paths(user_test_session_factory, sps_user.id, [[JT_BRASIL_ID, "od-3ce772781fd5edda748adff1face448e", "sps-functional"]])
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, sps_token)

    source_response = client.get("/api/data-sources/monitoring?region=PR")
    assert source_response.status_code == 200
    assert [row["Regional Origem"] for row in source_response.json()["source"]["parsed"]["rows"]] == ["SPS"]

    movement_response = client.get("/api/workbook?kind=movement&region=PR")
    assert movement_response.status_code == 200
    assert [row["Regional Origem"] for row in movement_response.json()["workbook"]["parsed"]["rows"]] == ["SPS"]

    history_response = client.get("/api/workbook?kind=taxa")
    assert history_response.status_code == 200
    visible_parts = history_response.json()["historyParts"]
    assert len(visible_parts) == 1
    assert visible_parts[0] != pr_version
    forced_other_part = client.get(f"/api/workbook?kind=taxa&part={pr_version}")
    assert forced_other_part.status_code == 200
    assert forced_other_part.json()["workbook"]["parsed"]["rows"] == []

    # The full responsibility summary contains national counts; regional V2
    # users must use the row-scoped workbook endpoint instead.
    assert client.get("/api/workbook/responsibility-list").status_code == 403
    scoped_responsibility = client.get("/api/workbook?kind=responsibilityList")
    assert scoped_responsibility.status_code == 200
    assert [row["Regional"] for row in scoped_responsibility.json()["workbook"]["parsed"]["rows"]] == ["SPS"]

    matrix_token, matrix_user = create_user_session(
        name="Matrix V2 User", platform_role="USER", organizational_scope="base", home_region=None,
        feishu_region_code=None, identity_suffix="v2-route-matrix-user",
    )
    _set_v2_paths(user_test_session_factory, matrix_user.id, [[JT_BRASIL_ID]])
    matrix = TestClient(app, base_url="http://127.0.0.1:8000")
    matrix.cookies.set(feishu_auth.SESSION_COOKIE, matrix_token)
    assert {row["Regional Origem"] for row in matrix.get("/api/workbook?kind=movement").json()["workbook"]["parsed"]["rows"]} == {"SPS", "PR", "MG"}
    assert matrix.get("/api/workbook/responsibility-list").status_code == 200
    assert matrix.post("/api/workbook/responsibility-list/preview", json={}).status_code == 403
    assert matrix.post("/api/workbook/responsibility-list/preview", json={}).status_code == 403

    admin_token, admin_user = create_user_session(
        name="Matrix V2 Admin", platform_role="ADMIN", organizational_scope="matrix", home_region=None,
        feishu_region_code=None, identity_suffix="v2-route-matrix-admin",
    )
    _set_v2_paths(user_test_session_factory, admin_user.id, [[JT_BRASIL_ID]])
    admin = TestClient(app, base_url="http://127.0.0.1:8000")
    admin.cookies.set(feishu_auth.SESSION_COOKIE, admin_token)
    upload = admin.post("/api/workbook", json={"kind": "movement", "fileName": "admin.xlsx", "parsed": movement})
    assert upload.status_code == 200


def test_v2_data_foundation_routes_apply_scope_after_query_and_publication_id_filters(
    monkeypatch, tmp_path, create_user_session, user_test_session_factory,
):
    from fastapi.testclient import TestClient
    import re
    from sqlalchemy import create_engine, event, text
    from sqlalchemy.pool import StaticPool
    from app.main import app
    from app.services import feishu_auth
    from test_collection_monitoring_v2_queries import _create_engine, _insert_day, MAPPING_ID

    settings = _v2_settings(tmp_path)
    _install_v2_route_settings(monkeypatch, settings, tmp_path)
    engine, contract, table = _create_engine()
    source_connection = engine.raw_connection()
    shared_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(shared_engine, "connect")
    def register_regexp(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "REGEXP_REPLACE",
            3,
            lambda value, pattern, replacement: re.sub(pattern, replacement, value) if value is not None else None,
        )

    target_connection = shared_engine.raw_connection()
    source_connection.dbapi_connection.backup(target_connection.dbapi_connection)
    source_connection.close()
    target_connection.close()
    engine.dispose()
    engine = shared_engine
    _insert_day(engine, contract, table, day=22, rows=[(1, True), (2, True), (3, True)])
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:id, 'SR-001', 'SR', 'SR Base', 'SC', 'SR-RM', 'RM SR')"), {"id": MAPPING_ID})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:id, 'PR-001', 'PR', 'PR Base', 'PR', 'PR-RM', 'RM PR')"), {"id": MAPPING_ID})
        connection.execute(text(f"UPDATE `{table}` SET source_base_name='SPS Base', resolved_base_code='SPS-001' WHERE source_row_no=1"))
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:id, 'SPS-001', 'SPS', 'SPS Base', 'SP', 'SPS-RM', 'RM SPS')"), {"id": MAPPING_ID})
        connection.execute(text(f"UPDATE `{table}` SET source_base_name='SR Base', resolved_base_code='SR-001' WHERE source_row_no=2"))
        connection.execute(text(f"UPDATE `{table}` SET source_base_name='PR Base', resolved_base_code='PR-001' WHERE source_row_no=3"))

    monkeypatch.setattr("app.api.data_foundation._require_feature", lambda: None)
    monkeypatch.setattr("app.api.data_foundation._engine", lambda: engine)
    token, user = create_user_session(
        identity_suffix="v2-api-sr", organizational_scope="base", home_region=None, feishu_region_code=None,
    )
    _set_v2_paths(user_test_session_factory, user.id, [[JT_BRASIL_ID, "od-bd07f18f063d7c4f8bc387114a993786", "sr-functional"]])
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)

    root = "/api/v2/data-sources/collection_monitoring"
    base_query = "contract_version=2&date_from=2026-10-22&date_to=2026-10-22"
    own = client.get(f"{root}/records?{base_query}&limit=10")
    assert own.status_code == 200
    assert own.json()["total"] == 1
    assert {record["mapped_region"] for record in own.json()["records"]} == {"SR"}

    attacked_region = client.get(f"{root}/records?{base_query}&region=PR&limit=10")
    assert attacked_region.status_code == 200
    assert attacked_region.json()["total"] == 0
    publication_id = "00000000-0000-0000-0000-000000000016"
    attacked_publication = client.get(f"{root}/records?{base_query}&publication_id={publication_id}&limit=10")
    assert attacked_publication.status_code == 200
    assert attacked_publication.json()["total"] == 1
    assert {record["mapped_region"] for record in attacked_publication.json()["records"]} == {"SR"}

    dates = client.get(f"{root}/dates?contract_version=2")
    assert dates.status_code == 200
    assert dates.json()["dates"][0]["rowCount"] == 1
    publications = client.get(f"{root}/publications?contract_version=2")
    assert publications.status_code == 200
    assert publications.json()["publications"][0]["visibleRowCount"] == 1
    scoped_export = client.get(f"{root}/export.csv?{base_query}")
    assert scoped_export.status_code == 200
    assert "SR Base" in scoped_export.text and "PR Base" not in scoped_export.text
    exported = client.get(f"{root}/export.csv?{base_query}&region=PR")
    assert exported.status_code == 200
    assert "PR Base" not in exported.text
    assert "SR Base" not in exported.text


def test_v2_profile_scope_is_fresh_until_900_second_boundary(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="v2-profile-ttl-boundary", organizational_scope="base",
        home_region=None, feishu_region_code=None,
    )
    synced_at = datetime(2026, 10, 28, 12, 0, 0, tzinfo=timezone.utc)
    with user_test_session_factory() as db:
        save_paths(
            db, user.id, [[JT_BRASIL_ID]],
            synced_at=synced_at.replace(tzinfo=None),
        )
        current = db.get(type(user), user.id)
        valid = identity_for_user(
            db, current, org_scope_v2_enabled=True,
            now=synced_at + timedelta(seconds=899),
        )
        expired = identity_for_user(
            db, current, org_scope_v2_enabled=True,
            now=synced_at + timedelta(seconds=900),
        )
    assert valid["organizational_scope"] == "matrix"
    assert expired["organizational_scope"] == "unknown"
    assert expired["organizational_scope_reason"] == "profile_expired"
