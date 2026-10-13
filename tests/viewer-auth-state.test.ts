import assert from "node:assert/strict";
import test from "node:test";
import { viewerAuthStateFromResponse, type ViewerSessionPayload } from "../src/lib/viewer-auth-state.ts";

test("an active Feishu session is authenticated without changing its role", () => {
  assert.equal(viewerAuthStateFromResponse(200, { authenticated: true, is_active: true }), "AUTHENTICATED");
  const adminIdentity: ViewerSessionPayload & { role: string } = { authenticated: true, is_active: true, role: "ADMIN" };
  const userIdentity: ViewerSessionPayload & { role: string } = { authenticated: true, is_active: true, role: "USER" };
  assert.equal(viewerAuthStateFromResponse(200, adminIdentity), "AUTHENTICATED");
  assert.equal(viewerAuthStateFromResponse(200, userIdentity), "AUTHENTICATED");
});

test("missing, expired, and inactive sessions resolve to unauthenticated", () => {
  assert.equal(viewerAuthStateFromResponse(401, null), "UNAUTHENTICATED");
  assert.equal(viewerAuthStateFromResponse(200, { authenticated: false }), "UNAUTHENTICATED");
  assert.equal(viewerAuthStateFromResponse(200, { authenticated: true, is_active: false }), "UNAUTHENTICATED");
});

test("server errors remain an error state instead of flashing the login screen", () => {
  assert.equal(viewerAuthStateFromResponse(503, null), "ERROR");
  assert.equal(viewerAuthStateFromResponse(500, { authenticated: false }), "ERROR");
});
