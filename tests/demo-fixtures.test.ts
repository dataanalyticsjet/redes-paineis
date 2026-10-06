import test from "node:test";
import assert from "node:assert/strict";
import {
  DASHBOARD_DEMO_FIXTURES,
  DEMO_WORKBOOK_NAME,
  scopeDemoSellerReference,
  scopeDemoWorkbook,
} from "../src/lib/demo-fixtures.ts";
import { buildBipagemLoadedData } from "../src/lib/bipagem.ts";
import { buildDamageData } from "../src/lib/damage.ts";
import { buildResponsibilityData } from "../src/lib/responsibility.ts";

const regionalScope = { region: "SPN-DEMO", base: null };
const baseScope = { region: null, base: "BASE RESTRITA DEMO" };

test("demo fixtures follow the workbook shapes and include interactive dimensions", () => {
  const workbookInputs = Object.values(DASHBOARD_DEMO_FIXTURES);
  assert.equal(workbookInputs.length, 10);
  for (const workbook of workbookInputs) {
    assert.ok(workbook.headers.length > 0, workbook.sheetName);
    assert.ok(workbook.rows.length > 0, workbook.sheetName);
    assert.equal(workbook.metadata.rowCount, workbook.rows.length, workbook.sheetName);
  }

  for (const key of ["monitoring", "taxa", "epop", "movement", "sellerPerformance", "bipagem", "damage"] as const) {
    const workbook = DASHBOARD_DEMO_FIXTURES[key];
    const dateColumn = key === "movement" ? "Horário da última operação" : workbook.dateColumn;
    assert.ok(dateColumn, `${key} date column`);
    assert.equal(new Set(workbook.rows.map((row) => String(row[dateColumn!] ?? "").slice(0, 10))).size, 3, key);
  }
});

test("monitoring and collection-rate fixtures reconcile from the same daily volumes", () => {
  const monitoring = DASHBOARD_DEMO_FIXTURES.monitoring;
  const taxa = DASHBOARD_DEMO_FIXTURES.taxa;
  const taxaByKey = new Map(taxa.rows.map((row) => [
    [row["Horário de término do prazo de coleta"], row["Nome da regional"], row["Nome da base de coleta"], row["Origem do Pedido"]].join("|"),
    row,
  ]));
  for (const row of monitoring.rows) {
    const reference = taxaByKey.get([row.Data, row["Regional Origem"], row["PDD de saída"], row["Origem do Pedido"]].join("|"));
    assert.ok(reference);
    assert.equal(row["dorp off应揽收"], reference["Qtd a coletar"]);
    assert.equal(row["dorp off待揽收"], reference["未揽收量"]);
    assert.equal(row["当前状态 网点发件流程中"], reference["揽收量"]);
    assert.equal(Number(reference["揽收量"]) + Number(reference["未揽收量"]), Number(reference["Qtd a coletar"]));
    assert.equal(Number(reference["Taxa de coleta"]), Number(reference["揽收量"]) / Number(reference["Qtd a coletar"]));
  }
});

test("seller status values reconcile and special sellers use stable synthetic IDs", () => {
  const performance = DASHBOARD_DEMO_FIXTURES.sellerPerformance;
  const componentColumns = [
    "Status atual – Recebido no Drop-off", "Status atual – Coletado", "Status atual – Recebido",
    "Status atual – Recebido na base", "Status atual – Em trânsito a partir da base", "Status atual – Chegou ao SC",
  ];
  for (const row of performance.rows) {
    const processed = componentColumns.reduce((total, header) => total + Number(row[header]), 0);
    const sellerType = String(row.Loja).split("-").at(-1);
    const awaiting = Number(row["Status atual – Aguardando coleta"]);
    if (sellerType === "1") assert.ok(processed > 0 && awaiting === 0);
    if (sellerType === "2") assert.ok(processed > 0 && awaiting > 0);
    if (sellerType === "3") assert.ok(processed === 0 && awaiting > 0);
    assert.match(String(row["Id Seller/remetente"]), /^\d{19}$/);
  }
  assert.equal(DASHBOARD_DEMO_FIXTURES.sellerSpecialList.rows.length, 6);
  assert.ok(DASHBOARD_DEMO_FIXTURES.sellerSpecialList.rows.every((row) => /^\d{19}$/.test(String(row["商家ID"]))));
});

test("bipagem, damage, and responsibility fixtures pass their existing processors", () => {
  const bipagem = buildBipagemLoadedData(DASHBOARD_DEMO_FIXTURES.bipagem, DEMO_WORKBOOK_NAME);
  const damage = buildDamageData(DASHBOARD_DEMO_FIXTURES.damage, DEMO_WORKBOOK_NAME);
  const responsibility = buildResponsibilityData(DASHBOARD_DEMO_FIXTURES.responsibilityList, DEMO_WORKBOOK_NAME);
  assert.equal(bipagem.dates.length, 3);
  assert.equal(bipagem.records.length, 36);
  assert.equal(damage.dates.length, 3);
  assert.equal(damage.records.length, 36);
  assert.equal(responsibility.records.length, 6);
});

test("regional and base demo fixtures are assigned and filtered to the authenticated scope", () => {
  for (const key of ["monitoring", "taxa", "epop", "movement", "sellerPerformance", "responsibilityList", "bipagem", "damage"] as const) {
    const regional = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES[key], regionalScope);
    const regionColumn = regional.regionColumn;
    assert.ok(regionColumn, `${key} regional column`);
    assert.ok(regional.rows.length > 0, key);
    assert.ok(regional.rows.every((row) => row[regionColumn!] === regionalScope.region), key);

    const base = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES[key], baseScope);
    const baseColumn = base.baseColumn;
    assert.ok(baseColumn, `${key} base column`);
    assert.ok(base.rows.length > 0, key);
    assert.ok(base.rows.every((row) => row[baseColumn!] === baseScope.base), key);
  }

  const regionalPerformance = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES.sellerPerformance, regionalScope);
  const regionalSellers = scopeDemoSellerReference(DASHBOARD_DEMO_FIXTURES.sellerList, regionalPerformance, regionalScope, false);
  const regionalSpecial = scopeDemoSellerReference(DASHBOARD_DEMO_FIXTURES.sellerSpecialList, regionalPerformance, regionalScope, true);
  assert.equal(regionalSellers.rows.length, 12);
  assert.equal(regionalSpecial.rows.length, 6);

  const basePerformance = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES.sellerPerformance, baseScope);
  const baseSellers = scopeDemoSellerReference(DASHBOARD_DEMO_FIXTURES.sellerList, basePerformance, baseScope, false);
  assert.equal(baseSellers.rows.length, 2);
});
