import assert from "node:assert/strict";
import test from "node:test";

import { loadIndependently } from "../src/lib/data-foundation/admin-metadata.ts";

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
