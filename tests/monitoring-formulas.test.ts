import assert from "node:assert/strict";
import test from "node:test";

import {
  monitoringAwaitingRate,
  monitoringCollectedVolume,
  monitoringCollectionRate,
} from "../app/lib/monitoring-formulas.ts";

test("reproduces the monitoring workbook formulas", () => {
  const input = { orderVolume: 2_505, awaiting: 849 };
  assert.equal(monitoringCollectedVolume(input), 1_656);
  assert.equal(monitoringCollectionRate(input), (2_505 - 849) / 2_505);
  assert.equal(monitoringAwaitingRate(input), 849 / 2_505);
  assert.equal(monitoringCollectionRate(input) + monitoringAwaitingRate(input), 1);
});

test("handles empty and inconsistent rows safely", () => {
  assert.equal(monitoringCollectionRate({ orderVolume: 0, awaiting: 0 }), 0);
  assert.equal(monitoringAwaitingRate({ orderVolume: 0, awaiting: 10 }), 0);
  assert.equal(monitoringCollectedVolume({ orderVolume: 10, awaiting: 12 }), 0);
});
