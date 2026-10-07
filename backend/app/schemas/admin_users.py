from __future__ import annotations

from pydantic import Field

from app.schemas.data_sources import ApiSchema


class AdminUserUpdate(ApiSchema):
    platform_role: str | None = Field(default=None, pattern=r"^(USER|ADMIN)$")
    additional_regions: list[str] | None = Field(default=None, max_length=64)
    is_active: bool | None = None
