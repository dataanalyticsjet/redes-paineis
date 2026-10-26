from datetime import date, datetime
import uuid

from decimal import Decimal

from sqlalchemy import create_engine, text
from fastapi import HTTPException
from types import SimpleNamespace

from app.services.collection_rate_operational_analysis import (
    TARGET_RATE,
    build_bilingual_analysis,
    generate_publication_analysis,
    get_analysis_history,
)


def test_rate_analysis_uses_weighted_official_fields_and_deterministic_impact_ranking():
    message, result = build_bilingual_analysis(
        operational_date=date(2026, 10, 26),
        publication_version=7,
        collected=8_400,
        planned=10_000,
        unmapped_planned=500,
        generated_at=datetime(2026, 10, 26, 11, 59),
        region_limit=1,
        base_limit=2,
        bases=[
            {"code": "001", "name": "A", "region": "SPE", "collected": 8_200, "planned": 10_000, "responsible": None},
            {"code": "002", "name": "B", "region": "SPE", "collected": 7_700, "planned": 8_000, "responsible": "RM B"},
            {"code": "003", "name": "C", "region": "SPS", "collected": 9_900, "planned": 10_000, "responsible": "RM C"},
        ],
    )

    assert TARGET_RATE == Decimal("0.98")
    assert "Bom dia, pessoal!" in message
    assert "大家早上好！" in message
    assert "Geral: **84,0%**" in message
    assert "Meta: **98,0%**" in message
    assert "SPE — 88,3%" in message
    assert "B — **96,3%** | 8.000 pacotes | RM: RM B" in message
    assert "A — **82,0%** | 10.000 pacotes | RM: Sem responsável identificado" in message
    assert "Volume sem regional/base DoomsDay vinculada mantido no consolidado nacional: 500" in message
    assert result["metric"] == {
        "numeratorField": "collected_quantity",
        "denominatorField": "quantity_to_collect",
        "volumeField": "quantity_to_collect",
        "collected": 8_400,
        "planned": 10_000,
        "rate": "0.84",
    }
    assert result["estimatedTargetGapIsObservedBacklog"] is False
    assert [base["baseCode"] for base in result["regions"][0]["bases"]] == ["001", "002"]


def test_rate_analysis_uses_sao_paulo_afternoon_greeting_and_handles_no_critical_regions():
    message, result = build_bilingual_analysis(
        operational_date=date(2026, 10, 27),
        publication_version=8,
        collected=99,
        planned=100,
        bases=[{"code": "B1", "name": "Base", "region": "CE", "collected": 99, "planned": 100}],
        generated_at=datetime(2026, 10, 27, 12, 0),
    )

    assert "Boa tarde, pessoal!" in message
    assert "大家下午好！" in message
    assert "Nenhuma regional mapeada está abaixo da meta" in message
    assert "没有已映射区域低于目标" in message
    assert result["regions"] == []


def test_critical_selection_is_limited_to_five_regions_and_two_highest_impact_bases_each():
    bases = []
    for region_number in range(6):
        region = f"R{region_number}"
        for base_number in range(3):
            planned = 1_000 + base_number * 100
            collected = 700 - region_number * 10 - base_number * 20
            bases.append({
                "code": f"{region_number}-{base_number}", "name": f"Base {base_number}",
                "region": region, "collected": collected, "planned": planned,
            })
    _, result = build_bilingual_analysis(
        operational_date=date(2026, 10, 28), publication_version=9,
        collected=0, planned=1, bases=bases,
        generated_at=datetime(2026, 10, 28, 13, 0),
    )
    assert len(result["regions"]) == 5
    assert all(len(region["bases"]) == 2 for region in result["regions"])
    assert all(Decimal(region["rate"]) < TARGET_RATE for region in result["regions"])


def _schema(engine, *, include_fact=True):
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB, source_id TEXT, version_no INTEGER, contract_version INTEGER, map_version_id BLOB, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publication_dates (source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER)")
        if include_fact:
            connection.exec_driver_sql("CREATE TABLE fact_collection_rate_v3 (source_id TEXT, publication_id BLOB, map_version_id BLOB, deadline_at DATETIME, resolved_base_code TEXT, mapping_resolution TEXT, collected_quantity INTEGER, quantity_to_collect INTEGER, order_quantity INTEGER)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, base_name TEXT, regional_name TEXT, rm_responsible TEXT, PRIMARY KEY (map_version_id, base_code))")
        connection.exec_driver_sql("""CREATE TABLE collection_rate_operational_analyses (
            analysis_id BLOB PRIMARY KEY, source_id TEXT, publication_id BLOB, publication_version INTEGER,
            contract_version INTEGER, map_version_id BLOB, operational_date DATE, analysis_state TEXT,
            national_collected_quantity INTEGER, national_quantity_to_collect INTEGER, national_rate NUMERIC,
            target_rate NUMERIC, results_json TEXT, message_pt_zh TEXT, rules_version TEXT, error_code TEXT,
            generated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (publication_id, rules_version))""")


def _publication(connection, *, publication_id, map_id, version, state="PUBLISHED"):
    connection.execute(text("""
        INSERT INTO source_publications VALUES (:publication_id, 'collection_rate', :version, 3, :map_id, :state)
    """), {"publication_id": publication_id.bytes, "version": version, "map_id": map_id.bytes, "state": state})


def test_generation_selects_latest_positive_operational_date_and_pinned_publication_map_idempotently():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine)
    publication_id, another_publication_id, aborted_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    map_id, another_map_id = uuid.uuid4(), uuid.uuid4()
    d10, d11, d12 = date(2026, 10, 25), date(2026, 10, 26), date(2026, 10, 27)
    with engine.begin() as connection:
        _publication(connection, publication_id=publication_id, map_id=map_id, version=7)
        _publication(connection, publication_id=another_publication_id, map_id=another_map_id, version=8)
        _publication(connection, publication_id=aborted_id, map_id=uuid.uuid4(), version=9, state="ABORTED")
        for data_date, row_count in ((d10, 4), (d11, 3), (d12, 0)):
            connection.execute(text("INSERT INTO source_publication_dates VALUES ('collection_rate', :pid, :data_date, :count)"), {
                "pid": publication_id.bytes, "data_date": data_date, "count": row_count,
            })
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('collection_rate', :pid, :day, 10)"), {"pid": another_publication_id.bytes, "day": d11})
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('collection_rate', :pid, :day, 10)"), {"pid": aborted_id.bytes, "day": d12})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map, '001', 'Base 1', 'SPE', 'Responsável oficial')"), {"map": map_id.bytes})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map, '002', 'Base 2', 'SPE', NULL)"), {"map": map_id.bytes})
        facts = [
            # Older day must not enter the operational-date analysis.
            (publication_id, map_id, d10, "001", "NAME_APPROVED", 10_000, 10_000, 10_000),
            # Duplicate rows for the same base aggregate before the mapping join.
            (publication_id, map_id, d11, "001", "NAME_APPROVED", 90, 100, 100),
            (publication_id, map_id, d11, "001", "NAME_APPROVED", 98, 100, 100),
            (publication_id, map_id, d11, "002", "NAME_APPROVED", 97, 100, 100),
            # Unmapped source volume remains in national totals.
            (publication_id, map_id, d11, None, "UNMAPPED", 10, 50, 50),
            # Facts from a different publication must never be mixed in.
            (another_publication_id, another_map_id, d11, None, "UNMAPPED", 0, 100_000, 100_000),
            (aborted_id, uuid.uuid4(), d12, None, "UNMAPPED", 0, 500_000, 500_000),
        ]
        for pid, mapping, day, code, resolution, collected, planned, orders in facts:
            connection.execute(text("""
                INSERT INTO fact_collection_rate_v3 VALUES ('collection_rate', :pid, :map, :deadline,
                    :code, :resolution, :collected, :planned, :orders)
            """), {"pid": pid.bytes, "map": mapping.bytes, "deadline": datetime.combine(day, datetime.min.time()),
                  "code": code, "resolution": resolution, "collected": collected, "planned": planned, "orders": orders})

    generate_publication_analysis(engine, publication_id=str(publication_id))
    generate_publication_analysis(engine, publication_id=str(publication_id))
    history = get_analysis_history(engine)
    assert len(history["analyses"]) == 1
    analysis = history["analyses"][0]
    assert analysis["state"] == "READY"
    assert analysis["publicationId"] == str(publication_id)
    assert analysis["publicationVersion"] == 7
    assert analysis["mapVersionId"] == str(map_id)
    assert analysis["operationalDate"] == d11.isoformat()
    assert analysis["planned"] == 350
    assert analysis["collected"] == 295
    assert analysis["rate"] == 295 / 350
    assert analysis["results"]["unmappedPlanned"] == 50
    assert "SPE — 95,0%" in analysis["message"]
    assert "Base 1 — **94,0%** | 200 pacotes | RM: Responsável oficial" in analysis["message"]
    assert "Base 2 — **97,0%** | 100 pacotes | RM: Sem responsável identificado" in analysis["message"]
    assert "Volume sem regional/base DoomsDay vinculada mantido no consolidado nacional: 50" in analysis["message"]


def test_aborted_or_wrong_contract_publications_are_not_analyzed():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine)
    with engine.begin() as connection:
        aborted_id, wrong_contract_id, map_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        _publication(connection, publication_id=aborted_id, map_id=map_id, version=2, state="ABORTED")
        connection.execute(text("INSERT INTO source_publications VALUES (:pid, 'collection_rate', 3, 2, :map, 'PUBLISHED')"), {
            "pid": wrong_contract_id.bytes, "map": map_id.bytes,
        })

    generate_publication_analysis(engine, publication_id=str(aborted_id))
    generate_publication_analysis(engine, publication_id=str(wrong_contract_id))
    assert get_analysis_history(engine)["analyses"] == []


def test_two_publications_on_the_same_operational_day_keep_separate_analyses_and_maps():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine)
    day = date(2026, 10, 29)
    publications = [(uuid.uuid4(), uuid.uuid4(), 10, 90), (uuid.uuid4(), uuid.uuid4(), 11, 50)]
    with engine.begin() as connection:
        for publication_id, map_id, version, collected in publications:
            _publication(connection, publication_id=publication_id, map_id=map_id, version=version)
            connection.execute(text("INSERT INTO source_publication_dates VALUES ('collection_rate', :pid, :day, 1)"), {
                "pid": publication_id.bytes, "day": day,
            })
            connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map, 'BASE', :name, 'SPE', 'RGM')"), {
                "map": map_id.bytes, "name": f"Base da v{version}",
            })
            connection.execute(text("""
                INSERT INTO fact_collection_rate_v3 VALUES ('collection_rate', :pid, :map, :deadline,
                    'BASE', 'NAME_APPROVED', :collected, 100, 100)
            """), {"pid": publication_id.bytes, "map": map_id.bytes,
                  "deadline": datetime.combine(day, datetime.min.time()), "collected": collected})

    for publication_id, _, _, _ in publications:
        generate_publication_analysis(engine, publication_id=str(publication_id))
    history = get_analysis_history(engine)
    assert len(history["analyses"]) == 2
    by_publication = {row["publicationId"]: row for row in history["analyses"]}
    for publication_id, map_id, version, collected in publications:
        row = by_publication[str(publication_id)]
        assert row["publicationVersion"] == version
        assert row["mapVersionId"] == str(map_id)
        assert row["operationalDate"] == day.isoformat()
        assert row["collected"] == collected
        assert f"Base da v{version}" in row["message"]


def test_generation_failure_is_audited_and_does_not_change_published_state():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _schema(engine, include_fact=False)
    publication_id, map_id = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as connection:
        _publication(connection, publication_id=publication_id, map_id=map_id, version=3)
        connection.execute(text("INSERT INTO source_publication_dates VALUES ('collection_rate', :pid, :day, 1)"), {
            "pid": publication_id.bytes, "day": date(2026, 10, 26),
        })

    generate_publication_analysis(engine, publication_id=str(publication_id))
    analysis = get_analysis_history(engine)["analyses"][0]
    with engine.connect() as connection:
        state = connection.execute(text("SELECT publication_state FROM source_publications WHERE publication_id=:pid"), {"pid": publication_id.bytes}).scalar_one()
    assert state == "PUBLISHED"
    assert analysis["state"] == "FAILED"
    assert analysis["errorCode"]


def test_analysis_history_requires_effective_matrix_scope(monkeypatch):
    from app.api import data_foundation
    from app.api.dependencies import AuthenticatedViewer

    monkeypatch.setattr(data_foundation, "_require_feature", lambda: None)
    monkeypatch.setattr(data_foundation, "get_collection_rate_analysis_history", lambda _engine, *, limit: {"analyses": [], "limit": limit})
    monkeypatch.setattr(data_foundation, "_engine", lambda: object())

    regional = AuthenticatedViewer(
        user=SimpleNamespace(),
        identity={"organizational_scope": "regional", "role": "regional"},
    )
    try:
        data_foundation.collection_rate_operational_analysis(limit=20, viewer=regional)
    except HTTPException as error:
        assert error.status_code == 403
        assert error.detail == "matrix_scope_required"
    else:
        raise AssertionError("regional viewers must not receive the national analysis")

    matrix = AuthenticatedViewer(
        user=SimpleNamespace(),
        identity={"organizational_scope": "matrix", "role": "matrix"},
    )
    assert data_foundation.collection_rate_operational_analysis(limit=7, viewer=matrix) == {"analyses": [], "limit": 7}
