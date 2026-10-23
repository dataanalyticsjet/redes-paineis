import test from "node:test";
import assert from "node:assert/strict";
import { loadCollectionMonitoringV2Retention, type CollectionMonitoringV2RetentionRecord, type CollectionMonitoringV2RmRetentionRecord } from "../src/lib/data-foundation/collection-monitoring-v2.ts";
import { regionalRetentionModel, regionalRetentionMatrix, rmRetentionModel, rmRetentionMatrix } from "../src/lib/data-foundation/collection-monitoring-v2-retention.ts";

function aggregate(date: string, region: string, vals: Partial<CollectionMonitoringV2RetentionRecord> = {}): CollectionMonitoringV2RetentionRecord {
  return {
    data_date: date, publication_id: "pub", region, row_count: 1, expected_dropoff: 100, expected_pickup: 0,
    pending_dropoff: 0, pending_pickup: 0, status_collected: 999, status_received_at_base: 10,
    status_dispatched_from_base: 20, status_in_transit_from_base: 800, in_transit_to_center: 30,
    in_transit_to_distribution: 40, arrived_sorting_center: 30, arrived_sc: 20, ...vals,
  };
}
function rmAggregate(date: string, region: string, rm_area: string, rm: string, vals: Partial<CollectionMonitoringV2RmRetentionRecord> = {}): CollectionMonitoringV2RmRetentionRecord {
  return { ...aggregate(date, region), rm_area, rm, ...vals };
}

test("regional table uses approved planned volume L+O+P+T and retention L+M+Q, keeping Q distinct from T", () => {
  const model = regionalRetentionModel([
    aggregate("2026-10-20", "SPE", { status_received_at_base: 2, in_transit_to_center: 3, in_transit_to_distribution: 4, status_dispatched_from_base: 3, arrived_sorting_center: 5, arrived_sc: 9000 }),
    aggregate("2026-10-21", "SPE", { status_received_at_base: 4, in_transit_to_center: 6, in_transit_to_distribution: 8, status_dispatched_from_base: 6, arrived_sorting_center: 10, arrived_sc: 9000 }),
    aggregate("2026-10-22", "SPE", { expected_dropoff: 99, expected_pickup: 1, status_received_at_base: 8, in_transit_to_center: 10, in_transit_to_distribution: 12, status_dispatched_from_base: 12, arrived_sorting_center: 20, arrived_sc: 9000 }),
  ], ["2026-10-20", "2026-10-21", "2026-10-22"]);
  assert.deepEqual(model.total.values.retentionTotal, [10, 20, 40]);
  assert.deepEqual(model.total.values.retainedAtBase, [2, 4, 8]);
  assert.deepEqual(model.total.values.dispatchedFromBase, [3, 6, 12]);
  assert.deepEqual(model.total.values.arrivedCenter, [5, 10, 20]);
  assert.equal(model.total.planned, 9030);
  for (const row of [...model.rows, model.total]) {
    for (let index = 0; index < model.dates.length; index += 1) {
      assert.equal(row.values.retentionTotal[index], row.values.retainedAtBase[index]! + row.values.dispatchedFromBase[index]! + row.values.arrivedCenter[index]!);
    }
  }
  assert.equal(model.total.planned, model.rows.reduce((sum, row) => sum + (row.planned ?? 0), 0));
  assert.equal(model.rows[0].variations.retentionTotal, 1);
  const matrix = regionalRetentionMatrix(model);
  assert.equal(matrix[0].length, 19);
  assert.deepEqual(matrix.at(-1)?.slice(0, 7), ["Total geral", "—", 9030, 10, 20, 40, 1]);
});

test("regional and RM planned volume match the approved 22/10 reference without changing retention components", () => {
  const source = aggregate("2026-10-22", "SPE", {
    status_received_at_base: 35_029,
    in_transit_to_center: 64_323,
    in_transit_to_distribution: 15_404,
    arrived_sc: 797_192,
    status_dispatched_from_base: 4_946,
    arrived_sorting_center: 267_819,
  });
  const regional = regionalRetentionModel([source], ["2026-10-22"]);
  const rm = rmRetentionModel([{ ...source, rm_area: "SP", rm: "RM A" }]);
  assert.equal(regional.total.planned, 911_948);
  assert.equal(regional.rows[0].planned, 911_948);
  assert.equal(rm.total.planned, 911_948);
  assert.equal(rm.rows[0].planned, 911_948);
  assert.equal(rm.total.retentionTotal, 307_794);
  assert.equal(rm.total.retentionTotal, rm.total.retainedAtBase + rm.total.dispatchedFromBase + rm.total.arrivedCenter);
});

test("regional table shows the latest three filtered dates; missing dates and actual zero stay distinct", () => {
  const rows = [aggregate("2026-10-18", "CE", { expected_dropoff: 10, status_received_at_base: 5, status_dispatched_from_base: 0, arrived_sorting_center: 0 }), aggregate("2026-10-20", "CE", { expected_dropoff: 10, status_received_at_base: 0, status_dispatched_from_base: 0, arrived_sorting_center: 0 }), aggregate("2026-10-22", "CE", { expected_dropoff: 20, status_received_at_base: 0, status_dispatched_from_base: 0, arrived_sorting_center: 0 }), aggregate("2026-10-22", "HQ", { expected_dropoff: 0, expected_pickup: 0, status_received_at_base: 1, status_dispatched_from_base: 0, arrived_sorting_center: 0 })];
  const model = regionalRetentionModel(rows, ["2026-10-18", "2026-10-20", "2026-10-22"]);
  assert.deepEqual(model.dates, ["2026-10-18", "2026-10-20", "2026-10-22"]);
  assert.deepEqual(model.rows.find((row) => row.region === "CE")?.values.retentionTotal, [5, 0, 0]);
  assert.deepEqual(model.rows.find((row) => row.region === "HQ")?.values.retentionTotal, [null, null, 1]);
  assert.equal(model.rows.find((row) => row.region === "HQ")?.planned, 91);
  assert.equal(model.rows.find((row) => row.region === "CE")?.variations.retentionTotal, null);
  assert.equal(regionalRetentionModel([], []).total.planned, null);
});

test("RM table groups by RM and official region, sums approved L+O+P+T before rates, and keeps retention L+M+Q", () => {
  const model = rmRetentionModel([
    rmAggregate("2026-10-22", "SPE", "SP", "RM A", { expected_dropoff: 80, status_received_at_base: 10, in_transit_to_center: 20, in_transit_to_distribution: 30, arrived_sc: 40, status_dispatched_from_base: 5, arrived_sorting_center: 5 }),
    rmAggregate("2026-10-22", "SPE", "SP", "RM A", { expected_dropoff: 20, status_received_at_base: 10, in_transit_to_center: 30, in_transit_to_distribution: 40, arrived_sc: 50, status_dispatched_from_base: 5, arrived_sorting_center: 5 }),
    rmAggregate("2026-10-22", "CE", "CE", "RM B", { expected_dropoff: 100, status_received_at_base: 5, in_transit_to_center: 25, in_transit_to_distribution: 35, arrived_sc: 45, status_dispatched_from_base: 0, arrived_sorting_center: 0 }),
  ]);
  assert.deepEqual(model.rows.map((row) => row.rm), ["RM A", "RM B"]);
  assert.equal(model.rows[0].planned, 230);
  assert.equal(model.rows[0].retentionTotal, 40);
  assert.equal(model.rows[0].retentionRate, 40 / 230);
  assert.equal(model.rows[0].arrivedCenter, 10);
  assert.equal(model.rows[1].retentionRate, 5 / 110);
  assert.equal(model.total.retentionTotal, model.rows.reduce((sum, row) => sum + row.retentionTotal, 0));
  assert.equal(model.total.planned, 340);
  assert.equal(model.total.retentionRate, 45 / 340);
  for (const row of [...model.rows, model.total]) {
    assert.equal(row.retentionTotal, row.retainedAtBase + row.dispatchedFromBase + row.arrivedCenter);
  }
  assert.equal(model.total.planned, model.rows.reduce((sum, row) => sum + row.planned, 0));
  const regionalTotals = regionalRetentionModel([
    rmAggregate("2026-10-22", "SPE", "SP", "RM A", { expected_dropoff: 80, status_received_at_base: 10, in_transit_to_center: 20, in_transit_to_distribution: 30, arrived_sc: 40, status_dispatched_from_base: 5, arrived_sorting_center: 5 }),
    rmAggregate("2026-10-22", "SPE", "SP", "RM A", { expected_dropoff: 20, status_received_at_base: 10, in_transit_to_center: 30, in_transit_to_distribution: 40, arrived_sc: 50, status_dispatched_from_base: 5, arrived_sorting_center: 5 }),
    rmAggregate("2026-10-22", "CE", "CE", "RM B", { expected_dropoff: 100, status_received_at_base: 5, in_transit_to_center: 25, in_transit_to_distribution: 35, arrived_sc: 45, status_dispatched_from_base: 0, arrived_sorting_center: 0 }),
  ], ["2026-10-22"]);
  assert.equal(regionalTotals.total.values.retentionTotal[0], model.total.retentionTotal);
  assert.equal(regionalTotals.total.planned, model.total.planned);
  assert.equal(rmRetentionModel([rmAggregate("2026-10-22", "SPE", "SP", "RM A", { expected_dropoff: 0, status_received_at_base: 0, in_transit_to_center: 0, in_transit_to_distribution: 0, arrived_sc: 0 })]).total.retentionRate, null);
  assert.equal(rmRetentionMatrix(model)[0].length, 12);
});

test("retention loader stays on the protected aggregate endpoint and validates both authorized groupings", async () => {
  const calls: string[] = [];
  const response = { sourceId: "collection_monitoring", contractVersion: 2, dates: ["2026-10-22"], aggregates: [aggregate("2026-10-22", "SPE")], rmAggregates: [rmAggregate("2026-10-22", "SPE", "SP", "RM A")] };
  const result = await loadCollectionMonitoringV2Retention({ dateFrom: "2026-10-20", dateTo: "2026-10-22" }, async (path) => { calls.push(path); return new Response(JSON.stringify(response)); }, undefined, { region: "SPE", rm: "RM A", rmArea: "SP", base: "PDD", origin: "JMS", rgmRegions: ["SPE"] });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /collection-monitoring-v2\/regional-retention/);
  assert.doesNotMatch(calls[0], /\/records/);
  const params = new URL(calls[0], "http://localhost").searchParams;
  for (const [key, expected] of [["region", "SPE"], ["rm", "RM A"], ["rm_area", "SP"], ["base", "PDD"], ["origin", "JMS"]]) assert.equal(params.get(key), expected);
  assert.deepEqual(params.getAll("rgm_regions"), ["SPE"]);
  assert.equal(result.aggregates[0].arrived_sorting_center, 30);
  assert.equal(result.rmAggregates[0].rm, "RM A");
  await assert.rejects(loadCollectionMonitoringV2Retention({ dateFrom: "2026-10-20", dateTo: "2026-10-22" }, async () => new Response("{}", { status: 403 })), /autorizado/);
  await assert.rejects(loadCollectionMonitoringV2Retention({ dateFrom: "2026-10-20", dateTo: "2026-10-22" }, async () => new Response(JSON.stringify({ ...response, sourceId: "collection_rate" }))), /outra fonte/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadCollectionMonitoringV2Retention({ dateFrom: "2026-10-22", dateTo: "2026-10-22" }, async () => { throw new Error("must not fetch"); }, controller.signal), /aborted/);
});

test("regional and RM table renderers preserve their approved columns and grouped headers", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = await import("typescript");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const componentUrl = new URL("../src/features/dashboards/collection-monitoring-v2-regional-retention.tsx", import.meta.url);
  const require = createRequire(import.meta.url);
  const source = await readFile(componentUrl, "utf8");
  const output = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replace(/from "([^"]+)"/g, (_all, specifier: string) => {
    const target = specifier.startsWith(".") ? new URL(specifier + (/\.tsx?$/.test(specifier) ? "" : ".ts"), componentUrl).href : pathToFileURL(require.resolve(specifier)).href;
    return `from ${JSON.stringify(target)}`;
  });
  const module = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const dates = ["2026-10-20", "2026-10-21", "2026-10-22"];
  const aggregateRows = dates.map((date) => aggregate(date, "SPE"));
  const regional = module.regionalRetentionModel?.(aggregateRows, dates) ?? regionalRetentionModel(aggregateRows, dates);
  const rm = rmRetentionModel([rmAggregate("2026-10-22", "SPE", "SP", "RM A")]);
  const t = (label: string) => label;
  const regionalHtml = renderToStaticMarkup(createElement(module.CollectionMonitoringV2RegionalRetentionTable, { t, language: "pt", model: regional, rmModel: rm, onExport: () => {} }));
  const rmHtml = renderToStaticMarkup(createElement(module.CollectionMonitoringV2RmRetentionTable, { t, language: "pt", model: rm }));
  assert.equal((regionalHtml.match(/colSpan="4"/gi) ?? []).length, 4);
  assert.equal((regionalHtml.match(/rowSpan="2"/gi) ?? []).length, 3);
  assert.match(regionalHtml, /Chegado ao centro/);
  assert.match(rmHtml, /Retenção por RM/);
  assert.match(rmHtml, /Região do RM/);
  assert.match(rmHtml, /Chegado ao centro/);
  assert.match(regionalHtml, /Baixar Excel — todas as tabelas/);
});

test("retention workbook has only regional and RM sheets", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { transpileModule, ModuleKind, ScriptTarget } = await import("typescript");
  const require = createRequire(import.meta.url);
  const fileUrl = new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url);
  const source = await readFile(fileUrl, "utf8");
  let helper = source.slice(source.indexOf("async function downloadRetentionWorkbook("), source.indexOf("export function CollectionMonitoringV2Dashboard"));
  helper = helper.replace("async function downloadRetentionWorkbook(", "export async function downloadRetentionWorkbook(").replace(/XLSX\.writeFile\(workbook,[\s\S]*?\);/, "return workbook;");
  const output = transpileModule(helper, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll('"xlsx-js-style"', JSON.stringify(pathToFileURL(require.resolve("xlsx-js-style")).href));
  const { downloadRetentionWorkbook } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const regional = regionalRetentionMatrix(regionalRetentionModel([aggregate("2026-10-22", "SPE")], ["2026-10-22"]));
  const rm = rmRetentionMatrix(rmRetentionModel([rmAggregate("2026-10-22", "SPE", "SP", "RM A")]));
  const workbook = await downloadRetentionWorkbook(regional, rm, { dateFrom: "2026-10-22", dateTo: "2026-10-22" });
  assert.deepEqual(workbook.SheetNames, ["Retenção por regional", "Retenção por RM"]);
  assert.equal(workbook.Sheets["Retenção por RM"].F2.v, 0.6);
});
