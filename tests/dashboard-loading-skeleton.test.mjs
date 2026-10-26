import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("../src/features/dashboards/dashboard-loading-skeleton.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const dashboards = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const monitoring = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url), "utf8");
const collectionRateLoader = await readFile(new URL("../src/lib/data-foundation/collection-rate-v3.ts", import.meta.url), "utf8");
const translations = await readFile(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");

test("loading shared shows percent only from a measurable total and supports indeterminate state", () => {
  assert.match(component, /progress\.total > 0/);
  assert.match(component, /Math\.max\(0, progress!\.loaded\) \/ progress!\.total/);
  assert.match(component, /measuredPercent !== null \? <strong/);
  assert.match(component, /is-indeterminate/);
  assert.match(component, /loaded: number/);
  assert.match(component, /total: number/);
  assert.match(component, /window\.setTimeout\(\(\) => setVisible\(true\), 180\)/);
});

test("loading shared exposes accessible status, retry, stale-data label, and responsive motion-safe skeletons", () => {
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /onRetry/);
  assert.match(component, /previousDataLabel/);
  assert.match(component, /dashboard-loading-kpis/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(translations, /"Atualizando os dados do dashboard…": \{ en: "Updating dashboard data…", zh:/);
  assert.match(translations, /"Exibindo dados anteriores: \{period\}": \{ en: "Showing previous data: \{period\}", zh:/);
});

test("all four dashboards share the loading experience without showing stale data as current", () => {
  assert.match(monitoring, /loadedScope === scopeKey && rows\.length > 0/);
  assert.match(dashboards, /<CollectionMonitoringV2Dashboard key=\{dashboardCacheIdentity\}/);
  assert.match(dashboards, /current\.identityKey === dashboardCacheIdentity \? current\.records : \[\]/);
  assert.match(dashboards, /pddDataAuthorized \? pddCollectionFailureV2State\.records : \[\]/);
  assert.match(dashboards, /hasPreviousData = hasData && \(status === "loading" \|\| status === "error"\)/);
  assert.match(dashboards, /taxaV2HasPreviousData = \(collectionRateV2State\.status === "loading" \|\| collectionRateV2State\.status === "error"\)/);
  assert.match(dashboards, /previousDataLabel=\{`\$\{collectionRateV2State\.loadedPeriod/);
  assert.match(dashboards, /loadPublishedCollectionRateV3\(\{ dateFrom, dateTo \}, cacheFetcher, signal, \(progress\)/);
  assert.match(collectionRateLoader, /onProgress\?\.\(\{ loaded: records\.length, total: expectedCount, stage: "records" \}\)/);
  assert.match(collectionRateLoader, /onProgress\?\.\(\{ loaded: 0, total: 0, stage: "validation" \}\)/);
  assert.match(dashboards, /retryKey: current\.retryKey \+ 1/);
  assert.match(dashboards, /current\.period\.dateFrom !== dateFrom \|\| current\.period\.dateTo < dateFrom \? "loading" : current\.status/);
  const taxaEffectStart = dashboards.indexOf('if (view !== "taxa") return undefined;');
  const taxaEffectEnd = dashboards.indexOf("}, [collectionRateV2State.period.dateFrom", taxaEffectStart);
  const taxaEffect = dashboards.slice(taxaEffectStart, taxaEffectEnd);
  assert.match(taxaEffect, /if \(!active\) return/);
  assert.match(taxaEffect, /active = false;[\s\S]*controller\.abort\(\)/);
});

test("Sem Movimentação keeps its header, actions, and existing filters visible while the results load", () => {
  const movementStart = dashboards.indexOf(') : view === "movimentacao" ? (', dashboards.indexOf("<main"));
  const movementEnd = dashboards.indexOf(') : view === "sellers" ? (', movementStart);
  const movementBranch = dashboards.slice(movementStart, movementEnd);
  const header = movementBranch.indexOf('className="dashboard-intro"');
  const actions = movementBranch.indexOf("{dashboardActionBand}");
  const filters = movementBranch.indexOf('className="filters-card movement-filters-card"');
  const resultsGate = movementBranch.indexOf("{noMovementHasPublishedRecords && movementLoaded ? <>");
  const skeleton = movementBranch.indexOf("<DashboardLoadingSkeleton", resultsGate);
  assert.ok(header >= 0 && actions > header && filters > actions && resultsGate > filters && skeleton > resultsGate);
  assert.match(movementBranch, /noMovementV2State.status === "error"[\s\S]*?<DashboardLoadingSkeleton[\s\S]*?onRetry/);
  assert.match(movementBranch, /status === "loading" \|\| noMovementV2State.status === "idle" \|\| !noMovementDataAuthorized/);
  assert.match(movementBranch, /disabled=\{!noMovementHasPublishedRecords\}/);
  assert.match(movementBranch, /noMovementHasPublishedRecords && movementLoaded \? t\("\{count\} colunas"[\s\S]*?: "—"/);
  assert.match(movementBranch, /<div className="filter-grid movement-filter-grid">/);
});

test("the permanent dashboard loading rule is documented without applying it to other panels", async () => {
  const standard = await readFile(new URL("../docs/architecture/dashboard-loading-standard.md", import.meta.url), "utf8");
  assert.match(standard, /header and permitted action buttons immediately/);
  assert.match(standard, /only in the results area/);
  assert.match(standard, /indeterminate progress/);
  assert.match(standard, /does not authorize changing other dashboard loading behavior/);
});
