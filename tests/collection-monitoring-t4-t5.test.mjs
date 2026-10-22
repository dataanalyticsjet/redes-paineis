import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { translateDashboardText } from "../src/lib/i18n.ts";

test("T4/T5 is exposed as an independent First Mile dashboard and uses its own source", async () => {
  const catalog = await readFile(new URL("../src/features/dashboards/dashboard-catalog.ts", import.meta.url), "utf8");
  const availability = await readFile(new URL("../src/features/dashboards/dashboard-availability.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");

  assert.match(catalog, /id: "monitoramento-t4-t5"[^\n]+category: "first-mile"/);
  assert.match(availability, /"monitoramento-t4-t5": "collection_monitoring_t4_t5"/);
  assert.match(app, /<CollectionMonitoringT4T5Dashboard key=\{dashboardCacheIdentity\}/);
  assert.match(app, /view === "monitoramento-t4-t5" \? \(/);
});

test("T4/T5 dashboard starts with the latest published date and queries server summaries and pages", async () => {
  const component = await readFile(new URL("../src/features/dashboards/collection-monitoring-t4-t5.tsx", import.meta.url), "utf8");

  assert.match(component, /dates\?contract_version=\$\{CONTRACT_VERSION\}&latest_only=true/);
  assert.match(component, /apiPath\("summary"/);
  assert.match(component, /apiPath\("groups"/);
  assert.match(component, /apiPath\("records"/);
  assert.match(component, /PAGE_SIZE = 50/);
  assert.match(component, /controllersRef\.current/);
  assert.match(component, /for \(const controller of controllers\) controller\.abort\(\)/);
  assert.match(component, /REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(component, /snapshotAsOf \? new Intl\.DateTimeFormat/);
  assert.doesNotMatch(component, /Promise\.all\(/);
  assert.doesNotMatch(component, /latest_only=false|limit=1000000/);

  const cardsReady = component.indexOf('setStatus(nextSummary.hasData ? "ready" : "empty")');
  const recordsRequest = component.indexOf('apiPath("records"');
  const groupsRequest = component.indexOf('apiPath("groups"');
  assert.ok(cardsReady >= 0 && recordsRequest > cardsReady);
  assert.ok(groupsRequest > cardsReady);
  assert.match(component, /setOptionsLoading\(true\)/);
  assert.match(component, /setRecordsLoading\(true\)/);
  assert.match(component, /setRegionalLoading\(true\)/);
  assert.match(component, /status !== "ready" && status !== "empty"/);
  assert.match(component, /status !== "ready" \|\| optionsLoading \|\| !summary\?\.hasData/);
  assert.match(component, /status !== "ready" \|\| optionsLoading \|\| !summary\?\.snapshotDate/);
  assert.match(component, /if \(!active \|\| controller\.signal\.aborted\) return/);
  assert.match(component, /function changeRecordPage\(page: number\) \{\s*setRecords\(\[\]\);\s*setRecordsLoading\(true\);\s*setRecordsError\(null\);\s*setRecordPage\(page\);\s*\}/);
  assert.doesNotMatch(component, /function changeRecordPage\(page: number\) \{[^}]*setSummary\(null\)/);
});

test("T4/T5 shows the approved processing summary and preserves independent status cards", async () => {
  const component = await readFile(new URL("../src/features/dashboards/collection-monitoring-t4-t5.tsx", import.meta.url), "utf8");

  for (const field of [
    "awaiting_collection", "received_at_dropoff", "collected", "received",
    "received_at_base", "in_base_dispatch_flow", "arrived_at_sc",
  ]) {
    assert.ok(component.includes(field), `status field ${field} is missing`);
  }
  assert.match(component, /totals\.processingRatePercent/);
  assert.match(component, /totals\.processingVolume/);
  assert.match(component, /totals\.awaitingCollectionVolume/);
  assert.match(component, /totals\.totalVolume/);
  assert.match(component, /Soma independente do campo JMS/);
  assert.match(component, /As contagens por status são independentes e não representam pedidos únicos/);
  assert.doesNotMatch(component, /collectionRate|totalPedidosUnicos/);

  for (const source of ["Processamento", "Aguardando coleta", "Volume em processamento", "{percentage} do volume total"]) {
    assert.notEqual(translateDashboardText("en", source, { percentage: "1.00%" }), source);
    assert.notEqual(translateDashboardText("zh", source, { percentage: "1.00%" }), source);
  }
});

test("T4/T5 retains the full source export and shows data state without invented values", async () => {
  const component = await readFile(new URL("../src/features/dashboards/collection-monitoring-t4-t5.tsx", import.meta.url), "utf8");
  const backend = await readFile(new URL("../backend/app/services/collection_monitoring_t4_t5.py", import.meta.url), "utf8");
  const api = await readFile(new URL("../backend/app/api/data_foundation.py", import.meta.url), "utf8");

  const columns = component.match(/const COLUMNS = \[([\s\S]*?)\n\] as const;/)?.[1] ?? "";
  assert.equal((columns.match(/\["[a-z_]+",/g) ?? []).length, 15);
  assert.match(component, /Aguardando primeira importação/);
  assert.match(component, /export\.xlsx/);
  assert.match(backend, /get_contract\(SOURCE_ID, CONTRACT_VERSION\)\.columns/);
  assert.match(backend, /stream_results=True/);
  assert.match(backend, /MAX_XLSX_DATA_ROWS/);
  assert.match(api, /def collection_monitoring_t4_t5_export\([\s\S]*?viewer: AuthenticatedViewer = Depends\(get_current_viewer\)/);
});

test("T4/T5 headings and operational statuses use the selected interface language", () => {
  const sources = [
    "Monitoramento de Coleta T4 e T5",
    "Monitoramento por Regional",
    "Monitoramento por PDD",
    "Por Cliente",
    "Por Loja",
    "Por Motorista",
    "Recebido no Drop-off",
    "Recebido",
    "Recebido na base",
    "Em processo de expedição na base",
    "Chegou ao SC",
    "{count} lojas",
    "{count} PDDs",
  ];

  for (const source of sources) {
    assert.notEqual(translateDashboardText("en", source, { count: 2 }), source);
    assert.notEqual(translateDashboardText("zh", source, { count: 2 }), source);
  }
  assert.equal(translateDashboardText("pt", "Monitoramento por Regional"), "Monitoramento por Regional");
});
