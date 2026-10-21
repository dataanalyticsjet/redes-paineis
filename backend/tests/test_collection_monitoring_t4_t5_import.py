from __future__ import annotations

from datetime import date
from decimal import Decimal
from io import BytesIO
import hashlib
import uuid

import pytest
from sqlalchemy import create_engine, text

from app.services.data_foundation.contracts import CONTRACTS
from app.services.data_foundation import repository
from app.services.data_foundation.repository import (
    create_received_import_job,
    get_job_status,
    load_mapping_resolver,
    process_t4t5_preview_job,
    publish_t4t5_import_job,
    queue_t4t5_publication,
    save_uploaded_workbook_stream,
    write_preview_manifest,
)
from app.services.data_foundation.xlsx_parser import parse_workbook
from app.services.data_foundation.repository import DataFoundationError
from test_data_foundation_publication import _sql_compatibility_for_sqlite, _sqlite_schema, _xlsx_bytes


T4T5_SOURCE = "collection_monitoring_t4_t5"
ACTOR_ID = 41


@pytest.fixture
def import_environment(tmp_path):
    engine = create_engine("sqlite://")
    _sqlite_schema(engine)
    _sql_compatibility_for_sqlite(engine)
    map_version_id = uuid.uuid4().bytes
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO base_mapping_versions
              (map_version_id, version_no, source_id, contract_version, version_state)
            VALUES (:map_id, 1, 'base_mapping_official', 1, 'PUBLISHED')
        """), {"map_id": map_version_id})
        connection.execute(text("""
            INSERT INTO base_mapping_current (current_key, map_version_id)
            VALUES ('OFFICIAL', :map_id)
        """), {"map_id": map_version_id})
        connection.execute(text("""
            INSERT INTO base_mapping_entries (map_version_id, base_code, base_name)
            VALUES (:map_id, 'BASE-SPE', 'PDD SPE')
        """), {"map_id": map_version_id})
    staging_directory = tmp_path / "private-imports"
    staging_directory.mkdir()
    yield engine, map_version_id, staging_directory
    engine.dispose()


def _workbook_row(day: int, *, seller_id: str = "000123") -> dict[str, object]:
    row: dict[str, object] = {}
    contract = CONTRACTS[T4T5_SOURCE]
    for column in contract.columns:
        if column.key == "data_date":
            row[column.key] = date(2026, 10, day)
        elif column.key == "reported_origin_region":
            row[column.key] = "SPE"
        elif column.key == "source_base_name":
            row[column.key] = "PDD SPE"
        elif column.key == "customer_name":
            row[column.key] = "Cliente JMS"
        elif column.key == "store_name":
            row[column.key] = "Loja 01"
        elif column.key == "seller_id":
            row[column.key] = seller_id
        elif column.key == "assigned_driver":
            row[column.key] = "Motorista"
        elif column.key == "order_origin":
            row[column.key] = "Aplicativo"
        elif column.kind == "INTEGER":
            row[column.key] = 0
        elif column.kind == "DECIMAL":
            row[column.key] = Decimal("0")
        else:
            row[column.key] = None
    return row


def _create_validated_job(engine, map_version_id, staging_directory, rows):
    contract = CONTRACTS[T4T5_SOURCE]
    content = _xlsx_bytes(contract, rows)
    stored_key, file_size, file_sha256 = save_uploaded_workbook_stream(
        staging_directory, BytesIO(content), max_bytes=256 * 1024 * 1024,
    )
    write_preview_manifest(staging_directory, stored_key, {
        "phase": "VALIDATION", "fileSha256": file_sha256,
    })
    with engine.connect() as connection:
        resolver = load_mapping_resolver(connection, source_id=T4T5_SOURCE)
        connection.commit()
        job_id = create_received_import_job(
            connection,
            source_id=T4T5_SOURCE,
            actor_user_id=ACTOR_ID,
            file_name="monitoramento_coleta_t4_t5.xlsx",
            file_size=file_size,
            stored_file_key=stored_key,
            file_sha256=file_sha256,
            map_version_id=resolver.map_version_id,
            request_id="isolated-import-test",
        )
    process_t4t5_preview_job(
        engine, job_id=job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
    )
    status = get_job_status(engine, job_id, ACTOR_ID, staging_directory=staging_directory)
    assert status["state"] == "VALIDATED"
    assert status["canPublish"] is True
    assert status["mappingVersionId"] == str(uuid.UUID(bytes=map_version_id))
    return job_id, stored_key, content, status


def _seed_old_daily_head(engine, map_version_id: bytes, day: int) -> bytes:
    publication_id = uuid.uuid4().bytes
    with engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO source_publications
              (publication_id, source_id, version_no, contract_version, map_version_id,
               file_sha256, publication_state, history_policy, period_start, period_end, row_count)
            VALUES (:publication_id, :source_id, :version_no, 1, :map_id,
                    :file_hash, 'PUBLISHED', 'DAILY_REPLACE_DATES', :day, :day, 1)
        """), {
            "publication_id": publication_id,
            "source_id": T4T5_SOURCE,
            "version_no": day,
            "map_id": map_version_id,
            "file_hash": bytes([day]) * 32,
            "day": date(2026, 10, day),
        })
        connection.execute(text("""
            INSERT INTO source_publication_dates (source_id, publication_id, data_date, row_count)
            VALUES (:source_id, :publication_id, :day, 1)
        """), {"source_id": T4T5_SOURCE, "publication_id": publication_id, "day": date(2026, 10, day)})
        connection.execute(text("""
            INSERT INTO source_daily_head (source_id, data_date, publication_id)
            VALUES (:source_id, :day, :publication_id)
        """), {"source_id": T4T5_SOURCE, "day": date(2026, 10, day), "publication_id": publication_id})
    return publication_id


def test_t4t5_validation_streams_workbook_and_preserves_duplicate_rows_and_text_ids(import_environment):
    engine, map_version_id, staging_directory = import_environment
    duplicate = _workbook_row(20)
    job_id, stored_key, _content, status = _create_validated_job(
        engine, map_version_id, staging_directory, [duplicate, duplicate.copy()],
    )

    assert status["inputRowCount"] == 2
    assert status["validRowCount"] == 2
    assert status["duplicateCount"] == 1
    assert status["perDateCounts"] == {"2026-10-20": 2}

    contract = CONTRACTS[T4T5_SOURCE]
    with engine.connect() as connection:
        resolver = load_mapping_resolver(connection, source_id=T4T5_SOURCE)
    parsed = parse_workbook(
        staging_directory / stored_key, contract, resolver,
    )
    assert len(contract.columns) == 15
    assert parsed.valid_row_count == 2
    assert parsed.exact_duplicate_count == 1
    assert status["jobId"] == job_id
    assert parsed.map_version_id == map_version_id
    assert (staging_directory / stored_key).read_bytes() == _content
    assert hashlib.sha256(_content).hexdigest() == status["fileSha256"]


def test_t4t5_rejects_a_second_upload_while_the_source_is_processing(import_environment):
    engine, map_version_id, staging_directory = import_environment
    first_job_id, _, _, _ = _create_validated_job(
        engine, map_version_id, staging_directory, [_workbook_row(20)],
    )
    queue_t4t5_publication(
        engine, job_id=first_job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
    )

    content = _xlsx_bytes(CONTRACTS[T4T5_SOURCE], [_workbook_row(19, seller_id="000789")])
    stored_key, file_size, file_sha256 = save_uploaded_workbook_stream(
        staging_directory, BytesIO(content), max_bytes=256 * 1024 * 1024,
    )
    try:
        with engine.connect() as connection:
            with pytest.raises(DataFoundationError, match="import_job_processing"):
                create_received_import_job(
                    connection,
                    source_id=T4T5_SOURCE,
                    actor_user_id=ACTOR_ID,
                    file_name="second-upload.xlsx",
                    file_size=file_size,
                    stored_file_key=stored_key,
                    file_sha256=file_sha256,
                    map_version_id=map_version_id,
                    request_id="isolated-import-test-second-upload",
                )
    finally:
        (staging_directory / stored_key).unlink(missing_ok=True)


def test_t4t5_does_not_queue_two_publications_for_the_same_source(import_environment):
    engine, map_version_id, staging_directory = import_environment
    first_job_id, _, _, _ = _create_validated_job(
        engine, map_version_id, staging_directory, [_workbook_row(20)],
    )
    second_job_id, _, _, _ = _create_validated_job(
        engine, map_version_id, staging_directory, [_workbook_row(19, seller_id="000789")],
    )

    queue_t4t5_publication(
        engine, job_id=first_job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
    )
    with pytest.raises(DataFoundationError, match="import_job_processing"):
        queue_t4t5_publication(
            engine, job_id=second_job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
        )

    first = get_job_status(engine, first_job_id, ACTOR_ID, staging_directory=staging_directory)
    second = get_job_status(engine, second_job_id, ACTOR_ID, staging_directory=staging_directory)
    assert first["state"] == "PARSING"
    assert first["phase"] == "PUBLICATION"
    assert second["state"] == "VALIDATED"


def test_t4t5_publication_failure_keeps_old_heads_and_resume_does_not_duplicate_rows(
    import_environment, monkeypatch,
):
    engine, map_version_id, staging_directory = import_environment
    old_day_19 = _seed_old_daily_head(engine, map_version_id, 19)
    old_day_20 = _seed_old_daily_head(engine, map_version_id, 20)
    first = _workbook_row(20)
    rows = [first, first.copy(), _workbook_row(18, seller_id="000456")]
    job_id, stored_key, _content, preview = _create_validated_job(
        engine, map_version_id, staging_directory, rows,
    )
    assert preview["duplicateCount"] == 1
    assert preview["perDateCounts"] == {"2026-10-18": 1, "2026-10-20": 2}

    queue_t4t5_publication(
        engine, job_id=job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
    )
    original_batch_size = repository.FACT_BATCH_SIZE
    original_parse = repository.parse_workbook
    monkeypatch.setattr(repository, "FACT_BATCH_SIZE", 2)

    def fail_after_first_committed_batch(content, contract, resolver, *, on_valid_row=None, on_progress=None):
        def interrupt_after_batch(row):
            if on_valid_row is not None:
                on_valid_row(row)
            if row.source_row_no == 3:
                raise RuntimeError("simulated interruption after committed batch")

        return original_parse(
            content, contract, resolver,
            on_valid_row=interrupt_after_batch,
            on_progress=on_progress,
        )

    monkeypatch.setattr(repository, "parse_workbook", fail_after_first_committed_batch)
    publish_t4t5_import_job(
        engine,
        job_id=job_id,
        actor_user_id=ACTOR_ID,
        staging_directory=staging_directory,
        idempotency_key="isolated-t4t5-import-key",
        request_id="isolated-import-test",
    )

    failed = get_job_status(engine, job_id, ACTOR_ID, staging_directory=staging_directory)
    assert failed["state"] == "FAILED"
    assert failed["phase"] == "PUBLICATION"
    assert failed["canPublish"] is True
    with engine.connect() as connection:
        prepared = connection.execute(text("""
            SELECT publication_id, publication_state
            FROM source_publications WHERE source_id = :source_id AND job_id = :job_id
        """), {"source_id": T4T5_SOURCE, "job_id": uuid.UUID(job_id).bytes}).mappings().one()
        prepared_id = bytes(prepared["publication_id"])
        assert prepared["publication_state"] == "PREPARED"
        assert connection.execute(text(
            "SELECT COUNT(*) FROM fact_collection_monitoring_t4_t5 WHERE publication_id = :publication_id"
        ), {"publication_id": prepared_id}).scalar_one() == 2
        heads = {
            int(str(row["data_date"])[-2:]): bytes(row["publication_id"])
            for row in connection.execute(text("""
                SELECT data_date, publication_id FROM source_daily_head WHERE source_id = :source_id
            """), {"source_id": T4T5_SOURCE}).mappings()
        }
        assert heads == {19: old_day_19, 20: old_day_20}

    queue_t4t5_publication(
        engine, job_id=job_id, actor_user_id=ACTOR_ID, staging_directory=staging_directory,
    )
    monkeypatch.setattr(repository, "parse_workbook", original_parse)
    monkeypatch.setattr(repository, "FACT_BATCH_SIZE", original_batch_size)
    publish_t4t5_import_job(
        engine,
        job_id=job_id,
        actor_user_id=ACTOR_ID,
        staging_directory=staging_directory,
        idempotency_key="isolated-t4t5-import-key",
        request_id="isolated-import-test",
    )

    published = get_job_status(engine, job_id, ACTOR_ID, staging_directory=staging_directory)
    assert published["state"] == "PUBLISHED"
    assert published["version"] == 21
    new_publication_id = uuid.UUID(published["publicationId"]).bytes
    with engine.connect() as connection:
        assert connection.execute(text("""
            SELECT COUNT(*) FROM source_publications WHERE source_id = :source_id
        """), {"source_id": T4T5_SOURCE}).scalar_one() == 3
        assert connection.execute(text("""
            SELECT COUNT(*) FROM fact_collection_monitoring_t4_t5 WHERE publication_id = :publication_id
        """), {"publication_id": new_publication_id}).scalar_one() == 3
        assert connection.execute(text("""
            SELECT COUNT(*) FROM fact_collection_monitoring_t4_t5
            WHERE publication_id = :publication_id AND seller_id = '000123'
        """), {"publication_id": new_publication_id}).scalar_one() == 2
        heads = {
            int(str(row["data_date"])[-2:]): bytes(row["publication_id"])
            for row in connection.execute(text("""
                SELECT data_date, publication_id FROM source_daily_head WHERE source_id = :source_id
            """), {"source_id": T4T5_SOURCE}).mappings()
        }
        assert heads == {18: new_publication_id, 19: old_day_19, 20: new_publication_id}
        published_dates = {
            str(row["data_date"]): int(row["row_count"])
            for row in connection.execute(text("""
                SELECT data_date, row_count FROM source_publication_dates
                WHERE source_id = :source_id AND publication_id = :publication_id
            """), {"source_id": T4T5_SOURCE, "publication_id": new_publication_id}).mappings()
        }
        assert published_dates == {"2026-10-18": 1, "2026-10-20": 2}
        assert connection.execute(text("""
            SELECT COUNT(*) FROM fact_collection_monitoring_t4_t5
            WHERE publication_id = :publication_id AND source_row_no IN (2, 3)
        """), {"publication_id": new_publication_id}).scalar_one() == 2

    assert (staging_directory / stored_key).is_file()
