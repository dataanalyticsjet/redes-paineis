import assert from "node:assert/strict";
import test from "node:test";

import {
  compactMonitoringWorkbook,
  detectColumns,
  latestMonitoringSnapshot,
  normalizeHeader,
  parseTabularData,
  richTextXmlToPlainText,
  toISODate,
  type WorkbookRow,
} from "../src/lib/workbook.ts";

test("normalizes Portuguese punctuation without discarding Chinese text", () => {
  assert.equal(normalizeHeader("  Status atual – Recebído na BASE  "), "status atual recebido na base");
  assert.equal(normalizeHeader("揽收状态（当前）"), "揽收状态 当前");
});

test("keeps responsible names stored as Excel rich text", () => {
  assert.equal(
    richTextXmlToPlainText('<t></t><r><rPr><u val="single"></u></rPr><t xml:space="preserve">@刘松林 SONGLIN LIU（Rick）</t></r>'),
    "@刘松林 SONGLIN LIU（Rick）",
  );
  assert.equal(richTextXmlToPlainText("<r><t>A &amp; B</t></r>"), "A & B");
});

test("normalizes Excel serials and date strings without timezone rollover", () => {
  assert.equal(toISODate(45_292), "2024-01-01");
  assert.equal(toISODate(46_245), "2026-08-11");
  assert.equal(toISODate("12/08/2026"), "2026-08-12");
  assert.equal(toISODate("2026-08-12T00:00:00-03:00"), "2026-08-12");
  assert.equal(toISODate("2026年8月12日"), "2026-08-12");
  assert.equal(toISODate("31/02/2026"), undefined);
});

test("detects the real report's base and separate status metric columns", () => {
  const headers = [
    "Data",
    "Regional Origem",
    "PDD de saida",
    "Origem do Pedido",
    "Taxa de coleta do vendedor",
    "Coleta Prevista Pick-up",
    "Dorp off待揽收",
    "Status atual – Coletado",
    "Status atual – Recebido na base",
    "Expedida pela Base",
    "Problemáticos Não Registrados",
  ];
  const rows: WorkbookRow[] = [
    {
      Data: 46_245,
      "Regional Origem": "SPS",
      "PDD de saida": "COT-SP",
      "Origem do Pedido": "TikTok",
      "Taxa de coleta do vendedor": 0.99,
      "Coleta Prevista Pick-up": 100,
      "Dorp off待揽收": 5,
      "Status atual – Coletado": 3,
      "Status atual – Recebido na base": 8,
      "Expedida pela Base": 2,
      "Problemáticos Não Registrados": 4,
    },
  ];

  const detected = detectColumns(headers, rows);
  assert.equal(detected.dateColumn, "Data");
  assert.equal(detected.baseColumn, "PDD de saida");
  assert.equal(detected.originColumn, "Origem do Pedido");
  assert.equal(detected.statusColumn, undefined);
  assert.deepEqual(detected.statusColumns, [
    "Coleta Prevista Pick-up",
    "Dorp off待揽收",
    "Status atual – Coletado",
    "Status atual – Recebido na base",
    "Expedida pela Base",
    "Problemáticos Não Registrados",
  ]);
});

test("detects multilingual order-source headers without confusing them with the base", () => {
  assert.equal(detectColumns(["日期", "站点", "订单来源"], []).originColumn, "订单来源");
  assert.equal(detectColumns(["Date", "Base", "Order source"], []).originColumn, "Order source");
});

test("detects Chinese aliases and a categorical status column", () => {
  const rows = [
    { 日期: "2026-08-12", 站点: "SP01", 当前状态: "已揽收" },
    { 日期: "2026-08-11", 站点: "SP02", 当前状态: "运输中" },
  ];
  const detected = detectColumns(["日期", "站点", "当前状态"], rows);

  assert.equal(detected.dateColumn, "日期");
  assert.equal(detected.baseColumn, "站点");
  assert.equal(detected.statusColumn, "当前状态");
  assert.deepEqual(detected.statusColumns, ["当前状态"]);
});

test("detects every operational transit status used by the monitoring workbook", () => {
  const detected = detectColumns([
    "Data",
    "PDD de saida",
    "网点发件在途(中心)",
    "网点发件在途(集散)",
    "集散发件在途",
  ], []);

  assert.deepEqual(detected.statusColumns, [
    "网点发件在途(中心)",
    "网点发件在途(集散)",
    "集散发件在途",
  ]);
});

test("keeps only the latest monitoring snapshot and compacts its operational totals", () => {
  const parsed = parseTabularData([
    ["Data", "Regional Origem", "PDD de saida", "Coleta Prevista Drop-off", "Aguardando Coleta Drop-off", "Status atual – Coletado"],
    ["05/10/2026", "SPS", "BASE-01", 40, 8, 32],
    ["06/10/2026", "SPS", "BASE-01", 20, 3, 17],
    ["06/10/2026", "SPS", "BASE-01", 10, 2, 8],
    ["07/10/2026", "SPS", "BASE-01", 12, 4, 8],
    ["07/10/2026", "SPS", "BASE-01", 3, 1, 2],
  ], { sheetName: "sheet0" });

  const latest = latestMonitoringSnapshot(parsed);
  assert.equal(latest.rows.length, 2);
  assert.ok(latest.rows.every((row) => row.Data === "2026-10-07"));
  assert.deepEqual(latest.metadata.dateRange, { min: "2026-10-07", max: "2026-10-07" });

  const compacted = compactMonitoringWorkbook(latest);
  assert.equal(compacted.rows.length, 1);
  assert.equal(compacted.rows[0]["Coleta Prevista Drop-off"], 15);
  assert.equal(compacted.rows[0]["Aguardando Coleta Drop-off"], 5);
  assert.equal(compacted.rows[0]["Status atual – Coletado"], 10);
  assert.deepEqual(compacted.metadata.dateRange, { min: "2026-10-07", max: "2026-10-07" });
});

test("finds a header below a title, drops empty rows, and keeps every column", () => {
  const parsed = parseTabularData(
    [
      ["Relatório diário de coleta"],
      [],
      ["Data", "Base", "Status", "Status", null],
      [46_245, "COT-SP", "Coletado", "OK", 12],
      [null, "", "", null, undefined],
      ["11/08/2026", "SAO-SP", "Em trânsito", "OK", 9],
    ],
    { sheetName: "Resumo" },
  );

  assert.equal(parsed.metadata.headerRow, 3);
  assert.deepEqual(parsed.headers, ["Data", "Base", "Status", "Status (2)", "Coluna 5"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].Data, "2026-08-11");
  assert.equal(parsed.rows[1].Data, "2026-08-11");
  assert.equal(parsed.rows[0]["Coluna 5"], 12);
  assert.match(parsed.warnings.join(" "), /cabeçalho\(s\) vazio\(s\)/);
  assert.match(parsed.warnings.join(" "), /duplicado\(s\)/);
});
