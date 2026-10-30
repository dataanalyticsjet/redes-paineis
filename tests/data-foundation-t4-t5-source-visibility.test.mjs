import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminSource = await readFile(new URL("../src/features/data-foundation/data-foundation-admin.tsx", import.meta.url), "utf8");

test("Central de Dados hides only the legacy J&T duplicate card", () => {
  assert.match(adminSource, /HIDDEN_DUPLICATE_CENTRAL_SOURCE_IDS\s*=\s*new Set\(\["jt_monitoring"\]\)/);
  assert.match(adminSource, /source\.source_id !== "base_mapping_official"\s*&&\s*!HIDDEN_DUPLICATE_CENTRAL_SOURCE_IDS\.has\(source\.source_id\)/);
  assert.match(adminSource, /collection_monitoring_t4_t5/);
  assert.doesNotMatch(adminSource, /DELETE\s+FROM|DROP\s+TABLE/i);
});
