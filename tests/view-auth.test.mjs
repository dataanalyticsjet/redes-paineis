import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbooks = await readFile(new URL("../backend/app/api/workbooks.py", import.meta.url), "utf8");
const apiMain = await readFile(new URL("../backend/app/main.py", import.meta.url), "utf8");
const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");

test("workbook reads require a FastAPI session before returning data", () => {
  assert.match(workbooks, /def _identity\(request: Request\)/);
  assert.match(workbooks, /get_local_session\(request\.cookies\.get\(SESSION_COOKIE\)/);
  assert.match(workbooks, /async def read_workbook\(request: Request\)[\s\S]*?identity, error = _identity\(request\)/);
  assert.match(workbooks, /authentication_required/);
});

test("the frontend has no parallel Worker auth aliases", () => {
  assert.match(apiMain, /include_router\(auth_router, prefix="\/api\/auth"\)/);
  assert.match(apiMain, /include_router\(workbooks_router, prefix="\/api"\)/);
  assert.doesNotMatch(apiMain, /cloudflare:workers|D1Database|R2Bucket/);
  assert.doesNotMatch(frontend, /\/api\/(?:view-auth|logout)(?:["`/])/);
});
