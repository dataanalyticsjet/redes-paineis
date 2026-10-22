from __future__ import annotations

from datetime import date
from decimal import Decimal
import re
import uuid
import zipfile
from xml.etree import ElementTree

import pytest
from sqlalchemy import create_engine, event, text

from app.services.collection_monitoring_t4_t5 import (
    STATUS_COLUMNS,
    T4T5Filters,
    _get_dashboard_summary_with_row_mapping,
    create_xlsx_export,
    get_dashboard_summary,
    get_detail_page,
    get_filter_options,
    get_group_page,
)
from app.services.data_foundation.contracts import contract_sha256, get_contract
from app.services.data_foundation.queries import _query_plan
from app.services.data_foundation.repository import DataFoundationError, fact_table_for_contract
from app.services.data_foundation.xlsx_parser import (
    MAX_UNCOMPRESSED_WORKBOOK_BYTES,
    _RawCell,
    _cell_as_value,
    _max_uncompressed_workbook_bytes,
)


MAPPING_ID = b"t4t5-map-version"
MATRIX_USER = {"platform_role": "USER", "organizational_scope": "matrix", "role": "matrix"}
MATRIX_ADMIN = {"platform_role": "ADMIN", "organizational_scope": "matrix", "role": "matrix"}
REGIONAL_ADMIN = {
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


def _create_database():
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def register_sql_functions(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "REGEXP_REPLACE",
            3,
            lambda value, pattern, replacement: re.sub(pattern, replacement, value) if value is not None else None,
        )

    contract = get_contract("collection_monitoring_t4_t5", 1)
    table = fact_table_for_contract(contract.source_id, contract.version)
    fact_columns = [
        "source_id TEXT NOT NULL",
        "publication_id BLOB NOT NULL",
        "map_version_id BLOB NOT NULL",
        "source_row_no INTEGER NOT NULL",
        *[
            f"`{column.key}` {_sqlite_type(column.kind)}"
            for column in contract.columns
        ],
        "resolved_base_code TEXT",
        "mapping_resolution TEXT NOT NULL",
        "PRIMARY KEY(publication_id, source_row_no)",
    ]
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE base_mapping_versions (map_version_id BLOB PRIMARY KEY, version_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_current (current_key TEXT PRIMARY KEY, map_version_id BLOB)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT, uf_code TEXT, rm_region TEXT, rm_responsible TEXT, PRIMARY KEY(map_version_id, base_code))")
        connection.exec_driver_sql("CREATE TABLE base_mapping_name_decisions (map_version_id BLOB, source_id TEXT, source_base_name TEXT, resolution_state TEXT, target_base_code TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB PRIMARY KEY, source_id TEXT, contract_version INTEGER, version_no INTEGER, map_version_id BLOB, period_start DATE, period_end DATE, snapshot_as_of TEXT, published_at TEXT, row_count INTEGER, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publication_dates (source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER, PRIMARY KEY(source_id, publication_id, data_date))")
        connection.exec_driver_sql("CREATE TABLE source_daily_head (source_id TEXT, data_date DATE, publication_id BLOB, PRIMARY KEY(source_id, data_date))")
        connection.exec_driver_sql(f"CREATE TABLE `{table}` ({', '.join(fact_columns)})")
        connection.execute(text("INSERT INTO base_mapping_versions VALUES (:map_id, 'PUBLISHED')"), {"map_id": MAPPING_ID})
        connection.execute(text("INSERT INTO base_mapping_current VALUES ('OFFICIAL', :map_id)"), {"map_id": MAPPING_ID})
        connection.execute(text("""
            INSERT INTO base_mapping_entries
              (map_version_id, base_code, regional_name, base_name, uf_code, rm_region, rm_responsible)
            VALUES
              (:map_id, 'BASE-SPE', 'SPE', 'PDD SPE', 'SP', 'SPE-BRAS', 'RM Sul'),
              (:map_id, 'BASE-CE', 'CE', 'PDD CE', 'CE', 'CE-FORT', 'RM Ceará')
        """), {"map_id": MAPPING_ID})
    return engine, contract, table


def _insert_publication(engine, contract, table: str, *, day: int, rows: list[dict[str, object]]) -> None:
    snapshot_date = date(2026, 10, day)
    publication_id = uuid.UUID(int=day).bytes
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, contract_version, version_no, map_version_id,
               period_start, period_end, snapshot_as_of, published_at, row_count, publication_state)
            VALUES (:publication_id, :source_id, 1, :version_no, :map_id,
                    :snapshot_date, :snapshot_date, :snapshot_as_of, :published_at, :row_count, 'PUBLISHED')
        """), {
            "publication_id": publication_id,
            "source_id": contract.source_id,
            "version_no": day,
            "map_id": MAPPING_ID,
            "snapshot_date": snapshot_date,
            "snapshot_as_of": f"2026-10-{day:02} 10:00:00",
            "published_at": f"2026-10-{day:02} 10:05:00",
            "row_count": len(rows),
        })
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES (:source_id, :publication_id, :snapshot_date, :row_count)
        """), {
            "source_id": contract.source_id,
            "publication_id": publication_id,
            "snapshot_date": snapshot_date,
            "row_count": len(rows),
        })
        connection.execute(text("""
            INSERT INTO source_daily_head (source_id, data_date, publication_id)
            VALUES (:source_id, :snapshot_date, :publication_id)
        """), {
            "source_id": contract.source_id,
            "snapshot_date": snapshot_date,
            "publication_id": publication_id,
        })
        insert_columns = [
            "source_id", "publication_id", "map_version_id", "source_row_no",
            *[column.key for column in contract.columns], "resolved_base_code", "mapping_resolution",
        ]
        bind_names = [f"v_{index}" for index in range(len(insert_columns))]
        statement = text(
            f"INSERT INTO `{table}` ({', '.join(f'`{column}`' for column in insert_columns)}) "
            f"VALUES ({', '.join(f':{name}' for name in bind_names)})"
        )
        for row_no, row in enumerate(rows, 1):
            values: dict[str, object] = {
                column.key: 0 if column.kind == "INTEGER" else None
                for column in contract.columns
            }
            values.update(row)
            values["data_date"] = snapshot_date
            source_name = values.get("source_base_name")
            mapping_code = {"PDD SPE": "BASE-SPE", "PDD CE": "BASE-CE"}.get(source_name)
            values.update({
                "source_id": contract.source_id,
                "publication_id": publication_id,
                "map_version_id": MAPPING_ID,
                "source_row_no": row_no,
                "resolved_base_code": mapping_code,
                "mapping_resolution": "NAME_APPROVED" if mapping_code else "UNMAPPED",
            })
            connection.execute(statement, {name: values[column] for name, column in zip(bind_names, insert_columns)})


def _fixture_data():
    engine, contract, table = _create_database()
    _insert_publication(engine, contract, table, day=19, rows=[{
        "source_base_name": "PDD SPE", "customer_name": "Cliente A", "store_name": "Loja 1",
        "seller_id": "000123", "assigned_driver": "Motorista 1", "order_origin": "App",
        **dict(zip(STATUS_COLUMNS, [1, 2, 3, 4, 5, 6, 7])),
    }])
    _insert_publication(engine, contract, table, day=20, rows=[
        {
            "source_base_name": "PDD SPE", "customer_name": "Cliente A", "store_name": "Loja 1",
            "seller_id": "000123", "assigned_driver": "Motorista 1", "order_origin": "App",
            **dict(zip(STATUS_COLUMNS, [10, 20, 30, 40, 50, 60, 70])),
        },
        {
            "source_base_name": "PDD CE", "customer_name": "Cliente B", "store_name": "Loja 2",
            "seller_id": "000456", "assigned_driver": "Motorista 2", "order_origin": "Web",
            **dict(zip(STATUS_COLUMNS, [2, 4, 6, 8, 10, 12, 14])),
        },
        {
            # The JMS-reported region cannot grant scope when DoomsDay has no match.
            "reported_origin_region": "SPE", "source_base_name": "Unknown PDD",
            "customer_name": "Cliente C", "store_name": "Loja 3", "seller_id": "000789",
            "assigned_driver": "Motorista 3", "order_origin": "App",
            **dict(zip(STATUS_COLUMNS, [3, 6, 9, 12, 15, 18, 21])),
        },
    ])
    return engine


def _insert_aborted_snapshot_with_stale_head(engine, contract, table: str) -> None:
    snapshot_date = date(2026, 10, 18)
    publication_id = uuid.UUID(int=18).bytes
    values: dict[str, object] = {
        column.key: 0 if column.kind == "INTEGER" else None
        for column in contract.columns
    }
    values.update({
        "data_date": snapshot_date,
        "source_base_name": "PDD ABORTED",
        "customer_name": "Registro abortado",
        "store_name": "Loja antiga",
        "seller_id": "ABORTED-1",
        "order_origin": "App",
        "awaiting_collection": 99,
    })
    columns = [
        "source_id", "publication_id", "map_version_id", "source_row_no",
        *[column.key for column in contract.columns], "resolved_base_code", "mapping_resolution",
    ]
    bind_names = [f"v_{index}" for index in range(len(columns))]
    insert_fact = text(
        f"INSERT INTO `{table}` ({', '.join(f'`{column}`' for column in columns)}) "
        f"VALUES ({', '.join(f':{name}' for name in bind_names)})"
    )
    values.update({
        "source_id": contract.source_id,
        "publication_id": publication_id,
        "map_version_id": MAPPING_ID,
        "source_row_no": 1,
        "resolved_base_code": None,
        "mapping_resolution": "UNMAPPED",
    })
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, contract_version, version_no, map_version_id,
               period_start, period_end, snapshot_as_of, published_at, row_count, publication_state)
            VALUES (:publication_id, :source_id, 1, 18, :map_id,
                    :snapshot_date, :snapshot_date, :snapshot_as_of, :published_at, 1, 'ABORTED')
        """), {
            "publication_id": publication_id,
            "source_id": contract.source_id,
            "map_id": MAPPING_ID,
            "snapshot_date": snapshot_date,
            "snapshot_as_of": "2026-10-18 10:00:00",
            "published_at": "2026-10-18 10:05:00",
        })
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES (:source_id, :publication_id, :snapshot_date, 1)
        """), {
            "source_id": contract.source_id,
            "publication_id": publication_id,
            "snapshot_date": snapshot_date,
        })
        # Model a stale head as well as the real orphaned facts. The published
        # publication-state join must still exclude this aborted snapshot.
        connection.execute(text("""
            INSERT INTO source_daily_head (source_id, data_date, publication_id)
            VALUES (:source_id, :snapshot_date, :publication_id)
        """), {
            "source_id": contract.source_id,
            "publication_id": publication_id,
            "snapshot_date": snapshot_date,
        })
        connection.execute(insert_fact, {name: values[column] for name, column in zip(bind_names, columns)})


def test_contract_is_versioned_and_keeps_the_fifteen_source_columns():
    contract = get_contract("collection_monitoring_t4_t5", 1)
    assert len(contract.columns) == 15
    assert contract.headers == (
        "Data", "Regional Origem", "PDD de saida", "Cliente", "Loja",
        "Id Seller/remetente", "Motorista Designado", "Origem do Pedido",
        "Status atual – Aguardando coleta", "Status atual – Recebido no Drop-off",
        "Status atual – Coletado", "Status atual – Recebido",
        "Status atual – Recebido na base", "当前状态-网点发件流程中", "Status atual – Chegou ao SC",
    )
    assert contract_sha256(contract).hex() == "3d6f804ccad783b2d4cc33870a26f9d11f891430ff30505861251fd17d1d4a62"
    assert contract.history_policy == "DAILY_REPLACE_DATES"
    assert contract.expected_sample_rows is None
    assert _max_uncompressed_workbook_bytes(contract) > MAX_UNCOMPRESSED_WORKBOOK_BYTES
    assert _max_uncompressed_workbook_bytes(get_contract("collection_monitoring", 1)) == MAX_UNCOMPRESSED_WORKBOOK_BYTES


def test_numeric_excel_store_and_seller_cells_preserve_text_precision():
    contract = get_contract("collection_monitoring_t4_t5", 1)
    store = next(column for column in contract.columns if column.key == "store_name")
    seller = next(column for column in contract.columns if column.key == "seller_id")
    customer = next(column for column in contract.columns if column.key == "customer_name")

    assert _cell_as_value(_RawCell(Decimal("123456"), numeric=True), store, False, allow_numeric_text=True) == ("123456", None)
    assert _cell_as_value(_RawCell(Decimal("123456"), numeric=True), seller, False, allow_numeric_text=True) == ("123456", None)
    assert _cell_as_value(_RawCell("000123"), seller, False) == ("000123", None)
    assert _cell_as_value(_RawCell(Decimal("123456"), numeric=True), customer, False) == (None, "text_type_invalid")
    assert _cell_as_value(_RawCell(Decimal("1234567890123456"), numeric=True), seller, False, allow_numeric_text=True) == (
        None, "text_numeric_precision_exceeded",
    )


def test_summary_filters_grouping_and_snapshot_selection_preserve_rows_and_status_sums():
    engine = _fixture_data()
    matrix = get_dashboard_summary(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert str(matrix["snapshotDate"]) == "2026-10-20"
    assert matrix["metadata"]["publishedRowCount"] == 3
    assert matrix["totals"]["records"] == 3
    assert matrix["totals"]["unmappedRecords"] == 1
    assert matrix["totals"]["statuses"] == dict(zip(STATUS_COLUMNS, [15, 30, 45, 60, 75, 90, 105]))
    assert matrix == _get_dashboard_summary_with_row_mapping(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )

    filtered = get_dashboard_summary(
        engine, identity=MATRIX_USER, filters=T4T5Filters(region="SPE", customer_name="Cliente A"),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert filtered["totals"]["records"] == 1
    assert filtered["totals"]["statuses"] == dict(zip(STATUS_COLUMNS, [10, 20, 30, 40, 50, 60, 70]))

    regional = get_dashboard_summary(
        engine, identity=REGIONAL_ADMIN, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert regional["totals"]["records"] == 1
    assert regional["totals"]["unmappedRecords"] == 0

    matrix_options = get_filter_options(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    regional_options = get_filter_options(
        engine, identity=REGIONAL_ADMIN, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    base_options = get_filter_options(
        engine,
        identity={
            "platform_role": "USER", "organizational_scope": "base", "role": "regional",
            "home_base": "BASE-SPE", "home_region": "SPE",
        },
        filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert matrix_options["regions"] == ["CE", "SPE", "Sem regional"]
    assert regional_options["regions"] == ["SPE"]
    assert regional_options["pdds"] == ["PDD SPE"]
    assert base_options["pdds"] == ["PDD SPE"]

    regional_groups = get_group_page(
        engine, identity=MATRIX_ADMIN, dimension="region", filters=T4T5Filters(),
        snapshot_date=date(2026, 10, 20), limit=20, offset=0,
    )
    by_region = {row["regional_name"]: row for row in regional_groups["rows"]}
    assert set(by_region) == {"SPE", "CE", "Sem regional"}
    assert by_region["SPE"]["record_count"] == 1
    assert by_region["Sem regional"]["record_count"] == 1

    with pytest.raises(DataFoundationError, match="user_scope_unavailable"):
        get_dashboard_summary(
            engine,
            identity={"platform_role": "ADMIN", "organizational_scope": "matrix", "role": "regional", "effective_regions": ["SPE"]},
            filters=T4T5Filters(), date_from=None, date_to=None,
        )


def test_matrix_summary_resolves_distinct_pdd_keys_and_matches_row_level_reference():
    engine, contract, table = _create_database()
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO base_mapping_entries
              (map_version_id, base_code, regional_name, base_name, uf_code, rm_region, rm_responsible)
            VALUES
              (:map_id, 'BASE-RJ', 'RJ', 'Twin PDD', 'RJ', 'RJ-RIO', 'RM Rio'),
              (:map_id, 'BASE-MG', 'MG', 'Twin PDD', 'MG', 'MG-BH', 'RM Minas')
        """), {"map_id": MAPPING_ID})
        connection.execute(text("""
            INSERT INTO base_mapping_name_decisions
              (map_version_id, source_id, source_base_name, resolution_state, target_base_code)
            VALUES
              (:map_id, :source_id, 'Manual Exact', 'LINKED', 'BASE-CE'),
              (:map_id, :source_id, 'Manual   Normalized', 'LINKED', 'BASE-SPE'),
              (:map_id, :source_id, 'Decision Ambiguous', 'AMBIGUOUS', NULL)
        """), {"map_id": MAPPING_ID, "source_id": contract.source_id})

    _insert_publication(engine, contract, table, day=20, rows=[
        {"source_base_name": "PDD SPE", "seller_id": "S-1", "awaiting_collection": 1},
        {"source_base_name": " pdd   ce ", "seller_id": "S-2", "awaiting_collection": 2},
        {"source_base_name": "Manual Exact", "seller_id": "S-3", "awaiting_collection": 3},
        {"source_base_name": " manual   normalized ", "seller_id": "S-4", "awaiting_collection": 4},
        {"source_base_name": "Twin PDD", "seller_id": "S-5", "awaiting_collection": 5},
        {"source_base_name": "Decision Ambiguous", "seller_id": "S-6", "awaiting_collection": 6},
        {"source_base_name": "Unknown PDD", "seller_id": "S-7", "awaiting_collection": 7},
    ])

    parameters = {
        "identity": MATRIX_USER,
        "filters": T4T5Filters(),
        "date_from": date(2026, 10, 20),
        "date_to": date(2026, 10, 20),
    }
    optimized = get_dashboard_summary(engine, **parameters)
    reference = _get_dashboard_summary_with_row_mapping(engine, **parameters)

    assert optimized == reference
    assert optimized["totals"]["records"] == 7
    assert optimized["totals"]["regions"] == 2
    assert optimized["totals"]["unmappedRecords"] == 3
    assert optimized["totals"]["statuses"]["awaiting_collection"] == 28


def test_matrix_distinct_mapping_summary_keeps_fact_filters_and_falls_back_for_map_filters_and_scopes():
    engine = _fixture_data()
    fact_filtered = T4T5Filters(
        customer_name="Cliente A", store_name="Loja 1", order_origin="App", search="PDD SPE",
    )
    optimized = get_dashboard_summary(
        engine, identity=MATRIX_USER, filters=fact_filtered,
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    reference = _get_dashboard_summary_with_row_mapping(
        engine, identity=MATRIX_USER, filters=fact_filtered,
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert optimized == reference
    assert optimized["totals"]["records"] == 1

    matrix_regional_filter = get_dashboard_summary(
        engine, identity=MATRIX_USER, filters=T4T5Filters(region="SPE"),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert matrix_regional_filter["totals"]["records"] == 1

    regional = get_dashboard_summary(
        engine, identity=REGIONAL_ADMIN, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert regional["totals"]["records"] == 1
    assert regional["totals"]["unmappedRecords"] == 0

    base = get_dashboard_summary(
        engine,
        identity={
            "platform_role": "USER", "organizational_scope": "base", "role": "regional",
            "home_base": "BASE-SPE", "home_region": "SPE",
        },
        filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
    )
    assert base["totals"]["records"] == 1
    assert base["totals"]["unmappedRecords"] == 0


def test_matrix_summary_sql_resolves_mapping_after_distinct_keys_only():
    engine = _fixture_data()
    table = fact_table_for_contract("collection_monitoring_t4_t5", 1)
    statements: list[str] = []

    def capture(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        get_dashboard_summary(
            engine, identity=MATRIX_USER, filters=T4T5Filters(),
            date_from=date(2026, 10, 20), date_to=date(2026, 10, 20),
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture)

    summary_sql = next(statement for statement in statements if table in statement)
    assert "keyed_snapshot_facts AS" in summary_sql
    assert "GROUP BY source_base_name_key, resolved_base_code_key, mapping_resolution_key" in summary_sql
    assert "FROM mapping_keys AS fact" in summary_sql
    assert summary_sql.index("GROUP BY source_base_name_key") < summary_sql.index("FROM mapping_keys AS fact")


def test_t4_t5_query_plan_starts_from_published_heads_without_changing_other_daily_sources():
    matrix_plan = _query_plan(
        "collection_monitoring_t4_t5", MATRIX_USER,
        contract_version=1, date_from=date(2026, 10, 20), date_to=date(2026, 10, 20),
        sql_dialect="mysql",
    )
    assert "FROM source_daily_head AS head" in matrix_plan.fact_from_sql
    assert "STRAIGHT_JOIN source_publications AS active_publication" in matrix_plan.fact_from_sql
    assert "publication_state = 'PUBLISHED'" in matrix_plan.fact_from_sql
    assert "STRAIGHT_JOIN `fact_collection_monitoring_t4_t5` AS fact" in matrix_plan.fact_from_sql
    assert "ROW_NUMBER()" not in matrix_plan.fact_from_sql
    assert "head.data_date >= :date_from" in matrix_plan.where_sql
    assert "head.data_date <= :date_to" in matrix_plan.where_sql

    legacy_plan = _query_plan(
        "collection_monitoring", MATRIX_USER,
        contract_version=2, date_from=date(2026, 10, 20), date_to=date(2026, 10, 20),
        sql_dialect="mysql",
    )
    assert "ROW_NUMBER()" in legacy_plan.fact_from_sql
    assert "source_daily_head AS head" not in legacy_plan.fact_from_sql


def test_aborted_t4_t5_facts_are_excluded_even_if_a_stale_head_exists():
    engine, contract, table = _create_database()
    _insert_aborted_snapshot_with_stale_head(engine, contract, table)

    summary = get_dashboard_summary(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 18), date_to=date(2026, 10, 18),
    )
    options = get_filter_options(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 18), date_to=date(2026, 10, 18),
    )
    details = get_detail_page(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 18), date_to=date(2026, 10, 18), limit=50, offset=0,
    )
    groups = get_group_page(
        engine, identity=MATRIX_USER, dimension="region", filters=T4T5Filters(),
        snapshot_date=date(2026, 10, 18), limit=100, offset=0,
    )

    assert summary["hasData"] is False
    assert options["snapshotDate"] is None
    assert options["regions"] == []
    assert details["records"] == []
    assert details["total"] == 0
    assert groups["rows"] == []
    assert groups["total"] == 0


def test_summary_and_filter_options_each_scan_t4_t5_facts_once():
    engine = _fixture_data()
    table = fact_table_for_contract("collection_monitoring_t4_t5", 1)
    statements: list[str] = []

    def capture(_connection, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        summary = get_dashboard_summary(
            engine, identity=MATRIX_USER, filters=T4T5Filters(),
            date_from=date(2026, 10, 20), date_to=date(2026, 10, 20),
        )
        summary_fact_queries = [sql for sql in statements if table in sql]
        statements.clear()
        options = get_filter_options(
            engine, identity=MATRIX_USER, filters=T4T5Filters(),
            date_from=date(2026, 10, 19), date_to=date(2026, 10, 20),
        )
        options_fact_queries = [sql for sql in statements if table in sql]
    finally:
        event.remove(engine, "before_cursor_execute", capture)

    assert summary["hasData"] is True
    assert len(summary_fact_queries) == 1
    assert options["snapshotDate"] == date(2026, 10, 20)
    assert len(options_fact_queries) == 1


def test_details_and_excel_keep_all_fifteen_original_columns_and_scope():
    engine = _fixture_data()
    detail = get_detail_page(
        engine, identity=REGIONAL_ADMIN, filters=T4T5Filters(),
        date_from=date(2026, 10, 19), date_to=date(2026, 10, 20), limit=50, offset=0,
    )
    assert detail["total"] == 2
    assert len(detail["records"][0]) == 15 + 8
    assert all(row["mapped_region"] == "SPE" for row in detail["records"])

    first_page = get_detail_page(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 20), date_to=date(2026, 10, 20), limit=2, offset=0,
    )
    last_page = get_detail_page(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 20), date_to=date(2026, 10, 20), limit=2, offset=2,
    )
    page_row_numbers = [row["source_row_no"] for row in first_page["records"] + last_page["records"]]
    assert first_page["total"] == last_page["total"] == 3
    assert len(first_page["records"]) == 2
    assert len(last_page["records"]) == 1
    assert len(set(page_row_numbers)) == 3

    base_detail = get_detail_page(
        engine,
        identity={
            "platform_role": "USER", "organizational_scope": "base", "role": "regional",
            "home_base": "BASE-SPE", "home_region": "SPE",
        },
        filters=T4T5Filters(),
        date_from=date(2026, 10, 20), date_to=date(2026, 10, 20), limit=50, offset=0,
    )
    assert base_detail["total"] == 1
    assert len(base_detail["records"]) == 1
    assert base_detail["records"][0]["mapped_region"] == "SPE"

    export_path = create_xlsx_export(
        engine, identity=MATRIX_USER, filters=T4T5Filters(),
        date_from=date(2026, 10, 20), date_to=date(2026, 10, 20),
    )
    try:
        with zipfile.ZipFile(export_path) as archive:
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        rows = sheet.findall(".//x:sheetData/x:row", namespace)
        assert len(rows) == 4  # header + three source records
        header = rows[0].findall("x:c", namespace)
        assert len(header) == 15
        cells = {cell.attrib["r"]: cell for cell in rows[1].findall("x:c", namespace)}
        assert cells["A2"].attrib.get("s") == "1"  # typed Excel date
        assert cells["F2"].attrib.get("t") == "inlineStr"  # seller IDs remain text
        assert cells["I2"].attrib.get("t") == "n"  # status counts remain numeric
        assert cells["I2"].find("x:v", namespace).text == "10"
    finally:
        export_path.unlink(missing_ok=True)
