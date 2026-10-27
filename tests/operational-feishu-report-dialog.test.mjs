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
  assert.match(dialog, /options\?\.recipients\.map/);
  assert.match(dialog, /prepared\?\.state === "CONFIRMED"/);
  assert.match(dialog, /!options\?\.sendEnabled/);
  assert.match(dialog, /window\.confirm\(t\("Enviar agora a análise e os dois anexos ao destinatário privado autorizado\?"\)\)/);
  assert.match(settings, /feishu_collection_rate_report_enabled: bool = False/);
  assert.match(settings, /feishu_pdd_collection_failure_report_enabled: bool = False/);
});

test("the two report dialogs are opened only for a ready published snapshot and matrix admin", () => {
  assert.match(app, /collectionRateV2State\.status !== "ready" \|\| !collectionRateV2State\.publicationId/);
  assert.match(app, /pddCollectionFailureV2State\.status !== "ready" \|\| !pddCollectionFailureV2State\.publicationId/);
  assert.match(app, /operationalFeishuSource && viewerAuthorization && isMatrixAdminViewer/);
});
