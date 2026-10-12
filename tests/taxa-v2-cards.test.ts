import assert from "node:assert/strict";
import test from "node:test";
import {
  filterTaxaV2CardRecords,
  mapTaxaV2CardRecords,
  summarizeTaxaV2Cards,
  taxaV2FilterOptions,
} from "../src/lib/taxa-v2-cards.ts";
import type { CollectionRateV2Record } from "../src/lib/data-foundation/collection-rate.ts";

function row(overrides: Partial<CollectionRateV2Record> = {}): CollectionRateV2Record {
  return {
    deadline_at: "2026-10-05 12:00:00",
    reported_region: "Sudeste",
    source_base_name: "Base A",
    order_origin: "Marketplace",
    product_type: "Normal",
    order_quantity: 100,
    quantity_to_collect: 80,
    cancelled_quantity: 0,
    collection_rate: "0.11",
    collected_quantity: 70,
    not_collected_quantity: 10,
    not_collected_on_time_quantity: 4,
    collected_on_time_quantity: 60,
    collection_on_time_rate: "0.99",
    collected_plus_attempts_quantity: 76,
    collection_rate_with_attempts: "0.12",
    average_collection_delay_hours: "1.25",
    processed_problem_items: 1,
    unprocessed_problem_items: 2,
    seller_collection_rate: "0.20",
    expected_merchant_visits: 3,
    merchants_not_visited: 1,
    publication_id: "publication-1",
    source_row_no: 2,
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    mapped_region: null,
    ...overrides,
  };
}

test("maps only the contract quantity columns used by the four legacy KPI formulas", () => {
  const [mapped] = mapTaxaV2CardRecords([row()]);
  const summary = summarizeTaxaV2Cards([mapped]);

  assert.equal(summary.onTime, 60);
  assert.equal(summary.onTimeRate, 60 / 80);
  assert.equal(summary.collectedWithAttempts, 76);
  assert.equal(summary.collectionWithAttemptsRate, 76 / 80);
  assert.equal(summary.toCollect, 80);
  assert.equal(summary.notCollected, 10);
  assert.equal(summary.awaitingRate, 10 / 80);
  assert.equal(mapped.region, "Sem regional");
  assert.equal(mapped.base, "Base A");
  assert.equal(mapped.origin, "Marketplace");
});

test("preserves the original V2 regional, base and order-origin text", () => {
  const [mapped] = mapTaxaV2CardRecords([row({
    reported_region: " Sudeste ",
    source_base_name: " Base A ",
    order_origin: " Marketplace ",
  })]);

  assert.equal(mapped.region, "Sem regional");
  assert.equal(mapped.reportedRegion, " Sudeste ");
  assert.equal(mapped.base, " Base A ");
  assert.equal(mapped.origin, " Marketplace ");
});

test("keeps the validated 05/10/2026 official workbook totals for each card", () => {
  const [mapped] = mapTaxaV2CardRecords([row({
    order_quantity: 1_045_004,
    quantity_to_collect: 906_527,
    collected_on_time_quantity: 635_075,
    collected_plus_attempts_quantity: 861_404,
    not_collected_quantity: 269_304,
  })]);
  const summary = summarizeTaxaV2Cards([mapped]);

  assert.equal(summary.onTimeRate, 635_075 / 906_527);
  assert.equal(summary.collectionWithAttemptsRate, 861_404 / 906_527);
  assert.equal(summary.toCollect, 906_527);
  assert.equal(summary.notCollected, 269_304);
});

test("aggregates numerators and denominators before calculating rates", () => {
  const [first, second] = mapTaxaV2CardRecords([
    row({ quantity_to_collect: 1, collected_on_time_quantity: 1, collected_plus_attempts_quantity: 1 }),
    row({ quantity_to_collect: 99, collected_on_time_quantity: 0, collected_plus_attempts_quantity: 99, source_row_no: 3 }),
  ]);
  const summary = summarizeTaxaV2Cards([first, second]);

  assert.equal(summary.onTimeRate, 1 / 100);
  assert.equal(summary.collectionWithAttemptsRate, 100 / 100);
  assert.notEqual(summary.onTimeRate, (1 + 0) / 2);
});

test("does not infer RM for unmapped or unapproved exact-name candidates", () => {
  const [unmapped, unapproved] = mapTaxaV2CardRecords([
    row(),
    row({ mapping_resolution: "UNAPPROVED_EXACT_NAME", resolved_base_code: "B-1", source_row_no: 3 }),
  ]);

  assert.equal(unmapped.rm, "Sem RM");
  assert.equal(unapproved.rmArea, "Sem região do RM");
  assert.equal(summarizeTaxaV2Cards([unmapped, unapproved]).toCollect, 160);
});

test("uses the official code-joined SR assignment and preserves raw regional origin", () => {
  const [mapped] = mapTaxaV2CardRecords([row({
    reported_region: "PR",
    mapping_resolution: "NAME_APPROVED",
    resolved_base_code: "RS-001",
    mapped_region: "SR",
    mapped_uf: "RS",
    mapped_rm_area: "SR-RS",
    mapped_rm: " 周正军   Zhengjun Zhou (Victor) ",
  })]);

  assert.equal(mapped.region, "SR");
  assert.equal(mapped.reportedRegion, "PR");
  assert.equal(mapped.rm, "周正军 Zhengjun Zhou (Victor)");
  assert.equal(mapped.rmArea, "SR-RS");
  assert.equal(mapped.rgm, "董文彤 WENTONG DONG (Winta)");
});

test("applies all filters to the same records and includes unassigned values as options", () => {
  const records = mapTaxaV2CardRecords([
    row(),
    row({ reported_region: null, source_base_name: null, order_origin: "Loja", source_row_no: 3 }),
  ]);
  const filtered = filterTaxaV2CardRecords(records, {
    regions: new Set(["Sem regional"]),
    rms: new Set(["Sem RM"]),
    rmAreas: new Set(["Sem região do RM"]),
    bases: new Set(["Sem base"]),
    origins: new Set(["Loja"]),
  });

  assert.equal(filtered.length, 1);
  assert.equal(summarizeTaxaV2Cards(filtered).toCollect, 80);
  assert.deepEqual(taxaV2FilterOptions(records).regions, ["Sem regional"]);
  assert.ok(taxaV2FilterOptions(records).rms.includes("Sem RM"));
});
