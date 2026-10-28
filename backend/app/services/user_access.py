from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import PlatformUser, PlatformUserFeishuProfile, Region, UserAccessAudit, UserRegionAccess
from app.services.feishu_regions import (
    DEPARTMENT_REGION_IDS,
    MATRIX_REGION_CODE,
    resolve_organizational_region_v2,
)


class UserAccessError(Exception):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def provision_feishu_user(db: Session, identity: dict[str, Any]) -> PlatformUser:
    tenant_key = str(identity.get("_tenant_key") or "").strip()
    open_id = str(identity.get("_open_id") or "").strip()
    email = str(identity.get("_email") or "").strip().lower()
    display_name = str(identity.get("username") or email).strip() or email
    if not tenant_key or not open_id or not email:
        raise UserAccessError("feishu_identity_incomplete", 403)
    try:
        user = db.scalar(
            select(PlatformUser).where(
                PlatformUser.tenant_key == tenant_key,
                PlatformUser.open_id == open_id,
            )
        )
        if user is None:
            user = PlatformUser(
                tenant_key=tenant_key,
                open_id=open_id,
                email=email,
                display_name=display_name,
                platform_role="USER",
                # The existing ENUM has no unassigned value. base + NULL
                # is a fail-closed placeholder until an administrator assigns scope.
                organizational_scope="base",
                home_region=None,
                home_base=None,
                is_active=True,
            )
            db.add(user)
            try:
                db.flush()
            except IntegrityError:
                db.rollback()
                user = db.scalar(
                    select(PlatformUser).where(
                        PlatformUser.tenant_key == tenant_key,
                        PlatformUser.open_id == open_id,
                    )
                )
                if user is None:
                    raise
        if not user.is_active:
            db.rollback()
            raise UserAccessError("user_inactive", 403)

        # Feishu supplies verified identity attributes only. Authorization
        # fields remain administrator-managed and are never changed at login.
        user.email = email
        user.display_name = display_name
        db.commit()
        db.refresh(user)
        return user
    except UserAccessError:
        raise
    except SQLAlchemyError:
        db.rollback()
        raise UserAccessError("user_store_unavailable", 503) from None


def additional_regions_for_user(db: Session, user_id: int) -> list[str]:
    try:
        return list(
            db.scalars(
                select(UserRegionAccess.region_code)
                .join(Region, Region.region_code == UserRegionAccess.region_code)
                .where(UserRegionAccess.user_id == user_id, Region.is_active.is_(True))
                .order_by(UserRegionAccess.region_code)
            )
        )
    except SQLAlchemyError:
        raise UserAccessError("user_store_unavailable", 503) from None


def _recent_feishu_region(profile: PlatformUserFeishuProfile | None) -> tuple[str | None, str]:
    if profile is None:
        return None, "none"
    status = str(profile.region_resolution_status or "").strip().upper()
    # A previously resolved department is never an authorization fallback
    # while Contacts synchronization is failing. Explicit audited grants are
    # resolved separately by identity_for_user and remain region-limited.
    if status != "RESOLVED":
        return None, "none"
    if profile.last_successful_sync_at is None:
        return None, "none"

    code = str(profile.organizational_region_code or "").strip().upper()
    approved_codes = {MATRIX_REGION_CODE, *(value.upper() for value in DEPARTMENT_REGION_IDS.values())}
    if code not in approved_codes:
        return None, "none"
    return code, "feishu"


def _profile_sync_is_fresh(
    profile: PlatformUserFeishuProfile | None,
    *,
    ttl_seconds: int,
    now: datetime,
) -> bool:
    if profile is None or profile.last_successful_sync_at is None:
        return False
    if str(profile.region_resolution_status or "").upper() == "SYNC_FAILED":
        return False
    synced_at = profile.last_successful_sync_at
    if synced_at.tzinfo is None:
        synced_at = synced_at.replace(tzinfo=timezone.utc)
    current = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    age_seconds = (current - synced_at).total_seconds()
    return 0 <= age_seconds < ttl_seconds


def identity_for_user(
    db: Session,
    user: PlatformUser,
    *,
    force_feishu_sync_failed: bool = False,
    org_scope_v2_enabled: bool | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    use_v2 = settings.feishu_org_scope_v2_enabled if org_scope_v2_enabled is None else org_scope_v2_enabled
    extras = additional_regions_for_user(db, user.id)
    administrative_scope = str(user.organizational_scope or "").strip().lower()
    profile = None
    try:
        profile = db.get(PlatformUserFeishuProfile, user.id)
    except SQLAlchemyError:
        # A profile-store failure must never broaden access.
        db.rollback()

    scope_reason = "legacy_policy"
    if use_v2:
        current_time = now or datetime.now(timezone.utc)
        organizational_region_code = None
        if force_feishu_sync_failed:
            region_resolution_status = "SYNC_FAILED"
            scope_reason = "contacts_sync_failed"
            resolution_code = None
        elif not _profile_sync_is_fresh(
            profile,
            ttl_seconds=settings.feishu_org_scope_profile_ttl_seconds,
            now=current_time,
        ):
            region_resolution_status = "UNKNOWN"
            scope_reason = "profile_expired"
            resolution_code = None
        else:
            resolution = resolve_organizational_region_v2(profile.department_paths if profile else None)
            organizational_region_code = resolution.region_code
            region_resolution_status = resolution.status
            scope_reason = resolution.reason
            resolution_code = resolution.region_code
        feishu_region_code = resolution_code
        scope_source = "feishu_v2" if feishu_region_code else "none"
    else:
        organizational_region_code = profile.organizational_region_code if profile else None
        region_resolution_status = (
            "SYNC_FAILED" if force_feishu_sync_failed
            else profile.region_resolution_status if profile
            else "UNKNOWN"
        )
        feishu_region_code, scope_source = (
            (None, "none") if force_feishu_sync_failed else _recent_feishu_region(profile)
        )

    if feishu_region_code and feishu_region_code != MATRIX_REGION_CODE:
        try:
            active_region = db.scalar(
                select(Region.region_code).where(
                    Region.region_code == feishu_region_code,
                    Region.is_active.is_(True),
                )
            )
        except SQLAlchemyError:
            db.rollback()
            active_region = None
        if not active_region:
            feishu_region_code = None
            scope_source = "none"
            if use_v2:
                organizational_region_code = None
                region_resolution_status = "UNKNOWN"
                scope_reason = "region_not_active"

    # Under V2 an unresolved hierarchy never falls back to manual grants.
    # With V2 disabled, the established audited-grant fallback is unchanged.
    if feishu_region_code == MATRIX_REGION_CODE:
        scope = "matrix"
        home_region = None
        home_base = None
    elif feishu_region_code:
        scope = "regional"
        home_region = feishu_region_code
        home_base = None
    elif not use_v2 and extras:
        scope = "regional"
        home_region = None
        home_base = None
        scope_source = "admin_grant"
    else:
        scope = "unknown"
        home_region = None
        home_base = None

    role = "matrix" if scope == "matrix" else "regional" if scope == "regional" else "unknown"
    if scope == "matrix":
        effective_regions: list[str] | None = None
    else:
        if scope_source in {"feishu", "feishu_v2"}:
            authorized_regions = [home_region]
        elif not use_v2:
            authorized_regions = extras
        else:
            authorized_regions = []
        effective_regions = sorted({region for region in authorized_regions if region})
    identity = {
        "user_id": user.id,
        "username": user.display_name,
        "role": role,
        "region": home_region,
        "base": home_base,
        "platform_role": user.platform_role,
        "administrative_scope": administrative_scope,
        "organizational_scope": scope,
        "home_region": home_region,
        "home_base": home_base,
        "additional_regions": extras,
        "effective_regions": effective_regions,
        "is_active": bool(user.is_active),
        "organizational_region_code": organizational_region_code,
        "region_resolution_status": region_resolution_status,
        "organizational_scope_reason": scope_reason,
        "organizational_scope_policy": "V2" if use_v2 else "LEGACY",
        "data_scope_source": scope_source,
    }
    delegated_regions = _delegated_administration_regions(identity)
    identity["can_manage_users"] = bool(
        user.platform_role == "ADMIN"
        and (administrative_scope == "matrix" or delegated_regions)
    )
    return identity


def _delegated_administration_regions(identity: dict[str, Any]) -> list[str] | None:
    if identity["platform_role"] == "ADMIN" and identity["administrative_scope"] == "matrix":
        return None
    if not get_settings().regional_user_administration_enabled:
        return []
    regions = set(identity["additional_regions"] or [])
    if (
        identity["organizational_scope"] == "regional"
        and identity["data_scope_source"] in {"feishu", "feishu_v2"}
        and identity["home_region"]
    ):
        regions.add(identity["home_region"])
    return sorted(regions)


def user_administration_identity(db: Session, actor: PlatformUser) -> dict[str, Any]:
    """Resolve administrative authority from the current user store, never a request payload."""
    current = db.get(PlatformUser, actor.id, populate_existing=True)
    if current is None or not current.is_active or current.platform_role != "ADMIN":
        raise UserAccessError("admin_required", 403)
    identity = identity_for_user(db, current)
    delegated_regions = _delegated_administration_regions(identity)
    if delegated_regions is None:
        identity["administrative_regions"] = None
        return identity
    identity["administrative_regions"] = delegated_regions
    if not identity["administrative_regions"]:
        if not get_settings().regional_user_administration_enabled:
            raise UserAccessError("regional_user_administration_disabled", 403)
        raise UserAccessError("user_admin_scope_unavailable", 403)
    return identity


def can_administer_user(
    administrator: dict[str, Any], target: PlatformUser, target_identity: dict[str, Any],
) -> bool:
    if administrator["administrative_scope"] == "matrix" and administrator["platform_role"] == "ADMIN":
        return True
    regions = set(target_identity["effective_regions"] or [])
    return bool(
        target.platform_role == "USER"
        and target_identity["organizational_scope"] == "regional"
        and regions
        and regions.issubset(set(administrator.get("administrative_regions") or []))
    )


def update_user_access(
    db: Session,
    *,
    actor: PlatformUser,
    target_id: int,
    platform_role: str | None,
    additional_regions: list[str] | None,
    is_active: bool | None,
) -> tuple[PlatformUser, list[str]]:
    try:
        # Serialize changes to administrators and the two affected users. Re-read
        # persisted roles under the lock so an old session cannot authorize a grant.
        locked_users = list(db.scalars(
            select(PlatformUser)
            .where(
                PlatformUser.id.in_([actor.id, target_id])
                | ((PlatformUser.platform_role == "ADMIN") & PlatformUser.is_active.is_(True))
            )
            .order_by(PlatformUser.id)
            .execution_options(populate_existing=True)
            .with_for_update()
        ))
        users_by_id = {user.id: user for user in locked_users}
        current_actor = users_by_id.get(actor.id)
        if current_actor is None:
            raise UserAccessError("admin_required", 403)
        authority = user_administration_identity(db, current_actor)
        target = users_by_id.get(target_id)
        if target is None:
            raise UserAccessError("user_not_found", 404)
        if target.id == current_actor.id:
            raise UserAccessError("admin_self_change_forbidden", 403)
        if not can_administer_user(authority, target, identity_for_user(db, target)):
            raise UserAccessError("user_admin_target_forbidden", 403)
        if authority["administrative_scope"] != "matrix" and (
            platform_role is not None or additional_regions is not None
        ):
            raise UserAccessError("regional_access_change_forbidden", 403)

        before_role = target.platform_role
        before_active = bool(target.is_active)
        # Include inactive grants in revocation/audit; filtering them here could
        # resurrect a revoked grant when its region is reactivated later.
        before_regions = set(db.scalars(
            select(UserRegionAccess.region_code).where(UserRegionAccess.user_id == target.id)
        ))
        requested_regions = before_regions

        if platform_role is not None and platform_role not in {"USER", "ADMIN"}:
            raise UserAccessError("user_platform_role_invalid", 422)
        if additional_regions is not None:
            normalized = [str(region).strip().upper() for region in additional_regions]
            if len(normalized) != len(set(normalized)):
                raise UserAccessError("user_regions_duplicate", 422)
            requested_regions = set(normalized)
            if target.organizational_scope == "matrix" and requested_regions:
                raise UserAccessError("matrix_user_cannot_have_extra_regions", 422)
            if target.home_region and target.home_region in requested_regions:
                raise UserAccessError("home_region_is_not_an_extra_region", 422)
            valid_regions = set(
                db.scalars(
                    select(Region.region_code).where(
                        Region.region_code.in_(requested_regions),
                        Region.is_active.is_(True),
                    )
                )
            ) if requested_regions else set()
            if valid_regions != requested_regions:
                raise UserAccessError("user_region_not_in_catalog", 422)

        next_role = platform_role if platform_role is not None else before_role
        next_active = is_active if is_active is not None else before_active
        if before_active and before_role == "ADMIN" and (next_role != "ADMIN" or not next_active):
            active_admins = int(db.scalar(
                select(func.count())
                .select_from(PlatformUser)
                .where(
                    PlatformUser.platform_role == "ADMIN",
                    PlatformUser.is_active.is_(True),
                )
            ) or 0)
            if active_admins <= 1:
                raise UserAccessError("last_active_admin_required", 409)
        added = sorted(requested_regions - before_regions)
        removed = sorted(before_regions - requested_regions)
        role_changed = next_role != before_role
        active_changed = next_active != before_active

        target.platform_role = next_role
        target.is_active = next_active
        if added:
            db.add_all([
                UserRegionAccess(
                    user_id=target.id,
                    region_code=region,
                    granted_by_user_id=actor.id,
                )
                for region in added
            ])
        if removed:
            db.execute(
                delete(UserRegionAccess).where(
                    UserRegionAccess.user_id == target.id,
                    UserRegionAccess.region_code.in_(removed),
                )
            )

        if role_changed or active_changed or added or removed:
            db.add(UserAccessAudit(
                actor_type="admin",
                actor_user_id=actor.id,
                target_user_id=target.id,
                action="access_updated",
                old_platform_role=before_role,
                new_platform_role=next_role,
                old_is_active=before_active,
                new_is_active=next_active,
                regions_added=added,
                regions_removed=removed,
            ))
        db.commit()
        db.refresh(target)
        return target, additional_regions_for_user(db, target.id)
    except UserAccessError:
        db.rollback()
        raise
    except SQLAlchemyError:
        db.rollback()
        raise UserAccessError("user_store_unavailable", 503) from None


def list_active_regions(db: Session) -> list[Region]:
    try:
        return list(
            db.scalars(
                select(Region)
                .where(Region.is_active.is_(True))
                .order_by(Region.display_name, Region.region_code)
            )
        )
    except SQLAlchemyError:
        raise UserAccessError("user_store_unavailable", 503) from None
