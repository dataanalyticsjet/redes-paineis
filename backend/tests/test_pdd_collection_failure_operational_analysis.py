from datetime import date, datetime
import uuid

from sqlalchemy import create_engine, text

from app.services.pdd_collection_failure_operational_analysis import (
    build_bilingual_analysis,
    generate_publication_analysis,
    get_analysis_history,
)


def _schema(engine, *, include_fact=True):
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB, source_id TEXT, version_no INTEGER, contract_version INTEGER, map_version_id BLOB, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publication_dates (source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, base_name TEXT, regional_name TEXT, rm_responsible TEXT, PRIMARY KEY (map_version_id, base_code))")
        if include_fact:
            connection.exec_driver_sql("CREATE TABLE fact_pdd_collection_failure_v2 (source_id TEXT, publication_id BLOB, map_version_id BLOB, data_date DATE, resolved_base_code TEXT, source_base_code TEXT, source_base_name TEXT, total_orders INTEGER, orders_unscanned_at_collection INTEGER)")
        connection.exec_driver_sql("""CREATE TABLE pdd_collection_failure_operational_analyses (
            analysis_id BLOB PRIMARY KEY, source_id TEXT, publication_id BLOB, publication_version INTEGER,
            contract_version INTEGER, map_version_id BLOB, operational_date DATE, analysis_state TEXT,
            total_orders INTEGER, orders_unscanned_at_collection INTEGER, collection_failure_rate NUMERIC,
            results_json TEXT, message_pt_zh TEXT, rules_version TEXT, error_code TEXT, generated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE (publication_id, rules_version))""")


def _published(connection, publication_id, map_id, version, state="PUBLISHED", contract=2):
    connection.execute(text("INSERT INTO source_publications VALUES (:pid,'pdd_collection_failure',:version,:contract,:map,:state)"), {
        "pid": publication_id.bytes, "version": version, "contract": contract,
        "map": map_id.bytes, "state": state,
    })


def test_analysis_uses_official_weighted_formula_and_deterministic_priority():
    message, results = build_bilingual_analysis(
        operational_date=date(2026, 10, 26), publication_version=8,
        total_orders=1000, orders_unscanned=140, unmapped_total=100, unmapped_unscanned=20,
        generated_at=datetime(2026, 10, 26, 11, 59),
        bases=[
            {"code": "002", "name": "Base B", "region": "SPE", "owner": None, "total": 100, "unscanned": 20},
            {"code": "001", "name": "Base A", "region": "SPE", "owner": "RM A", "total": 500, "unscanned": 100},
            {"code": "003", "name": "Sem falha", "region": "SPS", "owner": "RM C", "total": 900, "unscanned": 0},
        ],
    )
    assert "Bom dia, pessoal!" in message and "大家早上好！" in message
    assert "Total de pedidos: **1.000**" in message
    assert "Pedidos não bipados: **140 (14,0%)**" in message
    assert message.index("Base A") < message.index("Base B")
    assert "Sem falha" not in message
    assert "Sem RM" in message
    assert "100 pedidos, 20 não bipados" in message
    assert results["metric"]["rateFormula"] == "SUM(orders_unscanned_at_collection) / SUM(total_orders)"
    assert [row["baseCode"] for row in results["priorityBases"]] == ["001", "002"]


def test_zero_denominator_is_not_rendered_as_an_artificial_hundred_percent():
    message, results = build_bilingual_analysis(
        operational_date=date(2026, 10, 26), publication_version=8,
        total_orders=0, orders_unscanned=0,
        bases=[{"code": "001", "name": "Base", "total": 0, "unscanned": 1}],
        generated_at=datetime(2026, 10, 26, 12, 0),
    )
    assert "—" in message
    assert "100,0%" not in message
    assert results["metric"]["failureRate"] is None


def test_generation_uses_latest_date_pinned_map_and_keeps_unmapped_national_rows_idempotently():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine)
    publication_id, other_id, aborted_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    pinned_map, other_map = uuid.uuid4(), uuid.uuid4()
    old_day, latest_day, empty_day = date(2026, 10, 24), date(2026, 10, 25), date(2026, 10, 26)
    with engine.begin() as connection:
        _published(connection, publication_id, pinned_map, 7)
        _published(connection, other_id, other_map, 8)
        _published(connection, aborted_id, uuid.uuid4(), 9, state="ABORTED")
        for day, count in ((old_day, 2), (latest_day, 3), (empty_day, 0)):
            connection.execute(text("INSERT INTO source_publication_dates VALUES ('pdd_collection_failure',:pid,:day,:count)"), {"pid": publication_id.bytes, "day": day, "count": count})
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('pdd_collection_failure',:pid,:day,3)"), {"pid": other_id.bytes, "day": latest_day})
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('pdd_collection_failure',:pid,:day,4)"), {"pid": aborted_id.bytes, "day": empty_day})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map,'001','Base oficial','SPE','RM Oficial')"), {"map": pinned_map.bytes})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map,'001','Outra versão','RJ','Outro RM')"), {"map": other_map.bytes})
        facts = [
            (publication_id, pinned_map, old_day, "001", "001", "JMS", 500, 100),
            (publication_id, pinned_map, latest_day, "001", "001", "JMS", 100, 20),
            (publication_id, pinned_map, latest_day, "001", "001", "JMS", 200, 40),
            (publication_id, pinned_map, latest_day, None, "X-1", "Sem mapa", 50, 15),
            (other_id, other_map, latest_day, "001", "001", "JMS", 9000, 8000),
            (aborted_id, uuid.uuid4(), empty_day, None, "X-2", "Aborted", 8000, 7000),
        ]
        for pid, mapping, day, resolved, raw_code, raw_name, total, unscanned in facts:
            connection.execute(text("INSERT INTO fact_pdd_collection_failure_v2 VALUES ('pdd_collection_failure',:pid,:map,:day,:resolved,:raw_code,:raw_name,:total,:unscanned)"), {
                "pid": pid.bytes, "map": mapping.bytes, "day": day, "resolved": resolved,
                "raw_code": raw_code, "raw_name": raw_name, "total": total, "unscanned": unscanned,
            })

    generate_publication_analysis(engine, publication_id=str(publication_id))
    generate_publication_analysis(engine, publication_id=str(publication_id))
    rows = get_analysis_history(engine)["analyses"]
    assert len(rows) == 1
    row = rows[0]
    assert row["state"] == "READY" and row["operationalDate"] == latest_day.isoformat()
    assert row["publicationId"] == str(publication_id) and row["mapVersionId"] == str(pinned_map)
    assert row["totalOrders"] == 350 and row["ordersUnscannedAtCollection"] == 75
    assert row["failureRate"] == 75 / 350
    assert row["results"]["unmapped"] == {"totalOrders": 50, "ordersUnscannedAtCollection": 15}
    assert "Base oficial — 20,0%" in row["message"] and "RM Oficial" in row["message"]


def test_same_day_publications_have_independent_analyses_and_map_owners():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine)
    day = date(2026, 10, 28)
    items = [(uuid.uuid4(), uuid.uuid4(), 10, "RM v10"), (uuid.uuid4(), uuid.uuid4(), 11, "RM v11")]
    with engine.begin() as connection:
        for publication_id, map_id, version, owner in items:
            _published(connection, publication_id, map_id, version)
            connection.execute(text("INSERT INTO source_publication_dates VALUES ('pdd_collection_failure',:pid,:day,1)"), {"pid": publication_id.bytes, "day": day})
            connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map,'BASE',:name,'SPE',:owner)"), {"map": map_id.bytes, "name": "Base " + str(version), "owner": owner})
            connection.execute(text("INSERT INTO fact_pdd_collection_failure_v2 VALUES ('pdd_collection_failure',:pid,:map,:day,'BASE','BASE','JMS',100,10)"), {"pid": publication_id.bytes, "map": map_id.bytes, "day": day})
    for publication_id, _, _, _ in items:
        generate_publication_analysis(engine, publication_id=str(publication_id))
    rows = get_analysis_history(engine)["analyses"]
    assert len(rows) == 2 and {row["publicationId"] for row in rows} == {str(item[0]) for item in items}
    assert any("RM v10" in row["message"] for row in rows)
    assert any("RM v11" in row["message"] for row in rows)


def test_aborted_wrong_contract_and_generation_failure_do_not_return_ready_results():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine, include_fact=False)
    aborted, wrong, valid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    map_id = uuid.uuid4()
    with engine.begin() as connection:
        _published(connection, aborted, map_id, 1, state="ABORTED")
        _published(connection, wrong, map_id, 2, contract=1)
        _published(connection, valid, map_id, 3)
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('pdd_collection_failure',:pid,:day,1)"), {"pid": valid.bytes, "day": date(2026, 10, 27)})
    for publication_id in (aborted, wrong, valid):
        generate_publication_analysis(engine, publication_id=str(publication_id))
    rows = get_analysis_history(engine)["analyses"]
    assert len(rows) == 1 and rows[0]["state"] == "FAILED"


def test_history_endpoint_requires_matrix_scope_and_role(monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.api import data_foundation
    from app.api.dependencies import AuthenticatedViewer

    monkeypatch.setattr(data_foundation, "_require_feature", lambda: None)
    monkeypatch.setattr(data_foundation, "get_pdd_collection_failure_analysis_history", lambda _engine, *, limit: {"analyses": [], "limit": limit})
    monkeypatch.setattr(data_foundation, "_engine", lambda: object())
    for identity in (
        {"organizational_scope": "regional", "role": "regional"},
        {"organizational_scope": "matrix", "role": "admin"},
    ):
        viewer = AuthenticatedViewer(user=SimpleNamespace(), identity=identity)
        try:
            data_foundation.pdd_collection_failure_operational_analysis(limit=20, viewer=viewer)
        except HTTPException as error:
            assert error.status_code == 403
        else:
            raise AssertionError("national PDD analysis must be restricted to MATRIZ role and scope")
    matrix = AuthenticatedViewer(user=SimpleNamespace(), identity={"organizational_scope": "matrix", "role": "matrix"})
    assert data_foundation.pdd_collection_failure_operational_analysis(limit=7, viewer=matrix) == {"analyses": [], "limit": 7}
