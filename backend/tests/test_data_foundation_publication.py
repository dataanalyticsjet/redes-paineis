from __future__ import annotations

import os
import re
import sqlite3
import zipfile
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

import pytest
from sqlalchemy import create_engine, event, text

from app.services.data_foundation.contracts import CONTRACTS, contract_sha256
from app.services.data_foundation.queries import get_current_mapping_status
from app.services.data_foundation import repository as data_foundation_repository
from app.services.data_foundation.repository import (
    DataFoundationError,
    FACT_TABLES,
    create_preview_job,
    get_name_mapping_candidates,
    load_mapping_resolver,
    publish_import_job,
    publish_initial_mapping_migration,
    record_name_mapping_decision,
    save_uploaded_workbook,
    validate_job_again,
)
from app.services.data_foundation.xlsx_parser import MappingResolver, parse_workbook


OFFICIAL_WORKBOOK_ROOT = Path(os.environ.get(
    "DATA_FOUNDATION_REVIEW_WORKBOOKS",
    "/home/phelippecardoso/RedesPaineis-DataFoundationV2-Review-2026-10-09/planilhas",
))


def _sqlite_schema(engine) -> None:
    statements = [
        """CREATE TABLE data_source_registry (
            source_id TEXT PRIMARY KEY, display_name TEXT, description TEXT,
            source_state TEXT, history_policy TEXT)""",
        """CREATE TABLE source_contract_versions (
            source_id TEXT, contract_version INTEGER, contract_state TEXT,
            expected_sheet TEXT, header_row INTEGER, history_policy TEXT,
            contract_sha256 BLOB, PRIMARY KEY(source_id, contract_version))""",
        """CREATE TABLE import_jobs (
            job_id BLOB PRIMARY KEY, source_id TEXT, contract_version INTEGER,
            validation_map_version_id BLOB, reused_publication_id BLOB,
            submitted_by_user_id INTEGER, job_state TEXT, original_file_name TEXT,
            stored_file_key TEXT, file_size_bytes INTEGER, file_sha256 BLOB,
            input_row_count INTEGER, valid_row_count INTEGER, error_count INTEGER,
            request_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            validated_at TEXT, finished_at TEXT)""",
        """CREATE TABLE import_job_errors (
            error_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id BLOB,
            source_row_no INTEGER, column_key TEXT, error_code TEXT,
            safe_context TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)""",
        """CREATE TABLE base_mapping_versions (
            map_version_id BLOB PRIMARY KEY, version_no INTEGER UNIQUE,
            source_id TEXT, source_job_id BLOB, contract_version INTEGER,
            version_state TEXT, original_file_name TEXT, file_sha256 BLOB,
            mapping_row_count INTEGER, published_by_user_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, published_at TEXT)""",
        """CREATE TABLE base_mapping_entries (
            map_version_id BLOB, base_code TEXT, base_name TEXT, regional_name TEXT,
            uf_code TEXT, rm_region TEXT, rm_responsible TEXT, base_description TEXT,
            source_row_no INTEGER, PRIMARY KEY(map_version_id, base_code))""",
        """CREATE TABLE base_mapping_name_decisions (
            map_version_id BLOB, source_id TEXT, source_base_name TEXT,
            resolution_state TEXT, target_base_code TEXT, reviewed_by_user_id INTEGER,
            reviewed_at TEXT, review_note TEXT,
            PRIMARY KEY(map_version_id, source_id, source_base_name))""",
        """CREATE TABLE base_mapping_current (
            current_key TEXT PRIMARY KEY, map_version_id BLOB,
            changed_by_user_id INTEGER, changed_at TEXT DEFAULT CURRENT_TIMESTAMP)""",
        """CREATE TABLE source_publications (
            publication_id BLOB PRIMARY KEY, source_id TEXT, version_no INTEGER,
            job_id BLOB, contract_version INTEGER, map_version_id BLOB,
            file_sha256 BLOB, publication_state TEXT, history_policy TEXT,
            period_start DATE, period_end DATE, snapshot_as_of TEXT,
            row_count INTEGER, mapped_row_count INTEGER, unmapped_row_count INTEGER,
            missing_identifier_row_count INTEGER, ambiguous_row_count INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, published_at TEXT,
            UNIQUE(source_id, version_no),
            UNIQUE(source_id, contract_version, map_version_id, file_sha256))""",
        """CREATE TABLE source_publication_dates (
            source_id TEXT, publication_id BLOB, data_date DATE, row_count INTEGER,
            PRIMARY KEY(source_id, publication_id, data_date))""",
        """CREATE TABLE source_daily_head (
            source_id TEXT, data_date DATE, publication_id BLOB,
            changed_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source_id, data_date))""",
        """CREATE TABLE source_snapshot_head (
            source_id TEXT PRIMARY KEY, publication_id BLOB,
            changed_at TEXT DEFAULT CURRENT_TIMESTAMP)""",
        """CREATE TABLE data_audit_events (
            audit_id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER,
            action_code TEXT, object_type TEXT, object_id BLOB, request_id TEXT,
            event_context TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)""",
    ]
    for source_id, table_name in FACT_TABLES.items():
        contract = CONTRACTS[source_id]
        sql_types = {
            "DATE": "DATE",
            "DATETIME": "DATETIME",
            "BASE_CODE": "TEXT",
            "TEXT": "TEXT",
            "INTEGER": "INTEGER",
            "DECIMAL": "NUMERIC",
        }
        columns = [
            "source_id TEXT",
            "publication_id BLOB",
            "map_version_id BLOB",
            "source_row_no INTEGER",
            *[
                f"`{column.key}` {sql_types[column.kind]}"
                for column in contract.columns
            ],
            "resolved_base_code TEXT",
            "mapping_resolution TEXT",
            "PRIMARY KEY(publication_id, source_row_no)",
        ]
        statements.append(f"CREATE TABLE {table_name} ({', '.join(columns)})")

    with engine.begin() as connection:
        for statement in statements:
            connection.exec_driver_sql(statement)
        for source_id in ("base_mapping_official", *FACT_TABLES):
            contract = CONTRACTS[source_id]
            connection.execute(text("""
                INSERT INTO data_source_registry
                  (source_id, display_name, description, source_state, history_policy)
                VALUES (:source_id, :name, 'isolated publication test', 'ACTIVE', :policy)
            """), {
                "source_id": source_id,
                "name": contract.display_name,
                "policy": contract.history_policy,
            })
            connection.execute(text("""
                INSERT INTO source_contract_versions
                  (source_id, contract_version, contract_state, expected_sheet,
                   header_row, history_policy, contract_sha256)
                VALUES (:source_id, :version, 'APPROVED', :sheet, :header_row,
                        :policy, :contract_hash)
            """), {
                "source_id": source_id,
                "version": contract.version,
                "sheet": contract.sheet_name,
                "header_row": contract.header_row,
                "policy": contract.history_policy,
                "contract_hash": contract_sha256(contract),
            })


def _sql_compatibility_for_sqlite(engine) -> None:
    @event.listens_for(engine, "before_cursor_execute", retval=True)
    def translate(connection, cursor, statement, parameters, context, executemany):
        statement = statement.replace(" FOR UPDATE", "").replace("CURRENT_TIMESTAMP(6)", "CURRENT_TIMESTAMP")
        statement = re.sub(r"\bBINARY\s+", "", statement)
        if "ON DUPLICATE KEY UPDATE" in statement and "source_daily_head" in statement:
            statement = re.sub(
                r"ON DUPLICATE KEY UPDATE\s+publication_id = VALUES\(publication_id\),\s*changed_at = CURRENT_TIMESTAMP",
                "ON CONFLICT(source_id, data_date) DO UPDATE SET publication_id = excluded.publication_id, changed_at = CURRENT_TIMESTAMP",
                statement,
            )
        elif "ON DUPLICATE KEY UPDATE" in statement and "source_snapshot_head" in statement:
            statement = re.sub(
                r"ON DUPLICATE KEY UPDATE\s+publication_id = VALUES\(publication_id\),\s*changed_at = CURRENT_TIMESTAMP",
                "ON CONFLICT(source_id) DO UPDATE SET publication_id = excluded.publication_id, changed_at = CURRENT_TIMESTAMP",
                statement,
            )
        return statement, parameters


def _xlsx_bytes(
    contract,
    rows: list[dict[str, object]],
    *,
    execution_overrides: dict[str, object] | None = None,
    dictionary_status: str = "Confirmado",
) -> bytes:
    def column_letters(index: int) -> str:
        result = ""
        while index:
            index, remainder = divmod(index - 1, 26)
            result = chr(65 + remainder) + result
        return result

    def excel_serial(value: date | datetime) -> str:
        parsed = datetime.combine(value, datetime.min.time()) if isinstance(value, date) and not isinstance(value, datetime) else value
        return str((parsed - datetime(1899, 12, 30)).total_seconds() / 86400)

    def make_sheet_xml(
        headers: list[str],
        data_rows: list[dict[str, object]],
        kinds: list[str],
        row_keys: list[str] | None = None,
    ) -> str:
        keys = row_keys or headers
        xml_rows = []
        for row_no in range(1, len(data_rows) + 2):
            values = data_rows[row_no - 2] if row_no > 1 else None
            cells = []
            for index, (header, kind) in enumerate(zip(headers, kinds), start=1):
                value = header if values is None else values.get(keys[index - 1])
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
        return (
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
        )

    if contract.source_id == "no_movement" and contract.version >= 2:
        data_headers = list(contract.headers)
        data_kinds = [column.kind for column in contract.columns]
        execution_headers = [
            "Id da execução", "Data e horário da execução", "Quantidade de registros recebidos",
            "Quantidade de páginas consultadas", "Situação da execução", "Erros", "Data da coleta",
        ]
        execution_row = {
            "Id da execução": "synthetic-execution",
            "Data e horário da execução": datetime(2026, 10, 14, 10, 0),
            "Quantidade de registros recebidos": len(rows),
            "Quantidade de páginas consultadas": 1 if rows else 0,
            "Situação da execução": "SUCESSO",
            "Erros": None,
            "Data da coleta": date(2026, 10, 14),
        }
        execution_row.update(execution_overrides or {})
        dictionary_headers = [
            "Nome original do campo", "Nome exibido no JMS", "Tradução para português", "Status da identificação",
        ]
        dictionary_fields = [
            "scanAgentName", "dutyCode", "dutyName", "total", "halfwayCount", "day1", "day2", "day3",
            "day4", "day5", "day6", "day7", "day10", "day14", "day30", "operateTime", "dayRate14", "dayRate30",
        ]
        dictionary_rows = [
            {
                "Nome original do campo": field,
                "Nome exibido no JMS": field,
                "Tradução para português": field,
                "Status da identificação": dictionary_status,
            }
            for field in dictionary_fields
        ]
        sheets = [
            ("Dados", data_headers, rows, data_kinds, [column.key for column in contract.columns]),
            ("Execucoes", execution_headers, [execution_row], ["TEXT", "DATETIME", "INTEGER", "INTEGER", "TEXT", "TEXT", "DATE"], None),
            ("Dicionario", dictionary_headers, dictionary_rows, ["TEXT"] * 4, None),
        ]
    else:
        headers = list(contract.headers)
        sheets = [(contract.sheet_name, headers, rows, [column.kind for column in contract.columns], [column.key for column in contract.columns])]

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


def _daily_row(
    data_date: date,
    awaiting: int = 1,
    source_base_name: str = "SMD -AC",
) -> dict[str, object]:
    values: dict[str, object] = {
        "data_date": data_date,
        "reported_region": "GP",
        "source_base_name": source_base_name,
        "seller_collection_rate": Decimal("0.5"),
        "collection_visit_rate": Decimal("0.6"),
    }
    for column in CONTRACTS["collection_monitoring"].columns:
        if column.kind == "INTEGER":
            values[column.key] = awaiting
    return values


def _snapshot_row(code: str, name: str) -> dict[str, object]:
    values: dict[str, object] = {
        "reported_region": "GP",
        "source_base_code": code,
        "source_base_name": name,
        "last_operation_at": datetime(2026, 10, 8, 11, 30),
        "stopped_14_plus_days_rate": Decimal("0.1"),
        "stopped_30_plus_days_rate": Decimal("0.05"),
    }
    for column in CONTRACTS["no_movement"].columns:
        if column.kind == "INTEGER":
            values[column.key] = 1
    values["stopped_orders"] = 10
    return values


def test_no_movement_v2_parser_preserves_duplicate_base_codes_at_row_grain():
    contract = CONTRACTS["no_movement"]
    rows = [
        _snapshot_row("DUP-001", "Base duplicada - primeira regional"),
        _snapshot_row("DUP-001", "Base duplicada - segunda regional"),
    ]
    imported = []
    summary = parse_workbook(
        _xlsx_bytes(contract, rows),
        contract,
        MappingResolver(map_version_id=b"0123456789abcdef"),
        on_valid_row=imported.append,
    )

    assert summary.input_row_count == summary.valid_row_count == 2
    assert summary.invalid_row_count == 0
    assert summary.duplicate_base_code_count == 1
    assert summary.exact_duplicate_count == 0
    assert summary.can_publish is True
    assert [row.source_row_no for row in imported] == [2, 3]
    assert {row.values["source_base_code"] for row in imported} == {"DUP-001"}
    assert summary.collection_date == date(2026, 10, 14)
    assert summary.bot_executed_at == datetime(2026, 10, 14, 10, 0)


def test_no_movement_v2_parser_blocks_failed_execution_and_unconfirmed_dictionary():
    contract = CONTRACTS["no_movement"]
    resolver = MappingResolver(map_version_id=b"0123456789abcdef")
    row = _snapshot_row("CODE-001", "Base fictícia")

    failed = parse_workbook(
        _xlsx_bytes(contract, [row], execution_overrides={
            "Situação da execução": "FALHA",
            "Erros": "Falha de consulta",
        }),
        contract,
        resolver,
    )
    assert failed.valid_row_count == 1
    assert failed.can_publish is False
    assert failed.error_counts["no_movement_execution_not_successful"] == 1

    unconfirmed = parse_workbook(
        _xlsx_bytes(contract, [row], dictionary_status="Pendente"),
        contract,
        resolver,
    )
    assert unconfirmed.valid_row_count == 1
    assert unconfirmed.can_publish is False
    assert unconfirmed.error_counts["no_movement_dictionary_invalid"] == 1


def test_no_movement_v2_parser_blocks_execution_count_and_aging_mismatches():
    contract = CONTRACTS["no_movement"]
    resolver = MappingResolver(map_version_id=b"0123456789abcdef")
    row = _snapshot_row("CODE-001", "Base fictícia")
    row["stopped_over_1_day"] = 2

    summary = parse_workbook(
        _xlsx_bytes(contract, [row], execution_overrides={
            "Quantidade de registros recebidos": 2,
        }),
        contract,
        resolver,
    )
    assert summary.input_row_count == 1
    assert summary.valid_row_count == 0
    assert summary.invalid_row_count == 1
    assert summary.error_counts["aging_total_mismatch"] == 1
    assert summary.error_counts["no_movement_execution_row_count_mismatch"] == 1
    assert summary.can_publish is False


def _create_job(engine, content, contract, resolver, staging_directory, file_name):
    summary = parse_workbook(content, contract, resolver)
    assert summary.invalid_row_count == 0
    key = save_uploaded_workbook(staging_directory, content)
    with engine.connect() as connection:
        job_id = create_preview_job(
            connection,
            source_id=contract.source_id,
            actor_user_id=7,
            file_name=file_name,
            file_size=len(content),
            stored_file_key=key,
            summary=summary,
            request_id="sqlite-publication-test",
        )
    return job_id, key, summary


def _create_initial_mapping_job(engine, content, staging_directory):
    contract = CONTRACTS["base_mapping_official"]
    summary = parse_workbook(content, contract, MappingResolver())
    key = save_uploaded_workbook(staging_directory, content)
    with engine.connect() as connection:
        job_id = create_preview_job(
            connection,
            source_id=contract.source_id,
            actor_user_id=7,
            file_name=contract.workbook_name,
            file_size=len(content),
            stored_file_key=key,
            summary=summary,
            request_id="sqlite-mapping-migration-test",
        )
    return job_id, key


def _publish(engine, job_id, staging_directory, key):
    result = publish_import_job(
        engine,
        job_id=job_id,
        actor_user_id=7,
        staging_directory=staging_directory,
        idempotency_key="sqlite-test-idempotency",
        request_id="sqlite-publication-test",
    )
    return result


def test_local_publication_flow_keeps_history_and_replaces_daily_and_snapshot_heads(tmp_path):
    if not OFFICIAL_WORKBOOK_ROOT.is_dir():
        pytest.skip("Set DATA_FOUNDATION_REVIEW_WORKBOOKS to the official workbook review folder")
    sqlite3.register_adapter(Decimal, str)
    sqlite3.register_adapter(date, date.isoformat)
    sqlite3.register_adapter(datetime, datetime.isoformat)
    engine = create_engine("sqlite://")
    _sql_compatibility_for_sqlite(engine)
    _sqlite_schema(engine)
    staging_directory = tmp_path / "private-staging"
    try:
        mapping_path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
        if not mapping_path.is_file():
            pytest.skip("DoomsDay mapping workbook was not found in the review folder")
        mapping_content = mapping_path.read_bytes()
        mapping_job_id, _mapping_key = _create_initial_mapping_job(
            engine, mapping_content, staging_directory
        )
        mapping_idempotency_key = "sqlite-mapping-migration-idempotency"
        migrated = publish_initial_mapping_migration(
            engine,
            job_id=mapping_job_id,
            actor_user_id=7,
            staging_directory=staging_directory,
            idempotency_key=mapping_idempotency_key,
            request_id="sqlite-publication-test",
        )
        replayed_migration = publish_initial_mapping_migration(
            engine,
            job_id=mapping_job_id,
            actor_user_id=7,
            staging_directory=staging_directory,
            idempotency_key=mapping_idempotency_key,
            request_id="sqlite-publication-retry-test",
        )
        assert migrated["reused"] is False
        assert replayed_migration["reused"] is True
        assert replayed_migration["mapVersionId"] == migrated["mapVersionId"]
        assert migrated["version"] == 1
        assert migrated["mappingRowCount"] == 1628
        with pytest.raises(DataFoundationError, match="mapping_migration_idempotency_conflict"):
            publish_initial_mapping_migration(
                engine,
                job_id=mapping_job_id,
                actor_user_id=7,
                staging_directory=staging_directory,
                idempotency_key="different-migration-key",
                request_id="sqlite-publication-conflict-test",
            )
        with engine.connect() as connection:
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_versions"
            )).scalar_one() == 1
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_entries"
            )).scalar_one() == 1628
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_current"
            )).scalar_one() == 1
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_entries WHERE map_version_id = "
                "(SELECT map_version_id FROM base_mapping_current WHERE current_key = 'OFFICIAL')"
            )).scalar_one() == 1628
        matrix_map = get_current_mapping_status(
            engine,
            identity={
                "platform_role": "ADMIN",
                "organizational_scope": "matrix",
                "role": "matrix",
            },
        )
        assert matrix_map["visibleBaseCount"] == 1628
        with pytest.raises(DataFoundationError, match="matrix_scope_required"):
            get_current_mapping_status(
                engine,
                identity={
                    "platform_role": "ADMIN",
                    "organizational_scope": "regional",
                    "role": "regional",
                    "home_region": "__OUT_OF_SCOPE__",
                },
            )

        with engine.connect() as connection:
            unresolved_name_resolver = load_mapping_resolver(
                connection, source_id="collection_monitoring"
            )

        official_content: dict[str, bytes] = {}
        for source_id, contract in CONTRACTS.items():
            if source_id == "base_mapping_official":
                continue
            source_path = OFFICIAL_WORKBOOK_ROOT / contract.workbook_name
            assert source_path.is_file(), f"Official workbook missing: {source_path.name}"
            official_content[source_id] = source_path.read_bytes()

        collection_job, collection_key, collection_summary = _create_job(
            engine,
            official_content["collection_monitoring"],
            CONTRACTS["collection_monitoring"],
            unresolved_name_resolver,
            staging_directory,
            CONTRACTS["collection_monitoring"].workbook_name,
        )
        candidate_report = get_name_mapping_candidates(
            engine,
            job_id=collection_job,
            actor_user_id=7,
            staging_directory=staging_directory,
        )
        assert candidate_report["candidateNameCount"] == 925
        exact_source_name = next(
            item for item in candidate_report["candidates"]
            if item["decisionState"] == "AUTO_MATCH"
            and len(item["exactTargetCandidates"]) == 1
        )
        target_code = exact_source_name["exactTargetCandidates"][0]["baseCode"]
        assert exact_source_name["approvedTargetBaseCode"] == target_code
        validated = validate_job_again(
            engine,
            job_id=collection_job,
            actor_user_id=7,
            staging_directory=staging_directory,
        )
        assert validated["mappedRowCount"] > 0
        assert validated["unmappedRowCount"] > 0
        collection_v1 = _publish(engine, collection_job, staging_directory, collection_key)

        publications = {"collection_monitoring": collection_v1}
        summaries = {"collection_monitoring": collection_summary}
        for source_id in (
            "collection_rate", "jt_monitoring", "no_movement", "pdd_collection_failure"
        ):
            contract = CONTRACTS[source_id]
            with engine.connect() as connection:
                resolver = load_mapping_resolver(connection, source_id=source_id)
            job_id, key, summary = _create_job(
                engine,
                official_content[source_id],
                contract,
                resolver,
                staging_directory,
                contract.workbook_name,
            )
            publication = _publish(engine, job_id, staging_directory, key)
            assert publication["version"] == 1
            publications[source_id] = publication
            summaries[source_id] = summary

        assert summaries["collection_monitoring"].exact_duplicate_count == 0
        assert summaries["collection_rate"].mapped_row_count > 0
        assert summaries["collection_rate"].exact_name_candidate_row_count > 0
        assert summaries["collection_rate"].no_mapping_match_row_count > 0
        assert summaries["jt_monitoring"].exact_duplicate_count == 4
        assert summaries["jt_monitoring"].mapped_row_count > 0
        assert summaries["no_movement"].mapped_row_count == 141
        assert summaries["no_movement"].unmapped_row_count == 10
        assert summaries["pdd_collection_failure"].mapped_row_count == 1598
        assert summaries["pdd_collection_failure"].unmapped_row_count == 19

        replacement_date = date.fromisoformat(
            sorted(summaries["collection_monitoring"].per_date_counts)[0]
        )
        partial_daily = _xlsx_bytes(CONTRACTS["collection_monitoring"], [
            _daily_row(
                replacement_date,
                awaiting=4,
                source_base_name=str(exact_source_name["sourceBaseName"]),
            ),
        ])
        with engine.connect() as connection:
            resolver = load_mapping_resolver(connection, source_id="collection_monitoring")
        second_job, second_key, _ = _create_job(
            engine, partial_daily, CONTRACTS["collection_monitoring"], resolver,
            staging_directory, "daily-v2-partial.xlsx",
        )
        second_publication = _publish(engine, second_job, staging_directory, second_key)
        assert second_publication["version"] == 2

        with engine.connect() as connection:
            daily_heads = {
                row["data_date"]: bytes(row["publication_id"])
                for row in connection.execute(text("""
                    SELECT data_date, publication_id FROM source_daily_head
                    WHERE source_id = 'collection_monitoring'
                """)).mappings()
            }
            assert daily_heads == {
                day: (
                    bytes.fromhex(second_publication["publicationId"].replace("-", ""))
                    if day == replacement_date.isoformat()
                    else bytes.fromhex(collection_v1["publicationId"].replace("-", ""))
                )
                for day in summaries["collection_monitoring"].per_date_counts
            }
            assert connection.execute(text(
                "SELECT COUNT(*) FROM fact_collection_monitoring"
            )).scalar_one() == 3878
            assert connection.execute(text(
                "SELECT COUNT(*) FROM source_publications WHERE source_id = 'collection_monitoring'"
            )).scalar_one() == 2
            assert connection.execute(text("""
                SELECT COUNT(*) FROM fact_collection_monitoring
                WHERE mapping_resolution = 'NAME_APPROVED'
            """)).scalar_one() == validated["mappedRowCount"] + 1
            assert connection.execute(text(
                "SELECT COUNT(*) FROM fact_jt_monitoring"
            )).scalar_one() == 159666
            assert connection.execute(text(
                "SELECT COUNT(*) FROM fact_pdd_collection_failure"
            )).scalar_one() == 1617

        duplicate_job, duplicate_key, _ = _create_job(
            engine, partial_daily, CONTRACTS["collection_monitoring"], resolver,
            staging_directory, "daily-v2-retry.xlsx",
        )
        reused = _publish(engine, duplicate_job, staging_directory, duplicate_key)
        assert reused["reused"] is True
        assert reused["publicationId"] == second_publication["publicationId"]

        second_snapshot = _xlsx_bytes(CONTRACTS["no_movement"], [
            _snapshot_row("868101", "SMD -AC"),
        ])
        snapshot_resolver = load_mapping_resolver_from_engine(engine)
        snapshot_job_2, snapshot_key_2, _ = _create_job(
            engine, second_snapshot, CONTRACTS["no_movement"], snapshot_resolver,
            staging_directory, "snapshot-v2.xlsx",
        )
        snapshot_v2 = _publish(engine, snapshot_job_2, staging_directory, snapshot_key_2)
        assert snapshot_v2["version"] == 2
        with engine.connect() as connection:
            snapshot_head = connection.execute(text("""
                SELECT publication_id FROM source_snapshot_head WHERE source_id = 'no_movement'
            """)).scalar_one()
            assert bytes(snapshot_head) == bytes.fromhex(snapshot_v2["publicationId"].replace("-", ""))
            assert connection.execute(text(
                "SELECT COUNT(*) FROM fact_no_movement_snapshot"
            )).scalar_one() == 152
            assert connection.execute(text(
                "SELECT COUNT(*) FROM source_publications WHERE source_id = 'no_movement'"
            )).scalar_one() == 2
            assert bytes(snapshot_head) != bytes.fromhex(publications["no_movement"]["publicationId"].replace("-", ""))
    finally:
        engine.dispose()


def test_initial_mapping_migration_requires_active_source_and_approved_contract(tmp_path):
    if not OFFICIAL_WORKBOOK_ROOT.is_dir():
        pytest.skip("Set DATA_FOUNDATION_REVIEW_WORKBOOKS to the official workbook review folder")
    mapping_path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
    if not mapping_path.is_file():
        pytest.skip("DoomsDay mapping workbook was not found in the review folder")

    engine = create_engine("sqlite://")
    _sql_compatibility_for_sqlite(engine)
    _sqlite_schema(engine)
    try:
        with engine.begin() as connection:
            connection.execute(text("""
                UPDATE data_source_registry SET source_state = 'PENDING'
                WHERE source_id = 'base_mapping_official'
            """))
            connection.execute(text("""
                UPDATE source_contract_versions SET contract_state = 'DISCOVERED'
                WHERE source_id = 'base_mapping_official' AND contract_version = 1
            """))
        staging_directory = tmp_path / "private-staging"
        job_id, _key = _create_initial_mapping_job(
            engine, mapping_path.read_bytes(), staging_directory
        )

        with pytest.raises(DataFoundationError, match="base_mapping_source_not_active"):
            publish_initial_mapping_migration(
                engine,
                job_id=job_id,
                actor_user_id=7,
                staging_directory=staging_directory,
                idempotency_key="sqlite-mapping-approval-test",
                request_id="sqlite-mapping-approval-test",
            )
        with engine.begin() as connection:
            connection.execute(text("""
                UPDATE data_source_registry SET source_state = 'ACTIVE'
                WHERE source_id = 'base_mapping_official'
            """))
        with pytest.raises(DataFoundationError, match="base_mapping_contract_not_approved"):
            publish_initial_mapping_migration(
                engine,
                job_id=job_id,
                actor_user_id=7,
                staging_directory=staging_directory,
                idempotency_key="sqlite-mapping-approval-test",
                request_id="sqlite-mapping-approval-test",
            )
        with engine.connect() as connection:
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_versions"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_entries"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_current"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT job_state FROM import_jobs WHERE job_id = :job_id"
            ), {"job_id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == "VALIDATED"
    finally:
        engine.dispose()


def test_initial_mapping_migration_rolls_back_on_final_row_validation_failure(tmp_path, monkeypatch):
    if not OFFICIAL_WORKBOOK_ROOT.is_dir():
        pytest.skip("Set DATA_FOUNDATION_REVIEW_WORKBOOKS to the official workbook review folder")
    mapping_path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
    if not mapping_path.is_file():
        pytest.skip("DoomsDay mapping workbook was not found in the review folder")

    engine = create_engine("sqlite://")
    _sql_compatibility_for_sqlite(engine)
    _sqlite_schema(engine)
    try:
        staging_directory = tmp_path / "private-staging"
        job_id, _key = _create_initial_mapping_job(
            engine, mapping_path.read_bytes(), staging_directory
        )
        original_parse = data_foundation_repository.parse_workbook

        def fail_final_validation(content, contract, resolver=None, *, on_valid_row=None):
            summary = original_parse(content, contract, resolver, on_valid_row=on_valid_row)
            if on_valid_row is not None:
                summary.duplicate_base_code_count = 1
            return summary

        monkeypatch.setattr(data_foundation_repository, "parse_workbook", fail_final_validation)
        with pytest.raises(DataFoundationError, match="mapping_migration_validation_changed"):
            publish_initial_mapping_migration(
                engine,
                job_id=job_id,
                actor_user_id=7,
                staging_directory=staging_directory,
                idempotency_key="sqlite-mapping-rollback-test",
                request_id="sqlite-mapping-rollback-test",
            )
        with engine.connect() as connection:
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_versions"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_entries"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_current"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT job_state FROM import_jobs WHERE job_id = :job_id"
            ), {"job_id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == "VALIDATED"
            assert connection.execute(text(
                "SELECT COUNT(*) FROM data_audit_events"
            )).scalar_one() == 0
    finally:
        engine.dispose()


def test_initial_mapping_migration_rolls_back_if_audit_write_fails(tmp_path, monkeypatch):
    if not OFFICIAL_WORKBOOK_ROOT.is_dir():
        pytest.skip("Set DATA_FOUNDATION_REVIEW_WORKBOOKS to the official workbook review folder")
    mapping_path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
    if not mapping_path.is_file():
        pytest.skip("DoomsDay mapping workbook was not found in the review folder")

    engine = create_engine("sqlite://")
    _sql_compatibility_for_sqlite(engine)
    _sqlite_schema(engine)
    try:
        staging_directory = tmp_path / "private-staging"
        job_id, _key = _create_initial_mapping_job(
            engine, mapping_path.read_bytes(), staging_directory
        )

        def fail_audit(*_args, **_kwargs):
            raise RuntimeError("simulated audit persistence failure")

        monkeypatch.setattr(data_foundation_repository, "_write_audit", fail_audit)
        with pytest.raises(RuntimeError, match="simulated audit persistence failure"):
            publish_initial_mapping_migration(
                engine,
                job_id=job_id,
                actor_user_id=7,
                staging_directory=staging_directory,
                idempotency_key="sqlite-mapping-audit-rollback",
                request_id="sqlite-mapping-audit-rollback",
            )
        with engine.connect() as connection:
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_versions"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_entries"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM base_mapping_current"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT job_state FROM import_jobs WHERE job_id = :job_id"
            ), {"job_id": bytes.fromhex(job_id.replace("-", ""))}).scalar_one() == "VALIDATED"
    finally:
        engine.dispose()


def load_mapping_resolver_from_engine(engine):
    with engine.connect() as connection:
        return load_mapping_resolver(connection, source_id="no_movement")
