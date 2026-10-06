import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaxaMonthlyRegionalSeries,
  isExcludedMonthlyRegion,
  type TaxaMonthlyRecord,
} from "../src/lib/taxa-monthly.ts";

const records: TaxaMonthlyRecord[] = [
  { date: "2026-01-02", region: "SPE", toCollect: 100, collectedWithAttempts: 90 },
  { date: "2026-01-20", region: "SPE", toCollect: 900, collectedWithAttempts: 900 },
  { date: "2026-02-15", region: "SPE", toCollect: 200, collectedWithAttempts: 196 },
  { date: "2026-01-10", region: "RJ", toCollect: 50, collectedWithAttempts: 49 },
  { date: "2026-02-10", region: "Bahia", toCollect: 80, collectedWithAttempts: 80 },
  { date: "2026-02-10", region: "Sem regional", toCollect: 25, collectedWithAttempts: 20 },
];

test("builds a weighted closed result for each month and regional", () => {
  const result = buildTaxaMonthlyRegionalSeries(records);

  assert.deepEqual(result.months, ["2026-01", "2026-02"]);
  assert.deepEqual(result.regions.map((series) => series.region), ["RJ", "SPE"]);

  const spe = result.regions.find((series) => series.region === "SPE");
  assert.ok(spe);
  assert.equal(spe.points[0].rate, 0.99);
  assert.equal(spe.points[1].rate, 0.98);
  assert.equal(spe.totalToCollect, 1200);
  assert.equal(spe.latestRate, 0.98);
});

test("keeps missing regional months empty instead of treating them as zero", () => {
  const result = buildTaxaMonthlyRegionalSeries(records);
  const rj = result.regions.find((series) => series.region === "RJ");

  assert.ok(rj);
  assert.equal(rj.points[0].rate, 0.98);
  assert.equal(rj.points[1].rate, null);
  assert.equal(rj.latestRate, 0.98);
});

test("excludes Bahia and Sem regional regardless of accents or casing", () => {
  assert.equal(isExcludedMonthlyRegion("Bahia"), true);
  assert.equal(isExcludedMonthlyRegion("  BAHIA "), true);
  assert.equal(isExcludedMonthlyRegion("Sem Regional"), true);
  assert.equal(isExcludedMonthlyRegion("São Paulo"), false);
});
