import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_HEADERS,
  type CollectionMonitoringV2Record,
} from "../src/lib/data-foundation/collection-monitoring-v2.ts";
import {
  collectionMonitoringV2ExcelMatrix,
  collectionMonitoringV2ComparisonSlots,
  collectionMonitoringV2ComparisonValue,
  collectionMonitoringV2PercentageVariation,
  filterCollectionMonitoringV2Rows,
  groupCollectionMonitoringV2Rows,
  latestCollectionMonitoringV2Snapshot,
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

test("D-2 and D-1 compare calendar days and mark missing source dates separately", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, data_date: "2026-10-16" })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3, data_date: "2026-10-18" })),
  ];
  assert.deepEqual(collectionMonitoringV2ComparisonSlots(rows), [
    { key: "d2", date: "2026-10-16", hasRecords: true },
    { key: "d1", date: "2026-10-17", hasRecords: false },
    { key: "current", date: "2026-10-18", hasRecords: true },
  ]);
});

test("comparison values keep numeric zero distinct from missing data and pending definitions", () => {
  assert.deepEqual(collectionMonitoringV2ComparisonValue(0), { kind: "value", value: 0 });
  assert.deepEqual(collectionMonitoringV2ComparisonValue(undefined), { kind: "missing" });
  assert.deepEqual(collectionMonitoringV2ComparisonValue(null), { kind: "missing" });
});

test("approved provisional card and retention formulas match the 19 October workbook totals", () => {
  const row = mapCollectionMonitoringV2Record(rawRecord({
    data_date: "2026-10-19",
    source_row_no: 2,
    expected_dropoff: 479_523,
    expected_pickup: 2_037_439,
    pending_dropoff: 25_069,
    pending_pickup: 14_176,
    status_collected: 999_999,
    status_received_at_base: 64_212,
    status_dispatched_from_base: 24_286,
    arrived_sorting_center: 54_330,
  }));
  const metrics = summarizeCollectionMonitoringV2([row]);
  assert.equal(metrics.planned, 2_516_962);
  assert.equal(metrics.awaiting, 39_245);
  assert.equal(metrics.collected, 2_477_717);
  assert.ok(Math.abs((metrics.collectionRate ?? 0) - 0.98440779) < 0.00000001);
  assert.equal(metrics.retainedAtBase, 64_212);
  assert.equal(metrics.dispatchedFromBase, 24_286);
  assert.equal(metrics.arrivedAtCenter, 54_330);
  assert.equal(metrics.retentionTotal, 142_828);
});

test("current indicators use the latest snapshot in the selected period, not sums across dates", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, data_date: "2026-10-18", expected_dropoff: 900, pending_dropoff: 90 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3, data_date: "2026-10-19", expected_dropoff: 100, pending_dropoff: 10 })),
  ];
  const snapshot = latestCollectionMonitoringV2Snapshot(rows);
  assert.equal(snapshot.date, "2026-10-19");
  assert.equal(snapshot.rows.length, 1);
  assert.equal(summarizeCollectionMonitoringV2(snapshot.rows).planned, 100);
  assert.equal(summarizeCollectionMonitoringV2(snapshot.rows).awaiting, 10);
});

test("regional and RM grouping reconciles all rows and keeps same-name RMs separate", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 2, expected_dropoff: 20, pending_dropoff: 2, status_received_at_base: 3,
      source_base_name: "CE base", resolved_base_code: "CE-1", effective_base_code: "CE-1",
      mapping_resolution: "NAME_APPROVED", effective_mapping_resolution: "NAME_APPROVED",
      mapped_region: "CE", mapped_rm_area: "RM Norte", mapped_rm: "Alex",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 3, expected_pickup: 30, pending_pickup: 3, status_dispatched_from_base: 4,
      source_base_name: "MG base", resolved_base_code: "MG-1", effective_base_code: "MG-1",
      mapping_resolution: "NAME_APPROVED", effective_mapping_resolution: "NAME_APPROVED",
      mapped_region: "MG", mapped_rm_area: "RM Sul", mapped_rm: "Alex",
    })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 4, expected_pickup: 5, pending_pickup: 1, arrived_sorting_center: 6 })),
  ];
  const total = summarizeCollectionMonitoringV2(rows);
  const regions = groupCollectionMonitoringV2Rows(rows, "region");
  const rms = groupCollectionMonitoringV2Rows(rows, "rm");
  assert.equal(regions.length, 3);
  assert.equal(regions.reduce((sum, group) => sum + group.planned, 0), total.planned);
  assert.equal(regions.reduce((sum, group) => sum + group.retentionTotal, 0), total.retentionTotal);
  assert.equal(regions.find((group) => group.region === "Sem regional")?.planned, 5);
  assert.equal(rms.filter((group) => group.rm === "Alex").length, 2);
  assert.equal(rms.reduce((sum, group) => sum + group.awaiting, 0), total.awaiting);
});

test("percentage variation requires a nonzero prior snapshot and treats zero as a value", () => {
  assert.equal(collectionMonitoringV2PercentageVariation(0, 20), -1);
  assert.equal(collectionMonitoringV2PercentageVariation(30, 20), 0.5);
  assert.equal(collectionMonitoringV2PercentageVariation(30, 0), null);
  assert.equal(collectionMonitoringV2PercentageVariation(undefined, 20), null);
});

test("Excel export retains numeric quantities and all official columns", () => {
  const row = mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, expected_pickup: 40_185 }));
  const matrix = collectionMonitoringV2ExcelMatrix([row]);
  assert.equal(matrix[0]?.length, 23);
  assert.equal(matrix[1]?.length, 23);
  assert.equal(matrix[1]?.[7], 40_185);
});
