from __future__ import annotations

import base64
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import app
from app.models import PlatformUser, UserAccessAudit
from app.services import feishu_auth
from app.services.user_access import provision_feishu_user


@pytest.fixture
def admin_client(monkeypatch: pytest.MonkeyPatch, create_user_session) -> TestClient:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    monkeypatch.setenv("FEISHU_SESSION_SECRET", "admin-test-session-secret-at-least-32")
    monkeypatch.setenv("UPLOAD_USERNAME", "test-uploader")
    monkeypatch.setenv("UPLOAD_PASSWORD", "test-upload-password")
    get_settings.cache_clear()
    token, _user = create_user_session(
        name="Regional Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="admin-api",
    )
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    yield client
    get_settings.cache_clear()


def test_admin_lists_users_and_controlled_region_catalog(admin_client: TestClient) -> None:
    users = admin_client.get("/api/admin/users?q=Regional%20Admin")
    regions = admin_client.get("/api/admin/regions")

    assert users.status_code == 200
    assert users.json()["total"] == 1
    assert users.json()["users"][0]["platformRole"] == "ADMIN"
    assert regions.status_code == 200
    assert {item["code"] for item in regions.json()["regions"]} == {"SPE", "SPS", "MG", "RJ"}


def test_user_administration_requires_an_authenticated_feishu_session() -> None:
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        assert client.get("/api/admin/users").status_code == 401
        assert client.get("/api/admin/regions").status_code == 401
        assert client.patch("/api/admin/users/1", json={"platformRole": "ADMIN"}).status_code == 401


def test_first_feishu_provision_is_user_and_repeat_login_reuses_identity(
    user_test_session_factory: sessionmaker[Session],
) -> None:
    identity = {
        "username": "New Feishu Viewer",
        "role": "regional",
        "region": "SPE",
        "base": None,
        "_tenant_key": "new-user-tenant",
        "_open_id": "new-user-open-id",
        "_email": "new.viewer@example.test",
    }
    with user_test_session_factory() as db:
        first = provision_feishu_user(db, identity)
        first_id = first.id
        assert first.platform_role == "USER"
        assert first.organizational_scope == "regional"
        assert first.home_region == "SPE"
        assert first.is_active is True

        second = provision_feishu_user(db, identity)
        assert second.id == first_id

        users = list(db.scalars(select(PlatformUser).where(PlatformUser.email == "new.viewer@example.test")))
        assert len(users) == 1


def test_user_cannot_call_admin_routes_or_modify_users(
    admin_client: TestClient,
    create_user_session,
) -> None:
    user_token, _user = create_user_session(
        name="Read Only User",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="admin-forbidden-user",
    )
    admin_client.cookies.set(feishu_auth.SESSION_COOKIE, user_token)

    assert admin_client.get("/api/admin/users").status_code == 403
    assert admin_client.get("/api/admin/regions").status_code == 403
    assert admin_client.patch(
        "/api/admin/users/1",
        json={"platformRole": "ADMIN"},
    ).status_code == 403


def test_admin_updates_role_and_extra_regions_with_audit(
    admin_client: TestClient,
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    _token, target = create_user_session(
        name="SPE Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="target-scope-update",
    )

    response = admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={
            "platformRole": "ADMIN",
            "additionalRegions": ["MG", "RJ"],
        },
    )

    assert response.status_code == 200
    user = response.json()["user"]
    assert user["platformRole"] == "ADMIN"
    assert user["homeRegion"] == "SPE"
    assert user["additionalRegions"] == ["MG", "RJ"]
    assert user["organizationalScope"] == "regional"
    with user_test_session_factory() as db:
        audit = db.scalar(
            select(UserAccessAudit).where(UserAccessAudit.target_user_id == target.id)
        )
        assert audit is not None
        assert audit.actor_type == "admin"
        assert audit.old_platform_role == "USER"
        assert audit.new_platform_role == "ADMIN"
        assert audit.regions_added == ["MG", "RJ"]
        assert audit.regions_removed == []


@pytest.mark.parametrize(
    ("regions", "detail"),
    [(["SPE"], "home_region_is_not_an_extra_region"), (["XX"], "user_region_not_in_catalog")],
)
def test_home_region_cannot_become_extra_and_unknown_regions_are_rejected(
    admin_client: TestClient,
    create_user_session,
    regions: list[str],
    detail: str,
) -> None:
    _token, target = create_user_session(
        name="SPE Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix=f"bad-region-{detail}",
    )
    response = admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"additionalRegions": regions},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == detail


def test_matrix_users_cannot_receive_redundant_extra_regions(
    admin_client: TestClient,
    create_user_session,
) -> None:
    _token, target = create_user_session(
        name="Matrix User",
        platform_role="USER",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="matrix-extra-regions",
    )
    response = admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"additionalRegions": ["MG"]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "matrix_user_cannot_have_extra_regions"


def test_last_active_admin_cannot_lock_the_platform(
    admin_client: TestClient,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    with user_test_session_factory() as db:
        admin = db.scalar(select(PlatformUser).where(PlatformUser.open_id == "test-open-admin-api"))
        assert admin is not None
        admin_id = admin.id
    response = admin_client.patch(
        f"/api/admin/users/{admin_id}",
        json={"isActive": False},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "last_active_admin_required"


def test_disabled_user_loses_auth_me_and_data_source_access(
    admin_client: TestClient,
    create_user_session,
) -> None:
    user_token, user = create_user_session(
        name="Soon Disabled",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="disabled-user",
    )
    disabled = admin_client.patch(
        f"/api/admin/users/{user.id}",
        json={"isActive": False},
    )
    assert disabled.status_code == 200

    viewer = TestClient(app, base_url="http://127.0.0.1:8000")
    viewer.cookies.set(feishu_auth.SESSION_COOKIE, user_token)
    assert viewer.get("/api/auth/me").status_code == 401
    assert viewer.get("/api/data-sources/monitoring").status_code == 401


def _basic_upload_header() -> dict[str, str]:
    encoded = base64.b64encode(b"test-uploader:test-upload-password").decode("ascii")
    return {"Authorization": f"Basic {encoded}"}


def test_regional_admin_does_not_gain_national_scope_but_extra_region_is_applied(
    admin_client: TestClient,
    create_user_session,
) -> None:
    parsed = {
        "sheetName": "Dados",
        "headers": ["Regional Origem", "PDD de saída", "Qtd"],
        "rows": [
            {"Regional Origem": "SPE", "PDD de saída": "Base SPE", "Qtd": 1},
            {"Regional Origem": "MG", "PDD de saída": "Base MG", "Qtd": 2},
            {"Regional Origem": "RJ", "PDD de saída": "Base RJ", "Qtd": 3},
        ],
        "regionColumn": "Regional Origem",
        "baseColumn": "PDD de saída",
    }
    upload = admin_client.post(
        "/api/workbook",
        headers=_basic_upload_header(),
        data={"payload": json.dumps({"kind": "movement", "fileName": "scope.xlsx", "parsed": parsed})},
        files=[("files", ("scope.xlsx", b"test-xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))],
    )
    assert upload.status_code == 200

    # ADMIN is a platform role; it does not widen this user's Feishu scope.
    admin_read = admin_client.get("/api/workbook?kind=movement").json()["workbook"]["parsed"]["rows"]
    assert [row["Regional Origem"] for row in admin_read] == ["SPE"]

    viewer_token, _viewer = create_user_session(
        name="SPE plus MG Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        additional_regions=["MG"],
        identity_suffix="spe-mg-reader",
    )
    viewer = TestClient(app, base_url="http://127.0.0.1:8000")
    viewer.cookies.set(feishu_auth.SESSION_COOKIE, viewer_token)
    rows = viewer.get("/api/workbook?kind=movement").json()["workbook"]["parsed"]["rows"]
    assert {row["Regional Origem"] for row in rows} == {"SPE", "MG"}


def test_matrix_user_remains_national_without_admin_role(
    admin_client: TestClient,
    create_user_session,
) -> None:
    parsed = {
        "sheetName": "Dados",
        "headers": ["Regional Origem", "PDD de saída", "Qtd"],
        "rows": [
            {"Regional Origem": "SPE", "PDD de saída": "Base SPE", "Qtd": 1},
            {"Regional Origem": "RJ", "PDD de saída": "Base RJ", "Qtd": 2},
        ],
        "regionColumn": "Regional Origem",
        "baseColumn": "PDD de saída",
    }
    uploaded = admin_client.post(
        "/api/workbook",
        headers=_basic_upload_header(),
        data={"payload": json.dumps({"kind": "movement", "fileName": "matrix.xlsx", "parsed": parsed})},
        files=[("files", ("matrix.xlsx", b"test-xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))],
    )
    assert uploaded.status_code == 200

    token, _user = create_user_session(
        name="Matrix USER",
        platform_role="USER",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="matrix-user-scope",
    )
    viewer = TestClient(app, base_url="http://127.0.0.1:8000")
    viewer.cookies.set(feishu_auth.SESSION_COOKIE, token)
    identity = viewer.get("/api/auth/me").json()
    rows = viewer.get("/api/workbook?kind=movement").json()["workbook"]["parsed"]["rows"]
    assert identity["platform_role"] == "USER"
    assert identity["organizational_scope"] == "matrix"
    assert {row["Regional Origem"] for row in rows} == {"SPE", "RJ"}


def test_user_cannot_publish_workbook_even_with_basic_upload_password(
    admin_client: TestClient,
    create_user_session,
) -> None:
    token, _user = create_user_session(
        name="No Upload User",
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPE",
        identity_suffix="no-upload-user",
    )
    viewer = TestClient(app, base_url="http://127.0.0.1:8000")
    viewer.cookies.set(feishu_auth.SESSION_COOKIE, token)
    assert viewer.post("/api/upload-auth", headers=_basic_upload_header()).status_code == 403
    assert viewer.post(
        "/api/workbook",
        headers=_basic_upload_header(),
        json={"kind": "movement", "fileName": "x.xlsx", "parsed": {"headers": ["x"], "rows": [{}]}},
    ).status_code == 403
