from __future__ import annotations

import logging
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from app.core.config import get_settings
from app.db.session import database_session
from app.api.dependencies import AuthenticatedViewer, get_current_viewer
from app.services.feishu_auth import (
    SESSION_COOKIE,
    STATE_COOKIE,
    SESSION_TTL_SECONDS,
    STATE_TTL_SECONDS,
    FeishuAuthError,
    authorization_request_matches,
    authorization_url,
    configuration_is_ready,
    consume_oauth_attempt,
    create_local_session,
    create_oauth_attempt,
    exchange_authorization_code,
    fetch_user_info,
    redirect_uri_matches_request,
    resolve_authorized_viewer,
    revoke_local_session,
)
from app.services.user_access import UserAccessError, identity_for_user, provision_feishu_user

logger = logging.getLogger(__name__)
router = APIRouter(tags=["authentication"])


def _frontend_location(error: str | None = None) -> str:
    base_url = str(get_settings().frontend_base_url).rstrip("/")
    if error:
        return f"{base_url}/?{urlencode({'authError': error})}"
    return f"{base_url}/"


def _is_secure(request: Request) -> bool:
    settings = get_settings()
    return request.url.scheme.lower() == "https" or settings.app_env.lower() in {
        "prod",
        "production",
    }


def _cookie_options(request: Request, max_age: int) -> dict[str, object]:
    return {
        "max_age": max_age,
        "path": "/",
        "httponly": True,
        "secure": _is_secure(request),
        "samesite": "lax",
    }


def _delete_cookie(response: Response, name: str, request: Request) -> None:
    response.delete_cookie(
        name,
        path="/",
        httponly=True,
        secure=_is_secure(request),
        samesite="lax",
    )


def _login_error(request: Request, error: str, status: int = 303) -> RedirectResponse:
    logger.info(
        "Feishu OAuth returning to frontend (category=%s, local_http_status=%s)",
        error,
        status,
    )
    response = RedirectResponse(_frontend_location(error), status_code=status)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    _delete_cookie(response, STATE_COOKIE, request)
    return response


@router.get("/feishu/login")
async def feishu_login(request: Request) -> Response:
    settings = get_settings()
    logger.info("Feishu OAuth login started")
    if not configuration_is_ready(settings):
        logger.warning("Feishu OAuth configuration unavailable")
        return _login_error(request, "feishu_not_configured")
    if not authorization_request_matches(settings, str(request.url)):
        logger.warning("Feishu OAuth callback host does not match configured redirect URI")
        return _login_error(request, "feishu_callback_mismatch")

    state = create_oauth_attempt(settings)
    logger.info("Feishu OAuth state created (state_ttl_seconds=%s)", STATE_TTL_SECONDS)
    response = RedirectResponse(authorization_url(settings, state), status_code=302)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.set_cookie(STATE_COOKIE, state, **_cookie_options(request, STATE_TTL_SECONDS))
    return response


@router.get("/feishu/callback")
async def feishu_callback(request: Request) -> Response:
    settings = get_settings()
    state = request.query_params.get("state")
    code = request.query_params.get("code")
    oauth_error = request.query_params.get("error")
    logger.info(
        "Feishu OAuth callback received (state_present=%s, code_present=%s, provider_error_present=%s)",
        bool(state),
        bool(code),
        bool(oauth_error),
    )

    state_valid = consume_oauth_attempt(
        state,
        request.cookies.get(STATE_COOKIE),
        settings,
    )
    if not state_valid:
        logger.warning("Feishu OAuth callback rejected (invalid state)")
        return _login_error(request, "feishu_state_invalid")
    logger.info("Feishu OAuth state validated and consumed")

    if not redirect_uri_matches_request(settings, str(request.url)):
        logger.warning("Feishu OAuth callback host does not match configured redirect URI")
        return _login_error(request, "feishu_callback_mismatch")
    if oauth_error:
        logger.info("Feishu OAuth authorization denied by user/provider")
        return _login_error(request, "feishu_consent_denied")
    if not code:
        logger.warning("Feishu OAuth callback missing authorization code")
        return _login_error(request, "feishu_token_request_invalid")
    if not configuration_is_ready(settings):
        logger.warning("Feishu OAuth configuration unavailable")
        return _login_error(request, "feishu_not_configured")

    logger.info("Feishu OAuth token exchange started (endpoint=/open-apis/authen/v2/oauth/token)")
    try:
        access_token = await exchange_authorization_code(code, settings)
    except FeishuAuthError as error:
        logger.warning(
            "Feishu OAuth failed at token exchange (http_status=%s, category=%s)",
            error.http_status if error.http_status is not None else "unavailable",
            error.code,
        )
        return _login_error(request, error.code)

    logger.info("Feishu OAuth token exchange succeeded")
    logger.info("Feishu OAuth user_info request started (endpoint=/open-apis/authen/v1/user_info)")
    try:
        user = await fetch_user_info(access_token, settings)
    except FeishuAuthError as error:
        logger.warning(
            "Feishu OAuth failed at user_info (http_status=%s, category=%s)",
            error.http_status if error.http_status is not None else "unavailable",
            error.code,
        )
        return _login_error(request, error.code)

    email_source = (
        "enterprise_email"
        if str(user.get("enterprise_email") or "").strip()
        else "email"
        if str(user.get("email") or "").strip()
        else "absent"
    )
    logger.info(
        "Feishu identity claims received (email_source=%s, tenant_key_present=%s, open_id_present=%s)",
        email_source,
        bool(user.get("tenant_key")),
        bool(user.get("open_id")),
    )
    try:
        identity = resolve_authorized_viewer(user, settings)
    except FeishuAuthError as error:
        logger.warning("Feishu OAuth identity rejected (category=%s)", error.code)
        return _login_error(request, error.code)
    if not identity:
        logger.warning("Feishu OAuth user is not in the local allowlist")
        return _login_error(request, "feishu_access_denied")
    logger.info("Feishu corporate domain validated and local authorization matched")

    try:
        with database_session(settings) as db:
            user_record = provision_feishu_user(db, identity)
            session_identity = identity_for_user(db, user_record)
            session_identity["_owner_subject"] = identity.get("_owner_subject")
    except UserAccessError as error:
        logger.warning("Feishu account provisioning failed (category=%s)", error.code)
        return _login_error(request, error.code)
    except RuntimeError:
        logger.warning("Feishu account provisioning unavailable (category=user_store_unavailable)")
        return _login_error(request, "user_store_unavailable")
    except Exception as error:
        logger.error("Feishu account provisioning failed (error_type=%s)", type(error).__name__)
        return _login_error(request, "user_store_unavailable")

    try:
        session_token = create_local_session(session_identity, settings)
    except FeishuAuthError as error:
        logger.warning("Feishu OAuth failed at session creation (category=%s)", error.code)
        return _login_error(request, error.code)

    logger.info("Feishu local session created (ttl_seconds=%s)", SESSION_TTL_SECONDS)
    response = RedirectResponse(_frontend_location(), status_code=302)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.set_cookie(
        SESSION_COOKIE,
        session_token,
        **_cookie_options(request, SESSION_TTL_SECONDS),
    )
    _delete_cookie(response, STATE_COOKIE, request)
    logger.info("Feishu OAuth redirected to authenticated home")
    return response


@router.get("/me")
async def current_user(viewer: AuthenticatedViewer = Depends(get_current_viewer)) -> Response:
    identity = viewer.identity
    logger.info("Feishu local session recognized")
    return JSONResponse(
        {
            "authenticated": True,
            **{
                key: identity.get(key)
                for key in (
                    "username",
                    "role",
                    "region",
                    "base",
                    "platform_role",
                    "organizational_scope",
                    "home_region",
                    "home_base",
                    "additional_regions",
                    "effective_regions",
                    "is_active",
                )
            },
        },
        headers={"Cache-Control": "no-store"},
    )


@router.post("/logout")
async def logout(request: Request) -> Response:
    origin = request.headers.get("origin")
    allowed_origin = str(get_settings().frontend_base_url).rstrip("/")
    if origin and origin.rstrip("/") != allowed_origin:
        return Response(status_code=403, headers={"Cache-Control": "no-store"})
    revoke_local_session(request.cookies.get(SESSION_COOKIE), get_settings())
    logger.info("Feishu local logout completed and browser cookies cleared")
    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    _delete_cookie(response, SESSION_COOKIE, request)
    _delete_cookie(response, STATE_COOKIE, request)
    return response
