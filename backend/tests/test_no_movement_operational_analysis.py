from datetime import date, datetime
import uuid

from sqlalchemy import create_engine, text

from app.services.no_movement_operational_analysis import (
    build_bilingual_analysis,
    generate_publication_analysis,
    get_analysis_history,
)


def test_bilingual_analysis_ranks_positive_regions_and_bases_and_keeps_unmapped_total():
    message = build_bilingual_analysis(
        operational_date=date(2026, 10, 26),
        export_time=datetime(2026, 10, 26, 9, 15),
        publication_version=12,
        total=170,
        generated_at=datetime(2026, 10, 26, 11, 0),
        region_limit=1,
        base_limit=1,
        groups=[
            {"mapped": True, "region": "SPE", "base_name": "Base A", "rm_responsible": "RGM 1", "total": 100},
            {"mapped": True, "region": "SPE", "base_name": "Base B", "rm_responsible": None, "total": 50},
            {"mapped": True, "region": "SPS", "base_name": "Base C", "rm_responsible": "RGM 2", "total": 0},
            {"mapped": False, "region": "Sem mapeamento", "base_name": "Unidade X", "total": 20},
        ],
    )
    assert "Bom dia, equipe!" in message
    assert "大家早上好！" in message
    assert "26/10/2026" in message and "09:15" in message
    assert "Volume nacional: 170 pacotes" in message
    assert "SPE — 150 pacotes" in message
    assert "Base A — **100 pacotes**" in message
    assert "Base B" not in message
    assert "Unidade X — **20 pacotes**" in message
    assert "Sem responsável identificado" not in message  # only top base is rendered


def _analysis_schema(engine):
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB, source_id TEXT, version_no INTEGER, contract_version INTEGER, map_version_id BLOB, period_start DATE, snapshot_as_of DATETIME, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE fact_no_movement_snapshot (source_id TEXT, publication_id BLOB, map_version_id BLOB, resolved_base_code TEXT, reported_region TEXT, source_base_code TEXT, source_base_name TEXT, stopped_orders INTEGER)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT, rm_responsible TEXT)")
        connection.exec_driver_sql("""CREATE TABLE no_movement_operational_analyses (
            analysis_id BLOB, source_id TEXT, publication_id BLOB, publication_version INTEGER,
            contract_version INTEGER, map_version_id BLOB, operational_date DATE,
            export_time_local DATETIME, export_time_zone TEXT, export_time_source TEXT, confirmation_user_id INTEGER,
            confirmed_at DATETIME, analysis_state TEXT, rules_version TEXT,
            total_stopped_orders INTEGER, message_pt_zh TEXT, error_code TEXT,
            generated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)""")


def test_generation_uses_published_publication_and_pinned_map_and_is_idempotent():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _analysis_schema(engine)
    publication_id = uuid.uuid4()
    map_id = uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO source_publications VALUES (:pid,'no_movement',4,2,:map,:day,:export,'PUBLISHED')"), {
            "pid": publication_id.bytes, "map": map_id.bytes, "day": date(2026, 10, 26),
            "export": datetime(2026, 10, 26, 9, 15),
        })
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:map,'B-1','SPE','Base oficial','Responsável RM')"), {"map": map_id.bytes})
        connection.execute(text("INSERT INTO fact_no_movement_snapshot VALUES ('no_movement',:pid,:map,'B-1','Outra regional','B-1','Nome JMS',100)"), {"pid": publication_id.bytes, "map": map_id.bytes})
        connection.execute(text("INSERT INTO fact_no_movement_snapshot VALUES ('no_movement',:pid,:map,NULL,'SPE','X-1','Sem mapa',25)"), {"pid": publication_id.bytes, "map": map_id.bytes})

    generate_publication_analysis(engine, publication_id=str(publication_id))
    generate_publication_analysis(engine, publication_id=str(publication_id))
    history = get_analysis_history(engine)
    assert len(history["analyses"]) == 1
    analysis = history["analyses"][0]
    assert analysis["state"] == "READY"
    assert analysis["total"] == 125
    assert analysis["mapVersionId"] == str(map_id)
    assert "SPE — 100 pacotes" in analysis["message"]
    assert "Sem mapa (X-1) — **25 pacotes**" in analysis["message"]
    assert "Responsável RM: Responsável RM" in analysis["message"]


def test_aborted_publication_does_not_generate_analysis():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    _analysis_schema(engine)
    publication_id = uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO source_publications VALUES (:pid,'no_movement',5,2,:map,:day,:export,'ABORTED')"), {
            "pid": publication_id.bytes, "map": uuid.uuid4().bytes, "day": date(2026, 10, 26),
            "export": datetime(2026, 10, 26, 15),
        })
    generate_publication_analysis(engine, publication_id=str(publication_id))
    assert get_analysis_history(engine)["analyses"] == []
