import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const translations = await readFile(new URL("../src/lib/i18n.ts", import.meta.url), "utf8");
const actionBand = await readFile(new URL("../src/features/dashboards/dashboard-action-band.tsx", import.meta.url), "utf8");

test("Taxa de Coleta V3 inicia em D-1 de São Paulo e limpa para D-1", () => {
  assert.match(dashboard, /const yesterday = yesterdayInSaoPaulo\(\);[\s\S]*?period: \{ dateFrom: yesterday, dateTo: yesterday \}/);
  const mainStart = dashboard.indexOf("<main");
  const officialStart = dashboard.indexOf(') : view === "taxa" ? (', mainStart);
  const officialFilter = dashboard.slice(officialStart, officialStart + 18000);
  assert.match(officialFilter, /const yesterday = yesterdayInSaoPaulo\(\);[\s\S]*?period: \{ dateFrom: yesterday, dateTo: yesterday \}/);
  assert.match(officialFilter, /status === "empty"[\s\S]*?Sem dados publicados para a data selecionada/);
});

test("filtros Taxa V3 permanecem expandidos e mantêm Limpar filtros", () => {
  const officialBranchStart = dashboard.indexOf(') : view === "taxa" ? (', dashboard.indexOf("<main"));
  const officialBranch = dashboard.slice(officialBranchStart, officialBranchStart + 24000);
  assert.doesNotMatch(dashboard, /taxaV2FiltersExpanded|setTaxaV2FiltersExpanded/);
  assert.match(officialBranch, /id="taxa-v2-filter-content" className="taxa-v2-filter-content"(?! hidden)/);
  assert.doesNotMatch(officialBranch, /Expandir filtros|Recolher filtros/);
  assert.match(officialBranch, /Limpar filtros/);
  assert.doesNotMatch(styles, /\.taxa-v2-filter-content\[hidden\]/);
});

test("menus multi-select da Taxa V3 são exclusivos, pesquisáveis, roláveis e fecham fora ou com Escape", () => {
  const filterArea = dashboard.slice(dashboard.indexOf('id="taxa-v2-filter-content"'), dashboard.indexOf('data-testid="collection-rate-v2-diagnostic"'));
  assert.match(filterArea, /className="filter-grid taxa-filter-grid"/);
  assert.doesNotMatch(filterArea, /exclusiveGroup=/);
  assert.match(dashboard, /element\?\.closest\("\.filter-grid"\)/);
  assert.match(dashboard, /function positionMultiSelectPopover\(element: HTMLDetailsElement\): void/);
  assert.match(dashboard, /element\.dataset\.popoverAlign = fitsLeft \|\| !fitsRight \? "left" : "right"/);
  assert.match(dashboard, /document\.addEventListener\("pointerdown", closeOutside, true\)/);
  assert.match(dashboard, /event\.key === "Escape"[\s\S]*?detailsRef\.current\.open = false/);
  assert.match(dashboard, /window\.addEventListener\("resize", repositionOpenMenu\)/);
  assert.match(styles, /\.taxa-v2-filter-content \.multi-select-popover\s*\{[\s\S]*?max-height: min\(72dvh, 520px\);\s*overflow: hidden;/);
  assert.match(styles, /\.menu-options\s*\{\s*max-height: 265px;[\s\S]*?overflow: auto;/);
});

test("Taxa V3 reutiliza a barra corporativa sem botão Fonte de dados", () => {
  const officialBranchStart = dashboard.indexOf(') : view === "taxa" ? (', dashboard.indexOf("<main"));
  const legacyBranchStart = dashboard.indexOf(') : !taxaLoaded ? (', officialBranchStart);
  const officialBranch = dashboard.slice(officialBranchStart, legacyBranchStart > -1 ? legacyBranchStart : officialBranchStart + 30000);
  assert.match(officialBranch, /\{dashboardActionBand\}/);
  assert.match(officialBranch, /className="taxa-v3-print-heading"[\s\S]*?Taxa de coleta V3[\s\S]*?collectionRateV2State\.period\.dateFrom[\s\S]*?collectionRateV2State\.period\.dateTo/);
  for (const label of ["Gerar PDF", "Análise IA", "Enviar para Feishu"]) assert.ok(actionBand.includes(`t("${label}")`));
  assert.match(dashboard, /onDataSource=\{view !== "taxa" && canManageActiveDataSource/);
  assert.match(dashboard, /view !== "taxa" && canManageActiveDataSource/);
  assert.match(dashboard, /onPrint=\{handlePrintReport\}/);
  assert.match(dashboard, /onShare=\{openPanelFeishuShare\}/);
  assert.match(dashboard, /CollectionRateOperationalAnalysis\s+analysis=\{taxaV2OperationalAnalysis\}/);
  assert.match(dashboard, /buildCollectionRateV3OperationalAnalysis\(taxaV2FilteredRows/);
  assert.match(dashboard, /taxaV2AnalysisPeriodIsCurrent/);
});

test("novos rótulos dos filtros têm traduções para inglês e chinês", () => {
  assert.match(translations, /"Expandir filtros": \{ en: "Expand filters", zh: "展开筛选" \}/);
  assert.match(translations, /"Recolher filtros": \{ en: "Collapse filters", zh: "收起筛选" \}/);
});
