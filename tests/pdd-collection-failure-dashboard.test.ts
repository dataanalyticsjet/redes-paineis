import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzePddCollectionFailureV2,
  filterPddCollectionFailureV2Records,
  isPddCollectionFailureV2SingleOperationalDate,
  PDD_COLLECTION_FAILURE_V2_HEADERS,
  pddCollectionFailureV2Dimensions,
  pddCollectionFailureV2FilterOptions,
  summarizePddCollectionFailureV2,
  summarizePddCollectionFailureV2ByBase,
  summarizePddCollectionFailureV2ByRegion,
  summarizePddCollectionFailureV2ByRm,
} from "../src/lib/data-foundation/pdd-collection-failure-dashboard.ts";
import {
  PDD_COLLECTION_FAILURE_V2_COLUMNS,
  type PddCollectionFailureV2Record,
} from "../src/lib/data-foundation/pdd-collection-failure.ts";

function record(
  sourceRowNo: number,
  overrides: Partial<PddCollectionFailureV2Record> = {},
): PddCollectionFailureV2Record {
  return {
    data_date: "2026-10-09",
    source_region_code: "REG-1",
    reported_region: "Regional do Excel",
    source_base_code: "00123",
    source_base_name: "Base Alfa",
    mapped_region: "SPE",
    mapped_uf: "SP",
    mapped_rm_area: "SP Capital",
    mapped_rm: "RM Alfa",
    order_origin_code: "WEB",
    order_origin: "Loja virtual",
    total_orders: 100,
    orders_unscanned_at_receipt: 20,
    rate_unscanned_at_receipt: "0.20",
    orders_unscanned_at_collection: 10,
    collection_failure_rate: "0.10",
    packages_missing_dispatch_scan: 5,
    rate_unscanned_at_dispatch: "0.05",
    overall_unscanned_rate: "0.25",
    publication_id: "publication-v2",
    source_row_no: sourceRowNo,
    resolved_base_code: "00123",
    mapping_resolution: "CODE_MATCH",
    effective_base_code: "00123",
    effective_base_name: "Base Alfa",
    effective_region: "SPE",
    effective_uf: "SP",
    effective_rm_area: "SP Capital",
    effective_rm: "RM Alfa",
    effective_rgm: "RGM Alfa",
    mapping_is_approved: true,
    ...overrides,
  };
}

test("usa as 15 colunas do Bot 02 e não substitui quantidade pela taxa original", () => {
  const rows = [
    record(2, { total_orders: 100, orders_unscanned_at_collection: 10, collection_failure_rate: "0.10" }),
    record(3, { total_orders: 300, orders_unscanned_at_collection: 90, collection_failure_rate: "0.30" }),
  ];

  assert.equal(PDD_COLLECTION_FAILURE_V2_COLUMNS.length, 15);
  assert.equal(PDD_COLLECTION_FAILURE_V2_COLUMNS[10], "orders_unscanned_at_collection");
  assert.equal(PDD_COLLECTION_FAILURE_V2_HEADERS[10], "Qtd pedidos não bipados na coleta");
  const summary = summarizePddCollectionFailureV2(rows);
  assert.equal(summary.totalOrders, 400);
  assert.equal(summary.ordersUnscannedAtReceipt, 40);
  assert.equal(summary.ordersUnscannedAtCollection, 100);
  assert.equal(summary.collectionFailureRate, 0.25);
});

test("a coluna K soma pedidos não bipados na coleta e mantém recebimento como métrica independente", () => {
  const rows = [
    record(2, {
      total_orders: 100,
      orders_unscanned_at_receipt: 20,
      orders_unscanned_at_collection: 3,
    }),
    record(3, {
      total_orders: 300,
      orders_unscanned_at_receipt: 35,
      orders_unscanned_at_collection: 8,
    }),
    record(4, {
      total_orders: 50,
      orders_unscanned_at_receipt: 5,
      orders_unscanned_at_collection: 2,
      source_base_code: "00456",
      source_base_name: "Base Beta",
      effective_base_code: "00456",
      effective_base_name: "Base Beta",
      effective_region: "SR",
      effective_rm_area: "SR-RS",
      effective_rm: "RM Beta",
      effective_rgm: "RGM SR",
    }),
  ];
  const analysis = analyzePddCollectionFailureV2(rows);

  assert.equal(PDD_COLLECTION_FAILURE_V2_COLUMNS[8], "orders_unscanned_at_receipt");
  assert.equal(PDD_COLLECTION_FAILURE_V2_HEADERS[8], "Qtd pedidos não bipados no recebimento da coleta");
  assert.equal(analysis.summary.ordersUnscannedAtReceipt, 60);
  assert.equal(analysis.summary.ordersUnscannedAtCollection, 13);
  assert.deepEqual(analysis.regionalSummary.map((row) => row.ordersUnscannedAtCollection).sort((a, b) => a - b), [2, 11]);
  assert.deepEqual(analysis.rmSummary.map((row) => row.ordersUnscannedAtCollection).sort((a, b) => a - b), [2, 11]);
  assert.deepEqual(analysis.baseSummary.map((row) => row.ordersUnscannedAtCollection).sort((a, b) => a - b), [2, 11]);
  assert.equal(analysis.regionalSummary.reduce((sum, row) => sum + row.ordersUnscannedAtCollection, 0), analysis.summary.ordersUnscannedAtCollection);
  assert.equal(analysis.rmSummary.reduce((sum, row) => sum + row.ordersUnscannedAtCollection, 0), analysis.summary.ordersUnscannedAtCollection);
  assert.equal(analysis.baseSummary.reduce((sum, row) => sum + row.ordersUnscannedAtCollection, 0), analysis.summary.ordersUnscannedAtCollection);
  assert.equal(analysis.regionalSummary.reduce((sum, row) => sum + row.ordersUnscannedAtReceipt, 0), analysis.summary.ordersUnscannedAtReceipt);
  assert.equal(analysis.rmSummary.reduce((sum, row) => sum + row.ordersUnscannedAtReceipt, 0), analysis.summary.ordersUnscannedAtReceipt);
  assert.equal(analysis.baseSummary.reduce((sum, row) => sum + row.ordersUnscannedAtReceipt, 0), analysis.summary.ordersUnscannedAtReceipt);
  assert.equal(analysis.summary.collectionFailureRate, 13 / 450);
  assert.deepEqual(analysis.filteredRecords.map((row) => row.orders_unscanned_at_receipt), [20, 35, 5]);
  assert.deepEqual(analysis.filteredRecords.map((row) => row.orders_unscanned_at_collection), [3, 8, 2]);
});

test("card, regional/RM/base tables and summarized exports display the column K metric consistently", async () => {
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const componentStart = source.indexOf("function PddCollectionFailureV2Dashboard(");
  const componentEnd = source.indexOf("const PDD_COLLECTION_FAILURE_V2_HEADERS_BY_FIELD", componentStart);
  const component = source.slice(componentStart, componentEnd);

  assert.match(component, /label={t\("Pedidos não bipados"\)} value={hasData \? formatCompact\(summary\.ordersUnscannedAtCollection\) : "—"} detail={t\("Soma da coluna oficial de pedidos não bipados na coleta no período"\)}/);
  assert.equal((component.match(/t\("Pedidos não bipados"\)/g) ?? []).length, 7);
  assert.equal((component.match(/row\.ordersUnscannedAtCollection/g) ?? []).length, 6);
  assert.match(component, /const totals = \[summary\.totalOrders, summary\.ordersUnscannedAtReceipt, summary\.ordersUnscannedAtCollection, summary\.collectionFailureRate\]/);
  assert.match(source, /orders_unscanned_at_collection: "Qtd pedidos não bipados na coleta"/);
  assert.equal((component.match(/t\("Não bipados no recebimento"\)/g) ?? []).length, 6);
  assert.match(component, /summary\.ordersUnscannedAtReceipt/);
});

test("exige um dia operacional único antes de calcular indicadores e tabelas", () => {
  assert.equal(isPddCollectionFailureV2SingleOperationalDate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }), true);
  assert.equal(isPddCollectionFailureV2SingleOperationalDate({ dateFrom: "2026-10-05", dateTo: "2026-10-06" }), false);
  assert.equal(isPddCollectionFailureV2SingleOperationalDate({ dateFrom: "", dateTo: "2026-10-05" }), false);
  assert.throws(
    () => summarizePddCollectionFailureV2([record(2), record(3, { data_date: "2026-10-06" })]),
    /pdd_multiple_operational_dates_not_supported/,
  );
});

test("mantém região e código originais sem usar a regional do Excel como fallback", () => {
  const unmapped = record(2, {
    source_base_code: "99999",
    source_base_name: "Base sem vínculo",
    source_region_code: "REG-PR",
    reported_region: "PR",
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    effective_base_code: "99999",
    effective_base_name: "Base sem vínculo",
    effective_region: "Sem regional",
    effective_rm_area: "Sem região do RM",
    effective_rm: "Sem RM",
    effective_rgm: "Sem RGM",
    mapping_is_approved: false,
  });
  const dimension = pddCollectionFailureV2Dimensions(unmapped);

  assert.equal(dimension.region, "Sem regional");
  assert.equal(dimension.baseCode, "99999");
  assert.equal(unmapped.reported_region, "PR");
  assert.equal(unmapped.source_region_code, "REG-PR");
  assert.equal(summarizePddCollectionFailureV2ByRegion([unmapped])[0]?.region, "Sem regional");
});

test("filtros, tabelas regional, RM e base preservam as linhas e agrupam dimensões oficiais", () => {
  const rows = [
    record(2, { total_orders: 100, orders_unscanned_at_collection: 10 }),
    record(3, { total_orders: 200, orders_unscanned_at_collection: 20 }),
    record(4, {
      source_base_code: "00456",
      source_base_name: "Base Beta",
      effective_base_code: "00456",
      effective_base_name: "Base Beta",
      effective_region: "SR",
      effective_rm_area: "SR-RS",
      effective_rm: "RM Beta",
      effective_rgm: "RGM SR",
      order_origin: "Marketplace",
      total_orders: 50,
      orders_unscanned_at_collection: 5,
    }),
  ];
  const options = pddCollectionFailureV2FilterOptions(rows);
  const filtered = filterPddCollectionFailureV2Records(rows, {
    regions: new Set(["SPE"]),
    rms: new Set(["RM Alfa"]),
    rgms: new Set(["RGM Alfa"]),
    bases: new Set(["Base Alfa"]),
    origins: new Set(["Loja virtual"]),
  });

  assert.deepEqual(options.regions, ["SPE", "SR"]);
  assert.equal(filtered.length, 2);
  assert.equal(summarizePddCollectionFailureV2(filtered).totalOrders, 300);
  assert.equal(summarizePddCollectionFailureV2ByRegion(rows).length, 2);
  assert.equal(summarizePddCollectionFailureV2ByRm(rows).length, 2);
  assert.equal(summarizePddCollectionFailureV2ByBase(rows).length, 2);
  assert.equal(new Set(rows.map((row) => `${row.publication_id}:${row.source_row_no}`)).size, rows.length);
});

test("a análise consolidada do PDD preserva opções, linhas filtradas e resumos", () => {
  const rows = [
    record(2, { total_orders: 100, orders_unscanned_at_receipt: 20, orders_unscanned_at_collection: 10 }),
    record(3, { total_orders: 300, orders_unscanned_at_receipt: 60, orders_unscanned_at_collection: 90 }),
    record(4, {
      source_base_code: "00456",
      source_base_name: "Base Beta",
      effective_base_code: "00456",
      effective_base_name: "Base Beta",
      effective_region: "SR",
      effective_rm_area: "SR-RS",
      effective_rm: "RM Beta",
      effective_rgm: "RGM SR",
      order_origin: "Marketplace",
      total_orders: 50,
      orders_unscanned_at_receipt: 5,
      orders_unscanned_at_collection: 5,
    }),
  ];
  const selections = {
    regions: new Set(["SPE"]),
    rms: null,
    rgms: new Set(["RGM Alfa"]),
    bases: null,
    origins: new Set(["Loja virtual"]),
  };
  const filtered = filterPddCollectionFailureV2Records(rows, {
    regions: selections.regions!,
    rms: new Set(["RM Alfa"]),
    rgms: selections.rgms!,
    bases: new Set(["Base Alfa"]),
    origins: selections.origins!,
  });
  const analysis = analyzePddCollectionFailureV2(rows, selections);

  assert.deepEqual(analysis.options, pddCollectionFailureV2FilterOptions(rows));
  assert.deepEqual(analysis.filteredRecords, filtered);
  assert.deepEqual(analysis.summary, summarizePddCollectionFailureV2(filtered));
  assert.deepEqual(analysis.regionalSummary, summarizePddCollectionFailureV2ByRegion(filtered));
  assert.deepEqual(analysis.rmSummary, summarizePddCollectionFailureV2ByRm(filtered));
  assert.deepEqual(analysis.baseSummary, summarizePddCollectionFailureV2ByBase(filtered));

  const noneSelected = analyzePddCollectionFailureV2(rows, { regions: new Set() });
  assert.equal(noneSelected.filteredRecords.length, 0);
  assert.equal(noneSelected.summary.totalOrders, 0);
  assert.deepEqual(noneSelected.options, analysis.options);
});
