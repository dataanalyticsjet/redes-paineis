import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMovementByRegion,
  aggregateMovementByRm,
  deriveMovementFilterOptions,
  formatMovementRate,
  initialMovementFilterSelections,
  movementFrom2DaysTotal,
  movementSelectionsAfterChange,
  movementWeightedRate,
  selectMovementSummaryMetric,
} from "../src/lib/movement-summary.ts";
import { rmAreaForBase, responsibilityForBase } from "../src/lib/responsibility.ts";

const rows = [
  { region: "SR", rmArea: "SR-SC", rm: "Sean Fan", rgm: "Winta", base: "BNU -SC", totalStopped: 10, quantity: 10, inTransit: 100, over1Day: 4, over2Days: 3, over3Days: 2, over4Days: 1, over5Days: 0, over6Days: 0, over7Days: 0, over10Days: 0, over14Days: 0, over30Days: 0 },
  { region: "SR", rmArea: "SR-RS", rm: "Victor", rgm: "Winta", base: "CQA -RS", totalStopped: 20, quantity: 20, inTransit: 200, over1Day: 8, over2Days: 6, over3Days: 4, over4Days: 2, over5Days: 0, over6Days: 0, over7Days: 0, over10Days: 0, over14Days: 0, over30Days: 0 },
  { region: "PR", rmArea: "Sem região do RM", rm: "Sem RM", rgm: "Sem RGM", base: "UNMAPPED", totalStopped: 0, quantity: 0, inTransit: 300, over1Day: 0, over2Days: 0, over3Days: 0, over4Days: 0, over5Days: 0, over6Days: 0, over7Days: 0, over10Days: 0, over14Days: 0, over30Days: 0 },
];

test("movement filters initialize ALL and retain dependent options after manual selection", () => {
  const all = initialMovementFilterSelections(rows);
  let options = deriveMovementFilterOptions(rows, all);
  assert.deepEqual(options.regions, ["PR", "SR"]);
  assert.deepEqual(options.rmAreas, ["Sem região do RM", "SR-RS", "SR-SC"]);
  assert.equal(all.regions.size, 2);
  assert.equal(all.rmAreas.size, 3);
  assert.equal(options.filteredRows.length, 3);

  const oneRegion = movementSelectionsAfterChange(rows, all, "regions", new Set(["SR"]));
  options = deriveMovementFilterOptions(rows, oneRegion);
  assert.deepEqual(options.rms, ["Sean Fan", "Victor"]);
  assert.deepEqual(options.rmAreas, ["SR-RS", "SR-SC"]);
  assert.equal(options.filteredRows.length, 2);

  const oneRmArea = movementSelectionsAfterChange(rows, oneRegion, "rmAreas", new Set(["SR-SC"]));
  options = deriveMovementFilterOptions(rows, oneRmArea);
  assert.deepEqual(options.rmAreas, ["SR-RS", "SR-SC"]);
  assert.deepEqual(options.filteredRows.map((row) => row.base), ["BNU -SC"]);

  const reset = initialMovementFilterSelections(rows);
  options = deriveMovementFilterOptions(rows, reset);
  assert.equal(options.filteredRows.length, 3);
  assert.equal(reset.regions.size, 2);
});

test("movement RM and regional tables preserve canonical responsibility fields", () => {
  assert.deepEqual(aggregateMovementByRegion(rows).map(({ region, orders }) => [region, orders]), [["SR", 30], ["PR", 0]]);
  assert.deepEqual(aggregateMovementByRm(rows).map(({ rmArea, rm, rgm, orders }) => [rmArea, rm, rgm, orders]), [
    ["SR-RS", "Victor", "Winta", 20],
    ["SR-SC", "Sean Fan", "Winta", 10],
    ["Sem região do RM", "Sem RM", "Sem RGM", 0],
  ]);
});

test("movement aging buckets retain exclusive meanings and weighted rates handle zero denominators", () => {
  const row = rows[0];
  assert.equal(row.over1Day + row.over2Days + row.over3Days + row.over4Days, row.totalStopped);
  assert.equal(movementFrom2DaysTotal(row), 6);
  assert.equal(selectMovementSummaryMetric(row, "from2Days").totalStopped, 6);
  assert.equal(selectMovementSummaryMetric(row, "over14Days").totalStopped, 0);
  assert.equal(formatMovementRate(movementWeightedRate(0, 10), "pt-BR"), "0%");
  assert.equal(formatMovementRate(movementWeightedRate(0, 0), "pt-BR"), "—");
  assert.equal(formatMovementRate(movementWeightedRate(1, 0), "pt-BR"), "—");
  assert.equal(formatMovementRate(movementWeightedRate(1, 2), "pt-BR"), "50%");
});

test("missing official responsibility does not invent RM or RM area", () => {
  const responsibility = responsibilityForBase(null, "UNKNOWN BASE");
  assert.equal(responsibility.rm, "Sem RM");
  assert.equal(responsibility.rgm, "Sem RGM");
  assert.equal(rmAreaForBase(null, "UNKNOWN BASE"), "Sem região do RM");
});
