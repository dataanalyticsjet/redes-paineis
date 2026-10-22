import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionRateV3ExcelNumberFormat,
  collectionRateV3MonthlyChartPoints,
  collectionRateV3ProgressWidth,
  collectionRateV3ExcelValue,
  formatCollectionRateV3RegionalAttemptRate,
  collectionRateV3FilterOptions,
  filterCollectionRateV3Rows,
  formatCollectionRateV3Cell,
  groupCollectionRateV3Rows,
  mapCollectionRateV3Record,
  summarizeCollectionRateV3,
  summarizeCollectionRateV3Attempts,
  summarizeCollectionRateV3Cards,
  summarizeCollectionRateV3Daily,
  summarizeCollectionRateV3Monthly,
  summarizeCollectionRateV3Origins,
  summarizeCollectionRateV3RegionalAttempts,
} from "../src/lib/data-foundation/collection-rate-v3-dashboard.ts";
import {
  COLLECTION_RATE_V3_COLUMNS,
  COLLECTION_RATE_V3_HEADERS,
  type CollectionRateV3Record,
} from "../src/lib/data-foundation/collection-rate-v3.ts";
import { officialRgmForRegion, UNASSIGNED_RGM } from "../src/lib/responsibility.ts";
import { translateDashboardText } from "../src/lib/i18n.ts";

function record(overrides: Partial<CollectionRateV3Record> = {}): CollectionRateV3Record {
  return {
    deadline_at: "2026-10-13 00:00:00",
    reported_region: "MATRIZ informativa JMS",
    source_base_name: "Base sem confirmação",
    order_origin: "Marketplace",
    product_type: "EXPRESS",
    order_quantity: 100,
    quantity_to_collect: 80,
    cancelled_quantity: 0,
    collection_rate: 0.75,
    collected_quantity: 60,
    not_collected_quantity: 20,
    not_collected_on_time_quantity: 0,
    collected_on_time_quantity: 55,
    collection_on_time_rate: 0.68,
    collected_plus_attempts_quantity: 70,
    collection_rate_with_attempts: 0.9,
    average_collection_delay_hours: null,
    processed_problem_items: 2,
    unprocessed_problem_items: 3,
    seller_collection_rate: 0.8,
    expected_merchant_visits: 10,
    merchants_not_visited: 1,
    publication_id: "12345678-1234-5678-1234-567812345678",
    source_row_no: 2,
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    effective_base_code: null,
    effective_mapping_resolution: "UNMAPPED",
    mapped_region: null,
    mapped_uf: null,
    mapped_rm_area: null,
    mapped_rm: null,
    mapped_base_name: null,
    ...overrides,
  };
}

test("V3 contains exactly the 22 official JMS columns in order", () => {
  assert.equal(COLLECTION_RATE_V3_COLUMNS.length, 22);
  assert.deepEqual(COLLECTION_RATE_V3_COLUMNS.map((field) => COLLECTION_RATE_V3_HEADERS[field]), [
    "Horário de término do prazo de coleta", "Nome da regional", "Nome da base de coleta",
    "Origem do Pedido", "Tipo de produto", "Quantidade de pedidos", "Qtd a coletar",
    "Qtd cancelada", "Taxa de coleta", "揽收量", "未揽收量", "Qtd não coletada no prazo",
    "Qtd coletada no prazo", "Taxa de coleta no prazo", "Pedidos coletados + Tentativas de coleta",
    "Taxa de coleta com tentativas de coleta", "Prazo médio demorado para coleta(h)",
    "已做问题件的量", "未做问题件的量", "Taxa de coleta do vendedor", "应上门商家量", "未上门商家量",
  ]);
});

test("regional JMS stays informational and unresolved names remain Sem regional", () => {
  const row = mapCollectionRateV3Record(record());
  assert.equal(row.region, "Sem regional");
  assert.equal(row.rmArea, "Sem região do RM");
  assert.equal(row.rgm, "Sem RGM");
  assert.equal(row.base, "Base sem confirmação");

  const options = collectionRateV3FilterOptions([row]);
  assert.deepEqual(options.regions, ["Sem regional"]);
});

test("only a published unique mapping drives regional and RM dimensions", () => {
  const row = mapCollectionRateV3Record(record({
    resolved_base_code: "BASE-01",
    effective_base_code: "BASE-01",
    mapping_resolution: "NAME_APPROVED",
    effective_mapping_resolution: "NAME_APPROVED",
    mapped_region: "SPE",
    mapped_rm_area: "Sudeste",
    mapped_rm: "RM oficial",
    mapped_base_name: "Base oficial",
  }));
  assert.equal(row.region, "SPE");
  assert.equal(row.rmArea, "Sudeste");
  assert.equal(row.rm, "RM oficial");
  assert.equal(row.base, "Base oficial");
  assert.equal(row.baseCode, "BASE-01");
});

test("summary rates are recalculated from quantities and filters retain source rows", () => {
  const rows = [
    mapCollectionRateV3Record(record()),
    mapCollectionRateV3Record(record({
      source_row_no: 3,
      order_quantity: 20,
      quantity_to_collect: 20,
      collected_quantity: 10,
      not_collected_quantity: 10,
      collected_on_time_quantity: 5,
      order_origin: "Loja",
    })),
  ];
  const filtered = filterCollectionRateV3Rows(rows, { origins: new Set(["Marketplace"]) });
  assert.equal(filtered.length, 1);
  assert.deepEqual(summarizeCollectionRateV3(filtered), {
    totalOrders: 100,
    planned: 80,
    collected: 60,
    notCollected: 20,
    collectedOnTime: 55,
    collectionRate: 0.75,
    onTimeRate: 55 / 80,
  });
});

test("validated V3 cards use filtered quantities and the official attempts numerator", () => {
  const rows = [
    mapCollectionRateV3Record(record({
      deadline_at: "2026-10-01 00:00:00",
      quantity_to_collect: 10_000_000,
      collected_quantity: 8_183_663,
      not_collected_quantity: 1_816_337,
      collected_plus_attempts_quantity: 9_260_000,
      order_origin: "Marketplace",
    })),
    mapCollectionRateV3Record(record({
      deadline_at: "2026-10-02 00:00:00",
      quantity_to_collect: 500_000,
      collected_plus_attempts_quantity: 100_000,
      not_collected_quantity: 50_000,
      source_row_no: 3,
      order_origin: "Loja",
    })),
  ];
  const filtered = filterCollectionRateV3Rows(rows, { origins: new Set(["Marketplace"]) });
  const totals = summarizeCollectionRateV3(filtered);
  const attempts = summarizeCollectionRateV3Attempts(filtered);

  assert.equal(totals.notCollected, 1_816_337);
  assert.equal(attempts.collectedPlusAttempts, 9_260_000);
  assert.equal(attempts.quantityToCollect, 10_000_000);
  assert.equal(attempts.rate, 0.926);
});

test("validated V3 card reference for 18 October and zero denominator", () => {
  const row = mapCollectionRateV3Record(record({
    deadline_at: "2026-10-18 00:00:00",
    quantity_to_collect: 1_365_000,
    collected_quantity: 823_316,
    not_collected_quantity: 541_684,
    collected_plus_attempts_quantity: 541_905,
  }));
  const dailyRows = [row].filter((item) => item.data_date === "2026-10-18");
  const totals = summarizeCollectionRateV3(dailyRows);
  const attempts = summarizeCollectionRateV3Attempts(dailyRows);

  assert.equal(totals.notCollected, 541_684);
  assert.equal(attempts.rate, 0.397);
  assert.ok(Number(row.collected_plus_attempts_quantity) < Number(row.collected_quantity));

  const zeroDenominator = summarizeCollectionRateV3Attempts([
    mapCollectionRateV3Record(record({ quantity_to_collect: 0, collected_plus_attempts_quantity: 5 })),
  ]);
  assert.equal(zeroDenominator.rate, null);
});

test("single-pass V3 card summaries and filter options preserve existing results", () => {
  const rows = [
    mapCollectionRateV3Record(record({
      deadline_at: "2026-10-18 00:00:00",
      resolved_base_code: "BASE-01",
      effective_base_code: "BASE-01",
      mapping_resolution: "NAME_APPROVED",
      effective_mapping_resolution: "NAME_APPROVED",
      mapped_region: "SPE",
      mapped_rm_area: "Sudeste",
      mapped_rm: "RM Alfa",
      mapped_base_name: "Base Alfa",
      order_quantity: 100,
      quantity_to_collect: 80,
      collected_quantity: 60,
      not_collected_quantity: 20,
      collected_on_time_quantity: 55,
      collected_plus_attempts_quantity: 70,
      order_origin: "Marketplace",
    })),
    mapCollectionRateV3Record(record({
      deadline_at: "2026-10-19 00:00:00",
      source_row_no: 3,
      resolved_base_code: "BASE-02",
      effective_base_code: "BASE-02",
      mapping_resolution: "CODE_MATCH",
      effective_mapping_resolution: "CODE_MATCH",
      mapped_region: "SR",
      mapped_rm_area: "Sul",
      mapped_rm: "RM Beta",
      mapped_base_name: "Base Beta",
      order_quantity: 30,
      quantity_to_collect: 20,
      collected_quantity: 10,
      not_collected_quantity: 10,
      collected_on_time_quantity: 8,
      collected_plus_attempts_quantity: 15,
      order_origin: "Loja",
      product_type: "STANDARD",
    })),
  ];
  const cards = summarizeCollectionRateV3Cards(rows);
  const expectedOptions = {
    regions: [...new Set(rows.map((row) => row.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rms: [...new Set(rows.map((row) => row.rm).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rmAreas: [...new Set(rows.map((row) => row.rmArea).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rgms: [...new Set(rows.map((row) => row.rgm).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    bases: [...new Set(rows.map((row) => row.base).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    origins: [...new Set(rows.map((row) => row.origin).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    productTypes: [...new Set(rows.map((row) => row.productType).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
  };

  assert.deepEqual(cards.totals, summarizeCollectionRateV3(rows));
  assert.deepEqual(cards.attempts, summarizeCollectionRateV3Attempts(rows));
  assert.deepEqual(collectionRateV3FilterOptions(rows), expectedOptions);
  const byRegion = groupCollectionRateV3Rows(rows, "region");
  assert.equal(byRegion.length, new Set(rows.map((row) => row.region)).size);
  assert.equal(byRegion.reduce((sum, group) => sum + group.planned, 0), cards.totals.planned);
  assert.ok(byRegion.every((group) => group.daily.size > 0));
  for (const group of byRegion) {
    const matchingRows = rows.filter((row) => row.region === group.region);
    const planned = matchingRows.reduce((sum, row) => sum + Number(row.quantity_to_collect), 0);
    const collected = matchingRows.reduce((sum, row) => sum + Number(row.collected_quantity), 0);
    assert.equal(group.collectionRate, planned > 0 ? collected / planned : null);
    assert.equal(group.daily.get(matchingRows[0]?.data_date ?? "")?.planned, planned);
  }
  const byRmArea = groupCollectionRateV3Rows(rows, "rmArea");
  assert.equal(byRmArea.reduce((sum, group) => sum + group.planned, 0), cards.totals.planned);
  assert.deepEqual(summarizeCollectionRateV3Daily(rows).map((item) => item.date), ["2026-10-18", "2026-10-19"]);
  assert.deepEqual(summarizeCollectionRateV3Monthly(rows).map((item) => item.month), ["2026-10"]);
  assert.deepEqual(summarizeCollectionRateV3Origins(rows).map((item) => item.origin), ["Marketplace", "Loja"]);
});

test("regional attempt table reconciles the 21 October official workbook figures", () => {
  const source = [
    ["CE", 6_116, 63, 63],
    ["SPN", 140_135, 106_834, 106_800],
    ["MG", 133_168, 105_881, 105_103],
    ["SPS", 368_663, 319_075, 315_415],
    ["SPE", 476_714, 399_463, 394_483],
    ["GP", 31_252, 18_029, 17_646],
    ["RJ", 203_244, 171_673, 164_993],
    ["PR", 33_944, 21_386, 20_131],
    ["SR", 34_070, 22_332, 18_420],
    ["BA", 383, 0, 0],
    ["", 30, 3, 0],
  ] as const;
  const rows = source.map(([reported_region, order_quantity, quantity_to_collect, collected_plus_attempts_quantity], index) =>
    mapCollectionRateV3Record(record({
      deadline_at: "2026-10-21 00:00:00",
      reported_region: reported_region || null,
      source_row_no: index + 2,
      order_quantity,
      quantity_to_collect,
      collected_plus_attempts_quantity,
    })),
  );
  const summary = summarizeCollectionRateV3RegionalAttempts(rows, ["2026-10-21"]);

  assert.deepEqual(summary.dates, ["2026-10-21"]);
  assert.equal(2 + summary.dates.length + 1, 4);
  assert.deepEqual(summary.rows.map((row) => row.region), ["CE", "SPN", "MG", "SPS", "SPE", "GP", "RJ", "PR", "SR", "BA"]);
  const roundedRates = summary.rows.map(({ days }) => {
    const rate = days[0]?.rate;
    return rate === null || rate === undefined ? null : Math.round(rate * 1000) / 10;
  });
  assert.deepEqual(roundedRates, [100, 100, 99.3, 98.9, 98.8, 97.9, 96.1, 94.1, 82.5, null]);
  assert.equal(summary.rows.find((row) => row.region === "CE")?.days[0]?.rate, 1);
  assert.equal(summary.rows.find((row) => row.region === "BA")?.days[0]?.rate, null);
  assert.equal(summary.rows.find((row) => row.region === "CE")?.rgm, officialRgmForRegion("CE"));
  assert.equal(summary.rows.find((row) => row.region === "BA")?.rgm, officialRgmForRegion("BA"));
  assert.equal(formatCollectionRateV3RegionalAttemptRate(summary.rows[0]?.days[0]?.rate ?? null, "pt-BR"), "100,0%");
  assert.equal(formatCollectionRateV3RegionalAttemptRate(null, "pt-BR"), "—");
  assert.equal(summary.totalOrders, 1_427_689);
  assert.equal(summary.totals[0]?.quantityToCollect, 1_164_736);
  assert.equal(summary.totals[0]?.collectedPlusAttempts, 1_143_054);
  assert.ok(Math.abs((summary.totals[0]?.rate ?? 0) - 0.9813846227814716) < 1e-12);
  assert.equal(formatCollectionRateV3RegionalAttemptRate(summary.totals[0]?.rate ?? null, "pt-BR"), "98,1%");
  assert.deepEqual(summary.unassigned, { records: 1, orders: 30, quantityToCollect: 3 });
  assert.ok(summary.rows.every((row) => row.days.length === 1));
});

test("regional attempt table shows independent daily rates and never creates a period rate", () => {
  const rows = [
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-20 00:00:00", reported_region: "CE", order_quantity: 10, quantity_to_collect: 10, collected_plus_attempts_quantity: 8 })),
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-20 00:00:00", reported_region: "SPN", source_row_no: 3, order_quantity: 20, quantity_to_collect: 20, collected_plus_attempts_quantity: 10 })),
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-21 00:00:00", reported_region: "CE", source_row_no: 4, order_quantity: 20, quantity_to_collect: 20, collected_plus_attempts_quantity: 18 })),
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-21 00:00:00", reported_region: "SPN", source_row_no: 5, order_quantity: 10, quantity_to_collect: 10, collected_plus_attempts_quantity: 6 })),
  ];
  const summary = summarizeCollectionRateV3RegionalAttempts(rows, ["2026-10-21", "2026-10-20"]);

  assert.deepEqual(summary.dates, ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(summary.totals.map((day) => day.rate), [0.6, 0.8]);
  assert.equal(summary.rows.find((row) => row.region === "CE")?.totalOrders, 30);
  assert.deepEqual(summary.rows.find((row) => row.region === "CE")?.days.map((day) => day.rate), [0.8, 0.9]);
  assert.equal("periodRate" in summary, false);
});

test("regional attempt table keeps the authorized filtered subset and handles no data", () => {
  const regional = mapCollectionRateV3Record(record({
    reported_region: "CE",
    resolved_base_code: "CE-01",
    effective_base_code: "CE-01",
    mapping_resolution: "CODE_MATCH",
    effective_mapping_resolution: "CODE_MATCH",
    mapped_region: "CE",
    mapped_base_name: "Base Ceará",
    order_quantity: 12,
    quantity_to_collect: 10,
    collected_plus_attempts_quantity: 9,
  }));
  const other = mapCollectionRateV3Record(record({
    reported_region: "SPN",
    source_row_no: 3,
    resolved_base_code: "SPN-01",
    effective_base_code: "SPN-01",
    mapping_resolution: "CODE_MATCH",
    effective_mapping_resolution: "CODE_MATCH",
    mapped_region: "SPN",
    mapped_base_name: "Base Norte",
    order_quantity: 50,
    quantity_to_collect: 40,
    collected_plus_attempts_quantity: 35,
  }));
  const filtered = filterCollectionRateV3Rows([regional, other], { regions: new Set(["CE"]) });
  const summary = summarizeCollectionRateV3RegionalAttempts(filtered, ["2026-10-13"]);
  assert.deepEqual(summary.rows.map((row) => row.region), ["CE"]);
  assert.equal(summary.totalOrders, 12);

  const noRows = summarizeCollectionRateV3RegionalAttempts([], ["2026-10-21"]);
  assert.deepEqual(noRows.rows, []);
  assert.equal(noRows.totals[0]?.rate, null);
  assert.equal(noRows.totalOrders, 0);
});

test("regional table markup contains only the requested four column families", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const tableStart = source.indexOf('data-testid="taxa-v2-regional-summary"');
  const tableEnd = source.indexOf("</table>", tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const table = source.slice(tableStart, tableEnd);
  assert.match(table, /t\("Regional"\)/);
  assert.match(table, /RGM/);
  assert.match(table, /taxaV2RegionalAttempts\.dates\.map/);
  assert.match(table, /t\("Total de pedidos"\)/);
  assert.doesNotMatch(table, /t\("Bases"\)|t\("Taxa de coleta"\)|Pendente/);
  assert.match(table, /formatDate\(date, true\)\.toLocaleUpperCase/);
  assert.match(table, /formatWeekday\(date\)/);
  assert.equal(officialRgmForRegion("not-a-region"), undefined);
  assert.equal(UNASSIGNED_RGM, "Sem RGM");
});

test("regional attempt table notes and title are translated to English and Simplified Chinese", () => {
  assert.equal(translateDashboardText("en", "Taxa de coleta com tentativa por regional — período selecionado"), "Collection attempt rate by region — selected period");
  assert.equal(translateDashboardText("zh", "Taxa de coleta com tentativa por regional — período selecionado"), "各区域所选周期尝试揽收率");
  assert.notEqual(translateDashboardText("en", "Pedidos = SUM(totalCount). Taxa diária = SUM(Pedidos coletados + Tentativas de coleta) / SUM(Qtd a coletar). Em vários dias, cada data é exibida separadamente; não há taxa do período."), "Pedidos = SUM(totalCount). Taxa diária = SUM(Pedidos coletados + Tentativas de coleta) / SUM(Qtd a coletar). Em vários dias, cada data é exibida separadamente; não há taxa do período.");
});

test("V3 numeric formatting and Excel export preserve native numeric values", () => {
  assert.equal(formatCollectionRateV3Cell(40185, "order_quantity", "pt-BR"), "40.185");
  assert.equal(collectionRateV3ExcelValue(40185, "order_quantity"), 40185);
  assert.equal(collectionRateV3ExcelNumberFormat("order_quantity"), "#,##0");
  assert.equal(collectionRateV3ExcelValue(0.7319, "collection_rate"), 0.7319);
  assert.equal(collectionRateV3ExcelNumberFormat("collection_rate"), "0.00%");
  assert.equal(collectionRateV3ExcelValue(null, "average_collection_delay_hours"), null);
  assert.equal(collectionRateV3ExcelValue("2026-10-13 00:00:00", "deadline_at"), "2026-10-13 00:00:00");
  assert.equal(collectionRateV3ExcelNumberFormat("deadline_at"), "dd/mm/yyyy hh:mm");
  assert.match(formatCollectionRateV3Cell("2026-10-13 00:00:00", "deadline_at", "pt-BR"), /13\/10\/2026/);
});


test("login progress reflects its own collection rate regardless of relative order volume", () => {
  for (const [rate, width] of [[0, "0%"], [0.25, "25%"], [0.5, "50%"], [0.75, "75%"], [0.95, "95%"], [1, "100%"], [null, "0%"], [-0.2, "0%"], [1.2, "100%"], [NaN, "0%"]] as const) {
    assert.equal(collectionRateV3ProgressWidth(rate), width);
  }
  const origins = summarizeCollectionRateV3Origins([
    mapCollectionRateV3Record(record({ order_origin: "Large volume", quantity_to_collect: 10000, collected_quantity: 5000 })),
    mapCollectionRateV3Record(record({ order_origin: "Small volume", quantity_to_collect: 100, collected_quantity: 95 })),
  ]);
  assert.equal(collectionRateV3ProgressWidth(origins[1]!.collectionRate), "95%");
});

test("monthly chart reuses the validated ratio-of-sums formulas without changing daily summaries", () => {
  const rows = [
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-20 00:00:00", quantity_to_collect: 10, collected_quantity: 5, collected_plus_attempts_quantity: 8 })),
    mapCollectionRateV3Record(record({ deadline_at: "2026-10-21 00:00:00", quantity_to_collect: 90, collected_quantity: 85, collected_plus_attempts_quantity: 90 })),
    mapCollectionRateV3Record(record({ deadline_at: "2027-01-01 00:00:00", quantity_to_collect: 0, collected_quantity: 0, collected_plus_attempts_quantity: 0 })),
  ];
  const dailyBefore = summarizeCollectionRateV3Daily(rows);
  const monthly = collectionRateV3MonthlyChartPoints(rows);
  assert.deepEqual(monthly, [
    { month: "2026-10", collectionRate: 0.9, attemptRate: 0.98 },
    { month: "2027-01", collectionRate: null, attemptRate: null },
  ]);
  const oldMonthly = summarizeCollectionRateV3Monthly(rows);
  assert.equal(monthly[0]!.collectionRate, oldMonthly[0]!.collectionRate);
  assert.equal(monthly[0]!.attemptRate, summarizeCollectionRateV3Attempts(rows.slice(0,2)).rate);
  assert.deepEqual(summarizeCollectionRateV3Daily(rows), dailyBefore);
  assert.deepEqual(collectionRateV3MonthlyChartPoints([]), []);
});

test("Taxa presentation puts regional table, unchanged daily chart, monthly comparison and login in order", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const positions = ['data-testid="taxa-v2-kpi-grid"', 'data-testid="taxa-v2-regional-summary"', 'data-testid="taxa-v2-daily-chart"', '<CollectionRateV3MonthlyChart points=', 'data-testid="taxa-v2-origin-summary"', 'data-testid="taxa-v2-rm-summary"', 't("Dados detalhados — 22 colunas oficiais")'].map((marker) => {
    assert.equal(source.split(marker).length - 1, 1, marker + " remains unique");
    return source.indexOf(marker);
  });
  assert.deepEqual([...positions].sort((a,b) => a-b), positions);
  assert.match(source, /width: collectionRateV3ProgressWidth\(item.collectionRate\)/);
  assert.doesNotMatch(source, /item.planned \/ taxaV2ByOrigin\[0\]/);
});

test("monthly chart renders real points, both series, translated periods and empty states", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = await import("typescript");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const require = createRequire(import.meta.url);
  const source = await readFile(new URL("../src/features/dashboards/collection-rate-v3-monthly-chart.tsx", import.meta.url), "utf8");
  const output = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
  const { CollectionRateV3MonthlyChart } = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
  const t = (key: string, params?: Record<string,string|number>) => translateDashboardText("pt", key, params);
  const props = { locale: "pt-BR", formatRate: (rate: number|null) => formatCollectionRateV3RegionalAttemptRate(rate,"pt-BR"), t };
  const html = renderToStaticMarkup(createElement(CollectionRateV3MonthlyChart, { ...props, points: [{ month: "2026-10", collectionRate: 0.908, attemptRate: 0.981 }] }));
  assert.match(html, /Ano 2026/);
  assert.match(html, /90,8%/);
  assert.match(html, /98,1%/);
  assert.match(html, /out\./);
  assert.equal((html.match(/<circle /g) ?? []).length, 2);
  assert.match(html, /taxa-v3-series-collection/);
  assert.match(html, /taxa-v3-series-attempt/);
  const extremes = renderToStaticMarkup(createElement(CollectionRateV3MonthlyChart, { ...props, points: [{ month: "2026-10", collectionRate: 0, attemptRate: 0.5 }, { month: "2027-01", collectionRate: 1, attemptRate: null }] }));
  assert.doesNotMatch(extremes, /NaN|Infinity/);
  assert.match(extremes, /2026–2027/);
  assert.equal((extremes.match(/<circle /g) ?? []).length, 3);
  const empty = renderToStaticMarkup(createElement(CollectionRateV3MonthlyChart, { ...props, points: [] }));
  assert.match(empty, /Sem datas publicadas no período/);
  assert.doesNotMatch(empty, /<svg/);
});


test("Taxa removes only the history table and keeps official detail as the last section", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /taxa-v2-monthly-summary|taxa-v2-monthly-card/);
  assert.equal(source.split("<CollectionRateV3MonthlyChart points=").length - 1, 1);
  const detail = source.indexOf('<section className="chart-card bipagem-table-card taxa-v2-detail-card">');
  const end = source.indexOf(') : collectionRateV2State.status === "empty"', detail);
  assert.ok(detail > 0 && end > detail);
  const tail = source.slice(source.indexOf("</section>", detail) + "</section>".length, end);
  assert.doesNotMatch(tail, /<section|quality-note|<article/);
  const table = source.slice(detail, end);
  assert.match(table, /downloadRowsAsExcel\(taxaV2SearchedRows, COLLECTION_RATE_V3_COLUMNS\.map/);
  assert.match(table, /COLLECTION_RATE_V3_COLUMNS\.map\(\(field\) => <th key=\{field\}/);
  assert.match(table, /taxaV2VisibleRows\.map/);
  assert.match(table, /setTaxaV2TableQuery\(event.target.value\); setTaxaV2Page\(1\)/);
  assert.match(table, /taxaV2PageCount/);
});
