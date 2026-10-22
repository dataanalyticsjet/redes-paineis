"""One organizational revision per protected Data Foundation request."""
from contextvars import ContextVar
import hashlib
import json
import threading
import uuid
from weakref import WeakKeyDictionary

from sqlalchemy import inspect, text
from app.core.config import get_settings
from app.services.data_foundation.repository import DataFoundationError

request_revision: ContextVar[dict | None] = ContextVar("doomsday_request_revision", default=None)
_metadata_schema_cache: WeakKeyDictionary = WeakKeyDictionary()
_metadata_schema_cache_lock = threading.Lock()


def supports_unit_metadata(connection) -> bool:
    engine = connection.engine
    with _metadata_schema_cache_lock:
        cached = _metadata_schema_cache.get(engine)
    if cached is not None:
        return cached
    try:
        versions = {column["name"] for column in inspect(connection).get_columns("base_mapping_versions")}
        entries = {column["name"] for column in inspect(connection).get_columns("base_mapping_entries")}
        current = {column["name"] for column in inspect(connection).get_columns("base_mapping_current")}
        ready = {"candidate_metadata"}.issubset(versions) and {"unit_metadata"}.issubset(entries) and {"changed_at"}.issubset(current)
    except Exception:
        ready = False
    with _metadata_schema_cache_lock:
        _metadata_schema_cache[engine] = ready
    return ready


def unit_metadata_enabled(connection, *, version_no=None, candidate_metadata=None) -> bool:
    """Enable V3 unit semantics only by explicit flag or an activated official map."""
    if get_settings().data_mapping_unit_metadata_enabled:
        return True
    if version_no is None:
        if connection is None:
            return False
        if not supports_unit_metadata(connection):
            return False
        row = connection.execute(text("""
            SELECT version.version_no, version.candidate_metadata
            FROM base_mapping_current AS pointer
            JOIN base_mapping_versions AS version ON version.map_version_id=pointer.map_version_id
            WHERE pointer.current_key='OFFICIAL' AND version.version_state='PUBLISHED'
        """)).mappings().first()
        if row is None:
            return False
        version_no, candidate_metadata = row["version_no"], row["candidate_metadata"]
    if version_no is None or int(version_no) < 2:
        return False
    value = candidate_metadata
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return False
    return isinstance(value, dict) and value.get("activationEnabled") is True


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
    with engine.connect() as connection:
        metadata_schema_ready = supports_unit_metadata(connection)
        version_metadata = "version.candidate_metadata" if metadata_schema_ready else "NULL"
        version_number = "version.version_no" if metadata_schema_ready else "NULL"
        changed_at = "pointer.changed_at" if metadata_schema_ready else "NULL"
        row = connection.execute(text(f"""
            SELECT pointer.map_version_id, {changed_at} AS changed_at, {version_number} AS version_no,
                   {version_metadata} AS candidate_metadata
            FROM base_mapping_current AS pointer
            JOIN base_mapping_versions AS version ON version.map_version_id=pointer.map_version_id
            WHERE pointer.current_key='OFFICIAL' AND version.version_state='PUBLISHED'
        """)).mappings().first()
    if row is None:
        raise DataFoundationError("official_mapping_unavailable",503)
    enabled = unit_metadata_enabled(connection=None, version_no=row["version_no"], candidate_metadata=row["candidate_metadata"])
    changed = row["changed_at"] if enabled else None
    return {"mappingVersionId":str(uuid.UUID(bytes=bytes(row["map_version_id"]))),
            "revision":revision_token(row["map_version_id"],changed),
            "unitMetadataEnabled":enabled}
