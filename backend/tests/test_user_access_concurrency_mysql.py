"""MySQL/InnoDB concurrency checks for administrative permission writes.

Set NEWBI_MYSQL_CONCURRENCY_TEST_URL only to a disposable local MySQL database
named exactly newbi_permissions_concurrency_test. The tests never target a
remote host and remove only rows created with their unique test identities.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from os import environ
from threading import Barrier, Lock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, event, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.base import Base
from app.models import (
    PlatformUser,
    PlatformUserFeishuProfile,
    Region,
    UserAccessAudit,
    UserRegionAccess,
)
from app.services.user_access import UserAccessError, update_user_access

MYSQL_TEST_URL_ENV = "NEWBI_MYSQL_CONCURRENCY_TEST_URL"
MYSQL_TEST_DATABASE = "newbi_permissions_concurrency_test"
TEST_TABLES = [
    Region.__table__,
    PlatformUser.__table__,
    UserRegionAccess.__table__,
    UserAccessAudit.__table__,
    PlatformUserFeishuProfile.__table__,
]
REGIONS = ("CE", "SPE", "SPS", "PR", "MG")


@pytest.fixture(scope="module")
def mysql_sessions() -> sessionmaker[Session]:
    raw_url = environ.get(MYSQL_TEST_URL_ENV)
    if not raw_url:
        pytest.skip(f"{MYSQL_TEST_URL_ENV} não aponta para um MySQL local descartável")
    url = make_url(raw_url)
    if url.get_backend_name() != "mysql":
        pytest.fail("O teste de concorrência exige um driver MySQL.")
    if url.host not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("Por segurança, o teste de concorrência só aceita MySQL local.")
    if url.database != MYSQL_TEST_DATABASE:
        pytest.fail(f"O banco de teste precisa se chamar {MYSQL_TEST_DATABASE}.")

    engine = create_engine(
        url,
        isolation_level="REPEATABLE READ",
        pool_pre_ping=True,
        pool_size=6,
        max_overflow=0,
    )
    Base.metadata.create_all(engine, tables=TEST_TABLES)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with factory() as db:
        for table in TEST_TABLES:
            if table.name == "regions":
                continue
            count = int(db.scalar(select(func.count()).select_from(table)) or 0)
            if count:
                engine.dispose()
                pytest.fail(
                    "O banco de concorrência não está vazio. Os testes não apagam nem "
                    "substituem registros preexistentes."
                )
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture
def mysql_permission_users(mysql_sessions: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FEISHU_ORG_SCOPE_V2_ENABLED", "false")
    get_settings.cache_clear()
    suffix = uuid4().hex
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    ids: dict[str, int] = {}
    with mysql_sessions.begin() as db:
        for code in REGIONS:
            region = db.get(Region, code)
            if region is None:
                db.add(Region(region_code=code, display_name=code, is_active=True))
            elif not region.is_active:
                pytest.fail(f"A regional {code} está inativa no banco de teste dedicado.")
        for key, role, scope, region_code in (
            ("admin_a", "ADMIN", "matrix", "MATRIZ"),
            ("admin_b", "ADMIN", "matrix", "MATRIZ"),
            ("target", "USER", "regional", "CE"),
        ):
            user = PlatformUser(
                tenant_key="concurrency-test",
                open_id=f"{suffix}-{key}",
                email=f"{suffix}-{key}@example.test",
                display_name=f"Concurrency {key}",
                platform_role=role,
                organizational_scope=scope,
                home_region=None if scope == "matrix" else "CE",
                is_active=True,
            )
            db.add(user)
            db.flush()
            ids[key] = user.id
            db.add(PlatformUserFeishuProfile(
                user_id=user.id,
                organizational_region_code=region_code,
                region_resolution_status="RESOLVED",
                last_successful_sync_at=now,
            ))
        target_id = ids["target"]
        db.add(UserRegionAccess(user_id=target_id, region_code="CE", granted_by_user_id=ids["admin_a"]))
        db.add(UserAccessAudit(
            actor_type="admin",
            actor_user_id=ids["admin_a"],
            target_user_id=target_id,
            action="regional_override_created",
            regions_added=["CE"],
            regions_removed=[],
        ))
    try:
        yield ids
    finally:
        with mysql_sessions.begin() as db:
            target_ids = list(ids.values())
            db.execute(delete(UserAccessAudit).where(
                (UserAccessAudit.target_user_id.in_(target_ids))
                | (UserAccessAudit.actor_user_id.in_(target_ids))
            ))
            db.execute(delete(UserRegionAccess).where(
                UserRegionAccess.user_id.in_(target_ids)
                | UserRegionAccess.granted_by_user_id.in_(target_ids)
            ))
            db.execute(delete(PlatformUserFeishuProfile).where(
                PlatformUserFeishuProfile.user_id.in_(target_ids)
            ))
            db.execute(delete(PlatformUser).where(PlatformUser.id.in_(target_ids)))
    get_settings.cache_clear()


def _run_update(
    factory: sessionmaker[Session],
    actor_id: int,
    target_id: int,
    regions: list[str] | None,
    *,
    barrier: Barrier,
    results: list[tuple[int, list[str] | None, str | None]],
    result_lock: Lock,
    deactivate: bool = False,
    promote_admin: bool = False,
) -> None:
    try:
        with factory() as db:
            actor = db.get(PlatformUser, actor_id)
            target = db.get(PlatformUser, target_id)
            assert actor is not None and target is not None
            # Deliberately establish a read snapshot before the service starts.
            # Its transaction reset must prevent stale writes under REPEATABLE READ.
            _ = list(db.scalars(select(UserRegionAccess.region_code).where(
                UserRegionAccess.user_id == target_id
            )))
            barrier.wait(timeout=15)
            update_user_access(
                db,
                actor=actor,
                target_id=target_id,
                platform_role="USER" if deactivate else "ADMIN" if promote_admin else None,
                additional_regions=regions,
                is_active=False if deactivate else None,
                region_override=not deactivate and not promote_admin,
            )
            error_code = None
    except UserAccessError as error:
        error_code = error.code
    with result_lock:
        results.append((actor_id, regions, error_code))


def test_mysql_repeated_read_serializes_replacement_and_audit_without_union(
    mysql_sessions: sessionmaker[Session],
    mysql_permission_users: dict[str, int],
) -> None:
    ids = mysql_permission_users
    barrier = Barrier(2)
    result_lock = Lock()
    results: list[tuple[int, list[str] | None, str | None]] = []
    requests = {ids["admin_a"]: ["SPE", "SPS"], ids["admin_b"]: ["PR"]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                _run_update,
                mysql_sessions,
                actor_id,
                ids["target"],
                requested,
                barrier=barrier,
                results=results,
                result_lock=result_lock,
            )
            for actor_id, requested in requests.items()
        ]
        for future in futures:
            future.result(timeout=30)
    assert len(results) == 2
    assert all(error is None for _actor, _requested, error in results)
    with mysql_sessions() as db:
        audits = list(db.scalars(
            select(UserAccessAudit)
            .where(
                UserAccessAudit.target_user_id == ids["target"],
                UserAccessAudit.action == "regional_override_updated",
            )
            .order_by(UserAccessAudit.id)
        ))
        state = {"CE"}
        assert len(audits) == 2
        for audit in audits:
            requested = set(requests[audit.actor_user_id])
            assert set(audit.regions_removed or []) == state - requested
            assert set(audit.regions_added or []) == requested - state
            state = requested
        persisted = set(db.scalars(select(UserRegionAccess.region_code).where(
            UserRegionAccess.user_id == ids["target"]
        )))
        assert persisted == state
        assert persisted in ({"SPE", "SPS"}, {"PR"})


def test_mysql_concurrent_admin_deactivation_cannot_remove_last_admin(
    mysql_sessions: sessionmaker[Session],
    mysql_permission_users: dict[str, int],
) -> None:
    ids = mysql_permission_users
    barrier = Barrier(2)
    result_lock = Lock()
    results: list[tuple[int, list[str] | None, str | None]] = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                _run_update,
                mysql_sessions,
                actor_id,
                target_id,
                None,
                barrier=barrier,
                results=results,
                result_lock=result_lock,
                deactivate=True,
            )
            for actor_id, target_id in (
                (ids["admin_a"], ids["admin_b"]),
                (ids["admin_b"], ids["admin_a"]),
            )
        ]
        for future in futures:
            future.result(timeout=30)
    assert sum(error is None for _actor, _regions, error in results) == 1
    assert sum(error == "admin_required" for _actor, _regions, error in results) == 1
    with mysql_sessions() as db:
        active_matrix_admins = list(db.scalars(
            select(PlatformUser.id).where(
                PlatformUser.platform_role == "ADMIN",
                PlatformUser.is_active.is_(True),
                PlatformUser.organizational_scope == "matrix",
            )
        ))
        assert len(active_matrix_admins) == 1


def test_mysql_permission_replacement_handles_initially_empty_set_and_removal(
    mysql_sessions: sessionmaker[Session],
    mysql_permission_users: dict[str, int],
) -> None:
    ids = mysql_permission_users
    with mysql_sessions.begin() as db:
        db.execute(delete(UserAccessAudit).where(UserAccessAudit.target_user_id == ids["target"]))
        db.execute(delete(UserRegionAccess).where(UserRegionAccess.user_id == ids["target"]))

    with mysql_sessions() as db:
        actor = db.get(PlatformUser, ids["admin_a"])
        assert actor is not None
        update_user_access(
            db,
            actor=actor,
            target_id=ids["target"],
            platform_role=None,
            additional_regions=["PR", "MG"],
            is_active=None,
            region_override=True,
        )
    with mysql_sessions() as db:
        assert set(db.scalars(select(UserRegionAccess.region_code).where(
            UserRegionAccess.user_id == ids["target"]
        ))) == {"MG", "PR"}
        actor = db.get(PlatformUser, ids["admin_b"])
        assert actor is not None
        update_user_access(
            db,
            actor=actor,
            target_id=ids["target"],
            platform_role=None,
            additional_regions=[],
            is_active=None,
            region_override=True,
        )
    with mysql_sessions() as db:
        assert list(db.scalars(select(UserRegionAccess.region_code).where(
            UserRegionAccess.user_id == ids["target"]
        ))) == []
        audits = list(db.scalars(select(UserAccessAudit).where(
            UserAccessAudit.target_user_id == ids["target"]
        ).order_by(UserAccessAudit.id)))
        assert [entry.action for entry in audits] == [
            "regional_override_created",
            "regional_override_removed",
        ]
        assert audits[0].regions_added == ["MG", "PR"]
        assert audits[1].regions_removed == ["MG", "PR"]


def test_mysql_user_to_admin_promotion_serializes_with_scope_replacement(
    mysql_sessions: sessionmaker[Session],
    mysql_permission_users: dict[str, int],
) -> None:
    ids = mysql_permission_users
    barrier = Barrier(2)
    result_lock = Lock()
    results: list[tuple[int, list[str] | None, str | None]] = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                _run_update,
                mysql_sessions,
                ids["admin_a"],
                ids["target"],
                None,
                barrier=barrier,
                results=results,
                result_lock=result_lock,
                promote_admin=True,
            ),
            pool.submit(
                _run_update,
                mysql_sessions,
                ids["admin_b"],
                ids["target"],
                ["PR"],
                barrier=barrier,
                results=results,
                result_lock=result_lock,
            ),
        ]
        for future in futures:
            future.result(timeout=30)
    assert all(error is None for _actor, _requested, error in results)
    with mysql_sessions() as db:
        target = db.get(PlatformUser, ids["target"])
        assert target is not None and target.platform_role == "ADMIN"
        assert set(db.scalars(select(UserRegionAccess.region_code).where(
            UserRegionAccess.user_id == ids["target"]
        ))) == {"PR"}


def test_mysql_failed_flush_rolls_back_permission_and_audit_together(
    mysql_sessions: sessionmaker[Session],
    mysql_permission_users: dict[str, int],
) -> None:
    ids = mysql_permission_users

    def fail_after_flush(_session: Session, _flush_context: object) -> None:
        raise OperationalError("simulated test-only flush failure", {}, RuntimeError("rollback"))

    event.listen(Session, "after_flush", fail_after_flush)
    try:
        with mysql_sessions() as db:
            actor = db.get(PlatformUser, ids["admin_a"])
            assert actor is not None
            with pytest.raises(UserAccessError, match="user_store_unavailable"):
                update_user_access(
                    db,
                    actor=actor,
                    target_id=ids["target"],
                    platform_role=None,
                    additional_regions=["PR"],
                    is_active=None,
                    region_override=True,
                )
    finally:
        event.remove(Session, "after_flush", fail_after_flush)
    with mysql_sessions() as db:
        persisted = set(db.scalars(select(UserRegionAccess.region_code).where(
            UserRegionAccess.user_id == ids["target"]
        )))
        audit_actions = list(db.scalars(select(UserAccessAudit.action).where(
            UserAccessAudit.target_user_id == ids["target"]
        )))
        assert persisted == {"CE"}
        assert audit_actions == ["regional_override_created"]
