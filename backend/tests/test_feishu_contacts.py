import asyncio

import httpx
import pytest

from app.core.config import Settings
from app.services import feishu_contacts
from app.services.feishu_contacts import FeishuContactsError, fetch_feishu_organizational_profile


JT_BRASIL = "od-33e90ac1a93b12c1b65347320e648498"
SPN = "od-3d75c10ce15130e199fc3b42e4e86a04"


class MockContactsClient:
    def __init__(self, *, timeout):
        self.timeout = timeout
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, *, json):
        self.calls.append(("POST", url))
        return httpx.Response(
            200,
            json={"code": 0, "tenant_access_token": "mock-token"},
            request=httpx.Request("POST", url),
        )

    async def get(self, url, *, headers):
        self.calls.append(("GET", url, headers.get("Authorization")))
        if "/users/" in url:
            payload = {
                "code": 0,
                "data": {
                    "user": {
                        "union_id": "mock-union",
                        "department_ids": ["leaf"],
                        "avatar": {"avatar_640": "https://s3-imfile.feishucdn.com/photo.png"},
                    }
                },
            }
        elif url.endswith("/leaf?department_id_type=open_department_id"):
            payload = {"code": 0, "data": {"department": {
                "open_department_id": "leaf",
                "parent_department_id": SPN,
            }}}
        elif url.endswith(f"/{SPN}?department_id_type=open_department_id"):
            payload = {"code": 0, "data": {"department": {
                "open_department_id": SPN,
                "parent_department_id": JT_BRASIL,
            }}}
        elif url.endswith(f"/{JT_BRASIL}?department_id_type=open_department_id"):
            payload = {"code": 0, "data": {"department": {
                "open_department_id": JT_BRASIL,
                "parent_department_id": "0",
            }}}
        else:
            payload = {"code": 99991663, "msg": "mock permission detail must not escape"}
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))


def test_contacts_user_and_department_hierarchy_are_read_with_mocked_http(monkeypatch):
    client = MockContactsClient(timeout=None)
    monkeypatch.setattr(feishu_contacts.httpx, "AsyncClient", lambda **_kwargs: client)
    settings = Settings(
        feishu_oauth_app_id="mock-app",
        feishu_oauth_app_secret="mock-secret",
        _env_file=None,
    )

    async def run():
        return await fetch_feishu_organizational_profile(
            "mock-open-id",
            settings,
            fallback_avatar_url=None,
        )

    profile = asyncio.run(run())

    assert profile.union_id == "mock-union"
    assert profile.avatar_url == "https://s3-imfile.feishucdn.com/photo.png"
    assert profile.department_paths == [[JT_BRASIL, SPN, "leaf"]]
    assert len(client.calls) == 5
    user_request = next(call[1] for call in client.calls if call[0] == "GET" and "/users/" in call[1])
    assert "user_id_type=open_id" in user_request
    assert "department_id_type=open_department_id" in user_request
    assert all(call[-1] == "Bearer mock-token" for call in client.calls if call[0] == "GET")
    assert "mock-secret" not in repr(profile)
    assert "mock-token" not in repr(profile)


def test_contacts_permission_error_is_sanitized(monkeypatch):
    class ForbiddenClient(MockContactsClient):
        async def get(self, url, *, headers):
            return httpx.Response(
                403,
                text="provider body contains private diagnostics",
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(
        feishu_contacts.httpx,
        "AsyncClient",
        lambda **_kwargs: ForbiddenClient(timeout=None),
    )
    settings = Settings(
        feishu_oauth_app_id="mock-app",
        feishu_oauth_app_secret="mock-secret",
        _env_file=None,
    )

    async def run():
        with pytest.raises(FeishuContactsError) as caught:
            await fetch_feishu_organizational_profile("mock-open-id", settings)
        return caught.value

    error = asyncio.run(run())
    assert error.category == "contacts_permission_denied"
    assert "private diagnostics" not in str(error)
    assert "mock-secret" not in str(error)


def test_contacts_incomplete_hierarchy_fails_closed_instead_of_treating_missing_parent_as_root(
    monkeypatch,
):
    class IncompleteHierarchyClient(MockContactsClient):
        async def get(self, url, *, headers):
            self.calls.append(("GET", url, headers.get("Authorization")))
            if "/users/" in url:
                payload = {"code": 0, "data": {"user": {"department_ids": ["partial"]}}}
            else:
                payload = {"code": 0, "data": {"department": {"open_department_id": "partial"}}}
            return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    client = IncompleteHierarchyClient(timeout=None)
    monkeypatch.setattr(feishu_contacts.httpx, "AsyncClient", lambda **_kwargs: client)
    settings = Settings(feishu_oauth_app_id="mock-app", feishu_oauth_app_secret="mock-secret", _env_file=None)

    with pytest.raises(FeishuContactsError, match="contacts_hierarchy_incomplete"):
        asyncio.run(fetch_feishu_organizational_profile("mock-open-id", settings))

    assert not any(
        call[1].endswith(f"/{JT_BRASIL}?department_id_type=open_department_id")
        for call in client.calls
        if call[0] == "GET"
    )


def test_contacts_department_requests_have_a_global_limit(monkeypatch):
    class LongHierarchyClient(MockContactsClient):
        async def get(self, url, *, headers):
            self.calls.append(("GET", url, headers.get("Authorization")))
            if "/users/" in url:
                payload = {"code": 0, "data": {"user": {"department_ids": ["node-0"]}}}
            else:
                department_id = url.split("/departments/", 1)[1].split("?", 1)[0]
                index = int(department_id.removeprefix("node-"))
                parent = f"node-{index + 1}" if index < 3 else "0"
                payload = {"code": 0, "data": {"department": {
                    "open_department_id": department_id, "parent_department_id": parent
                }}}
            return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    client = LongHierarchyClient(timeout=None)
    monkeypatch.setattr(feishu_contacts.httpx, "AsyncClient", lambda **_kwargs: client)
    monkeypatch.setattr(feishu_contacts, "_MAX_DEPARTMENT_REQUESTS", 2)
    settings = Settings(feishu_oauth_app_id="mock-app", feishu_oauth_app_secret="mock-secret", _env_file=None)

    with pytest.raises(FeishuContactsError, match="contacts_request_limit"):
        asyncio.run(fetch_feishu_organizational_profile("mock-open-id", settings))

    department_calls = [call for call in client.calls if call[0] == "GET" and "/departments/" in call[1]]
    assert len(department_calls) == 2


def test_contacts_multiple_departments_reuse_shared_ancestor_requests(monkeypatch):
    class MultiDepartmentClient(MockContactsClient):
        async def get(self, url, *, headers):
            self.calls.append(("GET", url, headers.get("Authorization")))
            if "/users/" in url:
                departments = ["leaf-one", "leaf-two"]
                payload = {"code": 0, "data": {"user": {"department_ids": departments}}}
            else:
                department_id = url.split("/departments/", 1)[1].split("?", 1)[0]
                parents = {
                    "leaf-one": SPN,
                    "leaf-two": SPN,
                    SPN: JT_BRASIL,
                    JT_BRASIL: "0",
                }
                payload = {"code": 0, "data": {"department": {
                    "open_department_id": department_id,
                    "parent_department_id": parents[department_id],
                }}}
            return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    client = MultiDepartmentClient(timeout=None)
    monkeypatch.setattr(feishu_contacts.httpx, "AsyncClient", lambda **_kwargs: client)
    settings = Settings(feishu_oauth_app_id="mock-app", feishu_oauth_app_secret="mock-secret", _env_file=None)

    profile = asyncio.run(fetch_feishu_organizational_profile("mock-open-id", settings))

    assert profile.department_paths == [
        [JT_BRASIL, SPN, "leaf-one"],
        [JT_BRASIL, SPN, "leaf-two"],
    ]
    department_calls = [call for call in client.calls if call[0] == "GET" and "/departments/" in call[1]]
    assert len(department_calls) == 4

def test_contacts_code_40004_is_reported_as_access_or_visibility_failure():
    response = httpx.Response(
        200,
        json={"code": 40004, "msg": "private provider message"},
        request=httpx.Request("GET", "https://open.feishu.cn/open-apis/contact/v3/users/example"),
    )

    with pytest.raises(FeishuContactsError) as caught:
        feishu_contacts._json_body(response, "contacts_user_unavailable")

    assert caught.value.category == "contacts_permission_denied"
    assert caught.value.http_status == 200
    assert "private provider message" not in str(caught.value)
