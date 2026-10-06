import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const api = await readFile(new URL("../backend/app/api/auth.py", import.meta.url), "utf8");
const service = await readFile(new URL("../backend/app/services/feishu_auth.py", import.meta.url), "utf8");

test("frontend delegates Feishu login and session lifecycle to FastAPI", () => {
  assert.match(frontend, /fetch\("\/api\/auth\/me"[\s\S]*?credentials: "include"/);
  assert.match(frontend, /window\.location\.assign\("\/api\/auth\/feishu\/login"\)/);
  assert.match(frontend, /fetch\("\/api\/auth\/logout", \{ method: "POST", credentials: "include" \}\)/);
  assert.doesNotMatch(frontend, /\/api\/(?:view-auth|logout)(?:["`/])/);
  assert.doesNotMatch(frontend, /localStorage\.(?:getItem|setItem)\([^)]*(?:token|secret)/i);
});

test("FastAPI owns Feishu OAuth and issues an HttpOnly application session", () => {
  assert.match(api, /@router\.get\("\/feishu\/login"\)/);
  assert.match(api, /@router\.get\("\/feishu\/callback"\)/);
  assert.match(api, /@router\.get\("\/me"\)/);
  assert.match(api, /@router\.post\("\/logout"\)/);
  assert.match(service, /settings\.feishu_oauth_token_url/);
  assert.match(service, /enterprise_email/);
  assert.match(api, /["']httponly["']:\s*True/);
  assert.doesNotMatch(service, /cloudflare:workers|D1Database|R2Bucket/);
});
