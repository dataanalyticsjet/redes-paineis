from datetime import date, datetime, timezone
from io import BytesIO

import httpx
import pytest

from app.core.config import Settings
from app.services.data_foundation.contracts import get_contract
from app.services.no_movement_feishu_reports import (
    NoMovementFeishuReportError,
    RECIPIENT_KEY,
    _FeishuRejected,
    _analysis,
    _feishu_payload,
    _make_png,
    _make_xlsx,
    _recipient_key,
    _utc_now,
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


def test_disabled_pilot_blocks_send_before_database_or_http_access(monkeypatch):
    def forbidden_client(*args, **kwargs):
        pytest.fail("Feishu client must not be initialized while pilot flag is disabled")

    monkeypatch.setattr("app.services.no_movement_feishu_reports.httpx.Client", forbidden_client)
    with pytest.raises(NoMovementFeishuReportError) as error:
        send_report(None, report_id="not-read-when-disabled", actor_user_id=1, settings=Settings(feishu_no_movement_pilot_enabled=False))
    assert error.value.status_code == 503
    assert error.value.code == "no_movement_feishu_pilot_disabled"


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


def test_mysql_datetime_values_are_created_as_naive_utc():
    before = datetime.now(timezone.utc).replace(tzinfo=None)
    value = _utc_now()
    after = datetime.now(timezone.utc).replace(tzinfo=None)
    assert value.tzinfo is None  # MySQL DATETIME(6) stores the explicit UTC wall time.
    assert before <= value <= after
