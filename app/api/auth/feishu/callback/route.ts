import {
  authAttemptId,
  clearFeishuCookies,
  clearOAuthStateCookie,
  consumeOAuthState,
  createAuthAttemptId,
  feishuConfiguration,
  feishuLoginConfigured,
  feishuRedirectUriMatchesRequest,
  isDevelopmentEnvironment,
  logFeishuAuth,
  provisionOrFindFeishuUser,
  sessionCookie,
} from "../../../../lib/feishu-auth.server";

type FeishuTokenResponse = {
  access_token?: string;
  open_id?: string;
  code?: number | string;
  data?: { access_token?: string; open_id?: string };
  error?: string;
  error_description?: string;
};

function tokenFailureCode(payload: FeishuTokenResponse | null) {
  switch (payload?.error) {
    case "invalid_client": return "feishu_token_credentials_invalid";
    case "invalid_grant": {
      // Feishu's error_description is used only to choose a safe category. Never
      // return or log the provider text because it may contain request details.
      const detail = payload.error_description ?? "";
      if (/verifier|challenge|pkce/i.test(detail)) return "feishu_token_pkce_invalid";
      if (/redirect|callback/i.test(detail)) return "feishu_token_redirect_invalid";
      if (/expir|used|reuse|authorization code|auth code/i.test(detail)) return "feishu_token_code_expired_or_used";
      return "feishu_token_grant_invalid";
    }
    case "unauthorized_client": return "feishu_token_app_unauthorized";
    case "invalid_request": return "feishu_token_request_invalid";
    default: return "feishu_token_exchange_failed";
  }
}

type FeishuUserResponse = {
  code?: number;
  data?: {
    open_id?: string;
    tenant_key?: string;
    enterprise_email?: string;
    email?: string;
    name?: string;
    user?: { open_id?: string; tenant_key?: string; enterprise_email?: string; email?: string; name?: string };
  };
};

function redirectToLogin(request: Request, error: string, cookieHeaders: string[] = [], attemptId = createAuthAttemptId(), step = "callback_failed", details: Record<string, string | number | boolean | null> = {}) {
  logFeishuAuth(attemptId, step, { reason: error, ...details });
  const location = new URL("/", request.url);
  location.searchParams.set("authError", error);
  const headers = new Headers({ location: location.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const cookie of cookieHeaders) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const attemptId = authAttemptId(request) ?? createAuthAttemptId();
  let step = "callback_received";
  logFeishuAuth(attemptId, step, { codePresent: Boolean(url.searchParams.get("code") ?? request.headers.get("x-jt-feishu-oauth-code")), statePresent: Boolean(url.searchParams.get("state") ?? request.headers.get("x-jt-feishu-oauth-state")) });
  const clearedCookies = clearFeishuCookies(request);
  if (!isDevelopmentEnvironment()) return redirectToLogin(request, "feishu_local_only", clearedCookies, attemptId, step);
  if (!feishuRedirectUriMatchesRequest(request)) return redirectToLogin(request, "feishu_callback_mismatch", clearedCookies, attemptId, step);

  let codeVerifier: string | null = null;
  try {
    step = "state_validation";
    const state = url.searchParams.get("state") ?? request.headers.get("x-jt-feishu-oauth-state");
    codeVerifier = await consumeOAuthState(request, state);
  } catch {
    return redirectToLogin(request, "feishu_storage_not_ready", clearedCookies, attemptId, step);
  }
  if (!codeVerifier) return redirectToLogin(request, "feishu_state_invalid", clearedCookies, attemptId, step);
  logFeishuAuth(attemptId, "state_validated");
  if (url.searchParams.has("error")) return redirectToLogin(request, "feishu_consent_denied", clearedCookies, attemptId, "authorization_denied");

  const code = url.searchParams.get("code") ?? request.headers.get("x-jt-feishu-oauth-code");
  if (!code || !feishuLoginConfigured()) return redirectToLogin(request, "feishu_not_configured", clearedCookies, attemptId, "configuration_check");

  let failure = "feishu_token_exchange_failed";
  try {
    step = "token_exchange";
    logFeishuAuth(attemptId, "token_exchange_started", { endpointVersion: "oauth-v3" });
    const config = feishuConfiguration();
    const tokenResponse = await fetch("https://accounts.feishu.cn/oauth/v3/token", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenPayload = await tokenResponse.json().catch(() => null) as FeishuTokenResponse | null;
    const providerCode = typeof tokenPayload?.code === "number"
      ? tokenPayload.code
      : typeof tokenPayload?.code === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(tokenPayload.code)
        ? tokenPayload.code
        : tokenPayload?.error && /^[A-Za-z0-9_-]{1,48}$/.test(tokenPayload.error) ? tokenPayload.error : null;
    const tokenHasError = Boolean(tokenPayload?.error) || (tokenPayload?.code !== undefined && String(tokenPayload.code) !== "0");
    if (!tokenResponse.ok || !tokenPayload || tokenHasError) {
      const reason = tokenFailureCode(tokenPayload);
      logFeishuAuth(attemptId, "token_exchange_rejected", { httpStatus: tokenResponse.status, providerCode, category: reason });
      return redirectToLogin(request, reason, clearedCookies, attemptId, step, { httpStatus: tokenResponse.status, providerCode });
    }
    const accessToken = tokenPayload.access_token ?? tokenPayload.data?.access_token;
    if (!accessToken) return redirectToLogin(request, "feishu_token_response_invalid", clearedCookies, attemptId, step, { httpStatus: tokenResponse.status, providerCode });
    logFeishuAuth(attemptId, "user_access_token_received", { httpStatus: tokenResponse.status });

    failure = "feishu_user_info_failed";
    step = "user_info";
    const userResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) return redirectToLogin(request, "feishu_user_info_failed", clearedCookies, attemptId, step, { httpStatus: userResponse.status });
    const userPayload = await userResponse.json() as FeishuUserResponse;
    const user = userPayload.data?.user ?? userPayload.data;
    if (!user || (userPayload.code !== undefined && String(userPayload.code) !== "0")) return redirectToLogin(request, "feishu_user_info_failed", clearedCookies, attemptId, step, { httpStatus: userResponse.status, providerCode: userPayload.code ?? null });
    logFeishuAuth(attemptId, "user_info_received", { httpStatus: userResponse.status });

    const openId = user.open_id ?? tokenPayload.open_id ?? tokenPayload.data?.open_id;
    const tenantKey = user.tenant_key;
    const email = (user.enterprise_email?.trim() || user.email?.trim() || "").toLowerCase();
    if (!email) return redirectToLogin(request, "feishu_email_missing", clearedCookies, attemptId, step, { emailPresent: false });
    if (!openId || !tenantKey) return redirectToLogin(request, "feishu_identity_incomplete", clearedCookies, attemptId, step, { openIdPresent: Boolean(openId), tenantKeyPresent: Boolean(tenantKey) });

    failure = "feishu_user_provision_failed";
    step = "user_authorization";
    const localUser = await provisionOrFindFeishuUser({ openId, tenantKey, email, name: user.name });
    if (!localUser) return redirectToLogin(request, "feishu_access_denied", clearedCookies, attemptId, step);
    logFeishuAuth(attemptId, "user_authorized_or_reused");
    const headers = new Headers({
      location: new URL("/", url.origin).toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    failure = "feishu_session_failed";
    step = "session_creation";
    headers.append("set-cookie", await sessionCookie(localUser.id, request));
    headers.append("set-cookie", clearOAuthStateCookie(request));
    logFeishuAuth(attemptId, "session_created");
    return new Response(null, { status: 303, headers });
  } catch {
    return redirectToLogin(request, failure, clearedCookies, attemptId, step);
  }
}
