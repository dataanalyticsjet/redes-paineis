"""One organizational revision per protected Data Foundation request."""
from contextvars import ContextVar
import hashlib
import uuid

from sqlalchemy import text
from app.core.config import get_settings
from app.services.data_foundation.repository import DataFoundationError

request_revision: ContextVar[dict | None] = ContextVar("doomsday_request_revision", default=None)


def revision_token(map_id: bytes, changed_at=None) -> str:
    value = str(uuid.UUID(bytes=bytes(map_id)))
    return value if changed_at is None else value + ":" + hashlib.sha256(str(changed_at).encode()).hexdigest()


def observe_revision(map_id: bytes, changed_at=None) -> None:
    context = request_revision.get()
    if context is None:
        return
    token = revision_token(map_id, changed_at)
    context["observed"] = token
    expected = context.get("expected")
    if expected and expected != token:
        raise DataFoundationError("mapping_revision_changed", 409)
    context["expected"] = token
    context["observed"] = token


def read_revision(engine) -> dict[str, object]:
    enabled = get_settings().data_mapping_unit_metadata_enabled
    changed = "pointer.changed_at" if enabled else "NULL"
    with engine.connect() as connection:
        row = connection.execute(text(f"""
            SELECT pointer.map_version_id, {changed} AS changed_at
            FROM base_mapping_current AS pointer
            JOIN base_mapping_versions AS version ON version.map_version_id=pointer.map_version_id
            WHERE pointer.current_key='OFFICIAL' AND version.version_state='PUBLISHED'
        """)).mappings().first()
    if row is None:
        raise DataFoundationError("official_mapping_unavailable",503)
    return {"mappingVersionId":str(uuid.UUID(bytes=bytes(row["map_version_id"]))),
            "revision":revision_token(row["map_version_id"],row["changed_at"]),
            "unitMetadataEnabled":enabled}
