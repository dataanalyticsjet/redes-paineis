from functools import lru_cache
from contextlib import contextmanager
from typing import Generator

from fastapi import HTTPException
from sqlalchemy import Engine, URL, create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings


def create_database_engine(settings: Settings | None = None) -> Engine:
    """Build an engine on demand; this does not connect until it is used."""
    config = settings or get_settings()
    required = {
        "DB_HOST": config.db_host,
        "DB_NAME": config.db_name,
        "DB_USER": config.db_user,
        "DB_PASSWORD": config.db_password,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise RuntimeError(
            "Database settings are incomplete: " + ", ".join(missing)
        )

    url = URL.create(
        drivername="mysql+pymysql",
        username=config.db_user,
        password=config.db_password,
        host=config.db_host,
        port=config.db_port,
        database=config.db_name,
    )
    return create_engine(url, pool_pre_ping=True)


def create_data_database_engine(settings: Settings | None = None) -> Engine:
    """Build the separate data engine without opening a connection."""
    config = settings or get_settings()
    required = {
        "DATA_DB_HOST": config.data_db_host,
        "DATA_DB_NAME": config.data_db_name,
        "DATA_DB_USER": config.data_db_user,
        "DATA_DB_PASSWORD": config.data_db_password,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise RuntimeError("Data Foundation database settings are incomplete: " + ", ".join(missing))
    if config.data_db_name != "redes_paineis_dados":
        raise RuntimeError("DATA_DB_NAME must be redes_paineis_dados")
    url = URL.create(
        drivername="mysql+pymysql",
        username=config.data_db_user,
        password=config.data_db_password,
        host=config.data_db_host,
        port=config.data_db_port,
        database=config.data_db_name,
    )
    return create_engine(url, pool_pre_ping=True, pool_recycle=1800)


@lru_cache(maxsize=4)
def _cached_data_database_engine(
    host: str,
    port: int,
    name: str,
    user: str,
    password: str,
) -> Engine:
    config = Settings(
        app_env="development",
        data_db_host=host,
        data_db_port=port,
        data_db_name=name,
        data_db_user=user,
        data_db_password=password,
    )
    return create_data_database_engine(config)


def get_data_database_engine(settings: Settings | None = None) -> Engine:
    config = settings or get_settings()
    required = (config.data_db_host, config.data_db_name, config.data_db_user, config.data_db_password)
    if not all(required):
        raise RuntimeError("data_store_unavailable")
    return _cached_data_database_engine(
        str(config.data_db_host),
        config.data_db_port,
        str(config.data_db_name),
        str(config.data_db_user),
        str(config.data_db_password),
    )


def create_session_factory(
    engine: Engine | None = None,
) -> sessionmaker[Session]:
    """Create a session factory only when explicitly requested by a caller."""
    return sessionmaker(
        bind=engine or create_database_engine(),
        autoflush=False,
        autocommit=False,
    )


@lru_cache(maxsize=8)
def _cached_session_factory(
    host: str,
    port: int,
    name: str,
    user: str,
    password: str,
) -> sessionmaker[Session]:
    settings = Settings(
        app_env="development",
        db_host=host,
        db_port=port,
        db_name=name,
        db_user=user,
        db_password=password,
    )
    return create_session_factory(create_database_engine(settings))


def get_session_factory(settings: Settings | None = None) -> sessionmaker[Session]:
    config = settings or get_settings()
    required = (config.db_host, config.db_name, config.db_user, config.db_password)
    if not all(required):
        raise RuntimeError("user_store_unavailable")
    return _cached_session_factory(
        str(config.db_host),
        config.db_port,
        str(config.db_name),
        str(config.db_user),
        str(config.db_password),
    )


def get_db_session() -> Generator[Session, None, None]:
    """Open a request-scoped DB session; never creates or migrates tables."""
    try:
        factory = get_session_factory()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="user_store_unavailable") from None

    session = factory()
    try:
        yield session
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(status_code=503, detail="user_store_unavailable") from None
    finally:
        session.close()


@contextmanager
def database_session(settings: Settings | None = None) -> Generator[Session, None, None]:
    """Session scope for non-FastAPI flows such as the Feishu callback."""
    try:
        factory = get_session_factory(settings)
    except RuntimeError:
        raise RuntimeError("user_store_unavailable") from None
    session = factory()
    try:
        yield session
    finally:
        session.close()
