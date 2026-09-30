import {
  appendOAuthStateCookie,
  appendAuthAttemptCookie,
  createOAuthAttempt,
  createAuthAttemptId,
  feishuAuthorizationConfigured,
  feishuConfiguration,
  feishuLoginConfigured,
  feishuRedirectUriMatchesRequest,
  isDevelopmentEnvironment,
  logFeishuAuth,
} from "../../../../lib/feishu-auth.server";

function returnToLogin(request: Request, error: string, attemptId = createAuthAttemptId()) {
  logFeishuAuth(attemptId, "login_failed", { reason: error });
  const location = new URL("/", request.url);
  location.searchParams.set("authError", error);
  return new Response(null, { status: 303, headers: { location: location.toString(), "cache-control": "no-store" } });
}

function authorizationConfigurationError(attemptId: string) {
  logFeishuAuth(attemptId, "authorization_list_invalid");
  return new Response("Login Feishu local indisponível: revise FEISHU_VIEWER_ACCOUNTS_JSON. A lista deve ser um array JSON válido com email, tenant_key e role; usuários regionais também precisam de region e/ou base.", {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "referrer-policy": "no-referrer" },
  });
}

export async function GET(request: Request) {
  const attemptId = createAuthAttemptId();
  logFeishuAuth(attemptId, "login_started");
  if (!isDevelopmentEnvironment()) return returnToLogin(request, "feishu_local_only", attemptId);
  const config = feishuConfiguration();
  logFeishuAuth(attemptId, "configuration_checked", {
    appIdPresent: Boolean(config.clientId),
    appSecretPresent: Boolean(config.clientSecret),
    redirectUriPresent: Boolean(config.redirectUri),
    sessionSecretPresent: config.sessionSecret.length >= 32,
    authorizationListValid: feishuAuthorizationConfigured(),
  });
  if (!feishuLoginConfigured()) return returnToLogin(request, "feishu_not_configured", attemptId);
  if (!feishuRedirectUriMatchesRequest(request)) return returnToLogin(request, "feishu_callback_mismatch", attemptId);
  if (!feishuAuthorizationConfigured()) return authorizationConfigurationError(attemptId);

  try {
    const { state, challenge } = await createOAuthAttempt();
    const authorizeUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "contact:user.base:readonly contact:user.email:readonly");

    const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    appendOAuthStateCookie(headers, request, state);
    appendAuthAttemptCookie(headers, request, attemptId);
    headers.set("location", authorizeUrl.toString());
    logFeishuAuth(attemptId, "authorization_redirect_issued", { callbackMatches: true, pkce: "S256", scopeSet: "user-basic-and-email-readonly" });
    return new Response(null, { status: 303, headers });
  } catch {
    return returnToLogin(request, "feishu_storage_not_ready", attemptId);
  }
}
