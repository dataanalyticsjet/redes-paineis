import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, repo), "utf8");

test("Taxa de Coleta AI modal uses the exact authorized and filtered Data Foundation V3 rows", async () => {
  const [dashboard, component, backend] = await Promise.all([
    read("src/features/dashboards/dashboard-app.tsx"),
    read("src/features/dashboards/collection-rate-operational-analysis.tsx"),
    read("backend/app/api/data_foundation.py"),
  ]);
  assert.match(dashboard, /CollectionRateOperationalAnalysis\s+analysis=\{taxaV2OperationalAnalysis\}/);
  assert.match(dashboard, /buildCollectionRateV3OperationalAnalysis\(taxaV2FilteredRows/);
  assert.match(dashboard, /taxaV2AnalysisPeriodIsCurrent/);
  assert.match(dashboard, /view === "taxa" \? \(\s*viewerIdentity\?\.organizational_scope === "matrix" && viewerIdentity\?\.role === "matrix"/);
  assert.match(dashboard, /view !== "movimentacao" && view !== "taxa"/);
  assert.match(component, /navigator\.clipboard\.writeText\(analysis\.message\)/);
  assert.match(component, /analysis\?\.message\.split/);
  assert.match(component, /Taxa de Tentativa/);
  assert.doesNotMatch(component, /collection-rate\/operational-analysis\?limit=20/);
  assert.doesNotMatch(component, /Histórico de análises/);
  const synthesis = await read("src/lib/data-foundation/collection-rate-v3-operational-analysis.ts");
  assert.match(synthesis, /collected_plus_attempts_quantity/);
  assert.match(synthesis, /quantity_to_collect/);
  assert.match(synthesis, /targetRate: null/);
  assert.doesNotMatch(synthesis, /98%|TARGET_RATE/);
  assert.match(backend, /@router\.get\("\/collection-rate\/operational-analysis"\)/);
  assert.match(backend, /matrix_scope_required/);
});

test("new analysis is scheduled only after a new successful collection_rate V3 publication", async () => {
  const backend = await read("backend/app/api/data_foundation.py");
  assert.match(backend, /status\.get\("sourceId"\) == "collection_rate" and status\.get\("contractVersion"\) == 3 and not publication\.get\("reused"\)/);
  assert.match(backend, /background_tasks\.add_task\(\s*generate_collection_rate_operational_analysis/s);
  assert.match(backend, /publication_id=str\(publication\["publicationId"\]\)/);
});

test("collection-rate analysis remains separate, pinned to V3 publication and DoomsDay, and uses official aggregation fields", async () => {
  const [service, sql] = await Promise.all([
    read("backend/app/services/collection_rate_operational_analysis.py"),
    read("backend/sql/collection-rate-operational-analysis-review.sql"),
  ]);
  assert.match(service, /FROM fact_collection_rate_v3 AS fact/);
  assert.match(service, /publication_state='PUBLISHED' AND contract_version=:contract_version/);
  assert.match(service, /fact\.publication_id=:publication_id/);
  assert.match(service, /fact\.map_version_id=:map_version_id/);
  assert.match(service, /MAX\(publication_date\.data_date\)/);
  assert.match(service, /SUM\(fact\.collected_quantity\)/);
  assert.match(service, /SUM\(fact\.quantity_to_collect\)/);
  assert.match(service, /entry\.map_version_id=fact\.map_version_id/);
  assert.match(service, /fact\.mapping_resolution = 'NAME_APPROVED'/);
  assert.match(sql, /CREATE TABLE collection_rate_operational_analyses/);
  assert.match(sql, /UNIQUE KEY uq_collection_rate_analysis_publication_rules/);
  assert.match(sql, /REFERENCES source_publications\(source_id, publication_id, map_version_id\)/);
  assert.match(sql, /Manual-review SQL only/);
});

test("new states and empty-history messages have translations in English and Chinese", async () => {
  const translations = await read("src/lib/i18n.ts");
  assert.match(translations, /Ainda não há análise para uma publicação de Taxa de Coleta/);
  assert.match(translations, /collection_rate_analysis_unavailable/);
  assert.match(translations, /collection_rate_analysis_copy_failed/);
  assert.match(translations, /Coletado \/ previsto/);
  assert.match(translations, /Taxa nacional/);
});

test("Sem Movimentação keeps its existing persisted analysis component and modal path", async () => {
  const dashboard = await read("src/features/dashboards/dashboard-app.tsx");
  assert.match(dashboard, /view === "movimentacao" \? \(\s*viewerIdentity\?\.organizational_scope === "matrix" && viewerIdentity\?\.role === "matrix"/);
  assert.match(dashboard, /NoMovementOperationalAnalysis authorization=\{viewerAuthorization\}/);
});
