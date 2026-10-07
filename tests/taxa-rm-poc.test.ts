import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTaxaRmPoc } from "../src/lib/taxa-rm-poc.ts";
import { buildResponsibilityData, resolveResponsibilityForBase, UNASSIGNED_RM_AREA } from "../src/lib/responsibility.ts";
import type { ParsedWorkbook } from "../src/lib/workbook.ts";

function parsedWorkbook(headers: string[], rows: Record<string, string>[]): ParsedWorkbook {
  return {
    sheetName: "Ativas",
    headers,
    rows,
    statusColumns: [],
    metadata: {
      sheetNames: ["Ativas"],
      headerRow: 1,
      rowCount: rows.length,
      columnCount: headers.length,
      columns: [],
      date1904: false,
    },
    warnings: [],
  };
}

test("Taxa RM aggregation preserves official RM areas and legacy rows", () => {
  const headers = ["Regional", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"];
  const responsibility = buildResponsibilityData(parsedWorkbook(headers, [
    { Regional: "CE", "Região RM": "Região A", "Responsável Rm": "RM A", "Código da base": "1", "Nome da base": "Base A", Descrição: "teste" },
    { Regional: "MG", "Região RM": "Região B", "Responsável Rm": "RM B", "Código da base": "2", "Nome da base": "Base B", Descrição: "teste" },
  ]), "de-para-fixture.xlsx");
  const dates = ["2026-10-06"];
  const legacy = resolveResponsibilityForBase(null, "CARAP-SP");
  assert.equal(legacy.source, "legado");
  const rows = aggregateTaxaRmPoc([
    { date: dates[0], region: "CE", base: "Base A", orders: 100, toCollect: 80, collectedWithAttempts: 76 },
    { date: dates[0], region: "MG", base: "Base B", orders: 200, toCollect: 160, collectedWithAttempts: 152 },
    { date: dates[0], region: "RJ", base: "CARAP-SP", orders: 300, toCollect: 240, collectedWithAttempts: 228 },
  ], dates, responsibility, "pt-BR");

  const byArea = new Map(rows.map((row) => [row.rmArea, row]));
  assert.deepEqual(
    [byArea.get("Região A")?.rmArea, byArea.get("Região A")?.rm, byArea.get("Região A")?.rgm],
    ["Região A", "RM A", "@彭龙颂 LONGSONG PENG（Lucas）"],
  );
  assert.deepEqual(
    [byArea.get("Região B")?.rmArea, byArea.get("Região B")?.rm, byArea.get("Região B")?.rgm],
    ["Região B", "RM B", "@王龙 LONG WANG（Matt）"],
  );
  assert.equal(byArea.get(UNASSIGNED_RM_AREA)?.rm, legacy.rm);
  assert.equal(byArea.get(UNASSIGNED_RM_AREA)?.rgm, "@毕富有 FUYOU BI（Jason）");
  assert.equal(rows.length, 3);
});
