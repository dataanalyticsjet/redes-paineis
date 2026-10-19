from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import PlatformUser, PlatformUserFeishuProfile
from app.services.feishu_auth import SESSION_COOKIE, get_local_session
from app.services.user_access import UserAccessError, identity_for_user, user_administration_identity


@dataclass(frozen=True)
class AuthenticatedViewer:
    user: PlatformUser
    identity: dict[str, Any]


def get_current_viewer(
    request: Request,
    db: Session = Depends(get_db_session),
) -> AuthenticatedViewer:
    session_identity = get_local_session(
        request.cookies.get(SESSION_COOKIE),
        get_settings(),
    )
    if not session_identity:
        raise HTTPException(status_code=401, detail="authentication_required")
    try:
        raw_user_id = session_identity.get("user_id")
        user_id = int(raw_user_id) if raw_user_id is not None else 0
        user = db.get(PlatformUser, user_id) if user_id > 0 else None
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="authentication_required")
        force_feishu_sync_failed = False
        unpersisted_failure_at = session_identity.get("_feishu_sync_failed_at")
        if unpersisted_failure_at is not None:
            try:
                failure_timestamp = float(unpersisted_failure_at)
                profile = db.get(PlatformUserFeishuProfile, user.id)
                last_successful_sync_at = profile.last_successful_sync_at if profile else None
                if last_successful_sync_at is None:
                    force_feishu_sync_failed = True
                else:
                    if last_successful_sync_at.tzinfo is None:
                        last_successful_sync_at = last_successful_sync_at.replace(tzinfo=timezone.utc)
                    force_feishu_sync_failed = last_successful_sync_at.timestamp() <= failure_timestamp
            except (TypeError, ValueError, OverflowError, SQLAlchemyError):
                db.rollback()
                force_feishu_sync_failed = True
        resolved = identity_for_user(db, user, force_feishu_sync_failed=force_feishu_sync_failed)
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    return AuthenticatedViewer(user=user, identity={**session_identity, **resolved})


def require_admin(
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> AuthenticatedViewer:
    if viewer.user.platform_role != "ADMIN":
        raise HTTPException(status_code=403, detail="admin_required")
    return viewer


def require_matrix_admin(
    viewer: AuthenticatedViewer = Depends(require_admin),
) -> AuthenticatedViewer:
    # Also enforce the role when this guard is reused directly by legacy routes.
    viewer = require_admin(viewer)
    if viewer.identity.get("administrative_scope") != "matrix":
        raise HTTPException(status_code=403, detail="matrix_admin_required")
    return viewer


def require_user_administrator(
    viewer: AuthenticatedViewer = Depends(require_admin),
    db: Session = Depends(get_db_session),
) -> AuthenticatedViewer:
    try:
        identity = user_administration_identity(db, viewer.user)
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    return AuthenticatedViewer(user=viewer.user, identity=identity)
