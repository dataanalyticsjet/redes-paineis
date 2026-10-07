import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTaxaRate,
  legacyTaxaAverageCollectionHours,
  summarizeTaxaByMonth,
  summarizeTaxaPeriod,
  taxaRate,
} from "../src/lib/taxa-summary.ts";

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

const validatedOctoberDays = [
  { date: "2026-10-01", orders: 1_379_925, toCollect: 1_152_779, onTime: 1_064_609, collectedWithAttempts: 1_139_466, notCollected: 6_329 },
  { date: "2026-10-02", orders: 1_522_155, toCollect: 1_275_605, onTime: 1_218_261, collectedWithAttempts: 1_269_062, notCollected: 12_771 },
  { date: "2026-10-03", orders: 1_489_943, toCollect: 1_249_010, onTime: 1_147_158, collectedWithAttempts: 1_237_210, notCollected: 100_346 },
  { date: "2026-10-04", orders: 1_048_917, toCollect: 919_269, onTime: 737_534, collectedWithAttempts: 884_013, notCollected: 179_968 },
  { date: "2026-10-05", orders: 1_045_004, toCollect: 906_527, onTime: 635_075, collectedWithAttempts: 861_404, notCollected: 269_304 },
];

test("matches validated aggregate totals from the supplied Taxa workbook", () => {
  const summary = summarizeTaxaPeriod(validatedOctoberDays.map((day) => ({
    ...day,
    collected: day.orders - day.notCollected,
    base: day.date,
  })));

  assert.equal(summary.orders, 6_485_944);
  assert.equal(summary.toCollect, 5_503_190);
  assert.equal(summary.onTime, 4_802_637);
  assert.equal(summary.collectionWithAttemptsRate, 5_391_155 / 5_503_190);
  assert.equal(summary.onTimeRate, 4_802_637 / 5_503_190);
  assert.equal(summary.awaitingRate, 568_718 / 5_503_190);
  assert.equal(summary.collectedWithAttempts, 5_391_155);
  assert.equal(summary.notCollected, 568_718);
  assert.equal(summary.activeBases, 5);
});

test("keeps the validated per-day totals and calculates each daily rate from sums", () => {
  const months = summarizeTaxaByMonth(validatedOctoberDays.map((day) => ({
    date: day.date,
    toCollect: day.toCollect,
    onTime: day.onTime,
    collectedWithAttempts: day.collectedWithAttempts,
  })));

  assert.equal(months.length, 1);
  assert.equal(months[0].monthKey, "2026-10");
  assert.equal(months[0].toCollect, 5_503_190);
  assert.equal(months[0].onTime, 4_802_637);
  assert.equal(months[0].collectedWithAttempts, 5_391_155);
  assert.equal(months[0].onTimeRate, 4_802_637 / 5_503_190);
  assert.equal(months[0].attemptRate, 5_391_155 / 5_503_190);
  assert.deepEqual(validatedOctoberDays.map((day) => day.orders), [1_379_925, 1_522_155, 1_489_943, 1_048_917, 1_045_004]);
  assert.deepEqual(validatedOctoberDays.map((day) => day.notCollected), [6_329, 12_771, 100_346, 179_968, 269_304]);
});

test("preserves a missing rate separately from a true zero percent", () => {
  assert.equal(taxaRate(0, 0), null);
  assert.equal(formatTaxaRate(taxaRate(0, 0)), "—");
  assert.equal(taxaRate(0, 100), 0);
  assert.equal(formatTaxaRate(taxaRate(0, 100)), "0%");
});

test("monthly trend groups by year and month across selected years and keeps regional rows", () => {
  const months = summarizeTaxaByMonth([
    { date: "2025-12-31", toCollect: 100, onTime: 80, collectedWithAttempts: 90 },
    { date: "2026-01-01", toCollect: 200, onTime: 100, collectedWithAttempts: 180 },
    { date: "2026-01-02", toCollect: 300, onTime: 250, collectedWithAttempts: 300 },
    { date: "2026-01-03", toCollect: 0, onTime: 0, collectedWithAttempts: 0 },
  ]);

  assert.deepEqual(months.map((month) => month.monthKey), ["2025-12", "2026-01"]);
  assert.equal(months[0].onTimeRate, 0.8);
  assert.equal(months[1].toCollect, 500);
  assert.equal(months[1].onTimeRate, 350 / 500);
  assert.equal(months[1].attemptRate, 480 / 500);
});

test("keeps the existing average-duration aggregation isolated and marked unvalidated", () => {
  // Compatibility test only: this existing weighting is not confirmed as the official source formula.
  assert.equal(legacyTaxaAverageCollectionHours([
    { toCollect: 100, collected: 80, averageCollectionHours: 2 },
    { toCollect: 50, collected: 70, averageCollectionHours: 8 },
  ]), (2 * 100 + 8 * 70) / 170);
});
