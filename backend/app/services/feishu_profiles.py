from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import PlatformUserFeishuProfile
from app.services.feishu_contacts import FeishuOrganizationalProfile
from app.services.feishu_regions import resolve_organizational_region


def persist_successful_feishu_profile(
    db: Session,
    user_id: int,
    profile: FeishuOrganizationalProfile,
    *,
    fallback_union_id: str | None = None,
    fallback_avatar_url: str | None = None,
) -> PlatformUserFeishuProfile:
    """Persist only profile metadata; never touches the user's access record."""
    try:
        record = db.get(PlatformUserFeishuProfile, user_id)
        if record is None:
            record = PlatformUserFeishuProfile(user_id=user_id)
        resolution = resolve_organizational_region(profile.department_paths)
        union_id = profile.union_id or fallback_union_id
        avatar_url = profile.avatar_url or fallback_avatar_url
        if union_id:
            record.union_id = union_id[:128]
        record.avatar_url = avatar_url[:2048] if avatar_url else None
        record.department_paths = profile.department_paths
        record.organizational_region_code = resolution.region_code
        record.region_resolution_status = resolution.status
        record.last_successful_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(record)
        db.commit()
        db.refresh(record)
        return record
    except Exception:
        db.rollback()
        raise


def persist_feishu_sync_failure(
    db: Session,
    user_id: int,
    *,
    fallback_union_id: str | None = None,
    fallback_avatar_url: str | None = None,
) -> PlatformUserFeishuProfile:
    """Record failure status while retaining the last successful regional data."""
    try:
        record = db.get(PlatformUserFeishuProfile, user_id)
        if record is None:
            record = PlatformUserFeishuProfile(
                user_id=user_id,
                region_resolution_status="SYNC_FAILED",
            )
        else:
            record.region_resolution_status = "SYNC_FAILED"
        if fallback_union_id:
            record.union_id = fallback_union_id[:128]
        if fallback_avatar_url:
            record.avatar_url = fallback_avatar_url[:2048]
        db.add(record)
        db.commit()
        db.refresh(record)
        return record
    except Exception:
        db.rollback()
        raise
