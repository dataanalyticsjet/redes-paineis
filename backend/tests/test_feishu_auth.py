from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from starlette.requests import Request
from fastapi.testclient import TestClient

from app.api.auth import _cookie_options
from app.core.config import get_settings
from app.main import app
from app.services import feishu_auth


@pytest.fixture(autouse=True)
def local_feishu_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("FRONTEND_BASE_URL", "http://127.0.0.1:3000")
    monkeypatch.setenv("FEISHU_OAUTH_ENABLED", "true")
    monkeypatch.setenv("FEISHU_OAUTH_APP_ID", "test-app-id")
    monkeypatch.setenv("FEISHU_OAUTH_APP_SECRET", "test-app-secret")
    monkeypatch.setenv(
        "FEISHU_OAUTH_REDIRECT_URI",
        "http://127.0.0.1:8000/api/auth/feishu/callback",
    )
    monkeypatch.setenv("FEISHU_SESSION_SECRET", "test-session-key-with-32-characters")
    monkeypatch.setenv("ALLOWED_CORPORATE_DOMAINS", "example.test")
    monkeypatch.setenv("FEISHU_ALLOWED_TENANT_KEY", "tenant-test")
    monkeypatch.delenv("FEISHU_VIEWER_ACCOUNTS_JSON", raising=False)
    get_settings.cache_clear()
    feishu_auth.reset_temporary_auth_state()
    yield
    feishu_auth.reset_temporary_auth_state()
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, base_url="http://127.0.0.1:8000")


class MockFeishuClient:
    last_post_json: dict[str, object] | None = None
    last_post_url: str | None = None

    def __init__(self, user_payload: dict[str, object]) -> None:
        self.user_payload = user_payload

    async def __aenter__(self) -> MockFeishuClient:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def post(self, url: str, **kwargs: object) -> httpx.Response:
        payload = kwargs.get("json")
        self.__class__.last_post_json = payload if isinstance(payload, dict) else None
        self.__class__.last_post_url = url
        return httpx.Response(
            200,
            json={"code": 0, "access_token": "test-feishu-token"},
            request=httpx.Request("POST", url),
        )

    async def get(self, url: str, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json=self.user_payload,
            request=httpx.Request("GET", url),
        )


def begin_login(client: TestClient) -> tuple[str, dict[str, list[str]]]:
    response = client.get("/api/auth/feishu/login", follow_redirects=False)
    assert response.status_code == 302
    authorize = urlsplit(response.headers["location"])
    parameters = parse_qs(authorize.query)
    assert authorize.netloc == "accounts.feishu.cn"
    assert "code_challenge_method" not in parameters
    assert "code_challenge" not in parameters
    assert parameters["redirect_uri"] == [
        "http://127.0.0.1:8000/api/auth/feishu/callback"
    ]
    return parameters["state"][0], parameters


def patch_feishu_user(
    monkeypatch: pytest.MonkeyPatch,
    user_payload: dict[str, object],
) -> None:
    monkeypatch.setattr(
        feishu_auth.httpx,
        "AsyncClient",
        lambda **_kwargs: MockFeishuClient(user_payload),
    )


def test_login_creates_state_and_pkce_without_exposing_credentials(
    client: TestClient,
) -> None:
    state, parameters = begin_login(client)

    assert len(state) >= 40
    assert client.cookies.get(feishu_auth.STATE_COOKIE) == state
    assert parameters["client_id"] == ["test-app-id"]
    assert "test-app-secret" not in client.get(
        "/api/auth/feishu/login", follow_redirects=False
    ).headers["location"]


def test_callback_rejects_invalid_state(client: TestClient) -> None:
    response = client.get(
        "/api/auth/feishu/callback?code=fake-code&state=invalid",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["authError"] == [
        "feishu_state_invalid"
    ]


def test_oauth_state_is_single_use() -> None:
    state = feishu_auth.create_oauth_attempt(get_settings())
    assert feishu_auth.consume_oauth_attempt(state, state, get_settings()) is True
    assert feishu_auth.consume_oauth_attempt(state, state, get_settings()) is False


def test_callback_without_code_does_not_create_a_session(client: TestClient) -> None:
    state, _ = begin_login(client)
    response = client.get(
        f"/api/auth/feishu/callback?state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["authError"] == [
        "feishu_token_request_invalid"
    ]
    assert client.get("/api/auth/me").status_code == 401


def test_session_absent_and_logout_are_handled(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401

    response = client.post("/api/auth/logout")

    assert response.status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_unauthorized_feishu_user_is_blocked(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "enterprise_email": "other@outside.test",
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
            },
        },
    )
    state, _ = begin_login(client)

    response = client.get(
        f"/api/auth/feishu/callback?code=fake-code&state={state}",
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["authError"] == [
        "feishu_domain_denied"
    ]
    assert client.get("/api/auth/me").status_code == 401


def test_authorized_login_creates_local_session_and_logout_revokes_it(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    user_test_session_factory,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "enterprise_email": " ALLOWED@example.test ",
                "email": "different@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
                "name": "Demo Viewer",
            },
        },
    )
    state, _ = begin_login(client)

    callback = client.get(
        f"/api/auth/feishu/callback?code=fake-code&state={state}",
        follow_redirects=False,
    )
    assert callback.status_code == 302
    assert callback.headers["location"] == "http://127.0.0.1:3000/"
    assert feishu_auth.SESSION_COOKIE in callback.headers["set-cookie"]
    set_cookie_headers = callback.headers.get_list("set-cookie")
    session_cookie = next(
        value.lower()
        for value in set_cookie_headers
        if value.startswith(f"{feishu_auth.SESSION_COOKIE}=")
    )
    state_cookie = next(
        value.lower()
        for value in set_cookie_headers
        if value.startswith(f"{feishu_auth.STATE_COOKIE}=")
    )
    assert "httponly" in session_cookie
    assert "samesite=lax" in session_cookie
    assert "path=/" in session_cookie
    assert f"max-age={feishu_auth.SESSION_TTL_SECONDS}" in session_cookie
    assert "max-age=0" in state_cookie

    # A second request represents a page reload: the browser cookie retains the session.
    identity = client.get("/api/auth/me")
    assert identity.status_code == 200
    assert identity.json() == {
        "authenticated": True,
        "username": "Demo Viewer",
        "avatar_url": None,
        "role": "unknown",
        "region": None,
        "base": None,
        "platform_role": "USER",
        "administrative_scope": "base",
        "can_manage_users": False,
        "organizational_scope": "unknown",
        "data_scope_source": "none",
        "home_region": None,
        "home_base": None,
        "additional_regions": [],
        "effective_regions": [],
        "is_active": True,
        "organizational_region_code": None,
        "region_resolution_status": "UNKNOWN",
        "organizational_scope_reason": "legacy_policy",
        "organizational_scope_policy": "LEGACY",
        "organizational_scope_v2_enabled": False,
    }

    from sqlalchemy import select

    from app.models import PlatformUser

    with user_test_session_factory() as db:
        provisioned = db.scalar(
            select(PlatformUser).where(
                PlatformUser.tenant_key == "tenant-test",
                PlatformUser.open_id == "open-id-test",
            )
        )
        assert provisioned is not None
        assert provisioned.email == "allowed@example.test"
        assert provisioned.email != "different@example.test"

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_login_rejects_localhost_alias_for_loopback_callback() -> None:
    with TestClient(app, base_url="http://localhost:8000") as alias_client:
        response = alias_client.get("/api/auth/feishu/login", follow_redirects=False)

    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["authError"] == [
        "feishu_callback_mismatch"
    ]


def test_callback_uses_direct_oauth_query_parameters(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
            },
        },
    )
    state, _ = begin_login(client)

    callback = client.get(
        "/api/auth/feishu/callback?code=fake-code-from-feishu&state=" + state,
        follow_redirects=False,
    )

    assert callback.status_code == 302
    assert callback.headers["location"] == "http://127.0.0.1:3000/"
    assert client.get("/api/auth/me").status_code == 200


def test_authenticated_profile_exposes_only_valid_feishu_avatar_url(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "private-open-id",
                "union_id": "private-union-id",
                "name": "PHELIPPE LUCIANO CARDOSO",
                "avatar_middle": "https://s3-imfile.feishucdn.com/avatar-240.png",
                "avatar_big": "https://s3-imfile.feishucdn.com/avatar-640.png",
            },
        },
    )
    state, _ = begin_login(client)
    callback = client.get(
        f"/api/auth/feishu/callback?code=oauth-code&state={state}",
        follow_redirects=False,
    )

    assert callback.status_code == 302
    profile = client.get("/api/auth/me")

    assert profile.status_code == 200
    assert profile.json()["avatar_url"] == "https://s3-imfile.feishucdn.com/avatar-640.png"
    assert profile.json()["username"] == "PHELIPPE LUCIANO CARDOSO"
    assert "open_id" not in profile.json()
    assert "union_id" not in profile.json()
    assert "email" not in profile.json()
    assert "access_token" not in profile.json()
    assert "department_paths" not in profile.json()
    assert profile.json()["organizational_region_code"] is None
    assert profile.json()["region_resolution_status"] == "UNKNOWN"


def test_authenticated_profile_exposes_resolved_organizational_region_without_private_paths(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    user_test_session_factory,
) -> None:
    from app.services.feishu_contacts import FeishuOrganizationalProfile

    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "private-open-id",
                "union_id": "private-union-id",
            },
        },
    )

    async def resolved_profile(*_args: object, **_kwargs: object):
        return FeishuOrganizationalProfile(
            union_id="private-union-id",
            avatar_url=None,
            department_paths=[["od-3d75c10ce15130e199fc3b42e4e86a04"]],
        )

    monkeypatch.setattr("app.api.auth.fetch_feishu_organizational_profile", resolved_profile)
    state, _ = begin_login(client)
    assert client.get(
        f"/api/auth/feishu/callback?code=oauth-code&state={state}",
        follow_redirects=False,
    ).status_code == 302

    profile = client.get("/api/auth/me").json()
    assert profile["organizational_region_code"] == "SPN"
    assert profile["region_resolution_status"] == "RESOLVED"
    assert "department_paths" not in profile
    assert "union_id" not in profile
    assert "open_id" not in profile

    from sqlalchemy import select

    from app.models import PlatformUser

    with user_test_session_factory() as db:
        provisioned = db.scalar(
            select(PlatformUser).where(
                PlatformUser.tenant_key == "tenant-test",
                PlatformUser.open_id == "private-open-id",
            )
        )
        assert provisioned is not None
        assert provisioned.platform_role == "USER"
        assert provisioned.organizational_scope == "base"
        assert provisioned.home_region is None
        assert provisioned.home_base is None


def test_contacts_failure_does_not_block_login(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    user_test_session_factory,
) -> None:
    from app.services.feishu_contacts import FeishuContactsError

    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "private-open-id",
            },
        },
    )

    async def unavailable(*_args: object, **_kwargs: object):
        raise FeishuContactsError("contacts_permission_denied", 200)  # Feishu code 40004

    monkeypatch.setattr("app.api.auth.fetch_feishu_organizational_profile", unavailable)
    state, _ = begin_login(client)
    callback = client.get(
        f"/api/auth/feishu/callback?code=oauth-code&state={state}",
        follow_redirects=False,
    )
    assert callback.status_code == 302
    profile = client.get("/api/auth/me").json()
    assert profile["region_resolution_status"] == "SYNC_FAILED"

    from sqlalchemy import select

    from app.models import PlatformUser

    with user_test_session_factory() as db:
        provisioned = db.scalar(
            select(PlatformUser).where(
                PlatformUser.tenant_key == "tenant-test",
                PlatformUser.open_id == "private-open-id",
            )
        )
        assert provisioned is not None
        assert provisioned.platform_role == "USER"
        assert provisioned.organizational_scope == "base"
        assert provisioned.home_region is None
        assert provisioned.home_base is None


@pytest.mark.parametrize(
    ("profile", "expected"),
    [
        ({"avatar_big": "http://s3-imfile.feishucdn.com/avatar.png"}, None),
        ({"avatar_big": "https://example.test/avatar.png"}, None),
        ({"avatar_big": "https://s3-imfile.feishucdn.com/avatar.png"}, "https://s3-imfile.feishucdn.com/avatar.png"),
        ({"avatar_big": "invalid", "avatar_middle": "https://s3-imfile.feishucdn.com/middle.png"}, "https://s3-imfile.feishucdn.com/middle.png"),
    ],
)
def test_feishu_avatar_selection_rejects_untrusted_urls(
    profile: dict[str, str],
    expected: str | None,
) -> None:
    assert feishu_auth._feishu_avatar_url(profile) == expected


def test_callback_uses_v2_token_exchange_without_pkce_and_logs_no_oauth_values(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
            },
        },
    )
    caplog.set_level("INFO")
    state, parameters = begin_login(client)
    code = "authorization-code-that-must-not-be-logged"

    callback = client.get(
        f"/api/auth/feishu/callback?code={code}&state={state}",
        follow_redirects=False,
    )

    assert callback.status_code == 302
    token_request = MockFeishuClient.last_post_json
    assert token_request is not None
    assert token_request["code"] == code
    assert "code_verifier" not in token_request
    assert "code_challenge" not in parameters
    assert MockFeishuClient.last_post_url == "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
    application_logs = "\n".join(
        record.getMessage()
        for record in caplog.records
        if record.name.startswith("app.")
    )
    for sensitive_value in (
        state,
        code,
        "test-app-secret",
        "test-feishu-token",
        "allowed@example.test",
    ):
        assert sensitive_value not in application_logs


def test_callback_honors_direct_authorization_error_query(
    client: TestClient,
) -> None:
    state, _ = begin_login(client)

    callback = client.get(
        f"/api/auth/feishu/callback?state={state}&error=access_denied",
        follow_redirects=False,
    )

    assert callback.status_code == 303
    assert parse_qs(urlsplit(callback.headers["location"]).query)["authError"] == [
        "feishu_consent_denied"
    ]



def test_feishu_tenant_mismatch_is_rejected_by_callback(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch_feishu_user(
        monkeypatch,
        {
            "code": 0,
            "data": {
                "enterprise_email": "employee@example.test",
                "tenant_key": "untrusted-tenant",
                "open_id": "untrusted-open-id",
            },
        },
    )
    state, _ = begin_login(client)
    response = client.get(
        f"/api/auth/feishu/callback?code=fake-code&state={state}",
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["authError"] == [
        "feishu_tenant_denied"
    ]
    assert client.get("/api/auth/me").status_code == 401


def test_email_fallback_uses_only_provider_identity_and_allowlist_is_not_required() -> None:
    settings = get_settings()
    assert feishu_auth.configuration_is_ready(settings)
    assert not hasattr(settings, "feishu_viewer_accounts_json")

    identity = feishu_auth.resolve_authorized_viewer(
        {
            "enterprise_email": " ",
            "email": " ALLOWED@example.test ",
            "tenant_key": "tenant-test",
            "open_id": "open-id-test",
            "name": "Corporate User",
        },
        settings,
    )
    assert identity["_email"] == "allowed@example.test"
    assert identity["username"] == "Corporate User"
    assert "role" not in identity
    assert "region" not in identity
    assert "base" not in identity

    with pytest.raises(feishu_auth.FeishuAuthError, match="feishu_domain_denied"):
        feishu_auth.resolve_authorized_viewer(
            {
                "enterprise_email": "other@outside.test",
                "email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
            },
            settings,
        )


def test_feishu_tenant_mismatch_is_rejected() -> None:
    with pytest.raises(feishu_auth.FeishuAuthError, match="feishu_tenant_denied"):
        feishu_auth.resolve_authorized_viewer(
            {
                "enterprise_email": "allowed@example.test",
                "tenant_key": "another-tenant",
                "open_id": "open-id-test",
            },
            get_settings(),
        )


def test_missing_authorized_tenant_fails_closed() -> None:
    settings = get_settings().model_copy(update={"feishu_allowed_tenant_key": None})
    assert not feishu_auth.configuration_is_ready(settings)
    with pytest.raises(feishu_auth.FeishuAuthError, match="feishu_not_configured"):
        feishu_auth.resolve_authorized_viewer(
            {
                "enterprise_email": "allowed@example.test",
                "tenant_key": "tenant-test",
                "open_id": "open-id-test",
            },
            settings,
        )


def test_feishu_owner_subject_uses_tenant_and_open_id_not_display_name() -> None:
    settings = get_settings()
    first = feishu_auth.resolve_authorized_viewer(
        {
            "email": "allowed@example.test",
            "tenant_key": "tenant-test",
            "open_id": "open-id-one",
            "name": "Same Display Name",
        },
        settings,
    )
    second = feishu_auth.resolve_authorized_viewer(
        {
            "email": "allowed@example.test",
            "tenant_key": "tenant-test",
            "open_id": "open-id-two",
            "name": "Same Display Name",
        },
        settings,
    )

    assert first["username"] == second["username"]
    assert first["_owner_subject"] != second["_owner_subject"]
    assert feishu_auth.SESSION_COOKIE not in first


def test_production_cookie_is_secure_even_behind_http_proxy(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATA_DIRECTORY", str(tmp_path / "production-data"))
    get_settings.cache_clear()
    request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [],
            "server": ("127.0.0.1", 8000),
            "client": ("127.0.0.1", 40000),
        }
    )

    assert _cookie_options(request, 60)["secure"] is True
    get_settings.cache_clear()

def test_auth_me_survives_failure_of_optional_profile_store(
    client: TestClient,
    create_user_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy.exc import SQLAlchemyError
    from sqlalchemy.orm import Session

    from app.models import PlatformUserFeishuProfile

    token, user = create_user_session(
        platform_role="USER",
        organizational_scope="regional",
        home_region="SPS",
        identity_suffix="optional-profile-store",
    )
    client.cookies.set(feishu_auth.SESSION_COOKIE, token)
    original_get = Session.get

    def fail_only_optional_profile(
        session: Session,
        entity,
        ident,
        **kwargs: object,
    ):
        if entity is PlatformUserFeishuProfile:
            raise SQLAlchemyError("private database diagnostic")
        return original_get(session, entity, ident, **kwargs)

    monkeypatch.setattr(Session, "get", fail_only_optional_profile)
    response = client.get("/api/auth/me")

    assert response.status_code == 200
    body = response.json()
    assert body["authenticated"] is True
    assert body["platform_role"] == "USER"
    # If the optional profile store is unreadable, keep login but fail closed
    # for operational data rather than falling back to platform home_region.
    assert body["organizational_scope"] == "unknown"
    assert body["home_region"] is None
    assert body["administrative_scope"] == "regional"
    assert body["organizational_region_code"] is None
    assert body["region_resolution_status"] == "UNKNOWN"
    assert "private database diagnostic" not in response.text
    assert "department_paths" not in body
    assert "union_id" not in body
    assert user.platform_role == "USER"
