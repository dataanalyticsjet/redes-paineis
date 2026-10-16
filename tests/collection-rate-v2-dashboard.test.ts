import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionRateV2ExcelNumberFormat,
  collectionRateV2ExcelValue,
  collectionRateV2FilterOptions,
  filterCollectionRateV2Rows,
  formatCollectionRateV2Cell,
  groupCollectionRateV2Rows,
  mapCollectionRateV2Record,
  summarizeCollectionRateV2,
  summarizeCollectionRateV2Daily,
  summarizeCollectionRateV2Monthly,
  summarizeCollectionRateV2Origins,
} from "../src/lib/data-foundation/collection-rate-v2-dashboard.ts";
import {
  COLLECTION_RATE_V2_COLUMNS,
  COLLECTION_RATE_V2_HEADERS,
  type CollectionRateV2Record,
} from "../src/lib/data-foundation/collection-rate-v2.ts";

function sourceRow(rowNo: number, overrides: Partial<CollectionRateV2Record> = {}): CollectionRateV2Record {
  return {
    data_date: "2026-10-13",
    source_region_code: "REG-01",
    reported_region: "Regional original do Excel",
    source_base_code: "00123",
    source_base_name: "Base original",
    order_origin_code: "D67",
    order_origin: "TikTok",
    product_type_code: "EZ",
    product_type: "EZ",
    total_orders: 100,
    quantity_to_collect: 100,
    cancelled_orders: 0,
    collection_rate_reported: "0.5",
    collected_quantity: 50,
    not_collected_quantity: 50,
    not_collected_deadline_pending: 0,
    collected_on_time_quantity: 45,
    not_collected_after_deadline: 0,
    collected_after_deadline: 0,
    collection_on_time_rate_reported: "0.45",
    attempts_on_time_pending: 60,
    punctuality_rate_pending: "0.6",
    average_collection_pending: "1.25",
    problem_quantity: 0,
    no_problem_quantity: 0,
    seller_collection_rate_pending: "0",
    expected_shop_quantity_pending: 0,
    unexpected_shop_quantity_pending: 0,
    publication_id: "publication-v2",
    source_row_no: rowNo,
    resolved_base_code: "00123",
    mapping_resolution: "CODE_MATCH",
    effective_base_code: "00123",
    effective_mapping_resolution: "CODE_MATCH",
    mapped_base_name: "Base oficial",
    mapped_region: "SPE",
    mapped_uf: "SP",
    mapped_rm_area: "SP Capital",
    mapped_rm: "RM aprovado",
    ...overrides,
  } as CollectionRateV2Record;
}

test("Taxa V2 mantém as 28 colunas oficiais na ordem do contrato", () => {
  assert.equal(COLLECTION_RATE_V2_COLUMNS.length, 28);
  assert.deepEqual(COLLECTION_RATE_V2_COLUMNS.map((field) => COLLECTION_RATE_V2_HEADERS[field]), [
    "Data de referência", "Código da regional", "Regional", "Código da base de coleta", "Base de coleta",
    "Código da origem do pedido", "Origem do pedido", "Código do tipo de encomenda", "Tipo de encomenda",
    "Total de pedidos", "Quantidade prevista para coleta", "Total de cancelamentos", "Taxa de coleta",
    "Quantidade coletada", "Quantidade não coletada", "Não coletados — indicador de prazo", "Coletas no prazo",
    "Não coletados fora do prazo", "Coletas fora do prazo", "Taxa de coleta no prazo", "Tentativas de coleta no prazo",
    "Taxa de pontualidade", "Média de coleta", "Quantidade com problema", "Quantidade sem problema",
    "Taxa relacionada à loja", "Quantidade prevista — loja", "Quantidade não prevista — loja",
  ]);
});

test("Taxa de coleta agregada é ponderada por quantidade coletada e prevista", () => {
  const rows = [
    mapCollectionRateV2Record(sourceRow(2, { quantity_to_collect: 100, collected_quantity: 100, collected_on_time_quantity: 80 })),
    mapCollectionRateV2Record(sourceRow(3, { quantity_to_collect: 100, collected_quantity: 1, collected_on_time_quantity: 20 })),
  ];
  const summary = summarizeCollectionRateV2(rows);
  assert.equal(summary.totalOrders, 200);
  assert.equal(summary.planned, 200);
  assert.equal(summary.collected, 101);
  assert.equal(summary.collectionRate, 101 / 200);
  assert.equal(summary.onTimeRate, 100 / 200);
});

test("linhas sem código aprovado permanecem Sem regional e preservam os volumes", () => {
  const row = mapCollectionRateV2Record(sourceRow(2, {
    source_base_code: "-",
    source_base_name: null,
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    effective_base_code: null,
    effective_mapping_resolution: "UNMAPPED",
    mapped_region: null,
    mapped_rm_area: null,
    mapped_rm: null,
  }));
  assert.equal(row.region, "Sem regional");
  assert.equal(row.rm, "Sem RM");
  assert.equal(row.base, "-");
  assert.equal(summarizeCollectionRateV2([row]).planned, 100);
});

test("filtros combinados preservam dimensões organizacionais e origem", () => {
  const rows = [
    mapCollectionRateV2Record(sourceRow(2)),
    mapCollectionRateV2Record(sourceRow(3, { order_origin: "TEMU D2D" })),
  ];
  const options = collectionRateV2FilterOptions(rows);
  assert.deepEqual(options.regions, ["SPE"]);
  const filtered = filterCollectionRateV2Rows(rows, {
    regions: new Set(["SPE"]),
    rms: new Set(["RM aprovado"]),
    rmAreas: new Set(["SP Capital"]),
    rgms: new Set([rows[0].rgm]),
    bases: new Set(["Base oficial"]),
    origins: new Set(["TEMU D2D"]),
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].source_row_no, 3);
});

test("resumos regional e RM contam bases distintas sem multiplicar linhas", () => {
  const rows = [
    mapCollectionRateV2Record(sourceRow(2)),
    mapCollectionRateV2Record(sourceRow(3, { quantity_to_collect: 30, collected_quantity: 20 })),
  ];
  const region = groupCollectionRateV2Rows(rows, "region");
  const rm = groupCollectionRateV2Rows(rows, "rmArea");
  assert.equal(region.length, 1);
  assert.equal(region[0].baseCount, 1);
  assert.equal(region[0].planned, 130);
  assert.equal(region[0].totalOrders, 200);
  assert.equal(rm.length, 1);
  assert.equal(rm[0].rm, "RM aprovado");
  assert.equal(rm[0].planned, 130);
});

test("resumos por origem, dia e mês usam quantidades e só datas existentes", () => {
  const rows = [
    mapCollectionRateV2Record(sourceRow(2, { quantity_to_collect: 100, collected_quantity: 100 })),
    mapCollectionRateV2Record(sourceRow(3, { data_date: "2026-10-14", quantity_to_collect: 100, collected_quantity: 0, order_origin: "TEMU D2D" })),
  ];
  assert.equal(summarizeCollectionRateV2Origins(rows)[0].planned, 100);
  assert.deepEqual(summarizeCollectionRateV2Daily(rows).map((item) => item.date), ["2026-10-13", "2026-10-14"]);
  assert.equal(summarizeCollectionRateV2Monthly(rows)[0].collectionRate, 0.5);
  assert.equal(summarizeCollectionRateV2Monthly(rows).length, 1);
});

test("exportação mantém quantidades e taxas como números e formata colunas por tipo", () => {
  const row = sourceRow(2);
  assert.equal(collectionRateV2ExcelValue(row.quantity_to_collect, "quantity_to_collect"), 100);
  assert.equal(collectionRateV2ExcelValue(row.collection_rate_reported, "collection_rate_reported"), 0.5);
  assert.equal(collectionRateV2ExcelNumberFormat("collection_rate_reported"), "0.00%");
  assert.equal(collectionRateV2ExcelNumberFormat("quantity_to_collect"), "#,##0");
  assert.match(formatCollectionRateV2Cell("2026-10-13", "data_date", "pt-BR"), /13/);
  assert.equal(formatCollectionRateV2Cell("0.7319", "collection_rate_reported", "pt-BR"), "73,19%");
  assert.equal(formatCollectionRateV2Cell("123456", "quantity_to_collect", "pt-BR"), "123.456");
});
