import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAnalysisMarkdown, serializeAnalysisRuns } from "../src/lib/no-movement-analysis-editor.mjs";

const dialog = await readFile(new URL("../src/features/dashboards/operational-feishu-report-dialog.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../backend/app/core/config.py", import.meta.url), "utf8");
const api = await readFile(new URL("../backend/app/api/data_foundation.py", import.meta.url), "utf8");

test("report modal is limited to Collection Rate V3 and PDD Collection Failure", () => {
  assert.match(dialog, /type OperationalSource = "collection_rate" \| "pdd_collection_failure"/);
  assert.match(dialog, /operational-feishu\/\$\{sourceId\}/);
  assert.match(app, /setOperationalFeishuSource\("collection_rate"\)/);
  assert.match(app, /setOperationalFeishuSource\("pdd_collection_failure"\)/);
  assert.doesNotMatch(dialog, /collection_monitoring|t4_t5|no_movement/);
  assert.match(api, /Literal\["collection_rate", "pdd_collection_failure"\]/);
});

test("modal uses the existing Markdown rich-text serializer and plain-text paste", () => {
  const incoming = "**TAXA V3**\n稳定 98,1%\\* literal";
  const runs = parseAnalysisMarkdown(incoming);
  assert.equal(runs[0].bold, true);
  assert.equal(serializeAnalysisRuns(runs), incoming);
  assert.match(dialog, /parseAnalysisMarkdown, serializeAnalysisRuns/);
  assert.match(dialog, /clipboardData\.getData\("text\/plain"\)/);
  assert.match(dialog, /createTextNode/);
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML/);
});

test("regional changes require confirmation and discard prior preparation", () => {
  assert.match(dialog, /Alterar regional ou destinatário descarta a preparação e as edições/);
  assert.match(dialog, /setPrepared\(null\); setAnalysis\(""\)/);
  assert.ok(app.includes("key={`${operationalFeishuSource}:"));
});

test("recipient choices come from the fixed server list and real send remains separately gated", () => {
  assert.match(dialog, /recipientOptions\.filter\(item => item\.type === "email"\)/);
  assert.match(dialog, /item\.type === "chat_id" && item\.regionCode === null/);
  assert.match(dialog, /item\.type === "chat_id" && item\.regionCode !== null/);
  assert.match(dialog, /disabled: !item\.available/);
  assert.match(dialog, /DashboardSingleSelect id="operational-feishu-region"/);
  assert.match(dialog, /DashboardSingleSelect id="operational-feishu-recipient"/);
  assert.doesNotMatch(dialog, /<select\b/);
  assert.match(dialog, /scopeRegionCode/);
  assert.match(dialog, /prepared\?\.state === "CONFIRMED"/);
  assert.match(dialog, /!scopedOptions\?\.sendEnabled/);
  assert.match(dialog, /const activeRecipient = selectedOption\?\.key/);
  assert.match(dialog, /Confirmar envio para/);
  assert.match(dialog, /prepared\.recipientType/);
  assert.match(dialog, /prepared\?\.previouslySent/);
  assert.match(dialog, /prepared\?\.state === "SENT"[\s\S]*Preparar novo envio/);
  assert.match(settings, /feishu_collection_rate_report_enabled: bool = False/);
  assert.match(settings, /feishu_pdd_collection_failure_report_enabled: bool = False/);
});

test("Taxa V3 Feishu uses the same filtered attempt-rate synthesis as the AI modal", async () => {
  assert.match(dialog, /collectionRateAnalysisForRegion\?\.\(region \|\| null\)/);
  assert.match(dialog, /sourceId === "collection_rate" && \(!filteredBundle \|\| filteredBundle\.analysis\.rowCount === 0\)/);
  assert.match(dialog, /dashboardScope: filteredBundle\.dashboardScope/);
  assert.match(dialog, /const ready = filteredBundle \? \{ \.\.\.value, analysis: filteredBundle\.analysis\.message \} : value/);
  assert.match(dialog, /prepareGeneration/);
  assert.match(dialog, /collectionRateScopeKey/);
  assert.match(dialog, /analysisText: analysis/);
  assert.match(app, /collectionRateAnalysisForRegion=\{operationalFeishuSource === "collection_rate" \? collectionRateFeishuAnalysisForRegion : undefined\}/);
  assert.match(app, /allowedCollectionRateRegions=\{operationalFeishuSource === "collection_rate" \? taxaV2FeishuAllowedRegions : undefined\}/);
  assert.match(app, /buildCollectionRateV3OperationalAnalysis\(periodRows/);
  assert.match(app, /taxaV2FilteredRows\.filter\(\(row\) => row\.region === regionCode\)/);
  assert.match(app, /period: collectionRateV2State\.period/);
  assert.match(app, /filters,/);
  assert.match(app, /locale: dashboardLocale\(language\)/);
  assert.match(app, /expectedRowIdentitySha256: identityDigest/);
  assert.match(app, /expectedRowContentSha256: contentDigest/);
  assert.match(app, /currentMappingRevision\(\)/);
  assert.match(app, /publicationIds: \[\.\.\.collectionRateV2State\.publicationIds\]\.sort\(\)/);
  assert.match(app, /taxaV2Filters/);
  assert.match(api, /analysis_text=payload\.analysis_text/);
  assert.match(api, /operational_feishu_dashboard_scope_required/);
  assert.match(api, /identity=admin\.identity/);
  const service = await readFile(new URL("../backend/app/services/operational_feishu_reports.py", import.meta.url), "utf8");
  assert.match(service, /_feishu_interactive_content\(str\(row\["analysis_text"\]\)\)/);
  assert.match(service, /_stream_collection_rate_scope_payload/);
  assert.match(service, /operational_feishu_scope_changed/);
  assert.match(service, /Resumo da tentativa/);
});

test("only Collection Rate V3 replaces backend prepared text; PDD and other report flows remain unchanged", () => {
  assert.match(dialog, /sourceId === "collection_rate"\s*\?\s*await collectionRateAnalysisForRegion/);
  assert.match(dialog, /const ready = filteredBundle \? \{ \.\.\.value, analysis: filteredBundle\.analysis\.message \} : value/);
  assert.match(app, /operationalFeishuSource === "collection_rate" \? collectionRateFeishuAnalysisForRegion : undefined/);
  assert.match(app, /operationalFeishuSource === "collection_rate" \? taxaV2FeishuAllowedRegions : undefined/);
});

test("the two report dialogs are opened only for a ready published snapshot and matrix admin", () => {
  assert.ok(app.includes('collectionRateV2State.status === "ready" && collectionRateFeishuAnchorPublicationId'));
  assert.ok(app.includes("const latestDate = periodRows.reduce"));
  assert.ok(app.includes('pddCollectionFailureV2State.status === "ready" && pddCollectionFailureV2State.publicationId'));
  assert.ok(app.includes("operationalFeishuSource && viewerAuthorization && isEffectiveMatrixAdminViewer"));
});
