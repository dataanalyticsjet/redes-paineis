from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.main import app
from app.core.config import Settings
from app.db.session import create_database_engine


def test_health_returns_ok_without_database_access() -> None:
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_development_cors_uses_configured_frontend_origin() -> None:
    cors_middleware = next(
        middleware
        for middleware in app.user_middleware
        if middleware.cls is CORSMiddleware
    )

    assert cors_middleware.kwargs["allow_origins"] == ["http://localhost:3001"]
    assert "*" not in cors_middleware.kwargs["allow_origins"]


def test_mysql_engine_is_configured_without_opening_a_connection() -> None:
    engine = create_database_engine(
        Settings(
            db_host="127.0.0.1",
            db_name="test_database",
            db_user="app_user",
            db_password="test-only",
        )
    )

    assert engine.dialect.name == "mysql"
    assert engine.pool.checkedout() == 0
    engine.dispose()
