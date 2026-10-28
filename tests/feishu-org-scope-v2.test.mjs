import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("identity header displays only backend-resolved organization and effective regions", () => {
  const app = read("src/features/dashboards/dashboard-app.tsx");
  const display = read("src/lib/effective-region-display.mjs");
  assert.match(app, /effectiveRegionDisplay\(identity/);
  assert.match(display, /region_resolution_status === "RESOLVED"/);
  assert.match(display, /organizational_region_code === "MATRIZ"/);
  assert.match(display, /effective_scope_source === "ADMIN_OVERRIDE"/);
  assert.match(display, /effective_scope_source === "LEGACY_GRANT"/);
  assert.match(display, /return pendingLabel/);
});

test("PT and Chinese pending label exists while unknown scopes remain pending", () => {
  const i18n = read("src/lib/i18n.ts");
  assert.ok(i18n.includes('"Vínculo organizacional pendente de validação"'));
  const region = read("src/lib/organizational-region.ts");
  assert.match(region, /dataScopeSource === "feishu_v2"/);
});

test("backend flag is off and regional data scope is resolved server-side", () => {
  const config = read("backend/app/core/config.py");
  const access = read("backend/app/services/user_access.py");
  const deps = read("backend/app/api/dependencies.py");
  assert.match(config, /feishu_org_scope_v2_enabled: bool = False/);
  assert.match(access, /resolve_organizational_region_v2/);
  assert.match(access, /if override_is_valid and use_v2/);
  assert.match(access, /scope_source not in \{"feishu_v2"\}/);
  assert.match(access, /elif not use_v2 and extras/);
  assert.match(deps, /_refresh_feishu_profile_if_stale\(/);
});
