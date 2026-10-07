from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import PlatformUser, Region, UserAccessAudit, UserRegionAccess


class UserAccessError(Exception):
    def __init__(self, code: str, status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def _organizational_scope(identity: dict[str, Any]) -> tuple[str, str | None, str | None]:
    role = str(identity.get("role") or "").strip().lower()
    region = str(identity.get("region") or "").strip().upper() or None
    base = str(identity.get("base") or "").strip().upper() or None
    if role == "matrix":
        return "matrix", None, None
    if base:
        return "base", region, base
    if region:
        return "regional", region, None
    raise UserAccessError("user_scope_unavailable", 403)


def provision_feishu_user(db: Session, identity: dict[str, Any]) -> PlatformUser:
    tenant_key = str(identity.get("_tenant_key") or "").strip()
    open_id = str(identity.get("_open_id") or "").strip()
    email = str(identity.get("_email") or "").strip().lower()
    display_name = str(identity.get("username") or email).strip() or email
    if not tenant_key or not open_id or not email:
        raise UserAccessError("feishu_identity_incomplete", 403)
    organizational_scope, home_region, home_base = _organizational_scope(identity)

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
                organizational_scope=organizational_scope,
                home_region=home_region,
                home_base=home_base,
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

        # Feishu/configuration remains the source of organizational scope.
        # Platform role and additional regions are managed separately and are
        # deliberately not overwritten by a subsequent login.
        user.email = email
        user.display_name = display_name
        user.organizational_scope = organizational_scope
        user.home_region = home_region
        user.home_base = home_base
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
                .where(UserRegionAccess.user_id == user_id)
                .order_by(UserRegionAccess.region_code)
            )
        )
    except SQLAlchemyError:
        raise UserAccessError("user_store_unavailable", 503) from None


def identity_for_user(db: Session, user: PlatformUser) -> dict[str, Any]:
    extras = additional_regions_for_user(db, user.id)
    role = "matrix" if user.organizational_scope == "matrix" else "regional"
    effective_regions: list[str] | None
    if user.organizational_scope == "matrix":
        effective_regions = None  # null means unrestricted/national.
    else:
        effective_regions = sorted({
            region
            for region in [user.home_region, *extras]
            if region
        })
    return {
        "user_id": user.id,
        "username": user.display_name,
        "role": role,
        "region": user.home_region,
        "base": user.home_base,
        "platform_role": user.platform_role,
        "organizational_scope": user.organizational_scope,
        "home_region": user.home_region,
        "home_base": user.home_base,
        "additional_regions": extras,
        "effective_regions": effective_regions,
        "is_active": bool(user.is_active),
    }


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
        target = db.scalar(
            select(PlatformUser)
            .where(PlatformUser.id == target_id)
            .with_for_update()
        )
        if target is None:
            raise UserAccessError("user_not_found", 404)

        before_role = target.platform_role
        before_active = bool(target.is_active)
        before_regions = set(additional_regions_for_user(db, target.id))
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
