import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");

test("Monitoramento V2 presents the translated seven-field filter row and keeps Status disabled", () => {
  assert.match(component, /select\("region", "Regional"/);
  assert.match(component, /select\("rm", "RM"/);
  assert.match(component, /select\("base", "Base \/ PDD"/);
  assert.match(component, /dateFilters/);
  assert.match(component, /collection-monitoring-v2-status-filter[\s\S]*?disabled/);
  assert.match(component, /select\("origin", "Origem do pedido"/);
  assert.match(component, /collection-monitoring-v2-advanced-filters[\s\S]*?select\("rmArea"[\s\S]*?select\("rgm"/);
  assert.doesNotMatch(component, /预估揽收|待揽收|揽收率|待揽收率/);
});

test("retention tables show the approved provisional formulas and distinguish unavailable comparisons", () => {
  assert.match(component, /"Retenção por regional"/);
  assert.match(component, /"Retenção por RM"/);
  assert.match(component, /collectionMonitoringV2PercentageVariation\(current\.retentionTotal, previous\.retentionTotal\)/);
  assert.match(component, /group\.retainedAtBase/);
  assert.match(component, /group\.dispatchedFromBase/);
  assert.match(component, /group\.arrivedAtCenter/);
  assert.match(component, /t\("Comparação indisponível"\)/);
  assert.match(component, /t\("Sem dados"\)/);
  assert.match(component, /t\("As regras dos indicadores são operacionais provisórias/);
  assert.doesNotMatch(component, /Pendente de homologação/);
});

test("new layout rules are scoped to the Monitoramento V2 component and adapt to smaller screens", () => {
  assert.match(styles, /\.collection-monitoring-v2-intro\s*\{/);
  assert.match(styles, /\.collection-monitoring-v2-main-filter-grid\s*\{[^}]*repeat\(7, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.collection-monitoring-v2-retention-table\s*\{/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.collection-monitoring-v2-main-filter-grid/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.collection-monitoring-v2-retention-table/);
});
