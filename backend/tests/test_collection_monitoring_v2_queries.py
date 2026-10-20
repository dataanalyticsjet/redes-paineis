from __future__ import annotations

from datetime import date
import re
import uuid

from sqlalchemy import create_engine, event, text

from app.services.data_foundation.contracts import CONTRACT_VERSIONS
from app.services.data_foundation.queries import _query_plan, get_date_counts, get_records
from app.services.data_foundation.repository import fact_table_for_contract


MAPPING_ID = b"m" * 16
ADMIN_MATRIX = {
    "platform_role": "ADMIN",
    "organizational_scope": "matrix",
    "role": "matrix",
}
ADMIN_REGIONAL = {
    "platform_role": "ADMIN",
    "organizational_scope": "regional",
    "role": "regional",
    "effective_regions": ["SPE"],
}


def _sqlite_type(kind: str) -> str:
    return {
        "DATE": "DATE",
        "DATETIME": "DATETIME",
        "BASE_CODE": "TEXT",
        "TEXT": "TEXT",
        "INTEGER": "INTEGER",
        "DECIMAL": "NUMERIC",
    }[kind]


def _create_engine():
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def register_query_functions(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "REGEXP_REPLACE",
            3,
            lambda value, pattern, replacement: re.sub(pattern, replacement, value) if value is not None else None,
        )

    contract = CONTRACT_VERSIONS[("collection_monitoring", 2)]
    table = fact_table_for_contract("collection_monitoring", 2)
    column_definitions = [
        "source_id TEXT NOT NULL",
        "publication_id BLOB NOT NULL",
        "map_version_id BLOB NOT NULL",
        "source_row_no INTEGER NOT NULL",
    ]
    for column in contract.columns:
        if column.key not in {"source_id", "publication_id", "map_version_id", "source_row_no"}:
            column_definitions.append(f"`{column.key}` {_sqlite_type(column.kind)}")
    column_definitions.extend([
        "resolved_base_code TEXT",
        "mapping_resolution TEXT NOT NULL",
        "PRIMARY KEY(publication_id, source_row_no)",
    ])

    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE base_mapping_versions (map_version_id BLOB PRIMARY KEY, version_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_current (current_key TEXT PRIMARY KEY, map_version_id BLOB)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT, uf_code TEXT, rm_region TEXT, rm_responsible TEXT, PRIMARY KEY(map_version_id, base_code))")
        connection.exec_driver_sql("CREATE TABLE base_mapping_name_decisions (map_version_id BLOB, source_id TEXT, source_base_name TEXT, resolution_state TEXT, target_base_code TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB PRIMARY KEY, source_id TEXT, contract_version INTEGER NOT NULL, version_no INTEGER, period_start DATE, period_end DATE, snapshot_as_of DATETIME, published_at DATETIME, row_count INTEGER NOT NULL, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publication_dates (source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER, PRIMARY KEY(source_id, publication_id, data_date))")
        connection.exec_driver_sql(f"CREATE TABLE `{table}` ({', '.join(column_definitions)})")
        connection.execute(text("INSERT INTO base_mapping_versions VALUES (:id, 'PUBLISHED')"), {"id": MAPPING_ID})
        connection.execute(text("INSERT INTO base_mapping_current VALUES ('OFFICIAL', :id)"), {"id": MAPPING_ID})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:id, 'MATCHED-001', 'SPE', 'Mapped base', 'SP', 'SPE', 'RM One')"), {"id": MAPPING_ID})

    return engine, contract, table


def _publication_id(day: int) -> bytes:
    return uuid.UUID(int=day).bytes


def _insert_day(engine, contract, table: str, *, day: int, rows: list[tuple[int, bool]]) -> None:
    publication_id = _publication_id(day)
    data_date = date(2026, 10, day)
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, contract_version, version_no, period_start, period_end,
               snapshot_as_of, published_at, row_count, publication_state)
            VALUES (:publication_id, 'collection_monitoring', 2, :version_no, :data_date, :data_date,
                    NULL, :published_at, :row_count, 'PUBLISHED')
        """), {
            "publication_id": publication_id,
            "version_no": day,
            "data_date": data_date,
            "published_at": f"2026-10-{day:02} 08:00:00",
            "row_count": len(rows),
        })
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES ('collection_monitoring', :publication_id, :data_date, :row_count)
        """), {"publication_id": publication_id, "data_date": data_date, "row_count": len(rows)})
        columns = [column.key for column in contract.columns]
        insert_columns = ["source_id", "publication_id", "map_version_id", "source_row_no", *columns, "resolved_base_code", "mapping_resolution"]
        bind_names = [f"v_{index}" for index in range(len(insert_columns))]
        statement = text(
            f"INSERT INTO `{table}` ({', '.join(f'`{name}`' for name in insert_columns)}) "
            f"VALUES ({', '.join(f':{name}' for name in bind_names)})"
        )
        for row_no, mapped in rows:
            values: dict[str, object] = {}
            for column in contract.columns:
                if column.key == "data_date":
                    value: object = data_date
                elif column.kind == "INTEGER":
                    value = row_no
                elif column.kind == "DECIMAL":
                    value = row_no / 100
                elif column.kind == "DATE":
                    value = data_date
                elif column.kind == "DATETIME":
                    value = None
                elif column.key == "source_base_name":
                    value = "Mapped base" if mapped else "Unmapped source name"
                elif column.key == "reported_origin_region":
                    value = "JMS region should not authorize"
                else:
                    value = f"{column.key}-{row_no}"
                values[column.key] = value
            values.update({
                "source_id": "collection_monitoring",
                "publication_id": publication_id,
                "map_version_id": MAPPING_ID,
                "source_row_no": row_no,
                "resolved_base_code": "MATCHED-001" if mapped else None,
                "mapping_resolution": "NAME_APPROVED" if mapped else "UNMAPPED",
            })
            connection.execute(statement, {name: values[column] for name, column in zip(bind_names, insert_columns)})


def _baseline_page(engine, identity, *, limit: int, offset: int):
    plan = _query_plan(
        "collection_monitoring", identity, date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
        base_code=None, region=None, publication_id=None, contract_version=2, sql_dialect="sqlite",
    )
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(text(f"""
            SELECT {plan.select_sql}
            {plan.from_sql}
            WHERE {plan.where_sql}
            ORDER BY fact.data_date DESC, fact.source_row_no ASC
            LIMIT :page_limit OFFSET :page_offset
        """), {**plan.parameters, "page_limit": limit, "page_offset": offset}).mappings()]


def test_matrix_monitoring_v2_pages_facts_before_doomsday_and_matches_legacy_rows():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=19, rows=[(1, True)])
    _insert_day(engine, contract, table, day=20, rows=[(1, True), (2, False), (3, True)])
    statements: list[str] = []
    event.listen(engine, "before_cursor_execute", lambda _conn, _cursor, statement, _params, _context, _many: statements.append(statement))

    result = get_records(
        engine,
        source_id="collection_monitoring",
        identity=ADMIN_MATRIX,
        limit=2,
        offset=1,
        date_from=date(2026, 10, 19),
        date_to=date(2026, 10, 20),
        contract_version=2,
    )

    baseline_first = _baseline_page(engine, ADMIN_MATRIX, limit=2, offset=0)
    baseline_second = _baseline_page(engine, ADMIN_MATRIX, limit=2, offset=2)
    actual_rows = result["records"]
    expected_rows = baseline_first + baseline_second
    assert result["total"] == 4
    assert [(row["publication_id"], row["source_row_no"]) for row in actual_rows] == [
        (str(uuid.UUID(bytes=bytes(row["publication_id"]))), row["source_row_no"])
        for row in expected_rows[1:3]
    ]
    assert [row["effective_base_code"] for row in actual_rows] == [row["effective_base_code"] for row in expected_rows[1:3]]
    assert actual_rows[0]["effective_base_code"] is None
    assert actual_rows[1]["effective_base_code"] == "MATCHED-001"
    optimized_detail = next(statement for statement in statements if "WITH page_facts AS" in statement)
    assert optimized_detail.index("LIMIT ? OFFSET ?") < optimized_detail.index("LEFT JOIN base_mapping_entries AS stored_entry")
    metadata_total_queries = [statement for statement in statements if "COALESCE(SUM(metadata.row_count), 0)" in statement]
    assert metadata_total_queries
    assert all("fact_collection_monitoring_v2" not in statement for statement in metadata_total_queries)


def test_matrix_monitoring_v2_dates_can_return_only_latest_published_day_from_metadata():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=19, rows=[(1, True)])
    _insert_day(engine, contract, table, day=20, rows=[(1, True), (2, False)])

    result = get_date_counts(
        engine,
        source_id="collection_monitoring",
        identity=ADMIN_MATRIX,
        contract_version=2,
        latest_only=True,
    )

    assert result["hasPublishedPublication"] is True
    assert len(result["dates"]) == 1
    assert str(result["dates"][0]["date"]) == "2026-10-20"
    assert result["dates"][0]["rowCount"] == 2


def test_admin_regional_monitoring_v2_latest_dates_remain_scoped_and_fact_derived():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=19, rows=[(1, True), (2, False)])
    _insert_day(engine, contract, table, day=20, rows=[(1, True), (2, False), (3, True)])
    statements: list[str] = []
    event.listen(engine, "before_cursor_execute", lambda _conn, _cursor, statement, _params, _context, _many: statements.append(statement))

    dates = get_date_counts(
        engine,
        source_id="collection_monitoring",
        identity=ADMIN_REGIONAL,
        contract_version=2,
        latest_only=True,
    )
    records = get_records(
        engine,
        source_id="collection_monitoring",
        identity=ADMIN_REGIONAL,
        limit=50,
        offset=0,
        date_from=date(2026, 10, 20),
        date_to=date(2026, 10, 20),
        contract_version=2,
    )

    assert len(dates["dates"]) == 1
    assert str(dates["dates"][0]["date"]) == "2026-10-20"
    assert dates["dates"][0]["rowCount"] == 2
    assert records["total"] == 2
    assert all(row["mapped_region"] == "SPE" for row in records["records"])
    assert not any("ranked_metadata_dates" in statement for statement in statements)


def test_matrix_unmapped_filter_and_base_scope_keep_their_existing_visibility_rules():
    engine, contract, table = _create_engine()
    _insert_day(engine, contract, table, day=20, rows=[(1, True), (2, False), (3, True)])

    unmapped = get_records(
        engine,
        source_id="collection_monitoring",
        identity=ADMIN_MATRIX,
        limit=50,
        offset=0,
        date_from=date(2026, 10, 20),
        date_to=date(2026, 10, 20),
        region="Sem regional",
        contract_version=2,
    )
    base = get_records(
        engine,
        source_id="collection_monitoring",
        identity={
            "platform_role": "USER",
            "organizational_scope": "base",
            "role": "regional",
            "home_base": "MATCHED-001",
            "home_region": "SPE",
        },
        limit=50,
        offset=0,
        date_from=date(2026, 10, 20),
        date_to=date(2026, 10, 20),
        contract_version=2,
    )

    assert unmapped["total"] == 1
    assert unmapped["records"][0]["effective_mapping_resolution"] == "UNMAPPED"
    assert base["total"] == 2
    assert all(row["effective_base_code"] == "MATCHED-001" for row in base["records"])
