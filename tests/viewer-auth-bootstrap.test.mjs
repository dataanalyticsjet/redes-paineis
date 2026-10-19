import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../backend/app/api/auth.py", import.meta.url), "utf8");

test("the initial render stays in CHECKING until /me confirms the session", () => {
  assert.match(frontend, /useState<ViewerAuthState>\("CHECKING"\)/);
  assert.match(frontend, /if \(viewerAuthState === "CHECKING"\)[\s\S]*?PresentationAuthTransition/);
  assert.match(frontend, /if \(viewerAuthState === "UNAUTHENTICATED"\)[\s\S]*?PresentationLogin/);
});

test("the Feishu callback sets the session cookie before redirecting to the frontend home", () => {
  const callback = backend.slice(backend.indexOf("async def feishu_callback"), backend.indexOf("@router.get(\"/me\")"));
  assert.match(callback, /response = RedirectResponse\(_frontend_location\(\), status_code=302\)/);
  assert.match(callback, /response\.set_cookie\(\s*SESSION_COOKIE/);
});

test("session verification failures are distinct from an unauthenticated response", () => {
  assert.match(frontend, /response\.status === 401/);
  assert.match(frontend, /setViewerAuthState\("ERROR"\)/);
  assert.match(frontend, /retryViewerSessionCheck/);
  assert.match(frontend, /setViewerAuthState\("AUTHENTICATED"\)/);
});

test("logout and periodic session validation continue using the existing secure endpoints", () => {
  assert.match(frontend, /apiFetch\("\/api\/auth\/logout", \{ method: "POST" \}\)/);
  assert.match(frontend, /setViewerAuthState\("UNAUTHENTICATED"\)/);
  assert.match(frontend, /setInterval\(\(\) => void verifyCurrentAccess\(\), 30_000\)/);
  assert.match(frontend, /window\.addEventListener\("focus", verifyCurrentAccess\)/);
});

test("regional sync failure blocks data without ending the Feishu session", () => {
  assert.match(frontend, /region_resolution_status === "SYNC_FAILED"[\s\S]*?Não foi possível confirmar sua regional no Feishu/);
  assert.match(frontend, /subscribeToProtectedApiAuthorizationFailure\(\(\) => \{[\s\S]*?clearProtectedDashboardData\(\);[\s\S]*?setViewerDataAccessBlocked\(true\)/);
  assert.match(frontend, /if \(response\.status === 403\) \{\s*clearProtectedDashboardData\(\);\s*setViewerDataAccessBlocked\(true\);\s*return;/);
  assert.doesNotMatch(frontend, /feishu_sync_grace/);
});
