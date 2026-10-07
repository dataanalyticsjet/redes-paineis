from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from app.core.config import Settings

logger = logging.getLogger(__name__)

STATE_COOKIE = "jt_feishu_oauth_state"
SESSION_COOKIE = "jt_dashboard_session"
CALLBACK_PATH = "/api/auth/feishu/callback"
STATE_TTL_SECONDS = 600
SESSION_TTL_SECONDS = 8 * 60 * 60


@dataclass(frozen=True)
class OAuthAttempt:
    expires_at: float


@dataclass(frozen=True)
class LocalViewer:
    email: str
    tenant_key: str
    role: str
    region: str | None
    base: str | None


class FeishuAuthError(Exception):
    def __init__(self, code: str, http_status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status


_store_lock = threading.Lock()
_oauth_attempts: dict[str, OAuthAttempt] = {}
_consumed_oauth_attempts: dict[str, float] = {}
_sessions: dict[str, tuple[dict[str, str | None], float]] = {}
MAX_OAUTH_ATTEMPTS = 1024
MAX_CONSUMED_OAUTH_ATTEMPTS = 4096


def reset_temporary_auth_state() -> None:
    """Clear in-memory state for isolated automated tests."""
    with _store_lock:
        _oauth_attempts.clear()
        _consumed_oauth_attempts.clear()
        _sessions.clear()


def parse_viewer_allowlist(value: str) -> list[LocalViewer] | None:
    try:
        parsed: Any = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, list) or not parsed:
        return None

    viewers: list[LocalViewer] = []
    identities: set[tuple[str, str]] = set()
    for item in parsed:
        if not isinstance(item, dict):
            return None
        email = str(item.get("email") or "").strip().lower()
        tenant_key = str(item.get("tenant_key") or "").strip()
        role = item.get("role")
        region = str(item.get("region") or "").strip().upper() or None
        base = str(item.get("base") or "").strip().upper() or None
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or not tenant_key:
            return None
        if role not in {"regional", "matrix"}:
            return None
        if role == "regional" and not (region or base):
            return None
        if role == "matrix" and (region or base):
            return None
        identity = (email, tenant_key)
        if identity in identities:
            return None
        identities.add(identity)
        viewers.append(LocalViewer(email, tenant_key, role, region, base))
    return viewers


def configuration_is_ready(settings: Settings) -> bool:
    return bool(
        settings.feishu_oauth_enabled
        and settings.feishu_oauth_app_id
        and settings.feishu_oauth_app_secret
        and settings.feishu_oauth_redirect_uri
        and settings.feishu_session_secret
        and len(settings.feishu_session_secret) >= 32
        and settings.corporate_domain_allowlist
        and parse_viewer_allowlist(settings.feishu_viewer_accounts_json)
    )


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _keyed_digest(value: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def create_oauth_attempt(settings: Settings) -> str:
    state = _base64url(secrets.token_bytes(32))
    now = time.time()
    with _store_lock:
        for key, attempt in list(_oauth_attempts.items()):
            if attempt.expires_at <= now:
                _oauth_attempts.pop(key, None)
        for key, expires_at in list(_consumed_oauth_attempts.items()):
            if expires_at <= now:
                _consumed_oauth_attempts.pop(key, None)
        if len(_oauth_attempts) >= MAX_OAUTH_ATTEMPTS:
            oldest = min(_oauth_attempts, key=lambda key: _oauth_attempts[key].expires_at)
            _oauth_attempts.pop(oldest, None)
        if len(_consumed_oauth_attempts) >= MAX_CONSUMED_OAUTH_ATTEMPTS:
            oldest_consumed = min(_consumed_oauth_attempts, key=_consumed_oauth_attempts.get)
            _consumed_oauth_attempts.pop(oldest_consumed, None)
        _oauth_attempts[_keyed_digest(state, settings.feishu_session_secret or "")] = OAuthAttempt(
            expires_at=now + STATE_TTL_SECONDS,
        )
    return state


def consume_oauth_attempt(state: str | None, cookie_state: str | None, settings: Settings) -> bool:
    if not state:
        logger.warning("Feishu OAuth state validation failed (callback state missing)")
        return False
    if not cookie_state:
        logger.warning("Feishu OAuth state validation failed (browser cookie missing)")
        return False
    if not hmac.compare_digest(state, cookie_state):
        logger.warning("Feishu OAuth state validation failed (browser state mismatch)")
        return False
    state_key = _keyed_digest(state, settings.feishu_session_secret or "")
    with _store_lock:
        attempt = _oauth_attempts.pop(state_key, None)
        was_consumed = state_key in _consumed_oauth_attempts
        if attempt:
            _consumed_oauth_attempts[state_key] = attempt.expires_at
    if not attempt:
        reason = "state reused" if was_consumed else "state not issued or no longer available"
        logger.warning("Feishu OAuth state validation failed (%s)", reason)
        return False
    if attempt.expires_at <= time.time():
        logger.warning("Feishu OAuth state validation failed (attempt expired)")
        return False
    return True


def redirect_uri_matches_request(settings: Settings, request_url: str) -> bool:
    configured = urlsplit(str(settings.feishu_oauth_redirect_uri or ""))
    request = urlsplit(request_url)
    if not configured.scheme or configured.query or configured.fragment or configured.path != CALLBACK_PATH:
        return False
    if (configured.scheme, configured.netloc, configured.path) != (
        request.scheme,
        request.netloc,
        request.path,
    ):
        return False
    is_local_http = configured.scheme == "http" and configured.hostname in {
        "localhost",
        "127.0.0.1",
    }
    return configured.scheme == "https" or (
        settings.app_env == "development" and is_local_http
    )


def authorization_request_matches(settings: Settings, request_url: str) -> bool:
    configured = urlsplit(str(settings.feishu_oauth_redirect_uri or ""))
    request = urlsplit(request_url)
    if not configured.scheme or configured.path != CALLBACK_PATH or configured.query or configured.fragment:
        return False
    if (configured.scheme, configured.netloc) != (request.scheme, request.netloc):
        return False
    is_local_http = configured.scheme == "http" and configured.hostname in {
        "localhost",
        "127.0.0.1",
    }
    return configured.scheme == "https" or (
        settings.app_env == "development" and is_local_http
    )


def authorization_url(settings: Settings, state: str) -> str:
    query = urlencode(
        {
            "client_id": settings.feishu_oauth_app_id or "",
            "response_type": "code",
            "redirect_uri": str(settings.feishu_oauth_redirect_uri or ""),
            "state": state,
        }
    )
    return f"{settings.feishu_oauth_authorize_url}?{query}"


def _token_error_code(payload: dict[str, Any] | None) -> str:
    error = str((payload or {}).get("error") or "")
    if error == "invalid_client":
        return "feishu_token_credentials_invalid"
    if error == "unauthorized_client":
        return "feishu_token_app_unauthorized"
    if error == "invalid_request":
        return "feishu_token_request_invalid"
    if error == "invalid_grant":
        return "feishu_token_grant_invalid"
    return "feishu_token_exchange_failed"


def _sanitized_provider_code(payload: dict[str, Any] | None) -> str | None:
    """Return only a short provider error code; never expose message/description text."""
    if not isinstance(payload, dict):
        return None
    candidate: Any = payload.get("code")
    if candidate in (None, 0, "0", ""):
        candidate = payload.get("error_code") or payload.get("error")
    if isinstance(candidate, bool) or not isinstance(candidate, (str, int)):
        return None
    value = str(candidate)
    return value if re.fullmatch(r"[A-Za-z0-9_.-]{1,48}", value) else None


async def exchange_authorization_code(
    code: str,
    settings: Settings,
) -> str:
    logger.info("Feishu token exchange request started (endpoint=/open-apis/authen/v2/oauth/token)")
    payload = {
        "grant_type": "authorization_code",
        "client_id": settings.feishu_oauth_app_id,
        "client_secret": settings.feishu_oauth_app_secret,
        "code": code,
        "redirect_uri": str(settings.feishu_oauth_redirect_uri),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(str(settings.feishu_oauth_token_url), json=payload)
    except httpx.RequestError as error:
        logger.warning("Feishu token exchange failed (network error: %s)", type(error).__name__)
        raise FeishuAuthError("feishu_token_exchange_failed") from None

    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        logger.warning("Feishu token exchange failed (HTTP %s, invalid response)", response.status_code)
        raise FeishuAuthError("feishu_token_response_invalid", response.status_code)

    result_code = body.get("code")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    failed = (
        not response.is_success
        or bool(body.get("error"))
        or (result_code is not None and str(result_code) != "0")
    )
    if failed:
        category = _token_error_code(body)
        logger.warning(
            "Feishu token exchange failed (endpoint=/open-apis/authen/v2/oauth/token, HTTP %s, provider_code=%s, category=%s)",
            response.status_code,
            _sanitized_provider_code(body) or "unavailable",
            category,
        )
        raise FeishuAuthError(category, response.status_code)
    access_token = body.get("access_token") or data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        logger.warning("Feishu token exchange failed (HTTP %s, token absent)", response.status_code)
        raise FeishuAuthError("feishu_token_response_invalid", response.status_code)
    logger.info("Feishu token exchange succeeded (HTTP %s)", response.status_code)
    return access_token


async def fetch_user_info(access_token: str, settings: Settings) -> dict[str, Any]:
    logger.info("Feishu user_info request started (endpoint=/open-apis/authen/v1/user_info)")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                str(settings.feishu_oauth_userinfo_url),
                headers={"Authorization": f"Bearer {access_token}"},
            )
    except httpx.RequestError as error:
        logger.warning("Feishu user_info failed (network error: %s)", type(error).__name__)
        raise FeishuAuthError("feishu_user_info_failed") from None

    if not response.is_success:
        try:
            provider_payload = response.json()
        except ValueError:
            provider_payload = None
        logger.warning(
            "Feishu user_info failed (endpoint=/open-apis/authen/v1/user_info, HTTP %s, provider_code=%s)",
            response.status_code,
            _sanitized_provider_code(provider_payload) or "unavailable",
        )
        raise FeishuAuthError("feishu_user_info_failed", response.status_code)
    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, dict) or (
        body.get("code") is not None and str(body.get("code")) != "0"
    ):
        logger.warning(
            "Feishu user_info failed (endpoint=/open-apis/authen/v1/user_info, HTTP %s, provider_code=%s, invalid_response=true)",
            response.status_code,
            _sanitized_provider_code(body) or "unavailable",
        )
        raise FeishuAuthError("feishu_user_info_failed", response.status_code)

    data = body.get("data")
    if not isinstance(data, dict):
        logger.warning("Feishu user_info failed (HTTP %s, profile absent)", response.status_code)
        raise FeishuAuthError("feishu_user_info_failed", response.status_code)
    user = data.get("user") if isinstance(data.get("user"), dict) else data
    logger.info("Feishu user_info succeeded (HTTP %s)", response.status_code)
    return user


def resolve_authorized_viewer(user: dict[str, Any], settings: Settings) -> dict[str, str | None] | None:
    enterprise_email = str(user.get("enterprise_email") or "").strip().lower()
    fallback_email = str(user.get("email") or "").strip().lower()
    email = enterprise_email or fallback_email
    tenant_key = str(user.get("tenant_key") or "").strip()
    open_id = str(user.get("open_id") or "").strip()
    if not email:
        raise FeishuAuthError("feishu_email_missing")
    if not tenant_key or not open_id:
        raise FeishuAuthError("feishu_identity_incomplete")
    email_domain = email.rpartition("@")[2]
    if email_domain not in settings.corporate_domain_allowlist:
        logger.warning("Feishu identity rejected (corporate_domain_validated=false)")
        raise FeishuAuthError("feishu_domain_denied")
    logger.info("Feishu identity email domain validated")

    allowlist = parse_viewer_allowlist(settings.feishu_viewer_accounts_json)
    if not allowlist:
        raise FeishuAuthError("feishu_not_configured")
    viewer = next(
        (
            item
            for item in allowlist
            if item.email == email and item.tenant_key == tenant_key
        ),
        None,
    )
    if not viewer:
        logger.warning("Feishu identity rejected (local_allowlist_matched=false)")
        return None
    logger.info("Feishu identity authorized by local allowlist")
    display_name = str(user.get("name") or "").strip()
    owner_subject = _keyed_digest(
        json.dumps(
            {"tenant_key": tenant_key, "open_id": open_id},
            sort_keys=True,
            separators=(",", ":"),
        ),
        settings.feishu_session_secret or "",
    )
    resolved_role = viewer.role
    resolved_region = viewer.region
    resolved_base = viewer.base
    if (
        resolved_role == "regional"
        and resolved_base is None
        and resolved_region is not None
        and resolved_region.strip().casefold() == "matriz"
    ):
        resolved_role = "matrix"
        resolved_region = None
        resolved_base = None

    return {
        "username": display_name or email,
        "role": resolved_role,
        "region": resolved_region,
        "base": resolved_base,
        # Keep the Feishu identity private to the backend session. This keyed
        # digest is stable across logins and does not expose provider claims.
        "_owner_subject": owner_subject,
    }


def create_local_session(identity: dict[str, str | None], settings: Settings) -> str:
    secret = settings.feishu_session_secret
    if not secret or len(secret) < 32:
        raise FeishuAuthError("feishu_session_failed")
    token = secrets.token_urlsafe(32)
    key = _keyed_digest(token, secret)
    now = time.time()
    with _store_lock:
        for session_key, (_, expires_at) in list(_sessions.items()):
            if expires_at <= now:
                _sessions.pop(session_key, None)
        _sessions[key] = (dict(identity), now + SESSION_TTL_SECONDS)
    logger.info("Feishu local session record created (storage=process_memory)")
    return token


def get_local_session(token: str | None, settings: Settings) -> dict[str, str | None] | None:
    secret = settings.feishu_session_secret
    if not token or not secret or len(secret) < 32:
        return None
    key = _keyed_digest(token, secret)
    with _store_lock:
        session = _sessions.get(key)
        if not session:
            return None
        identity, expires_at = session
        if expires_at <= time.time():
            _sessions.pop(key, None)
            return None
        return dict(identity)


def revoke_local_session(token: str | None, settings: Settings) -> None:
    secret = settings.feishu_session_secret
    if not token or not secret or len(secret) < 32:
        return
    with _store_lock:
        revoked = _sessions.pop(_keyed_digest(token, secret), None) is not None
    logger.info("Feishu local session revocation completed (session_found=%s)", bool(revoked))
