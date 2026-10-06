import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTaxaPeriod } from "../src/lib/taxa-summary.ts";

test("calculates the JMS total row after consolidating multiple selected dates", () => {
  const summary = summarizeTaxaPeriod([
    {
      base: "Base A",
      orders: 120,
      toCollect: 100,
      collected: 80,
      notCollected: 20,
      onTime: 75,
      collectedWithAttempts: 90,
    },
    {
      base: "Base B",
      orders: 1_100,
      toCollect: 1_000,
      collected: 950,
      notCollected: 50,
      onTime: 900,
      collectedWithAttempts: 980,
    },
  ]);

  assert.equal(summary.toCollect, 1_100);
  assert.equal(summary.onTime, 975);
  assert.equal(summary.collectedWithAttempts, 1_070);
  assert.equal(summary.onTimeRate, 975 / 1_100);
  assert.equal(summary.collectionWithAttemptsRate, 1_070 / 1_100);
  assert.equal(summary.activeBases, 2);
});

test("uses Qtd a coletar as the denominator instead of rebuilding it", () => {
  const summary = summarizeTaxaPeriod([
    {
      base: "Base A",
      orders: 130,
      toCollect: 100,
      collected: 70,
      notCollected: 20,
      onTime: 60,
      collectedWithAttempts: 80,
    },
  ]);

  assert.equal(summary.toCollect, 100);
  assert.equal(summary.onTimeRate, 0.6);
  assert.equal(summary.collectionWithAttemptsRate, 0.8);
});

test("does not average percentages between bases or dates", () => {
  const summary = summarizeTaxaPeriod([
    {
      base: "Base A",
      orders: 10,
      toCollect: 10,
      collected: 10,
      notCollected: 0,
      onTime: 10,
      collectedWithAttempts: 10,
    },
    {
      base: "Base B",
      orders: 90,
      toCollect: 90,
      collected: 45,
      notCollected: 45,
      onTime: 45,
      collectedWithAttempts: 45,
    },
  ]);

  assert.equal(summary.onTimeRate, 0.55);
  assert.notEqual(summary.onTimeRate, 0.75);
});

test("keeps the JMS weighted rule for 1, 2, 7 or a full month of selected dates", () => {
  const records = Array.from({ length: 31 }, (_, index) => ({
    base: `Base ${index % 3}`,
    orders: 120 + index,
    toCollect: 100 + index,
    collected: 80 + index,
    notCollected: 20,
    onTime: 70 + index,
    collectedWithAttempts: 90 + index,
  }));

  for (const selectedDays of [1, 2, 7, 31]) {
    const selected = records.slice(0, selectedDays);
    const summary = summarizeTaxaPeriod(selected);
    const denominator = selected.reduce((sum, row) => sum + row.toCollect, 0);
    const onTime = selected.reduce((sum, row) => sum + row.onTime, 0);
    const withAttempts = selected.reduce((sum, row) => sum + row.collectedWithAttempts, 0);

    assert.equal(summary.toCollect, denominator);
    assert.equal(summary.onTimeRate, onTime / denominator);
    assert.equal(summary.collectionWithAttemptsRate, withAttempts / denominator);
  }
});
