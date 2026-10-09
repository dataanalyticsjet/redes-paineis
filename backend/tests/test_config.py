from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import DEFAULT_DATA_DIRECTORY, PROJECT_ROOT, Settings


def test_production_requires_explicit_data_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("DATA_DIRECTORY", raising=False)

    with pytest.raises(ValidationError, match="DATA_DIRECTORY must be explicitly configured"):
        Settings(_env_file=None)


def test_production_requires_absolute_directory_outside_repository(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="absolute path outside the project"):
        Settings(_env_file=None, app_env="production", data_directory=PROJECT_ROOT / "public" / "data")

    relative_path = Path("redes-paineis-data")
    with pytest.raises(ValidationError, match="absolute path outside the project"):
        Settings(_env_file=None, app_env="production", data_directory=relative_path)

    settings = Settings(_env_file=None, app_env="production", data_directory=tmp_path / "redes-paineis-data")
    assert settings.data_directory == tmp_path / "redes-paineis-data"


def test_development_keeps_the_existing_data_directory_fallback() -> None:
    settings = Settings(_env_file=None, app_env="development")

    assert settings.data_directory == DEFAULT_DATA_DIRECTORY


def test_data_sources_are_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATA_SOURCES_ENABLED", raising=False)

    settings = Settings(_env_file=None, app_env="development")

    assert settings.data_sources_enabled is False


def test_data_foundation_uses_dedicated_database_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "DATA_DB_HOST", "DATA_DB_NAME", "DATA_DB_USER", "DATA_DB_PASSWORD",
        "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DB_HOST", "auth-db.example.test")
    monkeypatch.setenv("DB_NAME", "redes_paineis")
    monkeypatch.setenv("DB_USER", "auth_user")
    monkeypatch.setenv("DB_PASSWORD", "auth_secret")

    with pytest.raises(ValidationError, match="DATA_DB_HOST"):
        Settings(_env_file=None, data_queries_enabled=True)


def test_data_foundation_imports_require_an_external_private_staging_path(tmp_path: Path) -> None:
    base = {
        "data_import_enabled": True,
        "data_db_host": "localhost",
        "data_db_name": "redes_paineis_dados",
        "data_db_user": "foundation_user",
        "data_db_password": "test-only-secret",
    }
    with pytest.raises(ValidationError, match="DATA_IMPORT_STAGING_DIRECTORY is required"):
        Settings(_env_file=None, **base)

    settings = Settings(_env_file=None, **base, data_import_staging_directory=tmp_path / "private-staging")
    assert settings.data_import_staging_directory == tmp_path / "private-staging"
