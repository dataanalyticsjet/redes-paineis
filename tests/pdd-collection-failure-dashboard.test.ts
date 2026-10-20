import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePddCollectionFailureV2,
  filterPddCollectionFailureV2Records,
  isPddCollectionFailureV2SingleOperationalDate,
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
  const summary = summarizePddCollectionFailureV2(rows);
  assert.equal(summary.totalOrders, 400);
  assert.equal(summary.ordersUnscannedAtReceipt, 40);
  assert.equal(summary.ordersUnscannedAtCollection, 100);
  assert.equal(summary.collectionFailureRate, 0.25);
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
