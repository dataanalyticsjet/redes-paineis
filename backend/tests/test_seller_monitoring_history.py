import pytest

from app.services.seller_monitoring_history import (
    SellerMonitoringHistoryError,
    merge_seller_monitoring_history,
)


def _parsed(rows: list[dict[str, object]]) -> dict[str, object]:
    headers = ["Data", "Regional Origem", "PDD de saida", "Origem do Pedido", "Qtd"]
    return {
        "headers": headers,
        "rows": rows,
        "dateColumn": "Data",
        "baseColumn": "PDD de saida",
        "regionColumn": "Regional Origem",
        "originColumn": "Origem do Pedido",
        "metadata": {"rowCount": len(rows)},
        "warnings": [],
    }


def test_jt_history_preserves_absent_dates_and_replaces_full_resubmitted_dates() -> None:
    existing = _parsed([
        {"Data": "2026-10-01", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 10},
        {"Data": "2026-10-02", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 20},
        {"Data": "2026-10-02", "Regional Origem": "MG", "PDD de saida": "B2", "Origem do Pedido": "TikTok", "Qtd": 30},
    ])
    incoming = _parsed([
        {"Data": "2026-10-02", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 21},
        {"Data": "2026-10-02", "Regional Origem": "MG", "PDD de saida": "B2", "Origem do Pedido": "TikTok", "Qtd": 31},
        {"Data": "2026-10-03", "Regional Origem": "MG", "PDD de saida": "B2", "Origem do Pedido": "TikTok", "Qtd": 40},
    ])

    merged = merge_seller_monitoring_history(existing, incoming)
    assert merged.new_dates == ["2026-10-03"]
    assert merged.replaced_dates == ["2026-10-02"]
    assert merged.file_row_count == 3
    assert merged.resulting_rows == 4
    assert [row["Data"] for row in merged.parsed["rows"]] == [
        "2026-10-01", "2026-10-02", "2026-10-02", "2026-10-03",
    ]
    assert [row["Qtd"] for row in merged.parsed["rows"]] == [10, 21, 31, 40]
    assert merged.parsed["metadata"]["rowCount"] == 4


def test_republishing_same_jt_snapshot_does_not_duplicate_rows() -> None:
    snapshot = _parsed([
        {"Data": "2026-10-06", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 12},
        {"Data": "2026-10-06", "Regional Origem": "MG", "PDD de saida": "B2", "Origem do Pedido": "TikTok", "Qtd": 13},
    ])
    merged = merge_seller_monitoring_history(snapshot, snapshot)
    assert merged.new_dates == []
    assert merged.replaced_dates == ["2026-10-06"]
    assert merged.resulting_rows == 2


def test_jt_history_rejects_invalid_dates_and_schema_changes() -> None:
    invalid = _parsed([{"Data": "06/10/2026", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 1}])
    with pytest.raises(SellerMonitoringHistoryError, match="data_source_seller_invalid_date"):
        merge_seller_monitoring_history(None, invalid)
    changed = _parsed([{"Data": "2026-10-06", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Extra": 1}])
    changed["headers"] = [*changed["headers"][:-1], "Extra"]
    with pytest.raises(SellerMonitoringHistoryError, match="data_source_seller_history_schema_mismatch"):
        merge_seller_monitoring_history(_parsed([{"Data": "2026-10-05", "Regional Origem": "SPE", "PDD de saida": "B1", "Origem do Pedido": "TikTok", "Qtd": 1}]), changed)
