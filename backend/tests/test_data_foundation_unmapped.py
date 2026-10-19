from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import re
import sqlite3
from types import SimpleNamespace
import uuid
from io import BytesIO
from xml.sax.saxutils import escape
import zipfile

import pytest
from sqlalchemy import create_engine, event, text

from app.services.data_foundation.contracts import CONTRACTS, CONTRACT_VERSIONS
from app.services.data_foundation import repository
from app.services.data_foundation.mapping_resolution import build_mapping_query
from app.services.data_foundation.queries import get_date_counts, get_publications, get_records
from app.services.data_foundation.repository import (
    FACT_BATCH_SIZE,
    FACT_TABLES,
    DataFoundationError,
    _fact_row,
    _insert_fact_batches,
    _persisted_mapping_resolution,
    _switch_heads,
)
from app.services.data_foundation.xlsx_parser import MappingResolver, ValidImportRow, _resolve_mapping, parse_workbook


EXPECTED_ROWS = {
    "collection_monitoring": 3_877,
    "collection_rate": 3_269,
    "jt_monitoring": 159_666,
    "no_movement": 151,
    "pdd_collection_failure": 1_617,
}
ADMIN_MATRIX = {
    "platform_role": "ADMIN",
    "organizational_scope": "matrix",
    "role": "matrix",
}
MAP_VERSION_ID = b"m" * 16


def _sqlite_type(kind: str) -> str:
    return {
        "DATE": "DATE",
        "DATETIME": "DATETIME",
        "BASE_CODE": "TEXT",
        "TEXT": "TEXT",
        "INTEGER": "INTEGER",
        "DECIMAL": "NUMERIC",
    }[kind]


def _create_query_schema(engine) -> None:
    @event.listens_for(engine, "connect")
    def register_query_functions(dbapi_connection, _connection_record):
        dbapi_connection.create_function(
            "REGEXP_REPLACE",
            3,
            lambda value, pattern, replacement: (
                re.sub(pattern, replacement, value) if value is not None else None
            ),
        )

    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE base_mapping_versions (map_version_id BLOB PRIMARY KEY, version_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_current (current_key TEXT PRIMARY KEY, map_version_id BLOB)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_entries (map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT, uf_code TEXT, rm_region TEXT, rm_responsible TEXT)")
        connection.exec_driver_sql("CREATE TABLE base_mapping_name_decisions (map_version_id BLOB, source_id TEXT, source_base_name TEXT, resolution_state TEXT, target_base_code TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publications (publication_id BLOB PRIMARY KEY, source_id TEXT, contract_version INTEGER NOT NULL DEFAULT 1, version_no INTEGER, period_start TEXT, period_end TEXT, snapshot_as_of TEXT, published_at TEXT, publication_state TEXT)")
        connection.exec_driver_sql("CREATE TABLE source_publication_dates (source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER, PRIMARY KEY(source_id, publication_id, data_date))")
        connection.exec_driver_sql("CREATE TABLE source_daily_head (source_id TEXT, data_date DATE, publication_id BLOB, PRIMARY KEY(source_id, data_date))")
        connection.exec_driver_sql("CREATE TABLE source_snapshot_head (source_id TEXT PRIMARY KEY, publication_id BLOB)")
        connection.execute(text("INSERT INTO base_mapping_versions VALUES (:id, 'PUBLISHED')"), {"id": MAP_VERSION_ID})
        connection.execute(text("INSERT INTO base_mapping_current VALUES ('OFFICIAL', :id)"), {"id": MAP_VERSION_ID})
        connection.execute(text("""
            INSERT INTO base_mapping_entries
              (map_version_id, base_code, regional_name, base_name)
            VALUES (:id, 'MATCHED-001', 'SPE', 'Mapped base')
        """), {"id": MAP_VERSION_ID})

        for source_id, table_name in FACT_TABLES.items():
            contract = CONTRACTS[source_id]
            column_definitions = [
                "source_id TEXT NOT NULL",
                "publication_id BLOB NOT NULL",
                "map_version_id BLOB NOT NULL",
                "source_row_no INTEGER NOT NULL",
            ]
            declared_keys = {"source_id", "publication_id", "map_version_id", "source_row_no"}
            for column in contract.columns:
                if column.key not in declared_keys:
                    column_definitions.append(f"`{column.key}` {_sqlite_type(column.kind)}")
                    declared_keys.add(column.key)
            if source_id == "collection_rate":
                column_definitions.append("data_date DATE GENERATED ALWAYS AS (date(deadline_at)) STORED")
            elif source_id in {"collection_monitoring", "jt_monitoring", "pdd_collection_failure"}:
                assert "data_date" in declared_keys
            if source_id in {"collection_monitoring", "collection_rate", "jt_monitoring"}:
                resolution_check = """CHECK (
                    (mapping_resolution = 'NAME_APPROVED' AND source_base_name IS NOT NULL
                        AND length(trim(source_base_name)) > 0 AND resolved_base_code IS NOT NULL)
                    OR (mapping_resolution = 'MISSING_IDENTIFIER'
                        AND (source_base_name IS NULL OR length(trim(source_base_name)) = 0)
                        AND resolved_base_code IS NULL)
                    OR (mapping_resolution IN ('UNMAPPED', 'AMBIGUOUS')
                        AND source_base_name IS NOT NULL AND length(trim(source_base_name)) > 0
                        AND resolved_base_code IS NULL)
                )"""
            else:
                resolution_check = """CHECK (
                    (mapping_resolution = 'CODE_MATCH' AND source_base_code IS NOT NULL
                        AND resolved_base_code IS NOT NULL)
                    OR (mapping_resolution = 'UNMAPPED' AND resolved_base_code IS NULL)
                )"""
            column_definitions.extend([
                "resolved_base_code TEXT",
                f"mapping_resolution TEXT NOT NULL {resolution_check}",
                "PRIMARY KEY(publication_id, source_row_no)",
            ])
            connection.exec_driver_sql(f"CREATE TABLE `{table_name}` ({', '.join(column_definitions)})")

        collection_rate_v2 = CONTRACT_VERSIONS[("collection_rate", 2)]
        v2_column_definitions = [
            "source_id TEXT NOT NULL",
            "publication_id BLOB NOT NULL",
            "map_version_id BLOB NOT NULL",
            "source_row_no INTEGER NOT NULL",
            *(f"`{column.key}` {_sqlite_type(column.kind)}" for column in collection_rate_v2.columns),
            "resolved_base_code TEXT",
            "mapping_resolution TEXT NOT NULL",
            "PRIMARY KEY(publication_id, source_row_no)",
        ]
        connection.exec_driver_sql(
            f"CREATE TABLE fact_collection_rate_v2 ({', '.join(v2_column_definitions)})"
        )

        collection_rate_v3 = CONTRACT_VERSIONS[("collection_rate", 3)]
        v3_column_definitions = [
            "source_id TEXT NOT NULL",
            "publication_id BLOB NOT NULL",
            "map_version_id BLOB NOT NULL",
            "source_row_no INTEGER NOT NULL",
            *(f"`{column.key}` {_sqlite_type(column.kind)}" for column in collection_rate_v3.columns),
            "data_date DATE GENERATED ALWAYS AS (date(deadline_at)) STORED",
            "resolved_base_code TEXT",
            "mapping_resolution TEXT NOT NULL",
            "PRIMARY KEY(publication_id, source_row_no)",
        ]
        connection.exec_driver_sql(
            f"CREATE TABLE fact_collection_rate_v3 ({', '.join(v3_column_definitions)})"
        )


def _row_values(source_id: str, row_no: int, *, duplicate_group: bool = False) -> dict[str, object]:
    contract = CONTRACTS[source_id]
    value_no = 1 if duplicate_group else row_no
    values: dict[str, object] = {}
    for column in contract.columns:
        if column.kind == "DATE":
            value: object = date(2026, 10, 1)
        elif column.kind == "DATETIME":
            value = datetime(2026, 10, 1, 8, 30)
        elif column.kind == "INTEGER":
            value = value_no
        elif column.kind == "DECIMAL":
            value = Decimal(value_no) / Decimal(100)
        elif column.kind == "BASE_CODE":
            value = f"SOURCE-CODE-{value_no:06d}"
        else:
            value = f"{column.key}-{value_no}"
        values[column.key] = value

    if source_id in {"collection_monitoring", "collection_rate", "jt_monitoring"}:
        if duplicate_group:
            values["source_base_name"] = "Unmapped duplicate from source"
        elif row_no == 1:
            values["source_base_name"] = "Approved source name"
        elif row_no == 2:
            values["source_base_name"] = "Exact candidate awaiting approval"
        elif row_no == 3:
            values["source_base_name"] = "Rejected source name"
        elif row_no == 4:
            values["source_base_name"] = "Ambiguous source name"
        elif row_no == 5:
            values["source_base_name"] = None
        else:
            values["source_base_name"] = f"No match {row_no}"
    elif source_id in {"no_movement", "pdd_collection_failure"}:
        values["source_base_code"] = "MATCHED-001" if row_no == 1 else f"NO-MATCH-{row_no}"
    if source_id == "no_movement":
        aging_keys = (
            "stopped_over_1_day", "stopped_over_2_days", "stopped_over_3_days",
            "stopped_over_4_days", "stopped_over_5_days", "stopped_over_6_days",
            "stopped_over_7_days", "stopped_over_10_days", "stopped_over_14_days",
            "stopped_over_30_days",
        )
        values["stopped_orders"] = sum(int(values[key]) for key in aging_keys)
    return values


def _resolution(source_id: str, row_no: int, *, duplicate_group: bool = False) -> tuple[str | None, str]:
    if source_id in {"collection_monitoring", "collection_rate", "jt_monitoring"}:
        if duplicate_group:
            return None, "UNMAPPED"
        states = {
            1: ("MATCHED-001", "NAME_APPROVED"),
            2: (None, "UNAPPROVED_EXACT_NAME"),
            3: (None, "REJECTED"),
            4: (None, "AMBIGUOUS"),
            5: (None, "MISSING_IDENTIFIER"),
        }
        return states.get(row_no, (None, "UNMAPPED"))
    if row_no == 1:
        return "MATCHED-001", "CODE_MATCH"
    return None, "UNMAPPED"


def _xlsx_bytes(contract, rows: list[dict[str, object]]) -> bytes:
    def column_letters(index: int) -> str:
        result = ""
        while index:
            index, remainder = divmod(index - 1, 26)
            result = chr(65 + remainder) + result
        return result

    def excel_serial(value: date | datetime) -> str:
        parsed = datetime.combine(value, datetime.min.time()) if isinstance(value, date) and not isinstance(value, datetime) else value
        return str((parsed - datetime(1899, 12, 30)).total_seconds() / 86400)

    def make_sheet_xml(headers: list[str], data_rows: list[dict[str, object]], kinds: list[str], keys: list[str] | None = None) -> str:
        row_keys = keys or headers
        xml_rows = []
        for row_no in range(1, len(data_rows) + 2):
            values = data_rows[row_no - 2] if row_no > 1 else None
            cells = []
            for index, (header, kind) in enumerate(zip(headers, kinds), start=1):
                value = header if values is None else values.get(row_keys[index - 1])
                if value is None:
                    continue
                reference = f"{column_letters(index)}{row_no}"
                if row_no == 1 or kind in {"TEXT", "BASE_CODE"}:
                    cells.append(f'<c r="{reference}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
                elif kind in {"DATE", "DATETIME"}:
                    cells.append(f'<c r="{reference}" s="1"><v>{excel_serial(value)}</v></c>')
                else:
                    numeric = format(value, "f") if isinstance(value, Decimal) else str(value)
                    cells.append(f'<c r="{reference}" t="n"><v>{numeric}</v></c>')
            xml_rows.append(f'<row r="{row_no}">{"".join(cells)}</row>')
        return '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'

    if contract.source_id == "no_movement" and contract.version >= 2:
        execution_headers = ["Id da execução", "Data e horário da execução", "Quantidade de registros recebidos", "Quantidade de páginas consultadas", "Situação da execução", "Erros", "Data da coleta"]
        execution_row = {
            "Id da execução": "synthetic-execution",
            "Data e horário da execução": datetime(2026, 10, 14, 10, 0),
            "Quantidade de registros recebidos": len(rows),
            "Quantidade de páginas consultadas": 1 if rows else 0,
            "Situação da execução": "SUCESSO",
            "Erros": None,
            "Data da coleta": date(2026, 10, 14),
        }
        dictionary_headers = ["Nome original do campo", "Nome exibido no JMS", "Tradução para português", "Status da identificação"]
        dictionary_fields = ["scanAgentName", "dutyCode", "dutyName", "total", "halfwayCount", "day1", "day2", "day3", "day4", "day5", "day6", "day7", "day10", "day14", "day30", "operateTime", "dayRate14", "dayRate30"]
        dictionary_rows = [{header: value for header, value in zip(dictionary_headers, (field, field, field, "Confirmado"))} for field in dictionary_fields]
        sheets = [
            ("Dados", list(contract.headers), rows, [column.kind for column in contract.columns], [column.key for column in contract.columns]),
            ("Execucoes", execution_headers, [execution_row], ["TEXT", "DATETIME", "INTEGER", "INTEGER", "TEXT", "TEXT", "DATE"], None),
            ("Dicionario", dictionary_headers, dictionary_rows, ["TEXT"] * 4, None),
        ]
    else:
        sheets = [(contract.sheet_name, list(contract.headers), rows, [column.kind for column in contract.columns], [column.key for column in contract.columns])]

    parts = {
        "xl/workbook.xml": (
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets>' + "".join(
                f'<sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="{index}" r:id="rId{index}"/>'
                for index, (name, _headers, _rows, _kinds, _keys) in enumerate(sheets, start=1)
            ) + '</sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
                for index in range(1, len(sheets) + 1)
            ) + '</Relationships>'
        ),
        "xl/styles.xml": (
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>'
            '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'
        ),
    }
    for index, (_name, headers, sheet_rows, kinds, keys) in enumerate(sheets, start=1):
        parts[f"xl/worksheets/sheet{index}.xml"] = make_sheet_xml(headers, sheet_rows, kinds, keys)
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return output.getvalue()


def _fake_streaming_parser(row_totals: dict[str, int]):
    def parse_workbook(_content, contract, _resolver=None, *, on_valid_row=None):
        total = row_totals[contract.source_id]
        for row_no in range(1, total + 1):
            duplicate_group = contract.source_id == "jt_monitoring" and row_no <= 4
            values = _row_values(contract.source_id, row_no, duplicate_group=duplicate_group)
            resolved_code, resolution = _resolution(contract.source_id, row_no, duplicate_group=duplicate_group)
            if on_valid_row is not None:
                on_valid_row(ValidImportRow(row_no, values, resolved_code, resolution))
        return SimpleNamespace(invalid_row_count=0, can_publish=True, valid_row_count=total)

    return parse_workbook


def test_all_five_sources_insert_full_row_counts_in_batches_and_keep_unmapped_data(monkeypatch):
    sqlite3.register_adapter(Decimal, str)
    sqlite3.register_adapter(date, lambda value: value.isoformat())
    sqlite3.register_adapter(datetime, lambda value: value.isoformat(sep=" "))
    engine = create_engine("sqlite://")
    _create_query_schema(engine)
    batch_sizes: list[int] = []

    @event.listens_for(engine, "before_cursor_execute")
    def record_fact_batches(_connection, _cursor, statement, parameters, _context, executemany):
        if statement.lstrip().upper().startswith("INSERT INTO `FACT_"):
            batch_sizes.append(len(parameters) if executemany else 1)

    monkeypatch.setattr(repository, "parse_workbook", _fake_streaming_parser(EXPECTED_ROWS))
    publication_ids = {
        source_id: uuid.uuid5(uuid.NAMESPACE_URL, f"test-publication:{source_id}").bytes
        for source_id in EXPECTED_ROWS
    }
    try:
        with engine.begin() as connection:
            for source_id, expected_count in EXPECTED_ROWS.items():
                _insert_fact_batches(
                    connection,
                    source_id=source_id,
                    contract=CONTRACTS[source_id],
                    publication_id=publication_ids[source_id],
                    map_version_id=MAP_VERSION_ID,
                    file_content=b"temporary synthetic input",
                    resolver=None,
                )

                connection.execute(text("""
                    INSERT INTO source_publications
                      (publication_id, source_id, contract_version, version_no, published_at, publication_state)
                    VALUES (:publication_id, :source_id, :contract_version, 1, '2026-10-09', 'PUBLISHED')
                """), {
                    "publication_id": publication_ids[source_id],
                    "source_id": source_id,
                    "contract_version": CONTRACTS[source_id].version,
                })
                if source_id in repository.DAILY_SOURCES:
                    connection.execute(text("""
                        INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
                        VALUES (:source_id, :publication_id, '2026-10-01', :row_count)
                    """), {
                        "source_id": source_id,
                        "publication_id": publication_ids[source_id],
                        "row_count": expected_count,
                    })
                    connection.execute(text("""
                        INSERT INTO source_daily_head (source_id, data_date, publication_id)
                        VALUES (:source_id, '2026-10-01', :publication_id)
                    """), {"source_id": source_id, "publication_id": publication_ids[source_id]})
                else:
                    connection.execute(text("""
                        INSERT INTO source_snapshot_head (source_id, publication_id)
                        VALUES (:source_id, :publication_id)
                    """), {"source_id": source_id, "publication_id": publication_ids[source_id]})

                count = connection.execute(
                    text(f"SELECT COUNT(*) FROM `{FACT_TABLES[source_id]}`")
                ).scalar_one()
                assert count == expected_count

        assert batch_sizes
        assert max(batch_sizes) <= FACT_BATCH_SIZE
        assert len(batch_sizes) > len(EXPECTED_ROWS)

        identity = ADMIN_MATRIX
        for source_id, expected_count in EXPECTED_ROWS.items():
            result = get_records(
                engine,
                source_id=source_id,
                identity=identity,
                limit=250,
                offset=0,
            )
            assert result["total"] == expected_count
            assert len(result["records"]) == min(250, expected_count)
            assert any(record["mapping_resolution"] == "UNMAPPED" for record in result["records"])

            publication_result = get_publications(
                engine,
                source_id=source_id,
                identity=identity,
                limit=10,
                offset=0,
            )
            assert publication_result["total"] == 1
            assert publication_result["publications"][0]["visibleRowCount"] == expected_count
            assert publication_result["publications"][0]["contractVersion"] == CONTRACTS[source_id].version

            regional_identity = {
                "platform_role": "USER",
                "organizational_scope": "regional",
                "role": "regional",
                "home_region": "SPE",
                "additional_regions": [],
            }
            regional_records = get_records(
                engine,
                source_id=source_id,
                identity=regional_identity,
                limit=10_000,
                offset=0,
            )
            regional_publications = get_publications(
                engine,
                source_id=source_id,
                identity=regional_identity,
                limit=10,
                offset=0,
            )
            visible_publication_rows = (
                regional_publications["publications"][0]["visibleRowCount"]
                if regional_publications["publications"]
                else 0
            )
            assert visible_publication_rows == regional_records["total"]
            assert regional_publications["total"] == (1 if regional_records["total"] else 0)
            assert regional_records["total"] <= expected_count

            counts = get_date_counts(engine, source_id=source_id, identity=identity)
            if source_id == "no_movement":
                assert counts["snapshotRowCount"] == expected_count
            else:
                assert sum(day["rowCount"] for day in counts["dates"]) == expected_count

        monitoring = get_records(
            engine, source_id="collection_monitoring", identity=identity, limit=10, offset=0
        )["records"]
        assert monitoring[1]["mapping_resolution"] == "UNMAPPED"
        assert monitoring[1]["source_base_name"] == "Exact candidate awaiting approval"
        assert monitoring[4]["mapping_resolution"] == "MISSING_IDENTIFIER"
        assert monitoring[4]["source_base_name"] is None

        jt = get_records(engine, source_id="jt_monitoring", identity=identity, limit=10, offset=0)["records"]
        duplicate_values = {
            tuple(record[column.key] for column in CONTRACTS["jt_monitoring"].columns)
            for record in jt[:4]
        }
        assert len(duplicate_values) == 1
        assert [record["source_row_no"] for record in jt[:4]] == [1, 2, 3, 4]
    finally:
        engine.dispose()


def test_mapping_resolution_normalization_is_explicit_and_source_specific():
    for source_id in ("collection_monitoring", "collection_rate", "jt_monitoring"):
        assert _persisted_mapping_resolution(source_id, "UNAPPROVED_EXACT_NAME") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "UNAPPROVED_NORMALIZED_NAME") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "REJECTED") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "NAME_APPROVED") == "NAME_APPROVED"
        assert _persisted_mapping_resolution(source_id, "MISSING_IDENTIFIER") == "MISSING_IDENTIFIER"
        assert _persisted_mapping_resolution(source_id, "AMBIGUOUS") == "AMBIGUOUS"
    for source_id in ("no_movement", "pdd_collection_failure"):
        assert _persisted_mapping_resolution(source_id, "CODE_MATCH") == "CODE_MATCH"
        assert _persisted_mapping_resolution(source_id, "UNMAPPED") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "NAME_APPROVED") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "MISSING_IDENTIFIER") == "UNMAPPED"
        assert _persisted_mapping_resolution(source_id, "AMBIGUOUS") == "UNMAPPED"
    with pytest.raises(DataFoundationError, match="mapping_resolution_not_persistable"):
        _persisted_mapping_resolution("collection_monitoring", "MAP_ENTRY")

    row = _fact_row(
        "collection_monitoring",
        CONTRACTS["collection_monitoring"],
        b"p" * 16,
        MAP_VERSION_ID,
        ValidImportRow(
            source_row_no=17,
            values={"source_base_name": "Exact candidate awaiting approval", "awaiting_collection_dropoff": 23},
            resolved_base_code=None,
            mapping_resolution="UNAPPROVED_EXACT_NAME",
        ),
    )
    assert row["mapping_resolution"] == "UNMAPPED"
    assert row["source_base_name"] == "Exact candidate awaiting approval"
    assert row["source_row_no"] == 17
    assert row["awaiting_collection_dropoff"] == 23
    assert row["resolved_base_code"] is None

    code_source_row = _fact_row(
        "no_movement",
        CONTRACTS["no_movement"],
        b"n" * 16,
        MAP_VERSION_ID,
        ValidImportRow(
            source_row_no=18,
            values={"source_base_code": "legacy-code", "source_base_name": "Approved name"},
            resolved_base_code="MATCHED-001",
            mapping_resolution="NAME_APPROVED",
        ),
    )
    assert code_source_row["mapping_resolution"] == "UNMAPPED"
    assert code_source_row["resolved_base_code"] is None
    assert code_source_row["source_base_code"] == "legacy-code"


@pytest.mark.parametrize("source_id", ("no_movement", "pdd_collection_failure"))
def test_code_sources_prioritize_supplied_code_then_use_unique_name_only_when_code_is_absent(source_id):
    resolver = MappingResolver(
        map_version_id=MAP_VERSION_ID,
        base_codes=frozenset({"PR-CWB"}),
        exact_base_name_candidates={
            "Base RS": ("RS-001",),
            "Base Duplicada": ("DUP-001", "DUP-002"),
        },
        name_decisions={"Base RS": ("LINKED", "RS-001")},
    )
    assert _resolve_mapping(
        source_id,
        {"source_base_code": "PR-CWB", "source_base_name": "Base RS"},
        resolver,
    ) == ("PR-CWB", "CODE_MATCH")
    assert _resolve_mapping(
        source_id,
        {"source_base_code": None, "source_base_name": "Base RS"},
        resolver,
    ) == ("RS-001", "NAME_APPROVED")
    assert _resolve_mapping(
        source_id,
        {"source_base_code": "unknown", "source_base_name": "Base Duplicada"},
        resolver,
    ) == (None, "UNMAPPED")
    assert _resolve_mapping(
        source_id,
        {"source_base_code": None, "source_base_name": None},
        resolver,
    ) == (None, "MISSING_IDENTIFIER")


@pytest.mark.parametrize("source_id", tuple(EXPECTED_ROWS))
def test_actual_parser_states_fit_the_source_enums(source_id):
    contract = CONTRACTS[source_id]
    resolver = MappingResolver(
        map_version_id=MAP_VERSION_ID,
        base_codes=frozenset({"MATCHED-001"}),
        exact_base_name_candidates={
            "Approved name": ("MATCHED-001",),
            "Exact candidate": ("MATCHED-001",),
            "Rejected name": ("MATCHED-001",),
            "Ambiguous name": ("MATCHED-001", "MATCHED-002"),
        },
        name_decisions={
            "Approved name": ("LINKED", "MATCHED-001"),
            "Rejected name": ("REJECTED", None),
        },
    )

    if source_id in {"collection_monitoring", "collection_rate", "jt_monitoring"}:
        rows = []
        names = ["Approved name", "Exact candidate", "Rejected name", "Ambiguous name", None]
        for row_no, name in enumerate(names, start=1):
            values = _row_values(source_id, row_no)
            values["source_base_name"] = name
            rows.append(values)
        expected_parser_states = [
            "NAME_APPROVED", "NAME_APPROVED", "NAME_APPROVED", "AMBIGUOUS", "MISSING_IDENTIFIER",
        ]
        expected_storage_states = expected_parser_states
    else:
        rows = []
        for row_no, code in enumerate(("MATCHED-001", "UNMATCHED-002"), start=1):
            values = _row_values(source_id, row_no)
            values["source_base_code"] = code
            rows.append(values)
        expected_parser_states = ["CODE_MATCH", "UNMAPPED"]
        expected_storage_states = ["CODE_MATCH", "UNMAPPED"]

    parsed_rows: list[ValidImportRow] = []
    summary = parse_workbook(
        _xlsx_bytes(contract, rows),
        contract,
        resolver,
        on_valid_row=parsed_rows.append,
    )
    assert summary.valid_row_count == len(rows)
    assert summary.invalid_row_count == 0
    assert summary.can_publish is True
    assert [row.mapping_resolution for row in parsed_rows] == expected_parser_states
    assert [
        _persisted_mapping_resolution(source_id, row.mapping_resolution)
        for row in parsed_rows
    ] == expected_storage_states


def test_collection_rate_v1_v2_and_v3_select_their_own_latest_daily_publications():
    engine = create_engine("sqlite://")
    _create_query_schema(engine)
    data_day = date(2026, 10, 13)
    old_v1_publication = b"1" * 16
    current_v1_publication = b"2" * 16
    current_v2_publication = b"3" * 16
    current_v3_publication = b"4" * 16

    def row_values(contract, row_no: int, *, base_code: str | None) -> dict[str, object]:
        result: dict[str, object] = {}
        for column in contract.columns:
            if column.kind == "DATE":
                value: object = data_day
            elif column.kind == "DATETIME":
                value = datetime(2026, 10, 13, 9, 0)
            elif column.kind == "INTEGER":
                value = row_no
            elif column.kind == "DECIMAL":
                value = 0.5
            elif column.key == "source_base_code":
                value = base_code
            elif column.key == "source_base_name":
                value = "Mapped base"
            elif column.nullable:
                value = None
            else:
                value = f"{column.key}-{row_no}"
            result[column.key] = value
        return result

    try:
        with engine.begin() as connection:
            for publication_id, contract_version, version_no, published_at, snapshot_as_of in (
                (old_v1_publication, 1, 4, "2026-10-13 10:00:00", "2026-10-13 09:00:00"),
                (current_v1_publication, 1, 5, "2026-10-14 10:00:00", "2026-10-14 09:00:00"),
                (current_v2_publication, 2, 6, "2026-10-14 11:00:00", "2026-10-14 10:30:00"),
                (current_v3_publication, 3, 7, "2026-10-14 12:00:00", "2026-10-14 11:30:00"),
            ):
                connection.execute(text("""
                    INSERT INTO source_publications
                      (publication_id, source_id, contract_version, version_no, published_at, snapshot_as_of, publication_state)
                    VALUES (:publication_id, 'collection_rate', :contract_version, :version_no, :published_at, :snapshot_as_of, 'PUBLISHED')
                """), {
                    "publication_id": publication_id,
                    "contract_version": contract_version,
                    "version_no": version_no,
                    "published_at": published_at,
                    "snapshot_as_of": snapshot_as_of,
                })
                connection.execute(text("""
                    INSERT INTO source_publication_dates
                      (source_id, publication_id, data_date, row_count)
                    VALUES ('collection_rate', :publication_id, :data_day, 1)
                """), {"publication_id": publication_id, "data_day": data_day})

            for contract_version, publication_id, source_row_no, mapping_resolution, source_code in (
                (1, old_v1_publication, 1, "NAME_APPROVED", None),
                (1, current_v1_publication, 2, "NAME_APPROVED", None),
                (2, current_v2_publication, 3, "CODE_MATCH", "MATCHED-001"),
                (3, current_v3_publication, 4, "NAME_APPROVED", None),
            ):
                contract = CONTRACT_VERSIONS[("collection_rate", contract_version)]
                values = row_values(contract, source_row_no, base_code=source_code)
                columns = [
                    "source_id", "publication_id", "map_version_id", "source_row_no",
                    *(column.key for column in contract.columns),
                    "resolved_base_code", "mapping_resolution",
                ]
                table = {
                    1: "fact_collection_rate",
                    2: "fact_collection_rate_v2",
                    3: "fact_collection_rate_v3",
                }[contract_version]
                payload = {
                    "source_id": "collection_rate",
                    "publication_id": publication_id,
                    "map_version_id": MAP_VERSION_ID,
                    "source_row_no": source_row_no,
                    **values,
                    "resolved_base_code": "MATCHED-001",
                    "mapping_resolution": mapping_resolution,
                }
                connection.execute(text(
                    f"INSERT INTO `{table}` ({', '.join(f'`{column}`' for column in columns)}) "
                    f"VALUES ({', '.join(f':{column}' for column in columns)})"
                ), payload)

            connection.execute(text("""
                INSERT INTO source_daily_head (source_id, data_date, publication_id)
                VALUES ('collection_rate', :data_day, :publication_id)
            """), {"data_day": data_day, "publication_id": current_v2_publication})

        v1 = get_records(
            engine, source_id="collection_rate", identity=ADMIN_MATRIX,
            limit=250, offset=0, date_from=data_day, date_to=data_day,
            contract_version=1,
        )
        v2 = get_records(
            engine, source_id="collection_rate", identity=ADMIN_MATRIX,
            limit=250, offset=0, date_from=data_day, date_to=data_day,
            contract_version=2,
        )
        v3 = get_records(
            engine, source_id="collection_rate", identity=ADMIN_MATRIX,
            limit=250, offset=0, date_from=data_day, date_to=data_day,
            contract_version=3,
        )
        assert v1["total"] == 1
        assert v1["records"][0]["source_row_no"] == 2
        assert v1["records"][0]["publication_id"] == str(uuid.UUID(bytes=current_v1_publication))
        assert v2["total"] == 1
        assert v2["records"][0]["source_row_no"] == 3
        assert v2["records"][0]["publication_id"] == str(uuid.UUID(bytes=current_v2_publication))
        assert v3["total"] == 1
        assert v3["records"][0]["source_row_no"] == 4
        assert v3["records"][0]["publication_id"] == str(uuid.UUID(bytes=current_v3_publication))
        assert v3["records"][0]["mapped_region"] == "SPE"
        assert v3["records"][0]["effective_mapping_resolution"] == "NAME_APPROVED"
        v2_dates = get_date_counts(
            engine, source_id="collection_rate", identity=ADMIN_MATRIX,
            date_from=data_day, date_to=data_day, contract_version=2,
        )
        assert v2_dates["hasPublishedPublication"] is True
        assert v2_dates["dates"] == [{
            "date": data_day.isoformat(),
            "rowCount": 1,
            "publicationId": str(uuid.UUID(bytes=current_v2_publication)),
            "publishedAt": "2026-10-14 11:00:00",
            "snapshotAsOf": "2026-10-14 10:30:00",
        }]
        v3_dates = get_date_counts(
            engine, source_id="collection_rate", identity=ADMIN_MATRIX,
            date_from=data_day, date_to=data_day, contract_version=3,
        )
        assert v3_dates["hasPublishedPublication"] is True
        assert v3_dates["dates"] == [{
            "date": data_day.isoformat(),
            "rowCount": 1,
            "publicationId": str(uuid.UUID(bytes=current_v3_publication)),
            "publishedAt": "2026-10-14 12:00:00",
            "snapshotAsOf": "2026-10-14 11:30:00",
        }]
    finally:
        engine.dispose()


def test_daily_replace_dates_preserves_other_days_and_snapshot_replaces_one_head():
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE source_daily_head (source_id TEXT, data_date DATE, publication_id BLOB, changed_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_id, data_date))")
        connection.exec_driver_sql("CREATE TABLE source_snapshot_head (source_id TEXT PRIMARY KEY, publication_id BLOB, changed_at TEXT DEFAULT CURRENT_TIMESTAMP)")
        connection.execute(text("INSERT INTO source_daily_head (source_id, data_date, publication_id) VALUES ('collection_monitoring', '2026-10-01', :old), ('collection_monitoring', '2026-10-02', :old)"), {"old": b"o" * 16})
        connection.execute(text("INSERT INTO source_snapshot_head (source_id, publication_id) VALUES ('no_movement', :old)"), {"old": b"o" * 16})

    @event.listens_for(engine, "before_cursor_execute", retval=True)
    def adapt_mysql_upsert(_connection, _cursor, statement, parameters, _context, _executemany):
        statement = statement.replace("CURRENT_TIMESTAMP(6)", "CURRENT_TIMESTAMP")
        if "ON DUPLICATE KEY UPDATE" in statement and "source_daily_head" in statement:
            statement = statement.replace(
                "ON DUPLICATE KEY UPDATE\n              publication_id = VALUES(publication_id),\n              changed_at = CURRENT_TIMESTAMP",
                "ON CONFLICT(source_id, data_date) DO UPDATE SET publication_id = excluded.publication_id, changed_at = CURRENT_TIMESTAMP",
            )
        if "ON DUPLICATE KEY UPDATE" in statement and "source_snapshot_head" in statement:
            statement = statement.replace(
                "ON DUPLICATE KEY UPDATE\n              publication_id = VALUES(publication_id),\n              changed_at = CURRENT_TIMESTAMP",
                "ON CONFLICT(source_id) DO UPDATE SET publication_id = excluded.publication_id, changed_at = CURRENT_TIMESTAMP",
            )
        return statement, parameters

    try:
        with engine.begin() as connection:
            _switch_heads(
                connection,
                source_id="collection_monitoring",
                publication_id=b"n" * 16,
                summary=SimpleNamespace(per_date_counts={"2026-10-02": 3, "2026-10-03": 4}),
            )
            _switch_heads(
                connection,
                source_id="no_movement",
                publication_id=b"n" * 16,
                summary=SimpleNamespace(per_date_counts={}),
            )
        with engine.connect() as connection:
            daily = connection.execute(text("SELECT data_date, publication_id FROM source_daily_head ORDER BY data_date")).all()
            snapshot = connection.execute(text("SELECT publication_id FROM source_snapshot_head WHERE source_id = 'no_movement'")).scalar_one()
        assert [(str(row.data_date), row.publication_id) for row in daily] == [
            ("2026-10-01", b"o" * 16),
            ("2026-10-02", b"n" * 16),
            ("2026-10-03", b"n" * 16),
        ]
        assert snapshot == b"n" * 16
    finally:
        engine.dispose()


def test_central_mapping_resolution_uses_unique_official_names_and_keeps_every_fact_row():
    sqlite3.register_adapter(Decimal, str)
    sqlite3.register_adapter(date, lambda value: value.isoformat())
    sqlite3.register_adapter(datetime, lambda value: value.isoformat(sep=" "))
    engine = create_engine("sqlite://")
    _create_query_schema(engine)
    publication_id = uuid.uuid5(uuid.NAMESPACE_URL, "mapping-resolution:monitoring").bytes
    snapshot_id = uuid.uuid5(uuid.NAMESPACE_URL, "mapping-resolution:no-movement").bytes
    try:
        with engine.begin() as connection:
            mapping_entries = [
                ("RS-001", "Base Rio RS", "SR", "RS", "SR-RS", "周正军 Zhengjun Zhou (Victor)"),
                ("SC-001", "Base Santa Catarina", "SR", "SC", "SR-SC", "樊善方 Shanfang Fan (Sean Fan)"),
                ("PR-CWB", "Base Curitiba", "PR", "PR", "PR-CWB", "Diego Souza Braga Da Silva"),
                ("PENDING-1", "Base Pending", "PR", "PR", "PR-CWB", "Diego Souza Braga Da Silva"),
                ("DUP-1", "Base Duplicada", "SR", "RS", "SR-RS", "Victor"),
                ("DUP-2", "Base Duplicada", "PR", "PR", "PR-CWB", "Diego"),
            ]
            for code, name, region, uf, rm_area, rm in mapping_entries:
                connection.execute(text("""
                    INSERT INTO base_mapping_entries
                      (map_version_id, base_code, base_name, regional_name, uf_code, rm_region, rm_responsible)
                    VALUES (:map_id, :code, :name, :region, :uf, :rm_area, :rm)
                """), {
                    "map_id": MAP_VERSION_ID, "code": code, "name": name,
                    "region": region, "uf": uf, "rm_area": rm_area, "rm": rm,
                })
            connection.execute(text("""
                INSERT INTO source_publications
                  (publication_id, source_id, contract_version, version_no, published_at, publication_state)
                VALUES (:publication_id, 'collection_monitoring', 1, 1, '2026-10-05', 'PUBLISHED')
            """), {"publication_id": publication_id})
            connection.execute(text("""
                INSERT INTO source_daily_head (source_id, data_date, publication_id)
                VALUES ('collection_monitoring', '2026-10-05', :publication_id)
            """), {"publication_id": publication_id})

            names = [
                "Base Rio RS",
                "  BASE\tSANTA   CATARINA  ",
                "Base Duplicada",
                "Base Pending",
                None,
                "Fonte Nova",
            ]
            for row_no, name in enumerate(names, start=1):
                connection.execute(text("""
                    INSERT INTO fact_collection_monitoring
                      (source_id, publication_id, map_version_id, source_row_no,
                       data_date, reported_region, source_base_name,
                       expected_dropoff_collection, expected_pickup_collection,
                       resolved_base_code, mapping_resolution)
                    VALUES
                      ('collection_monitoring', :publication_id, :map_id, :row_no,
                       '2026-10-05', 'PR', :name, :dropoff, :pickup, NULL, :resolution)
                """), {
                    "publication_id": publication_id,
                    "map_id": MAP_VERSION_ID,
                    "row_no": row_no,
                    "name": name,
                    "dropoff": row_no * 10,
                    "pickup": row_no,
                    "resolution": "MISSING_IDENTIFIER" if name is None else "UNMAPPED",
                })

            connection.execute(text("""
                INSERT INTO source_publications
                  (publication_id, source_id, contract_version, version_no, published_at, publication_state)
                VALUES (:publication_id, 'no_movement', 2, 1, '2026-10-05', 'PUBLISHED')
            """), {"publication_id": snapshot_id})
            connection.execute(text("""
                INSERT INTO source_snapshot_head (source_id, publication_id)
                VALUES ('no_movement', :publication_id)
            """), {"publication_id": snapshot_id})
            connection.execute(text("""
                INSERT INTO fact_no_movement_snapshot
                  (source_id, publication_id, map_version_id, source_row_no,
                   reported_region, source_base_code, source_base_name,
                   resolved_base_code, mapping_resolution)
                VALUES
                  ('no_movement', :publication_id, :map_id, 1,
                   'SR', 'PR-CWB', 'Base Rio RS', NULL, 'UNMAPPED'),
                  ('no_movement', :publication_id, :map_id, 2,
                   'PR', NULL, 'Base Santa Catarina', NULL, 'UNMAPPED'),
                  ('no_movement', :publication_id, :map_id, 3,
                   'SR', 'INVALID-CODE', 'Base Santa Catarina', NULL, 'UNMAPPED')
            """), {"publication_id": snapshot_id, "map_id": MAP_VERSION_ID})

        records = get_records(
            engine,
            source_id="collection_monitoring",
            identity=ADMIN_MATRIX,
            limit=250,
            offset=0,
            date_from=date(2026, 10, 5),
            date_to=date(2026, 10, 5),
        )
        assert records["total"] == 6
        assert len(records["records"]) == 6
        assert [row["source_row_no"] for row in records["records"]] == [1, 2, 3, 4, 5, 6]
        by_row = {row["source_row_no"]: row for row in records["records"]}
        assert by_row[1]["effective_base_code"] == "RS-001"
        assert by_row[1]["effective_mapping_resolution"] == "NAME_APPROVED"
        assert by_row[1]["mapping_match_method"] == "EXACT_NAME"
        assert by_row[1]["mapped_region"] == "SR"
        assert by_row[1]["mapped_uf"] == "RS"
        assert by_row[1]["mapped_rm_area"] == "SR-RS"
        assert by_row[1]["reported_region"] == "PR"
        assert by_row[2]["effective_base_code"] == "SC-001"
        assert by_row[2]["mapping_match_method"] == "NORMALIZED_NAME"
        assert by_row[2]["mapped_region"] == "SR"
        assert by_row[2]["mapped_uf"] == "SC"
        assert by_row[3]["effective_mapping_resolution"] == "AMBIGUOUS"
        assert by_row[3]["effective_base_code"] is None
        assert by_row[4]["effective_mapping_resolution"] == "NAME_APPROVED"
        assert by_row[4]["effective_base_code"] == "PENDING-1"
        assert by_row[4]["mapped_region"] == "PR"
        assert by_row[5]["effective_mapping_resolution"] == "MISSING_IDENTIFIER"
        assert by_row[6]["effective_mapping_resolution"] == "UNMAPPED"
        assert sum(
            int(row["expected_dropoff_collection"]) + int(row["expected_pickup_collection"])
            for row in records["records"]
        ) == 231

        regional = get_records(
            engine, source_id="collection_monitoring", identity=ADMIN_MATRIX,
            limit=250, offset=0, region="SR",
        )
        assert regional["total"] == 2
        assert {row["source_row_no"] for row in regional["records"]} == {1, 2}
        unassigned = get_records(
            engine, source_id="collection_monitoring", identity=ADMIN_MATRIX,
            limit=250, offset=0, region="Sem regional",
        )
        assert unassigned["total"] == 3
        assert {row["source_row_no"] for row in unassigned["records"]} == {3, 5, 6}
        base = get_records(
            engine, source_id="collection_monitoring", identity=ADMIN_MATRIX,
            limit=250, offset=0, base_code="SC-001",
        )
        assert base["total"] == 1
        assert base["records"][0]["source_row_no"] == 2

        snapshot_rows = get_records(
            engine, source_id="no_movement", identity=ADMIN_MATRIX,
            limit=250, offset=0,
        )["records"]
        assert len(snapshot_rows) == 3
        code_match, name_match, invalid_code = snapshot_rows
        assert code_match["effective_base_code"] == "PR-CWB"
        assert code_match["effective_mapping_resolution"] == "CODE_MATCH"
        assert code_match["mapped_region"] == "PR"
        assert code_match["mapped_uf"] == "PR"
        assert code_match["mapped_rm_area"] == "PR-CWB"
        assert name_match["effective_base_code"] == "SC-001"
        assert name_match["effective_mapping_resolution"] == "NAME_APPROVED"
        assert name_match["mapped_region"] == "SR"
        assert name_match["mapped_uf"] == "SC"
        assert name_match["mapped_rm_area"] == "SR-SC"
        assert invalid_code["effective_mapping_resolution"] == "UNMAPPED"
        assert invalid_code["effective_base_code"] is None
        assert invalid_code["mapped_region"] is None
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("source_id", "source_code", "source_name", "expected_code", "expected_resolution", "expected_region"),
    [
        ("collection_monitoring", None, "Base Rio RS", "RS-001", "NAME_APPROVED", "SR"),
        ("collection_rate", None, "  BASE\tSANTA   CATARINA  ", "SC-001", "NAME_APPROVED", "SR"),
        ("jt_monitoring", None, "Base Duplicada", None, "AMBIGUOUS", None),
        ("no_movement", "PR-CWB", "Base Rio RS", "PR-CWB", "CODE_MATCH", "PR"),
        ("pdd_collection_failure", "INVALID-CODE", "Base Santa Catarina", None, "UNMAPPED", None),
        ("pdd_collection_failure", None, "Base Santa Catarina", "SC-001", "NAME_APPROVED", "SR"),
    ],
)
def test_shared_published_map_query_for_all_five_sources(
    source_id, source_code, source_name, expected_code, expected_resolution, expected_region
):
    engine = create_engine("sqlite://")
    _create_query_schema(engine)
    try:
        with engine.begin() as connection:
            additional_entries = [
                ("RS-001", "Base Rio RS", "SR", "RS", "SR-RS", "Victor"),
                ("SC-001", "Base Santa Catarina", "SR", "SC", "SR-SC", "Sean Fan"),
                ("PR-CWB", "Base Curitiba", "PR", "PR", "PR-CWB", "Diego"),
                ("DUP-1", "Base Duplicada", "SR", "RS", "SR-RS", "Victor"),
                ("DUP-2", "Base Duplicada", "PR", "PR", "PR-CWB", "Diego"),
            ]
            for code, name, region, uf, rm_area, rm in additional_entries:
                connection.execute(text("""
                    INSERT INTO base_mapping_entries
                      (map_version_id, base_code, base_name, regional_name, uf_code, rm_region, rm_responsible)
                    VALUES (:map_id, :code, :name, :region, :uf, :rm_area, :rm)
                """), {
                    "map_id": MAP_VERSION_ID, "code": code, "name": name,
                    "region": region, "uf": uf, "rm_area": rm_area, "rm": rm,
                })

            contract = CONTRACTS[source_id]
            column_keys = {column.key for column in contract.columns}
            fact_columns = ["source_id", "publication_id", "map_version_id", "source_row_no", "resolved_base_code", "mapping_resolution"]
            values = {
                "source_id": source_id,
                "publication_id": b"x" * 16,
                "map_version_id": MAP_VERSION_ID,
                "source_row_no": 1,
                "resolved_base_code": None,
                "mapping_resolution": "UNMAPPED",
            }
            if "source_base_code" in column_keys:
                fact_columns.append("source_base_code")
                values["source_base_code"] = source_code
            if "source_base_name" in column_keys:
                fact_columns.append("source_base_name")
                values["source_base_name"] = source_name
            table = FACT_TABLES[source_id]
            insert_sql = (
                f"INSERT INTO `{table}` ({', '.join(f'`{column}`' for column in fact_columns)}) "
                f"VALUES ({', '.join(f':{column}' for column in fact_columns)})"
            )
            connection.execute(text(insert_sql), values)

        mapping_query = build_mapping_query(
            source_id=source_id,
            has_source_base_code="source_base_code" in column_keys,
            has_source_base_name="source_base_name" in column_keys,
            dialect="sqlite",
        )
        with engine.connect() as connection:
            rows = connection.execute(text(f"""
                SELECT fact.source_row_no,
                       {mapping_query.effective_base_code_sql} AS effective_base_code,
                       {mapping_query.effective_resolution_sql} AS effective_mapping_resolution,
                       effective_entry.regional_name AS mapped_region,
                       fact.source_base_name AS source_base_name
                FROM `{table}` AS fact
                JOIN base_mapping_current AS current_map
                  ON current_map.current_key = 'OFFICIAL'
                {mapping_query.joins}
            """), {"source_id": source_id}).mappings().all()

        assert len(rows) == 1
        assert rows[0]["source_row_no"] == 1
        assert rows[0]["source_base_name"] == source_name
        assert rows[0]["effective_base_code"] == expected_code
        assert rows[0]["effective_mapping_resolution"] == expected_resolution
        assert rows[0]["mapped_region"] == expected_region
    finally:
        engine.dispose()


def test_normalized_unique_name_resolves_automatically_and_ambiguity_stays_unmapped():
    normalized_resolver = MappingResolver(
        map_version_id=MAP_VERSION_ID,
        normalized_base_name_candidates={
            "base santa catarina": ("SC-001",),
            "base duplicada": ("DUP-001", "DUP-002"),
        },
        normalized_name_decisions={
            "base santa catarina": ("LINKED", "SC-001"),
        },
    )
    assert _resolve_mapping(
        "collection_monitoring",
        {"source_base_name": "  BASE\tSANTA   CATARINA  "},
        MappingResolver(
            map_version_id=MAP_VERSION_ID,
            normalized_base_name_candidates={"base santa catarina": ("SC-001",)},
        ),
    ) == ("SC-001", "NAME_APPROVED")
    assert _resolve_mapping(
        "collection_monitoring",
        {"source_base_name": "base duplicada"},
        normalized_resolver,
    ) == (None, "AMBIGUOUS")

    unapproved_resolver = MappingResolver(
        map_version_id=MAP_VERSION_ID,
        normalized_base_name_candidates={"base pending": ("BASE-001",)},
    )
    assert _resolve_mapping(
        "collection_monitoring",
        {"source_base_name": " BASE   PENDING "},
        unapproved_resolver,
    ) == ("BASE-001", "NAME_APPROVED")
    assert _persisted_mapping_resolution(
        "collection_monitoring", "UNAPPROVED_NORMALIZED_NAME"
    ) == "UNMAPPED"


def test_collection_rate_v3_name_mapping_and_feishu_scope_use_official_region_only():
    engine = create_engine("sqlite://")
    _create_query_schema(engine)
    data_day = date(2026, 10, 13)
    publication_id = uuid.uuid5(uuid.NAMESPACE_URL, "collection-rate-v3-name-scope").bytes
    try:
        with engine.begin() as connection:
            for code, name, region in (
                ("EXACT-001", "Base Exata", "SPE"),
                ("NORMALIZED-001", "Base Normalizada", "CE"),
                ("AMBIGUOUS-001", "Base Ambígua", "SPE"),
                ("AMBIGUOUS-002", "Base Ambígua", "CE"),
            ):
                connection.execute(text("""
                    INSERT INTO base_mapping_entries
                      (map_version_id, base_code, base_name, regional_name, uf_code, rm_region, rm_responsible)
                    VALUES (:map_id, :code, :name, :region, :region, :rm_area, :rm)
                """), {
                    "map_id": MAP_VERSION_ID,
                    "code": code,
                    "name": name,
                    "region": region,
                    "rm_area": f"{region}-RM",
                    "rm": f"{region} RGM",
                })
            connection.execute(text("""
                INSERT INTO source_publications
                  (publication_id, source_id, contract_version, version_no, published_at, snapshot_as_of, publication_state)
                VALUES (:publication_id, 'collection_rate', 3, 1, '2026-10-14 10:00:00', '2026-10-14 09:00:00', 'PUBLISHED')
            """), {"publication_id": publication_id})
            connection.execute(text("""
                INSERT INTO source_publication_dates
                  (source_id, publication_id, data_date, row_count)
                VALUES ('collection_rate', :publication_id, :data_day, 5)
            """), {"publication_id": publication_id, "data_day": data_day})
            connection.execute(text("""
                INSERT INTO source_daily_head (source_id, data_date, publication_id)
                VALUES ('collection_rate', :data_day, :publication_id)
            """), {"publication_id": publication_id, "data_day": data_day})

            contract = CONTRACT_VERSIONS[("collection_rate", 3)]
            source_rows = (
                ("Base Exata", "CE"),
                ("  BASE\tNORMALIZADA  ", "SPE"),
                ("Base Ambígua", "SPE"),
                ("Nome inexistente", "CE"),
                (None, "CE"),
            )
            for row_no, (base_name, reported_region) in enumerate(source_rows, start=1):
                values = {}
                for column in contract.columns:
                    if column.key == "deadline_at":
                        value = datetime(2026, 10, 13, 9, 0)
                    elif column.key == "source_base_name":
                        value = base_name
                    elif column.key == "reported_region":
                        value = reported_region
                    elif column.kind == "INTEGER":
                        value = row_no
                    elif column.kind == "DECIMAL":
                        value = "0.5"
                    elif column.nullable:
                        value = None
                    else:
                        value = f"{column.key}-{row_no}"
                    values[column.key] = value
                columns = [
                    "source_id", "publication_id", "map_version_id", "source_row_no",
                    *(column.key for column in contract.columns),
                    "resolved_base_code", "mapping_resolution",
                ]
                payload = {
                    "source_id": "collection_rate",
                    "publication_id": publication_id,
                    "map_version_id": MAP_VERSION_ID,
                    "source_row_no": row_no,
                    **values,
                    "resolved_base_code": None,
                    "mapping_resolution": "MISSING_IDENTIFIER" if base_name is None else "UNMAPPED",
                }
                connection.execute(text(
                    f"INSERT INTO fact_collection_rate_v3 ({', '.join(chr(34) + column + chr(34) for column in columns)}) "
                    f"VALUES ({', '.join(':' + column for column in columns)})"
                ), payload)

        national = get_records(
            engine,
            source_id="collection_rate",
            identity=ADMIN_MATRIX,
            limit=250,
            offset=0,
            date_from=data_day,
            date_to=data_day,
            contract_version=3,
        )
        assert national["total"] == 5
        rows = {row["source_row_no"]: row for row in national["records"]}
        assert rows[1]["effective_base_code"] == "EXACT-001"
        assert rows[1]["effective_mapping_resolution"] == "NAME_APPROVED"
        assert rows[1]["mapping_match_method"] == "EXACT_NAME"
        assert rows[1]["mapped_region"] == "SPE"
        assert rows[1]["reported_region"] == "CE"
        assert rows[2]["effective_base_code"] == "NORMALIZED-001"
        assert rows[2]["mapping_match_method"] == "NORMALIZED_NAME"
        assert rows[2]["mapped_region"] == "CE"
        assert rows[2]["reported_region"] == "SPE"
        assert rows[3]["effective_mapping_resolution"] == "AMBIGUOUS"
        assert rows[3]["effective_base_code"] is None
        assert rows[3]["mapped_region"] is None
        assert rows[4]["effective_mapping_resolution"] == "UNMAPPED"
        assert rows[4]["effective_base_code"] is None
        assert rows[5]["effective_mapping_resolution"] == "MISSING_IDENTIFIER"
        assert rows[5]["mapped_region"] is None

        regional_ce = get_records(
            engine,
            source_id="collection_rate",
            identity={
                "platform_role": "USER",
                "organizational_scope": "regional",
                "home_region": "CE",
                "role": "regional",
            },
            limit=250,
            offset=0,
            date_from=data_day,
            date_to=data_day,
            contract_version=3,
        )
        assert regional_ce["total"] == 1
        assert regional_ce["records"][0]["source_row_no"] == 2
        assert regional_ce["records"][0]["mapped_region"] == "CE"

        regional_spe = get_records(
            engine,
            source_id="collection_rate",
            identity={
                "platform_role": "USER",
                "organizational_scope": "regional",
                "home_region": "SPE",
                "role": "regional",
            },
            limit=250,
            offset=0,
            date_from=data_day,
            date_to=data_day,
            contract_version=3,
        )
        assert regional_spe["total"] == 1
        assert regional_spe["records"][0]["source_row_no"] == 1
        assert regional_spe["records"][0]["mapped_region"] == "SPE"
    finally:
        engine.dispose()