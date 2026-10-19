import assert from "node:assert/strict";
import test from "node:test";
import { organizationalRegionLabel } from "../src/lib/organizational-region.ts";

test("resolved organizational region is shown", () => {
  assert.equal(organizationalRegionLabel(" SPN ", "RESOLVED", "Regional não identificada"), "SPN");
});

test("a stale regional label is hidden after a Feishu sync failure", () => {
  assert.equal(organizationalRegionLabel("PR", "SYNC_FAILED", "Regional não identificada"), "Regional não identificada");
  assert.equal(organizationalRegionLabel("PR", "SYNC_FAILED", "Regional não identificada", "feishu"), "Regional não identificada");
  assert.equal(organizationalRegionLabel("PR", "SYNC_FAILED", "Regional não identificada", "none"), "Regional não identificada");
});

test("unknown and ambiguous profiles never fall back to access region", () => {
  assert.equal(organizationalRegionLabel(null, "UNKNOWN", "Regional não identificada"), "Regional não identificada");
  assert.equal(organizationalRegionLabel(null, "AMBIGUOUS", "Regional não identificada"), "Regional não identificada");
  assert.equal(organizationalRegionLabel("SPS", "UNKNOWN", "Regional não identificada"), "Regional não identificada");
});
