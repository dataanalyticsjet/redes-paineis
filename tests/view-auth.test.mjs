import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbooks = await readFile(new URL("../backend/app/api/workbooks.py", import.meta.url), "utf8");
const apiMain = await readFile(new URL("../backend/app/main.py", import.meta.url), "utf8");
const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");

test("workbook reads require a FastAPI session before returning data", () => {
  assert.match(workbooks, /from app\.api\.dependencies import AuthenticatedViewer, get_current_viewer, require_admin/);
  assert.match(workbooks, /async def read_workbook\([\s\S]*?viewer: AuthenticatedViewer = Depends\(get_current_viewer\)/);
  assert.match(workbooks, /async def write_workbook\([\s\S]*?_admin: AuthenticatedViewer = Depends\(require_admin\)/);
  assert.match(workbooks, /scope_parsed_rows\(parsed, identity\)/);
});

test("the frontend has no parallel Worker auth aliases", () => {
  assert.match(apiMain, /include_router\(auth_router, prefix="\/api\/auth"\)/);
  assert.match(apiMain, /include_router\(workbooks_router, prefix="\/api"\)/);
  assert.doesNotMatch(apiMain, /cloudflare:workers|D1Database|R2Bucket/);
  assert.doesNotMatch(frontend, /\/api\/(?:view-auth|logout)(?:["`/])/);
});
