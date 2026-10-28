from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.dependencies import AuthenticatedViewer, require_user_administrator
from app.db.session import get_db_session
from app.models import PlatformUser, UserAccessAudit
from app.schemas.admin_users import AdminUserUpdate
from app.services.user_access import (
    UserAccessError,
    additional_regions_for_user,
    list_active_regions,
    update_user_access,
    identity_for_user,
    can_administer_user,
)

router = APIRouter(prefix="/admin", tags=["user administration"])


def _require_visible_target(db: Session, administrator: AuthenticatedViewer, user: PlatformUser) -> None:
    try:
        allowed = can_administer_user(administrator.identity, user, identity_for_user(db, user))
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    if not allowed:
        raise HTTPException(status_code=403, detail="user_admin_target_forbidden")


def _user_payload(
    db: Session, user: PlatformUser, extras: list[str] | None = None,
    *, administrator: AuthenticatedViewer,
) -> dict[str, object]:
    identity = identity_for_user(db, user)
    return {
        "id": user.id,
        "name": user.display_name,
        "email": user.email,
        "platformRole": user.platform_role,
        "organizationalScope": identity["organizational_scope"],
        "homeRegion": identity["home_region"],
        "homeBase": identity["home_base"],
        "additionalRegions": extras if extras is not None else additional_regions_for_user(db, user.id),
        "effectiveRegions": identity["effective_regions"] or [],
        "adminOverrideEnabled": identity["admin_override_enabled"],
        "adminAllowedRegions": identity["admin_allowed_regions"],
        "effectiveScopeSource": identity["effective_scope_source"],
        "organizationalScopePolicy": identity["organizational_scope_policy"],
        "feishuRegionCode": identity["organizational_region_code"],
        "feishuRegionStatus": identity["region_resolution_status"],
        "isActive": bool(user.is_active),
        "canChangeStatus": user.id != administrator.user.id and can_administer_user(administrator.identity, user, identity),
        "canManageAccess": (
            user.id != administrator.user.id
            and administrator.identity["administrative_scope"] == "matrix"
            and administrator.user.platform_role == "ADMIN"
        ),
    }


@router.get("/users/{user_id}/access-audit")
def list_user_access_audit(
    user_id: int,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    admin: AuthenticatedViewer = Depends(require_user_administrator),
    db: Session = Depends(get_db_session),
) -> dict[str, object]:
    target = db.get(PlatformUser, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    _require_visible_target(db, admin, target)
    statement = (
        select(UserAccessAudit)
        .where(UserAccessAudit.target_user_id == user_id)
        .order_by(UserAccessAudit.created_at.desc(), UserAccessAudit.id.desc())
        .offset(offset)
        .limit(limit)
    )
    total = int(db.scalar(
        select(func.count()).select_from(UserAccessAudit).where(UserAccessAudit.target_user_id == user_id)
    ) or 0)
    entries = list(db.scalars(statement))
    actor_ids = {entry.actor_user_id for entry in entries if entry.actor_user_id is not None}
    actors = {
        actor.id: actor.display_name
        for actor in db.scalars(select(PlatformUser).where(PlatformUser.id.in_(actor_ids)))
    } if actor_ids else {}
    return {
        "entries": [
            {
                "id": entry.id,
                "actor": actors.get(entry.actor_user_id, "Sistema") if entry.actor_user_id is not None else "Sistema",
                "action": entry.action,
                "oldPlatformRole": entry.old_platform_role,
                "newPlatformRole": entry.new_platform_role,
                "oldIsActive": entry.old_is_active,
                "newIsActive": entry.new_is_active,
                "regionsAdded": entry.regions_added or [],
                "regionsRemoved": entry.regions_removed or [],
                "scopeSourceBefore": (
                    "ADMIN_OVERRIDE" if entry.action == "regional_override_updated"
                    or entry.action in {"regional_override_removed", "regional_override_removed_to_none"}
                    else "LEGACY_GRANT" if entry.action == "regional_override_created_from_legacy"
                    else "NONE" if entry.action == "regional_override_created_from_none"
                    else "AUTOMATIC" if entry.action.startswith("regional_override_")
                    else None
                ),
                "scopeSourceAfter": (
                    "NONE" if entry.action == "regional_override_removed_to_none"
                    else "AUTOMATIC" if entry.action == "regional_override_removed"
                    else "ADMIN_OVERRIDE" if entry.action.startswith("regional_override_")
                    else None
                ),
                "createdAt": entry.created_at.replace(tzinfo=timezone.utc) if entry.created_at.tzinfo is None else entry.created_at.astimezone(timezone.utc),
            }
            for entry in entries
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/users")
def list_users(
    q: str = Query(default="", max_length=160),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    admin: AuthenticatedViewer = Depends(require_user_administrator),
    db: Session = Depends(get_db_session),
) -> dict[str, object]:
    statement = select(PlatformUser)
    count_statement = select(func.count()).select_from(PlatformUser)
    search = q.strip()
    if search:
        pattern = f"%{search}%"
        criterion = or_(
            PlatformUser.display_name.ilike(pattern),
            PlatformUser.email.ilike(pattern),
            PlatformUser.home_region.ilike(pattern),
            PlatformUser.home_base.ilike(pattern),
        )
        statement = statement.where(criterion)
        count_statement = count_statement.where(criterion)
    ordered = statement.order_by(PlatformUser.display_name, PlatformUser.id)
    if admin.identity["administrative_scope"] == "matrix":
        users = list(db.scalars(ordered.offset(offset).limit(limit)))
        total = int(db.scalar(count_statement) or 0)
    else:
        # Optional delegation has a restricted catalog. Apply the effective
        # identity check before pagination, including Feishu and extra grants.
        candidates = db.scalars(ordered.where(
            PlatformUser.platform_role == "USER",
            PlatformUser.organizational_scope != "matrix",
        ))
        visible = [user for user in candidates if can_administer_user(
            admin.identity, user, identity_for_user(db, user),
        )]
        total = len(visible)
        users = visible[offset:offset + limit]
    return {
        "users": [_user_payload(db, user, administrator=admin) for user in users],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/regions")
def get_regions(
    admin: AuthenticatedViewer = Depends(require_user_administrator),
    db: Session = Depends(get_db_session),
) -> dict[str, object]:
    try:
        regions = list_active_regions(db)
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    if admin.identity["administrative_scope"] != "matrix":
        regions = [region for region in regions if region.region_code in admin.identity["administrative_regions"]]
    return {
        "regions": [
            {"code": region.region_code, "name": region.display_name}
            for region in regions
        ]
    }


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: AdminUserUpdate,
    admin: AuthenticatedViewer = Depends(require_user_administrator),
    db: Session = Depends(get_db_session),
) -> dict[str, object]:
    fields = payload.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="user_update_empty")
    if "platform_role" not in fields:
        platform_role = None
    else:
        platform_role = payload.platform_role
    if "additional_regions" not in fields:
        extra_regions = None
    else:
        extra_regions = payload.additional_regions or []
    override_fields = {"admin_override_enabled", "admin_allowed_regions"} & fields
    if override_fields:
        if "additional_regions" in fields or override_fields != {"admin_override_enabled", "admin_allowed_regions"}:
            raise HTTPException(status_code=422, detail="user_region_override_payload_invalid")
        if payload.admin_override_enabled is True:
            if not payload.admin_allowed_regions:
                raise HTTPException(status_code=422, detail="user_region_override_requires_regions")
            extra_regions = payload.admin_allowed_regions
        else:
            if payload.admin_allowed_regions:
                raise HTTPException(status_code=422, detail="user_region_override_disabled_with_regions")
            extra_regions = []
    if "is_active" not in fields:
        is_active = None
    else:
        is_active = payload.is_active
    region_override = bool(override_fields)
    try:
        user, extras = update_user_access(
            db,
            actor=admin.user,
            target_id=user_id,
            platform_role=platform_role,
            additional_regions=extra_regions,
            is_active=is_active,
            region_override=region_override,
        )
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    return {"user": _user_payload(db, user, extras, administrator=admin)}
