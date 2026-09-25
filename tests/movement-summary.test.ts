import assert from "node:assert/strict";
import test from "node:test";
import { selectMovementSummaryMetric } from "../app/lib/movement-summary.ts";

const source = Object.freeze({
  totalStopped: 14387, quantity: 14387, inTransit: 42181,
  over1Day: 9725, over2Days: 1541, over3Days: 833, over4Days: 0,
  over5Days: 48, over6Days: 127, over7Days: 443, over10Days: 238,
  over14Days: 1044, over30Days: 388,
});

test("summary defaults to the complete report total, including the one-day band", () => {
  assert.equal(selectMovementSummaryMetric(source, "totalStopped").quantity, 14387);
  assert.equal(selectMovementSummaryMetric(source, "from2Days").quantity, 4662);
});

test("aging selection keeps totals consistent without mutating source or transit volume", () => {
  const selected = selectMovementSummaryMetric(source, "over14Days");
  assert.equal(selected.totalStopped, 1044);
  assert.equal(selected.quantity, 1044);
  assert.equal(selected.over1Day, 0);
  assert.equal(selected.over14Days, 1044);
  assert.equal(selected.inTransit, 42181);
  assert.equal(source.over1Day, 9725);
  assert.equal(selectMovementSummaryMetric(source, "totalStopped").totalStopped, 14387);
});
