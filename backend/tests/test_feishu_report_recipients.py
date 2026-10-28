import pytest

from app.core.config import Settings
from app.services.feishu_report_recipients import RECIPIENTS, recipient_from_audit, recipient_options, resolve_recipient


def _settings(**overrides):
    values = {
        "feishu_report_recipient_phelippe_enabled": True,
        "feishu_report_recipient_marcos_enabled": True,
        "feishu_report_recipient_alan_enabled": True,
        "feishu_report_recipient_national_rms_enabled": True,
        "feishu_report_recipient_sr_enabled": True,
        "feishu_report_recipient_mg_enabled": True,
        "feishu_report_recipient_ce_hq_enabled": True,
        "feishu_report_recipient_spn_enabled": True,
        "feishu_report_recipient_pr_enabled": True,
    }
    values.update(overrides)
    return Settings(**values)


def test_allowlist_contains_three_people_a_national_group_and_five_fixed_groups():
    assert [item.key for item in RECIPIENTS] == [
        "PHELIPPE_PRIVATE", "MARCOS_PRIVATE", "ALAN_PRIVATE", "NATIONAL_RMS", "SR_COLLECTION_GROUP",
        "MG_COLLECTION_GROUP", "CE_HQ_COLLECTION_GROUP", "SPN_COLLECTION_GROUP", "PR_COLLECTION_GROUP",
    ]
    assert RECIPIENTS[1].identifier == "marcos.sjunior@jtexpress.com.br"
    assert RECIPIENTS[2].identifier == "alan.vicente@jtexpress.com.br"
    assert RECIPIENTS[3].identifier == "oc_8474b27a4b40adb3ecb8c6577773d222"
    assert RECIPIENTS[3].label == "Grupo Nacional de RMs 全国RM — MATRIZ / Todas as regionais"
    assert RECIPIENTS[3].audit_name == "Grupo Nacional de RMs 全国RM"
    assert RECIPIENTS[3].national_only is True
    assert all(item.kind == "chat_id" for item in RECIPIENTS[3:])
    assert all("揽收沟通" in item.label for item in RECIPIENTS[4:])


def test_national_scope_exposes_people_and_only_the_enabled_national_group():
    options = recipient_options(None, _settings())
    assert all(item["available"] for item in options[:3])
    assert options[3]["available"] is True
    assert all(not item["available"] for item in options[4:])
    assert all(item["unavailableReason"] == "recipient_region_unavailable" for item in options[4:])


def test_national_group_is_explicitly_flagged_and_cannot_receive_regional_scope():
    from app.services.feishu_report_recipients import resolve_recipient

    group = resolve_recipient("NATIONAL_RMS", None, _settings())
    assert group.kind == "chat_id"
    assert group.identifier == "oc_8474b27a4b40adb3ecb8c6577773d222"
    assert group.region_code is None and group.national_only
    assert recipient_from_audit(group.key, None, group.kind, group.identifier, group.audit_name, None, _settings()) == group
    for region in ("SPS", "SR", "MG"):
        option = next(item for item in recipient_options(region, _settings()) if item["key"] == "NATIONAL_RMS")
        assert option["available"] is False
        with pytest.raises(ValueError, match="feishu_report_recipient_region_mismatch"):
            resolve_recipient("NATIONAL_RMS", region, _settings())

    disabled = _settings(feishu_report_recipient_national_rms_enabled=False)
    option = next(item for item in recipient_options(None, disabled) if item["key"] == "NATIONAL_RMS")
    assert option["available"] is False
    assert option["unavailableReason"] == "recipient_disabled_by_configuration"
    with pytest.raises(ValueError, match="feishu_report_recipient_disabled"):
        resolve_recipient("NATIONAL_RMS", None, disabled)


def test_national_recipient_flag_defaults_off():
    assert Settings(_env_file=None).feishu_report_recipient_national_rms_enabled is False


@pytest.mark.parametrize(("region", "key"), [
    ("SR", "SR_COLLECTION_GROUP"),
    ("MG", "MG_COLLECTION_GROUP"), ("CE", "CE_HQ_COLLECTION_GROUP"),
    ("SPN", "SPN_COLLECTION_GROUP"), ("PR", "PR_COLLECTION_GROUP"),
])
def test_regional_group_is_available_only_for_its_confirmed_region(region, key):
    settings = _settings()
    group = next(option for option in recipient_options(region, settings) if option["key"] == key)
    assert group["available"] is True
    resolved = resolve_recipient(key, region, settings)
    assert resolved.kind == "chat_id"
    assert resolved.region_code == region
    with pytest.raises(ValueError, match="feishu_report_recipient_region_mismatch"):
        resolve_recipient(key, "SPS", settings)


def test_sr_is_only_available_for_its_own_region_and_requires_its_group_flag():
    enabled = _settings(feishu_report_recipient_sr_enabled=True)
    sr = next(item for item in recipient_options("SR", enabled) if item["key"] == "SR_COLLECTION_GROUP")
    assert sr["available"] is True
    assert resolve_recipient("SR_COLLECTION_GROUP", "SR", enabled).identifier == "oc_cf854b86072f21b49d9f4c926b0c192b"

    national = next(item for item in recipient_options(None, enabled) if item["key"] == "SR_COLLECTION_GROUP")
    elsewhere = next(item for item in recipient_options("SPS", enabled) if item["key"] == "SR_COLLECTION_GROUP")
    assert national["available"] is False
    assert elsewhere["available"] is False
    with pytest.raises(ValueError, match="feishu_report_recipient_region_mismatch"):
        resolve_recipient("SR_COLLECTION_GROUP", "SPS", enabled)

    disabled = _settings(feishu_report_recipient_sr_enabled=False)
    blocked = next(item for item in recipient_options("SR", disabled) if item["key"] == "SR_COLLECTION_GROUP")
    assert blocked["available"] is False
    assert blocked["unavailableReason"] == "recipient_disabled_by_configuration"
    with pytest.raises(ValueError, match="feishu_report_recipient_disabled"):
        resolve_recipient("SR_COLLECTION_GROUP", "SR", disabled)


def test_ce_hq_is_limited_to_ce_not_national_or_hq():
    settings = _settings()
    assert next(item for item in recipient_options("CE", settings) if item["key"] == "CE_HQ_COLLECTION_GROUP")["available"]
    assert not next(item for item in recipient_options(None, settings) if item["key"] == "CE_HQ_COLLECTION_GROUP")["available"]
    with pytest.raises(ValueError, match="feishu_report_recipient_region_mismatch"):
        resolve_recipient("CE_HQ_COLLECTION_GROUP", "HQ", settings)


def test_each_group_can_be_released_independently_and_revoked():
    settings = _settings(feishu_report_recipient_mg_enabled=True, feishu_report_recipient_pr_enabled=False)
    assert next(item for item in recipient_options("MG", settings) if item["key"] == "MG_COLLECTION_GROUP")["available"]
    pr = next(item for item in recipient_options("PR", settings) if item["key"] == "PR_COLLECTION_GROUP")
    assert pr["available"] is False
    assert pr["unavailableReason"] == "recipient_disabled_by_configuration"
    with pytest.raises(ValueError, match="feishu_report_recipient_disabled"):
        resolve_recipient("PR_COLLECTION_GROUP", "PR", settings)


def test_individual_destination_flags_are_independent():
    settings = _settings(feishu_report_recipient_marcos_enabled=False, feishu_report_recipient_alan_enabled=True)
    options = {item["key"]: item for item in recipient_options(None, settings)}
    assert options["MARCOS_PRIVATE"]["available"] is False
    assert options["ALAN_PRIVATE"]["available"] is True
    with pytest.raises(ValueError, match="feishu_report_recipient_disabled"):
        resolve_recipient("MARCOS_PRIVATE", None, settings)


def test_audit_snapshot_must_match_fixed_server_destination_and_supports_old_private_rows():
    settings = _settings()
    marcos = resolve_recipient("MARCOS_PRIVATE", None, settings)
    assert recipient_from_audit(marcos.key, None, marcos.kind, marcos.identifier, marcos.label, marcos.identifier, settings) == marcos
    with pytest.raises(ValueError, match="feishu_report_recipient_changed"):
        recipient_from_audit(marcos.key, None, "chat_id", marcos.identifier, marcos.label, None, settings)
    phelippe = resolve_recipient("PHELIPPE_PRIVATE", None, settings)
    assert recipient_from_audit(phelippe.key, None, None, None, None, phelippe.identifier, settings) == phelippe
