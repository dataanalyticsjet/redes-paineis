import assert from "node:assert/strict";
import test from "node:test";
import { MOVEMENT_REQUIRED_FIELDS, normalizeMovementWorkbook } from "../src/lib/data-sources/movement.ts";
import { translateDashboardText } from "../src/lib/i18n.ts";
import type { ParsedWorkbook } from "../src/lib/workbook.ts";

function workbook(headers: string[] = [...MOVEMENT_REQUIRED_FIELDS]): ParsedWorkbook {
  const row: Record<string, unknown> = Object.fromEntries(headers.map((header) => [header, 0]));
  row["Regional responsável"] = "PR";
  row["Código da unidade responsável"] = "BNU1";
  row["Nome da unidade responsável"] = "BNU -SC";
  row["Total de pedidos sem movimentação"] = "1234";
  row["Qtd pedidos em trânsito"] = "8765";
  row["Sem mov. há mais de 14 dias"] = "125";
  row["Taxa de sem mov 14+dias"] = "12,5%";
  row["Horário da última operação"] = "06/10/2026 09:15";
  return {
    sheetName: "sheet0",
    headers,
    rows: [row],
    dateColumn: "Horário da última operação",
    baseColumn: "Nome da unidade responsável",
    regionColumn: "Regional responsável",
    originColumn: undefined,
    statusColumns: [],
    metadata: {
      sheetNames: ["sheet0"],
      headerRow: 1,
      rowCount: 1,
      columnCount: headers.length,
      columns: [],
      date1904: false,
      dateRange: { min: "2026-10-06", max: "2026-10-06" },
    },
    warnings: [],
  };
}

test("movement adapter uses the complete 18-column snapshot contract and never treats last operation as date", () => {
  const parsed = normalizeMovementWorkbook(workbook());
  assert.equal(MOVEMENT_REQUIRED_FIELDS.length, 18);
  assert.equal(parsed.headers.length, 18);
  assert.equal(parsed.metadata.rowCount, 1);
  assert.equal(parsed.metadata.columnCount, 18);
  assert.equal(parsed.dateColumn, undefined);
  assert.equal(parsed.metadata.dateRange, undefined);
  assert.equal(parsed.regionColumn, "Regional responsável");
  assert.equal(parsed.baseColumn, "Nome da unidade responsável");
  assert.equal(parsed.rows[0]["Total de pedidos sem movimentação"], 1234);
  assert.equal(parsed.rows[0]["Qtd pedidos em trânsito"], 8765);
  assert.equal(parsed.rows[0]["Sem mov. há mais de 14 dias"], 125);
  assert.equal(parsed.rows[0]["Taxa de sem mov 14+dias"], 0.125);
});

test("movement adapter rejects workbooks without the exact required columns", () => {
  assert.throws(
    () => normalizeMovementWorkbook(workbook([...MOVEMENT_REQUIRED_FIELDS].slice(1))),
    { message: "data_source_movement_required_columns_missing" },
  );
});

test("movement panel labels and every source column have PT, EN and Simplified Chinese text", () => {
  const labels = [
    ...MOVEMENT_REQUIRED_FIELDS,
    "Sem movimentação",
    "Todas as regionais",
    "Todos os RM",
    "Todas as regiões do RM",
    "Todas as bases",
    "Todos os RGM",
    "Indicador / AGING",
    "Sem movimentação por regional",
    "Sem movimentação por RM",
    "Dados por base",
  ];
  for (const label of labels) {
    assert.notEqual(translateDashboardText("en", label), label, `missing EN translation: ${label}`);
    assert.notEqual(translateDashboardText("zh", label), label, `missing ZH translation: ${label}`);
  }
});
