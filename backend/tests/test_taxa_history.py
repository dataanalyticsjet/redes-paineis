from __future__ import annotations

from copy import deepcopy

import pytest

from app.services.data_sources import TAXA_REQUIRED_HEADERS
from app.services.taxa_history import TaxaHistoryError, merge_taxa_history


def parsed_taxa(rows: list[tuple[str, str, str]]) -> dict[str, object]:
    headers = list(TAXA_REQUIRED_HEADERS)
    parsed_rows = []
    for date, base, region in rows:
        row = {header: 0 for header in headers}
        row.update({
            "Horário de término do prazo de coleta": date,
            "Nome da regional": region,
            "Nome da base de coleta": base,
            "Origem do Pedido": "TikTok",
            "Tipo de produto": "Pacote",
            "Quantidade de pedidos": 10,
            "Qtd a coletar": 8,
            "未揽收量": 1,
            "Qtd coletada no prazo": 6,
            "Pedidos coletados + Tentativas de coleta": 7,
        })
        parsed_rows.append(row)
    return {
        "sheetName": "Taxa",
        "headers": headers,
        "rows": parsed_rows,
        "dateColumn": "Horário de término do prazo de coleta",
        "regionColumn": "Nome da regional",
        "baseColumn": "Nome da base de coleta",
        "originColumn": "Origem do Pedido",
        "metadata": {"headerRow": 1, "rowCount": len(parsed_rows), "date1904": False},
        "warnings": [],
    }


def test_taxa_history_adds_new_dates_and_keeps_absent_dates() -> None:
    existing = parsed_taxa([
        ("2026-10-01", "Base A", "SPS"),
        ("2026-10-02", "Base B", "SPE"),
    ])
    incoming = parsed_taxa([("2026-10-03", "Base C", "RJ")])

    result = merge_taxa_history(existing, incoming)

    assert result.new_dates == ["2026-10-03"]
    assert result.replaced_dates == []
    assert result.file_period == {"start": "2026-10-03", "end": "2026-10-03"}
    assert result.merged_period == {"start": "2026-10-01", "end": "2026-10-03"}
    assert [row["Nome da base de coleta"] for row in result.parsed["rows"]] == ["Base A", "Base B", "Base C"]


def test_taxa_history_replaces_whole_overlapping_dates_without_row_deduplication() -> None:
    existing = parsed_taxa([
        ("2026-10-01", "Base A", "SPS"),
        ("2026-10-01", "Base B", "SPE"),
        ("2026-10-02", "Base C", "RJ"),
    ])
    replacement = parsed_taxa([
        ("2026-10-01", "Base New", "SPS"),
        ("2026-10-01", "Base New", "SPS"),
    ])

    result = merge_taxa_history(existing, replacement)

    assert result.new_dates == []
    assert result.replaced_dates == ["2026-10-01"]
    assert result.file_row_count == 2
    assert result.resulting_rows == 3
    assert [row["Nome da base de coleta"] for row in result.parsed["rows"]] == ["Base New", "Base New", "Base C"]


def test_reuploading_same_taxa_snapshot_does_not_duplicate_and_retains_other_dates() -> None:
    existing = parsed_taxa([
        ("2026-10-01", "Base A", "SPS"),
        ("2026-10-02", "Base B", "SPE"),
    ])
    snapshot = parsed_taxa([
        ("2026-10-02", "Base Replacement", "SPE"),
        ("2026-10-03", "Base C", "RJ"),
    ])

    first = merge_taxa_history(existing, snapshot)
    second = merge_taxa_history(first.parsed, snapshot)

    assert first.resulting_rows == 3
    assert second.resulting_rows == 3
    assert second.new_dates == []
    assert second.replaced_dates == ["2026-10-02", "2026-10-03"]
    assert [row["Nome da base de coleta"] for row in second.parsed["rows"]] == ["Base A", "Base Replacement", "Base C"]


def test_taxa_history_reports_blank_bases_and_rejects_invalid_date_or_schema() -> None:
    incoming = parsed_taxa([("2026-10-01", "", "SPS")])
    result = merge_taxa_history(None, incoming)
    assert result.blank_base_rows == 1

    invalid_date = deepcopy(incoming)
    invalid_date["rows"][0]["Horário de término do prazo de coleta"] = "2026-13-40"
    with pytest.raises(TaxaHistoryError, match="data_source_taxa_invalid_date"):
        merge_taxa_history(None, invalid_date)

    incompatible = deepcopy(incoming)
    incompatible["headers"].remove("Nome da base de coleta")
    with pytest.raises(TaxaHistoryError, match="data_source_taxa_history_schema_mismatch"):
        merge_taxa_history(None, incompatible)
