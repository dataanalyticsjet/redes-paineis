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
