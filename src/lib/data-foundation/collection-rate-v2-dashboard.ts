import { officialRgmForRegion, UNASSIGNED_RGM, UNASSIGNED_RM, UNASSIGNED_RM_AREA } from "../responsibility.ts";
import { resolvePublishedRegionalAssignment } from "./regional-assignment.ts";
import type { CollectionRateV2Record } from "./collection-rate-v2.ts";

export interface CollectionRateV2DashboardRow extends CollectionRateV2Record {
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  base: string;
  baseCode: string;
  origin: string;
  productType: string;
}

export interface CollectionRateV2Filters {
  regions?: ReadonlySet<string>;
  rms?: ReadonlySet<string>;
  rmAreas?: ReadonlySet<string>;
  rgms?: ReadonlySet<string>;
  bases?: ReadonlySet<string>;
  origins?: ReadonlySet<string>;
  productTypes?: ReadonlySet<string>;
}

export interface CollectionRateV2Totals {
  totalOrders: number;
  planned: number;
  collected: number;
  notCollected: number;
  collectedOnTime: number;
  collectionRate: number | null;
  onTimeRate: number | null;
}

export interface CollectionRateV2Options {
  regions: string[];
  rms: string[];
  rmAreas: string[];
  rgms: string[];
  bases: string[];
  origins: string[];
  productTypes: string[];
}

export interface CollectionRateV2Group extends CollectionRateV2Totals {
  key: string;
  label: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  baseCount: number;
  daily: Map<string, CollectionRateV2Totals>;
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function quantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function mapCollectionRateV2Record(record: CollectionRateV2Record): CollectionRateV2DashboardRow {
  const assignment = resolvePublishedRegionalAssignment(record);
  const region = assignment.effective_region;
  return {
    ...record,
    region,
    rmArea: assignment.effective_rm_area || UNASSIGNED_RM_AREA,
    rm: assignment.effective_rm || UNASSIGNED_RM,
    rgm: assignment.mapping_is_approved ? officialRgmForRegion(region) ?? UNASSIGNED_RGM : UNASSIGNED_RGM,
    base: assignment.effective_base_name || text(record.source_base_name) || text(record.source_base_code) || "Sem base",
    baseCode: text(record.source_base_code) || "—",
    origin: text(record.order_origin) || "Sem origem",
    productType: text(record.product_type) || "Sem tipo",
  };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((left, right) => left.localeCompare(right, "pt-BR"));
}

export function collectionRateV2FilterOptions(rows: readonly CollectionRateV2DashboardRow[]): CollectionRateV2Options {
  return {
    regions: unique(rows.map((row) => row.region)),
    rms: unique(rows.map((row) => row.rm)),
    rmAreas: unique(rows.map((row) => row.rmArea)),
    rgms: unique(rows.map((row) => row.rgm)),
    bases: unique(rows.map((row) => row.base)),
    origins: unique(rows.map((row) => row.origin)),
    productTypes: unique(rows.map((row) => row.productType)),
  };
}

function includesSelection(selection: ReadonlySet<string> | undefined, value: string): boolean {
  return !selection || selection.size === 0 || selection.has(value);
}

export function filterCollectionRateV2Rows(
  rows: readonly CollectionRateV2DashboardRow[],
  filters: CollectionRateV2Filters,
): CollectionRateV2DashboardRow[] {
  return rows.filter((row) =>
    includesSelection(filters.regions, row.region) &&
    includesSelection(filters.rms, row.rm) &&
    includesSelection(filters.rmAreas, row.rmArea) &&
    includesSelection(filters.rgms, row.rgm) &&
    includesSelection(filters.bases, row.base) &&
    includesSelection(filters.origins, row.origin) &&
    includesSelection(filters.productTypes, row.productType),
  );
}

export function summarizeCollectionRateV2(rows: readonly CollectionRateV2DashboardRow[]): CollectionRateV2Totals {
  const totalOrders = rows.reduce((sum, row) => sum + quantity(row.total_orders), 0);
  const planned = rows.reduce((sum, row) => sum + quantity(row.quantity_to_collect), 0);
  const collected = rows.reduce((sum, row) => sum + quantity(row.collected_quantity), 0);
  const notCollected = rows.reduce((sum, row) => sum + quantity(row.not_collected_quantity), 0);
  const collectedOnTime = rows.reduce((sum, row) => sum + quantity(row.collected_on_time_quantity), 0);
  return {
    totalOrders,
    planned,
    collected,
    notCollected,
    collectedOnTime,
    collectionRate: planned > 0 ? collected / planned : null,
    onTimeRate: planned > 0 ? collectedOnTime / planned : null,
  };
}

function addTotals(target: CollectionRateV2Totals, row: CollectionRateV2DashboardRow): void {
  target.totalOrders += quantity(row.total_orders);
  target.planned += quantity(row.quantity_to_collect);
  target.collected += quantity(row.collected_quantity);
  target.notCollected += quantity(row.not_collected_quantity);
  target.collectedOnTime += quantity(row.collected_on_time_quantity);
  target.collectionRate = target.planned > 0 ? target.collected / target.planned : null;
  target.onTimeRate = target.planned > 0 ? target.collectedOnTime / target.planned : null;
}

function emptyTotals(): CollectionRateV2Totals {
  return { totalOrders: 0, planned: 0, collected: 0, notCollected: 0, collectedOnTime: 0, collectionRate: null, onTimeRate: null };
}

function groupKey(row: CollectionRateV2DashboardRow, dimension: "region" | "rmArea"): string {
  return dimension === "region" ? row.region : [row.rmArea, row.rm, row.rgm].join("\u0000");
}

export function groupCollectionRateV2Rows(
  rows: readonly CollectionRateV2DashboardRow[],
  dimension: "region" | "rmArea",
): CollectionRateV2Group[] {
  const groups = new Map<string, CollectionRateV2Group>();
  const basesByGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = groupKey(row, dimension);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: dimension === "region" ? row.region : row.rmArea,
        region: row.region,
        rmArea: row.rmArea,
        rm: row.rm,
        rgm: row.rgm,
        ...emptyTotals(),
        baseCount: 0,
        daily: new Map(),
      };
      groups.set(key, group);
    }
    addTotals(group, row);
    const day = text(row.data_date);
    const daily = group.daily.get(day) ?? emptyTotals();
    addTotals(daily, row);
    group.daily.set(day, daily);
    if (row.mapping_resolution === "CODE_MATCH" && text(row.resolved_base_code)) {
      const baseCodes = basesByGroup.get(key) ?? new Set<string>();
      baseCodes.add(text(row.resolved_base_code));
      basesByGroup.set(key, baseCodes);
    }
  }
  const result = [...groups.values()];
  for (const group of result) group.baseCount = basesByGroup.get(group.key)?.size ?? 0;
  return result.sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label, "pt-BR"));
}

export interface CollectionRateV2OriginSummary extends CollectionRateV2Totals {
  origin: string;
}

export function summarizeCollectionRateV2Origins(rows: readonly CollectionRateV2DashboardRow[]): CollectionRateV2OriginSummary[] {
  const groups = new Map<string, CollectionRateV2OriginSummary>();
  for (const row of rows) {
    const summary = groups.get(row.origin) ?? { origin: row.origin, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(row.origin, summary);
  }
  return [...groups.values()].sort((left, right) => right.planned - left.planned || left.origin.localeCompare(right.origin, "pt-BR"));
}

export interface CollectionRateV2DailySummary extends CollectionRateV2Totals { date: string; }

export function summarizeCollectionRateV2Daily(rows: readonly CollectionRateV2DashboardRow[]): CollectionRateV2DailySummary[] {
  const groups = new Map<string, CollectionRateV2DailySummary>();
  for (const row of rows) {
    const date = text(row.data_date);
    const summary = groups.get(date) ?? { date, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(date, summary);
  }
  return [...groups.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export interface CollectionRateV2MonthlySummary extends CollectionRateV2Totals { month: string; }

export function summarizeCollectionRateV2Monthly(rows: readonly CollectionRateV2DashboardRow[]): CollectionRateV2MonthlySummary[] {
  const groups = new Map<string, CollectionRateV2MonthlySummary>();
  for (const row of rows) {
    const month = text(row.data_date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const summary = groups.get(month) ?? { month, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(month, summary);
  }
  return [...groups.values()].sort((left, right) => left.month.localeCompare(right.month));
}

export function collectionRateV2BaseIdentity(row: CollectionRateV2DashboardRow): string {
  if (row.mapping_resolution === "CODE_MATCH" && text(row.resolved_base_code)) return `code:${text(row.resolved_base_code)}`;
  return `unmapped:${text(row.source_row_no)}`;
}

const QUANTITY_FIELDS = new Set<string>([
  "total_orders", "quantity_to_collect", "cancelled_orders", "collected_quantity",
  "not_collected_quantity", "not_collected_deadline_pending", "collected_on_time_quantity",
  "not_collected_after_deadline", "collected_after_deadline", "attempts_on_time_pending",
  "problem_quantity", "no_problem_quantity", "expected_shop_quantity_pending",
  "unexpected_shop_quantity_pending",
]);
const RATE_FIELDS = new Set<string>([
  "collection_rate_reported", "collection_on_time_rate_reported", "punctuality_rate_pending",
  "seller_collection_rate_pending",
]);
const DECIMAL_FIELDS = new Set<string>([...RATE_FIELDS, "average_collection_pending"]);

function rawNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatCollectionRateV2Cell(
  value: unknown,
  field: (typeof import("./collection-rate-v2.ts").COLLECTION_RATE_V2_COLUMNS)[number],
  locale: string,
): string {
  if (field === "data_date") {
    const raw = text(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return raw || "—";
    return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${raw}T12:00:00.000Z`));
  }
  const numeric = rawNumber(value);
  if (numeric !== null && RATE_FIELDS.has(field)) {
    return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(numeric);
  }
  if (numeric !== null && DECIMAL_FIELDS.has(field)) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(numeric);
  }
  if (numeric !== null && QUANTITY_FIELDS.has(field)) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(numeric);
  }
  return text(value) || "—";
}

export function collectionRateV2ExcelValue(
  value: unknown,
  field: (typeof import("./collection-rate-v2.ts").COLLECTION_RATE_V2_COLUMNS)[number],
): string | number | null {
  if (QUANTITY_FIELDS.has(field) || DECIMAL_FIELDS.has(field)) return rawNumber(value);
  return value === null || value === undefined ? null : String(value);
}

export function collectionRateV2ExcelNumberFormat(
  field: (typeof import("./collection-rate-v2.ts").COLLECTION_RATE_V2_COLUMNS)[number],
): string | undefined {
  if (RATE_FIELDS.has(field)) return "0.00%";
  if (QUANTITY_FIELDS.has(field)) return "#,##0";
  if (DECIMAL_FIELDS.has(field)) return "#,##0.000";
  if (field === "data_date") return "dd/mm/yyyy";
  return undefined;
}
