import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

process.env.NODE_ENV = "development";
const secret = "test-only-session-secret-longer-than-thirty-two-characters";
const stateRows = new Map();
const users = new Map();
const sessions = new Map();
const fakeDb = {
  prepare(query) {
    return {
      bind(...values) {
        return {
          async run() {
            if (query.includes("INSERT INTO feishu_oauth_states")) stateRows.set(values[0], { verifier: values[1], expires: values[2] });
            if (query.includes("INSERT INTO local_auth_users")) {
              users.set(values[3], { id: values[0], tenant_key: values[1], open_id: values[2], normalized_email: values[3], email: values[4], username: values[5], profile: "USER", region: values[6], base: values[7], disabled_at: null });
            }
            if (query.includes("INSERT INTO local_auth_sessions")) sessions.set(values[0], { user_id: values[1], expires_at: values[2], revoked_at: null });
            if (query.includes("UPDATE local_auth_sessions")) {
              const session = sessions.get(values[1]);
              if (session) session.revoked_at = values[0];
            }
            if (query.includes("UPDATE local_auth_users SET region = NULL")) {
              const user = [...users.values()].find((item) => item.id === values[1]);
              if (user) { user.region = null; user.base = null; }
            }
            return { success: true };
          },
          async first() {
            if (query.includes("DELETE FROM feishu_oauth_states")) {
              const row = stateRows.get(values[0]);
              if (!row || row.expires <= values[1]) return null;
              stateRows.delete(values[0]);
              return { code_verifier: row.verifier };
            }
            if (query.includes("FROM local_auth_users WHERE normalized_email")) return users.get(values[0]) ?? null;
            if (query.includes("UPDATE local_auth_users SET open_id")) {
              const user = [...users.values()].find((item) => item.id === values[2] && !item.open_id);
              if (!user) return null;
              user.open_id = values[0];
              return { id: user.id };
            }
            if (query.includes("JOIN local_auth_users")) {
              const session = sessions.get(values[0]);
              const user = session && [...users.values()].find((item) => item.id === session.user_id);
              if (!session || session.expires_at <= values[1] || session.revoked_at || !user || user.disabled_at || user.profile !== "USER") return null;
              return { username: user.username, email: user.email, tenant_key: user.tenant_key, region: user.region, base: user.base };
            }
            return null;
          },
        };
      },
    };
  },
};
const runtimeEnv = {
  FEISHU_APP_ID: "test-app",
  FEISHU_APP_SECRET: "test-only-app-secret",
  FEISHU_REDIRECT_URI: "http://localhost:3000/api/auth/feishu/callback",
  FEISHU_SESSION_SECRET: secret,
  FEISHU_VIEWER_ACCOUNTS_JSON: JSON.stringify([
    { email: "viewer@example.test", tenant_key: "tenant-a", role: "matrix" },
    { email: "scoped@example.test", tenant_key: "tenant-a", role: "regional", region: "sp", base: "base-2" },
    { email: "third@example.test", tenant_key: "tenant-b", role: "matrix" },
  ]),
  DB: fakeDb,
};
const source = (await readFile(new URL("../app/lib/feishu-auth.server.ts", import.meta.url), "utf8"))
  .replace('import { env } from "cloudflare:workers";', `const env = ${JSON.stringify(runtimeEnv, (key, value) => key === "DB" ? undefined : value)}; env.DB = globalThis.__fakeDb;`)
  .replace('import { authenticateViewer, viewerAccountsConfigured, type ViewerIdentity } from "./view-auth.server";', "const authenticateViewer = async () => null; const viewerAccountsConfigured = () => false;");
globalThis.__fakeDb = fakeDb;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const auth = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function request(url, cookie) {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

test("Feishu OAuth state is browser-bound, PKCE S256, short-lived, and consumed once", async () => {
  const browserRequest = request("http://localhost:3000/");
  const { state, challenge } = await auth.createOAuthAttempt(browserRequest);
  const headers = new Headers();
  auth.appendOAuthStateCookie(headers, browserRequest, state);
  const cookie = headers.get("set-cookie").split(";", 1)[0];
  const callback = request("http://localhost:3000/api/auth/feishu/callback?code=redacted&state=" + state, cookie);
  const verifier = await auth.consumeOAuthState(callback, state);
  assert.equal(verifier?.length, 43);
  const calculated = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const base64 = Buffer.from(calculated).toString("base64url");
  assert.equal(challenge, base64);
  assert.equal(await auth.consumeOAuthState(callback, state), null);
  assert.equal(await auth.consumeOAuthState(request(callback.url), state), null);
});

test("Feishu authorization list requires exact identity and role fields", () => {
  const valid = JSON.stringify([{ email: "viewer@example.test", tenant_key: "tenant-a", role: "regional", region: "sp" }]);
  assert.deepEqual(auth.parseFeishuViewerAuthorizations(valid), [{ email: "viewer@example.test", tenant_key: "tenant-a", role: "regional", region: "SP", base: null }]);
  assert.equal(auth.parseFeishuViewerAuthorizations("not-json"), null);
  assert.equal(auth.parseFeishuViewerAuthorizations(JSON.stringify([{ email: "viewer@example.test", role: "regional", region: "SP" }])), null);
  assert.equal(auth.parseFeishuViewerAuthorizations(JSON.stringify([{ email: "viewer@example.test", tenant_key: "tenant-a", role: "regional" }])), null);
  assert.equal(auth.parseFeishuViewerAuthorizations(JSON.stringify([{ email: "viewer@example.test", tenant_key: "tenant-a", role: "unknown" }])), null);
});

test("local session cookie is HttpOnly and server revocation takes effect", async () => {
  const user = await auth.provisionOrFindFeishuUser({ openId: "open-1", tenantKey: "tenant-a", email: "viewer@example.test", name: "Feishu Viewer" });
  assert.equal(user.profile, "USER");
  assert.equal(user.region, null);
  assert.equal(user.base, null);
  const repeated = await auth.provisionOrFindFeishuUser({ openId: "open-1", tenantKey: "tenant-a", email: "VIEWER@example.test", name: "Other name" });
  assert.equal(repeated.id, user.id);
  assert.equal(repeated.region, null);
  assert.equal(repeated.base, null);
  const scopedUser = await auth.provisionOrFindFeishuUser({ openId: "open-2", tenantKey: "tenant-a", email: "scoped@example.test", name: "Scoped Viewer" });
  assert.equal(scopedUser.profile, "USER");
  assert.equal(scopedUser.region, "SP");
  assert.equal(scopedUser.base, "BASE-2");
  assert.equal(await auth.provisionOrFindFeishuUser({ openId: "open-x", tenantKey: "tenant-a", email: "not-allowlisted@example.test" }), null);
  const otherTenantUser = await auth.provisionOrFindFeishuUser({ openId: "open-3", tenantKey: "tenant-b", email: "third@example.test", name: "Third Viewer" });
  assert.equal(otherTenantUser.profile, "USER");
  assert.equal(otherTenantUser.region, null);
  assert.equal(await auth.provisionOrFindFeishuUser({ openId: "open-1", tenantKey: "tenant-b", email: "viewer@example.test" }), null);
  assert.equal(await auth.provisionOrFindFeishuUser({ openId: "open-2", tenantKey: "tenant-a", email: "viewer@example.test" }), null);

  const secureRequest = request("https://localhost:3000/");
  const cookie = await auth.sessionCookie(user.id, secureRequest);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const sessionRequest = request("https://localhost:3000/api/view-auth", cookie.split(";", 1)[0]);
  assert.deepEqual(await auth.dashboardViewer(sessionRequest), { username: "Feishu Viewer", role: "matrix", region: null, base: null });
  const scopedCookie = await auth.sessionCookie(scopedUser.id, secureRequest);
  const scopedSessionRequest = request("https://localhost:3000/api/view-auth", scopedCookie.split(";", 1)[0]);
  assert.deepEqual(await auth.dashboardViewer(scopedSessionRequest), { username: "Scoped Viewer", role: "regional", region: "SP", base: "BASE-2" });
  await auth.revokeFeishuSession(sessionRequest);
  assert.equal(await auth.dashboardViewer(sessionRequest), null);
});

test("successful callback can clear OAuth cookies without expiring the new session", () => {
  const callbackRequest = request("http://localhost:3000/api/auth/feishu/callback");
  const clearedStateCookie = auth.clearOAuthStateCookie(callbackRequest);
  assert.match(clearedStateCookie, /^jt_feishu_oauth_state=;/);
  assert.doesNotMatch(clearedStateCookie, /jt_dashboard_session/);
});

test("local callback is pinned to localhost and does not accept the loopback IP alias", () => {
  assert.equal(auth.feishuRedirectUriMatchesRequest(request("http://localhost:3000/api/auth/feishu/login")), true);
  assert.equal(auth.feishuRedirectUriMatchesRequest(request("http://127.0.0.1:3000/api/auth/feishu/login")), false);
});
