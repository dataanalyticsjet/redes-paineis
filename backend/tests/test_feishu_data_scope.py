from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import AuthenticatedViewer, require_matrix_admin
from app.core.config import get_settings
from app.main import app
from app.models import PlatformUserFeishuProfile
from app.services.data_foundation.queries import _query_plan
from app.services.data_foundation.repository import DataFoundationError
from app.services.user_access import (
    UserAccessError,
    can_administer_user,
    identity_for_user,
    user_administration_identity,
)
from app.services import feishu_auth
from app.services.row_scope import scope_parsed_rows


def test_five_reference_users_separate_feishu_data_scope_from_admin_role(
    create_user_session, user_test_session_factory, monkeypatch,
):
    cases = [
        ("ref-1", "ADMIN", "matrix", None, None, "MATRIZ"),
        ("ref-2", "USER", "base", None, None, "MATRIZ"),
        ("ref-3", "USER", "base", None, None, "CE"),
        ("ref-4", "USER", "base", None, None, "MATRIZ"),
        (
            "ref-5", "ADMIN", "base", None,
            ["CE", "SPE", "SPS", "MG", "RJ", "PR", "SR", "SPN", "PA", "BA"],
            "MATRIZ",
        ),
    ]
    users = []
    for suffix, role, scope, home_region, grants, feishu_region in cases:
        _token, user = create_user_session(
            identity_suffix=suffix,
            platform_role=role,
            organizational_scope=scope,
            home_region=home_region,
            additional_regions=grants,
            feishu_region_code=feishu_region,
        )
        users.append(user)

    assert [user.id for user in users] == [1, 2, 3, 4, 5]
    with user_test_session_factory() as db:
        identities = [identity_for_user(db, db.get(type(user), user.id)) for user in users]

    # ID 1 retains global admin authority from the platform's explicit matrix
    # assignment. IDs 2 and 4 get national data from Feishu without ADMIN.
    assert identities[0]["organizational_scope"] == "matrix"
    assert identities[0]["administrative_scope"] == "matrix"
    assert identities[1]["organizational_scope"] == "matrix"
    assert identities[1]["platform_role"] == "USER"
    assert identities[3]["organizational_scope"] == "matrix"
    assert identities[3]["platform_role"] == "USER"
    assert identities[2]["organizational_scope"] == "regional"
    assert identities[2]["effective_regions"] == ["CE"]

    for national_identity in (identities[0], identities[1], identities[3], identities[4]):
        national_plan = _query_plan("no_movement", national_identity)
        assert "scope_region_" not in national_plan.where_sql
        assert "scope_base_code" not in national_plan.where_sql
    regional_plan = _query_plan("no_movement", identities[2])
    assert "scope_region_0" in regional_plan.where_sql
    assert regional_plan.parameters["scope_region_0"] == "CE"

    with pytest.raises(HTTPException) as matrix_user_error:
        require_matrix_admin(AuthenticatedViewer(user=users[1], identity=identities[1]))
    assert matrix_user_error.value.status_code == 403
    assert matrix_user_error.value.detail == "admin_required"
    require_matrix_admin(AuthenticatedViewer(user=users[0], identity=identities[0]))

    # ID 5's Feishu MATRIZ resolution grants national data, but its persisted
    # administrative scope is base. Ten region grants do not make it a global
    # administrator. With delegated administration enabled, they remain the
    # exact boundary for regional user administration.
    id5 = identities[4]
    assert id5["organizational_scope"] == "matrix"
    assert id5["administrative_scope"] == "base"
    with pytest.raises(HTTPException) as global_admin_error:
        require_matrix_admin(AuthenticatedViewer(user=users[4], identity=id5))
    assert global_admin_error.value.status_code == 403
    assert global_admin_error.value.detail == "matrix_admin_required"

    monkeypatch.setenv("REGIONAL_USER_ADMINISTRATION_ENABLED", "true")
    get_settings.cache_clear()
    with user_test_session_factory() as db:
        delegated = user_administration_identity(db, db.get(type(users[4]), users[4].id))
        assert len(delegated["administrative_regions"]) == 10
        assert can_administer_user(delegated, users[2], identities[2]) is True
        assert can_administer_user(delegated, users[0], identities[0]) is False


def test_platform_matrix_or_base_assignment_without_feishu_or_grant_is_not_data_access(
    create_user_session, user_test_session_factory,
):
    _token, matrix_user = create_user_session(
        identity_suffix="no-feishu-matrix",
        organizational_scope="matrix",
        home_region=None,
        feishu_region_code=None,
    )
    _token, base_user = create_user_session(
        identity_suffix="no-feishu-base",
        organizational_scope="base",
        home_region=None,
        feishu_region_code=None,
    )
    with user_test_session_factory() as db:
        matrix_identity = identity_for_user(db, db.get(type(matrix_user), matrix_user.id))
        base_identity = identity_for_user(db, db.get(type(base_user), base_user.id))
    assert matrix_identity["organizational_scope"] == "unknown"
    assert matrix_identity["effective_regions"] == []
    assert base_identity["organizational_scope"] == "unknown"
    for identity in (matrix_identity, base_identity):
        with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
            _query_plan("no_movement", identity)


def test_resolved_feishu_region_is_not_broadened_by_manual_region_grants(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="feishu-region-overrides-grants",
        organizational_scope="base",
        home_region=None,
        additional_regions=["SPE", "MG"],
        feishu_region_code="CE",
    )
    with user_test_session_factory() as db:
        identity = identity_for_user(db, db.get(type(user), user.id))

    assert identity["organizational_scope"] == "regional"
    assert identity["home_region"] == "CE"
    assert identity["effective_regions"] == ["CE"]
    plan = _query_plan("no_movement", identity)
    assert plan.parameters["scope_region_0"] == "CE"
    assert len([key for key in plan.parameters if key.startswith("scope_region_")]) == 1
    parsed = {
        "headers": ["Regional Origem", "Base"],
        "regionColumn": "Regional Origem",
        "baseColumn": "Base",
        "rows": [
            {"Regional Origem": "CE", "Base": "CE-01"},
            {"Regional Origem": "SPE", "Base": "SP-01"},
            {"Regional Origem": "MG", "Base": "MG-01"},
        ],
    }
    scoped = scope_parsed_rows(parsed, identity)
    assert [row["Regional Origem"] for row in scoped["rows"]] == ["CE"]


def test_sync_failed_never_reuses_last_feishu_region_and_successful_sync_restores_scope(
    create_user_session, user_test_session_factory,
):
    _token, user = create_user_session(
        identity_suffix="expiring-feishu-matrix",
        organizational_scope="base",
        home_region=None,
        feishu_region_code="MATRIZ",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        assert profile is not None
        profile.region_resolution_status = "SYNC_FAILED"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=23)
        db.commit()
        current_identity = identity_for_user(db, db.get(type(user), user.id))
        assert current_identity["organizational_scope"] == "unknown"
        assert current_identity["effective_regions"] == []
        assert current_identity["data_scope_source"] == "none"
        with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
            _query_plan("no_movement", current_identity)

        # A newly successful Feishu sync restores only the currently resolved
        # regional assignment; the previous national assignment is not reused.
        profile.organizational_region_code = "CE"
        profile.region_resolution_status = "RESOLVED"
        db.commit()
        recovered_identity = identity_for_user(db, db.get(type(user), user.id))
        assert recovered_identity["organizational_scope"] == "regional"
        assert recovered_identity["effective_regions"] == ["CE"]
        assert recovered_identity["data_scope_source"] == "feishu"
        recovered_plan = _query_plan("no_movement", recovered_identity)
        assert recovered_plan.parameters["scope_region_0"] == "CE"

        profile.region_resolution_status = "AMBIGUOUS"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        ambiguous_identity = identity_for_user(db, db.get(type(user), user.id))
        assert ambiguous_identity["organizational_scope"] == "unknown"

        profile.region_resolution_status = "RESOLVED"
        profile.organizational_region_code = "NOT-OFFICIAL"
        db.commit()
        unrecognized_identity = identity_for_user(db, db.get(type(user), user.id))
        assert unrecognized_identity["organizational_scope"] == "unknown"


def test_sync_failed_uses_only_explicit_active_region_grants(create_user_session, user_test_session_factory):
    _token, user = create_user_session(
        identity_suffix="sync-failed-explicit-regions",
        platform_role="ADMIN",
        organizational_scope="base",
        home_region=None,
        additional_regions=["CE", "SPE"],
        feishu_region_code="MATRIZ",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        assert profile is not None
        profile.region_resolution_status = "SYNC_FAILED"
        db.commit()

        identity = identity_for_user(db, db.get(type(user), user.id))

    assert identity["platform_role"] == "ADMIN"
    assert identity["organizational_scope"] == "regional"
    assert identity["data_scope_source"] == "admin_grant"
    assert identity["effective_regions"] == ["CE", "SPE"]
    plan = _query_plan("no_movement", identity)
    assert {value for key, value in plan.parameters.items() if key.startswith("scope_region_")} == {"CE", "SPE"}
    assert "scope_region_" in plan.where_sql
    assert "scope_base_code" not in plan.parameters
    with pytest.raises(HTTPException) as admin_error:
        require_matrix_admin(AuthenticatedViewer(user=user, identity=identity))
    assert admin_error.value.status_code == 403


def test_sync_failed_without_grants_blocks_v2_kpis_tables_and_csv_endpoints(
    create_user_session, user_test_session_factory, monkeypatch,
):
    token, user = create_user_session(
        identity_suffix="sync-failed-v2-api",
        organizational_scope="matrix",
        home_region=None,
        feishu_region_code="MATRIZ",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        assert profile is not None
        profile.region_resolution_status = "SYNC_FAILED"
        db.commit()

    monkeypatch.setenv("DATA_QUERIES_ENABLED", "true")
    get_settings.cache_clear()
    monkeypatch.setattr(
        "app.api.data_foundation._engine",
        lambda: SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
    )
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)

    paths = [
        "/api/v2/data-sources/collection_monitoring/publications",
        "/api/v2/data-sources/collection_monitoring/dates",
        "/api/v2/data-sources/collection_monitoring/records",
        "/api/v2/data-sources/collection_monitoring/export.csv",
    ]
    try:
        for path in paths:
            response = client.get(path)
            assert response.status_code == 403, path
            assert response.json()["detail"] == "user_scope_unavailable", path

        # Data authorization failure does not end the authenticated Feishu session.
        profile_response = client.get("/api/auth/me")
        assert profile_response.status_code == 200
        assert profile_response.json()["authenticated"] is True
        assert profile_response.json()["organizational_scope"] == "unknown"
        assert profile_response.json()["region_resolution_status"] == "SYNC_FAILED"
    finally:
        get_settings.cache_clear()


def test_unpersisted_sync_failure_is_fail_closed_until_a_new_successful_profile_sync(
    create_user_session, user_test_session_factory, monkeypatch,
):
    _token, user = create_user_session(
        identity_suffix="unpersisted-sync-failure",
        organizational_scope="base",
        home_region=None,
        feishu_region_code="CE",
    )
    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        assert profile is not None and profile.last_successful_sync_at is not None
        failure_timestamp = profile.last_successful_sync_at.replace(tzinfo=timezone.utc).timestamp() + 1

    monkeypatch.setattr(
        "app.api.dependencies.get_local_session",
        lambda *_args: {"user_id": user.id, "_feishu_sync_failed_at": failure_timestamp},
    )
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    failed_identity = client.get("/api/auth/me").json()
    assert failed_identity["authenticated"] is True
    assert failed_identity["region_resolution_status"] == "SYNC_FAILED"
    assert failed_identity["organizational_scope"] == "unknown"
    assert failed_identity["effective_regions"] == []

    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        assert profile is not None
        profile.organizational_region_code = "SPE"
        profile.region_resolution_status = "RESOLVED"
        profile.last_successful_sync_at = datetime.fromtimestamp(failure_timestamp + 1, timezone.utc).replace(tzinfo=None)
        db.commit()

    recovered_identity = client.get("/api/auth/me").json()
    assert recovered_identity["region_resolution_status"] == "RESOLVED"
    assert recovered_identity["organizational_scope"] == "regional"
    assert recovered_identity["effective_regions"] == ["SPE"]


def test_same_session_observes_feishu_region_change_and_invalidates_identity_key(
    create_user_session, user_test_session_factory,
):
    token, user = create_user_session(
        identity_suffix="feishu-region-change",
        organizational_scope="base",
        home_region=None,
        feishu_region_code="CE",
    )
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    before = client.get("/api/auth/me").json()
    assert before["effective_regions"] == ["CE"]

    with user_test_session_factory() as db:
        profile = db.get(PlatformUserFeishuProfile, user.id)
        profile.organizational_region_code = "SPS"
        profile.region_resolution_status = "RESOLVED"
        profile.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    after = client.get("/api/auth/me").json()
    assert after["effective_regions"] == ["SPS"]
    assert after["organizational_region_code"] == "SPS"
    assert after["administrative_scope"] == "base"
    assert after["data_scope_source"] == "feishu"
