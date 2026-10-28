"""Server-side allowlist and scope checks for audited Feishu report delivery."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.core.config import Settings, get_settings
from app.services.feishu_publication_notifications import RECIPIENT_EMAIL


@dataclass(frozen=True)
class Recipient:
    key: str
    label: str
    kind: str
    identifier: str
    enabled_setting: str | None = None
    region_code: str | None = None
    mapping_confirmed: bool = True
    national_only: bool = False
    audit_name: str | None = None


RECIPIENTS: tuple[Recipient, ...] = (
    Recipient("PHELIPPE_PRIVATE", "Phelippe · Pessoa / 个人", "email", RECIPIENT_EMAIL, "feishu_report_recipient_phelippe_enabled"),
    Recipient("MARCOS_PRIVATE", "Marcos · Pessoa / 个人", "email", "marcos.sjunior@jtexpress.com.br", "feishu_report_recipient_marcos_enabled"),
    Recipient("ALAN_PRIVATE", "Alan · Pessoa / 个人", "email", "alan.vicente@jtexpress.com.br", "feishu_report_recipient_alan_enabled"),
    Recipient("NATIONAL_RMS", "Grupo Nacional de RMs 全国RM — MATRIZ / Todas as regionais", "chat_id", "oc_8474b27a4b40adb3ecb8c6577773d222", "feishu_report_recipient_national_rms_enabled", national_only=True, audit_name="Grupo Nacional de RMs 全国RM"),
    Recipient("SR_COLLECTION_GROUP", "SR 揽收沟通群 · Coordenação de Coleta - First Mile", "chat_id", "oc_cf854b86072f21b49d9f4c926b0c192b", "feishu_report_recipient_sr_enabled", region_code="SR"),
    Recipient("MG_COLLECTION_GROUP", "MG 揽收沟通群 · Coordenação de Coleta First Mile", "chat_id", "oc_d3ef49bb0698066065c5556ce484c6ed", "feishu_report_recipient_mg_enabled", region_code="MG"),
    Recipient("CE_HQ_COLLECTION_GROUP", "【CE+HQ】揽收沟通 · Coordenação de Coleta", "chat_id", "oc_eccb8d1014d79126eb0cec51c540dea9", "feishu_report_recipient_ce_hq_enabled", region_code="CE"),
    Recipient("SPN_COLLECTION_GROUP", "SPN 揽收沟通群 · Coordenação de Coleta - First Mile", "chat_id", "oc_3f9337ae49aa097b5d0b56c153bbb73b", "feishu_report_recipient_spn_enabled", region_code="SPN"),
    Recipient("PR_COLLECTION_GROUP", "PR 揽收沟通群 · Coordenação de Coleta - First Mile", "chat_id", "oc_422e75322f6829d105a6954f4a02a457", "feishu_report_recipient_pr_enabled", region_code="PR"),
)
_BY_KEY = {recipient.key: recipient for recipient in RECIPIENTS}


def _is_enabled(recipient: Recipient, settings: Settings) -> bool:
    return True if recipient.enabled_setting is None else bool(getattr(settings, recipient.enabled_setting, False))


def recipient_options(region_code: str | None, settings: Settings | None = None) -> list[dict[str, Any]]:
    config = settings or get_settings()
    result: list[dict[str, Any]] = []
    for recipient in RECIPIENTS:
        if recipient.kind == "email":
            scope_matches = True
        elif recipient.national_only:
            scope_matches = region_code is None and recipient.mapping_confirmed
        else:
            scope_matches = bool(region_code) and recipient.mapping_confirmed and recipient.region_code == region_code
        enabled = _is_enabled(recipient, config)
        available = scope_matches and enabled
        if recipient.kind == "chat_id" and not recipient.mapping_confirmed:
            reason = "recipient_mapping_pending"
        elif not scope_matches:
            reason = "recipient_region_unavailable" if recipient.kind == "chat_id" else None
        elif not enabled:
            reason = "recipient_disabled_by_configuration"
        else:
            reason = None
        result.append({
            "key": recipient.key,
            "label": recipient.label,
            "type": recipient.kind,
            "available": available,
            "unavailableReason": reason,
            "regionCode": recipient.region_code,
        })
    return result


def resolve_recipient(recipient_key: str, region_code: str | None, settings: Settings | None = None) -> Recipient:
    config = settings or get_settings()
    recipient = _BY_KEY.get(recipient_key)
    if recipient is None:
        raise ValueError("feishu_report_recipient_invalid")
    if not _is_enabled(recipient, config):
        raise ValueError("feishu_report_recipient_disabled")
    if recipient.kind == "chat_id":
        if not recipient.mapping_confirmed:
            raise ValueError("feishu_report_recipient_mapping_pending")
        if recipient.national_only and region_code is not None:
            raise ValueError("feishu_report_recipient_region_mismatch")
        if not recipient.national_only and (not region_code or region_code != recipient.region_code):
            raise ValueError("feishu_report_recipient_region_mismatch")
    return recipient


def recipient_from_audit(
    recipient_key: str, region_code: str | None, recipient_type: object, recipient_identifier: object,
    recipient_name: object, legacy_email: object, settings: Settings | None = None,
) -> Recipient:
    """Resolve the fixed key again and verify persisted destination snapshot.

    Null new audit columns are accepted only for legacy email rows created before
    the additive schema update. They can never resolve to a group destination.
    """
    try:
        recipient = resolve_recipient(recipient_key, region_code, settings)
    except ValueError as error:
        raise ValueError(str(error)) from None
    if recipient_type is None and recipient_identifier is None and recipient_name is None:
        if recipient.kind == "email" and str(legacy_email or "") == recipient.identifier:
            return recipient
        raise ValueError("feishu_report_recipient_invalid")
    if (str(recipient_type or "") != recipient.kind
            or str(recipient_identifier or "") != recipient.identifier
            or str(recipient_name or "") != (recipient.audit_name or recipient.label)):
        raise ValueError("feishu_report_recipient_changed")
    if recipient.kind == "email" and str(legacy_email or "") != recipient.identifier:
        raise ValueError("feishu_report_recipient_changed")
    if recipient.kind == "chat_id" and legacy_email not in (None, ""):
        raise ValueError("feishu_report_recipient_changed")
    return recipient
