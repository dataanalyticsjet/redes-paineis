from __future__ import annotations

import io
import json
from datetime import date, datetime
import os
from pathlib import Path
import uuid

import pytest
from openpyxl import load_workbook
from PIL import Image

from app.core.config import Settings
from app.services import operational_feishu_reports as service
from app.services.no_movement_feishu_reports import _feishu_markdown


def test_source_allowlist_and_flags_are_separate_and_off_by_default():
    settings = Settings(_env_file=None)
    assert settings.feishu_collection_rate_report_enabled is False
    assert settings.feishu_pdd_collection_failure_report_enabled is False
    assert service._feature_enabled("collection_rate", settings) is False
    assert service._feature_enabled("pdd_collection_failure", settings) is False
    with pytest.raises(service.OperationalFeishuReportError):
        service._source("collection_monitoring")


def test_collection_rate_analysis_uses_official_weighted_formula_and_unmapped_national_rows():
    publication = {"version_no": 7}
    rows = [
        {"deadline_at": datetime(2026, 10, 22), "resolved_base_code": "001", "mapping_resolution": "CODE_MATCH", "mapped_region": "SPS", "mapped_base_name": "Base Um", "mapped_rm": "RM A", "collected_quantity": 90, "quantity_to_collect": 100, "order_quantity": 105},
        {"deadline_at": datetime(2026, 10, 22), "resolved_base_code": "002", "mapping_resolution": "NAME_APPROVED", "mapped_region": "SPE", "mapped_base_name": "Base Dois", "mapped_rm": "RM B", "collected_quantity": 40, "quantity_to_collect": 50, "order_quantity": 51},
        {"deadline_at": datetime(2026, 10, 22), "resolved_base_code": None, "mapping_resolution": "UNMAPPED", "mapped_region": None, "mapped_base_name": None, "mapped_rm": None, "collected_quantity": 10, "quantity_to_collect": 20, "order_quantity": 22},
    ]
    message, result, totals = service._analysis("collection_rate", publication, rows, None, date(2026, 10, 22))
    assert totals == {"collected": 140, "planned": 170, "totalOrders": 178, "rateNumerator": 140, "rateDenominator": 170}
    assert result["operationalDate"] == "2026-10-22"
    assert result["result"]["metric"]["numeratorField"] == "collected_quantity"
    assert result["result"]["metric"]["denominatorField"] == "quantity_to_collect"
    assert result["result"]["unmappedPlanned"] == 20
    assert "82,4%" in message
    assert "Volume sem regional/base DoomsDay" in message


def test_pdd_analysis_uses_collection_column_and_keeps_unmapped_in_national_totals():
    publication = {"version_no": 4}
    rows = [
        {"data_date": date(2026, 10, 22), "resolved_base_code": "001", "mapping_resolution": "CODE_MATCH", "mapped_region": "SPS", "mapped_base_name": "PDD Um", "mapped_rm": "RM SPS", "total_orders": 100, "orders_unscanned_at_collection": 7},
        {"data_date": date(2026, 10, 22), "resolved_base_code": None, "mapping_resolution": "UNMAPPED", "mapped_region": None, "mapped_base_name": None, "mapped_rm": None, "total_orders": 25, "orders_unscanned_at_collection": 3},
    ]
    message, result, totals = service._analysis("pdd_collection_failure", publication, rows, None, date(2026, 10, 22))
    assert totals == {"collected": 115, "planned": 125, "totalOrders": 125, "rateNumerator": 10, "rateDenominator": 125}
    assert result["result"]["metric"]["unscannedField"] == "orders_unscanned_at_collection"
    assert result["result"]["unmapped"]["totalOrders"] == 25
    assert "8,0%" in message


def test_collection_rate_excel_contains_all_contract_columns_and_all_rows():
    from app.services.data_foundation.contracts import get_contract

    contract = get_contract("collection_rate", 3)
    rows = [{column.key: None for column in contract.columns} for _ in range(2)]
    rows[0].update({"deadline_at": datetime(2026, 10, 22), "reported_region": "SPS", "order_quantity": 105, "quantity_to_collect": 100, "collected_quantity": 90})
    rows[1].update({"deadline_at": datetime(2026, 10, 21), "reported_region": None, "order_quantity": 22, "quantity_to_collect": 20, "collected_quantity": 10})
    name, content = service._xlsx("collection_rate", rows, date(2026, 10, 22), None)
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    assert name.endswith("2026-10-22.xlsx")
    assert workbook.sheetnames == ["Dados"]
    sheet = workbook["Dados"]
    values = list(sheet.values)
    assert len(values[0]) == 22
    assert len(values) == 3
    assert values[1][5] == 105


def test_pdd_excel_preserves_fifteen_columns_and_one_date_named_sheet_per_day():
    from app.services.data_foundation.contracts import get_contract

    contract = get_contract("pdd_collection_failure", 2)
    rows = [{column.key: None for column in contract.columns} for _ in range(2)]
    rows[0].update({"data_date": date(2026, 10, 21), "source_base_code": "001", "total_orders": 10, "orders_unscanned_at_collection": 1})
    rows[1].update({"data_date": date(2026, 10, 22), "source_base_code": "002", "total_orders": 20, "orders_unscanned_at_collection": 2})
    _, content = service._xlsx("pdd_collection_failure", rows, date(2026, 10, 22), "SPS")
    workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    assert workbook.sheetnames == ["2026-10-21", "2026-10-22"]
    assert all(len(list(workbook[sheet].values)[0]) == 15 and len(list(workbook[sheet].values)) == 2 for sheet in workbook.sheetnames)


def test_png_is_valid_image_and_reports_source_specific_metrics():
    publication = {"version_no": 3, "contract_version": 3}
    totals = {"totalOrders": 100, "rateNumerator": 98, "rateDenominator": 100, "collected": 98, "planned": 100}
    result = {"operationalDate": "2026-10-22", "result": {"regions": []}}
    content = service._png("collection_rate", publication, "SPS", totals, result)
    image = Image.open(io.BytesIO(content))
    assert image.format == "PNG"
    assert image.size == (1400, 760)


def test_recipient_is_fixed_before_database_or_artifact_access():
    with pytest.raises(service.OperationalFeishuReportError) as recipient_error:
        service.prepare_report(None, source_id="collection_rate", publication_id="bad", region_code=None,
                               recipient_key="arbitrary", actor_user_id=1, staging_directory=__import__("pathlib").Path("/tmp"))
    assert recipient_error.value.code == "operational_feishu_recipient_invalid"


def _report_engine(source_id: str, *, database_url: str = "sqlite://", extra_rows: int = 0):
    from sqlalchemy import create_engine, text
    from app.services.data_foundation.contracts import get_contract

    source = service._source(source_id)
    contract = get_contract(source_id, source["contract"])
    engine = create_engine(database_url)
    pub_id, map_id = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE source_snapshot_head(source_id TEXT, publication_id BLOB)"))
        connection.execute(text("CREATE TABLE source_publications(source_id TEXT, publication_id BLOB, version_no INTEGER, contract_version INTEGER, map_version_id BLOB, period_start TEXT, snapshot_as_of TEXT, published_at TEXT, publication_state TEXT)"))
        connection.execute(text("CREATE TABLE source_publication_dates(source_id TEXT, publication_id BLOB, data_date TEXT, row_count INTEGER)"))
        connection.execute(text("CREATE TABLE base_mapping_entries(map_version_id BLOB, base_code TEXT, regional_name TEXT, base_name TEXT, rm_responsible TEXT)"))
        connection.execute(text(f"CREATE TABLE {source['table']}(source_id TEXT, publication_id BLOB, map_version_id BLOB, source_row_no INTEGER, source_sheet_name TEXT, resolved_base_code TEXT, mapping_resolution TEXT, " + ", ".join(f"`{column.key}` TEXT" for column in contract.columns) + ")"))
        connection.execute(text("""CREATE TABLE operational_feishu_reports(
          report_id BLOB, source_id TEXT, publication_id BLOB, publication_version INTEGER, contract_version INTEGER,
          map_version_id BLOB, region_key TEXT, recipient_key TEXT, recipient_email TEXT, actor_user_id INTEGER,
          analysis_text TEXT, record_count INTEGER, dataset_sha256 BLOB, rules_version TEXT, report_state TEXT,
          delivery_context TEXT, created_at TEXT, updated_at TEXT, confirmed_at TEXT, sent_at TEXT)"""))
        connection.execute(text("INSERT INTO source_snapshot_head VALUES (:s,:p)"), {"s": source_id, "p": pub_id.bytes})
        connection.execute(text("INSERT INTO source_publications VALUES (:s,:p,5,:cv,:m,'2026-10-22','2026-10-22','2026-10-22 12:00:00','PUBLISHED')"), {"s": source_id, "p": pub_id.bytes, "cv": source["contract"], "m": map_id.bytes})
        connection.execute(text("INSERT INTO source_publication_dates VALUES (:s,:p,'2026-10-22',:count)"), {"s": source_id, "p": pub_id.bytes, "count": extra_rows + 2})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:m,'001','SPS','Base SPS','RM SPS')"), {"m": map_id.bytes})
        connection.execute(text("INSERT INTO base_mapping_entries VALUES (:m,'002','SPE','Base SPE','RM SPE')"), {"m": map_id.bytes})
        values = {column.key: None for column in contract.columns}
        if source_id == "collection_rate":
            values.update({"deadline_at": "2026-10-22 12:00:00", "order_quantity": "12", "quantity_to_collect": "10", "collected_quantity": "9"})
        else:
            values.update({"data_date": "2026-10-22", "source_base_code": "001", "source_base_name": "Base SPS", "total_orders": "12", "orders_unscanned_at_collection": "2"})
        keys = ["source_id", "publication_id", "map_version_id", "source_row_no", "source_sheet_name", "resolved_base_code", "mapping_resolution"] + [column.key for column in contract.columns]
        inserted = {"source_id": source_id, "publication_id": pub_id.bytes, "map_version_id": map_id.bytes,
                    "source_row_no": 2, "source_sheet_name": "2026-10-22" if source["sheet_mode"] == "daily" else None,
                    "resolved_base_code": "001", "mapping_resolution": "CODE_MATCH", **values}
        connection.execute(text(f"INSERT INTO {source['table']} ({','.join(f'`{key}`' for key in keys)}) VALUES ({','.join(':'+key for key in keys)})"), inserted)
        second_values = {column.key: None for column in contract.columns}
        if source_id == "collection_rate":
            second_values.update({"deadline_at": "2026-10-22 12:00:00", "reported_region": "SPE", "order_quantity": "8", "quantity_to_collect": "8", "collected_quantity": "7"})
        else:
            second_values.update({"data_date": "2026-10-22", "source_base_code": "002", "source_base_name": "Base SPE", "total_orders": "8", "orders_unscanned_at_collection": "1"})
        second_row = {"source_id": source_id, "publication_id": pub_id.bytes, "map_version_id": map_id.bytes,
                      "source_row_no": 3, "source_sheet_name": "2026-10-22" if source["sheet_mode"] == "daily" else None,
                      "resolved_base_code": "002", "mapping_resolution": "CODE_MATCH", **second_values}
        connection.execute(text(f"INSERT INTO {source['table']} ({','.join(f'`{key}`' for key in keys)}) VALUES ({','.join(':'+key for key in keys)})"), second_row)
        insert_sql = text(f"INSERT INTO {source['table']} ({','.join(f'`{key}`' for key in keys)}) VALUES ({','.join(':'+key for key in keys)})")
        batch = []
        for index in range(extra_rows):
            base_code = "001" if index % 2 == 0 else "002"
            row_values = {column.key: None for column in contract.columns}
            if source_id == "collection_rate":
                row_values.update({"deadline_at": "2026-10-22 12:00:00", "order_quantity": "22", "quantity_to_collect": "20", "collected_quantity": "19"})
            else:
                row_values.update({"data_date": "2026-10-22", "source_base_code": base_code, "source_base_name": f"Base {base_code}", "total_orders": "20", "orders_unscanned_at_collection": "2"})
            batch.append({"source_id": source_id, "publication_id": pub_id.bytes, "map_version_id": map_id.bytes,
                          "source_row_no": index + 4, "source_sheet_name": "2026-10-22" if source["sheet_mode"] == "daily" else None,
                          "resolved_base_code": base_code, "mapping_resolution": "CODE_MATCH", **row_values})
            if len(batch) == 2_000:
                connection.execute(insert_sql, batch)
                batch.clear()
        if batch:
            connection.execute(insert_sql, batch)
    return engine, str(pub_id), map_id


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_regional_payload_is_exactly_scoped_by_the_publication_mapping(source_id: str):
    engine, publication_id, _ = _report_engine(source_id)
    national = service._payload(engine, source_id, publication_id, None)
    regional = service._payload(engine, source_id, publication_id, "SPS")

    assert len(national["rows"]) == 2
    assert {row["mapped_region"] for row in national["rows"]} == {"SPS", "SPE"}
    assert len(regional["rows"]) == 1
    assert {row["mapped_region"] for row in regional["rows"]} == {"SPS"}
    assert {row["resolved_base_code"] for row in regional["rows"]} == {"001"}


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_streamed_preparation_matches_reference_analysis_digest_and_excel_contract(tmp_path: Path, source_id: str):
    engine, publication_id, _ = _report_engine(source_id)
    source = service._source(source_id)
    date_field = source["date_field"]
    # Keep a second PDD date in its own sheet while the analysis remains on the
    # latest published date. Taxa V3 stays in its single contract sheet.
    if source["sheet_mode"] == "daily":
        with engine.begin() as connection:
            connection.execute(__import__("sqlalchemy").text(
                f"UPDATE {source['table']} SET {date_field}='2026-10-21' WHERE source_row_no=3"
            ), {})
    reference = service._payload(engine, source_id, publication_id, None)
    first_id = uuid.uuid4()
    streamed = service._stream_payload(engine, source_id=source_id, publication_id=publication_id,
                                       region_code=None, staging_directory=tmp_path, report_id=first_id)
    second_id = uuid.uuid4()
    repeated = service._stream_payload(engine, source_id=source_id, publication_id=publication_id,
                                       region_code=None, staging_directory=tmp_path, report_id=second_id)

    assert streamed["recordCount"] == len(reference["rows"])
    assert streamed["digest"] == reference["digest"]
    assert streamed["analysis"] == reference["analysis"]
    assert streamed["analysisResult"] == reference["analysisResult"]
    assert streamed["totals"] == reference["totals"]
    assert streamed["fileName"] == reference["fileName"]
    private = tmp_path / ".operational-feishu-reports"
    xlsx_path = private / f"{first_id.hex}.xlsx"
    workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
    expected_sheets = ["Dados"] if source["sheet_mode"] == "single" else ["2026-10-21", "2026-10-22"]
    assert workbook.sheetnames == expected_sheets
    exported_rows = sum(sum(1 for _ in sheet.iter_rows(values_only=True)) - 1 for sheet in workbook.worksheets)
    assert exported_rows == len(reference["rows"])
    assert xlsx_path.read_bytes() == (private / f"{second_id.hex}.xlsx").read_bytes()
    assert (private / f"{first_id.hex}.png").read_bytes() == (private / f"{second_id.hex}.png").read_bytes()


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_streaming_xlsx_size_limit_fails_without_ready_or_partial_artifacts(tmp_path: Path, monkeypatch, source_id: str):
    engine, publication_id, _ = _report_engine(source_id)
    monkeypatch.setattr(service, "MAX_FILE_BYTES", 512)
    report_id = uuid.uuid4()
    with pytest.raises(service.OperationalFeishuReportError) as error:
        service._stream_payload(engine, source_id=source_id, publication_id=publication_id,
                                region_code=None, staging_directory=tmp_path, report_id=report_id)
    assert error.value.code == "operational_feishu_xlsx_invalid"
    private = tmp_path / ".operational-feishu-reports"
    assert list(private.iterdir()) == []


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_generation_timeout_leaves_no_report_or_partial_artifact(tmp_path: Path, monkeypatch, source_id: str):
    engine, publication_id, _ = _report_engine(source_id)
    monkeypatch.setattr(service, "MAX_GENERATION_SECONDS", 0.0)
    with pytest.raises(service.OperationalFeishuReportError) as error:
        service.prepare_report(engine, source_id=source_id, publication_id=publication_id, region_code=None,
                              recipient_key=service.RECIPIENT_KEY, actor_user_id=71, staging_directory=tmp_path)
    assert error.value.code == "operational_feishu_generation_timeout"
    assert error.value.status_code == 504
    with engine.connect() as connection:
        assert connection.execute(__import__("sqlalchemy").text("SELECT COUNT(*) FROM operational_feishu_reports")).scalar_one() == 0
    private = tmp_path / ".operational-feishu-reports"
    assert list(private.iterdir()) == []


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_prepare_confirm_and_disabled_send_use_same_publication_map_and_immutable_artifacts(tmp_path: Path, monkeypatch, source_id: str):
    engine, publication_id, map_id = _report_engine(source_id)
    monkeypatch.setattr(service, "get_settings", lambda: Settings(_env_file=None))
    prepared = service.prepare_report(engine, source_id=source_id, publication_id=publication_id, region_code="SPS",
                                     recipient_key=service.RECIPIENT_KEY, actor_user_id=71, staging_directory=tmp_path)
    assert prepared["state"] == "PREPARED"
    assert prepared["regionCode"] == "SPS"
    assert prepared["mapVersionId"] == str(map_id)
    assert prepared["recordCount"] == 1
    assert prepared["excelBytes"] > 0 and prepared["pngBytes"] > 0
    report_uuid = uuid.UUID(prepared["reportId"])
    private = tmp_path / ".operational-feishu-reports"
    assert (private / f"{report_uuid.hex}.xlsx").is_file()
    assert (private / f"{report_uuid.hex}.png").is_file()
    if os.name == "posix":
        assert (private.stat().st_mode & 0o777) == 0o700
        assert ((private / f"{report_uuid.hex}.xlsx").stat().st_mode & 0o777) == 0o600
    edited = prepared["analysis"] + "\n**Revisado pelo administrador**"
    confirmed = service.confirm_report(engine, report_id=prepared["reportId"], actor_user_id=71, analysis_text=edited, source_id=source_id)
    assert confirmed["state"] == "CONFIRMED"
    with engine.connect() as connection:
        row = connection.execute(__import__("sqlalchemy").text("SELECT analysis_text,report_state FROM operational_feishu_reports WHERE report_id=:id"), {"id": report_uuid.bytes}).first()
    assert row[0] == edited and row[1] == "CONFIRMED"
    with pytest.raises(service.OperationalFeishuReportError) as disabled:
        service.send_report(engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
                            staging_directory=tmp_path, settings=Settings(_env_file=None))
    assert disabled.value.code == "operational_feishu_send_disabled"
    assert (private / f"{report_uuid.hex}.xlsx").is_file()


class _FakeFeishuClient:
    def __init__(self, *, fail_url: str | None = None, ambiguous_message: bool = False):
        self.fail_url = fail_url
        self.ambiguous_message = ambiguous_message
        self.calls: list[tuple[str, dict[str, object]]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url: str, **kwargs):
        import httpx

        self.calls.append((url, kwargs))
        if url == self.fail_url:
            if self.ambiguous_message:
                raise httpx.ReadTimeout("simulated timeout", request=httpx.Request("POST", url))
            return httpx.Response(403, json={"code": 999, "msg": "permission denied"})
        if url == service.TOKEN_URL:
            body = {"code": 0, "tenant_access_token": "mock-token"}
        elif url == service.FILES_URL:
            body = {"code": 0, "data": {"file_key": "mock-file-key"}}
        elif url == service.IMAGES_URL:
            body = {"code": 0, "data": {"image_key": "mock-image-key"}}
        else:
            body = {"code": 0, "data": {"message_id": f"message-{len(self.calls)}"}}
        return httpx.Response(200, json=body)


def _enabled_settings(source_id: str) -> Settings:
    return Settings(
        _env_file=None,
        **{
            service._source(source_id)["flag"]: True,
            "feishu_oauth_app_id": "test-app-id",
            "feishu_oauth_app_secret": "test-app-secret",
        },
    )


@pytest.mark.parametrize("source_id", ["collection_rate", "pdd_collection_failure"])
def test_send_uses_confirmed_analysis_and_same_immutable_artifacts_without_real_network(tmp_path: Path, monkeypatch, source_id: str):
    engine, publication_id, _ = _report_engine(source_id)
    fake = _FakeFeishuClient()
    monkeypatch.setattr(service.httpx, "Client", lambda **_kwargs: fake)
    prepared = service.prepare_report(
        engine, source_id=source_id, publication_id=publication_id, region_code="SPS",
        recipient_key=service.RECIPIENT_KEY, actor_user_id=71, staging_directory=tmp_path,
    )
    edited = prepared["analysis"] + "\n**Conferido manualmente**"
    service.confirm_report(engine, report_id=prepared["reportId"], actor_user_id=71, analysis_text=edited, source_id=source_id)

    result = service.send_report(
        engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
        staging_directory=tmp_path, settings=_enabled_settings(source_id),
    )

    assert result["state"] == "SENT"
    sent_messages = [kwargs["json"] for url, kwargs in fake.calls if url == service.MESSAGE_URL]
    assert len(sent_messages) == 3
    assert sent_messages[0]["msg_type"] == "interactive"
    card = json.loads(sent_messages[0]["content"])
    rendered = card["body"]["elements"][0]["content"]
    assert rendered == _feishu_markdown(edited)
    assert "**Conferido manualmente**" in rendered
    assert sent_messages[1]["msg_type"] == "file"
    assert sent_messages[2]["msg_type"] == "image"
    with engine.connect() as connection:
        stored_state = connection.execute(
            __import__("sqlalchemy").text("SELECT report_state FROM operational_feishu_reports WHERE report_id=:id"),
            {"id": uuid.UUID(prepared["reportId"]).bytes},
        ).scalar_one()
    assert stored_state == "SENT"
    call_count = len(fake.calls)
    with pytest.raises(service.OperationalFeishuReportError) as duplicate:
        service.send_report(
            engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
            staging_directory=tmp_path, settings=_enabled_settings(source_id),
        )
    assert duplicate.value.code == "operational_feishu_report_not_confirmed"
    assert len(fake.calls) == call_count


def test_send_rejects_modified_artifact_after_confirmation(tmp_path: Path, monkeypatch):
    source_id = "collection_rate"
    engine, publication_id, _ = _report_engine(source_id)
    fake = _FakeFeishuClient()
    monkeypatch.setattr(service.httpx, "Client", lambda **_kwargs: fake)
    prepared = service.prepare_report(
        engine, source_id=source_id, publication_id=publication_id, region_code="SPS",
        recipient_key=service.RECIPIENT_KEY, actor_user_id=71, staging_directory=tmp_path,
    )
    service.confirm_report(engine, report_id=prepared["reportId"], actor_user_id=71,
                           analysis_text=prepared["analysis"], source_id=source_id)
    artifact = tmp_path / ".operational-feishu-reports" / f"{uuid.UUID(prepared['reportId']).hex}.xlsx"
    artifact.write_bytes(artifact.read_bytes() + b"tampered")
    with pytest.raises(service.OperationalFeishuReportError) as changed:
        service.send_report(
            engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
            staging_directory=tmp_path, settings=_enabled_settings(source_id),
        )
    assert changed.value.code == "operational_feishu_artifacts_changed"
    assert fake.calls == []


@pytest.mark.parametrize("ambiguous", [False, True], ids=["explicit-rejection", "timeout-ambiguous"])
def test_partial_or_ambiguous_delivery_is_not_retried_automatically(tmp_path: Path, monkeypatch, ambiguous: bool):
    source_id = "collection_rate"
    engine, publication_id, _ = _report_engine(source_id)
    fake = _FakeFeishuClient(fail_url=service.FILES_URL if not ambiguous else service.MESSAGE_URL,
                            ambiguous_message=ambiguous)
    monkeypatch.setattr(service.httpx, "Client", lambda **_kwargs: fake)
    prepared = service.prepare_report(
        engine, source_id=source_id, publication_id=publication_id, region_code="SPS",
        recipient_key=service.RECIPIENT_KEY, actor_user_id=71, staging_directory=tmp_path,
    )
    service.confirm_report(engine, report_id=prepared["reportId"], actor_user_id=71,
                           analysis_text=prepared["analysis"], source_id=source_id)
    expected_state = "PENDING" if ambiguous else "PARTIAL"
    expected_error = "operational_feishu_delivery_pending" if ambiguous else "operational_feishu_partial_delivery"
    with pytest.raises(service.OperationalFeishuReportError) as failure:
        service.send_report(
            engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
            staging_directory=tmp_path, settings=_enabled_settings(source_id),
        )
    assert failure.value.code == expected_error
    with engine.connect() as connection:
        state = connection.execute(
            __import__("sqlalchemy").text("SELECT report_state FROM operational_feishu_reports WHERE report_id=:id"),
            {"id": uuid.UUID(prepared["reportId"]).bytes},
        ).scalar_one()
    assert state == expected_state
    call_count = len(fake.calls)
    with pytest.raises(service.OperationalFeishuReportError):
        service.send_report(
            engine, source_id=source_id, report_id=prepared["reportId"], actor_user_id=71,
            staging_directory=tmp_path, settings=_enabled_settings(source_id),
        )
    assert len(fake.calls) == call_count
