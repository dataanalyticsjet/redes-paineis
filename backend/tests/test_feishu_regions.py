import pytest

from app.services.feishu_regions import (
    JT_BRASIL_ID,
    REGIONAL_SPONSOR_ID,
    resolve_organizational_region,
)


SPN = "od-3d75c10ce15130e199fc3b42e4e86a04"
SPS = "od-3ce772781fd5edda748adff1face448e"
PA = "od-efec880285b9a9d7efce49c5563f52ac"
GP = "od-bdac7b2d6ec6c2d295fd84033751573d"
PR = "od-f79058598e26448ec69b87708072e188"
RJ = "od-d5bcd25dd039564533842c835a1296b7"
SPE = "od-5fac219620d9274fcdd7631895ef59d3"
MG = "od-7d5b679dc3564de403ddf11270a3f4ea"
BA = "od-9fbc67c37122cd6e7460b6dc20c3f2cd"
CE = "od-5ddc00e36f5fd1f67fe075511f6f6188"
SPN_ALTERNATE = "od-fa1675bc30bde03e7a6f5a434f2a0535"


def test_spn_precedes_sps_and_pa_precedes_gp():
    assert resolve_organizational_region([[SPS, SPN]]).region_code == "SPN"
    assert resolve_organizational_region([[GP, PA]]).region_code == "PA"


@pytest.mark.parametrize(
    ("department_id", "expected"),
    [
        (SPN_ALTERNATE, "SPN"),
        (SPE, "SPE"),
        (MG, "MG"),
        (BA, "BA"),
        (RJ, "RJ"),
        (CE, "CE"),
        (PR, "PR"),
    ],
)
def test_all_remaining_documented_regional_ids_resolve(department_id, expected):
    assert resolve_organizational_region([[department_id]]).region_code == expected


def test_gp_is_only_used_as_sole_known_generic_fallback():
    assert resolve_organizational_region([[GP]]).region_code == "GP"
    assert resolve_organizational_region([[GP, SPS]]).status == "AMBIGUOUS"


def test_matrix_requires_jt_brasil_and_no_regional_sponsor():
    assert resolve_organizational_region([[JT_BRASIL_ID]]).region_code == "MATRIZ"
    assert resolve_organizational_region([[JT_BRASIL_ID, REGIONAL_SPONSOR_ID]]).status == "UNKNOWN"


def test_matrix_requires_every_associated_path_to_reach_jt_brasil():
    result = resolve_organizational_region([[JT_BRASIL_ID], ["external-root"]])
    assert result.region_code is None
    assert result.status == "UNKNOWN"


def test_unknown_and_sponsor_without_region_never_become_matrix():
    assert resolve_organizational_region([["unrecognized-id"]]).status == "UNKNOWN"
    assert resolve_organizational_region([[REGIONAL_SPONSOR_ID]]).status == "UNKNOWN"


def test_conflicting_specific_regions_are_ambiguous():
    result = resolve_organizational_region([[PA], [RJ]])
    assert result.region_code is None
    assert result.status == "AMBIGUOUS"


def test_unmapped_sr_is_not_inferred():
    assert resolve_organizational_region([["sr-department-id"]]).status == "UNKNOWN"


# Phase 2 confirmed organization IDs and path-specific precedence.
JT = "od-33e90ac1a93b12c1b65347320e648498"
MN = "od-930a0c1d13f1c393e942a8153e560641"
NORTHWEST = "od-bdac7b2d6ec6c2d295fd84033751573d"
V2_BA = "od-9fbc67c37122cd6e7460b6dc20c3f2cd"
V2_SPS = "od-3ce772781fd5edda748adff1face448e"
V2_SPE = "od-5fac219620d9274fcdd7631895ef59d3"
V2_SR = "od-bd07f18f063d7c4f8bc387114a993786"
V2_MG = "od-7d5b679dc3564de403ddf11270a3f4ea"
V2_SPN = "od-3099c86c91c4819fe25065ddc059690f"
V2_PA = "od-efec880285b9a9d7efce49c5563f52ac"
V2_GP = "od-489b1cc18987c2142d40aa16220a2bb8"
REGION_CHILD = "operational-child"


@pytest.mark.parametrize(
    ("department_id", "expected"),
    [
        (V2_BA, "BA"),
        (V2_SPS, "SPS"),
        (V2_SPE, "SPE"),
        (V2_SR, "SR"),
        (V2_MG, "MG"),
        (V2_SPN, "SPN"),
        (V2_GP, "GP"),
        (V2_PA, "PA"),
    ],
)
def test_v2_confirmed_department_ids_resolve_under_complete_jt_path(department_id, expected):
    from app.services.feishu_regions import resolve_organizational_region_v2

    result = resolve_organizational_region_v2([[JT, department_id, REGION_CHILD]])
    assert (result.region_code, result.status) == (expected, "RESOLVED")


def test_v2_northwest_defaults_to_gp_but_pa_descendant_overrides_it():
    from app.services.feishu_regions import resolve_organizational_region_v2

    assert resolve_organizational_region_v2([[JT, NORTHWEST, REGION_CHILD]]).region_code == "GP"
    assert resolve_organizational_region_v2([[JT, NORTHWEST, V2_PA, REGION_CHILD]]).region_code == "PA"
    assert resolve_organizational_region_v2([[JT, NORTHWEST, V2_GP, REGION_CHILD]]).region_code == "GP"


@pytest.mark.parametrize(("child", "expected"), [(V2_MG, "MG"), (V2_SPN, "SPN")])
def test_v2_mn_specific_children_resolve_but_direct_and_unmapped_mn_are_pending(child, expected):
    from app.services.feishu_regions import resolve_organizational_region_v2

    assert resolve_organizational_region_v2([[JT, MN, child, REGION_CHILD]]).region_code == expected
    direct = resolve_organizational_region_v2([[JT, MN]])
    functional = resolve_organizational_region_v2([[JT, MN, "unmapped-functional-child"]])
    assert direct.status == "UNKNOWN" and direct.reason == "mn_rule_pending"
    assert functional.status == "UNKNOWN" and functional.reason == "mn_rule_pending"


def test_v2_matrix_requires_only_the_confirmed_corporate_root_path():
    from app.services.feishu_regions import resolve_organizational_region_v2

    assert resolve_organizational_region_v2([[JT]]).region_code == "MATRIZ"
    assert resolve_organizational_region_v2([[JT, "unmapped-hq-department"]]).status == "UNKNOWN"


def test_v2_memberships_preserve_path_boundaries_and_reject_conflicts():
    from app.services.feishu_regions import resolve_organizational_region_v2

    assert resolve_organizational_region_v2([[JT, V2_SPS], [JT, V2_SPS, REGION_CHILD]]).region_code == "SPS"
    assert resolve_organizational_region_v2([[JT], [JT, V2_SPS]]).status == "AMBIGUOUS"
    assert resolve_organizational_region_v2([[JT, V2_MG], [JT, V2_SPN]]).status == "AMBIGUOUS"
    assert resolve_organizational_region_v2([[JT, V2_SPS], ["external", V2_SPS]]).status == "UNKNOWN"
    assert resolve_organizational_region_v2([[JT, REGIONAL_SPONSOR_ID, V2_SPS]]).region_code is None


def test_v2_incomplete_and_duplicate_paths_fail_closed():
    from app.services.feishu_regions import resolve_organizational_region_v2

    assert resolve_organizational_region_v2([[]]).status == "UNKNOWN"
    assert resolve_organizational_region_v2([[V2_SPS]]).status == "UNKNOWN"
    assert resolve_organizational_region_v2([[JT, V2_SPS, JT]]).status == "UNKNOWN"
