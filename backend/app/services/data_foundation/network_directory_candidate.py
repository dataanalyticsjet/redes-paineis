"""Offline preparation of the official Network Directory DoomsDay candidate.

No database writes, publication, contract registration or active-map replacement.
Run: python -m app.services.data_foundation.network_directory_candidate
     --new-file NEW.xlsx --previous-file OLD.xlsx --output NEW.json
The output is a review artifact, never an approved mapping or a second live map.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import io
import json
import os
import uuid
from pathlib import Path, PurePosixPath
import zipfile

from app.services.data_foundation.contracts import CONTRACTS, NETWORK_DIRECTORY_CONTRACT
from app.services.data_foundation.mapping_resolution import normalize_mapping_name
from app.services.data_foundation.xlsx_parser import (
    MappingResolver, WorkbookValidationError, _date_1904, _date_style_ids,
    _excel_datetime, _iter_sheet_rows, _shared_strings, _sheet_path, parse_workbook,
)

SHEET_NAME = NETWORK_DIRECTORY_CONTRACT.sheet_name
HEADERS = NETWORK_DIRECTORY_CONTRACT.headers
FIELDS = tuple(c.key for c in NETWORK_DIRECTORY_CONTRACT.columns)
UNIT_TYPES = {"Franquia 加盟": "FRANCHISE", "Próprio 自营": "OWN", "PA": "PA", "DC": "DC", "SC": "SC"}
OPERATIONAL_BASE_TYPES = frozenset({"FRANCHISE", "OWN"})
ALL_UNIT_TYPES = frozenset(UNIT_TYPES.values())


@dataclass(frozen=True)
class NetworkDirectoryCandidate:
    file_sha256: str
    units: tuple[dict[str, object], ...]
    excluded_rows: tuple[dict[str, object], ...]
    errors: tuple[dict[str, object], ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "sourceId": "base_mapping_official", "candidateLabel": "Atualização do Depara",
            "candidateSchemaVersion": 1, "contractVersion": NETWORK_DIRECTORY_CONTRACT.version, "state": "LOCAL_REVIEW_REQUIRED",
            "approved": False, "canPublish": False, "mapVersionId": None,
            "fileSha256": self.file_sha256, "sheetName": SHEET_NAME,
            "headers": list(HEADERS), "units": list(self.units),
            "excludedRows": list(self.excluded_rows), "errors": list(self.errors),
            "counts": {
                "units": len(self.units),
                "operationalBases": sum(u["unit_type"] in OPERATIONAL_BASE_TYPES for u in self.units),
                "types": dict(sorted(Counter(str(u["unit_type"]) for u in self.units).items())),
                "statuses": dict(sorted(Counter(str(u["enabled_status_raw"]) for u in self.units).items())),
                "regions": dict(sorted(Counter(str(u["regional_name"]) for u in self.units).items())),
            },
        }


def parse_network_directory(content: bytes) -> NetworkDirectoryCandidate:
    """Strict 13-column reader; ignores unreliable worksheet dimension metadata."""
    if len(content) > 32 * 1024 * 1024:
        raise WorkbookValidationError("mapping_file_too_large", 413)
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError):
        raise WorkbookValidationError("workbook_file_invalid") from None
    units, excluded, errors = [], [], []
    with archive:
        if sum(i.file_size for i in archive.infolist()) > 128 * 1024 * 1024:
            raise WorkbookValidationError("workbook_uncompressed_size_exceeded", 413)
        if any(i.filename.startswith("/") or ".." in PurePosixPath(i.filename).parts for i in archive.infolist()):
            raise WorkbookValidationError("workbook_archive_path_invalid")
        rows = iter(_iter_sheet_rows(archive, _sheet_path(archive, SHEET_NAME), _shared_strings(archive), _date_style_ids(archive)))
        uses_1904 = _date_1904(archive)
        header_no, header = next(rows, (0, {}))
        if any(c.formula or c.invalid for c in header.values()) or header_no != 1 or tuple(header.get(i).value if i in header else None for i in range(13)) != HEADERS or any(i > 12 and c.value is not None for i, c in header.items()):
            raise WorkbookValidationError("network_directory_header_mismatch")
        for row_no, cells in rows:
            if not any(c.value is not None for c in cells.values()):
                continue
            def raw(index: int) -> object:
                cell = cells.get(index)
                if cell is None or cell.value is None:
                    return None
                if cell.date_style and isinstance(cell.value, Decimal):
                    try:
                        return _excel_datetime(cell.value, uses_1904).isoformat(sep=" ")
                    except ValueError:
                        raise WorkbookValidationError("network_directory_date_invalid") from None
                return str(cell.value) if isinstance(cell.value, Decimal) else cell.value
            values = [raw(i) for i in range(13)]
            # Only the known trailing timestamp residue is exempt from code validation.
            if all(v is None or v == "" for v in values[:12]) and not any(c.formula or c.invalid for c in cells.values()):
                excluded.append({"source_row_no": row_no, "reason": "TIMESTAMP_ONLY_RESIDUE", "raw": values})
                continue
            unit = dict(zip(FIELDS, values))
            unit["source_row_no"] = row_no
            unit["unit_type"] = UNIT_TYPES.get(str(unit["unit_type_raw"]), "UNKNOWN")
            unit["is_operational_base"] = unit["unit_type"] in OPERATIONAL_BASE_TYPES
            unit["enabled_state"] = "ENABLED" if unit["enabled_status_raw"] == "启用" else "UNCONFIRMED"
            for field, index in (("base_code", 0), ("base_name", 1)):
                value = values[index]
                if not isinstance(value, str) or not value.strip() or (field == "base_code" and (cells[index].numeric or value != value.strip())):
                    errors.append({"row": row_no, "field": field, "code": "exact_text_identifier_required"})
            for field, limit in (("base_code", 64), ("base_name", 191), ("regional_name", 64), ("rm_region", 96), ("rm_responsible", 160)):
                value = unit[field]
                if value is not None and (not isinstance(value, str) or len(value) > limit):
                    errors.append({"row": row_no, "field": field, "code": "existing_mapping_column_incompatible"})
            if unit["unit_type"] == "UNKNOWN" or unit["enabled_state"] == "UNCONFIRMED":
                errors.append({"row": row_no, "code": "unit_type_or_status_requires_official_definition"})
            if any(c.formula or c.invalid for c in cells.values()) or any(i > 12 and c.value is not None for i, c in cells.items()):
                errors.append({"row": row_no, "code": "formula_invalid_cell_or_extra_column"})
            units.append(unit)
    counts = Counter(u["base_code"] for u in units)
    errors.extend({"code": "duplicate_base_code", "base_code": code, "count": count} for code, count in counts.items() if count > 1)
    if not units:
        errors.append({"code": "network_directory_empty"})
    return NetworkDirectoryCandidate(hashlib.sha256(content).hexdigest(), tuple(units), tuple(excluded), tuple(errors))


def previous_mapping_entries(content: bytes) -> list[dict[str, object]]:
    """Read the historical contract unchanged, including its original Ativas sheet."""
    entries = []
    summary = parse_workbook(content, CONTRACTS["base_mapping_official"], on_valid_row=lambda row: entries.append(dict(row.values)))
    if not summary.can_publish or summary.duplicate_base_code_count:
        raise WorkbookValidationError("previous_mapping_invalid")
    return entries


def build_candidate_resolver(candidate: NetworkDirectoryCandidate, *, included_types: frozenset[str]) -> MappingResolver:
    """Offline simulations only; inclusion policy is explicit, never implied by Bases."""
    if candidate.errors or not included_types or not included_types <= ALL_UNIT_TYPES:
        raise WorkbookValidationError("candidate_not_eligible_for_simulation")
    units = [u for u in candidate.units if u["unit_type"] in included_types and u["enabled_state"] == "ENABLED"]
    exact, normalized = defaultdict(set), defaultdict(set)
    for u in units:
        exact[u["base_name"]].add(u["base_code"])
        normalized[normalize_mapping_name(u["base_name"])].add(u["base_code"])
    return MappingResolver(
        base_codes=frozenset(u["base_code"] for u in units),
        exact_base_name_candidates={n: tuple(sorted(c)) for n, c in exact.items()},
        normalized_base_name_candidates={n: tuple(sorted(c)) for n, c in normalized.items()},
    )


def audit_candidate(candidate: NetworkDirectoryCandidate, previous: list[dict[str, object]], *, previous_sha256: str, manual_decisions: list[dict[str, object]] | None = None) -> dict[str, object]:
    """Report every changed code without merging missing old entries into the candidate."""
    old = {u["base_code"]: u for u in previous}
    new = {u["base_code"]: u for u in candidate.units}
    changes = {}
    for field in ("base_name", "regional_name", "rm_region", "rm_responsible"):
        changes[field] = [{"base_code": c, "before": old[c].get(field), "after": new[c].get(field)} for c in sorted(old.keys() & new.keys()) if old[c].get(field) != new[c].get(field)]
    names = defaultdict(list)
    exact = defaultdict(list)
    for u in candidate.units:
        name = u["base_name"]
        if isinstance(name, str):
            names[normalize_mapping_name(name)].append(u["base_code"])
            exact[name].append(u["base_code"])
    required = ("base_name", "regional_name", "rm_region", "rm_responsible", "supervisor", "base_responsible")
    decisions = []
    for decision in manual_decisions or []:
        target = decision.get("target_base_code")
        source_name = str(decision.get("source_base_name") or "")
        candidates = exact.get(source_name) or names.get(normalize_mapping_name(source_name), [])
        old_candidates = [u["base_code"] for u in previous if u["base_name"] == source_name]
        if not old_candidates:
            old_candidates = [u["base_code"] for u in previous if normalize_mapping_name(str(u["base_name"])) == normalize_mapping_name(source_name)]
        compatible = decision.get("resolution_state") == "LINKED" and target in candidates and target in new
        same_dimensions = target in new and target in old and all(old[target].get(f) == new[target].get(f) for f in ("regional_name", "rm_region", "rm_responsible"))
        decisions.append({**decision, "candidateTargetPresent": target in new,
                          "candidateCodes": sorted(candidates), "compatibleTarget": compatible,
                          "becameAmbiguous": len(old_candidates) <= 1 < len(candidates),
                          "reviewRequired": True,
                          "compatibility": "COMPATIBLE_REVIEW_REQUIRED" if compatible and same_dimensions else "REVIEW_REQUIRED",
                          "targetRegionChanged": target in new and target in old and old[target].get("regional_name") != new[target].get("regional_name")})
    return {
        "previousSha256": previous_sha256, "previousCount": len(previous),
        "commonCodes": len(old.keys() & new.keys()),
        "newUnits": [new[c] for c in sorted(new.keys() - old.keys())],
        "missingUnits": [old[c] for c in sorted(old.keys() - new.keys())],
        "changes": changes,
        "duplicateNamesExact": {n: c for n, c in sorted(exact.items()) if len(c) > 1},
        "duplicateNamesNormalized": {n: c for n, c in sorted(names.items()) if len(c) > 1},
        "emptyFields": {f: [u["base_code"] for u in candidate.units if not str(u.get(f) or "").strip()] for f in required},
        "manualDecisionReview": decisions,
        "manualDecisionsAvailable": manual_decisions is not None,
        "publicationBlockers": [
            "Review additions, removals, changed fields and manual decisions before publication.",
            "The candidate must match the registered V2 contract and valid unit metadata.",
            "Publication requires an explicit confirmation and a fresh check of the current official pointer.",
            "Previous published maps and their operational references remain available as history.",
            "Organizational caches are invalidated after the official pointer changes.",
        ],
    }


def preview_on_connection(connection, candidate: NetworkDirectoryCandidate) -> dict[str, object]:
    from sqlalchemy import text
    from app.services.data_foundation.repository import current_mapping_version
    result = candidate.as_dict()
    if candidate.errors:
        return result
    map_id = current_mapping_version(connection)
    previous, decisions, previous_hash = [], [], None
    if map_id is not None:
        previous = [dict(row) for row in connection.execute(text("""
            SELECT base_code, base_name, regional_name, uf_code, rm_region, rm_responsible
            FROM base_mapping_entries WHERE map_version_id = :map_id ORDER BY base_code
        """), {"map_id": map_id}).mappings()]
        decisions = [dict(row) for row in connection.execute(text("""
            SELECT source_id, source_base_name, resolution_state, target_base_code
            FROM base_mapping_name_decisions WHERE map_version_id = :map_id
            ORDER BY source_id, source_base_name
        """), {"map_id": map_id}).mappings()]
        previous_hash = connection.execute(text("SELECT file_sha256 FROM base_mapping_versions WHERE map_version_id = :map_id"), {"map_id": map_id}).scalar_one()
    result["previousMapVersionId"] = str(uuid.UUID(bytes=map_id)) if map_id else None
    result["audit"] = audit_candidate(candidate, previous, previous_sha256=bytes(previous_hash).hex() if previous_hash else "", manual_decisions=decisions if map_id else None)
    # Bind review to immutable source + exact prior entries/decisions, not browser totals.
    result["reviewSha256"] = hashlib.sha256(json.dumps({
        "file":candidate.file_sha256, "map":result["previousMapVersionId"],
        "previous":previous, "decisions":decisions,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    result["requiresSchemaApproval"] = True
    result["requiresManualPublicationApproval"] = True
    return result


def preview_network_directory(engine, content: bytes) -> dict[str, object]:
    """Administrative read-only preview; never prepares or activates a version."""
    candidate = parse_network_directory(content)
    with engine.connect() as connection:
        return preview_on_connection(connection, candidate)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-file", type=Path, required=True)
    parser.add_argument("--previous-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    content = args.new_file.read_bytes()
    previous = args.previous_file.read_bytes()
    candidate = parse_network_directory(content)
    report = candidate.as_dict()
    report["sourceFileName"] = args.new_file.name
    report["audit"] = audit_candidate(candidate, previous_mapping_entries(previous), previous_sha256=hashlib.sha256(previous).hexdigest()) if not candidate.errors else {"comparisonSkipped": True, "reason": "candidate_validation_errors"}
    # Never overwrite a workbook or an earlier review artifact.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
