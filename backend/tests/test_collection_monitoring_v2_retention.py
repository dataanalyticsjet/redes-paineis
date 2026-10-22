from collections import defaultdict
from datetime import date
import uuid

import pytest
from sqlalchemy import event, text

from app.services.collection_monitoring_v2_retention import RETENTION_FIELDS, _get_authorized_retention_aggregates as get_regional_retention
from app.services.data_foundation.queries import _query_plan
from app.services.data_foundation.repository import DataFoundationError
from test_collection_monitoring_v2_queries import _create_engine, _insert_day, ADMIN_MATRIX, ADMIN_REGIONAL, MAPPING_ID


BASE = {"role": "regional", "organizational_scope": "base", "home_base": "MATCHED-001", "home_region": "SPE"}


def baseline(engine, identity, start=20, end=22):
    plan = _query_plan("collection_monitoring", identity, date_from=date(2026, 10, start), date_to=date(2026, 10, end), contract_version=2, sql_dialect="sqlite")
    with engine.connect() as conn:
        rows = conn.execute(text(f"SELECT {plan.select_sql} {plan.from_sql} WHERE {plan.where_sql}"), plan.parameters).mappings()
        grouped = {}
        for row in rows:
            key = tuple(row[k] for k in ("data_date", "source_base_name", "order_origin", "resolved_base_code", "mapping_resolution"))
            item = grouped.setdefault(key, {k: row[k] for k in ("data_date", "source_base_name", "order_origin", "resolved_base_code", "mapping_resolution", "effective_base_code", "effective_mapping_resolution", "mapped_base_name", "mapped_region", "mapped_rm_area", "mapped_rm")})
            item["publication_id"] = str(uuid.UUID(bytes=row["publication_id"]))
            item["row_count"] = item.get("row_count", 0) + 1
            for field in RETENTION_FIELDS:
                item[field] = item.get(field, 0) + row[field]
    return sorted(grouped.values(), key=str)


@pytest.mark.parametrize("identity", [ADMIN_MATRIX, ADMIN_REGIONAL, BASE])
def test_aggregates_equal_authorized_record_query_and_keep_unmapped_national_only(identity):
    engine, contract, table = _create_engine()
    for day in (20, 21, 22):
        _insert_day(engine, contract, table, day=day, rows=[(1, True), (2, False), (3, True)])
    actual = get_regional_retention(engine, identity=identity, date_from=date(2026, 10, 20), date_to=date(2026, 10, 22))
    assert sorted(actual["aggregates"], key=str) == baseline(engine, identity)
    assert sum(r["row_count"] for r in actual["aggregates"]) == (9 if identity is ADMIN_MATRIX else 6)
    assert actual["contractVersion"] == 2


def test_exact_normalized_ambiguous_and_manual_names_keep_the_same_resolution():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=22, rows=[(1, False), (2, False), (3, False), (4, False), (5, False), (6, False)])
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO base_mapping_entries VALUES (:id, 'A2', 'CE', 'Duplicated', 'CE', 'CE-1', 'RM CE'), (:id, 'A3', 'RJ', 'Duplicated', 'RJ', 'RJ-1', 'RM RJ')"), {"id": MAPPING_ID})
        names = ['Mapped base', ' mapped   BASE ', 'Duplicated', 'Absent', None, '']
        for index, name in enumerate(names, 1):
            conn.execute(text(f"UPDATE `{table}` SET source_base_name=:name, order_origin='JMS' WHERE source_row_no=:row"), {"name": name, "row": index})
    for identity in (ADMIN_MATRIX, ADMIN_REGIONAL, BASE):
        assert sorted(get_regional_retention(engine, identity=identity, date_from=date(2026, 10, 22), date_to=date(2026, 10, 22))["aggregates"], key=str) == baseline(engine, identity, 22, 22)
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO base_mapping_name_decisions VALUES (:id, 'collection_monitoring', 'Duplicated', 'LINKED', 'A2')"), {"id": MAPPING_ID})
    assert sorted(get_regional_retention(engine, identity=ADMIN_MATRIX, date_from=date(2026, 10, 22), date_to=date(2026, 10, 22))["aggregates"], key=str) == baseline(engine, ADMIN_MATRIX, 22, 22)


def test_active_version_only_aborted_and_superseded_facts_excluded_and_no_page_limit():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=22, rows=[(1, True), (2, True)])
    with engine.begin() as conn:
        conn.exec_driver_sql("INSERT INTO source_publications SELECT x'99999999999999999999999999999999', source_id, contract_version, 999, period_start, period_end, snapshot_as_of, published_at, row_count, 'ABORTED' FROM source_publications")
        conn.exec_driver_sql("INSERT INTO source_publication_dates SELECT source_id, x'99999999999999999999999999999999', data_date, row_count FROM source_publication_dates")
        cols = [r[1] for r in conn.exec_driver_sql(f"PRAGMA table_info(`{table}`)")]
        select = ', '.join("x'99999999999999999999999999999999'" if key == 'publication_id' else f'`{key}`' for key in cols)
        conn.exec_driver_sql(f"INSERT INTO `{table}` SELECT {select} FROM `{table}`")
    statements=[]
    event.listen(engine,"before_cursor_execute",lambda _c,_cu,sql,_p,_ctx,_m: statements.append(sql))
    result = get_regional_retention(engine, identity=ADMIN_MATRIX, date_from=date(2026,10,22), date_to=date(2026,10,22))
    assert sum(r['row_count'] for r in result['aggregates']) == 2
    query = next(sql for sql in statements if 'WITH candidate_facts AS' in sql)
    assert 'publication_state = \'PUBLISHED\'' in query
    assert 'ROW_NUMBER()' in query and 'publication_rank = 1' in query
    assert 'FROM mapping_keys AS fact' in query and 'FROM keyed_facts GROUP BY' in query
    assert 'SELECT DISTINCT fact.source_base_name_key' in query
    assert 'LIMIT' not in query
    assert len(statements) == 2  # map guard + one aggregated query, no regional/day N+1
    with engine.begin() as conn:
        conn.exec_driver_sql("UPDATE source_publications SET publication_state='PUBLISHED' WHERE version_no=999")
    result = get_regional_retention(engine, identity=ADMIN_MATRIX, date_from=date(2026,10,22), date_to=date(2026,10,22))
    assert all(r['publication_id'] == '99999999-9999-9999-9999-999999999999' for r in result['aggregates'])
    assert sum(r['row_count'] for r in result['aggregates']) == 2


@pytest.mark.parametrize('identity', [{}, {'platform_role':'ADMIN','role':'regional','organizational_scope':'regional','effective_regions':[]}])
def test_unresolved_scope_never_returns_national_aggregates(identity):
    engine, _, _ = _create_engine()
    with pytest.raises(DataFoundationError):
        get_regional_retention(engine,identity=identity,date_from=date(2026,10,20),date_to=date(2026,10,22))


def test_missing_map_and_invalid_period_are_blocked():
    engine, _, _ = _create_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql('DELETE FROM base_mapping_current')
    with pytest.raises(DataFoundationError):
        get_regional_retention(engine,identity=ADMIN_MATRIX,date_from=date(2026,10,20),date_to=date(2026,10,22))
    with pytest.raises(DataFoundationError):
        get_regional_retention(engine,identity=ADMIN_MATRIX,date_from=date(2026,10,22),date_to=date(2026,10,20))


def test_endpoint_uses_only_authenticated_backend_scope_and_anonymous_access_is_denied(monkeypatch):
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api.dependencies import get_current_viewer
    monkeypatch.setattr('app.api.data_foundation._require_feature', lambda: None)
    monkeypatch.setattr('app.api.data_foundation._engine', lambda: object())
    seen=[]
    def fake(_engine, **kwargs):
        seen.append(kwargs['identity'])
        return {'sourceId':'collection_monitoring','contractVersion':2,'aggregates':[]}
    monkeypatch.setattr('app.api.data_foundation.get_regional_retention_table', fake)
    with TestClient(app) as client:
        assert client.get('/api/v2/collection-monitoring-v2/regional-retention?date_from=2026-10-20&date_to=2026-10-22').status_code == 401
        assert seen == []
        app.dependency_overrides[get_current_viewer] = lambda: SimpleNamespace(identity=ADMIN_REGIONAL)
        response=client.get('/api/v2/collection-monitoring-v2/regional-retention?date_from=2026-10-20&date_to=2026-10-22&scope=matrix&region=MATRIZ')
        assert response.status_code == 200
        assert seen == [ADMIN_REGIONAL]


def test_duplicate_fact_rows_are_weighted_once_and_all_exact_keys_remain_distinct():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=22, rows=[(1, True), (2, True), (3, True)])
    with engine.begin() as conn:
        conn.exec_driver_sql(f"UPDATE `{table}` SET order_origin='JMS'")
    result=get_regional_retention(engine,identity=ADMIN_MATRIX,date_from=date(2026,10,22),date_to=date(2026,10,22))['aggregates']
    assert len(result)==1 and result[0]['row_count']==3
    assert result[0]['expected_dropoff']==6
    assert result == baseline(engine, ADMIN_MATRIX,22,22)
    with engine.begin() as conn:
        conn.exec_driver_sql(f"UPDATE `{table}` SET source_base_name='mapped base ' WHERE source_row_no=2")
    result=get_regional_retention(engine,identity=ADMIN_MATRIX,date_from=date(2026,10,22),date_to=date(2026,10,22))['aggregates']
    assert len(result)==2 and sum(row['row_count'] for row in result)==3
    assert sorted(result,key=str) == baseline(engine, ADMIN_MATRIX,22,22)


def test_table_response_finishes_filters_and_latest_three_dates_on_backend():
    from app.services.collection_monitoring_v2_retention import get_regional_retention_table
    engine, contract, table = _create_engine()
    for day in (18, 20, 21, 22):
        _insert_day(engine, contract, table, day=day, rows=[(1, True), (2, False), (3, True)])
    arguments=dict(engine=engine,identity=ADMIN_MATRIX,date_from=date(2026,10,18),date_to=date(2026,10,22))
    result=get_regional_retention_table(**arguments)['aggregates']
    assert sorted({r['data_date'] for r in result}) == ['2026-10-20','2026-10-21','2026-10-22']
    assert len(result)==6 and sum(r['row_count'] for r in result)==9
    assert all('source_base_name' not in r and 'mapped_rm' not in r for r in result)
    filtered=get_regional_retention_table(**arguments,region='SPE',rm='RM One',rm_area='SPE',base='Mapped base',origin='order_origin-1',rgm_filter=True,rgm_regions=['SPE'])['aggregates']
    assert len(filtered)==3
    assert all(r['expected_dropoff']==1 and r['row_count']==1 and r['region']=='SPE' for r in filtered)
    assert get_regional_retention_table(**arguments,rgm_filter=True,rgm_regions=[])['aggregates']==[]
    assert get_regional_retention_table(**arguments,region='CE')['aggregates']==[]
    arguments['identity']=ADMIN_REGIONAL
    assert all(r['region']=='SPE' for r in get_regional_retention_table(**arguments)['aggregates'])
    assert get_regional_retention_table(**arguments,region='Sem regional')['aggregates']==[]


def test_backend_display_filters_match_existing_javascript_whitespace_semantics():
    from app.services.collection_monitoring_v2_retention import get_regional_retention_table
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=22, rows=[(1, True)])
    with engine.begin() as conn:
        conn.execute(text("UPDATE base_mapping_entries SET base_name=:base, rm_responsible=:rm"),{'base':' Mapped \tbase\uFEFF','rm':' RM\u00A0One '})
    rows=get_regional_retention_table(engine,identity=ADMIN_MATRIX,date_from=date(2026,10,22),date_to=date(2026,10,22),base='Mapped base',rm='RM One')['aggregates']
    assert len(rows)==1 and rows[0]['row_count']==1
