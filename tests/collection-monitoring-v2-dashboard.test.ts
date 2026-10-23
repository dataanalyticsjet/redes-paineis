import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_HEADERS,
  type CollectionMonitoringV2Record,
} from "../src/lib/data-foundation/collection-monitoring-v2.ts";
import {
  collectionMonitoringV2BaseDetailMatrix,
  collectionMonitoringV2ExcelMatrix,
  collectionMonitoringV2ComparisonSlots,
  collectionMonitoringV2ComparisonValue,
  collectionMonitoringV2PercentageVariation,
  collectionMonitoringV2RegionalStatusGroups,
  collectionMonitoringV2RegionalSummaryMatrix,
  collectionMonitoringV2RmSummaryMatrix,
  filterCollectionMonitoringV2Rows,
  groupCollectionMonitoringV2BaseDetails,
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

test("cards use the approved L/O/P/T grouping and derive rates from aggregate sums", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({
      data_date: "2026-10-22", source_row_no: 2, status_received_at_base: 10_000,
      in_transit_to_center: 20_000, in_transit_to_distribution: 10_000, arrived_sc: 100_000,
      status_in_transit_from_base: 700_000, expected_dropoff: 1_000_000,
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      data_date: "2026-10-22", source_row_no: 3, status_received_at_base: 25_029,
      in_transit_to_center: 44_323, in_transit_to_distribution: 5_404, arrived_sc: 697_192,
      status_in_transit_from_base: 900_000, expected_dropoff: 2_000_000,
    })),
  ];
  const metrics = summarizeCollectionMonitoringV2(rows);
  assert.equal(metrics.planned, 911_948);
  assert.equal(metrics.awaiting, 79_727);
  assert.equal(metrics.collected, 832_221);
  assert.equal(metrics.collectionRate, 832_221 / 911_948);
  assert.equal(metrics.awaitingRate, 79_727 / 911_948);
  assert.equal(Number((metrics.collectionRate! * 100).toFixed(2)), 91.26);
  assert.equal(Number((metrics.awaitingRate! * 100).toFixed(2)), 8.74);
  assert.notEqual(metrics.collectionRate, (110_000 / 140_000 + 722_221 / 771_948) / 2);
  assert.equal(metrics.retention, 35_029);
  assert.equal(metrics.inTransitToBase, 1_679_727);
  assert.equal(rows[0].region, "Sem regional");
});

test("contract positions for the approved operational card fields remain official", () => {
  assert.equal(COLLECTION_MONITORING_V2_COLUMNS[11], "status_received_at_base");
  assert.equal(COLLECTION_MONITORING_V2_COLUMNS[14], "in_transit_to_center");
  assert.equal(COLLECTION_MONITORING_V2_COLUMNS[15], "in_transit_to_distribution");
  assert.equal(COLLECTION_MONITORING_V2_COLUMNS[19], "arrived_sc");
});

test("dashboard keeps the four approved card values dynamic after legacy operational sections are removed", async () => {
  const source = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url), "utf8");
  assert.match(source, /title: "Previsto a coletar", value: number\(metrics\.planned\)/);
  assert.match(source, /title: "Aguardando coleta", value: number\(metrics\.awaiting\)/);
  assert.match(source, /title: "Taxa de coleta", value: percent\(metrics\.collectionRate\)/);
  assert.match(source, /title: "Taxa de pedidos aguardando coleta", value: percent\(metrics\.awaitingRate\)/);
  assert.match(source, /summarizeCollectionMonitoringV2\(currentRows\)/);
  assert.match(source, /<CollectionMonitoringV2RetentionTables/);
  assert.doesNotMatch(source, /Monitoramento por regional|Monitoramento por RM|Total por regional e status|Dados por base/);
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
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, order_origin: "Marketplace", expected_dropoff: 5, status_received_at_base: 2, arrived_sc: 3 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3, data_date: "2026-10-19", order_origin: "Retail", expected_pickup: 8 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 4, order_origin: "Marketplace", expected_pickup: 4, in_transit_to_center: 1, in_transit_to_distribution: 3 })),
  ];
  const selected = filterCollectionMonitoringV2Rows(rows, { dateFrom: "2026-10-18", dateTo: "2026-10-18", origin: "Marketplace" });
  assert.equal(selected.length, 2);
  assert.equal(summarizeCollectionMonitoringV2(selected).planned, 9);
  assert.deepEqual(groupCollectionMonitoringV2Rows(selected, "region").map((group) => group.label), ["Sem regional"]);
  assert.equal(groupCollectionMonitoringV2Rows(selected, "region")[0].operationalPlanned, 9);
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

test("approved card metrics read receipt and transit V2 columns while retention uses its independent denominator", () => {
  const row = mapCollectionMonitoringV2Record(rawRecord({
    data_date: "2026-10-22",
    source_row_no: 2,
    expected_dropoff: 479_523,
    expected_pickup: 2_037_439,
    status_collected: 999_999,
    status_received_at_base: 64_212,
    status_dispatched_from_base: 24_286,
    status_in_transit_from_base: 800_000,
    in_transit_to_center: 25_069,
    in_transit_to_distribution: 14_176,
    arrived_sc: 54_330,
  }));
  const metrics = summarizeCollectionMonitoringV2([row]);
  assert.equal(metrics.planned, 157_787);
  assert.equal(metrics.awaiting, 39_245);
  assert.equal(metrics.collected, 118_542);
  assert.equal(metrics.collectionRate, 118_542 / 157_787);
  assert.equal(metrics.awaitingRate, 39_245 / 157_787);
  assert.equal(metrics.retention, 64_212);
  assert.equal(metrics.dispatchedFromBase, 24_286);
  assert.equal(metrics.inTransitToBase, 839_245);
  assert.equal(metrics.retentionRate, 64_212 / 2_516_962);
});

test("current indicators use the latest snapshot in the selected period, not sums across dates", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 2, data_date: "2026-10-21", expected_dropoff: 900, pending_dropoff: 90, status_received_at_base: 900, arrived_sc: 900 })),
    mapCollectionMonitoringV2Record(rawRecord({ source_row_no: 3, data_date: "2026-10-22", expected_dropoff: 100, pending_dropoff: 10, in_transit_to_center: 7, in_transit_to_distribution: 3, arrived_sc: 90 })),
  ];
  const snapshot = latestCollectionMonitoringV2Snapshot(rows);
  assert.equal(snapshot.date, "2026-10-22");
  assert.equal(snapshot.rows.length, 1);
  assert.equal(summarizeCollectionMonitoringV2(snapshot.rows).planned, 100);
  assert.equal(summarizeCollectionMonitoringV2(snapshot.rows).awaiting, 10);
  assert.equal(summarizeCollectionMonitoringV2(snapshot.rows).collected, 90);
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
  assert.equal(regions.reduce((sum, group) => sum + group.operationalPlanned, 0), total.planned);
  assert.equal(regions.reduce((sum, group) => sum + group.retention, 0), total.retention);
  assert.equal(regions.find((group) => group.region === "Sem regional")?.planned, 5);
  assert.equal(rms.filter((group) => group.rm === "Alex").length, 2);
  assert.equal(rms.reduce((sum, group) => sum + group.operationalAwaiting, 0), total.awaiting);
});

test("approved collection formula reconciles cards, regional/RM tables, base detail and summary exports", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 2, data_date: "2026-10-22", order_origin: "Marketplace", source_base_name: "CE Base",
      expected_dropoff: 1_000_000, pending_dropoff: 10_000, status_collected: 1_200_000,
      status_received_at_base: 10_000, in_transit_to_center: 20_000, in_transit_to_distribution: 10_000, arrived_sc: 100_000,
      resolved_base_code: "CE-1", effective_base_code: "CE-1", mapping_resolution: "NAME_APPROVED",
      effective_mapping_resolution: "NAME_APPROVED", mapped_base_name: "CE Base oficial", mapped_region: "CE",
      mapped_rm_area: "RM Nordeste", mapped_rm: "Ana",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 3, data_date: "2026-10-22", order_origin: "Marketplace", source_base_name: "MG Base",
      expected_dropoff: 2_000_000, pending_dropoff: 20_000, status_collected: 2_094_897,
      status_received_at_base: 20_000, in_transit_to_center: 40_000, in_transit_to_distribution: 5_000, arrived_sc: 600_000,
      resolved_base_code: "MG-1", effective_base_code: "MG-1", mapping_resolution: "NAME_APPROVED",
      effective_mapping_resolution: "NAME_APPROVED", mapped_base_name: "MG Base oficial", mapped_region: "MG",
      mapped_rm_area: "RM Sudeste", mapped_rm: "Bruno",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 4, data_date: "2026-10-22", order_origin: "Marketplace", source_base_name: "Base sem vínculo",
      reported_origin_region: "SPE", expected_pickup: 328_879, pending_pickup: 18_904, status_collected: 300_000,
      status_received_at_base: 5_029, in_transit_to_center: 4_323, in_transit_to_distribution: 404, arrived_sc: 97_192,
      mapping_resolution: "UNMAPPED", effective_mapping_resolution: "UNMAPPED",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 5, data_date: "2026-10-21", order_origin: "Retail", expected_dropoff: 900_000,
      pending_dropoff: 100_000, status_collected: 950_000, status_received_at_base: 90_000, arrived_sc: 700_000,
    })),
  ];
  const selected = filterCollectionMonitoringV2Rows(rows, {
    dateFrom: "2026-10-22", dateTo: "2026-10-22", origin: "Marketplace",
  });
  const metrics = summarizeCollectionMonitoringV2(selected);
  const regions = groupCollectionMonitoringV2Rows(selected, "region");
  const rms = groupCollectionMonitoringV2Rows(selected, "rm");
  const details = groupCollectionMonitoringV2BaseDetails(selected);
  const regionalExport = collectionMonitoringV2RegionalSummaryMatrix(regions, metrics, 2, (label) => label);
  const rmExport = collectionMonitoringV2RmSummaryMatrix(rms, metrics, 2, (label) => label);
  const detailExport = collectionMonitoringV2BaseDetailMatrix(details, (label) => label);

  assert.equal(selected.length, 3);
  assert.equal(metrics.planned, 911_948);
  assert.equal(metrics.awaiting, 79_727);
  assert.equal(metrics.collected, 832_221);
  assert.equal(metrics.collectionRate, 832_221 / 911_948);
  assert.equal(metrics.awaitingRate, 79_727 / 911_948);
  assert.equal(Number((metrics.collectionRate! * 100).toFixed(2)), 91.26);
  assert.equal(Number((metrics.awaitingRate! * 100).toFixed(2)), 8.74);
  assert.equal(metrics.retention, 35_029);

  for (const groups of [regions, rms]) {
    assert.equal(groups.reduce((sum, group) => sum + group.operationalPlanned, 0), metrics.planned);
    assert.equal(groups.reduce((sum, group) => sum + group.operationalAwaiting, 0), metrics.awaiting);
    assert.equal(groups.reduce((sum, group) => sum + group.operationalCollected, 0), metrics.collected);
  }
  assert.equal(regions.find((group) => group.region === "Sem regional")?.operationalPlanned, 106_948);
  assert.equal(regions.reduce((sum, group) => sum + group.planned, 0), 3_328_879);
  assert.equal(regions.reduce((sum, group) => sum + group.collected, 0), 3_594_897);

  assert.deepEqual(regionalExport.at(-1)?.slice(3, 6), [metrics.planned, metrics.awaiting, metrics.collected]);
  assert.deepEqual(rmExport.at(-1)?.slice(4, 7), [metrics.planned, metrics.awaiting, metrics.collected]);
  assert.deepEqual(regionalExport.slice(1, -1).map((row) => row.slice(3, 6)), regions.map((group) => [group.operationalPlanned, group.operationalAwaiting, group.operationalCollected]));
  assert.deepEqual(rmExport.slice(1, -1).map((row) => row.slice(4, 7)), rms.map((group) => [group.operationalPlanned, group.operationalAwaiting, group.operationalCollected]));
  assert.deepEqual(detailExport.slice(1).reduce<number[]>((totals, row) => [
    totals[0] + Number(row[6]), totals[1] + Number(row[7]), totals[2] + Number(row[8]),
  ], [0, 0, 0]), [metrics.planned, metrics.awaiting, metrics.collected]);
  assert.equal(details.reduce((sum, row) => sum + row.collected, 0), metrics.collected);
  assert.equal(details.reduce((sum, row) => sum + row.retention, 0), metrics.retention);

  const narrowed = filterCollectionMonitoringV2Rows(selected, {
    region: "CE", rm: "Ana", base: "CE Base oficial", origin: "Marketplace",
  });
  const narrowedMetrics = summarizeCollectionMonitoringV2(narrowed);
  const narrowedRegion = groupCollectionMonitoringV2Rows(narrowed, "region");
  const narrowedRm = groupCollectionMonitoringV2Rows(narrowed, "rm");
  const narrowedDetail = groupCollectionMonitoringV2BaseDetails(narrowed);
  assert.deepEqual(
    [narrowedRegion[0]?.operationalPlanned, narrowedRegion[0]?.operationalAwaiting, narrowedRegion[0]?.operationalCollected],
    [narrowedMetrics.planned, narrowedMetrics.awaiting, narrowedMetrics.collected],
  );
  assert.deepEqual(
    [narrowedRm[0]?.operationalPlanned, narrowedRm[0]?.operationalAwaiting, narrowedRm[0]?.operationalCollected],
    [narrowedMetrics.planned, narrowedMetrics.awaiting, narrowedMetrics.collected],
  );
  assert.deepEqual(
    [narrowedDetail[0]?.planned, narrowedDetail[0]?.awaiting, narrowedDetail[0]?.collected],
    [narrowedMetrics.planned, narrowedMetrics.awaiting, narrowedMetrics.collected],
  );
  assert.deepEqual([narrowedMetrics.planned, narrowedMetrics.awaiting, narrowedMetrics.collected], [140_000, 30_000, 110_000]);
});

test("base detail summary keeps daily snapshots separate and exports ten numeric columns", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 2, source_base_name: "CE base", order_origin: "Marketplace", expected_dropoff: 20,
      pending_dropoff: 2, status_collected: 15, status_received_at_base: 3, in_transit_to_center: 2, in_transit_to_distribution: 1, arrived_sc: 4, resolved_base_code: "CE-1", effective_base_code: "CE-1",
      mapping_resolution: "NAME_APPROVED", effective_mapping_resolution: "NAME_APPROVED", mapped_region: "CE",
      mapped_rm_area: "RM Norte", mapped_rm: "Alex",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 3, source_base_name: "CE base", order_origin: "Marketplace", expected_dropoff: 5,
      pending_dropoff: 1, status_collected: 7, status_dispatched_from_base: 4, in_transit_to_center: 1, in_transit_to_distribution: 1, resolved_base_code: "CE-1", effective_base_code: "CE-1",
      mapping_resolution: "NAME_APPROVED", effective_mapping_resolution: "NAME_APPROVED", mapped_region: "CE",
      mapped_rm_area: "RM Norte", mapped_rm: "Alex",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 4, data_date: "2026-10-19", source_base_name: "CE base", order_origin: "Marketplace",
      expected_dropoff: 10, status_received_at_base: 2, arrived_sc: 5, resolved_base_code: "CE-1", effective_base_code: "CE-1",
      mapping_resolution: "NAME_APPROVED", effective_mapping_resolution: "NAME_APPROVED", mapped_region: "CE",
      mapped_rm_area: "RM Norte", mapped_rm: "Alex",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 5, source_base_name: "Unmapped base", order_origin: "Marketplace", expected_pickup: 7,
      status_received_at_base: 1, in_transit_to_center: 2, arrived_sc: 3,
    })),
  ];

  const summary = groupCollectionMonitoringV2BaseDetails(rows);
  assert.equal(summary.length, 3);
  assert.equal(summary.find((item) => item.period === "2026-10-18" && item.region === "CE")?.planned, 12);
  assert.equal(summary.find((item) => item.period === "2026-10-18" && item.region === "CE")?.awaiting, 5);
  assert.equal(summary.find((item) => item.period === "2026-10-18" && item.region === "CE")?.collected, 7);
  assert.equal(summary.find((item) => item.period === "2026-10-18" && item.region === "CE")?.retention, 3);
  assert.equal(summary.find((item) => item.region === "Sem regional")?.base, "Unmapped base");

  const matrix = collectionMonitoringV2BaseDetailMatrix(summary, (label) => label);
  assert.equal(matrix[0]?.length, 10);
  assert.equal(matrix[1]?.length, 10);
  assert.equal(matrix.find((line) => line[0] === "2026-10-18" && line[1] === "CE")?.[6], 12);
  assert.equal(matrix.find((line) => line[0] === "2026-10-18" && line[1] === "CE")?.[9], 3);
});

test("regional movement summary uses the four defined indicators and exact transit components", () => {
  const rows = [
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 2, source_base_name: "CE base", expected_dropoff: 100,
      status_received_at_base: 10, status_dispatched_from_base: 5, arrived_sorting_center: 5,
      status_collected: 20, status_in_transit_from_base: 1_000, in_transit_to_center: 2_000,
      in_transit_to_distribution: 3_000, arrived_sc: 2_000,
      resolved_base_code: "CE-1", effective_base_code: "CE-1", mapping_resolution: "NAME_APPROVED",
      effective_mapping_resolution: "NAME_APPROVED", mapped_region: "CE",
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 3, source_base_name: "Unmapped base", reported_origin_region: "JMS says SPE",
      status_received_at_base: 4,
    })),
    mapCollectionMonitoringV2Record(rawRecord({
      source_row_no: 4, source_base_name: "No retention movement", expected_dropoff: 500,
      status_in_transit_from_base: 400, in_transit_to_center: 200, in_transit_to_distribution: 100, arrived_sc: 300,
      resolved_base_code: "MG-1", effective_base_code: "MG-1", mapping_resolution: "NAME_APPROVED",
      effective_mapping_resolution: "NAME_APPROVED", mapped_region: "MG",
    })),
  ];

  const groups = collectionMonitoringV2RegionalStatusGroups(rows);
  assert.deepEqual(groups.map((group) => group.region), ["CE", "MG", "Sem regional"]);
  assert.deepEqual(groups[0]?.components.map((item) => item.field), [
    "retention", "dispatchedFromBase", "inTransitToBase", "collected",
  ]);
  assert.equal(groups[0]?.collected, 20, "status summary keeps the raw status_collected value");
  assert.equal(groups[0]?.componentTotal, 6_035);
  assert.equal(groups[0]?.basesWithMovement, 1);
  assert.equal(groups[2]?.region, "Sem regional");
  assert.equal(groups[2]?.componentTotal, 4);
  assert.equal(groups[2]?.basesWithMovement, 1);
  assert.equal(groups.find((group) => group.region === "MG")?.inTransitToBase, 700);
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
