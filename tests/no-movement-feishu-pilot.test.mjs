import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAnalysisMarkdown, serializeAnalysisRuns } from "../src/lib/no-movement-analysis-editor.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Sem Movimentação opens the scoped report dialog, leaving other dashboards on their existing share flow", async () => {
  const app = await read("src/features/dashboards/dashboard-app.tsx");
  assert.match(app, /if \(view === "movimentacao"\)[\s\S]*setNoMovementFeishuDialogOpen\(true\)/);
  assert.match(app, /<NoMovementFeishuReportDialog[\s\S]*publicationId=\{noMovementV2State\.publicationId\}/);
  assert.match(app, /<FeishuShareDialog preview=\{feishuSharePreview\}/);
  assert.match(app, /noMovementFeishuDialogOpen && noMovementV2State\.status === "ready" && noMovementV2State\.identityKey === dashboardCacheIdentity[\s\S]*?viewerAuthorization && isMatrixAdminViewer/);
});

test("pilot dialog edits and confirms the exact analysis text without extra message fields", async () => {
  const dialog = await read("src/features/dashboards/no-movement-feishu-report-dialog.tsx");
  assert.match(dialog, /\/api\/v2\/no-movement\/feishu-report\/options/);
  assert.match(dialog, /\/api\/v2\/no-movement\/feishu-report\/prepare/);
  assert.match(dialog, /\/\$\{prepared\.reportId\}\/confirm/);
  assert.match(dialog, /\/\$\{prepared\.reportId\}\/send/);
  assert.match(dialog, /recipientKey: activeRecipient/);
  assert.match(dialog, /useState\("PHELIPPE_PRIVATE"\)/);
  assert.match(dialog, /useState\(""\)/);
  assert.match(dialog, /disabled=\{busy \|\| !scopedOptions\?\.sendEnabled\}/);
  assert.match(dialog, /window\.confirm\(`\$\{t\("Confirmar envio para"\)\}/);
  assert.match(dialog, /window\.confirm\(t\("Alterar regional ou destinatário/);
  assert.match(dialog, /Análise atual do painel/);
  assert.match(dialog, /contentEditable=\{!busy && Boolean\(prepared\) && prepared\?\.state !== "SENT"\}/);
  assert.match(dialog, /renderAnalysisMarkdown\(editor, prepared\?\.analysis \?\? ""\)/);
  assert.match(dialog, /serializeEditorChildren\(editor\)/);
  assert.match(dialog, /document\.createElement\("strong"\)/);
  assert.match(dialog, /document\.execCommand\("bold"\)/);
  assert.match(dialog, /event\.clipboardData\.getData\("text\/plain"\)/);
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML/);
  assert.match(dialog, /attemptedScopeRef\.current = scopeKey/);
  assert.match(dialog, /analysisText: analysisDraft/);
  assert.match(dialog, /analysisDraftRef\.current = next/);
  assert.match(dialog, /state: "PREPARED"/);
  assert.match(dialog, /setPrepared\(null\); setAnalysisDraft\(""\)/);
  assert.match(dialog, /Data da fonte/);
  assert.match(dialog, /publicationDate\(scopedOptions\?\.publishedAt\)/);
  assert.match(dialog, /prepared\?\.excelBytes && prepared\.excelBytes > 0/);
  assert.match(dialog, /prepared\?\.pngBytes && prepared\.pngBytes > 0/);
  assert.match(dialog, /Excel pronto/);
  assert.match(dialog, /Prévia PNG pronta/);
  assert.doesNotMatch(dialog, /nm-feishu-interpretation|nm-feishu-comments|nm-feishu-recommendations|nm-feishu-final-message/);
  assert.match(dialog, /18 colunas oficiais/);
  assert.doesNotMatch(dialog, /DEMO_GROUPS|Demonstração — Grupo/);
});

test("analysis editor round-trips bold, lists, line breaks, emoji and Portuguese/Chinese text without visible Markdown markers", () => {
  const source = "📦 **Resumo SPS**\n- Base **São Paulo**: 12\n- 网点 **深圳**: 8\nLiteral: \\*\\*não negrito\\*\\* e 2 \\* 3";
  const runs = parseAnalysisMarkdown(source);

  assert.deepEqual(runs.filter(run => run.bold).map(run => run.text), ["Resumo SPS", "São Paulo", "深圳"]);
  assert.equal(runs.map(run => run.text).join(""), "📦 Resumo SPS\n- Base São Paulo: 12\n- 网点 深圳: 8\nLiteral: **não negrito** e 2 * 3");
  assert.equal(serializeAnalysisRuns(runs), source);
  assert.equal(parseAnalysisMarkdown("**Título**")[0]?.text, "Título");
});

test("edited rich-text runs serialize to confirmed Markdown and preserve bold for Feishu", () => {
  const editedRuns = [
    { text: "Análise SPS revisada", bold: true },
    { text: "\nVolume: ", bold: false },
    { text: "1.234", bold: true },
    { text: "\nResponsável: 李伟", bold: false },
    { text: "\nNota literal: **não é estilo**", bold: false },
  ];
  const serialized = serializeAnalysisRuns(editedRuns);

  assert.equal(serialized, "**Análise SPS revisada**\nVolume: **1.234**\nResponsável: 李伟\nNota literal: \\*\\*não é estilo\\*\\*");
  assert.deepEqual(parseAnalysisMarkdown(serialized).filter(run => run.bold).map(run => run.text), ["Análise SPS revisada", "1.234"]);
});

test("rich-text editor controls keep Portuguese source text and English/Chinese translations", async () => {
  const translations = await read("src/lib/i18n.ts");
  assert.match(translations, /"Negrito": \{ en: "Bold", zh: "粗体" \}/);
  assert.match(translations, /"Formatação da análise": \{ en: "Analysis formatting", zh: "分析格式" \}/);
  assert.match(translations, /"Selecione o texto para aplicar ou remover negrito\."/);
});

test("backend delivers only the confirmed analysis_text and keeps the pilot disabled by default", async () => {
  const service = await read("backend/app/services/no_movement_feishu_reports.py");
  const api = await read("backend/app/api/data_foundation.py");
  const config = await read("backend/app/core/config.py");
  assert.match(api, /analysis_text: str = Field\(alias="analysisText", min_length=1, max_length=20000\)/);
  assert.match(service, /SET report_state='CONFIRMED', analysis_text=:analysis_text/);
  assert.match(service, /message_content = _feishu_interactive_content\(str\(row\["analysis_text"\]\)\)/);
  assert.match(service, /"msg_type": "interactive"/);
  assert.doesNotMatch(service, /📝 Interpretação|💬 Comentários|🎯 Recomendações/);
  assert.match(config, /feishu_no_movement_pilot_enabled: bool = False/);
});

test("pilot uses independently disabled configuration and does not alter automatic publication notifications", async () => {
  const config = await read("backend/app/core/config.py");
  const example = await read("backend/.env.example");
  const service = await read("backend/app/services/no_movement_feishu_reports.py");
  assert.match(config, /feishu_no_movement_pilot_enabled: bool = False/);
  assert.match(example, /FEISHU_NO_MOVEMENT_PILOT_ENABLED=false/);
  assert.match(service, /if not config\.feishu_no_movement_pilot_enabled/);
  assert.match(service, /RECIPIENT_EMAIL/);
  assert.match(service, /params=\{"receive_id_type": recipient\.kind\}/);
  assert.match(service, /"receive_id": recipient\.identifier/);
});

test("recipient selectors use scoped backend allowlists and never embed destination IDs in the UI", async () => {
  const dialog = await read("src/features/dashboards/no-movement-feishu-report-dialog.tsx");
  const service = await read("backend/app/services/feishu_report_recipients.py");
  const noMovement = await read("backend/app/services/no_movement_feishu_reports.py");
  assert.match(dialog, /scopedOptions\?\.recipients\.filter\(item => item\.type === "email"\)/);
  assert.match(dialog, /scopedOptions\?\.recipients\.filter\(item => item\.type === "chat_id"\)/);
  assert.match(dialog, /disabled=\{!item\.available\}/);
  assert.match(dialog, /regionCode=\$\{encodeURIComponent\(region\)\}/);
  assert.match(dialog, /prepared\.recipientType/);
  assert.match(service, /"SR_COLLECTION_GROUP"/);
  assert.match(service, /region_code="SR"/);
  assert.match(noMovement, /recipient_options\(region_code\)/);
  assert.match(dialog, /const scopedOptions = options\?\.scopeRegionCode === \(region \|\| null\) \? options : null/);
  assert.match(dialog, /const activeRecipient = selectedOption\?\.key/);
  assert.doesNotMatch(dialog, /oc_[a-f0-9]{20,}|marcos\.sjunior@|alan\.vicente@/);
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
  assert.match(service, /CONVERT_TZ\(p\.published_at, @@session\.time_zone, 'America\/Sao_Paulo'\)/);
});

test("all pilot API routes require full effective MATRIX admin and same-origin writes", async () => {
  const api = await read("backend/app/api/data_foundation.py");
  const routes = api.slice(api.indexOf('@router.get("/no-movement/feishu-report/options")'), api.indexOf('@router.get("/operational-feishu/{source_id}/options")'));
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
