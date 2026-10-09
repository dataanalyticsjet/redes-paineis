from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_db_session
from app.core.config import get_settings
from app.db.base import Base
from app.main import app
from app.models import PlatformUser, Region, UserRegionAccess
from app.services import feishu_auth
from app.services.user_access import identity_for_user


@pytest.fixture
def user_test_session_factory() -> Iterator[sessionmaker[Session]]:
    """A disposable SQLite database; never uses the configured application DB."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    with factory() as db:
        db.add_all([
            Region(region_code="SPE", display_name="São Paulo Leste", is_active=True),
            Region(region_code="SPS", display_name="São Paulo Sul", is_active=True),
            Region(region_code="MG", display_name="Minas Gerais", is_active=True),
            Region(region_code="RJ", display_name="Rio de Janeiro", is_active=True),
            Region(region_code="SR", display_name="Regional Sul", is_active=True),
        ])
        db.commit()
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture(autouse=True)
def bind_disposable_user_database(
    user_test_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> Iterator[None]:
    previous_overrides = dict(app.dependency_overrides)

    def db_dependency() -> Iterator[Session]:
        with user_test_session_factory() as db:
            yield db

    @contextmanager
    def callback_database_session(_settings: Any = None) -> Iterator[Session]:
        with user_test_session_factory() as db:
            yield db

    app.dependency_overrides[get_db_session] = db_dependency
    monkeypatch.setattr("app.api.auth.database_session", callback_database_session)
    # Workbook endpoints exercised by these tests must never write to the
    # machine's configured DATA_DIRECTORY.
    from app.services.local_workbooks import data_root as resolve_data_root

    def isolated_workbook_root(configured: Path) -> Path:
        configured_path = Path(configured)
        try:
            configured_path.resolve().relative_to(tmp_path.resolve())
        except ValueError:
            return tmp_path / "test-workbooks"
        return resolve_data_root(configured_path)

    monkeypatch.setattr("app.api.workbooks.data_root", isolated_workbook_root)
    try:
        yield
    finally:
        get_settings.cache_clear()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)


@pytest.fixture
def create_user_session(
    user_test_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
):
    def create(
        *,
        name: str = "Test Viewer",
        email: str | None = None,
        platform_role: str = "USER",
        organizational_scope: str = "regional",
        home_region: str | None = "SPS",
        home_base: str | None = None,
        additional_regions: list[str] | None = None,
        active: bool = True,
        identity_suffix: str = "one",
    ) -> tuple[str, PlatformUser]:
        monkeypatch.setenv("FEISHU_SESSION_SECRET", "isolated-test-session-secret-at-least-32-chars")
        get_settings.cache_clear()
        with user_test_session_factory() as db:
            user = db.scalar(
                select(PlatformUser).where(
                    PlatformUser.tenant_key == "test-tenant",
                    PlatformUser.open_id == f"test-open-{identity_suffix}",
                )
            )
            if user is None:
                user = PlatformUser(
                    tenant_key="test-tenant",
                    open_id=f"test-open-{identity_suffix}",
                    email=email or f"{identity_suffix}@example.test",
                    display_name=name,
                    platform_role=platform_role,
                    organizational_scope=organizational_scope,
                    home_region=home_region,
                    home_base=home_base,
                    is_active=active,
                )
                db.add(user)
                db.flush()
                for region in additional_regions or []:
                    db.add(UserRegionAccess(
                        user_id=user.id,
                        region_code=region,
                        granted_by_user_id=user.id,
                    ))
                db.commit()
            db.refresh(user)
            identity = identity_for_user(db, user)
            identity["_owner_subject"] = f"test-subject-{identity_suffix}"
            token = feishu_auth.create_local_session(
                identity,
                get_settings(),
            )
            return token, user

    return create
