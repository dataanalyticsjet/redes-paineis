import assert from "node:assert/strict";
import test from "node:test";

import { buildT4T5ImportProgressView } from "../src/lib/data-foundation/t4t5-import-progress.ts";

test("validation progress shows analyzed rows without claiming database writes", () => {
  assert.deepEqual(buildT4T5ImportProgressView({
    phase: "VALIDATION",
    inputRowCount: 30_000,
    validRowCount: 0,
  }), {
    phaseLabel: "Validação do arquivo",
    analyzedRowCount: 30_000,
    writtenRowCount: null,
    committedRowCount: null,
    totalExpectedRowCount: null,
    progressPercent: null,
  });
});

test("publication progress separates analyzed, written, committed, and expected rows", () => {
  assert.deepEqual(buildT4T5ImportProgressView({
    phase: "PUBLICATION",
    inputRowCount: 49_000,
    analyzedRowCount: 50_000,
    writtenRowCount: 45_000,
    committedRowCount: 45_000,
    totalExpectedRowCount: 789_522,
  }), {
    phaseLabel: "Publicação",
    analyzedRowCount: 50_000,
    writtenRowCount: 45_000,
    committedRowCount: 45_000,
    totalExpectedRowCount: 789_522,
    progressPercent: (45_000 / 789_522) * 100,
  });
});

test("publication progress handles zero and clamps inconsistent counters", () => {
  assert.equal(buildT4T5ImportProgressView({
    phase: "PUBLICATION",
    writtenRowCount: 0,
    committedRowCount: 0,
    totalExpectedRowCount: 0,
  }).progressPercent, null);
  assert.equal(buildT4T5ImportProgressView({
    phase: "PUBLICATION",
    committedRowCount: 12,
    totalExpectedRowCount: 10,
  }).progressPercent, 100);
});

test("older publication responses do not treat analyzed input as committed writes", () => {
  const view = buildT4T5ImportProgressView({
    phase: "PUBLICATION",
    inputRowCount: 49_000,
    totalExpectedRowCount: 100_000,
  });
  assert.equal(view.analyzedRowCount, 0);
  assert.equal(view.writtenRowCount, null);
  assert.equal(view.committedRowCount, null);
  assert.equal(view.progressPercent, null);
});

test("unknown stages do not present stale counters as validation progress", () => {
  assert.deepEqual(buildT4T5ImportProgressView({
    inputRowCount: 49_000,
    validRowCount: 789_522,
  }), {
    phaseLabel: "Etapa indisponível",
    analyzedRowCount: 0,
    writtenRowCount: null,
    committedRowCount: null,
    totalExpectedRowCount: null,
    progressPercent: null,
  });
});
