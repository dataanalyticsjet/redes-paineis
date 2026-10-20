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
}

export interface CollectionMonitoringV2Group extends CollectionMonitoringV2Metrics {
  label: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  baseCount: number;
}

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
  const planned = rows.reduce((sum, row) => sum + toQuantity(row.expected_dropoff) + toQuantity(row.expected_pickup), 0);
  const awaiting = rows.reduce((sum, row) => sum + toQuantity(row.pending_dropoff) + toQuantity(row.pending_pickup), 0);
  const collected = planned - awaiting;
  return {
    planned,
    awaiting,
    collected,
    collectionRate: planned > 0 ? collected / planned : null,
    awaitingRate: planned > 0 ? awaiting / planned : null,
  };
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
        planned: 0, awaiting: 0, collected: 0, collectionRate: null, awaitingRate: null, baseCount: 0,
      };
      groups.set(key, group);
    }
    group.planned += toQuantity(row.expected_dropoff) + toQuantity(row.expected_pickup);
    group.awaiting += toQuantity(row.pending_dropoff) + toQuantity(row.pending_pickup);
    if (row.mappingConfirmed && row.baseCode !== "—") {
      const groupBases = bases.get(key) ?? new Set<string>();
      groupBases.add(row.baseCode);
      bases.set(key, groupBases);
    }
  }
  for (const [key, group] of groups) {
    group.collected = group.planned - group.awaiting;
    group.collectionRate = group.planned > 0 ? group.collected / group.planned : null;
    group.awaitingRate = group.planned > 0 ? group.awaiting / group.planned : null;
    group.baseCount = bases.get(key)?.size ?? 0;
  }
  return [...groups.values()].sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label, "pt-BR"));
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
