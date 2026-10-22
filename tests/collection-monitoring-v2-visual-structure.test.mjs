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
  assert.match(component, /<CollectionMonitoringV2RegionalRetention/);
  assert.match(component, /group\.retainedAtBase/);
  assert.match(component, /group\.dispatchedFromBase/);
  assert.match(component, /group\.arrivedAtCenter/);

  assert.match(component, /t\("Sem dados"\)/);
  assert.match(component, /t\("As regras dos indicadores são operacionais provisórias/);
  assert.doesNotMatch(component, /Pendente de homologação/);
});

test("new monitoring sections follow retention in PDF order without removing the raw 23-column source", () => {
  const retentionRm = component.indexOf('comparisonTable("Retenção por RM"');
  const regional = component.indexOf('monitoringTable("Monitoramento por regional"');
  const rm = component.indexOf('monitoringTable("Monitoramento por RM"');
  const status = component.indexOf('aria-label={t("Total por regional e status")}');
  const detail = component.indexOf('aria-label={t("Dados por base")}');
  assert.ok(retentionRm >= 0 && retentionRm < regional);
  assert.ok(regional < rm && rm < status && status < detail);
  assert.match(component, /groupCollectionMonitoringV2BaseDetails\(filteredRows\)/);
  assert.match(component, /Dados originais da fonte \(23 colunas\)/);
  assert.match(component, /COLLECTION_MONITORING_V2_COLUMNS\.map\(\(key\) => <th key=\{key\}/);
  assert.match(component, /book_append_sheet\(workbook, summaryWorksheet, "Resumo por base"\)/);
  assert.match(component, /book_append_sheet\(workbook, worksheet, "Dados"\)/);
  assert.match(component, /collectionMonitoringV2ExcelMatrix\(rows\)/);
  assert.equal((component.match(/monitoringTable\("Monitoramento por regional"/g) ?? []).length, 1);
  assert.equal((component.match(/monitoringTable\("Monitoramento por RM"/g) ?? []).length, 1);
  assert.match(styles, /\.collection-monitoring-v2-status-row\s*\{/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.collection-monitoring-v2-status-row/);
});

test("new layout rules are scoped to the Monitoramento V2 component and adapt to smaller screens", () => {
  assert.match(styles, /\.collection-monitoring-v2-intro\s*\{/);
  assert.match(styles, /\.collection-monitoring-v2-main-filter-grid\s*\{[^}]*repeat\(7, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.collection-monitoring-v2-retention-table\s*\{/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.collection-monitoring-v2-main-filter-grid/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.collection-monitoring-v2-retention-table/);
});
