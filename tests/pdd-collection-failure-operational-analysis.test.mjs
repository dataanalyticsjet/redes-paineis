import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, repo), "utf8");

test("PDD shell keeps header, action buttons and filters visible while only results show the skeleton", async () => {
  const dashboard = await read("src/features/dashboards/dashboard-app.tsx");
  assert.match(dashboard, /PddCollectionFailureOperationalAnalysis/);
  assert.match(dashboard, /<DashboardActionBand/);
  assert.match(dashboard, /Filtros operacionais/);
  assert.match(dashboard, /DashboardLoadingSkeleton t=\{t\} message=/);
  assert.match(dashboard, /data-testid="pdd-collection-failure-v2-dashboard"/);
  assert.match(dashboard, /status === "loading" \|\| status === "idle"\) && !hasData/);
});

test("PDD AI modal loads persisted publication history and supports retry and copy", async () => {
  const [dashboard, component, api] = await Promise.all([
    read("src/features/dashboards/dashboard-app.tsx"),
    read("src/features/dashboards/pdd-collection-failure-operational-analysis.tsx"),
    read("backend/app/api/data_foundation.py"),
  ]);
  assert.match(dashboard, /PddCollectionFailureOperationalAnalysis authorization=\{viewerAuthorization\}/);
  assert.match(component, /pdd-collection-failure\/operational-analysis\?limit=20/);
  assert.match(component, /navigator\.clipboard\.writeText\(selected\.message\)/);
  assert.match(component, /Histórico de análises/);
  assert.match(api, /@router\.get\("\/pdd-collection-failure\/operational-analysis"\)/);
  assert.match(api, /matrix_scope_required/);
});

test("PDD analysis service uses the published PDD fields and publication-pinned mapping", async () => {
  const service = await read("backend/app/services/pdd_collection_failure_operational_analysis.py");
  assert.match(service, /SUM\(fact\.orders_unscanned_at_collection\)/);
  assert.match(service, /SUM\(fact\.total_orders\)/);
  assert.match(service, /fact\.publication_id=:publication_id/);
  assert.match(service, /fact\.map_version_id=:map_version_id/);
  assert.match(service, /MAX\(pd\.data_date\)/);
  assert.match(service, /entry\.map_version_id=fact\.map_version_id/);
  assert.match(service, /BASE_LIMIT = 8/);
});

test("PDD analysis table is a manual-review artifact only", async () => {
  const sql = await read("backend/sql/pdd-collection-failure-operational-analysis-review.sql");
  assert.match(sql, /CREATE TABLE pdd_collection_failure_operational_analyses/);
  assert.match(sql, /UNIQUE KEY uq_pdd_failure_analysis_publication_rules/);
  assert.match(sql, /Manual-review SQL only/);
});
