import assert from "node:assert/strict";
import test from "node:test";

import {
  loadIndependently,
  publicationHeadChanged,
  publicationRequestPlan,
} from "../src/lib/data-foundation/admin-metadata.ts";

test("metadata sources settle independently when one source times out", async () => {
  const loaded: string[] = [];
  const failed: string[] = [];

  await loadIndependently(
    ["collection_rate", "jt_monitoring", "no_movement"],
    async (source) => {
      if (source === "jt_monitoring") throw new Error("gateway_timeout");
      return `${source}:contract`;
    },
    (source) => loaded.push(source),
    (source) => failed.push(source),
  );

  assert.deepEqual(loaded, ["collection_rate", "no_movement"]);
  assert.deepEqual(failed, ["jt_monitoring"]);
});

test("contract and publication requests can be isolated as separate metadata tasks", async () => {
  const contractResults: string[] = [];
  const publicationFailures: string[] = [];
  const sources = ["jt_monitoring", "no_movement"];

  await Promise.all([
    loadIndependently(
      sources,
      async (source) => `${source}:contract`,
      (_source, contract) => contractResults.push(contract),
      () => assert.fail("contract request should succeed"),
    ),
    loadIndependently(
      sources,
      async (source) => {
        if (source === "jt_monitoring") throw new Error("gateway_timeout");
        return `${source}:publications`;
      },
      () => undefined,
      (source) => publicationFailures.push(source),
    ),
  ]);

  assert.deepEqual(contractResults, ["jt_monitoring:contract", "no_movement:contract"]);
  assert.deepEqual(publicationFailures, ["jt_monitoring"]);
});

test("initial history plan loads details only for the selected source and keeps other source summaries", () => {
  const plan = publicationRequestPlan(
    [
      { source_id: "collection_monitoring" },
      { source_id: "collection_rate" },
      { source_id: "jt_monitoring" },
      { source_id: "no_movement" },
      { source_id: "pdd_collection_failure" },
    ],
    "collection_rate",
  );

  assert.equal(plan.length, 5);
  assert.equal(plan.filter((item) => item.limit === 50).length, 1);
  assert.equal(plan.find((item) => item.source.source_id === "collection_rate")?.limit, 50);
  assert.equal(plan.filter((item) => item.limit === 1).length, 4);
});

test("publication summaries load with bounded concurrency and keep source errors isolated", async () => {
  const loaded: string[] = [];
  const failed: string[] = [];
  let active = 0;
  let maximumActive = 0;

  await loadIndependently(
    ["collection_rate", "jt_monitoring", "no_movement", "pdd_collection_failure"],
    async (source) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      if (source === "jt_monitoring") throw new Error("gateway_timeout");
      return `${source}:latest`;
    },
    (source) => loaded.push(source),
    (source) => failed.push(source),
    2,
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(loaded.sort(), ["collection_rate", "no_movement", "pdd_collection_failure"].sort());
  assert.deepEqual(failed, ["jt_monitoring"]);
});

test("cached detail can be reused only while the latest publication is unchanged", () => {
  const current = {
    publicationId: "publication-a",
    version: 4,
    contractVersion: 2,
    publishedAt: "2026-10-19T10:00:00Z",
    visibleRowCount: 162,
    periodStart: "2026-10-19",
    periodEnd: "2026-10-19",
  };

  assert.equal(publicationHeadChanged(current, { ...current }), false);
  assert.equal(publicationHeadChanged(current, { ...current, publicationId: "publication-b", version: 5 }), true);
  assert.equal(publicationHeadChanged(current, null), true);
  assert.equal(publicationHeadChanged(null, null), false);
});
