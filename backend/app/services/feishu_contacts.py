from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import Settings
from app.services.feishu_auth import _feishu_avatar_url


_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
_USER_URL = "https://open.feishu.cn/open-apis/contact/v3/users/{open_id}?user_id_type=open_id"
_DEPARTMENT_URL = "https://open.feishu.cn/open-apis/contact/v3/departments/{department_id}?department_id_type=open_department_id"
_MAX_MEMBERSHIPS = 20
_MAX_HIERARCHY_DEPTH = 32


class FeishuContactsError(Exception):
    """Sanitized Contacts failure; never includes provider payloads or identifiers."""

    def __init__(self, category: str, http_status: int | None = None) -> None:
        super().__init__(category)
        self.category = category
        self.http_status = http_status


@dataclass(frozen=True)
class FeishuOrganizationalProfile:
    union_id: str | None
    avatar_url: str | None
    department_paths: list[list[str]]


def _json_body(response: httpx.Response, category: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError:
        status = response.status_code
        safe_category = "contacts_permission_denied" if status in {401, 403} else category
        raise FeishuContactsError(safe_category, status) from None
    try:
        body = response.json()
    except (ValueError, TypeError):
        raise FeishuContactsError(category, response.status_code) from None
    if not isinstance(body, dict) or body.get("code") != 0:
        code = body.get("code") if isinstance(body, dict) else None
        safe_category = "contacts_permission_denied" if code in {40004, 99991663, 99991664, 99991668} else category
        raise FeishuContactsError(safe_category, response.status_code)
    return body


def _contact_avatar(user: dict[str, Any]) -> str | None:
    avatar = user.get("avatar")
    avatar = avatar if isinstance(avatar, dict) else {}
    return _feishu_avatar_url({
        "avatar_big": user.get("avatar_640") or avatar.get("avatar_640") or user.get("avatar_big"),
        "avatar_middle": user.get("avatar_240") or avatar.get("avatar_240") or user.get("avatar_middle"),
        "avatar_url": user.get("avatar_url"),
        "avatar_thumb": user.get("avatar_72") or avatar.get("avatar_72"),
    })


async def fetch_feishu_organizational_profile(
    open_id: str,
    settings: Settings,
    *,
    fallback_union_id: str | None = None,
    fallback_avatar_url: str | None = None,
) -> FeishuOrganizationalProfile:
    """Read a user's Contacts profile and department ancestors using app identity."""
    if not settings.feishu_oauth_app_id or not settings.feishu_oauth_app_secret or not open_id:
        raise FeishuContactsError("contacts_not_configured")

    timeout = httpx.Timeout(10.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            token_response = await client.post(
                _TOKEN_URL,
                json={
                    "app_id": settings.feishu_oauth_app_id,
                    "app_secret": settings.feishu_oauth_app_secret,
                },
            )
            token_body = _json_body(token_response, "contacts_token_unavailable")
            token = token_body.get("tenant_access_token")
            if not isinstance(token, str) or not token:
                raise FeishuContactsError("contacts_token_unavailable", token_response.status_code)
            headers = {"Authorization": f"Bearer {token}"}

            user_response = await client.get(
                _USER_URL.format(open_id=quote(open_id, safe="")),
                headers=headers,
            )
            user_body = _json_body(user_response, "contacts_user_unavailable")
            data = user_body.get("data")
            contact_user = data.get("user") if isinstance(data, dict) else None
            if not isinstance(contact_user, dict):
                raise FeishuContactsError("contacts_user_unavailable", user_response.status_code)

            raw_department_ids = contact_user.get("department_ids") or []
            if not isinstance(raw_department_ids, list) or len(raw_department_ids) > _MAX_MEMBERSHIPS:
                raise FeishuContactsError("contacts_department_data_invalid")
            department_ids = list(dict.fromkeys(
                item.strip() for item in raw_department_ids if isinstance(item, str) and item.strip()
            ))

            async def department_path(start_id: str) -> list[str]:
                current_id = start_id
                seen: set[str] = set()
                reverse_path: list[str] = []
                for _ in range(_MAX_HIERARCHY_DEPTH):
                    if current_id in seen:
                        raise FeishuContactsError("contacts_department_cycle")
                    seen.add(current_id)
                    response = await client.get(
                        _DEPARTMENT_URL.format(department_id=quote(current_id, safe="")),
                        headers=headers,
                    )
                    body = _json_body(response, "contacts_department_unavailable")
                    item_data = body.get("data")
                    department = item_data.get("department") if isinstance(item_data, dict) else None
                    if not isinstance(department, dict):
                        raise FeishuContactsError("contacts_department_unavailable", response.status_code)
                    actual_id = department.get("open_department_id")
                    if isinstance(actual_id, str) and actual_id:
                        current_id = actual_id
                    reverse_path.append(current_id)
                    parent_id = department.get("parent_department_id")
                    if not isinstance(parent_id, str) or not parent_id or parent_id == "0":
                        break
                    if current_id == parent_id:
                        raise FeishuContactsError("contacts_department_cycle")
                    current_id = parent_id
                else:
                    raise FeishuContactsError("contacts_hierarchy_too_deep")
                return list(reversed(reverse_path))

            paths = [await department_path(department_id) for department_id in department_ids]
    except FeishuContactsError:
        raise
    except httpx.TimeoutException:
        raise FeishuContactsError("contacts_timeout") from None
    except httpx.HTTPError:
        raise FeishuContactsError("contacts_network_unavailable") from None

    union_id = contact_user.get("union_id")
    if not isinstance(union_id, str) or not union_id.strip() or len(union_id.strip()) > 128:
        union_id = fallback_union_id
    else:
        union_id = union_id.strip()
    return FeishuOrganizationalProfile(
        union_id=union_id if isinstance(union_id, str) else None,
        avatar_url=_contact_avatar(contact_user) or fallback_avatar_url,
        department_paths=paths,
    )
