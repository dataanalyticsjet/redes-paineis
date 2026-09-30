from functools import lru_cache
from pathlib import Path

from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_env: str = "development"

    db_host: str | None = None
    db_port: int = 3306
    db_name: str | None = None
    db_user: str | None = None
    db_password: str | None = None

    frontend_base_url: AnyHttpUrl = "http://localhost:3000"

    feishu_oauth_enabled: bool = False
    feishu_oauth_app_id: str | None = None
    feishu_oauth_app_secret: str | None = None
    feishu_oauth_redirect_uri: AnyHttpUrl | None = None
    feishu_session_secret: str | None = None

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_ignore_empty=True,
        extra="ignore",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
