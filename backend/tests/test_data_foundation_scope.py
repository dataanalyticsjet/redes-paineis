from __future__ import annotations

import pytest

from datetime import date

from app.services.data_foundation.queries import _query_plan, get_date_counts
from app.services.data_foundation.repository import DataFoundationError


def test_admin_scope_remains_regional_and_filters_use_official_current_mapping():
    plan = _query_plan(
        "jt_monitoring",
        {
            "platform_role": "ADMIN",
            "organizational_scope": "regional",
            "role": "regional",
            "home_region": "SPE",
            "additional_regions": ["SPS"],
        },
        region="SPS",
    )

    assert "current_entry.map_version_id = current_map.map_version_id" in plan.from_sql
    assert "fact.resolved_base_code IS NOT NULL" in plan.where_sql
    assert "fact.mapping_resolution IN ('CODE_MATCH', 'NAME_APPROVED')" in plan.where_sql
    assert plan.parameters["scope_region_0"] == "SPE"
    assert plan.parameters["scope_region_1"] == "SPS"
    assert plan.parameters["filter_region"] == "SPS"


def test_admin_without_an_explicit_organizational_scope_is_denied():
    with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
        _query_plan("no_movement", {"platform_role": "ADMIN", "role": "admin"})


def test_national_scope_requires_explicit_matrix_assignment():
    matrix = _query_plan("no_movement", {"organizational_scope": "matrix", "role": "matrix"})
    assert "fact.resolved_base_code IS NOT NULL" in matrix.where_sql

    with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
        _query_plan("no_movement", {"platform_role": "ADMIN", "organizational_scope": "regional"})


def test_historical_publication_query_pins_version_but_keeps_current_scope():
    plan = _query_plan(
        "collection_rate",
        {"organizational_scope": "regional", "role": "regional", "home_region": "SPE"},
        publication_id="e9b66e1c-1afc-4bca-9c5e-97a65a70fd87",
    )

    assert "selected_publication.publication_state = 'PUBLISHED'" in plan.from_sql
    assert "source_daily_head" not in plan.from_sql
    assert plan.parameters["selected_publication_id"] == bytes.fromhex("e9b66e1c1afc4bca9c5e97a65a70fd87")
    assert "BINARY current_entry.regional_name" in plan.where_sql


def test_date_count_rejects_reversed_date_range_before_database_access():
    with pytest.raises(DataFoundationError, match="date_range_invalid"):
        get_date_counts(
            None,
            source_id="collection_monitoring",
            identity={"organizational_scope": "regional", "role": "regional", "home_region": "SPE"},
            date_from=date(2026, 10, 10),
            date_to=date(2026, 10, 9),
        )

