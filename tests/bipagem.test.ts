import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBipagemLoadedData,
  compareBipagemPeriod,
  summarizeBipagem,
  summarizeBipagemByBase,
  summarizeBipagemByRegional,
} from "../app/lib/bipagem.ts";
import type { ParsedWorkbook } from "../app/lib/workbook.ts";

const headers = [
  "Data considerada",
  "Código da Regional do PDD Responsável",
  "Nome da Regional do PDD Responsável",
  "Código da base",
  "Nome do PDD Responsável",
  "Código de origem do pedido",
  "Origem do Pedido",
  "Qtd pedidos a bipar",
  "Qtd pedidos não bipados no recebimento da coleta",
  "Taxa de pedidos não bipados no recebimento da coleta",
  "Qtd pedidos não bipados na coleta",
  "Taxa de falta de bipagem na coleta",
  "Qtd de Pacotes com Falta de Bipe de Envio",
  "Taxa de pedidos não bipados na expedição",
  "Taxa geral de falta de bipagem",
];

function workbook(): ParsedWorkbook {
  return {
    sheetName: "sheet0",
    headers,
    rows: [
      {
        "Data considerada": "2026-08-25",
        "Código da Regional do PDD Responsável": 350000,
        "Nome da Regional do PDD Responsável": "SPS",
        "Código da base": 311001,
        "Nome do PDD Responsável": "BASE A",
        "Código de origem do pedido": "D67",
        "Origem do Pedido": "TikTok",
        "Qtd pedidos a bipar": 100,
        "Qtd pedidos não bipados no recebimento da coleta": 20,
        "Qtd pedidos não bipados na coleta": 5,
        "Qtd de Pacotes com Falta de Bipe de Envio": 3,
      },
      {
        "Data considerada": "2026-08-25",
        "Código da Regional do PDD Responsável": 350000,
        "Nome da Regional do PDD Responsável": "SPS",
        "Código da base": 311002,
        "Nome do PDD Responsável": "BASE B",
        "Código de origem do pedido": "D899",
        "Origem do Pedido": "TEMU D2D",
        "Qtd pedidos a bipar": 50,
        "Qtd pedidos não bipados no recebimento da coleta": 10,
        "Qtd pedidos não bipados na coleta": 0,
        "Qtd de Pacotes com Falta de Bipe de Envio": 2,
      },
    ],
    statusColumns: [],
    warnings: [],
  } as ParsedWorkbook;
}

test("parses the missing-scan workbook and calculates weighted rates from volumes", () => {
  const data = buildBipagemLoadedData(workbook(), "falha.xlsx");
  assert.equal(data.records.length, 2);
  assert.deepEqual(data.origins, ["TEMU D2D", "TikTok"]);
  const summary = summarizeBipagem(data.records);
  assert.equal(summary.ordersToScan, 150);
  assert.equal(summary.scannedCollection, 145);
  assert.equal(summary.notScannedReceipt, 30);
  assert.equal(summary.notScannedCollection, 5);
  assert.equal(summary.collectionFailureRate, 5 / 150);
});

test("summarizes by regional and by base/RM without averaging row percentages", () => {
  const data = buildBipagemLoadedData(workbook(), "falha.xlsx");
  const regional = summarizeBipagemByRegional(data.records);
  assert.equal(regional[0]?.region, "SPS");
  assert.equal(regional[0]?.activeBases, 2);
  assert.equal(regional[0]?.collectionFailureRate, 5 / 150);

  const byBase = summarizeBipagemByBase(data.records, (base) => base === "BASE A" ? "Rick" : "Ana");
  assert.equal(byBase[0]?.base, "BASE A");
  assert.equal(byBase[0]?.rm, "Rick");
  assert.equal(byBase[0]?.notScannedCollection, 5);
});

test("compares the first and last selected day and classifies improvement or worsening", () => {
  const data = buildBipagemLoadedData(workbook(), "falha.xlsx");
  const startRecords = data.records;
  const endRecords = data.records.map((record, index) => ({
    ...record,
    key: `${record.key}-end`,
    date: "2026-08-26",
    notScannedReceipt: index === 0 ? 12 : 8,
    notScannedCollection: index === 0 ? 8 : 2,
  }));
  const comparison = compareBipagemPeriod(
    [...startRecords, ...endRecords],
    "2026-08-25",
    "2026-08-26",
  );

  assert.deepEqual(comparison.receipt, {
    startValue: 30,
    endValue: 20,
    delta: -10,
    variation: -1 / 3,
    trend: "improved",
  });
  assert.deepEqual(comparison.collection, {
    startValue: 5,
    endValue: 10,
    delta: 5,
    variation: 1,
    trend: "worsened",
  });
});

test("marks zero-to-zero as stable and zero-to-volume as new worsening", () => {
  const data = buildBipagemLoadedData(workbook(), "falha.xlsx");
  const base = data.records[0]!;
  const comparison = compareBipagemPeriod([
    { ...base, date: "2026-08-25", notScannedReceipt: 0, notScannedCollection: 0 },
    { ...base, date: "2026-08-26", notScannedReceipt: 0, notScannedCollection: 4 },
  ], "2026-08-25", "2026-08-26");

  assert.equal(comparison.receipt.trend, "stable");
  assert.equal(comparison.receipt.variation, 0);
  assert.equal(comparison.collection.trend, "worsened");
  assert.equal(comparison.collection.variation, null);
});
