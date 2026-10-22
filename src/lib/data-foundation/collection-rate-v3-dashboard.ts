import { isOperationalMappedBase } from "./mapping-revision.ts";
import { officialRgmForRegion, UNASSIGNED_RGM, UNASSIGNED_RM, UNASSIGNED_RM_AREA } from "../responsibility.ts";
import { resolvePublishedRegionalAssignment } from "./regional-assignment.ts";
import {
  COLLECTION_RATE_V3_COLUMNS,
  type CollectionRateV3Record,
} from "./collection-rate-v3.ts";

export interface CollectionRateV3DashboardRow extends CollectionRateV3Record {
  data_date: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  base: string;
  baseCode: string;
  origin: string;
  productType: string;
}

export interface CollectionRateV3Filters {
  regions?: ReadonlySet<string>;
  rms?: ReadonlySet<string>;
  rmAreas?: ReadonlySet<string>;
  rgms?: ReadonlySet<string>;
  bases?: ReadonlySet<string>;
  origins?: ReadonlySet<string>;
  productTypes?: ReadonlySet<string>;
}

export interface CollectionRateV3Totals {
  totalOrders: number;
  planned: number;
  collected: number;
  notCollected: number;
  collectedOnTime: number;
  collectionRate: number | null;
  onTimeRate: number | null;
}

export interface CollectionRateV3AttemptRate {
  collectedPlusAttempts: number;
  quantityToCollect: number;
  rate: number | null;
}

export interface CollectionRateV3CardSummaries {
  totals: CollectionRateV3Totals;
  attempts: CollectionRateV3AttemptRate;
}

export interface CollectionRateV3Options {
  regions: string[];
  rms: string[];
  rmAreas: string[];
  rgms: string[];
  bases: string[];
  origins: string[];
  productTypes: string[];
}

export interface CollectionRateV3Group extends CollectionRateV3Totals {
  key: string;
  label: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  baseCount: number;
  daily: Map<string, CollectionRateV3Totals>;
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function quantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function dateFromDeadline(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ""));
  return match?.[1] ?? "";
}

export function mapCollectionRateV3Record(record: CollectionRateV3Record): CollectionRateV3DashboardRow {
  const assignment = resolvePublishedRegionalAssignment(record);
  const region = assignment.effective_region;
  return {
    ...record,
    data_date: dateFromDeadline(record.deadline_at),
    region,
    rmArea: assignment.effective_rm_area || UNASSIGNED_RM_AREA,
    rm: assignment.effective_rm || UNASSIGNED_RM,
    rgm: assignment.mapping_is_approved ? officialRgmForRegion(region) ?? UNASSIGNED_RGM : UNASSIGNED_RGM,
    base: assignment.effective_base_name || text(record.source_base_name) || "Sem base",
    baseCode: text(record.effective_base_code ?? record.resolved_base_code) || "—",
    origin: text(record.order_origin) || "Sem origem",
    productType: text(record.product_type) || "Sem tipo",
  };
}

export function collectionRateV3FilterOptions(rows: readonly CollectionRateV3DashboardRow[]): CollectionRateV3Options {
  const regions = new Set<string>();
  const rms = new Set<string>();
  const rmAreas = new Set<string>();
  const rgms = new Set<string>();
  const bases = new Set<string>();
  const origins = new Set<string>();
  const productTypes = new Set<string>();
  for (const row of rows) {
    if (row.region) regions.add(row.region);
    if (row.rm) rms.add(row.rm);
    if (row.rmArea) rmAreas.add(row.rmArea);
    if (row.rgm) rgms.add(row.rgm);
    if (row.base) bases.add(row.base);
    if (row.origin) origins.add(row.origin);
    if (row.productType) productTypes.add(row.productType);
  }
  const sorted = (values: ReadonlySet<string>) => [...values].sort((left, right) => left.localeCompare(right, "pt-BR"));
  return {
    regions: sorted(regions),
    rms: sorted(rms),
    rmAreas: sorted(rmAreas),
    rgms: sorted(rgms),
    bases: sorted(bases),
    origins: sorted(origins),
    productTypes: sorted(productTypes),
  };
}

function includesSelection(selection: ReadonlySet<string> | undefined, value: string): boolean {
  return !selection || selection.size === 0 || selection.has(value);
}

export function filterCollectionRateV3Rows(
  rows: readonly CollectionRateV3DashboardRow[],
  filters: CollectionRateV3Filters,
): CollectionRateV3DashboardRow[] {
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

function emptyTotals(): CollectionRateV3Totals {
  return { totalOrders: 0, planned: 0, collected: 0, notCollected: 0, collectedOnTime: 0, collectionRate: null, onTimeRate: null };
}

function addTotals(target: CollectionRateV3Totals, row: CollectionRateV3DashboardRow): void {
  target.totalOrders += quantity(row.order_quantity);
  target.planned += quantity(row.quantity_to_collect);
  target.collected += quantity(row.collected_quantity);
  target.notCollected += quantity(row.not_collected_quantity);
  target.collectedOnTime += quantity(row.collected_on_time_quantity);
}

function finalizeTotals(target: CollectionRateV3Totals): CollectionRateV3Totals {
  target.collectionRate = target.planned > 0 ? target.collected / target.planned : null;
  target.onTimeRate = target.planned > 0 ? target.collectedOnTime / target.planned : null;
  return target;
}

export function summarizeCollectionRateV3(rows: readonly CollectionRateV3DashboardRow[]): CollectionRateV3Totals {
  const summary = emptyTotals();
  for (const row of rows) addTotals(summary, row);
  return finalizeTotals(summary);
}

export function summarizeCollectionRateV3Cards(
  rows: readonly CollectionRateV3DashboardRow[],
): CollectionRateV3CardSummaries {
  const totals = emptyTotals();
  let collectedPlusAttempts = 0;
  let quantityToCollect = 0;
  for (const row of rows) {
    addTotals(totals, row);
    collectedPlusAttempts += quantity(row.collected_plus_attempts_quantity);
    quantityToCollect += quantity(row.quantity_to_collect);
  }
  return {
    totals: finalizeTotals(totals),
    attempts: {
      collectedPlusAttempts,
      quantityToCollect,
      rate: quantityToCollect > 0 ? collectedPlusAttempts / quantityToCollect : null,
    },
  };
}

export function summarizeCollectionRateV3Attempts(
  rows: readonly CollectionRateV3DashboardRow[],
): CollectionRateV3AttemptRate {
  let collectedPlusAttempts = 0;
  let quantityToCollect = 0;
  for (const row of rows) {
    collectedPlusAttempts += quantity(row.collected_plus_attempts_quantity);
    quantityToCollect += quantity(row.quantity_to_collect);
  }
  return {
    collectedPlusAttempts,
    quantityToCollect,
    rate: quantityToCollect > 0 ? collectedPlusAttempts / quantityToCollect : null,
  };
}

export interface CollectionRateV3RegionalAttemptDay {
  orders: number;
  quantityToCollect: number;
  collectedPlusAttempts: number;
  rate: number | null;
}

export interface CollectionRateV3RegionalAttemptRow {
  region: string;
  rgm: string;
  days: CollectionRateV3RegionalAttemptDay[];
  totalOrders: number;
}

export interface CollectionRateV3RegionalAttemptSummary {
  dates: string[];
  rows: CollectionRateV3RegionalAttemptRow[];
  totals: CollectionRateV3RegionalAttemptDay[];
  totalOrders: number;
  unassigned: { records: number; orders: number; quantityToCollect: number };
}

export function formatCollectionRateV3RegionalAttemptRate(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function emptyRegionalAttemptDay(): Omit<CollectionRateV3RegionalAttemptDay, "rate"> {
  return { orders: 0, quantityToCollect: 0, collectedPlusAttempts: 0 };
}

function addRegionalAttemptRow(
  target: Omit<CollectionRateV3RegionalAttemptDay, "rate">,
  row: CollectionRateV3DashboardRow,
): void {
  target.orders += quantity(row.order_quantity);
  target.quantityToCollect += quantity(row.quantity_to_collect);
  target.collectedPlusAttempts += quantity(row.collected_plus_attempts_quantity);
}

function finishRegionalAttemptDay(
  value: Omit<CollectionRateV3RegionalAttemptDay, "rate">,
): CollectionRateV3RegionalAttemptDay {
  return { ...value, rate: value.quantityToCollect > 0 ? value.collectedPlusAttempts / value.quantityToCollect : null };
}

/**
 * Builds the regional presentation from rows already loaded and authorized by the Data Foundation.
 * Regional labels follow the source's proxyAreaName (reported_region); RGM comes from the
 * existing official NEW BI region-to-RGM mapping. Each selected day remains independent.
 */
export function summarizeCollectionRateV3RegionalAttempts(
  rows: readonly CollectionRateV3DashboardRow[],
  selectedDates: readonly string[],
): CollectionRateV3RegionalAttemptSummary {
  const dates = [...new Set(selectedDates.map(text).filter(Boolean))].sort();
  const dateSet = new Set(dates);
  const regionGroups = new Map<string, Map<string, Omit<CollectionRateV3RegionalAttemptDay, "rate">>>();
  const totalByDate = new Map<string, Omit<CollectionRateV3RegionalAttemptDay, "rate">>();
  const unassigned = { records: 0, orders: 0, quantityToCollect: 0 };

  for (const row of rows) {
    const date = text(row.data_date);
    if (!dateSet.has(date)) continue;
    const region = text(row.reported_region);
    if (!region) {
      unassigned.records += 1;
      unassigned.orders += quantity(row.order_quantity);
      unassigned.quantityToCollect += quantity(row.quantity_to_collect);
      continue;
    }

    const byDate = regionGroups.get(region) ?? new Map();
    const regionalDay = byDate.get(date) ?? emptyRegionalAttemptDay();
    addRegionalAttemptRow(regionalDay, row);
    byDate.set(date, regionalDay);
    regionGroups.set(region, byDate);

    const totalDay = totalByDate.get(date) ?? emptyRegionalAttemptDay();
    addRegionalAttemptRow(totalDay, row);
    totalByDate.set(date, totalDay);
  }

  const regionalRows = [...regionGroups.entries()].map(([region, byDate]) => {
    const days = dates.map((date) => finishRegionalAttemptDay(byDate.get(date) ?? emptyRegionalAttemptDay()));
    return {
      region,
      rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
      days,
      totalOrders: days.reduce((sum, day) => sum + day.orders, 0),
    };
  });
  const latestDateIndex = Math.max(0, dates.length - 1);
  regionalRows.sort((left, right) => {
    const leftRate = left.days[latestDateIndex]?.rate ?? null;
    const rightRate = right.days[latestDateIndex]?.rate ?? null;
    if (leftRate === null && rightRate !== null) return 1;
    if (leftRate !== null && rightRate === null) return -1;
    if (leftRate !== null && rightRate !== null && leftRate !== rightRate) return rightRate - leftRate;
    return left.region.localeCompare(right.region, "pt-BR", { numeric: true });
  });
  const totals = dates.map((date) => finishRegionalAttemptDay(totalByDate.get(date) ?? emptyRegionalAttemptDay()));

  return {
    dates,
    rows: regionalRows,
    totals,
    totalOrders: totals.reduce((sum, day) => sum + day.orders, 0),
    unassigned,
  };
}

function groupKey(row: CollectionRateV3DashboardRow, dimension: "region" | "rmArea"): string {
  return dimension === "region" ? row.region : [row.rmArea, row.rm, row.rgm].join("\u0000");
}

export function groupCollectionRateV3Rows(
  rows: readonly CollectionRateV3DashboardRow[],
  dimension: "region" | "rmArea",
): CollectionRateV3Group[] {
  const groups = new Map<string, CollectionRateV3Group>();
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
    const day = row.data_date;
    const daily = group.daily.get(day) ?? emptyTotals();
    addTotals(daily, row);
    group.daily.set(day, daily);
    const resolution = text(row.effective_mapping_resolution ?? row.mapping_resolution);
    const code = text(row.effective_base_code ?? row.resolved_base_code);
    if (["CODE_MATCH", "NAME_APPROVED"].includes(resolution) && code && isOperationalMappedBase(row)) {
      const codes = basesByGroup.get(key) ?? new Set<string>();
      codes.add(code);
      basesByGroup.set(key, codes);
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    finalizeTotals(group);
    for (const daily of group.daily.values()) finalizeTotals(daily);
    group.baseCount = basesByGroup.get(group.key)?.size ?? 0;
  }
  return result.sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label, "pt-BR"));
}

export interface CollectionRateV3OriginSummary extends CollectionRateV3Totals { origin: string; }

export function summarizeCollectionRateV3Origins(rows: readonly CollectionRateV3DashboardRow[]): CollectionRateV3OriginSummary[] {
  const groups = new Map<string, CollectionRateV3OriginSummary>();
  for (const row of rows) {
    const summary = groups.get(row.origin) ?? { origin: row.origin, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(row.origin, summary);
  }
  return [...groups.values()].map((summary) => { finalizeTotals(summary); return summary; })
    .sort((left, right) => right.planned - left.planned || left.origin.localeCompare(right.origin, "pt-BR"));
}

export interface CollectionRateV3DailySummary extends CollectionRateV3Totals { date: string; }

export function summarizeCollectionRateV3Daily(rows: readonly CollectionRateV3DashboardRow[]): CollectionRateV3DailySummary[] {
  const groups = new Map<string, CollectionRateV3DailySummary>();
  for (const row of rows) {
    const date = row.data_date;
    const summary = groups.get(date) ?? { date, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(date, summary);
  }
  return [...groups.values()].map((summary) => { finalizeTotals(summary); return summary; })
    .sort((left, right) => left.date.localeCompare(right.date));
}

export interface CollectionRateV3MonthlySummary extends CollectionRateV3Totals { month: string; }

export function summarizeCollectionRateV3Monthly(rows: readonly CollectionRateV3DashboardRow[]): CollectionRateV3MonthlySummary[] {
  const groups = new Map<string, CollectionRateV3MonthlySummary>();
  for (const row of rows) {
    const month = row.data_date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const summary = groups.get(month) ?? { month, ...emptyTotals() };
    addTotals(summary, row);
    groups.set(month, summary);
  }
  return [...groups.values()].map((summary) => { finalizeTotals(summary); return summary; })
    .sort((left, right) => left.month.localeCompare(right.month));
}

const QUANTITY_FIELDS = new Set<string>([
  "order_quantity", "quantity_to_collect", "cancelled_quantity", "collected_quantity",
  "not_collected_quantity", "not_collected_on_time_quantity", "collected_on_time_quantity",
  "collected_plus_attempts_quantity", "processed_problem_items", "unprocessed_problem_items",
  "expected_merchant_visits", "merchants_not_visited",
]);
const RATE_FIELDS = new Set<string>([
  "collection_rate", "collection_on_time_rate", "collection_rate_with_attempts", "seller_collection_rate",
]);
const DECIMAL_FIELDS = new Set<string>([...RATE_FIELDS, "average_collection_delay_hours"]);

function rawNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatCollectionRateV3Cell(
  value: unknown,
  field: (typeof COLLECTION_RATE_V3_COLUMNS)[number],
  locale: string,
): string {
  if (field === "deadline_at") {
    const raw = text(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (!match) return raw || "—";
    const [, year, month, day, hour, minute, second = "00"] = match;
    const instant = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    return new Intl.DateTimeFormat(locale, {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    }).format(instant);
  }
  const parsed = rawNumber(value);
  if (parsed !== null && RATE_FIELDS.has(field)) {
    return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(parsed);
  }
  if (parsed !== null && field === "average_collection_delay_hours") {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(parsed);
  }
  if (parsed !== null && QUANTITY_FIELDS.has(field)) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(parsed);
  }
  return text(value) || "—";
}

export function collectionRateV3ExcelValue(
  value: unknown,
  field: (typeof COLLECTION_RATE_V3_COLUMNS)[number],
): string | number | null {
  if (QUANTITY_FIELDS.has(field) || DECIMAL_FIELDS.has(field)) return rawNumber(value);
  return value === null || value === undefined ? null : String(value);
}

export function collectionRateV3ExcelNumberFormat(
  field: (typeof COLLECTION_RATE_V3_COLUMNS)[number],
): string | undefined {
  if (RATE_FIELDS.has(field)) return "0.00%";
  if (QUANTITY_FIELDS.has(field)) return "#,##0";
  if (field === "average_collection_delay_hours") return "#,##0.000";
  if (field === "deadline_at") return "dd/mm/yyyy hh:mm";
  return undefined;
}

export const collectionRateV3DetailColumns = COLLECTION_RATE_V3_COLUMNS;

/** Percentage presentation only; source rates remain unchanged, including rates above 100%. */
export function collectionRateV3ProgressWidth(rate: number | null): string {
  return `${rate !== null && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) * 100 : 0}%`;
}

export interface CollectionRateV3MonthlyChartPoint {
  month: string;
  collectionRate: number | null;
  attemptRate: number | null;
}

export function collectionRateV3MonthlyChartPoints(
  rows: readonly CollectionRateV3DashboardRow[],
): CollectionRateV3MonthlyChartPoint[] {
  const months = new Map<string, CollectionRateV3DashboardRow[]>();
  for (const row of rows) {
    const month = row.data_date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const group = months.get(month) ?? [];
    group.push(row);
    months.set(month, group);
  }
  return [...months].sort(([left], [right]) => left.localeCompare(right)).map(([month, group]) => {
    const summary = summarizeCollectionRateV3Cards(group);
    return { month, collectionRate: summary.totals.collectionRate, attemptRate: summary.attempts.rate };
  });
}
