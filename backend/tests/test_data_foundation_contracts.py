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

    assert summary.input_row_count == contract.expected_sample_rows
    assert summary.valid_row_count == contract.expected_sample_rows
    assert summary.invalid_row_count == 0
    assert summary.exact_duplicate_count == expected_duplicates
    assert len(summary.per_date_counts) == expected_dates
    assert summary.mapped_row_count == 0
    assert summary.unmapped_row_count == contract.expected_sample_rows
    assert summary.can_publish is False


def test_code_matches_and_name_decisions_are_exact():
    resolver = MappingResolver(
        map_version_id=b"0123456789abcdef",
        base_codes=frozenset({"00123"}),
        exact_base_name_candidates={"Base A-SP": ("00123",)},
        name_decisions={"Base A-SP": ("LINKED", "00123")},
    )
    contract = CONTRACTS["collection_monitoring"]

    assert _resolve_mapping("collection_monitoring", {"source_base_name": "Base A-SP"}, resolver) == (
        "00123", "NAME_APPROVED"
    )
    assert _resolve_mapping("collection_monitoring", {"source_base_name": "base a-sp"}, resolver) == (
        None, "UNMAPPED"
    )
    assert "00123" in resolver.base_codes
    assert "123" not in resolver.base_codes
    assert contract.headers[2] == "PDD de saida"
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(exact_base_name_candidates={"Base A-SP": ("00123",)}),
    ) == (None, "UNAPPROVED_EXACT_NAME")
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(
            exact_base_name_candidates={"Base A-SP": ("00123",)},
            name_decisions={"Base A-SP": ("LINKED", "00999")},
        ),
    ) == (None, "UNAPPROVED_EXACT_NAME")
    assert _resolve_mapping(
        "collection_monitoring", {"source_base_name": "Base A-SP"},
        MappingResolver(
            exact_base_name_candidates={"Base A-SP": ("00123", "00456")},
            name_decisions={"Base A-SP": ("LINKED", "00123")},
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


@pytest.mark.parametrize(
    ("source_id", "expected_mapped_rows", "expected_unmapped_rows"),
    [
        ("collection_monitoring", 0, 3877),
        ("collection_rate", 0, 3269),
        ("jt_monitoring", 0, 159666),
        ("no_movement", 141, 10),
        ("pdd_collection_failure", 1598, 19),
    ],
)
def test_five_source_previews_use_exact_shared_mapping_only(
    source_id, expected_mapped_rows, expected_unmapped_rows, doomsday_resolver
):
    contract = CONTRACTS[source_id]
    path = OFFICIAL_WORKBOOK_ROOT / contract.workbook_name
    if not path.is_file():
        pytest.skip(f"Official workbook not found: {contract.workbook_name}")

    summary = parse_workbook(path.read_bytes(), contract, doomsday_resolver)

    assert summary.input_row_count == contract.expected_sample_rows
    assert summary.valid_row_count == contract.expected_sample_rows
    assert summary.invalid_row_count == 0
    assert summary.mapped_row_count == expected_mapped_rows
    assert summary.unmapped_row_count == expected_unmapped_rows
    assert summary.can_publish is True
    if source_id in {"collection_monitoring", "collection_rate", "jt_monitoring"}:
        # Exact name candidates are only candidates. No row is regionally
        # resolved until a human decision is explicitly stored and approved.
        assert summary.exact_name_candidate_row_count > 0
        assert summary.no_mapping_match_row_count > 0
        assert summary.mapped_row_count == 0
    else:
        assert summary.exact_name_candidate_row_count == 0
        assert summary.no_mapping_match_row_count == expected_unmapped_rows


def test_name_candidates_are_reported_but_never_approved_implicitly():
    resolver = MappingResolver(
        map_version_id=b"0123456789abcdef",
        exact_base_name_candidates={"Base A-SP": ("00123",)},
    )
    assert _resolve_mapping(
        "jt_monitoring", {"source_base_name": "Base A-SP"}, resolver
    ) == (None, "UNAPPROVED_EXACT_NAME")
    assert _resolve_mapping(
        "jt_monitoring", {"source_base_name": "Base a-SP"}, resolver
    ) == (None, "UNMAPPED")


def test_manual_name_decision_requires_unique_exact_target_and_review_note():
    validate_name_mapping_decision(
        source_id="collection_monitoring",
        source_base_name="Base A-SP",
        resolution_state="LINKED",
        target_base_code="00123",
        candidate_codes=("00123",),
        review_note="Conferido por operador.",
    )
    with pytest.raises(DataFoundationError, match="mapping_target_must_be_unique_exact_match"):
        validate_name_mapping_decision(
            source_id="collection_monitoring",
            source_base_name="Base A-SP",
            resolution_state="LINKED",
            target_base_code="00999",
            candidate_codes=("00123",),
            review_note="Conferido.",
        )
    with pytest.raises(DataFoundationError, match="mapping_target_must_be_unique_exact_match"):
        validate_name_mapping_decision(
            source_id="collection_monitoring",
            source_base_name="Base A-SP",
            resolution_state="LINKED",
            target_base_code="00123",
            candidate_codes=("00123", "00456"),
            review_note="Conferido.",
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
        entry = entries[source_id]
        assert entry["source"]["sourceState"] == "PENDING"
        assert entry["contract"]["state"] == "DISCOVERED"
        assert entry["contract"]["sha256"] == contract_sha256(contract).hex()
        assert [column["sourceHeader"] for column in entry["contract"]["columns"]] == list(contract.headers)
        assert all(not column["aliases"] for column in entry["contract"]["columns"])
