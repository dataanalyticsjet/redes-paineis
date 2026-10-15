import assert from "node:assert/strict";
import test from "node:test";
import {
  mapNoMovementV2Record,
  NO_MOVEMENT_SOURCE_HEADERS,
  noMovementAvailabilityMessage,
} from "../src/lib/data-foundation/no-movement-dashboard.ts";

const record = (sourceRowNo: number) => ({
  reported_region: "Regional original",
  source_base_code: "DUP-001",
  source_base_name: "Base JMS original",
  stopped_orders: "100",
  orders_in_transit: "900",
  stopped_over_1_day: "20",
  stopped_over_2_days: "10",
  stopped_over_3_days: "8",
  stopped_over_4_days: "6",
  stopped_over_5_days: "4",
  stopped_over_6_days: "3",
  stopped_over_7_days: "2",
  stopped_over_10_days: "1",
  stopped_over_14_days: "30",
  stopped_over_30_days: "36",
  last_operation_at: "2026-10-14 14:25:00",
  stopped_14_plus_days_rate: "0.300000000000000001",
  stopped_30_plus_days_rate: "0.360000000000000001",
  publication_id: "publication-1",
  source_row_no: sourceRowNo,
  resolved_base_code: "DUP-001",
  mapping_resolution: "CODE_MATCH",
  mapped_region: "SR",
  mapped_uf: sourceRowNo === 2 ? "RS" : "SC",
  mapped_rm_area: sourceRowNo === 2 ? "SR-RS" : "SR-SC",
  mapped_rm: sourceRowNo === 2 ? "Victor" : "Sean Fan",
});

test("JMS adapter preserves physical rows, raw fields and exact DECIMAL strings", () => {
  const first = mapNoMovementV2Record(record(2));
  const second = mapNoMovementV2Record(record(3));

  assert.notEqual(first.key, second.key);
  assert.equal(first.region, "SR");
  assert.equal(first.sourceRegion, "Regional original");
  assert.equal(first.rmArea, "SR-RS");
  assert.equal(first.rm, "Victor");
  assert.equal(first.code, "DUP-001");
  assert.equal(first.totalStopped, 100);
  assert.equal(first.over14Days, 30);
  assert.equal(first.over30Days, 36);
  assert.equal(first.values[NO_MOVEMENT_SOURCE_HEADERS.stopped_14_plus_days_rate], "0.300000000000000001");
  assert.equal(first.values[NO_MOVEMENT_SOURCE_HEADERS.reported_region], "Regional original");
  assert.equal(second.rmArea, "SR-SC");
  assert.equal(second.mappingResolution, "CODE_MATCH");
  assert.equal(Object.keys(first.values).length, 18);
});

test("unmapped JMS rows remain visible with original region and no invented responsibility", () => {
  const unmapped = mapNoMovementV2Record({
    ...record(4),
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    mapped_region: null,
    mapped_rm_area: null,
    mapped_rm: null,
  });

  assert.equal(unmapped.region, "Sem regional");
  assert.equal(unmapped.sourceRegion, "Regional original");
  assert.equal(unmapped.rm, "Sem RM");
  assert.equal(unmapped.rmArea, "Sem região do RM");
  assert.equal(unmapped.mappingResolution, "UNMAPPED");
  assert.equal(unmapped.totalStopped, 100);
});

test("painel sem publicação V2 informa primeira importação sem recorrer à fonte legada", () => {
  assert.equal(noMovementAvailabilityMessage("idle", null), "Carregando publicação vigente da Data Foundation V2…");
  assert.equal(noMovementAvailabilityMessage("loading", null), "Carregando publicação vigente da Data Foundation V2…");
  assert.equal(noMovementAvailabilityMessage("empty", null), "Aguardando primeira importação");
  assert.equal(noMovementAvailabilityMessage("empty", "publication-1"), "Publicação V2 sem registros");
  assert.equal(noMovementAvailabilityMessage("error", null), "Erro ao consultar a Data Foundation V2.");
});
