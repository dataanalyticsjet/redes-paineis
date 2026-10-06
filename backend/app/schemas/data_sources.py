from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiSchema(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class ParsedWorkbookPayload(ApiSchema):
    sheet_name: str = Field(min_length=1, max_length=120)
    headers: list[str] = Field(min_length=1, max_length=1000)
    rows: list[dict[str, Any]] = Field(max_length=250_000)
    date_column: str | None = None
    base_column: str | None = None
    region_column: str | None = None
    origin_column: str | None = None
    status_column: str | None = None
    status_columns: list[str] = Field(default_factory=list, max_length=300)
    metadata: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list, max_length=200)


class PreviewSourceRequest(ApiSchema):
    file_name: str = Field(min_length=1, max_length=512)
    file_size_bytes: int = Field(gt=0)
    content_type: str = Field(default="", max_length=160)
    parsed: ParsedWorkbookPayload


class ImportSourceRequest(ApiSchema):
    preview_id: str = Field(pattern=r"^[0-9a-f-]{36}$")

\n