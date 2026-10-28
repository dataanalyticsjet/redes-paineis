from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Iterable, Sequence


# Existing resolver and map are retained for the disabled legacy policy.
JT_BRASIL_ID = "od-33e90ac1a93b12c1b65347320e648498"
REGIONAL_SPONSOR_ID = "od-f0274f53c145deb39c05e626b61f0976"
MATRIX_REGION_CODE = "MATRIZ"

DEPARTMENT_REGION_IDS: dict[str, str] = {
    "od-3d75c10ce15130e199fc3b42e4e86a04": "SPN",
    "od-fa1675bc30bde03e7a6f5a434f2a0535": "SPN",
    "od-3ce772781fd5edda748adff1face448e": "SPS",
    "od-5fac219620d9274fcdd7631895ef59d3": "SPE",
    "od-7d5b679dc3564de403ddf11270a3f4ea": "MG",
    "od-efec880285b9a9d7efce49c5563f52ac": "PA",
    "od-9fbc67c37122cd6e7460b6dc20c3f2cd": "BA",
    "od-d5bcd25dd039564533842c835a1296b7": "RJ",
    "od-5ddc00e36f5fd1f67fe075511f6f6188": "CE",
    "od-f79058598e26448ec69b87708072e188": "PR",
    "od-bdac7b2d6ec6c2d295fd84033751573d": "GP",
}

# Phase 2 rules, versioned in code and gated by FEISHU_ORG_SCOPE_V2_ENABLED.
MN_GROUP_ID = "od-930a0c1d13f1c393e942a8153e560641"
V2_DEPARTMENT_REGION_IDS: dict[str, str] = {
    "od-9fbc67c37122cd6e7460b6dc20c3f2cd": "BA",
    "od-3ce772781fd5edda748adff1face448e": "SPS",
    "od-d5bcd25dd039564533842c835a1296b7": "RJ",
    "od-5ddc00e36f5fd1f67fe075511f6f6188": "CE",
    "od-f79058598e26448ec69b87708072e188": "PR",
    "od-bdac7b2d6ec6c2d295fd84033751573d": "GP",
    "od-5fac219620d9274fcdd7631895ef59d3": "SPE",
    "od-bd07f18f063d7c4f8bc387114a993786": "SR",
    "od-7d5b679dc3564de403ddf11270a3f4ea": "MG",
    "od-3099c86c91c4819fe25065ddc059690f": "SPN",
    "od-efec880285b9a9d7efce49c5563f52ac": "PA",
    "od-489b1cc18987c2142d40aa16220a2bb8": "GP",
}


@dataclass(frozen=True)
class RegionResolution:
    region_code: str | None
    status: str
    reason: str = "unresolved"


def resolve_organizational_region(
    department_paths: Iterable[Sequence[str]] | None,
) -> RegionResolution:
    """Resolve the legacy policy. Do not change while V2 remains opt-in."""
    paths = [tuple(str(item) for item in path if item) for path in (department_paths or [])]
    all_ids = {department_id for path in paths for department_id in path}
    found = {DEPARTMENT_REGION_IDS[item] for item in all_ids if item in DEPARTMENT_REGION_IDS}
    specific = found & frozenset({"SPN", "SPE", "MG", "PA", "BA", "RJ", "CE", "PR"})

    if len(specific) > 1:
        return RegionResolution(None, "AMBIGUOUS", "multiple_regions")
    if specific:
        return RegionResolution(next(iter(specific)), "RESOLVED", "legacy_specific_region")

    generic = found & frozenset({"SPS", "GP"})
    if len(generic) > 1:
        return RegionResolution(None, "AMBIGUOUS", "multiple_regions")
    if generic:
        return RegionResolution(next(iter(generic)), "RESOLVED", "legacy_generic_region")

    sponsor_seen = any(REGIONAL_SPONSOR_ID in path for path in paths)
    matrix_paths_complete = bool(paths) and all(JT_BRASIL_ID in path for path in paths)
    if matrix_paths_complete and not sponsor_seen:
        return RegionResolution("MATRIZ", "RESOLVED", "legacy_matrix")

    return RegionResolution(None, "UNKNOWN", "legacy_unresolved")


def resolve_organizational_region_v2(
    department_paths: Iterable[Sequence[str]] | None,
) -> RegionResolution:
    """Resolve each complete Feishu membership path independently and fail closed."""
    paths = [tuple(str(item).strip() for item in path if str(item).strip()) for path in (department_paths or [])]
    if not paths:
        return RegionResolution(None, "UNKNOWN", "no_department_paths")

    path_regions: list[str | None] = []
    saw_sponsor = False
    saw_mn_pending = False
    for path in paths:
        if not path or path[0] != JT_BRASIL_ID or len(path) != len(set(path)):
            return RegionResolution(None, "UNKNOWN", "path_incomplete")
        if REGIONAL_SPONSOR_ID in path:
            saw_sponsor = True
            path_regions.append(None)
            continue

        # Most-specific descendant wins only inside this single ancestry path.
        mapped = [(index, V2_DEPARTMENT_REGION_IDS[item]) for index, item in enumerate(path) if item in V2_DEPARTMENT_REGION_IDS]
        if mapped:
            path_regions.append(max(mapped, key=lambda item: item[0])[1])
        elif MN_GROUP_ID in path:
            saw_mn_pending = True
            path_regions.append(None)
        else:
            path_regions.append(None)

    if saw_sponsor:
        return RegionResolution(None, "UNKNOWN", "regional_sponsor")
    if saw_mn_pending:
        return RegionResolution(None, "UNKNOWN", "mn_rule_pending")

    resolved_regions = {region for region in path_regions if region}
    has_unresolved_path = any(region is None for region in path_regions)
    if has_unresolved_path:
        # A corporate path plus a regional path, or any unmapped membership,
        # cannot be reduced to one authorization by discarding a path.
        if resolved_regions:
            return RegionResolution(None, "AMBIGUOUS", "matrix_or_region_conflict")
        # The only matrix membership confirmed by the mapping audit is the
        # corporate root itself. Unmapped descendants require a reviewed rule.
        if all(path == (JT_BRASIL_ID,) for path in paths):
            return RegionResolution("MATRIZ", "RESOLVED", "matrix")
        return RegionResolution(None, "UNKNOWN", "unmapped_department")
    if len(resolved_regions) > 1:
        return RegionResolution(None, "AMBIGUOUS", "multiple_regions")
    if not resolved_regions:
        return RegionResolution(None, "UNKNOWN", "unmapped_department")
    return RegionResolution(next(iter(resolved_regions)), "RESOLVED", "regional")
