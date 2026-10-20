import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_HEADERS,
  type CollectionMonitoringV2Record,
} from "../src/lib/data-foundation/collection-monitoring-v2.ts";
import {
  filterCollectionMonitoringV2Rows,
  groupCollectionMonitoringV2Rows,
  mapCollectionMonitoringV2Record,
  summarizeCollectionMonitoringV2,
} from "../src/lib/data-foundation/collection-monitoring-v2-dashboard.ts";

function rawRecord(overrides: Partial<CollectionMonitoringV2Record> = {}): CollectionMonitoringV2Record {
  const values: Record<string, unknown> = {};
  for (const key of COLLECTION_MONITORING_V2_COLUMNS) {
    if (key === "data_date") values[key] = "2026-10-18";
    else if (["reported_origin_region", "source_base_name", "seller_collection_rate", "collection_visit_rate"].includes(key)) values[key] = null;
    else if (key === "order_origin") values[key] = "Marketplace";
    else if (["seller_collection_rate", "collection_visit_rate"].includes(key)) values[key] = 0.5;
    else values[key] = 0;
  }
  return {
    ...values,
    publication_id: "12345678-1234-5678-1234-567812345678",
    source_row_no: 2,
    resolved_base_code: null,
    effective_base_code: null,
    mapping_resolution: "MISSING_IDENTIFIER",
    effective_mapping_resolution: "MISSING_IDENTIFIER",
    mapped_region: null,
    ...overrides,
  } as CollectionMonitoringV2Record;
}

test("Monitoramento V2 mantém as 23 colunas oficiais na ordem da exportação", () => {
  assert.equal(COLLECTION_MONITORING_V2_COLUMNS.length, 23);
  assert.deepEqual(COLLECTION_MONITORING_V2_COLUMNS.map((key) => COLLECTION_MONITORING_V2_HEADERS[key]), [
    "Data", "Regional Origem", "PDD de saida", "Origem do Pedido", "Taxa de coleta do vendedor",
    "Taxa de Visita de Coleta", "Coleta Prevista Drop-off", "Coleta Prevista Pick-up",
    "Aguardando Coleta Drop-off", "Aguardando Coleta Pick-up", "Status atual – Coletado",
    "Status atual – Recebido na base", "Expedida pela Base", "Status atual – Em trânsito a partir da base",
    "网点发件在途(中心)", "网点发件在途(集散)", "Chegada ao Centro de Triagem", "Expedido pelo Centro de Triagem",
    "集散发件在途", "Status atual – Chegou ao SC", "Pacote Criado pela Base", "已处理问题件", "未处理问题件",
  ]);
});

test("four candidate indicators reproduce the supplied JMS sample without aggregating status snapshots", () => {
  const rows = Array.from({ length: 72 }, (_, index) => mapCollectionMonitoringV2Record(rawRecord({
    source_row_no: index + 2,
    reported_origin_region: `JMS region ${index % 9}`,
    expected_dropoff: 12 + (index === 0 ? 9 : 0),
    expected_pickup: 364 + (index === 0 ? 28 : 0),
    pending_dropoff: 0,
    pending_pickup: 0,
    status_collected: 99_999,
  })));
  const metrics = summarizeCollectionMonitoringV2(rows);
  assert.equal(rows.length, 72);
  assert.equal(metrics.planned, 27_109);
  assert.equal(metrics.awaiting, 0);
  assert.equal(metrics.collected, 27_109);
  assert.equal(metrics.collectionRate, 1);
  assert.equal(metrics.awaitingRate, 0);
  assert.equal(rows[0].region, "Sem regional");
  assert.equal(metrics.planned, 873 + 26_236);
});

test("only a confirmed unique DoomsDay mapping supplies organizational dimensions", () => {
  const mapped = mapCollectionMonitoringV2Record(rawRecord({
    source_base_name: "Verified base",
    reported_origin_region: "JMS says SPE",
    resolved_base_code: "BASE-1",
    effective_base_code: "BASE-1",
    mapping_resolution: "NAME_APPROVED",
    effective_mapping_resolution: "NAME_APPROVED",
    mapped_base_name: "Official base",
    mapped_region: "CE",
    mapped_rm_area: "Região CE",
    mapped_rm: "Official RM",
  }));
  const unresolved = mapCollectionMonitoringV2Record(rawRecord({
    reported_origin_region: "JMS says MATRIZ",
    source_base_name: "Unknown PDD",
    mapping_resolution: "UNMAPPED",
    effective_mapping_resolution: "UNMAPPED",
  }));
  assert.equal(mapped.region, "CE");
  assert.equal(mapped.base, "Official base");
  assert.equal(mapped.rm, "Official RM");
  assert.equal(unresolved.region, "Sem regional");
  assert.equal(unresolved.rgm, "Sem RGM");
});

test("date and origin filters keep physical records and regional summaries include unresolved only as Sem regional", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, order_origin: "Marketplace", expected_dropoff: 5 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3, data_date: "2026-10-19", order_origin: "Retail", expected_pickup: 8 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 4, order_origin: "Marketplace", expected_pickup: 4 })),
  ];
  const selected = filterCollectionMonitoringV2Rows(rows, { dateFrom: "2026-10-18", dateTo: "2026-10-18", origin: "Marketplace" });
  assert.equal(selected.length, 2);
  assert.equal(summarizeCollectionMonitoringV2(selected).planned, 9);
  assert.deepEqual(groupCollectionMonitoringV2Rows(selected, "region").map((group) => group.label), ["Sem regional"]);
  assert.equal(groupCollectionMonitoringV2Rows(selected, "region")[0].planned, 9);
});

test("zero planned volume returns unavailable rates and summaries keep the source grain", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3 })),
  ];
  const summary = summarizeCollectionMonitoringV2(rows);
  assert.equal(rows.length, 2);
  assert.equal(summary.collectionRate, null);
  assert.equal(summary.awaitingRate, null);
});
