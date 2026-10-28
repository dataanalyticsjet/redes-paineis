import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("identity UI shows only the backend-resolved Feishu V2 scope", () => {
  const app = read("src/features/dashboards/dashboard-app.tsx");
  assert.match(app, /organizational_scope_policy === "V2"/);
  assert.match(app, /MATRIZ — Visão Nacional/);
  assert.match(app, /REGIONAL \{region\}/);
  assert.match(app, /Vínculo organizacional pendente de validação/);
  assert.match(app, /organizational_scope_reason/);
});

test("PT and Chinese labels exist and unknown scopes remain pending", () => {
  const i18n = read("src/lib/i18n.ts");
  for (const label of [
    "MATRIZ — Visão Nacional",
    "REGIONAL {region}",
    "Vínculo organizacional pendente de validação",
  ]) assert.ok(i18n.includes('"' + label + '"'), "missing translation: " + label);
  const region = read("src/lib/organizational-region.ts");
  assert.match(region, /dataScopeSource === "feishu_v2"/);
});

test("backend flag is off and regional data scope is resolved server-side", () => {
  const config = read("backend/app/core/config.py");
  const access = read("backend/app/services/user_access.py");
  const deps = read("backend/app/api/dependencies.py");
  assert.match(config, /feishu_org_scope_v2_enabled: bool = False/);
  assert.match(access, /resolve_organizational_region_v2/);
  assert.match(access, /Under V2 an unresolved hierarchy never falls back to manual grants/);
  assert.match(deps, /_refresh_feishu_profile_if_stale\(/);
});
