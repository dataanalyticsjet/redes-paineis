from __future__ import annotations

import json
import os
from pathlib import Path
from decimal import Decimal

import pytest

from app.services.data_foundation.contracts import (
    CONTRACTS,
    INITIAL_MAPPING_WORKBOOK_SHA256,
    contract_sha256,
)
from app.services.data_foundation.xlsx_parser import (
    MappingResolver,
    ValidImportRow,
    _RawCell,
    _cell_as_value,
    _resolve_mapping,
    parse_workbook,
)
from app.services.data_foundation.repository import (
    DataFoundationError,
    validate_name_mapping_decision,
)


OFFICIAL_WORKBOOK_ROOT = Path(os.environ.get(
    "DATA_FOUNDATION_REVIEW_WORKBOOKS",
    "/home/phelippecardoso/RedesPaineis-DataFoundationV2-Review-2026-10-09/planilhas",
))
NO_MOVEMENT_REFERENCE_WORKBOOK = Path(os.environ.get("DATA_FOUNDATION_NO_MOVEMENT_WORKBOOK", ""))


@pytest.mark.parametrize(
    ("source_id", "expected_duplicates", "expected_dates"),
    [
        ("collection_monitoring", 0, 6),
        ("collection_rate", 0, 5),
        ("jt_monitoring", 4, 4),
        ("no_movement", 0, 0),
        ("pdd_collection_failure", 0, 1),
    ],
)
def test_official_workbook_contracts_parse_without_a_mapping(source_id, expected_duplicates, expected_dates):
    if not OFFICIAL_WORKBOOK_ROOT.is_dir():
        pytest.skip("Official review workbooks were not mounted")
    contract = CONTRACTS[source_id]
    path = OFFICIAL_WORKBOOK_ROOT / contract.workbook_name
    if not path.is_file():
        pytest.skip(f"Official workbook not found: {contract.workbook_name}")

    summary = parse_workbook(path.read_bytes(), contract, MappingResolver())

    expected_rows = contract.expected_sample_rows if contract.expected_sample_rows is not None else summary.input_row_count
    assert summary.input_row_count == expected_rows
    assert summary.valid_row_count == expected_rows
    assert summary.invalid_row_count == 0
    assert summary.exact_duplicate_count == expected_duplicates
    assert len(summary.per_date_counts) == expected_dates
    assert summary.mapped_row_count == 0
    assert summary.unmapped_row_count == expected_rows
    assert summary.can_publish is False


def test_code_and_unique_published_name_matches_are_automatic_and_conservative():
    resolver = MappingResolver(
        map_version_id=b"0123456789abcdef",
        base_codes=frozenset({"00123"}),
        exact_base_name_candidates={"Base A-SP": ("00123",)},
        normalized_base_name_candidates={"base a-sp": ("00123",)},
        name_decisions={"Base A-SP": ("LINKED", "00123")},
    )
    contract = CONTRACTS["collection_monitoring"]

    assert _resolve_mapping("collection_monitoring", {"source_base_name": "Base A-SP"}, resolver) == (
        "00123", "NAME_APPROVED"
    )
    assert _resolve_mapping("collection_monitoring", {"source_base_name": "base a-sp"}, resolver) == (
        "00123", "NAME_APPROVED"
    )
    assert "00123" in resolver.base_codes
    assert "123" not in resolver.base_codes
    assert contract.headers[2] == "PDD de saida"
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(exact_base_name_candidates={"Base A-SP": ("00123",)}),
    ) == ("00123", "NAME_APPROVED")
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(
            exact_base_name_candidates={"Base A-SP": ("00123",)},
            name_decisions={"Base A-SP": ("LINKED", "00999")},
        ),
    ) == ("00123", "NAME_APPROVED")
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(
            exact_base_name_candidates={"Base A-SP": ("00123", "00456")},
            name_decisions={"Base A-SP": ("LINKED", "00123")},
        ),
    ) == ("00123", "NAME_APPROVED")
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(
            exact_base_name_candidates={"Base A-SP": ("00123", "00456")},
        ),
    ) == (None, "AMBIGUOUS")


def test_doomsday_mapping_has_exactly_1628_unique_codes_and_official_headers():
    path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
    if not path.is_file():
        pytest.skip("DoomsDay mapping workbook was not mounted")
    rows: list[ValidImportRow] = []
    summary = parse_workbook(
        path.read_bytes(), CONTRACTS["base_mapping_official"], on_valid_row=rows.append
    )

    codes = [str(row.values["base_code"]) for row in rows]
    assert CONTRACTS["base_mapping_official"].sheet_name == "Ativas"
    assert CONTRACTS["base_mapping_official"].headers == (
        "Regional", "UF", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"
    )
    assert summary.input_row_count == summary.valid_row_count == 1628
    assert summary.invalid_row_count == summary.duplicate_base_code_count == 0
    assert len(set(codes)) == 1628
    assert summary.file_sha256 == INITIAL_MAPPING_WORKBOOK_SHA256


@pytest.fixture(scope="module")
def doomsday_resolver():
    path = OFFICIAL_WORKBOOK_ROOT / "De_para DoomsDay.xlsx"
    if not path.is_file():
        pytest.skip("DoomsDay mapping workbook was not mounted")
    mapping_rows: list[ValidImportRow] = []
    mapping_summary = parse_workbook(
        path.read_bytes(), CONTRACTS["base_mapping_official"], on_valid_row=mapping_rows.append
    )
    assert mapping_summary.valid_row_count == 1628
    name_candidates: dict[str, list[str]] = {}
    codes = set()
    for row in mapping_rows:
        code = str(row.values["base_code"])
        codes.add(code)
        name_candidates.setdefault(str(row.values["base_name"]), []).append(code)
    return MappingResolver(
        map_version_id=b"0123456789abcdef",
        base_codes=frozenset(codes),
        exact_base_name_candidates={name: tuple(values) for name, values in name_candidates.items()},
    )


@pytest.mark.parametrize("source_id", (
    "collection_monitoring", "collection_monitoring_t4_t5", "collection_rate", "jt_monitoring",
    "no_movement", "pdd_collection_failure",
))
def test_source_previews_use_exact_shared_mapping_only(
    source_id, doomsday_resolver
):
    contract = CONTRACTS[source_id]
    path = OFFICIAL_WORKBOOK_ROOT / contract.workbook_name
    if not path.is_file():
        pytest.skip(f"Official workbook not found: {contract.workbook_name}")

    summary = parse_workbook(path.read_bytes(), contract, doomsday_resolver)

    expected_rows = contract.expected_sample_rows if contract.expected_sample_rows is not None else summary.input_row_count
    assert summary.input_row_count == expected_rows
    assert summary.valid_row_count == expected_rows
    assert summary.invalid_row_count == 0
    assert summary.mapped_row_count + summary.unmapped_row_count == expected_rows
    assert summary.can_publish is True
    if source_id in {"collection_monitoring", "collection_monitoring_t4_t5", "collection_rate", "jt_monitoring"}:
        # Unique names resolve immediately; ambiguous and absent names remain
        # visible as unresolved rows in the totals.
        assert summary.exact_name_candidate_row_count > 0
        assert summary.no_mapping_match_row_count > 0
        assert summary.mapped_row_count > 0
    else:
        assert summary.mapped_row_count > 0


def test_unique_published_name_candidate_is_automatically_resolved():
    resolver = MappingResolver(
        map_version_id=b"0123456789abcdef",
        exact_base_name_candidates={"Base A-SP": ("00123",)},
        normalized_base_name_candidates={"base a-sp": ("00123",)},
    )
    assert _resolve_mapping(
        "jt_monitoring", {"source_base_name": "Base A-SP"}, resolver
    ) == ("00123", "NAME_APPROVED")
    assert _resolve_mapping(
        "jt_monitoring", {"source_base_name": "Base a-SP"}, resolver
    ) == ("00123", "NAME_APPROVED")


def test_manual_name_decision_can_disambiguate_candidates_with_a_review_note():
    validate_name_mapping_decision(
        source_id="collection_monitoring",
        source_base_name="Base A-SP",
        resolution_state="LINKED",
        target_base_code="00123",
        candidate_codes=("00123",),
        review_note="Conferido por operador.",
    )
    with pytest.raises(DataFoundationError, match="mapping_target_must_be_candidate"):
        validate_name_mapping_decision(
            source_id="collection_monitoring",
            source_base_name="Base A-SP",
            resolution_state="LINKED",
            target_base_code="00999",
            candidate_codes=("00123",),
            review_note="Conferido.",
        )
    validate_name_mapping_decision(
        source_id="collection_monitoring",
        source_base_name="Base A-SP",
        resolution_state="LINKED",
        target_base_code="00456",
        candidate_codes=("00123", "00456"),
        review_note="Código e UF conferidos manualmente.",
    )
    with pytest.raises(DataFoundationError, match="mapping_review_note_required"):
        validate_name_mapping_decision(
            source_id="collection_monitoring",
            source_base_name="Base A-SP",
            resolution_state="REJECTED",
            target_base_code=None,
            candidate_codes=(),
            review_note="   ",
        )


def test_numeric_source_code_is_not_zero_padded_and_text_zeroes_are_preserved():
    column = CONTRACTS["no_movement"].columns[1]
    assert _cell_as_value(_RawCell(value=Decimal("123"), numeric=True), column, False) == ("123", None)
    assert _cell_as_value(_RawCell(value="00123"), column, False) == ("00123", None)


def test_review_registry_hashes_match_versioned_python_contracts():
    manifest_path = Path(__file__).parents[1] / "data-foundation" / "phase2-contract-registry-v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = {entry["source"]["sourceId"]: entry for entry in manifest["contracts"]}

    assert manifest["status"] == "REVIEW_ONLY"
    assert entries["base_mapping_official"]["source"]["workbookName"] == "De_para DoomsDay.xlsx"
    assert entries["base_mapping_official"]["source"]["workbookSha256"] == (
        INITIAL_MAPPING_WORKBOOK_SHA256
    )
    for source_id, contract in CONTRACTS.items():
        if source_id == "collection_monitoring_t4_t5":
            # Keep the checked-in phase-two registry as a historical snapshot;
            # this source has its own separately reviewed registration SQL.
            continue
        entry = entries[source_id]
        assert entry["source"]["sourceState"] == "PENDING"
        assert entry["contract"]["state"] == "DISCOVERED"
        if source_id == "no_movement":
            # This checked-in manifest is a historical v1 review snapshot. The
            # JMS workbook is a new v2 contract and must not rewrite that record.
            assert entry["contract"]["version"] == 1
            assert entry["contract"]["sha256"] == "52ecb4852bdd89e1df7a7e2f458ef7a3eeadd0e772eb4de08ba857b201f5ef22"
            continue
        assert entry["contract"]["sha256"] == contract_sha256(contract).hex()
        assert [column["sourceHeader"] for column in entry["contract"]["columns"]] == list(contract.headers)
        assert all(not column["aliases"] for column in entry["contract"]["columns"])


def test_jms_no_movement_contract_is_a_new_snapshot_v2():
    contract = CONTRACTS["no_movement"]
    assert contract.version == 2
    assert contract.workbook_name == "painel_sem_movimentacao.xlsx"
    assert contract.sheet_name == "Dados"
    assert contract.history_policy == "SNAPSHOT_REPLACE_ALL"
    assert len(contract.columns) == 18
    assert contract.expected_sample_rows is None


def test_latest_jms_reference_workbook_reconciles_snapshot_metrics():
    if not NO_MOVEMENT_REFERENCE_WORKBOOK.is_file():
        pytest.skip("Set DATA_FOUNDATION_NO_MOVEMENT_WORKBOOK to the supplied JMS workbook")
    imported: list[ValidImportRow] = []
    summary = parse_workbook(
        NO_MOVEMENT_REFERENCE_WORKBOOK.read_bytes(),
        CONTRACTS["no_movement"],
        MappingResolver(map_version_id=b"0123456789abcdef"),
        on_valid_row=imported.append,
    )

    assert summary.input_row_count == summary.valid_row_count == 162
    assert summary.invalid_row_count == 0
    assert summary.duplicate_base_code_count == 9
    assert summary.exact_duplicate_count == 0
    assert summary.workbook_validation_errors == []
    assert summary.can_publish is True
    assert summary.collection_date is not None
    assert summary.bot_executed_at is not None
    assert len(imported) == 162
    assert len({str(row.values["source_base_code"]) for row in imported}) == 153

    totals = {
        key: sum(int(row.values[key]) for row in imported)
        for key in (
            "stopped_orders", "orders_in_transit", "stopped_over_2_days", "stopped_over_3_days",
            "stopped_over_4_days", "stopped_over_5_days", "stopped_over_6_days", "stopped_over_7_days",
            "stopped_over_10_days", "stopped_over_14_days", "stopped_over_30_days",
        )
    }
    assert totals["stopped_orders"] == 13_316
    assert totals["orders_in_transit"] == 364_350
    assert sum(totals[key] for key in (
        "stopped_over_2_days", "stopped_over_3_days", "stopped_over_4_days", "stopped_over_5_days",
        "stopped_over_6_days", "stopped_over_7_days", "stopped_over_10_days", "stopped_over_14_days",
        "stopped_over_30_days",
    )) == 5_991
    assert totals["stopped_over_14_days"] == 902
    assert totals["stopped_over_30_days"] == 1_982
    assert len({str(row.values["reported_region"]) for row in imported}) == 10
    critical_codes = {
        str(row.values["source_base_code"])
        for row in imported
        if sum(int(row.values[key]) for key in (
            "stopped_over_2_days", "stopped_over_3_days", "stopped_over_4_days",
            "stopped_over_5_days", "stopped_over_6_days", "stopped_over_7_days",
            "stopped_over_10_days", "stopped_over_14_days", "stopped_over_30_days",
        )) > 0
    }
    assert len(critical_codes) == 133
    aging_keys = (
        "stopped_over_1_day", "stopped_over_2_days", "stopped_over_3_days", "stopped_over_4_days",
        "stopped_over_5_days", "stopped_over_6_days", "stopped_over_7_days", "stopped_over_10_days",
        "stopped_over_14_days", "stopped_over_30_days",
    )
    assert all(sum(int(row.values[key]) for key in aging_keys) == int(row.values["stopped_orders"]) for row in imported)
