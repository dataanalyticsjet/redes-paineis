import {
  authAttemptId,
  clearAuthAttemptCookie,
  dashboardAuthConfigured,
  dashboardViewer,
  isDevelopmentEnvironment,
  logFeishuAuth,
} from "../../lib/feishu-auth.server";
import {
  authenticateViewer,
  viewerAuthorizationError,
} from "../../lib/view-auth.server";

export async function GET(request: Request) {
  const attemptId = authAttemptId(request);
  const identity = await dashboardViewer(request);
  if (attemptId) logFeishuAuth(attemptId, identity ? "frontend_session_recognized" : "frontend_session_not_recognized");
  if (!identity) {
    const response = viewerAuthorizationError(dashboardAuthConfigured() ? 401 : 503);
    if (attemptId) response.headers.append("set-cookie", clearAuthAttemptCookie(request));
    return response;
  }
  const response = Response.json(
    { authenticated: true, username: identity.username, role: identity.role, region: identity.region, base: identity.base },
    { headers: { "cache-control": "no-store" } },
  );
  if (attemptId) response.headers.append("set-cookie", clearAuthAttemptCookie(request));
  return response;
}

export async function POST(request: Request) {
  if (!isDevelopmentEnvironment()) return viewerAuthorizationError(401);
  if (!dashboardAuthConfigured()) return viewerAuthorizationError(503);
  const identity = await authenticateViewer(request);
  if (!identity) return viewerAuthorizationError();
  return Response.json(
    { authenticated: true, username: identity.username, role: identity.role, region: identity.region, base: identity.base },
    { headers: { "cache-control": "no-store" } },
  );
}
