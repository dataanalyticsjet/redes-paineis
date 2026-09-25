import assert from "node:assert/strict";
import test from "node:test";
import { verifyUploadAuthorization } from "../app/lib/upload-auth.ts";

function basic(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

test("accepts only the configured upload credentials", async () => {
  assert.equal(await verifyUploadAuthorization(basic("jt_upload", "correct-password"), "jt_upload", "correct-password"), true);
  assert.equal(await verifyUploadAuthorization(basic("jt_upload", "wrong"), "jt_upload", "correct-password"), false);
  assert.equal(await verifyUploadAuthorization(basic("wrong", "correct-password"), "jt_upload", "correct-password"), false);
});

test("rejects missing, malformed, or unconfigured authorization", async () => {
  assert.equal(await verifyUploadAuthorization(null, "jt_upload", "correct-password"), false);
  assert.equal(await verifyUploadAuthorization("Bearer token", "jt_upload", "correct-password"), false);
  assert.equal(await verifyUploadAuthorization("Basic !!!", "jt_upload", "correct-password"), false);
  assert.equal(await verifyUploadAuthorization(basic("jt_upload", "correct-password"), undefined, undefined), false);
});
