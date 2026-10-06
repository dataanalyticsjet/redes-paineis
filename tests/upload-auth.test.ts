import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../backend/app/api/workbooks.py", import.meta.url), "utf8");
const backendTests = await readFile(new URL("../backend/tests/test_workbooks.py", import.meta.url), "utf8");

test("Excel upload asks FastAPI to validate server-side upload credentials", () => {
  assert.match(frontend, /fetch\("\/api\/upload-auth"/);
  assert.match(frontend, /fetch\("\/api\/workbook"/);
  assert.match(backend, /async def verify_upload_auth\(request: Request\)/);
  assert.match(backend, /hmac\.compare_digest/);
  assert.match(backendTests, /def test_upload_auth_is_separate_from_viewer_session/);
});
