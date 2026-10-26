import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, repo), "utf8");

test("Sem Movimentação integrates a national-only, copyable bilingual analysis section", async () => {
  const [dashboard, component, backend] = await Promise.all([
    read("src/features/dashboards/dashboard-app.tsx"),
    read("src/features/dashboards/no-movement-operational-analysis.tsx"),
    read("backend/app/api/data_foundation.py"),
  ]);
  assert.match(dashboard, /NoMovementOperationalAnalysis authorization=\{viewerAuthorization\}/);
  assert.match(dashboard, /organizational_scope === "matrix" && viewerIdentity\?\.role === "matrix"/);
  assert.match(component, /navigator\.clipboard\.writeText/);
  assert.match(component, /Histórico/);
  assert.match(component, /PROCESSING/);
  assert.match(component, /FAILED/);
  assert.match(backend, /matrix_scope_required/);
});

test("analysis is scheduled only for a successful new no_movement V2 publication", async () => {
  const backend = await read("backend/app/api/data_foundation.py");
  assert.match(backend, /status\.get\("sourceId"\) == "no_movement" and status\.get\("contractVersion"\) == 2 and not publication\.get\("reused"\)/);
  assert.match(backend, /background_tasks\.add_task\(\s*generate_publication_analysis/s);
});

test("analysis SQL is pinned to publication and map version and sums official stopped_orders", async () => {
  const service = await read("backend/app/services/no_movement_operational_analysis.py");
  assert.match(service, /publication_state = 'PUBLISHED' AND contract_version = 2/);
  assert.match(service, /fact\.publication_id = :publication_id/);
  assert.match(service, /fact\.map_version_id = :map_version_id/);
  assert.match(service, /SUM\(fact\.stopped_orders\)/);
  assert.match(service, /base_mapping_entries AS entry/);
  assert.match(service, /Sem mapeamento/);
});

test("manual export date/time is explicit and the existing Bot metadata remains authoritative", async () => {
  const [admin, parser, translations] = await Promise.all([
    read("src/features/data-foundation/data-foundation-admin.tsx"),
    read("backend/app/services/data_foundation/xlsx_parser.py"),
    read("src/lib/i18n.ts"),
  ]);
  assert.match(admin, /confirmed_export_date/);
  assert.match(admin, /confirmed_export_time/);
  assert.match(parser, /metadata_error == "no_movement_execution_metadata_missing"/);
  assert.match(translations, /manualmente a data e hora da exportação/);
});
