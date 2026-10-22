import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  formatNoMovementSourceCell,
  mapNoMovementV2Record,
  noMovementSourceColumnKind,
  noMovementSourceExcelNumberFormat,
  noMovementSourceExcelValue,
  NO_MOVEMENT_SOURCE_COLUMN_KINDS,
  NO_MOVEMENT_SOURCE_HEADERS,
  noMovementAvailabilityMessage,
} from "../src/lib/data-foundation/no-movement-dashboard.ts";
import { NO_MOVEMENT_V2_COLUMNS } from "../src/lib/data-foundation/no-movement.ts";
import { summarizeMovementSnapshot } from "../src/lib/movement-summary.ts";

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
  assert.equal(first.inTransit, 900);
  assert.equal(summarizeMovementSnapshot([first]).inTransit, 900);
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

test("quantidades são formatadas por tipo de coluna e não confundidas com seriais de data", () => {
  const transit = NO_MOVEMENT_SOURCE_HEADERS.orders_in_transit;

  assert.equal(formatNoMovementSourceCell(40_185, transit, "pt-BR"), "40.185");
  assert.equal(formatNoMovementSourceCell(40_185, transit, "en-US"), "40,185");
  assert.equal(formatNoMovementSourceCell(40_185, transit, "zh-CN"), "40,185");
  assert.equal(formatNoMovementSourceCell(0, transit, "pt-BR"), "0");
  assert.equal(formatNoMovementSourceCell(1_234_567, transit, "pt-BR"), "1.234.567");
  assert.equal(formatNoMovementSourceCell(40_185, NO_MOVEMENT_SOURCE_HEADERS.source_base_code, "pt-BR"), "40185");
  assert.equal(formatNoMovementSourceCell(40_185, NO_MOVEMENT_SOURCE_HEADERS.last_operation_at, "pt-BR"), "07/01/2010, 00:00");
  assert.equal(formatNoMovementSourceCell("2026-10-14 14:25:00", NO_MOVEMENT_SOURCE_HEADERS.last_operation_at, "pt-BR"), "2026-10-14 14:25:00");
});

test("classificação tipada cobre exatamente as 18 colunas oficiais", () => {
  const headers = Object.values(NO_MOVEMENT_SOURCE_HEADERS);
  assert.equal(headers.length, 18);
  assert.equal(Object.keys(NO_MOVEMENT_SOURCE_COLUMN_KINDS).length, 18);
  assert.deepEqual(Object.keys(NO_MOVEMENT_SOURCE_HEADERS), NO_MOVEMENT_V2_COLUMNS);
  assert.deepEqual(headers.map(noMovementSourceColumnKind), [
    "text", "text", "text", "quantity", "quantity", "quantity", "quantity", "quantity", "quantity",
    "quantity", "quantity", "quantity", "quantity", "quantity", "quantity", "datetime", "percentage", "percentage",
  ]);
});

test("exportação mantém quantidades numéricas e aplica formato inteiro na coluna", async () => {
  const header = NO_MOVEMENT_SOURCE_HEADERS.orders_in_transit;
  const exportedValue = noMovementSourceExcelValue("40185", header);
  const worksheet = XLSX.utils.aoa_to_sheet([[header], [exportedValue]]);
  const cell = worksheet.A2;
  assert.equal(cell.t, "n");
  assert.equal(cell.v, 40_185);
  assert.equal(noMovementSourceExcelNumberFormat(header), "#,##0");
  assert.equal(noMovementSourceExcelNumberFormat(NO_MOVEMENT_SOURCE_HEADERS.last_operation_at), "dd/mm/yyyy hh:mm");
  assert.equal(noMovementSourceExcelNumberFormat(NO_MOVEMENT_SOURCE_HEADERS.stopped_14_plus_days_rate), "0.0%");

  const mappingSource = await readFile(new URL("../src/lib/data-foundation/no-movement-dashboard.ts", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  assert.match(mappingSource, /inTransit: numericValue\(record\.orders_in_transit\)/);
  assert.match(appSource, /formatCompact\(movementSummary\.inTransit\)/);
  assert.match(appSource, /noMovementSourceExcelValue\(row\.values\[column\], column\)/);
  assert.match(appSource, /movementLoaded\.displayColumns\.map\(noMovementSourceExcelNumberFormat\)/);
});
