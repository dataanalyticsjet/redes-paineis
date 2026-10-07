from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db_session
from app.models import PlatformUser
from app.services.feishu_auth import SESSION_COOKIE, get_local_session
from app.services.user_access import UserAccessError, identity_for_user


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
        resolved = identity_for_user(db, user)
    except UserAccessError as error:
        raise HTTPException(status_code=error.status_code, detail=error.code) from None
    return AuthenticatedViewer(user=user, identity={**session_identity, **resolved})


def require_admin(
    viewer: AuthenticatedViewer = Depends(get_current_viewer),
) -> AuthenticatedViewer:
    if viewer.user.platform_role != "ADMIN":
        raise HTTPException(status_code=403, detail="admin_required")
    return viewer
