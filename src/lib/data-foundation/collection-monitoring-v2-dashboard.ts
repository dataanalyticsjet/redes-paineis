import { isOperationalMappedBase } from "./mapping-revision.ts";
import { officialRgmForRegion, UNASSIGNED_RGM, UNASSIGNED_RM, UNASSIGNED_RM_AREA } from "../responsibility.ts";
import { COLLECTION_MONITORING_V2_COLUMNS, COLLECTION_MONITORING_V2_HEADERS, type CollectionMonitoringV2Record } from "./collection-monitoring-v2.ts";

export interface CollectionMonitoringV2Row extends CollectionMonitoringV2Record {
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  base: string;
  baseCode: string;
  origin: string;
  mappingConfirmed: boolean;
}

export interface CollectionMonitoringV2Filters {
  dateFrom?: string;
  dateTo?: string;
  region?: string;
  rm?: string;
  rmArea?: string;
  rgm?: string;
  base?: string;
  origin?: string;
}

export interface CollectionMonitoringV2Metrics {
  planned: number;
  awaiting: number;
  collected: number;
  collectionRate: number | null;
  awaitingRate: number | null;
  retention: number;
  dispatchedFromBase: number;
  inTransitToBase: number;
  retentionRate: number | null;
  dispatchedFromBaseRate: number | null;
  inTransitToBaseRate: number | null;
}

export const COLLECTION_MONITORING_V2_STATUS_FIELDS = [
  { field: "retention", label: "Retenção" },
  { field: "dispatchedFromBase", label: "Despachado pela base" },
  { field: "inTransitToBase", label: "Em trânsito para a base" },
  { field: "collected", label: "Coletado" },
] as const;
export type CollectionMonitoringV2StatusField = typeof COLLECTION_MONITORING_V2_STATUS_FIELDS[number]["field"];

export interface CollectionMonitoringV2Group extends CollectionMonitoringV2Metrics {
  label: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  baseCount: number;
  /** Approved operational card/table metrics; separate from the legacy retention view. */
  operationalPlanned: number;
  operationalAwaiting: number;
  operationalCollected: number;
  operationalCollectionRate: number | null;
  operationalAwaitingRate: number | null;
}

export interface CollectionMonitoringV2BaseDetail {
  period: string;
  region: string;
  base: string;
  origin: string;
  rmArea: string;
  rm: string;
  rgm: string;
  planned: number;
  awaiting: number;
  collected: number;
  retention: number;
}

export interface CollectionMonitoringV2StatusComponent {
  field: CollectionMonitoringV2StatusField;
  label: string;
  value: number;
}

export interface CollectionMonitoringV2RegionalStatusGroup extends CollectionMonitoringV2Group {
  basesWithMovement: number;
  componentTotal: number;
  components: CollectionMonitoringV2StatusComponent[];
}

export interface CollectionMonitoringV2ComparisonSlot {
  key: "d2" | "d1" | "current";
  date: string;
  hasRecords: boolean;
}

export type CollectionMonitoringV2ComparisonValue =
  | { kind: "value"; value: number }
  | { kind: "missing" };

const toText = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
const toQuantity = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const uniqueSorted = (items: Iterable<string>): string[] =>
  [...new Set([...items].filter(Boolean))].sort((left, right) => left.localeCompare(right, "pt-BR"));

export function mapCollectionMonitoringV2Record(record: CollectionMonitoringV2Record): CollectionMonitoringV2Row {
  const resolution = toText(record.effective_mapping_resolution ?? record.mapping_resolution);
  const code = toText(record.effective_base_code ?? record.resolved_base_code);
  const mappingConfirmed = resolution === "NAME_APPROVED" && Boolean(code);
  const region = mappingConfirmed ? toText(record.mapped_region) || "Sem regional" : "Sem regional";
  return {
    ...record,
    region,
    rmArea: mappingConfirmed ? toText(record.mapped_rm_area) || UNASSIGNED_RM_AREA : UNASSIGNED_RM_AREA,
    rm: mappingConfirmed ? toText(record.mapped_rm) || UNASSIGNED_RM : UNASSIGNED_RM,
    rgm: mappingConfirmed ? officialRgmForRegion(region) ?? UNASSIGNED_RGM : UNASSIGNED_RGM,
    base: mappingConfirmed ? toText(record.mapped_base_name) || toText(record.source_base_name) || "Sem base" : toText(record.source_base_name) || "Sem base",
    baseCode: mappingConfirmed ? code : "—",
    origin: toText(record.order_origin) || "Sem origem",
    mappingConfirmed,
  };
}

export function filterCollectionMonitoringV2Rows(
  rows: readonly CollectionMonitoringV2Row[],
  filters: CollectionMonitoringV2Filters,
): CollectionMonitoringV2Row[] {
  return rows.filter((row) => {
    const date = String(row.data_date ?? "").slice(0, 10);
    return (!filters.dateFrom || date >= filters.dateFrom) &&
      (!filters.dateTo || date <= filters.dateTo) &&
      (!filters.region || row.region === filters.region) &&
      (!filters.rm || row.rm === filters.rm) &&
      (!filters.rmArea || row.rmArea === filters.rmArea) &&
      (!filters.rgm || row.rgm === filters.rgm) &&
      (!filters.base || row.base === filters.base) &&
      (!filters.origin || row.origin === filters.origin);
  });
}

export function summarizeCollectionMonitoringV2(rows: readonly CollectionMonitoringV2Row[]): CollectionMonitoringV2Metrics {
  // Approved JMS-reference grouping for the operational cards: L + O + P + T,
  // O + P, and L + T. This is a grouping of receipt and post-collection transit
  // states; it is not asserted to be equivalent to the original JMS field names.
  const planned = rows.reduce((sum, row) => sum + toQuantity(row.status_received_at_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution) + toQuantity(row.arrived_sc), 0);
  const awaiting = rows.reduce((sum, row) => sum + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution), 0);
  const collected = rows.reduce((sum, row) => sum + toQuantity(row.status_received_at_base) + toQuantity(row.arrived_sc), 0);
  const retentionDenominator = rows.reduce((sum, row) => sum + toQuantity(row.expected_dropoff) + toQuantity(row.expected_pickup), 0);
  const retention = rows.reduce((sum, row) => sum + toQuantity(row.status_received_at_base), 0);
  const dispatchedFromBase = rows.reduce((sum, row) => sum + toQuantity(row.status_dispatched_from_base), 0);
  const inTransitToBase = rows.reduce((sum, row) => sum + toQuantity(row.status_in_transit_from_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution), 0);
  const rate = (value: number) => planned > 0 ? value / planned : null;
  const retentionRate = (value: number) => retentionDenominator > 0 ? value / retentionDenominator : null;
  return {
    planned,
    awaiting,
    collected,
    collectionRate: rate(collected),
    awaitingRate: rate(awaiting),
    retention,
    dispatchedFromBase,
    inTransitToBase,
    retentionRate: retentionRate(retention),
    dispatchedFromBaseRate: retentionRate(dispatchedFromBase),
    inTransitToBaseRate: retentionRate(inTransitToBase),
  };
}

export function collectionMonitoringV2RowsForDate(
  rows: readonly CollectionMonitoringV2Row[],
  date: string | undefined,
): CollectionMonitoringV2Row[] {
  if (!date) return [];
  return rows.filter((row) => String(row.data_date ?? "").slice(0, 10) === date);
}

export function latestCollectionMonitoringV2Snapshot(
  rows: readonly CollectionMonitoringV2Row[],
): { date: string | null; rows: CollectionMonitoringV2Row[] } {
  const latestDate = rows
    .map((row) => String(row.data_date ?? "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
    .at(-1) ?? null;
  return { date: latestDate, rows: collectionMonitoringV2RowsForDate(rows, latestDate ?? undefined) };
}

export function collectionMonitoringV2ComparisonSlots(
  rows: readonly CollectionMonitoringV2Row[],
  comparisonRows: readonly CollectionMonitoringV2Row[] = [],
): CollectionMonitoringV2ComparisonSlot[] {
  const dates = [...new Set(rows.map((row) => String(row.data_date ?? "").slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  const latest = dates.at(-1);
  if (!latest) return [];
  const available = new Set([
    ...dates,
    ...comparisonRows.map((row) => String(row.data_date ?? "").slice(0, 10)).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
  ]);
  const addDays = (date: string, offset: number) => {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  return [
    { key: "d2", date: addDays(latest, -2), hasRecords: available.has(addDays(latest, -2)) },
    { key: "d1", date: addDays(latest, -1), hasRecords: available.has(addDays(latest, -1)) },
    { key: "current", date: latest, hasRecords: available.has(latest) },
  ];
}

export function collectionMonitoringV2ComparisonValue(
  value: number | null | undefined,
): CollectionMonitoringV2ComparisonValue {
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "value", value };
  return { kind: "missing" };
}

export function collectionMonitoringV2PercentageVariation(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (typeof current !== "number" || !Number.isFinite(current) ||
      typeof previous !== "number" || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

export function groupCollectionMonitoringV2Rows(
  rows: readonly CollectionMonitoringV2Row[],
  dimension: "region" | "rm" | "base",
): CollectionMonitoringV2Group[] {
  const groups = new Map<string, CollectionMonitoringV2Group>();
  const bases = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = dimension === "region" ? row.region
      : dimension === "rm" ? `${row.rmArea}\u0000${row.rm}\u0000${row.region}`
        : `${row.region}\u0000${row.base}\u0000${row.baseCode}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        label: dimension === "region" ? row.region : dimension === "rm" ? row.rm : row.base,
        region: row.region, rmArea: row.rmArea, rm: row.rm, rgm: row.rgm,
        planned: 0, awaiting: 0, collected: 0, collectionRate: null, awaitingRate: null,
        retention: 0, dispatchedFromBase: 0, inTransitToBase: 0,
        retentionRate: null, dispatchedFromBaseRate: null, inTransitToBaseRate: null,
        baseCount: 0,
        operationalPlanned: 0, operationalAwaiting: 0, operationalCollected: 0,
        operationalCollectionRate: null, operationalAwaitingRate: null,
      };
      groups.set(key, group);
    }
    group.planned += toQuantity(row.expected_dropoff) + toQuantity(row.expected_pickup);
    group.awaiting += toQuantity(row.pending_dropoff) + toQuantity(row.pending_pickup);
    group.collected += toQuantity(row.status_collected);
    group.operationalPlanned += toQuantity(row.status_received_at_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution) + toQuantity(row.arrived_sc);
    group.operationalAwaiting += toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution);
    group.operationalCollected += toQuantity(row.status_received_at_base) + toQuantity(row.arrived_sc);
    group.retention += toQuantity(row.status_received_at_base);
    group.dispatchedFromBase += toQuantity(row.status_dispatched_from_base);
    group.inTransitToBase += toQuantity(row.status_in_transit_from_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution);
    if (row.mappingConfirmed && row.baseCode !== "—" && isOperationalMappedBase(row)) {
      const groupBases = bases.get(key) ?? new Set<string>();
      groupBases.add(row.baseCode);
      bases.set(key, groupBases);
    }
  }
  for (const [key, group] of groups) {
    group.collectionRate = group.planned > 0 ? group.collected / group.planned : null;
    group.awaitingRate = group.planned > 0 ? group.awaiting / group.planned : null;
    group.operationalCollectionRate = group.operationalPlanned > 0 ? group.operationalCollected / group.operationalPlanned : null;
    group.operationalAwaitingRate = group.operationalPlanned > 0 ? group.operationalAwaiting / group.operationalPlanned : null;
    group.retentionRate = group.planned > 0 ? group.retention / group.planned : null;
    group.dispatchedFromBaseRate = group.planned > 0 ? group.dispatchedFromBase / group.planned : null;
    group.inTransitToBaseRate = group.planned > 0 ? group.inTransitToBase / group.planned : null;
    group.baseCount = bases.get(key)?.size ?? 0;
  }
  return [...groups.values()].sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label, "pt-BR"));
}

export type CollectionMonitoringV2SummaryMatrixCell = string | number | null;

export function collectionMonitoringV2RegionalSummaryMatrix(
  groups: readonly CollectionMonitoringV2Group[],
  metrics: CollectionMonitoringV2Metrics,
  mappedBaseCount: number,
  translate: (label: string) => string = (label) => label,
): CollectionMonitoringV2SummaryMatrixCell[][] {
  return [
    [translate("Regional"), "RGM", translate("Bases vinculadas"), translate("Previsto a coletar"), translate("Aguardando coleta"), translate("Coletado"), translate("Taxa de coleta"), translate("Taxa de pedidos aguardando coleta")],
    ...groups.map((group) => [group.region, group.rgm, group.baseCount, group.operationalPlanned, group.operationalAwaiting, group.operationalCollected, group.operationalCollectionRate, group.operationalAwaitingRate]),
    [translate("Total geral"), "—", mappedBaseCount, metrics.planned, metrics.awaiting, metrics.collected, metrics.collectionRate, metrics.awaitingRate],
  ];
}

export function collectionMonitoringV2RmSummaryMatrix(
  groups: readonly CollectionMonitoringV2Group[],
  metrics: CollectionMonitoringV2Metrics,
  mappedBaseCount: number,
  translate: (label: string) => string = (label) => label,
): CollectionMonitoringV2SummaryMatrixCell[][] {
  return [
    [translate("Região do RM"), translate("Responsável do RM"), "RGM", translate("Bases vinculadas"), translate("Previsto a coletar"), translate("Aguardando coleta"), translate("Coletado"), translate("Taxa de coleta"), translate("Taxa de pedidos aguardando coleta")],
    ...groups.map((group) => [group.rmArea, group.rm, group.rgm, group.baseCount, group.operationalPlanned, group.operationalAwaiting, group.operationalCollected, group.operationalCollectionRate, group.operationalAwaitingRate]),
    [translate("Total geral"), "—", "—", mappedBaseCount, metrics.planned, metrics.awaiting, metrics.collected, metrics.collectionRate, metrics.awaitingRate],
  ];
}

export function groupCollectionMonitoringV2BaseDetails(
  rows: readonly CollectionMonitoringV2Row[],
): CollectionMonitoringV2BaseDetail[] {
  const groups = new Map<string, CollectionMonitoringV2BaseDetail>();
  for (const row of rows) {
    const period = String(row.data_date ?? "").slice(0, 10);
    const identity = JSON.stringify([
      period, row.region, row.baseCode, row.base, row.origin, row.rmArea, row.rm, row.rgm,
    ]);
    const group = groups.get(identity) ?? {
      period,
      region: row.region,
      base: row.base,
      origin: row.origin,
      rmArea: row.rmArea,
      rm: row.rm,
      rgm: row.rgm,
      planned: 0,
      awaiting: 0,
      collected: 0,
      retention: 0,
    };
    group.planned += toQuantity(row.status_received_at_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution) + toQuantity(row.arrived_sc);
    group.awaiting += toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution);
    group.collected += toQuantity(row.status_received_at_base) + toQuantity(row.arrived_sc);
    group.retention += toQuantity(row.status_received_at_base);
    groups.set(identity, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.retention - left.retention || right.period.localeCompare(left.period) || left.base.localeCompare(right.base, "pt-BR"));
}

export function collectionMonitoringV2RegionalStatusGroups(
  rows: readonly CollectionMonitoringV2Row[],
): CollectionMonitoringV2RegionalStatusGroup[] {
  const rowsByRegion = new Map<string, CollectionMonitoringV2Row[]>();
  for (const row of rows) {
    const regionRows = rowsByRegion.get(row.region) ?? [];
    regionRows.push(row);
    rowsByRegion.set(row.region, regionRows);
  }

  return groupCollectionMonitoringV2Rows(rows, "region").map((group) => {
    const regionRows = rowsByRegion.get(group.region) ?? [];
    const components = COLLECTION_MONITORING_V2_STATUS_FIELDS.map(({ field, label }) => ({
      field,
      label,
      value: regionRows.reduce((sum, row) => sum + statusMetricValue(row, field), 0),
    })).filter((component) => component.value > 0);
    const basesWithMovement = new Set(regionRows.flatMap((row) => {
      const hasMovement = COLLECTION_MONITORING_V2_STATUS_FIELDS.some(({ field }) => statusMetricValue(row, field) > 0);
      if (!hasMovement) return [];
      if (row.mappingConfirmed && row.baseCode !== "—" && isOperationalMappedBase(row)) return [`code:${row.baseCode}`];
      const rawName = toText(row.source_base_name).toLocaleLowerCase("pt-BR");
      return rawName && rawName !== "sem base" ? [`name:${rawName}`] : [];
    })).size;
    const componentTotal = components.reduce((sum, component) => sum + component.value, 0);
    return { ...group, basesWithMovement, componentTotal, components };
  }).filter((group) => group.componentTotal > 0)
    .sort((left, right) => right.componentTotal - left.componentTotal || left.region.localeCompare(right.region, "pt-BR"));
}

function statusMetricValue(row: CollectionMonitoringV2Row, field: CollectionMonitoringV2StatusField): number {
  if (field === "retention") return toQuantity(row.status_received_at_base);
  if (field === "dispatchedFromBase") return toQuantity(row.status_dispatched_from_base);
  if (field === "inTransitToBase") return toQuantity(row.status_in_transit_from_base) + toQuantity(row.in_transit_to_center) + toQuantity(row.in_transit_to_distribution);
  return toQuantity(row.status_collected);
}

export function collectionMonitoringV2BaseDetailMatrix(
  rows: readonly CollectionMonitoringV2BaseDetail[],
  translate: (label: string) => string = (label) => label,
): (string | number)[][] {
  return [
    ["Período", "Regional", "Base", "Origem do pedido", "RM", "RGM", "Previsto a coletar", "Aguardando coleta", "Coletado", "Retenção"].map(translate),
    ...rows.map((row) => [
      row.period,
      row.region,
      row.base,
      row.origin,
      row.rm,
      row.rgm,
      row.planned,
      row.awaiting,
      row.collected,
      row.retention,
    ]),
  ];
}

export interface CollectionMonitoringV2FilterOptions {
  regions: string[];
  rms: string[];
  rmAreas: string[];
  rgms: string[];
  bases: string[];
  origins: string[];
}

export function collectionMonitoringV2FilterOptions(rows: readonly CollectionMonitoringV2Row[]): CollectionMonitoringV2FilterOptions {
  return {
    regions: uniqueSorted(rows.map((row) => row.region)),
    rms: uniqueSorted(rows.map((row) => row.rm)),
    rmAreas: uniqueSorted(rows.map((row) => row.rmArea)),
    rgms: uniqueSorted(rows.map((row) => row.rgm)),
    bases: uniqueSorted(rows.map((row) => row.base)),
    origins: uniqueSorted(rows.map((row) => row.origin)),
  };
}

export function filterCollectionMonitoringV2Dimensions(
  rows: readonly CollectionMonitoringV2Row[],
  filters: CollectionMonitoringV2Filters,
): CollectionMonitoringV2FilterOptions {
  const dimensions = { ...filters };
  delete dimensions.dateFrom;
  delete dimensions.dateTo;
  return collectionMonitoringV2FilterOptions(filterCollectionMonitoringV2Rows(rows, dimensions));
}

export function collectionMonitoringV2VisibleColumns(): readonly (typeof COLLECTION_MONITORING_V2_COLUMNS)[number][] {
  return COLLECTION_MONITORING_V2_COLUMNS;
}

export function formatCollectionMonitoringV2Value(value: unknown, key: string, locale = "pt-BR"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "data_date") {
    const date = String(value).slice(0, 10);
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(parsed);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(number)) {
    if (["seller_collection_rate", "collection_visit_rate"].includes(key)) {
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(number);
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(number);
  }
  return String(value);
}

export function collectionMonitoringV2CsvCell(value: unknown, key: string): string {
  if (value === null || value === undefined) return "";
  if (key === "data_date") return String(value).slice(0, 10);
  return String(value);
}

const INTEGER_KEYS = new Set<string>([
  "expected_dropoff", "expected_pickup", "pending_dropoff", "pending_pickup", "status_collected",
  "status_received_at_base", "status_dispatched_from_base", "status_in_transit_from_base",
  "in_transit_to_center", "in_transit_to_distribution", "arrived_sorting_center",
  "departed_sorting_center", "distribution_in_transit", "arrived_sc", "package_created_at_base",
  "processed_problem_items", "unprocessed_problem_items",
]);

export function collectionMonitoringV2ExcelValue(value: unknown, key: string): string | number | Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (key === "data_date") {
    const date = String(value).slice(0, 10);
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
  }
  if (INTEGER_KEYS.has(key) || key === "seller_collection_rate" || key === "collection_visit_rate") {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(value);
}

export function collectionMonitoringV2ExcelMatrix(rows: readonly CollectionMonitoringV2Row[]): (string | number | Date | null)[][] {
  return [
    COLLECTION_MONITORING_V2_COLUMNS.map((key) => COLLECTION_MONITORING_V2_HEADERS[key]),
    ...rows.map((row) => COLLECTION_MONITORING_V2_COLUMNS.map((key) => collectionMonitoringV2ExcelValue(row[key], key))),
  ];
}
