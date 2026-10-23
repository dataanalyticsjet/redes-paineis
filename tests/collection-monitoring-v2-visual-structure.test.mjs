import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url), "utf8");
const retention = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2-regional-retention.tsx", import.meta.url), "utf8");
const retentionModel = await readFile(new URL("../src/lib/data-foundation/collection-monitoring-v2-retention.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");

test("final Monitoramento V2 order is filters, both retention tables, then four KPI cards", () => {
  const filters = component.indexOf('aria-label={t("Filtros operacionais")}');
  const tables = component.indexOf("<CollectionMonitoringV2RetentionTables");
  const cards = component.indexOf('aria-label={t("Indicadores principais")}');
  assert.ok(filters >= 0 && filters < tables && tables < cards);
  assert.equal((component.match(/data-testid="collection-monitoring-v2-kpi"/g) ?? []).length, 1);
  assert.match(component, /select\("region", "Regional"/);
  assert.match(component, /select\("rm", "RM"/);
  assert.match(component, /select\("base", "Base \/ PDD"/);
  assert.match(component, /dateFilters/);
  assert.match(component, /collection-monitoring-v2-status-filter[\s\S]*?disabled/);
  assert.match(component, /select\("origin", "Origem do pedido"/);
  assert.match(component, /collection-monitoring-v2-advanced-filters[\s\S]*?select\("rmArea"[\s\S]*?select\("rgm"/);
});

test("all legacy operational sections and the raw 23-column table are absent from the dashboard render", () => {
  for (const section of ["monitoringTable(\"Monitoramento por regional\"", "monitoringTable(\"Monitoramento por RM\"", "Total por regional e status", "Dados por base", "Dados originais da fonte (23 colunas)", "collectionMonitoringV2ExcelMatrix", "Resumo por base", "Dados\""]) {
    assert.equal(component.includes(section), false, `unexpected legacy UI/export section: ${section}`);
  }
  assert.match(component, /append\(regional, "Retenção por regional"/);
  assert.match(component, /append\(rm, "Retenção por RM"/);
  assert.doesNotMatch(component, /Retenção por RM"[,\s\S]{0,80}byRm/);
  assert.match(retention, /loadCollectionMonitoringV2Retention/);
  assert.match(retention, /subscribeToProtectedApiAuthorizationFailure/);
});

test("regional and RM tables retain the approved columns, red headers, date groups, variation and totals", () => {
  assert.match(retention, /RETENTION_MEASURES\.map/);
  assert.match(retention, /rowSpan=\{2\}/);
  assert.match(retention, /scope="colgroup"/);
  assert.match(retention, /Retenção por RM/);
  assert.ok(retention.indexOf("<CollectionMonitoringV2RegionalRetentionTable") < retention.indexOf("<CollectionMonitoringV2RmRetentionTable"));
  assert.match(retentionModel, /label: "Retenção total"/);
  assert.match(retentionModel, /label: "Retido na base"/);
  assert.match(retentionModel, /label: "Despachado pela base"/);
  assert.match(retentionModel, /label: "Chegado ao centro"/);
  assert.match(retention, /<tfoot>/);
  assert.match(retention, /Baixar Excel — todas as tabelas/);
  assert.match(styles, /\.collection-monitoring-v2-regional-retention \.cm-v2-regional-retention-table th \{[^}]*color: #fff; background: #e60000/s);
  assert.match(styles, /\.collection-monitoring-v2-rm-retention-table th \{[^}]*color: #fff; background: #e60000/s);
  assert.match(styles, /\.collection-monitoring-v2-rm-retention-scroll/);
});
