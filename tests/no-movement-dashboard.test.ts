import assert from "node:assert/strict";
import test from "node:test";
import { NoMovementV2LoadError } from "../src/lib/data-foundation/no-movement.ts";
import {
  mapNoMovementV2Record,
  NO_MOVEMENT_SOURCE_HEADERS,
  selectNoMovementSource,
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

test("sem publicação compatível, preserva integralmente a fonte legada", async () => {
  const legacy = { sourceType: "MANUAL_UPLOAD", rows: [{ id: "legacy-row", total: 17 }] };
  let legacyLoadCount = 0;
  const selected = await selectNoMovementSource(
    async () => { throw new NoMovementV2LoadError("empty", "Ainda não existe snapshot V2."); },
    async () => { legacyLoadCount += 1; return legacy; },
  );

  assert.equal(selected.source, "LEGACY");
  if (selected.source !== "LEGACY") throw new Error("A fonte legada deveria ter sido escolhida.");
  assert.strictEqual(selected.data, legacy);
  assert.equal(selected.reason, "awaiting_v2");
  assert.equal(legacyLoadCount, 1);
});

test("publicação V1 ou contrato V2 ainda não aprovado não substitui a fonte legada", async () => {
  const legacy = { sourceType: "MANUAL_UPLOAD", rows: [{ id: "legacy-row", total: 19 }] };
  const selected = await selectNoMovementSource(
    async () => { throw new NoMovementV2LoadError("incompatible", "A publicação vigente usa o contrato V1."); },
    async () => legacy,
  );

  assert.equal(selected.source, "LEGACY");
  if (selected.source !== "LEGACY") throw new Error("A publicação V1 não pode ser usada como V2.");
  assert.strictEqual(selected.data, legacy);
  assert.equal(selected.reason, "awaiting_v2");
  assert.match(selected.v2Error, /contrato V1/);
});

test("usa somente V2 após validar a publicação completa, sem carregar o legado", async () => {
  const snapshot = { publicationId: "v2", rowCount: 0, records: [] };
  let legacyLoadCount = 0;
  const selected = await selectNoMovementSource(
    async () => snapshot,
    async () => { legacyLoadCount += 1; return { sourceType: "MANUAL_UPLOAD" }; },
  );

  assert.equal(selected.source, "V2");
  if (selected.source !== "V2") throw new Error("A publicação V2 validada deveria ser escolhida.");
  assert.strictEqual(selected.data, snapshot);
  assert.equal(legacyLoadCount, 0);
});

test("falha de rede mantém dados anteriores identificados como legados", async () => {
  const legacy = { sourceType: "MANUAL_UPLOAD", rows: [{ id: "legacy-row", total: 23 }] };
  const selected = await selectNoMovementSource(
    async () => { throw new NoMovementV2LoadError("request", "A API V2 está indisponível."); },
    async () => legacy,
  );

  assert.equal(selected.source, "LEGACY");
  if (selected.source !== "LEGACY") throw new Error("A fonte anterior deveria permanecer disponível.");
  assert.strictEqual(selected.data, legacy);
  assert.equal(selected.reason, "v2_unavailable");
  assert.match(selected.v2Error, /API V2 está indisponível/);
});

test("dados V2 incompletos são descartados integralmente e usam a fonte anterior", async () => {
  const legacy = { sourceType: "MANUAL_UPLOAD", rows: [{ id: "legacy-row", total: 29 }] };
  const selected = await selectNoMovementSource(
    async () => { throw new NoMovementV2LoadError("inconsistent", "A paginação V2 ficou incompleta."); },
    async () => legacy,
  );

  assert.equal(selected.source, "LEGACY");
  if (selected.source !== "LEGACY") throw new Error("Dados V2 parciais não podem ser apresentados.");
  assert.strictEqual(selected.data, legacy);
  assert.equal(selected.reason, "v2_invalid");
});

test("se a fonte legada também falhar, não apresenta dados parciais nem mistura fontes", async () => {
  const selected = await selectNoMovementSource(
    async () => { throw new NoMovementV2LoadError("invalid_data", "A publicação V2 é incompatível."); },
    async () => { throw new Error("legacy failure"); },
  );

  assert.equal(selected.source, "LEGACY");
  if (selected.source !== "LEGACY") throw new Error("A contingência deveria permanecer explícita.");
  assert.equal(selected.data, null);
  assert.equal(selected.legacyUnavailable, true);
  assert.equal(selected.reason, "v2_invalid");
});
