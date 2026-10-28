from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import PlatformUser, PlatformUserFeishuProfile, Region, UserAccessAudit, UserRegionAccess
from app.services.feishu_regions import (
    DEPARTMENT_REGION_IDS,
    MATRIX_REGION_CODE,
    resolve_organizational_region_v2,
)

_ADMIN_OVERRIDE_ACTIONS = frozenset({
    "regional_override_created",
    "regional_override_created_from_legacy",
    "regional_override_created_from_none",
    "regional_override_updated",
    "regional_override_removed",
    "regional_override_removed_to_none",
})
_ADMIN_OVERRIDE_ACTIVE_ACTIONS = frozenset({
    "regional_override_created",
    "regional_override_created_from_legacy",
    "regional_override_created_from_none",
    "regional_override_updated",
})


class UserAccessError(Exception):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _is_mysql_lock_conflict(error: OperationalError) -> bool:
    original = error.orig
    arguments = getattr(original, "args", ())
    error_number = arguments[0] if arguments and isinstance(arguments[0], int) else None
    sql_state = getattr(original, "sqlstate", None) or getattr(original, "pgcode", None)
    return error_number in {1205, 1213} or sql_state == "40001"


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


def additional_regions_for_user(
    db: Session,
    user_id: int,
    *,
    for_update: bool = False,
) -> list[str]:
    try:
        statement = (
            select(UserRegionAccess.region_code)
            .join(Region, Region.region_code == UserRegionAccess.region_code)
            .where(UserRegionAccess.user_id == user_id, Region.is_active.is_(True))
            .order_by(UserRegionAccess.region_code)
        )
        if for_update:
            statement = statement.with_for_update()
        return list(db.scalars(statement))
    except SQLAlchemyError:
        raise UserAccessError("user_store_unavailable", 503) from None


def administrative_region_override_for_user(
    db: Session,
    user_id: int,
    *,
    for_update: bool = False,
) -> tuple[bool, list[str]]:
    """Read the latest explicit override transition and its currently assigned regions.

    Old user_region_access rows predate replacement semantics and remain legacy
    grants until an administrator explicitly saves an override. The existing
    append-only user_access_audit table distinguishes those old rows without a
    new permission table or a schema migration.
    """
    try:
        transition_statement = (
            select(UserAccessAudit.action)
            .where(
                UserAccessAudit.target_user_id == user_id,
                UserAccessAudit.action.in_(_ADMIN_OVERRIDE_ACTIONS),
            )
            .order_by(UserAccessAudit.created_at.desc(), UserAccessAudit.id.desc())
            .limit(1)
        )
        if for_update:
            transition_statement = transition_statement.with_for_update()
        latest_transition = db.scalar(transition_statement)
        if latest_transition not in _ADMIN_OVERRIDE_ACTIVE_ACTIONS:
            return False, []
        regions_statement = (
            select(UserRegionAccess.region_code)
            .where(UserRegionAccess.user_id == user_id)
            .order_by(UserRegionAccess.region_code)
        )
        if for_update:
            regions_statement = regions_statement.with_for_update()
        regions = list(db.scalars(regions_statement))
        return True, regions
    except SQLAlchemyError:
        db.rollback()
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
    lock_access_state: bool = False,
) -> dict[str, Any]:
    settings = get_settings()
    use_v2 = settings.feishu_org_scope_v2_enabled if org_scope_v2_enabled is None else org_scope_v2_enabled
    extras = additional_regions_for_user(db, user.id, for_update=lock_access_state)
    admin_override_enabled, raw_admin_regions = administrative_region_override_for_user(
        db, user.id, for_update=lock_access_state
    )
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
            organizational_region_code = None
            region_resolution_status = "UNKNOWN"
            scope_reason = "region_not_active"

    # V2 never lets an administrative override bypass an unresolved, stale,
    # ambiguous, or failed Feishu profile. With V2 disabled the legacy policy
    # remains unchanged unless an administrator explicitly created an override.
    override_is_valid = admin_override_enabled and bool(raw_admin_regions)
    if override_is_valid and use_v2 and (
        region_resolution_status != "RESOLVED"
        or not feishu_region_code
        or scope_source not in {"feishu_v2"}
    ):
        override_is_valid = False
        scope_reason = scope_reason or "feishu_scope_required_for_override"

    active_admin_regions = set(extras)
    if override_is_valid and active_admin_regions != set(raw_admin_regions):
        # A saved override containing a disabled/non-catalog region cannot be
        # silently narrowed to a different set.
        override_is_valid = False

    if override_is_valid:
        scope = "regional"
        home_region = feishu_region_code if feishu_region_code != MATRIX_REGION_CODE else None
        home_base = None
        scope_source = "admin_override"
        effective_regions = sorted(set(raw_admin_regions))
    elif admin_override_enabled:
        # Fail closed for an invalid/empty override or a V2 identity whose
        # organizational profile is not eligible for a manual replacement.
        scope = "unknown"
        home_region = None
        home_base = None
        scope_source = "none"
        effective_regions = []
        if not raw_admin_regions:
            scope_reason = "admin_override_empty"
        elif not extras:
            scope_reason = "admin_override_region_inactive"
    elif feishu_region_code == MATRIX_REGION_CODE:
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
    elif not override_is_valid and not (admin_override_enabled and scope == "unknown"):
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
        "admin_override_enabled": admin_override_enabled,
        "admin_allowed_regions": sorted(set(raw_admin_regions)) if admin_override_enabled else [],
        "effective_scope_source": (
            "ADMIN_OVERRIDE" if override_is_valid else
            "LEGACY_GRANT" if scope_source == "admin_grant" else
            "FEISHU" if scope_source in {"feishu", "feishu_v2"} else
            "NONE"
        ),
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
    if identity.get("admin_override_enabled"):
        # Data-scope overrides must not grant or transfer delegated user
        # administration rights. Only the separately assigned matrix authority
        # above or the pre-existing Feishu/legacy delegation can do that.
        return []
    regions = set(identity["additional_regions"] or [])
    if (
        identity["organizational_scope"] == "regional"
        and identity["data_scope_source"] in {"feishu", "feishu_v2"}
        and identity["home_region"]
    ):
        regions.add(identity["home_region"])
    return sorted(regions)


def user_administration_identity(
    db: Session,
    actor: PlatformUser,
    *,
    lock_access_state: bool = False,
) -> dict[str, Any]:
    """Resolve administrative authority from the current user store, never a request payload."""
    current = db.get(PlatformUser, actor.id, populate_existing=True)
    if current is None or not current.is_active or current.platform_role != "ADMIN":
        raise UserAccessError("admin_required", 403)
    identity = identity_for_user(db, current, lock_access_state=lock_access_state)
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
    region_override: bool = False,
) -> tuple[PlatformUser, list[str]]:
    actor_id = int(actor.id)
    try:
        if db.new or db.dirty or db.deleted:
            raise UserAccessError("user_store_unavailable", 503)
        # Authentication and authorization dependencies may already have made
        # consistent reads in this request's Session. Start a fresh transaction
        # so no pre-lock REPEATABLE READ snapshot can drive the write decision.
        if db.in_transaction():
            db.rollback()
        transaction = db.begin()

        # Lock all active administrators first in primary-key order. Every
        # permission mutation takes this same global lock set, so role/status
        # changes serialize before target-specific rows are touched.
        locked_admins = list(db.scalars(
            select(PlatformUser)
            .where(
                PlatformUser.platform_role == "ADMIN",
                PlatformUser.is_active.is_(True),
            )
            .order_by(PlatformUser.id)
            .execution_options(populate_existing=True)
            .with_for_update()
        ))
        users_by_id = {user.id: user for user in locked_admins}
        remaining_ids = sorted({actor_id, target_id} - set(users_by_id))
        if remaining_ids:
            locked_remainder = list(db.scalars(
                select(PlatformUser)
                .where(PlatformUser.id.in_(remaining_ids))
                .order_by(PlatformUser.id)
                .execution_options(populate_existing=True)
                .with_for_update()
            ))
            users_by_id.update({user.id: user for user in locked_remainder})
        current_actor = users_by_id.get(actor_id)
        if current_actor is None:
            raise UserAccessError("admin_required", 403)
        authority = user_administration_identity(db, current_actor, lock_access_state=True)
        target = users_by_id.get(target_id)
        if target is None:
            raise UserAccessError("user_not_found", 404)
        if target.id == current_actor.id:
            raise UserAccessError("admin_self_change_forbidden", 403)
        target_identity_before = identity_for_user(db, target, lock_access_state=True)
        if not can_administer_user(authority, target, target_identity_before):
            raise UserAccessError("user_admin_target_forbidden", 403)
        if region_override and additional_regions and get_settings().feishu_org_scope_v2_enabled and (
            target_identity_before.get("region_resolution_status") != "RESOLVED"
            or target_identity_before.get("data_scope_source") != "feishu_v2"
        ):
            raise UserAccessError("user_region_override_feishu_unavailable", 409)
        if authority["administrative_scope"] != "matrix" and (
            platform_role is not None or additional_regions is not None
        ):
            raise UserAccessError("regional_access_change_forbidden", 403)

        before_role = target.platform_role
        before_active = bool(target.is_active)
        # Include inactive grants in revocation/audit; filtering them here could
        # resurrect a revoked grant when its region is reactivated later.
        before_regions = set(db.scalars(
            select(UserRegionAccess.region_code)
            .where(UserRegionAccess.user_id == target.id)
            .order_by(UserRegionAccess.region_code)
            .with_for_update()
        ))
        requested_regions = before_regions

        if platform_role is not None and platform_role not in {"USER", "ADMIN"}:
            raise UserAccessError("user_platform_role_invalid", 422)
        override_enabled_before, _override_regions_before = administrative_region_override_for_user(
            db, target.id, for_update=True
        )
        if additional_regions is not None:
            normalized = [str(region).strip().upper() for region in additional_regions]
            if len(normalized) != len(set(normalized)):
                raise UserAccessError("user_regions_duplicate", 422)
            requested_regions = set(normalized)
            if not region_override and target.organizational_scope == "matrix" and requested_regions:
                raise UserAccessError("matrix_user_cannot_have_extra_regions", 422)
            if not region_override and target.home_region and target.home_region in requested_regions:
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
            # Use the current locking-read result above, not COUNT(*) from a
            # potentially older consistent snapshot. Preserve at least one
            # active administrator and one administrator with MATRIZ authority.
            active_admins = [user for user in locked_admins if user.platform_role == "ADMIN" and user.is_active]
            active_matrix_admins = [
                user for user in active_admins
                if str(user.organizational_scope or "").strip().lower() == "matrix"
            ]
            removes_matrix_admin = (
                str(target.organizational_scope or "").strip().lower() == "matrix"
                and (next_role != "ADMIN" or not next_active)
            )
            if len(active_admins) <= 1 or (removes_matrix_admin and len(active_matrix_admins) <= 1):
                raise UserAccessError("last_active_admin_required", 409)
        added = sorted(requested_regions - before_regions)
        removed = sorted(before_regions - requested_regions)
        role_changed = next_role != before_role
        active_changed = next_active != before_active
        if override_enabled_before and additional_regions is not None and not region_override:
            raise UserAccessError("user_region_override_requires_admin_mode", 409)
        override_changed = region_override and additional_regions is not None and (
            bool(requested_regions) != override_enabled_before
            or requested_regions != before_regions
        )

        target.platform_role = next_role
        target.is_active = next_active
        if added:
            db.add_all([
                UserRegionAccess(
                    user_id=target.id,
                    region_code=region,
                    granted_by_user_id=actor_id,
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

        if override_changed:
            action = (
                "regional_override_removed_to_none"
                if additional_regions is not None and not requested_regions
                and target_identity_before.get("region_resolution_status") != "RESOLVED"
                else "regional_override_removed" if additional_regions is not None and not requested_regions
                else "regional_override_updated" if override_enabled_before
                else "regional_override_created_from_legacy"
                if target_identity_before.get("effective_scope_source") == "LEGACY_GRANT"
                else "regional_override_created_from_none"
                if target_identity_before.get("effective_scope_source") == "NONE"
                else "regional_override_created"
            )
            db.add(UserAccessAudit(
                actor_type="admin",
                actor_user_id=actor_id,
                target_user_id=target.id,
                action=action,
                old_platform_role=before_role if role_changed else None,
                new_platform_role=next_role if role_changed else None,
                old_is_active=before_active if active_changed else None,
                new_is_active=next_active if active_changed else None,
                regions_added=added,
                regions_removed=removed,
            ))
        elif role_changed or active_changed or added or removed:
            db.add(UserAccessAudit(
                actor_type="admin",
                actor_user_id=actor_id,
                target_user_id=target.id,
                action="access_updated",
                old_platform_role=before_role,
                new_platform_role=next_role,
                old_is_active=before_active,
                new_is_active=next_active,
                regions_added=added,
                regions_removed=removed,
            ))
        db.flush()
        extras_after = additional_regions_for_user(db, target.id, for_update=True)
        transaction.commit()
        db.refresh(target)
        return target, extras_after
    except UserAccessError:
        db.rollback()
        raise
    except OperationalError as error:
        db.rollback()
        if _is_mysql_lock_conflict(error):
            raise UserAccessError("user_access_concurrency_conflict", 409) from None
        raise UserAccessError("user_store_unavailable", 503) from None
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
