from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.dependencies import AuthenticatedViewer, require_admin
from app.db.session import get_db_session
from app.models import PlatformUser
from app.schemas.admin_users import AdminUserUpdate
from app.services.user_access import (
    UserAccessError,
    additional_regions_for_user,
    list_active_regions,
    update_user_access,
)

router = APIRouter(prefix="/admin", tags=["user administration"])


def _user_payload(db: Session, user: PlatformUser, extras: list[str] | None = None) -> dict[str, object]:
    return {
        "id": user.id,
        "name": user.display_name,
        "email": user.email,
        "platformRole": user.platform_role,
        "organizationalScope": user.organizational_scope,
        "homeRegion": user.home_region,
        "homeBase": user.home_base,
        "additionalRegions": extras if extras is not None else additional_regions_for_user(db, user.id),
        "isActive": bool(user.is_active),
    }


@router.get("/users")
def list_users(
    q: str = Query(default="", max_length=160),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    _admin: AuthenticatedViewer = Depends(require_admin),
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
    users = list(
        db.scalars(
            statement.order_by(PlatformUser.display_name, PlatformUser.id)
            .offset(offset)
            .limit(limit)
        )
    )
    total = int(db.scalar(count_statement) or 0)
    return {
        "users": [_user_payload(db, user) for user in users],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/regions")
def get_regions(
    _admin: AuthenticatedViewer = Depends(require_admin),
    db: Session = Depends(get_db_session),
) -> dict[str, object]:
    try:
        regions = list_active_regions(db)
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
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
    admin: AuthenticatedViewer = Depends(require_admin),
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
    if "is_active" not in fields:
        is_active = None
    else:
        is_active = payload.is_active
    try:
        user, extras = update_user_access(
            db,
            actor=admin.user,
            target_id=user_id,
            platform_role=platform_role,
            additional_regions=extra_regions,
            is_active=is_active,
        )
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    return {"user": _user_payload(db, user, extras)}
