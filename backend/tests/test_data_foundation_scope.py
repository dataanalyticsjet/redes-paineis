from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from types import SimpleNamespace

from datetime import date

from app.api.data_foundation import MAX_PAGE_SIZE, _require_metadata_feature
from app.api.dependencies import get_current_viewer, require_admin
from app.main import app
from app.services.data_foundation.queries import _query_plan, get_date_counts
from app.services.data_foundation.repository import DataFoundationError


MATRIX_ADMIN_IDENTITY = {
    "platform_role": "ADMIN",
    "organizational_scope": "matrix",
    "role": "matrix",
}


def test_matrix_admin_query_plan_includes_mapped_and_unmapped_rows():
    plan = _query_plan(
        "jt_monitoring",
        MATRIX_ADMIN_IDENTITY,
    )

    assert "effective_entry.map_version_id = current_map.map_version_id" in plan.from_sql
    assert "LEFT JOIN base_mapping_entries AS effective_entry" in plan.from_sql
    assert "effective_entry.uf_code AS mapped_uf" in plan.select_sql
    assert "effective_entry.rm_region AS mapped_rm_area" in plan.select_sql
    assert "effective_entry.rm_responsible AS mapped_rm" in plan.select_sql
    assert "fact.resolved_base_code IS NOT NULL" not in plan.where_sql
    assert "fact.mapping_resolution IN" not in plan.where_sql


@pytest.mark.parametrize(
    "identity",
    [
        {"platform_role": "USER", "organizational_scope": "regional", "role": "regional"},
        {"platform_role": "USER", "organizational_scope": "unknown", "role": "unknown"},
        {"platform_role": "USER", "organizational_scope": "matrix", "role": "regional"},
    ],
)
def test_query_plan_rejects_missing_or_inconsistent_data_scope(identity):
    with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
        _query_plan("no_movement", identity)


def test_matrix_user_can_read_national_data_without_admin_role():
    plan = _query_plan(
        "no_movement",
        {"platform_role": "USER", "organizational_scope": "matrix", "role": "matrix"},
    )

    assert "scope_region_" not in plan.where_sql
    assert "scope_base_code" not in plan.where_sql


def test_regional_user_query_is_server_scoped_independently_of_admin_role():
    identity = {
        "platform_role": "USER",
        "organizational_scope": "regional",
        "role": "regional",
        "home_region": "SPE",
        "additional_regions": ["SPS"],
    }
    plan = _query_plan("collection_rate", identity, contract_version=2)

    assert "effective_entry.regional_name IN (:scope_region_0, :scope_region_1)" in plan.where_sql
    assert plan.parameters["scope_region_0"] == "SPE"
    assert plan.parameters["scope_region_1"] == "SPS"


def test_base_user_query_keeps_base_scope_when_client_requests_another_base():
    plan = _query_plan(
        "pdd_collection_failure",
        {
            "platform_role": "ADMIN",
            "organizational_scope": "base",
            "role": "regional",
            "home_base": "311197",
            "home_region": "SPE",
        },
        contract_version=2,
        base_code="OTHER-BASE",
    )

    assert "effective_entry.base_code = :scope_base_code" in plan.where_sql
    assert "effective_entry.base_code = :filter_base_code" in plan.where_sql
    assert plan.parameters["scope_base_code"] == "311197"
    assert plan.parameters["filter_base_code"] == "OTHER-BASE"


def test_admin_permission_is_independent_from_dashboard_data_scope():
    regional_admin = SimpleNamespace(
        user=SimpleNamespace(platform_role="ADMIN"),
        identity={"organizational_scope": "regional", "role": "regional"},
    )
    assert require_admin(regional_admin) is regional_admin

    matrix_user = SimpleNamespace(
        user=SimpleNamespace(platform_role="USER"),
        identity={"organizational_scope": "matrix", "role": "matrix"},
    )
    with pytest.raises(HTTPException) as user_error:
        require_admin(matrix_user)
    assert user_error.value.status_code == 403
    assert user_error.value.detail == "admin_required"

    matrix_admin = SimpleNamespace(
        user=SimpleNamespace(platform_role="ADMIN"),
        identity={"organizational_scope": "matrix", "role": "matrix"},
    )
    assert require_admin(matrix_admin) is matrix_admin


def test_v2_metadata_is_available_for_import_review_without_enabling_queries(monkeypatch):
    monkeypatch.setattr(
        "app.api.data_foundation.get_settings",
        lambda: SimpleNamespace(data_queries_enabled=False, data_import_enabled=False),
    )
    with pytest.raises(HTTPException) as disabled_error:
        _require_metadata_feature()
    assert disabled_error.value.status_code == 503
    assert disabled_error.value.detail == "data_foundation_v2_disabled"

    monkeypatch.setattr(
        "app.api.data_foundation.get_settings",
        lambda: SimpleNamespace(data_queries_enabled=False, data_import_enabled=True),
    )
    _require_metadata_feature()


def test_historical_publication_query_pins_version_but_keeps_current_scope():
    plan = _query_plan(
        "collection_rate",
        MATRIX_ADMIN_IDENTITY,
        publication_id="e9b66e1c-1afc-4bca-9c5e-97a65a70fd87",
    )

    assert "selected_publication.publication_state = 'PUBLISHED'" in plan.from_sql
    assert "source_daily_head" not in plan.from_sql
    assert plan.parameters["selected_publication_id"] == bytes.fromhex("e9b66e1c1afc4bca9c5e97a65a70fd87")
    assert "fact.resolved_base_code IS NOT NULL" not in plan.where_sql


def test_date_count_rejects_reversed_date_range_before_database_access():
    with pytest.raises(DataFoundationError, match="date_range_invalid"):
        get_date_counts(
            None,
            source_id="collection_monitoring",
            identity=MATRIX_ADMIN_IDENTITY,
            date_from=date(2026, 10, 10),
            date_to=date(2026, 10, 9),
        )


ADMIN_READ_ENDPOINTS = [
    "/api/v2/data-sources",
    "/api/v2/base-mapping/name-candidates/00000000-0000-0000-0000-000000000000",
    "/api/v2/data-sources/collection_monitoring/contract",
    "/api/v2/imports/00000000-0000-0000-0000-000000000000",
]


def _viewer(platform_role: str, organizational_scope: str):
    role = "matrix" if organizational_scope == "matrix" else "regional"
    return SimpleNamespace(
        user=SimpleNamespace(platform_role=platform_role, id=1),
        identity={
            "platform_role": platform_role,
            "administrative_scope": organizational_scope,
            "organizational_scope": organizational_scope,
            "role": role,
        },
    )


@pytest.mark.parametrize(
    ("platform_role", "organizational_scope"),
    [
        ("USER", "matrix"),
        ("USER", "regional"),
    ],
)
def test_administration_endpoints_require_admin_but_not_matrix_scope(
    platform_role, organizational_scope,
):
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_current_viewer] = lambda: _viewer(platform_role, organizational_scope)
    try:
        with TestClient(app) as client:
            for endpoint in ADMIN_READ_ENDPOINTS:
                response = client.get(endpoint)
                assert response.status_code == 403, endpoint
                assert response.json()["detail"] == "admin_required", endpoint
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def test_regional_and_matrix_users_can_read_publications_under_their_own_scope(monkeypatch):
    previous = dict(app.dependency_overrides)
    monkeypatch.setenv("DATA_SOURCES_ENABLED", "true")
    from app.core.config import get_settings
    get_settings.cache_clear()
    regional = _viewer("USER", "regional")
    regional.identity.update({"home_region": "SPE", "additional_regions": []})
    app.dependency_overrides[get_current_viewer] = lambda: regional
    monkeypatch.setattr("app.api.data_foundation._engine", lambda: SimpleNamespace(dialect=SimpleNamespace(name="sqlite")))

    def scoped_publications(_engine, *, identity, **_kwargs):
        return {"sourceId": "collection_monitoring", "scope": identity["organizational_scope"]}

    monkeypatch.setattr("app.api.data_foundation.get_publications", scoped_publications)
    try:
        with TestClient(app) as client:
            regional_response = client.get("/api/v2/data-sources/collection_monitoring/publications")
            assert regional_response.status_code == 200
            assert regional_response.json()["scope"] == "regional"

            app.dependency_overrides[get_current_viewer] = lambda: _viewer("USER", "matrix")
            matrix_response = client.get("/api/v2/data-sources/collection_monitoring/publications")
            assert matrix_response.status_code == 200
            assert matrix_response.json()["scope"] == "matrix"
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        get_settings.cache_clear()


def test_unknown_scope_is_rejected_before_publication_query_database_access(monkeypatch):
    from app.services.data_foundation.queries import get_publications

    with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
        get_publications(
            SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
            source_id="collection_monitoring",
            identity={"platform_role": "USER", "organizational_scope": "unknown", "role": "unknown"},
            limit=1,
            offset=0,
        )


def test_v2_read_endpoints_require_authentication():
    with TestClient(app) as client:
        response = client.get("/api/v2/data-sources/collection_monitoring/records")
    assert response.status_code == 401
    assert response.json()["detail"] == "authentication_required"


def test_jt_records_endpoint_caps_each_response_to_one_page():
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_current_viewer] = lambda: _viewer("ADMIN", "matrix")
    try:
        with TestClient(app) as client:
            response = client.get(
                "/api/v2/data-sources/jt_monitoring/records",
                params={"limit": 159_666},
            )
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
    assert MAX_PAGE_SIZE == 250
    assert response.status_code == 422
