import assert from "node:assert/strict";
import test from "node:test";

import {
  collectionRateV3ExcelNumberFormat,
  collectionRateV3ExcelValue,
  collectionRateV3FilterOptions,
  filterCollectionRateV3Rows,
  formatCollectionRateV3Cell,
  mapCollectionRateV3Record,
  summarizeCollectionRateV3,
} from "../src/lib/data-foundation/collection-rate-v3-dashboard.ts";
import {
  COLLECTION_RATE_V3_COLUMNS,
  COLLECTION_RATE_V3_HEADERS,
  type CollectionRateV3Record,
} from "../src/lib/data-foundation/collection-rate-v3.ts";

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
