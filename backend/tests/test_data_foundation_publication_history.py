from __future__ import annotations

import re
import uuid

import pytest
from sqlalchemy import create_engine, event, text

from app.services.data_foundation.queries import get_publications
from app.services.data_foundation.repository import DataFoundationError


MATRIX_USER = {
    "platform_role": "USER",
    "organizational_scope": "matrix",
    "role": "matrix",
}


def _history_engine(*, published_mapping: bool = True):
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def register_sqlite_functions(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "REGEXP_REPLACE",
            3,
            lambda value, pattern, replacement: (
                re.sub(pattern, replacement, value) if value is not None else None
            ),
        )

    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE base_mapping_versions (map_version_id BLOB PRIMARY KEY, version_state TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE base_mapping_current (current_key TEXT PRIMARY KEY, map_version_id BLOB)"
        )
        connection.exec_driver_sql("""
            CREATE TABLE base_mapping_entries (
                map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE base_mapping_name_decisions (
                map_version_id BLOB, source_id TEXT, source_base_name TEXT,
                resolution_state TEXT, target_base_code TEXT
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE source_publications (
                publication_id BLOB PRIMARY KEY,
                source_id TEXT NOT NULL,
                contract_version INTEGER NOT NULL,
                version_no INTEGER NOT NULL,
                published_at TEXT,
                snapshot_as_of TEXT,
                row_count INTEGER NOT NULL,
                period_start DATE,
                period_end DATE,
                publication_state TEXT NOT NULL
            )
        """)
        connection.exec_driver_sql("""
            CREATE TABLE source_publication_dates (
                source_id TEXT NOT NULL,
                publication_id BLOB NOT NULL,
                data_date DATE NOT NULL,
                row_count INTEGER NOT NULL,
                PRIMARY KEY(source_id, publication_id, data_date)
            )
        """)
        if published_mapping:
            mapping_id = b"m" * 16
            connection.execute(
                text("INSERT INTO base_mapping_versions VALUES (:id, 'PUBLISHED')"),
                {"id": mapping_id},
            )
            connection.execute(
                text("INSERT INTO base_mapping_current VALUES ('OFFICIAL', :id)"),
                {"id": mapping_id},
            )
    return engine


def _add_publication(
    connection,
    *,
    publication_id: bytes,
    source_id: str,
    contract_version: int,
    version_no: int,
    row_count: int,
    period_start: str | None,
    period_end: str | None,
    state: str = "PUBLISHED",
    snapshot_as_of: str | None = None,
) -> None:
    connection.execute(text("""
        INSERT INTO source_publications
          (publication_id, source_id, contract_version, version_no,
           published_at, snapshot_as_of, row_count, period_start, period_end,
           publication_state)
        VALUES
          (:publication_id, :source_id, :contract_version, :version_no,
           '2026-10-20 10:00:00', :snapshot_as_of, :row_count, :period_start,
           :period_end, :state)
    """), {
        "publication_id": publication_id,
        "source_id": source_id,
        "contract_version": contract_version,
        "version_no": version_no,
        "snapshot_as_of": snapshot_as_of,
        "row_count": row_count,
        "period_start": period_start,
        "period_end": period_end,
        "state": state,
    })


def _add_daily_count(connection, *, publication_id: bytes, day: str, count: int) -> None:
    connection.execute(text("""
        INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
        VALUES ('collection_rate', :publication_id, :day, :count)
    """), {"publication_id": publication_id, "day": day, "count": count})


def test_matrix_history_uses_metadata_for_all_supported_daily_contract_versions_and_paginates():
    engine = _history_engine()
    sql_statements: list[str] = []

    @event.listens_for(engine, "before_cursor_execute")
    def capture_sql(_connection, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            sql_statements.append(statement)

    ids = {version: uuid.uuid4().bytes for version in (1, 2, 3)}
    empty_id = uuid.uuid4().bytes
    prepared_id = uuid.uuid4().bytes
    with engine.begin() as connection:
        for version, version_no, row_count, days in (
            (1, 5, 4, (("2026-10-13", 2), ("2026-10-14", 2))),
            (2, 6, 1, (("2026-10-15", 1),)),
            (3, 7, 3, (("2026-10-15", 1), ("2026-10-16", 2))),
        ):
            start = days[0][0]
            end = days[-1][0]
            _add_publication(
                connection,
                publication_id=ids[version],
                source_id="collection_rate",
                contract_version=version,
                version_no=version_no,
                row_count=row_count,
                period_start=start,
                period_end=end,
            )
            for day, count in days:
                _add_daily_count(connection, publication_id=ids[version], day=day, count=count)
        _add_publication(
            connection,
            publication_id=empty_id,
            source_id="collection_rate",
            contract_version=1,
            version_no=8,
            row_count=0,
            period_start=None,
            period_end=None,
        )
        _add_publication(
            connection,
            publication_id=prepared_id,
            source_id="collection_rate",
            contract_version=3,
            version_no=9,
            row_count=99,
            period_start="2026-10-17",
            period_end="2026-10-17",
            state="PREPARED",
        )

    # No fact tables are created in this test: success proves the eligible
    # matrix path does not touch or aggregate operational facts.
    page = get_publications(
        engine,
        source_id="collection_rate",
        identity=MATRIX_USER,
        limit=2,
        offset=1,
    )
    assert page["total"] == 3
    assert page["limit"] == 2
    assert page["offset"] == 1
    assert [item["version"] for item in page["publications"]] == [6, 5]
    assert [item["contractVersion"] for item in page["publications"]] == [2, 1]
    assert [item["visibleRowCount"] for item in page["publications"]] == [1, 4]
    assert page["publications"][1]["periodStart"] == "2026-10-13"
    assert page["publications"][1]["periodEnd"] == "2026-10-14"

    all_publications = get_publications(
        engine,
        source_id="collection_rate",
        identity=MATRIX_USER,
        limit=50,
        offset=0,
    )
    assert [item["version"] for item in all_publications["publications"]] == [7, 6, 5]
    assert all_publications["publications"][0]["publicationId"] == str(uuid.UUID(bytes=ids[3]))
    assert all_publications["publications"][0]["periodStart"] == "2026-10-15"
    assert all_publications["publications"][0]["periodEnd"] == "2026-10-16"
    assert all("fact_" not in statement.lower() for statement in sql_statements)
    assert sum("SELECT COUNT(*)" in statement.upper() for statement in sql_statements) == 2
    assert any("LIMIT" in statement.upper() and "OFFSET" in statement.upper() for statement in sql_statements)

    filtered = get_publications(
        engine,
        source_id="collection_rate",
        identity=MATRIX_USER,
        limit=10,
        offset=0,
        contract_version=2,
    )
    assert filtered["total"] == 1
    assert [item["contractVersion"] for item in filtered["publications"]] == [2]
    engine.dispose()


def test_matrix_snapshot_history_uses_publication_metadata_and_excludes_empty_publications():
    engine = _history_engine()
    publication_id = uuid.uuid4().bytes
    empty_id = uuid.uuid4().bytes
    with engine.begin() as connection:
        _add_publication(
            connection,
            publication_id=publication_id,
            source_id="no_movement",
            contract_version=2,
            version_no=3,
            row_count=151,
            period_start="2026-10-19",
            period_end="2026-10-19",
            snapshot_as_of="2026-10-19 08:00:00",
        )
        _add_publication(
            connection,
            publication_id=empty_id,
            source_id="no_movement",
            contract_version=2,
            version_no=4,
            row_count=0,
            period_start=None,
            period_end=None,
        )

    result = get_publications(
        engine,
        source_id="no_movement",
        identity=MATRIX_USER,
        limit=50,
        offset=0,
    )
    assert result["total"] == 1
    assert result["publications"] == [{
        "publicationId": str(uuid.UUID(bytes=publication_id)),
        "version": 3,
        "contractVersion": 2,
        "publishedAt": "2026-10-20 10:00:00",
        "snapshotAsOf": "2026-10-19 08:00:00",
        "visibleRowCount": 151,
        "periodStart": "2026-10-19",
        "periodEnd": "2026-10-19",
    }]
    engine.dispose()


def test_matrix_history_requires_current_published_official_mapping():
    engine = _history_engine(published_mapping=False)
    with pytest.raises(DataFoundationError, match="official_mapping_unavailable"):
        get_publications(
            engine,
            source_id="collection_rate",
            identity=MATRIX_USER,
            limit=10,
            offset=0,
        )
    engine.dispose()


def test_inconsistent_daily_metadata_falls_back_to_legacy_fact_aggregation():
    engine = _history_engine()
    publication_id = uuid.uuid4().bytes
    with engine.begin() as connection:
        _add_publication(
            connection,
            publication_id=publication_id,
            source_id="collection_monitoring",
            contract_version=1,
            version_no=1,
            row_count=2,
            period_start="2026-10-05",
            period_end="2026-10-05",
        )
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES ('collection_monitoring', :publication_id, '2026-10-05', 1)
        """), {"publication_id": publication_id})
        connection.exec_driver_sql("""
            CREATE TABLE fact_collection_monitoring (
                source_id TEXT, publication_id BLOB, data_date DATE,
                source_base_name TEXT, resolved_base_code TEXT
            )
        """)
        connection.execute(text("""
            INSERT INTO fact_collection_monitoring
              (source_id, publication_id, data_date, source_base_name, resolved_base_code)
            VALUES ('collection_monitoring', :publication_id, '2026-10-05', 'Unknown base', NULL)
        """), {"publication_id": publication_id})

    result = get_publications(
        engine,
        source_id="collection_monitoring",
        identity=MATRIX_USER,
        limit=10,
        offset=0,
    )
    assert result["total"] == 1
    assert result["publications"][0]["visibleRowCount"] == 1
    assert result["publications"][0]["periodStart"] == "2026-10-05"
    engine.dispose()
