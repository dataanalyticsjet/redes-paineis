from functools import lru_cache
import os
from pathlib import Path
import re

from typing import Any

from pydantic import AnyHttpUrl, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BACKEND_ROOT.parent
LOCAL_APP_DATA = os.environ.get("LOCALAPPDATA")
XDG_DATA_HOME = os.environ.get("XDG_DATA_HOME")
DEFAULT_DATA_DIRECTORY = (
    Path(LOCAL_APP_DATA) / "RedesPaineis" / "data"
    if LOCAL_APP_DATA
    else Path(XDG_DATA_HOME) / "redes-paineis" / "data"
    if XDG_DATA_HOME
    else Path.home() / ".local" / "share" / "redes-paineis" / "data"
)


class Settings(BaseSettings):
    app_env: str = "development"

    db_host: str | None = None
    db_port: int = 3306
    db_name: str | None = None
    db_user: str | None = None
    db_password: str | None = None

    frontend_base_url: AnyHttpUrl = "http://localhost:3001"
    data_directory: Path = DEFAULT_DATA_DIRECTORY
    upload_username: str | None = None
    upload_password: str | None = None

    feishu_oauth_enabled: bool = False
    feishu_oauth_app_id: str | None = None
    feishu_oauth_app_secret: str | None = None
    feishu_oauth_authorize_url: AnyHttpUrl = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
    feishu_oauth_token_url: AnyHttpUrl = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
    feishu_oauth_userinfo_url: AnyHttpUrl = "https://open.feishu.cn/open-apis/authen/v1/user_info"
    feishu_oauth_redirect_uri: AnyHttpUrl | None = None
    feishu_session_secret: str | None = None
    feishu_viewer_accounts_json: str = "[]"
    allowed_corporate_domains: str = "jtexpress.com.br"

    @model_validator(mode="before")
    @classmethod
    def require_external_data_directory_in_production(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values

        app_env = str(values.get("app_env", os.environ.get("APP_ENV", "development"))).strip().lower()
        configured_directory = values.get("data_directory", os.environ.get("DATA_DIRECTORY"))
        if app_env not in {"production", "prod"}:
            return values
        if not configured_directory:
            raise ValueError("DATA_DIRECTORY must be explicitly configured in production")

        directory = Path(configured_directory).expanduser()
        if not directory.is_absolute() or directory.resolve().is_relative_to(PROJECT_ROOT.resolve()):
            raise ValueError("DATA_DIRECTORY must be an absolute path outside the project in production")
        return values

    @property
    def corporate_domain_allowlist(self) -> frozenset[str]:
        candidates = (
            domain.strip().lower().removeprefix("@").rstrip(".")
            for domain in self.allowed_corporate_domains.split(",")
            if domain.strip()
        )
        return frozenset(
            domain
            for domain in candidates
            if re.fullmatch(
                r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}",
                domain,
            )
        )

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_ignore_empty=True,
        extra="ignore",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
