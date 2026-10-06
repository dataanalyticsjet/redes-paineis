import assert from "node:assert/strict";
import test from "node:test";

import { mergeTaxaHistory } from "../src/lib/taxa-history.ts";
import { parseTabularData } from "../src/lib/workbook.ts";

const headers = [
  "Horário de término do prazo de coleta",
  "Nome da regional",
  "Nome da base de coleta",
  "Qtd a coletar",
];

function workbook(rows: unknown[][]) {
  return parseTabularData([headers, ...rows], { sheetName: "sheet0" });
}

test("preserves historical dates and replaces only dates present in a new daily upload", () => {
  const historical = workbook([
    ["2026-01-31", "SPE", "Base A", 100],
    ["2026-08-19", "SPE", "Base A", 200],
  ]);
  const daily = workbook([
    ["2026-08-19", "SPE", "Base A", 250],
    ["2026-08-20", "RJ", "Base B", 300],
  ]);
  const result = mergeTaxaHistory(historical, [daily]);

  assert.equal(result.addedDates, 1);
  assert.equal(result.replacedDates, 1);
  assert.equal(result.totalDates, 3);
  assert.deepEqual(result.parsed.rows.map((row) => row[headers[0]]), ["2026-01-31", "2026-08-19", "2026-08-20"]);
  assert.equal(result.parsed.rows[1][headers[3]], 250);
});

test("accepts two initial files and lets the later workbook replace overlapping dates", () => {
  const januaryToJuly = workbook([
    ["2026-01-31", "SPE", "Base A", 100],
    ["2026-07-31", "SPE", "Base A", 180],
  ]);
  const august = workbook([
    ["2026-07-31", "SPE", "Base A", 180],
    ["2026-08-19", "RJ", "Base B", 220],
  ]);
  const result = mergeTaxaHistory(null, [januaryToJuly, august]);

  assert.equal(result.totalDates, 3);
  assert.equal(result.totalRows, 3);
  assert.deepEqual(result.parsed.metadata.dateRange, { min: "2026-01-31", max: "2026-08-19" });
});

test("preserves identical source rows because each row contributes to the JMS totals", () => {
  const daily = workbook([
    ["2026-08-21", "SPE", "Base A", 100],
    ["2026-08-21", "SPE", "Base A", 100],
  ]);

  const result = mergeTaxaHistory(null, [daily]);

  assert.equal(result.totalRows, 2);
  assert.equal(result.parsed.rows.reduce((sum, row) => sum + Number(row[headers[3]]), 0), 200);
});

test("does not double count an overlapping date when two files are selected together", () => {
  const first = workbook([
    ["2026-08-21", "SPE", "Base A", 100],
    ["2026-08-22", "SPE", "Base A", 200],
  ]);
  const refreshed = workbook([
    ["2026-08-21", "SPE", "Base A", 150],
  ]);

  const result = mergeTaxaHistory(null, [first, refreshed]);

  assert.equal(result.totalRows, 2);
  assert.deepEqual(
    result.parsed.rows.map((row) => [row[headers[0]], row[headers[3]]]),
    [["2026-08-21", 150], ["2026-08-22", 200]],
  );
});

test("rejects files with incompatible columns", () => {
  const valid = workbook([["2026-01-31", "SPE", "Base A", 100]]);
  const incompatible = parseTabularData([
    ["Horário de término do prazo de coleta", "Nome da regional", "Outra coluna"],
    ["2026-02-28", "SPE", 1],
  ]);

  assert.throws(() => mergeTaxaHistory(valid, [incompatible]), /mesmas colunas/);
});
