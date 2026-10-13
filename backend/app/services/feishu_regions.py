from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Iterable, Sequence


# Stable Feishu department identifiers copied from the approved Conecta DP
# reference. Descriptions are intentionally not used to resolve a region.
JT_BRASIL_ID = "od-33e90ac1a93b12c1b65347320e648498"
REGIONAL_SPONSOR_ID = "od-f0274f53c145deb39c05e626b61f0976"

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

_SPECIFIC_REGIONS = frozenset({"SPN", "SPE", "MG", "PA", "BA", "RJ", "CE", "PR"})
_GENERIC_REGIONS = frozenset({"SPS", "GP"})


@dataclass(frozen=True)
class RegionResolution:
    region_code: str | None
    status: str


def resolve_organizational_region(
    department_paths: Iterable[Sequence[str]] | None,
) -> RegionResolution:
    """Resolve only from known department IDs and explicit priority rules."""
    paths = [tuple(str(item) for item in path if item) for path in (department_paths or [])]
    all_ids = {department_id for path in paths for department_id in path}
    found = {DEPARTMENT_REGION_IDS[item] for item in all_ids if item in DEPARTMENT_REGION_IDS}
    specific = found & _SPECIFIC_REGIONS

    if len(specific) > 1:
        return RegionResolution(None, "AMBIGUOUS")
    if specific:
        return RegionResolution(next(iter(specific)), "RESOLVED")

    generic = found & _GENERIC_REGIONS
    if len(generic) > 1:
        return RegionResolution(None, "AMBIGUOUS")
    if generic:
        # GP is accepted only as the sole known regional department; a known
        # specific region always wins above.
        return RegionResolution(next(iter(generic)), "RESOLVED")

    sponsor_seen = any(REGIONAL_SPONSOR_ID in path for path in paths)
    # Every associated path must reach the corporate boundary. One complete
    # path cannot make an unrelated, incomplete path look like MATRIZ.
    matrix_paths_complete = bool(paths) and all(JT_BRASIL_ID in path for path in paths)
    if matrix_paths_complete and not sponsor_seen:
        return RegionResolution("MATRIZ", "RESOLVED")

    # A sponsor path, an incomplete path, or an unknown ID must never imply HQ.
    return RegionResolution(None, "UNKNOWN")
