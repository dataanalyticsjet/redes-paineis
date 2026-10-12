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


def test_spn_precedes_sps_and_pa_precedes_gp():
    assert resolve_organizational_region([[SPS, SPN]]).region_code == "SPN"
    assert resolve_organizational_region([[GP, PA]]).region_code == "PA"


def test_gp_is_only_used_as_sole_known_generic_fallback():
    assert resolve_organizational_region([[GP]]).region_code == "GP"
    assert resolve_organizational_region([[GP, SPS]]).status == "AMBIGUOUS"


def test_matrix_requires_jt_brasil_and_no_regional_sponsor():
    assert resolve_organizational_region([[JT_BRASIL_ID]]).region_code == "MATRIZ"
    assert resolve_organizational_region([[JT_BRASIL_ID, REGIONAL_SPONSOR_ID]]).status == "UNKNOWN"


def test_unknown_and_sponsor_without_region_never_become_matrix():
    assert resolve_organizational_region([["unrecognized-id"]]).status == "UNKNOWN"
    assert resolve_organizational_region([[REGIONAL_SPONSOR_ID]]).status == "UNKNOWN"


def test_conflicting_specific_regions_are_ambiguous():
    result = resolve_organizational_region([[PA], [RJ]])
    assert result.region_code is None
    assert result.status == "AMBIGUOUS"


def test_unmapped_sr_is_not_inferred():
    assert resolve_organizational_region([["sr-department-id"]]).status == "UNKNOWN"
