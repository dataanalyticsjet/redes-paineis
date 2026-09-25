import {
  authenticateViewer,
  viewerAccountsConfigured,
  viewerAuthorizationError,
} from "../../lib/view-auth.server";

export async function POST(request: Request) {
  if (!viewerAccountsConfigured()) return viewerAuthorizationError(503);
  const identity = await authenticateViewer(request);
  if (!identity) return viewerAuthorizationError();
  return Response.json(
    { authenticated: true, username: identity.username, role: identity.role, region: identity.region, base: identity.base },
    { headers: { "cache-control": "no-store" } },
  );
}
