from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.main import app
from app.models import PlatformUser, PlatformUserFeishuProfile, Region, UserAccessAudit, UserRegionAccess
from app.services import feishu_auth
from app.services.data_foundation.queries import _query_plan
from app.services.feishu_regions import JT_BRASIL_ID, V2_DEPARTMENT_REGION_IDS
from app.services.row_scope import scope_parsed_rows
from app.services.user_access import UserAccessError, identity_for_user, update_user_access


@pytest.fixture
def matrix_admin_client(monkeypatch: pytest.MonkeyPatch, create_user_session) -> TestClient:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    monkeypatch.setenv("FEISHU_SESSION_SECRET", "regional-override-admin-session-secret")
    get_settings.cache_clear()
    token, _admin = create_user_session(
        name="Matrix Admin",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="regional-override-admin",
    )
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    yield client
    get_settings.cache_clear()


def _reader_client(token: str) -> TestClient:
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    return client


@pytest.mark.parametrize(
    ("regions", "expected"),
    [(["PR"], ["PR"]), (["CE", "PR"], ["CE", "PR"]), (["PR", "MG"], ["MG", "PR"])],
)
def test_explicit_override_replaces_feishu_home_and_limits_shared_scope(
    matrix_admin_client: TestClient,
    create_user_session,
    regions: list[str],
    expected: list[str],
) -> None:
    token, target = create_user_session(
        name="CE Viewer",
        platform_role="USER",
        organizational_scope="regional",
        home_region="CE",
        identity_suffix=f"override-{'-'.join(regions)}",
    )

    saved = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": regions},
    )
    assert saved.status_code == 200
    assert saved.json()["user"]["platformRole"] == "USER"
    assert saved.json()["user"]["adminOverrideEnabled"] is True
    assert saved.json()["user"]["effectiveRegions"] == expected

    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["effective_scope_source"] == "ADMIN_OVERRIDE"
    assert identity["effective_regions"] == expected
    assert identity["organizational_region_code"] == "CE"
    assert identity["platform_role"] == "USER"

    query = _query_plan("no_movement", identity)
    scoped_regions = {
        value for key, value in query.parameters.items() if key.startswith("scope_region_")
    }
    assert scoped_regions == set(expected)
    rows = scope_parsed_rows(
        {
            "headers": ["regional"],
            "regionColumn": "regional",
            "baseColumn": None,
            "rows": [{"regional": code} for code in ("CE", "PR", "MG", "SPS")],
        },
        identity,
    )
    assert {row["regional"] for row in rows["rows"]} == set(expected)
    assert identity["role"] == "regional"


def test_matrix_classified_user_can_be_restricted_without_becoming_admin(
    matrix_admin_client: TestClient,
    create_user_session,
) -> None:
    token, target = create_user_session(
        name="Matrix Employee",
        platform_role="USER",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="matrix-user-regional-override",
    )
    response = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["SPE"]},
    )
    assert response.status_code == 200
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["organizational_region_code"] == "MATRIZ"
    assert identity["organizational_scope"] == "regional"
    assert identity["effective_regions"] == ["SPE"]
    assert identity["platform_role"] == "USER"
    assert identity["can_manage_users"] is False
    assert _query_plan("no_movement", identity).parameters["scope_region_0"] == "SPE"


def test_matrix_admin_override_limits_data_but_preserves_matrix_administration(
    matrix_admin_client: TestClient,
    create_user_session,
) -> None:
    token, target = create_user_session(
        name="Matrix Administrator",
        platform_role="ADMIN",
        organizational_scope="matrix",
        home_region=None,
        identity_suffix="matrix-admin-regional-override",
    )
    response = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["SPE", "SPS"]},
    )
    assert response.status_code == 200
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["organizational_region_code"] == "MATRIZ"
    assert identity["organizational_scope"] == "regional"
    assert identity["effective_regions"] == ["SPE", "SPS"]
    assert identity["platform_role"] == "ADMIN"
    assert identity["administrative_scope"] == "matrix"
    assert identity["can_manage_users"] is True
    query = _query_plan("no_movement", identity)
    assert {
        value for key, value in query.parameters.items() if key.startswith("scope_region_")
    } == {"SPE", "SPS"}


def test_data_override_does_not_grant_or_retarget_delegated_admin_permissions(
    matrix_admin_client: TestClient,
    create_user_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REGIONAL_USER_ADMINISTRATION_ENABLED", "true")
    get_settings.cache_clear()
    token, target = create_user_session(
        name="Regional Platform Admin",
        platform_role="ADMIN",
        organizational_scope="regional",
        home_region="CE",
        identity_suffix="override-no-delegation",
    )
    saved = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert saved.status_code == 200
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["effective_regions"] == ["PR"]
    assert identity["can_manage_users"] is False


def test_removing_override_restores_current_feishu_region_immediately(
    matrix_admin_client: TestClient,
    create_user_session,
) -> None:
    token, target = create_user_session(
        name="CE Return",
        home_region="CE",
        identity_suffix="override-removal",
    )
    saved = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert saved.status_code == 200
    assert _reader_client(token).get("/api/auth/me").json()["effective_regions"] == ["PR"]

    removed = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": False, "adminAllowedRegions": []},
    )
    assert removed.status_code == 200
    current = _reader_client(token).get("/api/auth/me").json()
    assert current["admin_override_enabled"] is False
    assert current["effective_scope_source"] == "FEISHU"
    assert current["effective_regions"] == ["CE"]


def test_feishu_transfer_does_not_replace_active_manual_override(
    matrix_admin_client: TestClient,
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    token, target = create_user_session(
        name="Transferred User",
        home_region="CE",
        identity_suffix="override-transfer",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, target.id)
        assert profile is not None
        profile.organizational_region_code = "BA"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    response = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert response.status_code == 200
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["organizational_region_code"] == "BA"
    assert identity["effective_regions"] == ["PR"]


def test_v2_unresolved_profile_cannot_be_bypassed_by_override(
    matrix_admin_client: TestClient,
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FEISHU_ORG_SCOPE_V2_ENABLED", "true")
    get_settings.cache_clear()
    token, target = create_user_session(
        name="Unresolved V2 User",
        home_region="CE",
        identity_suffix="override-v2-unresolved",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, target.id)
        assert profile is not None
        profile.department_paths = [["od-33e90ac1a93b12c1b65347320e648498", "od-930a0c1d13f1c393e942a8153e560641"]]
        profile.region_resolution_status = "RESOLVED"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    saved = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert saved.status_code == 409
    assert saved.json()["detail"] == "user_region_override_feishu_unavailable"
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["organizational_scope"] == "unknown"
    assert identity["effective_regions"] == []
    assert identity["effective_scope_source"] == "NONE"


def test_v2_valid_override_survives_transfer_and_removal_returns_to_new_feishu_region(
    matrix_admin_client: TestClient,
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FEISHU_ORG_SCOPE_V2_ENABLED", "true")
    get_settings.cache_clear()
    token, target = create_user_session(
        name="V2 Transferred User",
        home_region="CE",
        identity_suffix="override-v2-transfer",
    )
    ce_department = next(code for code, region in V2_DEPARTMENT_REGION_IDS.items() if region == "CE")
    ba_department = next(code for code, region in V2_DEPARTMENT_REGION_IDS.items() if region == "BA")
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, target.id)
        assert profile is not None
        profile.department_paths = [[JT_BRASIL_ID, ce_department]]
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    saved = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert saved.status_code == 200
    assert saved.json()["user"]["organizationalScopePolicy"] == "V2"

    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, target.id)
        assert profile is not None
        profile.department_paths = [[JT_BRASIL_ID, ba_department]]
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    identity = _reader_client(token).get("/api/auth/me").json()
    assert identity["organizational_region_code"] == "BA"
    assert identity["effective_regions"] == ["PR"]

    removed = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": False, "adminAllowedRegions": []},
    )
    assert removed.status_code == 200
    assert _reader_client(token).get("/api/auth/me").json()["effective_regions"] == ["BA"]


def test_v2_sync_failure_cannot_be_bypassed_by_saved_override(
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    _token, target = create_user_session(
        name="Failed V2 Sync User",
        home_region="CE",
        identity_suffix="override-v2-sync-failed",
    )
    with user_test_session_factory() as db:
        user = db.get(type(target), target.id)
        profile = db.get(PlatformUserFeishuProfile, target.id)
        assert user is not None and profile is not None
        db.add(UserAccessAudit(
            actor_type="admin",
            actor_user_id=None,
            target_user_id=target.id,
            action="regional_override_created",
            regions_added=["PR"],
            regions_removed=[],
        ))
        db.add(UserRegionAccess(user_id=target.id, region_code="PR", granted_by_user_id=target.id))
        profile.department_paths = [["od-33e90ac1a93b12c1b65347320e648498", "od-5ddc00e36f5fd1f67fe075511f6f6188"]]
        profile.region_resolution_status = "SYNC_FAILED"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        identity = identity_for_user(db, user, org_scope_v2_enabled=True, force_feishu_sync_failed=True)

    assert identity["organizational_scope"] == "unknown"
    assert identity["effective_regions"] == []
    assert identity["data_scope_source"] == "none"
    assert identity["effective_scope_source"] == "NONE"


def test_empty_or_unknown_override_is_rejected_and_audit_records_source_transition(
    matrix_admin_client: TestClient,
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    _token, target = create_user_session(
        name="Legacy Grant Target",
        organizational_scope="base",
        home_region=None,
        additional_regions=["MG"],
        feishu_region_code=None,
        identity_suffix="override-source-audit",
    )
    empty = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": []},
    )
    assert empty.status_code == 422
    invalid = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["XX"]},
    )
    assert invalid.status_code == 422

    created = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"adminOverrideEnabled": True, "adminAllowedRegions": ["PR"]},
    )
    assert created.status_code == 200
    audit = matrix_admin_client.get(f"/api/admin/users/{target.id}/access-audit").json()["entries"][0]
    assert audit["action"] == "regional_override_created_from_legacy"
    assert audit["regionsAdded"] == ["PR"]
    assert audit["regionsRemoved"] == ["MG"]
    assert audit["scopeSourceBefore"] == "LEGACY_GRANT"
    assert audit["scopeSourceAfter"] == "ADMIN_OVERRIDE"
    with user_test_session_factory() as db:
        rows = list(db.scalars(select(UserAccessAudit).where(UserAccessAudit.target_user_id == target.id)))
        assert len(rows) == 1


def test_legacy_additional_region_api_keeps_its_original_validation(
    matrix_admin_client: TestClient,
    create_user_session,
) -> None:
    _token, target = create_user_session(
        home_region="CE",
        identity_suffix="legacy-additional-compatibility",
    )
    response = matrix_admin_client.patch(
        f"/api/admin/users/{target.id}",
        json={"additionalRegions": ["CE"]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "home_region_is_not_an_extra_region"


def test_inactive_feishu_region_is_not_returned_as_confirmed_header_scope(
    create_user_session,
    user_test_session_factory: sessionmaker[Session],
) -> None:
    _token, target = create_user_session(
        home_region="CE",
        identity_suffix="inactive-region-header",
    )
    with user_test_session_factory() as db:
        region = db.get(Region, "CE")
        user = db.get(type(target), target.id)
        assert region is not None and user is not None
        region.is_active = False
        db.commit()
        identity = identity_for_user(db, user)

    assert identity["organizational_scope"] == "unknown"
    assert identity["organizational_region_code"] is None
    assert identity["region_resolution_status"] == "UNKNOWN"
    assert identity["effective_regions"] == []


@pytest.mark.parametrize(
    ("mysql_error_number", "sqlstate"),
    [(1205, None), (1213, None), (None, "40001")],
)
def test_mysql_lock_conflict_rolls_back_and_returns_conflict(
    user_test_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    mysql_error_number: int | None,
    sqlstate: str | None,
) -> None:
    class SimulatedMySQLLockFailure(Exception):
        def __init__(self) -> None:
            super().__init__(mysql_error_number or sqlstate, "simulated lock conflict")
            self.sqlstate = sqlstate

    with user_test_session_factory() as db:
        actor = PlatformUser(
            tenant_key="lock-conflict-test",
            open_id=f"matrix-admin-{mysql_error_number or sqlstate}",
            email="matrix-admin@example.test",
            display_name="Matrix Admin",
            platform_role="ADMIN",
            organizational_scope="matrix",
            is_active=True,
        )
        target = PlatformUser(
            tenant_key="lock-conflict-test",
            open_id=f"regional-user-{mysql_error_number or sqlstate}",
            email="regional-user@example.test",
            display_name="Regional User",
            platform_role="USER",
            organizational_scope="regional",
            home_region="CE",
            is_active=True,
        )
        db.add_all([actor, target])
        db.commit()
        actor_id, target_id = actor.id, target.id

        def raise_lock_conflict(*_args: object, **_kwargs: object) -> None:
            raise OperationalError(
                "SELECT ... FOR UPDATE",
                {},
                SimulatedMySQLLockFailure(),
            )

        original_scalars = db.scalars
        monkeypatch.setattr(db, "scalars", raise_lock_conflict)
        with pytest.raises(UserAccessError, match="user_access_concurrency_conflict"):
            update_user_access(
                db,
                actor=actor,
                target_id=target_id,
                platform_role=None,
                additional_regions=["SPE"],
                is_active=None,
                region_override=True,
            )
        monkeypatch.setattr(db, "scalars", original_scalars)

        assert not db.in_transaction()
        persisted = db.get(PlatformUser, target_id)
        assert persisted is not None and persisted.platform_role == "USER"
        assert list(db.scalars(
            select(UserRegionAccess.region_code).where(UserRegionAccess.user_id == target_id)
        )) == []
        assert db.scalar(
            select(UserAccessAudit.id).where(UserAccessAudit.target_user_id == target_id)
        ) is None
        assert actor_id != target_id
