import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const [app, actionBand, api, service] = await Promise.all([
  read("src/features/dashboards/dashboard-app.tsx"),
  read("src/features/dashboards/dashboard-action-band.tsx"),
  read("backend/app/api/data_foundation.py"),
  read("backend/app/services/operational_feishu_reports.py"),
]);

test("Feishu action visibility defaults unchanged and can be hidden per dashboard", () => {
  assert.match(actionBand, /showShare = true/);
  assert.match(actionBand, /showShare \? <button/);
  assert.match(actionBand, /t\("Enviar para Feishu"\)/);
  assert.match(app, /showShare=\{view !== "taxa" \|\| canShowCollectionRateFeishuButton\}/);
  assert.match(app, /showShare=\{canShowPddFeishuButton\}/);
  assert.match(app, /onShare=\{openPanelFeishuShare\}/);
});

test("each operational dashboard uses its own effective flag and publication", () => {
  assert.match(app, /sourceId: "collection_rate" as const, publicationId: collectionRateV2State\.publicationId/);
  assert.match(app, /sourceId: "pdd_collection_failure" as const, publicationId: pddCollectionFailureV2State\.publicationId/);
  assert.match(app, /canShowCollectionRateFeishuButton = Boolean\([\s\S]*?sourceId === "collection_rate"[\s\S]*?enabled && operationalFeishuAvailability\.publicationValid/);
  assert.match(app, /canShowPddFeishuButton = Boolean\([\s\S]*?sourceId === "pdd_collection_failure"[\s\S]*?enabled && operationalFeishuAvailability\.publicationValid/);
  assert.match(app, /operationalFeishuAvailability\.publicationId === collectionRateV2State\.publicationId/);
  assert.match(app, /operationalFeishuAvailability\.publicationId === pddCollectionFailureV2State\.publicationId/);
});

test("button capability uses authenticated live backend state and refreshes after runtime changes", () => {
  assert.match(app, /isEffectiveMatrixAdminViewer = isMatrixAdminViewer[\s\S]*?organizational_scope === "matrix"[\s\S]*?role === "matrix"/);
  assert.match(app, /\/api\/v2\/operational-feishu\/\$\{operationalFeishuTargetSource\}\/availability/);
  assert.match(app, /window\.setInterval\(\(\) => void refresh\(\), 30_000\)/);
  assert.match(app, /addEventListener\("focus", refreshWhenVisible\)/);
  assert.match(app, /addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(app, /enabled: false,[\s\S]*?publicationValid: false/);
  assert.match(app, /controller\?\.abort\(\)/);
});

test("backend capability endpoint is matrix-admin authenticated and returns no configuration", () => {
  const route = api.slice(api.indexOf('@router.get("/operational-feishu/{source_id}/availability")'), api.indexOf('@router.post("/operational-feishu/{source_id}/prepare")'));
  assert.match(route, /admin: AuthenticatedViewer = Depends\(require_matrix_admin\)/);
  assert.match(route, /_require_effective_matrix_admin\(admin\)/);
  assert.match(route, /get_operational_feishu_report_availability/);
  assert.match(service, /return \{"enabled": False, "publicationValid": False\}/);
  assert.match(service, /return \{"enabled": True, "publicationValid": True\}/);
  assert.doesNotMatch(service.slice(service.indexOf("def get_availability"), service.indexOf("def _stable")), /recipient|email|token|secret|mapVersion|region/i);
});

test("Sem Movimentação share flow is unchanged", () => {
  assert.match(app, /if \(view === "movimentacao"\) \{\s*if \(!isMatrixAdminViewer \|\| !viewerAuthorization \|\| noMovementV2State\.status !== "ready"/);
  assert.match(app, /noMovementFeishuDialogOpen && noMovementV2State\.status === "ready" && noMovementV2State\.identityKey === dashboardCacheIdentity/);
});
