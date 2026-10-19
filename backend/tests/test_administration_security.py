from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.main import app
from app.models import Region, UserAccessAudit, UserRegionAccess
from app.services import feishu_auth


@pytest.fixture
def security_users(monkeypatch, create_user_session):
    monkeypatch.setenv("REGIONAL_USER_ADMINISTRATION_ENABLED", "true")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    get_settings.cache_clear()

    def create(suffix, *, admin=False, scope="regional", region="CE", extras=None, no_feishu=False):
        session_options = dict(
            name=suffix, platform_role="ADMIN" if admin else "USER",
            organizational_scope=scope, home_region=region,
            additional_regions=extras, identity_suffix=suffix,
        )
        if no_feishu:
            session_options["feishu_region_code"] = None
        token, user = create_user_session(**session_options)
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        client.cookies.set(feishu_auth.SESSION_COOKIE, token)
        return client, user

    return create


@pytest.mark.parametrize("payload", [
    {"additionalRegions": ["SPS"]}, {"platformRole": "USER"}, {"isActive": False},
])
def test_regional_admin_cannot_change_self(security_users, payload, user_test_session_factory):
    client, actor = security_users("ce-self", admin=True)
    response = client.patch(f"/api/admin/users/{actor.id}", json=payload)
    assert response.status_code == 403
    assert response.json()["detail"] == "admin_self_change_forbidden"
    assert client.get("/api/auth/me").json()["effective_regions"] == ["CE"]
    with user_test_session_factory() as db:
        assert list(db.scalars(select(UserAccessAudit))) == []


@pytest.mark.parametrize("payload", [
    {"additionalRegions": ["SPS"]}, {"additionalRegions": []}, {"platformRole": "ADMIN"},
])
def test_regional_admin_cannot_grant_permissions_even_to_local_users(security_users, payload):
    client, _ = security_users("ce-grant", admin=True)
    target_client, target = security_users("ce-target")
    assert client.patch(f"/api/admin/users/{target.id}", json=payload).status_code == 403
    identity = target_client.get("/api/auth/me").json()
    assert identity["platform_role"] == "USER"
    assert identity["effective_regions"] == ["CE"]


@pytest.mark.parametrize("scope,region,admin,extras", [
    ("matrix", None, True, None), ("regional", "SPS", False, None),
    ("regional", "CE", True, None), ("base", None, False, None),
    ("regional", "CE", False, ["SPS"]),
])
def test_regional_admin_cannot_manage_superior_unknown_or_outside_targets(
    security_users, scope, region, admin, extras,
):
    client, _ = security_users("ce-constrained", admin=True)
    target_client, target = security_users(
        "protected-target", admin=admin, scope=scope, region=region, extras=extras,
        no_feishu=extras is not None,
    )
    assert client.patch(f"/api/admin/users/{target.id}", json={"isActive": False}).status_code == 403
    assert client.get(f"/api/admin/users/{target.id}/access-audit").status_code == 403
    assert target_client.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("payload", [
    {"organizationalScope": "matrix"}, {"homeRegion": "SPS"},
    {"platform_role": "ADMIN", "role": "matrix"}, {"additionalRegions": ["SPS"], "userId": 1},
])
def test_manipulated_fields_are_rejected_instead_of_being_silently_ignored(security_users, payload):
    client, _ = security_users("matrix-validator", admin=True, scope="matrix", region=None)
    target_client, target = security_users("manipulated-target")
    assert client.patch(f"/api/admin/users/{target.id}", json=payload).status_code == 422
    assert target_client.get("/api/auth/me").json()["effective_regions"] == ["CE"]


def test_delegation_is_disabled_by_default_and_does_not_grant_global_catalog(security_users, monkeypatch):
    client, target = security_users("disabled-delegation", admin=True)
    monkeypatch.delenv("REGIONAL_USER_ADMINISTRATION_ENABLED")
    get_settings.cache_clear()
    assert get_settings().regional_user_administration_enabled is False
    for path in ("/api/admin/users", "/api/admin/regions", f"/api/admin/users/{target.id}/access-audit"):
        assert client.get(path).status_code == 403
    assert client.patch(f"/api/admin/users/{target.id}", json={"isActive": False}).status_code == 403


def test_delegated_admin_sees_only_local_users_and_can_change_only_their_status(
    security_users, user_test_session_factory,
):
    client, _ = security_users("delegated-ce", admin=True)
    target_client, target = security_users("local-user")
    security_users("outside-user", region="SPS")
    security_users("broad-user", extras=["SPS"], no_feishu=True)
    security_users("matrix-admin", admin=True, scope="matrix", region=None)
    security_users("unknown-user", scope="base", region=None)
    listed = client.get("/api/admin/users?limit=1&offset=0").json()
    assert listed["total"] == 1
    assert [user["id"] for user in listed["users"]] == [target.id]
    assert listed["users"][0]["canChangeStatus"] is True
    assert listed["users"][0]["canManageAccess"] is False
    assert [region["code"] for region in client.get("/api/admin/regions").json()["regions"]] == ["CE"]
    response = client.patch(f"/api/admin/users/{target.id}", json={"isActive": False})
    assert response.status_code == 200
    assert target_client.get("/api/auth/me").status_code == 401
    audit = client.get(f"/api/admin/users/{target.id}/access-audit").json()["entries"]
    assert len(audit) == 1
    assert audit[0]["actor"] == "delegated-ce"
    assert audit[0]["oldIsActive"] is True and audit[0]["newIsActive"] is False
    with user_test_session_factory() as db:
        assert len(list(db.scalars(select(UserAccessAudit)))) == 1


def test_same_session_uses_current_grants_after_matrix_grant_and_revocation(security_users, monkeypatch):
    matrix, matrix_user = security_users("authorized-matrix", admin=True, scope="matrix", region=None)
    target_client, target = security_users("unknown-release", scope="base", region=None)
    parsed = {
        "sheetName": "Dados", "headers": ["Regional Origem", "PDD de saída", "Qtd"],
        "regionColumn": "Regional Origem", "baseColumn": "PDD de saída",
        "rows": [{"Regional Origem": "CE", "PDD de saída": "TEST-A", "Qtd": 1},
                 {"Regional Origem": "SPS", "PDD de saída": "TEST-B", "Qtd": 2},
                 {"Regional Origem": "", "PDD de saída": "TEST-C", "Qtd": 3}],
    }
    assert matrix.post("/api/workbook", json={"kind": "movement", "fileName": "test.xlsx", "parsed": parsed}).status_code == 200
    assert target_client.get("/api/workbook?kind=movement").status_code == 403
    # No data-engine query is reached for an identity without an authorized scope.
    monkeypatch.setattr("app.api.data_foundation.get_settings", lambda: SimpleNamespace(data_queries_enabled=True))
    monkeypatch.setattr("app.api.data_foundation._engine", lambda: SimpleNamespace(dialect=SimpleNamespace(name="sqlite")))
    def denied():
        for suffix in ("records", "dates", "publications", "export.csv"):
            response = target_client.get(f"/api/v2/data-sources/no_movement/{suffix}?region=SPS&role=matrix")
            assert response.status_code == 403
    denied()
    assert matrix.patch(f"/api/admin/users/{target.id}", json={"additionalRegions": ["CE"]}).status_code == 200
    identity = target_client.get("/api/auth/me").json()
    assert identity["effective_regions"] == ["CE"] and identity["platform_role"] == "USER"
    rows = target_client.get("/api/workbook?kind=movement").json()["workbook"]["parsed"]["rows"]
    assert [row["Regional Origem"] for row in rows] == ["CE"]
    assert matrix.patch(f"/api/admin/users/{target.id}", json={"additionalRegions": []}).status_code == 200
    assert target_client.get("/api/auth/me").json()["effective_regions"] == []
    assert target_client.get("/api/workbook?kind=movement").status_code == 403
    denied()
    assert len(matrix.get(f"/api/admin/users/{target.id}/access-audit").json()["entries"]) == 2
    assert matrix.patch(f"/api/admin/users/{matrix_user.id}", json={"isActive": False}).status_code == 403
    own = next(user for user in matrix.get("/api/admin/users").json()["users"] if user["id"] == matrix_user.id)
    assert own["canChangeStatus"] is False and own["canManageAccess"] is False


@pytest.mark.parametrize("path", [
    "/api/v2/imports/preview", "/api/v2/base-mapping/initial-migration/preview",
    "/api/v2/base-mapping/initial-migration/job/publish", "/api/v2/base-mapping/name-decisions",
    "/api/v2/imports/job/validate", "/api/v2/imports/job/publish",
    "/api/data-sources/monitoring/preview", "/api/data-sources/monitoring/import",
    "/api/workbook", "/api/upload-auth", "/api/workbook/responsibility-list/publish",
])
@pytest.mark.parametrize("admin,scope", [(True, "regional"), (False, "regional"), (False, "matrix")])
def test_regional_admin_and_user_cannot_mutate_global_sources(security_users, path, admin, scope):
    client, _ = security_users("non-matrix-publisher", admin=admin, scope=scope, region=None if scope == "matrix" else "CE")
    assert client.post(path, json={}).status_code == 403


def test_role_revocation_blocks_old_admin_cookie_on_next_request(security_users):
    matrix, _ = security_users("matrix-revoker", admin=True, scope="matrix", region=None)
    regional, actor = security_users("old-admin-cookie", admin=True)
    assert regional.get("/api/admin/users").status_code == 200
    assert matrix.patch(f"/api/admin/users/{actor.id}", json={"platformRole": "USER"}).status_code == 200
    assert regional.get("/api/admin/users").status_code == 403
    assert regional.get("/api/auth/me").json()["platform_role"] == "USER"


def test_matrix_revocation_removes_inactive_grants_without_future_resurrection(security_users, user_test_session_factory):
    matrix, _ = security_users("matrix-inactive-grant", admin=True, scope="matrix", region=None)
    _, target = security_users("inactive-grant-target", extras=["SPS"])
    with user_test_session_factory() as db:
        region = db.get(Region, "SPS")
        region.is_active = False
        db.commit()
    result = matrix.patch(f"/api/admin/users/{target.id}", json={"additionalRegions": []})
    assert result.status_code == 200
    with user_test_session_factory() as db:
        assert list(db.scalars(select(UserRegionAccess).where(UserRegionAccess.user_id == target.id))) == []
    assert matrix.get(f"/api/admin/users/{target.id}/access-audit").json()["entries"][0]["regionsRemoved"] == ["SPS"]


def test_audit_failure_rolls_back_the_permission_grant(security_users, user_test_session_factory):
    matrix, _ = security_users("matrix-atomic-audit", admin=True, scope="matrix", region=None)
    target_client, target = security_users("atomic-target")

    def fail_audit(session, _context, _instances):
        if any(isinstance(item, UserAccessAudit) for item in session.new):
            raise SQLAlchemyError("simulated audit storage failure")

    session_class = user_test_session_factory.class_
    event.listen(session_class, "before_flush", fail_audit)
    try:
        response = matrix.patch(f"/api/admin/users/{target.id}", json={"platformRole": "ADMIN", "additionalRegions": ["SPS"]})
        assert response.status_code == 503
    finally:
        event.remove(session_class, "before_flush", fail_audit)
    identity = target_client.get("/api/auth/me").json()
    assert identity["platform_role"] == "USER" and identity["effective_regions"] == ["CE"]
    with user_test_session_factory() as db:
        assert list(db.scalars(select(UserAccessAudit))) == []
