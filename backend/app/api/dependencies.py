from __future__ import annotations

import asyncio
import logging
import time
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.db.session import get_db_session
from app.models import PlatformUser, PlatformUserFeishuProfile
from app.services.feishu_auth import SESSION_COOKIE, get_local_session
from app.services.feishu_contacts import FeishuContactsError, fetch_feishu_organizational_profile
from app.services.feishu_profiles import persist_feishu_sync_failure, persist_successful_feishu_profile
from app.services.user_access import UserAccessError, _profile_sync_is_fresh, identity_for_user, user_administration_identity

logger = logging.getLogger(__name__)
_ORG_PROFILE_REFRESH_LOCKS: dict[int, threading.Lock] = {}
_ORG_PROFILE_RETRY_AFTER: dict[int, float] = {}


@dataclass(frozen=True)
class AuthenticatedViewer:
    user: PlatformUser
    identity: dict[str, Any]


def _session_sync_failure_timestamp(session_identity: dict[str, Any]) -> float | None:
    raw = session_identity.get("_feishu_sync_failed_at")
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError, OverflowError):
        return time.time()


def _profile_needs_refresh(
    db: Session,
    user: PlatformUser,
    settings: Settings,
    *,
    after_timestamp: float | None,
) -> bool:
    try:
        profile = db.get(PlatformUserFeishuProfile, user.id)
    except SQLAlchemyError:
        db.rollback()
        return True
    now = datetime.now(timezone.utc)
    if not _profile_sync_is_fresh(
        profile,
        ttl_seconds=settings.feishu_org_scope_profile_ttl_seconds,
        now=now,
    ):
        return True
    if after_timestamp is not None:
        synced_at = profile.last_successful_sync_at
        if synced_at and synced_at.tzinfo is None:
            synced_at = synced_at.replace(tzinfo=timezone.utc)
        if synced_at is None or synced_at.timestamp() <= after_timestamp:
            return True
    return False


def _refresh_feishu_profile_if_stale(
    db: Session,
    user: PlatformUser,
    settings: Settings,
    *,
    after_timestamp: float | None = None,
) -> bool:
    """Refresh stale profile before authorization; return True when refresh failed."""
    if not _profile_needs_refresh(db, user, settings, after_timestamp=after_timestamp):
        return False

    retry_after = _ORG_PROFILE_RETRY_AFTER.get(user.id, 0.0)
    if time.monotonic() < retry_after:
        return True

    lock = _ORG_PROFILE_REFRESH_LOCKS.setdefault(user.id, threading.Lock())
    with lock:
        if not _profile_needs_refresh(db, user, settings, after_timestamp=after_timestamp):
            _ORG_PROFILE_RETRY_AFTER.pop(user.id, None)
            return False
        if time.monotonic() < _ORG_PROFILE_RETRY_AFTER.get(user.id, 0.0):
            return True
        category = "contacts_not_configured"
        try:
            if (
                not settings.feishu_allowed_tenant_key
                or user.tenant_key != settings.feishu_allowed_tenant_key
                or not user.open_id
            ):
                raise FeishuContactsError("contacts_tenant_mismatch")
            prior = db.get(PlatformUserFeishuProfile, user.id)
            profile = asyncio.run(fetch_feishu_organizational_profile(
                user.open_id,
                settings,
                fallback_union_id=prior.union_id if prior else None,
                fallback_avatar_url=prior.avatar_url if prior else None,
            ))
            persist_successful_feishu_profile(db, user.id, profile)
            _ORG_PROFILE_RETRY_AFTER.pop(user.id, None)
            return False
        except FeishuContactsError as error:
            category = error.category
        except Exception as error:
            category = f"storage_or_refresh_{type(error).__name__}"
        logger.warning("Feishu organization scope refresh failed (category=%s)", category)
        try:
            persist_feishu_sync_failure(db, user.id)
        except Exception:
            logger.warning("Feishu organization scope failure status could not be persisted")
        _ORG_PROFILE_RETRY_AFTER[user.id] = time.monotonic() + 60
        return True


def get_current_viewer(
    request: Request,
    db: Session = Depends(get_db_session),
) -> AuthenticatedViewer:
    settings = get_settings()
    session_identity = get_local_session(
        request.cookies.get(SESSION_COOKIE),
        settings,
    )
    if not session_identity:
        raise HTTPException(status_code=401, detail="authentication_required")
    try:
        raw_user_id = session_identity.get("user_id")
        user_id = int(raw_user_id) if raw_user_id is not None else 0
        user = db.get(PlatformUser, user_id) if user_id > 0 else None
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="authentication_required")

        unpersisted_failure_at = _session_sync_failure_timestamp(session_identity)
        force_feishu_sync_failed = False
        if settings.feishu_org_scope_v2_enabled:
            force_feishu_sync_failed = _refresh_feishu_profile_if_stale(
                db,
                user,
                settings,
                after_timestamp=unpersisted_failure_at,
            )
        elif unpersisted_failure_at is not None:
            try:
                profile = db.get(PlatformUserFeishuProfile, user.id)
                last_successful_sync_at = profile.last_successful_sync_at if profile else None
                if last_successful_sync_at is None:
                    force_feishu_sync_failed = True
                else:
                    if last_successful_sync_at.tzinfo is None:
                        last_successful_sync_at = last_successful_sync_at.replace(tzinfo=timezone.utc)
                    force_feishu_sync_failed = last_successful_sync_at.timestamp() <= unpersisted_failure_at
            except (SQLAlchemyError, AttributeError):
                db.rollback()
                force_feishu_sync_failed = True

        resolved = identity_for_user(
            db,
            user,
            force_feishu_sync_failed=force_feishu_sync_failed,
            org_scope_v2_enabled=settings.feishu_org_scope_v2_enabled,
        )
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
