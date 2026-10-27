import hashlib
from datetime import date, datetime, timezone
from io import BytesIO

import httpx
import pytest
from sqlalchemy import create_engine, text

from app.core.config import Settings
from app.services.data_foundation.contracts import get_contract
from app.services.no_movement_feishu_reports import (
    NoMovementFeishuReportError,
    RECIPIENT_KEY,
    _FeishuRejected,
    _analysis,
    _feishu_interactive_content,
    _feishu_markdown,
    _feishu_payload,
    _make_png,
    _make_xlsx,
    _read_prepared_artifact,
    _remove_prepared_artifacts,
    _store_prepared_artifacts,
    _recipient_key,
    _utc_now,
    confirm_report,
    prepare_report,
    send_report,
)
from app.services.no_movement_operational_analysis import build_bilingual_analysis


def _response(status: int, payload: dict) -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request("POST", "https://open.feishu.cn/test"))


def test_pilot_recipient_is_fixed_to_the_authorized_private_test_user():
    _recipient_key(RECIPIENT_KEY)
    with pytest.raises(NoMovementFeishuReportError) as error:
        _recipient_key("ANY_OTHER_RECIPIENT")
    assert error.value.status_code == 403
    assert error.value.code == "no_movement_report_recipient_invalid"


def test_explicit_feishu_http_rejection_is_distinguished_from_ambiguous_server_failure():
    with pytest.raises(_FeishuRejected):
        _feishu_payload(_response(400, {"code": 999, "msg": "rejected"}))
    with pytest.raises(RuntimeError, match="feishu_http_outcome_uncertain"):
        _feishu_payload(_response(503, {"code": 1}))


def test_feishu_api_rejection_is_detected_even_when_http_status_is_success():
    with pytest.raises(_FeishuRejected):
        _feishu_payload(_response(200, {"code": 999, "msg": "rejected"}))


def test_feishu_markdown_formats_bold_and_preserves_operational_text_and_literal_asterisks():
    analysis = (
        "📦 **Resumo SPS — 22/10/2026**\n"
        "Pedidos parados: **1.234** (12,5%)\n"
        "- **Base São Paulo**: 12\n"
        "- **网点 深圳**: 8\n"
        "Responsável: João / 张伟\n"
        "Nota literal: 2 * 3; escape: \\*não é negrito\\*; "
        "marcadores literais: \\*\\*texto literal\\*\\*; sem par: **texto"
    )

    rendered = _feishu_markdown(analysis)

    assert "**Resumo SPS — 22/10/2026**" in rendered
    assert "**1.234**" in rendered
    assert "- **Base São Paulo**: 12\n- **网点 深圳**: 8" in rendered
    assert "📦" in rendered and "João / 张伟" in rendered
    assert "2 \\* 3" in rendered
    assert r"\*não é negrito\*" in rendered
    assert r"\*\*texto literal\*\*" in rendered
    assert "**texto" not in rendered
    assert r"\*\*texto" in rendered


def test_feishu_interactive_content_keeps_large_multilingual_message_and_line_breaks():
    import json

    analysis = "**Análise atual**\n" + ("SPS — Operação / 运营 📦\n" * 800)
    content = _feishu_interactive_content(analysis)
    card = json.loads(content)

    assert card["schema"] == "2.0"
    assert card["body"]["elements"][0]["tag"] == "markdown"
    markdown = card["body"]["elements"][0]["content"]
    assert markdown.startswith("**Análise atual**\n")
    assert markdown.count("\n") == analysis.count("\n")
    assert "运营 📦" in markdown


def test_feishu_interactive_content_rejects_messages_over_platform_limit_without_truncation():
    analysis = "SPS — operação / 运营 📦\n" * 2000
    with pytest.raises(NoMovementFeishuReportError) as error:
        _feishu_interactive_content(analysis)
    assert error.value.code == "no_movement_report_message_too_large"
    assert error.value.status_code == 413


def test_disabled_pilot_blocks_send_before_database_or_http_access(monkeypatch):
    def forbidden_client(*args, **kwargs):
        pytest.fail("Feishu client must not be initialized while pilot flag is disabled")

    monkeypatch.setattr("app.services.no_movement_feishu_reports.httpx.Client", forbidden_client)
    with pytest.raises(NoMovementFeishuReportError) as error:
        send_report(None, report_id="not-read-when-disabled", actor_user_id=1, settings=Settings(feishu_no_movement_pilot_enabled=False))
    assert error.value.status_code == 503
    assert error.value.code == "no_movement_feishu_pilot_disabled"


def test_confirmation_persists_exact_edited_analysis_and_clears_legacy_text_fields(monkeypatch):
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE no_movement_feishu_reports (
                report_id BLOB PRIMARY KEY, publication_id BLOB NOT NULL,
                actor_user_id INTEGER NOT NULL, report_state TEXT NOT NULL,
                analysis_text TEXT NOT NULL, interpretation TEXT NOT NULL,
                comments TEXT NOT NULL, recommendations TEXT NOT NULL,
                confirmed_at DATETIME, updated_at DATETIME
            )
        """)
        connection.execute(text("""
            INSERT INTO no_movement_feishu_reports VALUES
            (:report_id, :publication_id, 7, 'PREPARED', 'generated', 'old', 'old', 'old', NULL, NULL)
        """), {"report_id": bytes.fromhex("72727272727272727272727272727272"), "publication_id": b"p" * 16})
    monkeypatch.setattr(
        "app.services.no_movement_feishu_reports._current_publication",
        lambda *args, **kwargs: {},
    )
    edited = "分析 SPS\nLinha final editada — ç"
    result = confirm_report(engine, report_id="72727272-7272-7272-7272-727272727272", actor_user_id=7, analysis_text=edited)
    assert result == {"reportId": "72727272-7272-7272-7272-727272727272", "state": "CONFIRMED", "messageSent": False}
    with engine.connect() as connection:
        row = connection.execute(text("SELECT analysis_text, interpretation, comments, recommendations FROM no_movement_feishu_reports")).one()
    assert tuple(row) == (edited, "", "", "")


def test_confirmation_rejects_blank_analysis_before_database_access():
    with pytest.raises(NoMovementFeishuReportError) as error:
        confirm_report(None, report_id="not-used", actor_user_id=7, analysis_text="   ")
    assert error.value.code == "no_movement_report_text_required"


def test_regional_analysis_is_scoped_while_default_national_text_is_unchanged():
    common = {
        "operational_date": date(2026, 10, 26),
        "export_time": datetime(2026, 10, 26, 9, 15),
        "publication_version": 12,
        "total": 80,
        "groups": [
            {"mapped": True, "region": "SPS", "base_name": "Base A", "rm_responsible": "RGM 1", "total": 60},
            {"mapped": False, "region": "Sem mapeamento", "base_name": "Unidade X", "total": 20},
        ],
    }
    national = build_bilingual_analysis(**common)
    regional = build_bilingual_analysis(**{**common, "total": 60, "groups": common["groups"][:1]}, region_scope="SPS")
    assert "SEM MOVIMENTAÇÃO | 无流转**" in national
    assert "Volume nacional: 80 pacotes" in national
    assert "REGIONAL SPS | 区域 SPS" in regional
    assert "Volume regional: 60 pacotes" in regional


def test_pilot_xlsx_contract_keeps_all_eighteen_source_columns_and_analysis_total_includes_unmapped_national_rows():
    contract = get_contract("no_movement", 2)
    assert len(contract.columns) == 18
    publication = {
        "period_start": date(2026, 10, 26),
        "snapshot_as_of": datetime(2026, 10, 26, 9, 15),
        "version_no": 12,
    }
    rows = [
        {"stopped_orders": 60, "resolved_base_code": "001", "mapped_region": "SPS", "mapped_base_name": "Base A", "mapped_rm": "RGM 1", "source_base_code": "001", "source_base_name": "Base A", "reported_region": "SPS"},
        {"stopped_orders": 20, "resolved_base_code": None, "mapped_region": None, "mapped_base_name": None, "mapped_rm": None, "source_base_code": "999", "source_base_name": "Unidade X", "reported_region": "SPS"},
    ]
    national, national_total = _analysis(publication, rows, None)
    regional, regional_total = _analysis(publication, rows[:1], "SPS")
    assert national_total == 80 and "Volume nacional: 80 pacotes" in national
    assert "Unidade X (999) — **20 pacotes**" in national
    assert regional_total == 60 and "Volume regional: 60 pacotes" in regional


def test_real_xlsx_and_png_generation_preserves_contract_rows_and_regional_scope():
    from openpyxl import load_workbook
    from PIL import Image

    contract = get_contract("no_movement", 2)

    def make_row(row_no: int, stopped: int, region: str | None, code: str | None) -> dict:
        row = {column.key: None for column in contract.columns}
        row.update({
            "source_row_no": row_no,
            "reported_region": region,
            "source_base_code": code,
            "source_base_name": f"Loja {row_no}",
            "stopped_orders": stopped,
            "stopped_over_7_days": stopped // 2,
            "stopped_over_14_days": stopped // 3,
            "stopped_over_30_days": stopped // 4,
            "resolved_base_code": code,
            "mapped_region": region,
            "mapped_base_name": f"Base {row_no}" if code else None,
            "mapped_rm": "Responsável fictício" if code else None,
        })
        return row

    unmapped = make_row(4, 5, None, None)
    unmapped["reported_region"] = "SPS"
    rows = [
        make_row(2, 11, "SPS", "001"),
        make_row(3, 7, "SR", "002"),
        unmapped,  # Reported SPS is not enough to assign a DoomsDay regional scope.
    ]
    publication = {
        "period_start": date(2026, 10, 26),
        "snapshot_as_of": datetime(2026, 10, 26, 12, 30),
        "version_no": 17,
    }

    national_message, national_total = _analysis(publication, rows, None)
    sps_rows = [row for row in rows if row["mapped_region"] == "SPS" and row["resolved_base_code"]]
    sps_message, sps_total = _analysis(publication, sps_rows, "SPS")
    assert national_total == 23 and "Volume nacional: 23 pacotes" in national_message
    assert sps_total == 11 and "Volume regional: 11 pacotes" in sps_message
    assert "REGIONAL SPS" in sps_message and "REGIONAL SR" not in sps_message

    national_name, national_xlsx = _make_xlsx(rows, region_code=None, operational_date=publication["period_start"])
    sps_name, sps_xlsx = _make_xlsx(sps_rows, region_code="SPS", operational_date=publication["period_start"])
    assert national_name.endswith("_nacional_2026-10-26.xlsx")
    assert sps_name.endswith("_SPS_2026-10-26.xlsx")
    for content, expected_rows in ((national_xlsx, rows), (sps_xlsx, sps_rows)):
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
        sheet = workbook["Dados"]
        exported = list(sheet.iter_rows(values_only=True))
        assert len(exported[0]) == 18
        assert exported[0] == tuple(column.header for column in contract.columns)
        assert len(exported) == len(expected_rows) + 1
        stopped_index = next(index for index, column in enumerate(contract.columns) if column.key == "stopped_orders")
        assert [row[stopped_index] for row in exported[1:]] == [row["stopped_orders"] for row in expected_rows]
        workbook.close()

    for content in (_make_png(rows, region_code=None, publication=publication, total=national_total),
                    _make_png(sps_rows, region_code="SPS", publication=publication, total=sps_total)):
        image = Image.open(BytesIO(content))
        image.verify()
        image = Image.open(BytesIO(content))
        assert image.format == "PNG" and image.size == (1800, 650)
        rgb = image.convert("RGB")
        assert rgb.getpixel((900, 260)) == (255, 255, 255)
        assert any(color == (230, 0, 18) for _, color in rgb.getcolors(maxcolors=1_200_000) or [])


def test_repeated_sps_xlsx_and_png_generation_is_byte_stable_for_same_input():
    contract = get_contract("no_movement", 2)
    row = {column.key: None for column in contract.columns}
    row.update({
        "source_row_no": 1, "source_base_code": "001", "source_base_name": "Base SPS",
        "stopped_orders": 12, "stopped_over_7_days": 6, "stopped_over_14_days": 3,
        "stopped_over_30_days": 1, "resolved_base_code": "001", "mapped_region": "SPS",
        "mapped_base_name": "Base SPS", "mapped_rm": "Responsável fictício",
    })
    publication = {
        "period_start": date(2026, 10, 26),
        "snapshot_as_of": datetime(2026, 10, 26, 9, 15),
        "version_no": 12,
    }
    first_xlsx = _make_xlsx([row], region_code="SPS", operational_date=publication["period_start"])[1]
    second_xlsx = _make_xlsx([row], region_code="SPS", operational_date=publication["period_start"])[1]
    first_png = _make_png([row], region_code="SPS", publication=publication, total=12)
    second_png = _make_png([row], region_code="SPS", publication=publication, total=12)
    assert first_xlsx == second_xlsx
    assert first_png == second_png
    changed_row = {**row, "stopped_orders": 13}
    changed_xlsx = _make_xlsx([changed_row], region_code="SPS", operational_date=publication["period_start"])[1]
    changed_png = _make_png([row], region_code="SPS", publication=publication, total=13)
    assert hashlib.sha256(first_xlsx).digest() != hashlib.sha256(changed_xlsx).digest()
    assert hashlib.sha256(first_png).digest() != hashlib.sha256(changed_png).digest()


def test_prepared_sps_artifacts_are_reused_and_real_changes_or_tampering_are_rejected(tmp_path):
    import hashlib
    import uuid

    report_id = uuid.uuid4()
    xlsx = b"xlsx bytes prepared for SPS"
    png = b"png bytes prepared for SPS"
    _store_prepared_artifacts(tmp_path, report_id, xlsx, png)
    assert _read_prepared_artifact(tmp_path, report_id, "xlsx", hashlib.sha256(xlsx).hexdigest()) == xlsx
    assert _read_prepared_artifact(tmp_path, report_id, "png", hashlib.sha256(png).hexdigest()) == png

    changed_xlsx_path = tmp_path / ".no-movement-feishu-reports" / f"{report_id.hex}.xlsx"
    changed_xlsx_path.write_bytes(b"tampered xlsx")
    with pytest.raises(NoMovementFeishuReportError) as xlsx_error:
        _read_prepared_artifact(tmp_path, report_id, "xlsx", hashlib.sha256(xlsx).hexdigest())
    assert xlsx_error.value.code == "no_movement_report_artifacts_changed"

    changed_png_path = tmp_path / ".no-movement-feishu-reports" / f"{report_id.hex}.png"
    changed_png_path.write_bytes(b"tampered png")
    with pytest.raises(NoMovementFeishuReportError) as png_error:
        _read_prepared_artifact(tmp_path, report_id, "png", hashlib.sha256(png).hexdigest())
    assert png_error.value.code == "no_movement_report_artifacts_changed"
    _remove_prepared_artifacts(tmp_path, report_id)
    assert not changed_xlsx_path.exists() and not changed_png_path.exists()


def test_prepare_and_confirm_sps_persists_exact_text_and_immutable_attachment_hashes(tmp_path, monkeypatch):
    import hashlib
    import json
    import uuid

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE no_movement_feishu_reports (
                report_id BLOB PRIMARY KEY, source_id TEXT, publication_id BLOB,
                publication_version INTEGER, contract_version INTEGER, map_version_id BLOB,
                region_key TEXT, recipient_key TEXT, recipient_email TEXT, actor_user_id INTEGER,
                analysis_text TEXT, interpretation TEXT, comments TEXT, recommendations TEXT,
                record_count INTEGER, total_stopped_orders INTEGER, dataset_sha256 BLOB,
                rules_version TEXT, report_state TEXT, delivery_context TEXT,
                created_at DATETIME, updated_at DATETIME, confirmed_at DATETIME, sent_at DATETIME
            )
        """)

    publication_id = uuid.uuid4()
    map_version_id = uuid.uuid4()
    publication = {
        "publication_id": publication_id.bytes, "version_no": 12, "contract_version": 2,
        "map_version_id": map_version_id.bytes, "period_start": date(2026, 10, 26),
        "snapshot_as_of": datetime(2026, 10, 26, 9, 15), "publication_state": "PUBLISHED",
    }
    xlsx, png = b"prepared SPS xlsx", b"prepared SPS png"
    payload = {
        "publication": publication, "regionCode": "SPS", "rows": [{"resolved_base_code": "001", "mapped_region": "SPS"}],
        "message": "Análise SPS original", "recordCount": 1, "total": 12,
        "datasetDigest": b"d" * 32, "fileName": "sem_movimentacao_SPS_2026-10-26.xlsx",
        "xlsx": xlsx, "png": png, "regions": ["SPS"],
    }
    monkeypatch.setattr("app.services.no_movement_feishu_reports._report_payload", lambda *args, **kwargs: payload)
    monkeypatch.setattr("app.services.no_movement_feishu_reports._current_publication", lambda *args, **kwargs: publication)

    prepared = prepare_report(
        engine, publication_id=str(publication_id), region_code="SPS", recipient_key=RECIPIENT_KEY,
        actor_user_id=7, staging_directory=tmp_path,
    )
    report_uuid = uuid.UUID(prepared["reportId"])
    assert prepared["regionCode"] == "SPS"
    assert (tmp_path / ".no-movement-feishu-reports" / f"{report_uuid.hex}.xlsx").read_bytes() == xlsx
    assert (tmp_path / ".no-movement-feishu-reports" / f"{report_uuid.hex}.png").read_bytes() == png

    edited = "Análise SPS editada e confirmada — texto exato"
    confirm_report(engine, report_id=prepared["reportId"], actor_user_id=7, analysis_text=edited)
    with engine.connect() as connection:
        stored = connection.execute(text("SELECT analysis_text, report_state, delivery_context FROM no_movement_feishu_reports")).one()
    context = json.loads(stored.delivery_context)
    assert stored.analysis_text == edited and stored.report_state == "CONFIRMED"
    assert context["artifacts"] == {
        "xlsxSha256": hashlib.sha256(xlsx).hexdigest(),
        "pngSha256": hashlib.sha256(png).hexdigest(),
    }


def test_send_uses_confirmed_sps_artifact_bytes_and_exact_edited_text_without_regeneration(tmp_path, monkeypatch):
    import uuid

    from app.services import no_movement_feishu_reports as service

    engine = create_engine("sqlite://")
    publication_id, map_version_id = uuid.uuid4(), uuid.uuid4()
    publication = {
        "publication_id": publication_id.bytes, "version_no": 12, "contract_version": 2,
        "map_version_id": map_version_id.bytes, "period_start": date(2026, 10, 26),
        "snapshot_as_of": datetime(2026, 10, 26, 9, 15), "publication_state": "PUBLISHED",
    }
    with engine.begin() as connection:
        connection.exec_driver_sql("""
            CREATE TABLE no_movement_feishu_reports (
                report_id BLOB PRIMARY KEY, source_id TEXT, publication_id BLOB,
                publication_version INTEGER, contract_version INTEGER, map_version_id BLOB,
                region_key TEXT, recipient_key TEXT, recipient_email TEXT, actor_user_id INTEGER,
                analysis_text TEXT, interpretation TEXT, comments TEXT, recommendations TEXT,
                record_count INTEGER, total_stopped_orders INTEGER, dataset_sha256 BLOB,
                rules_version TEXT, report_state TEXT, delivery_context TEXT,
                created_at DATETIME, updated_at DATETIME, confirmed_at DATETIME, sent_at DATETIME
            )
        """)
        connection.exec_driver_sql("CREATE TABLE source_snapshot_head (source_id TEXT, publication_id BLOB)")
        connection.exec_driver_sql("""
            CREATE TABLE source_publications (
                source_id TEXT, publication_id BLOB, version_no INTEGER, contract_version INTEGER,
                map_version_id BLOB, period_start DATE, snapshot_as_of DATETIME, publication_state TEXT
            )
        """)
        connection.execute(text("INSERT INTO source_snapshot_head VALUES ('no_movement', :publication_id)"), {"publication_id": publication_id.bytes})
        connection.execute(text("""
            INSERT INTO source_publications VALUES
            ('no_movement', :publication_id, 12, 2, :map_id, :period_start, :snapshot_as_of, 'PUBLISHED')
        """), {"publication_id": publication_id.bytes, "map_id": map_version_id.bytes,
              "period_start": publication["period_start"], "snapshot_as_of": publication["snapshot_as_of"]})

    xlsx, png = b"confirmed SPS workbook bytes", b"confirmed SPS image bytes"
    digest = b"d" * 32
    payload = {
        "publication": publication, "regionCode": "SPS", "rows": [{"resolved_base_code": "001", "mapped_region": "SPS"}],
        "message": "Original analysis", "recordCount": 1, "total": 12, "datasetDigest": digest,
        "fileName": "sem_movimentacao_SPS_2026-10-26.xlsx", "xlsx": xlsx, "png": png, "regions": ["SPS"],
    }
    include_artifact_calls = []

    def report_payload(*args, include_artifacts=True, **kwargs):
        include_artifact_calls.append(include_artifacts)
        return {**payload, "xlsx": xlsx if include_artifacts else None, "png": png if include_artifacts else None}

    monkeypatch.setattr(service, "_report_payload", report_payload)
    monkeypatch.setattr(service, "_current_publication", lambda *args, **kwargs: publication)
    prepared = prepare_report(
        engine, publication_id=str(publication_id), region_code="SPS", recipient_key=RECIPIENT_KEY,
        actor_user_id=7, staging_directory=tmp_path,
    )
    edited = "**Resumo SPS**\nTexto confirmado — 内容原文 📦\nBases: **001, Base SPS**"
    confirm_report(engine, report_id=prepared["reportId"], actor_user_id=7, analysis_text=edited)
    settings = Settings(feishu_no_movement_pilot_enabled=True, feishu_oauth_app_id="fake", feishu_oauth_app_secret="fake")
    replaced_publication_id = uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(text("UPDATE source_snapshot_head SET publication_id=:new_id"), {"new_id": replaced_publication_id.bytes})
    with pytest.raises(NoMovementFeishuReportError) as replaced_error:
        send_report(engine, report_id=prepared["reportId"], actor_user_id=7, staging_directory=tmp_path, settings=settings)
    assert replaced_error.value.code == "no_movement_publication_not_current"
    with engine.begin() as connection:
        connection.execute(text("UPDATE source_snapshot_head SET publication_id=:old_id"), {"old_id": publication_id.bytes})
    captured = {"uploads": {}, "messages": []}

    class FakeClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, **kwargs):
            if url == service.TOKEN_URL:
                return _response(200, {"code": 0, "tenant_access_token": "test-token"})
            if url == service.FILES_URL:
                captured["uploads"]["xlsx"] = kwargs["files"]["file"][1].read()
                return _response(200, {"code": 0, "data": {"file_key": "fake-file-key"}})
            if url == service.IMAGES_URL:
                captured["uploads"]["png"] = kwargs["files"]["image"][1].read()
                return _response(200, {"code": 0, "data": {"image_key": "fake-image-key"}})
            if url == service.MESSAGE_URL:
                body = kwargs["json"]
                captured["messages"].append(body)
                return _response(200, {"code": 0, "data": {"message_id": f"message-{len(captured['messages'])}"}})
            raise AssertionError(f"Unexpected HTTP endpoint: {url}")

    monkeypatch.setattr(service.httpx, "Client", FakeClient)
    result = send_report(
        engine, report_id=prepared["reportId"], actor_user_id=7, staging_directory=tmp_path,
        settings=settings,
    )
    assert result["state"] == "SENT"
    assert include_artifact_calls == [True, False]
    assert captured["uploads"] == {"xlsx": xlsx, "png": png}
    import json
    assert captured["messages"][0]["msg_type"] == "interactive"
    card = json.loads(captured["messages"][0]["content"])
    assert card["schema"] == "2.0"
    assert card["body"]["elements"][0]["tag"] == "markdown"
    assert card["body"]["elements"][0]["content"] == _feishu_markdown(edited)
    assert "**Resumo SPS**" in card["body"]["elements"][0]["content"]
    with engine.connect() as connection:
        persisted_text = connection.execute(text("SELECT analysis_text FROM no_movement_feishu_reports")).scalar_one()
    assert persisted_text == edited
    assert not (tmp_path / ".no-movement-feishu-reports" / f"{uuid.UUID(prepared['reportId']).hex}.xlsx").exists()
    with pytest.raises(NoMovementFeishuReportError) as duplicate_error:
        prepare_report(
            engine, publication_id=str(publication_id), region_code="SPS", recipient_key=RECIPIENT_KEY,
            actor_user_id=7, staging_directory=tmp_path,
        )
    assert duplicate_error.value.code == "no_movement_report_delivery_unresolved"
    assert list((tmp_path / ".no-movement-feishu-reports").iterdir()) == []


def test_mysql_datetime_values_are_created_as_naive_utc():
    before = datetime.now(timezone.utc).replace(tzinfo=None)
    value = _utc_now()
    after = datetime.now(timezone.utc).replace(tzinfo=None)
    assert value.tzinfo is None  # MySQL DATETIME(6) stores the explicit UTC wall time.
    assert before <= value <= after
