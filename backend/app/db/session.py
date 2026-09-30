from sqlalchemy import Engine, URL, create_engine
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


def create_session_factory(
    engine: Engine | None = None,
) -> sessionmaker[Session]:
    """Create a session factory only when explicitly requested by a caller."""
    return sessionmaker(
        bind=engine or create_database_engine(),
        autoflush=False,
        autocommit=False,
    )
