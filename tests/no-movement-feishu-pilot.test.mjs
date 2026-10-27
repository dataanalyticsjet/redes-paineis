import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Sem Movimentação opens the scoped report dialog, leaving other dashboards on their existing share flow", async () => {
  const app = await read("src/features/dashboards/dashboard-app.tsx");
  assert.match(app, /if \(view === "movimentacao"\)[\s\S]*setNoMovementFeishuDialogOpen\(true\)/);
  assert.match(app, /<NoMovementFeishuReportDialog[\s\S]*publicationId=\{noMovementV2State\.publicationId\}/);
  assert.match(app, /<FeishuShareDialog preview=\{feishuSharePreview\}/);
  assert.match(app, /noMovementFeishuDialogOpen && noMovementV2State\.status === "ready" && noMovementV2State\.identityKey === dashboardCacheIdentity[\s\S]*?viewerAuthorization && isMatrixAdminViewer/);
});

test("pilot dialog binds report, scope and recipient to backend-generated artifacts and requires confirmation", async () => {
  const dialog = await read("src/features/dashboards/no-movement-feishu-report-dialog.tsx");
  assert.match(dialog, /\/api\/v2\/no-movement\/feishu-report\/options/);
  assert.match(dialog, /\/api\/v2\/no-movement\/feishu-report\/prepare/);
  assert.match(dialog, /\/\$\{prepared\.reportId\}\/confirm/);
  assert.match(dialog, /\/\$\{prepared\.reportId\}\/send/);
  assert.match(dialog, /recipientKey: recipient/);
  assert.match(dialog, /useState\("PHELIPPE_PRIVATE"\)/);
  assert.match(dialog, /useState\(""\)/);
  assert.match(dialog, /disabled=\{busy \|\| !options\?\.sendEnabled\}/);
  assert.match(dialog, /window\.confirm\(t\("Enviar agora/);
  assert.match(dialog, /window\.confirm\(t\("Alterar regional ou destinatário/);
  assert.match(dialog, /Análise atual do painel/);
  assert.match(dialog, /attemptedScopeRef\.current = scopeKey/);
  assert.match(dialog, /Interpretação editável/);
  assert.match(dialog, /Comentários/);
  assert.match(dialog, /Recomendações/);
  assert.match(dialog, /Prévia final da mensagem/);
  assert.match(dialog, /18 colunas oficiais/);
  assert.doesNotMatch(dialog, /DEMO_GROUPS|Demonstração — Grupo/);
});

test("pilot uses independently disabled configuration and does not alter automatic publication notifications", async () => {
  const config = await read("backend/app/core/config.py");
  const example = await read("backend/.env.example");
  const service = await read("backend/app/services/no_movement_feishu_reports.py");
  assert.match(config, /feishu_no_movement_pilot_enabled: bool = False/);
  assert.match(example, /FEISHU_NO_MOVEMENT_PILOT_ENABLED=false/);
  assert.match(service, /if not config\.feishu_no_movement_pilot_enabled/);
  assert.match(service, /RECIPIENT_EMAIL/);
  assert.doesNotMatch(service, /receive_id_type=.{0,20}chat_id/);
});

test("report generation uses the selected publication and its pinned map, not browser pagination", async () => {
  const service = await read("backend/app/services/no_movement_feishu_reports.py");
  assert.match(service, /FROM source_snapshot_head AS head/);
  assert.match(service, /fact\.publication_id = :publication_id/);
  assert.match(service, /fact\.map_version_id = :map_version_id/);
  assert.match(service, /LEFT JOIN base_mapping_entries AS entry/);
  assert.match(service, /Workbook\(write_only=True\)/);
  assert.match(service, /Image\.new\("RGB"/);
  assert.match(service, /dataset_sha256/);
});

test("all pilot API routes require full effective MATRIX admin and same-origin writes", async () => {
  const api = await read("backend/app/api/data_foundation.py");
  const routes = api.slice(api.indexOf('@router.get("/no-movement/feishu-report/options")'), api.indexOf('@router.get("/collection-rate/operational-analysis")'));
  assert.equal((routes.match(/Depends\(require_matrix_admin\)/g) ?? []).length, 4);
  assert.equal((routes.match(/_require_effective_matrix_admin\(admin\)/g) ?? []).length, 4);
  assert.equal((routes.match(/_same_origin\(request\)/g) ?? []).length, 3);
  assert.match(api, /identity\.get\("organizational_scope"\) == "matrix"/);
  assert.match(api, /identity\.get\("role"\) == "matrix"/);
});

test("manual pilot schema matches the approved publication provenance and UTC datetime columns", async () => {
  const sql = await read("backend/sql/no-movement-feishu-pilot-review.sql");
  assert.match(sql, /publication_version BIGINT UNSIGNED NOT NULL/);
  for (const field of ["created_at", "updated_at", "confirmed_at", "sent_at"]) {
    assert.match(sql, new RegExp(`${field} DATETIME\\(6\\)`));
  }
  for (const field of ["interpretation", "comments", "recommendations"]) {
    assert.match(sql, new RegExp(`${field} TEXT NOT NULL,`));
    assert.doesNotMatch(sql, new RegExp(`${field} TEXT NOT NULL DEFAULT`));
  }
  assert.match(sql, /FOREIGN KEY \(source_id, publication_id, map_version_id\)\s+REFERENCES source_publications\(source_id, publication_id, map_version_id\)/);
});
