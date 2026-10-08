import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSellerReportRows,
  classifySellerOutcome,
  filterSellerReportRows,
  filterSellerRowsByOutcome,
  normalizeSellerCategory,
  resolveSellerOrganization,
  sellerCategoryMatches,
  selectTopSellersBelowRate,
  sortSellerReportRowsByAwaiting,
  summarizeAwaitingByBaseAndRm,
  summarizeSellerOutcomes,
  type SellerMetricRecord,
} from "../src/lib/seller-monitoring.ts";
import { SELLER_MONITORING_FIELDS, normalizeSellerMonitoringWorkbook, summarizeSellerMonitoring } from "../src/lib/data-sources/seller-monitoring.ts";
import { DASHBOARD_DATA_SOURCES } from "../src/lib/data-sources/catalog.ts";
import type { ParsedWorkbook } from "../src/lib/workbook.ts";
import { buildResponsibilityData } from "../src/lib/responsibility.ts";
import { initialRegionSelection } from "../src/lib/initial-region-selection.ts";

function workbook(): ParsedWorkbook {
  const row: Record<string, unknown> = Object.fromEntries(SELLER_MONITORING_FIELDS.map((header) => [header, 0]));
  row["Data"] = "2026-10-06";
  row["Regional Origem"] = "PR";
  row["PDD de saida"] = "BNU -SC";
  row["Status atual – Aguardando coleta"] = 12;
  row["Status atual – Recebido no Drop-off"] = 1;
  row["Status atual – Coletado"] = 2;
  row["Status atual – Recebido"] = 3;
  row["Status atual – Recebido na base"] = 4;
  row["当前状态-网点发件流程中"] = 5;
  row["Status atual – Chegou ao SC"] = 6;
  return {
    sheetName: "sheet1",
    headers: [...SELLER_MONITORING_FIELDS],
    rows: [row],
    dateColumn: "Data",
    baseColumn: "PDD de saida",
    regionColumn: "Regional Origem",
    originColumn: "Origem do Pedido",
    statusColumns: [...SELLER_MONITORING_FIELDS.slice(8)],
    metadata: { sheetNames: ["sheet1"], headerRow: 1, rowCount: 1, columnCount: SELLER_MONITORING_FIELDS.length, columns: [], date1904: false },
    warnings: [],
  };
}

test("J&T source catalog uses the shared manual data-source flow", () => {
  const source = DASHBOARD_DATA_SOURCES.sellerPerformance;
  assert.equal(source.configured, true);
  assert.deepEqual(source.acceptedFormats, [".xlsx", ".xls"]);
  assert.equal(typeof source.preview, "function");
  assert.equal(typeof source.import, "function");
  assert.equal(typeof source.remove, "function");
});

test("J&T monitoring normalizes the official XLSX contract and retains the existing KPI formula", () => {
  const parsed = normalizeSellerMonitoringWorkbook(workbook());
  assert.equal(parsed.dateColumn, "Data");
  assert.equal(parsed.metadata.dateRange?.max, "2026-10-06");
  assert.deepEqual(summarizeSellerMonitoring(parsed), {
    awaiting: 12,
    processed: 21,
    total: 33,
    rate: 21 / 33,
  });
});

test("the J&T control totals remain unchanged when official regions are remapped", () => {
  const parsed = workbook();
  const row = { ...parsed.rows[0] };
  row["Regional Origem"] = "PR";
  row["PDD de saida"] = "BNU -SC";
  row["Status atual – Aguardando coleta"] = 1_220_993;
  row["Status atual – Recebido no Drop-off"] = 36_178;
  row["Status atual – Coletado"] = 60_915;
  row["Status atual – Recebido"] = 4;
  row["Status atual – Recebido na base"] = 137_180;
  row["当前状态-网点发件流程中"] = 531_447;
  row["Status atual – Chegou ao SC"] = 3_355_655;
  parsed.rows = [row];

  const normalized = normalizeSellerMonitoringWorkbook(parsed);
  assert.deepEqual(summarizeSellerMonitoring(normalized), {
    awaiting: 1_220_993,
    processed: 4_121_379,
    total: 5_342_372,
    rate: 4_121_379 / 5_342_372,
  });
});

test("official SC and RS base mapping moves them to SR while PR remains PR", () => {
  const headers = ["Regional", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"];
  const parsed: ParsedWorkbook = {
    sheetName: "Ativas",
    headers,
    rows: [
      { Regional: "SR", "Região RM": "SR-SC", "Responsável Rm": "樊善方 Shanfang Fan (Sean Fan)", "Código da base": "147113", "Nome da base": "BNU -SC", Descrição: "Própria" },
      { Regional: "SR", "Região RM": "SR-RS", "Responsável Rm": "周正军 Zhengjun Zhou (Victor)", "Código da base": "151135", "Nome da base": "CQA -RS", Descrição: "Própria" },
      { Regional: "PR", "Região RM": "PR-CWB", "Responsável Rm": "Diego Souza Braga Da Silva", "Código da base": "155158", "Nome da base": "F MGR 02-PR", Descrição: "Franquia" },
    ],
    statusColumns: [],
    metadata: { sheetNames: ["Ativas"], headerRow: 1, rowCount: 3, columnCount: 6, columns: [], date1904: false },
    warnings: [],
  };
  const responsibility = buildResponsibilityData(parsed, "De_para DoomsDay.xlsx");
  const enriched = [
    { region: "PR", base: "BNU -SC" },
    { region: "PR", base: "CQA -RS" },
    { region: "PR", base: "F MGR 02-PR" },
  ].map((record) => resolveSellerOrganization(record, responsibility));

  assert.deepEqual(enriched.map(({ base, region, rm, rgm }) => ({ base, region, rm, rgm })), [
    { base: "BNU -SC", region: "SR", rm: "樊善方 Shanfang Fan (Sean Fan)", rgm: "董文彤 WENTONG DONG (Winta)" },
    { base: "CQA -RS", region: "SR", rm: "周正军 Zhengjun Zhou (Victor)", rgm: "董文彤 WENTONG DONG (Winta)" },
    { base: "F MGR 02-PR", region: "PR", rm: "Diego Souza Braga Da Silva", rgm: "@高俊波" },
  ]);
  assert.deepEqual(enriched.filter((record) => record.region === "SR").map((record) => record.base), ["BNU -SC", "CQA -RS"]);
  assert.deepEqual(enriched.filter((record) => record.region === "PR").map((record) => record.base), ["F MGR 02-PR"]);

  const allRegions = initialRegionSelection(enriched.map((record) => record.region), {
    role: "matrix", organizational_scope: "matrix", region: null,
  });
  assert.deepEqual([...new Set(allRegions)], ["SR", "PR"]);
  const selectedSr = new Set(["SR"]);
  assert.deepEqual(enriched.filter((record) => selectedSr.has(record.region)).map((record) => record.base), ["BNU -SC", "CQA -RS"]);
  const clearedRegions = initialRegionSelection(enriched.map((record) => record.region), {
    role: "matrix", organizational_scope: "matrix", region: null,
  });
  assert.deepEqual([...new Set(clearedRegions)], ["SR", "PR"]);
});

test("missing official seller categories never exclude JMS rows or infer a category", () => {
  assert.equal(sellerCategoryMatches(null, new Set(), []), true);
  assert.equal(sellerCategoryMatches("J&T 重点保障", new Set(["J&T 重点保障", "单商多服"]), ["J&T 重点保障", "单商多服"]), true);
  assert.equal(sellerCategoryMatches(null, new Set(["J&T 重点保障"]), ["J&T 重点保障", "单商多服"]), false);
  assert.equal(sellerCategoryMatches("单商多服", new Set(["J&T 重点保障"]), ["J&T 重点保障", "单商多服"]), false);
});

test("J&T source rejects a missing required status field instead of guessing", () => {
  const parsed = workbook();
  parsed.headers = parsed.headers.filter((header) => header !== "Status atual – Chegou ao SC");
  assert.throws(() => normalizeSellerMonitoringWorkbook(parsed), /data_source_seller_required_columns_missing/);
});

const records: SellerMetricRecord[] = [
  {
    region: "SP",
    base: "Base A",
    sellerCode: "7494000000000000001",
    sellerName: "Loja Ágil",
    tier: "J&T 重点保障",
    origin: "JMS",
    awaiting: 10,
    processed: 90,
    total: 100,
  },
  {
    region: "RJ",
    base: "Base B",
    sellerCode: "7494000000000000001",
    sellerName: "Loja Ágil",
    tier: "J&T 重点保障",
    origin: "JMS",
    awaiting: 5,
    processed: 45,
    total: 50,
  },
  {
    region: "SP",
    base: "Base A",
    sellerCode: "7494000000000000002",
    sellerName: "Seller sem coleta",
    tier: "J&T 重点保障",
    origin: "JMS",
    awaiting: 20,
    processed: 0,
    total: 20,
  },
];

test("normalizes the official seller categories and keeps legacy T4/T5 lists compatible", () => {
  assert.equal(normalizeSellerCategory("J&T 重点保障"), "J&T 重点保障");
  assert.equal(normalizeSellerCategory("J&T重点保障"), "J&T 重点保障");
  assert.equal(normalizeSellerCategory("单商多服"), "单商多服");
  assert.equal(normalizeSellerCategory("T4"), "J&T 重点保障");
  assert.equal(normalizeSellerCategory("T5"), "J&T 重点保障");
  assert.equal(normalizeSellerCategory("outro"), "");
});

test("consolidates a seller across bases before calculating volume and attainment", () => {
  const rows = buildSellerReportRows(records, "seller", "14/08/2026");

  assert.equal(rows.length, 2);
  const t5 = rows.find((row) => row.sellerCode === "7494000000000000001");
  assert.ok(t5);
  assert.equal(t5.total, 150);
  assert.equal(t5.processed, 135);
  assert.equal(t5.awaiting, 15);
  assert.equal(t5.rate, 0.9);
  assert.equal(t5.baseCount, 2);
  assert.match(t5.base, /Base A/);
  assert.match(t5.base, /Base B/);
});

test("keeps sellers with only awaiting volume at zero percent", () => {
  const rows = buildSellerReportRows(records, "seller", "14/08/2026");
  const zeroSeller = rows.find((row) => row.sellerCode === "7494000000000000002");

  assert.ok(zeroSeller);
  assert.equal(zeroSeller.total, 20);
  assert.equal(zeroSeller.processed, 0);
  assert.equal(zeroSeller.rate, 0);
});

test("keeps master-list sellers absent from the JMS summary as zero percent", () => {
  const absentSeller: SellerMetricRecord = {
    region: "Sem regional",
    base: "Sem base",
    sellerCode: "7494000000000000003",
    sellerName: "Sem dados no Resumo JMS",
    tier: "J&T 重点保障",
    origin: "Sem registro no Resumo JMS",
    awaiting: 0,
    processed: 0,
    total: 0,
  };
  const rows = buildSellerReportRows([...records, absentSeller], "seller", "14/08/2026");
  const absent = rows.find((row) => row.sellerCode === absentSeller.sellerCode);

  assert.ok(absent);
  assert.equal(absent.total, 0);
  assert.equal(absent.rate, 0);
  assert.equal(absent.region, "Sem regional");
  assert.equal(absent.base, "Sem base");
});

test("builds independent summaries by base and regional", () => {
  const byBase = buildSellerReportRows(records, "base", "14/08/2026");
  const byRegional = buildSellerReportRows(records, "regional", "14/08/2026");

  assert.equal(byBase.length, 2);
  assert.equal(byRegional.length, 2);
  const sp = byRegional.find((row) => row.region === "SP");
  assert.ok(sp);
  assert.equal(sp.sellerCount, 2);
  assert.equal(sp.total, 120);
  assert.equal(sp.processed, 90);
  assert.equal(sp.rate, 0.75);
});

test("keeps the registered RM in seller, base and regional report rows", () => {
  const rmRecords = [
    { ...records[0], rm: "RM Ana" },
    { ...records[1], region: "SP", rm: "RM Bruno" },
  ];
  const bySeller = buildSellerReportRows(rmRecords, "seller", "01/08/2026");
  const byBase = buildSellerReportRows(rmRecords, "base", "01/08/2026");
  const byRegional = buildSellerReportRows(rmRecords, "regional", "01/08/2026");

  assert.equal(bySeller[0].rmLabel, "RM Ana, RM Bruno");
  assert.deepEqual(byBase.map((row) => row.rmLabel).sort(), ["RM Ana", "RM Bruno"]);
  assert.equal(byRegional[0].rmLabel, "RM Ana, RM Bruno");
});

test("filters seller reports by accent-insensitive name or exact code", () => {
  const rows = buildSellerReportRows(records, "seller", "14/08/2026");

  assert.equal(filterSellerReportRows(rows, "agil").length, 1);
  assert.equal(filterSellerReportRows(rows, "7494000000000000002").length, 1);
});

test("ranks only sellers with volume below the 90 percent target", () => {
  const belowTarget: SellerMetricRecord = {
    region: "MG",
    base: "Base C",
    sellerCode: "7494000000000000004",
    sellerName: "Loja em alerta",
    tier: "J&T 重点保障",
    origin: "JMS",
    awaiting: 10,
    processed: 40,
    total: 50,
  };
  const absent: SellerMetricRecord = {
    ...belowTarget,
    sellerCode: "7494000000000000005",
    sellerName: "Sem dados no Resumo JMS",
    awaiting: 0,
    processed: 0,
    total: 0,
  };
  const rows = buildSellerReportRows([...records, belowTarget, absent], "seller", "14/08/2026");
  const ranking = selectTopSellersBelowRate(rows, 0.9, 10);

  assert.deepEqual(
    ranking.map((row) => row.sellerCode),
    ["7494000000000000004", "7494000000000000002"],
  );
  assert.ok(ranking.every((row) => row.total > 0 && row.rate < 0.9));
});

test("summarizes complete, partial, and zero seller outcomes after consolidation", () => {
  const complete: SellerMetricRecord = {
    region: "MG",
    base: "Base C",
    sellerCode: "7494000000000000004",
    sellerName: "Seller completo",
    tier: "J&T 重点保障",
    origin: "JMS",
    awaiting: 0,
    processed: 100,
    total: 100,
  };
  const almostComplete: SellerMetricRecord = {
    ...complete,
    sellerCode: "7494000000000000005",
    sellerName: "Seller quase completo",
    awaiting: 1,
    processed: 9999,
    total: 10000,
  };
  const absent: SellerMetricRecord = {
    ...complete,
    sellerCode: "7494000000000000006",
    sellerName: "Sem dados no Resumo JMS",
    awaiting: 0,
    processed: 0,
    total: 0,
  };
  const rows = buildSellerReportRows(
    [...records, complete, almostComplete, absent],
    "seller",
    "14/08/2026",
  );
  const summary = summarizeSellerOutcomes(rows);

  assert.deepEqual(summary, {
    total: 5,
    complete: { count: 1, rate: 0.2 },
    partial: { count: 2, rate: 0.4 },
    zero: { count: 2, rate: 0.4 },
  });
  assert.equal(classifySellerOutcome(rows.find((row) => row.sellerCode === complete.sellerCode)!), "complete");
  assert.equal(classifySellerOutcome(rows.find((row) => row.sellerCode === almostComplete.sellerCode)!), "partial");
  assert.deepEqual(
    filterSellerRowsByOutcome(rows, "zero").map((row) => row.sellerCode).sort(),
    ["7494000000000000002", "7494000000000000006"],
  );
});

test("returns zero outcome rates for an empty seller selection", () => {
  assert.deepEqual(summarizeSellerOutcomes([]), {
    total: 0,
    complete: { count: 0, rate: 0 },
    partial: { count: 0, rate: 0 },
    zero: { count: 0, rate: 0 },
  });
});

test("sorts report rows by awaiting collection from highest to lowest", () => {
  const rows = buildSellerReportRows(records, "seller", "14/08/2026");
  const sorted = sortSellerReportRowsByAwaiting(rows);

  assert.deepEqual(sorted.map((row) => row.awaiting), [20, 15]);
});

test("summarizes awaiting collection by base and RM after all dashboard filters", () => {
  const filteredRecords: SellerMetricRecord[] = [
    { ...records[0], rm: "RM Ana" },
    { ...records[1], rm: "RM Ana" },
    { ...records[2], rm: "RM Bruno" },
    { ...records[2], rm: "RM sem pendência", awaiting: 0, total: 0 },
  ];

  assert.deepEqual(summarizeAwaitingByBaseAndRm(filteredRecords), [
    {
      base: "Base A",
      rm: "RM Bruno",
      awaiting: 20,
      processed: 0,
      total: 20,
      rate: 0,
    },
    {
      base: "Base A",
      rm: "RM Ana",
      awaiting: 10,
      processed: 90,
      total: 100,
      rate: 0.9,
    },
    {
      base: "Base B",
      rm: "RM Ana",
      awaiting: 5,
      processed: 45,
      total: 50,
      rate: 0.9,
    },
  ]);
});
