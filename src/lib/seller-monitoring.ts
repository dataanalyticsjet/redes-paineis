import {
  officialRgmForRegion,
  registeredRegionForBase,
  responsibilityForBase,
  type ResponsibilityData,
} from "./responsibility.ts";

export type SellerReportMode = "seller" | "base" | "regional";
export type SellerOutcome = "complete" | "partial" | "zero";
export type SellerCategory = "J&T 重点保障" | "单商多服";

export function normalizeSellerCategory(value: unknown): SellerCategory | "" {
  const compact = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .toLocaleUpperCase("pt-BR");
  if (compact.includes("单商多服")) return "单商多服";
  if (
    compact === "T4" ||
    compact === "T5" ||
    compact.includes("J&T重点保障") ||
    compact.includes("JT重点保障")
  ) {
    return "J&T 重点保障";
  }
  return "";
}

export interface SellerMetricRecord {
  region: string;
  base: string;
  rm?: string;
  rgm?: string;
  sellerCode: string;
  sellerName: string;
  tier: SellerCategory | null;
  origin: string;
  awaiting: number;
  processed: number;
  total: number;
}

/** Categories are metadata from the official seller list, never inferred from JMS rows. */
export function sellerCategoryMatches(
  rowCategory: SellerCategory | null | undefined,
  selectedCategories: ReadonlySet<string>,
  availableCategories: readonly SellerCategory[],
): boolean {
  const allAvailableSelected = availableCategories.every((category) => selectedCategories.has(category));
  return allAvailableSelected || (rowCategory != null && selectedCategories.has(rowCategory));
}

/** Resolve organizational labels before aggregation so official SR assignments remain visible. */
export function resolveSellerOrganization<T extends { region: string; base: string }>(
  record: T,
  responsibility: ResponsibilityData | null,
): T & { region: string; rm: string; rgm: string } {
  const region = registeredRegionForBase(responsibility, record.base, record.region);
  const assignment = responsibilityForBase(responsibility, record.base);
  return {
    ...record,
    region,
    rm: assignment.rm,
    rgm: officialRgmForRegion(region) ?? assignment.rgm,
  };
}

export interface SellerReportRow {
  key: string;
  period: string;
  tierLabel: string;
  region: string;
  base: string;
  rmLabel: string;
  rgmLabel: string;
  sellerCode: string;
  sellerName: string;
  originLabel: string;
  sellerCount: number;
  baseCount: number;
  awaiting: number;
  processed: number;
  total: number;
  rate: number;
}

export interface SellerOutcomeSummary {
  total: number;
  complete: { count: number; rate: number };
  partial: { count: number; rate: number };
  zero: { count: number; rate: number };
}

export interface SellerBaseRmAwaitingSummary {
  base: string;
  rm: string;
  awaiting: number;
  processed: number;
  total: number;
  rate: number;
}

interface SellerReportGroup {
  key: string;
  period: string;
  sellerCode: string;
  sellerName: string;
  tiers: Set<string>;
  regions: Set<string>;
  bases: Set<string>;
  rms: Set<string>;
  rgms: Set<string>;
  sellers: Set<string>;
  origins: Set<string>;
  awaiting: number;
  processed: number;
  total: number;
}

function safeRate(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

function summarizeLabels(values: Set<string>, limit = 2): string {
  const labels = [...values].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  if (labels.length <= limit) return labels.join(", ");
  return `${labels.slice(0, limit).join(", ")} +${labels.length - limit}`;
}

function groupIdentity(record: SellerMetricRecord, mode: SellerReportMode): string {
  if (mode === "regional") return record.region;
  if (mode === "base") return `${record.region}::${record.base}`;
  return record.sellerCode;
}

export function buildSellerReportRows(
  records: readonly SellerMetricRecord[],
  mode: SellerReportMode,
  period: string,
): SellerReportRow[] {
  const groups = new Map<string, SellerReportGroup>();

  for (const record of records) {
    const identity = groupIdentity(record, mode);
    const key = `${mode}::${identity}`;
    const current =
      groups.get(key) ??
      {
        key,
        period,
        sellerCode: mode === "seller" ? record.sellerCode : "",
        sellerName: mode === "seller" ? record.sellerName : "",
        tiers: new Set<string>(),
        regions: new Set<string>(),
        bases: new Set<string>(),
        rms: new Set<string>(),
        rgms: new Set<string>(),
        sellers: new Set<string>(),
        origins: new Set<string>(),
        awaiting: 0,
        processed: 0,
        total: 0,
      };

    if (mode === "seller" && current.sellerName === "Sem loja" && record.sellerName !== "Sem loja") {
      current.sellerName = record.sellerName;
    }
    if (record.tier) current.tiers.add(record.tier);
    current.regions.add(record.region);
    current.bases.add(record.base);
    current.rms.add(record.rm?.trim() || "Sem RM");
    current.rgms.add(record.rgm?.trim() || "Sem RGM");
    current.sellers.add(record.sellerCode);
    current.origins.add(record.origin);
    current.awaiting += record.awaiting;
    current.processed += record.processed;
    current.total += record.total;
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      period: group.period,
      tierLabel: summarizeLabels(group.tiers) || "—",
      region: summarizeLabels(group.regions),
      base: mode === "regional" ? `${group.bases.size} base(s)` : summarizeLabels(group.bases),
      rmLabel: summarizeLabels(group.rms),
      rgmLabel: summarizeLabels(group.rgms),
      sellerCode: group.sellerCode,
      sellerName: group.sellerName,
      originLabel: summarizeLabels(group.origins, 3),
      sellerCount: group.sellers.size,
      baseCount: group.bases.size,
      awaiting: group.awaiting,
      processed: group.processed,
      total: group.total,
      rate: safeRate(group.processed, group.total),
    }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.rate - b.rate ||
        a.region.localeCompare(b.region, "pt-BR", { numeric: true }) ||
        a.base.localeCompare(b.base, "pt-BR", { numeric: true }) ||
        a.sellerName.localeCompare(b.sellerName, "pt-BR", { numeric: true }),
    );
}

export function filterSellerReportRows(
  rows: readonly SellerReportRow[],
  query: string,
): SellerReportRow[] {
  const normalizedQuery = query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
  if (!normalizedQuery) return [...rows];

  return rows.filter((row) =>
    `${row.sellerName} ${row.sellerCode} ${row.base} ${row.region} ${row.rmLabel} ${row.rgmLabel} ${row.tierLabel} ${row.originLabel}`
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .includes(normalizedQuery),
  );
}

export function classifySellerOutcome(row: SellerReportRow): SellerOutcome {
  if (row.processed <= 0) return "zero";
  if (row.awaiting <= 0) return "complete";
  return "partial";
}

export function summarizeSellerOutcomes(
  rows: readonly SellerReportRow[],
): SellerOutcomeSummary {
  const counts: Record<SellerOutcome, number> = {
    complete: 0,
    partial: 0,
    zero: 0,
  };

  for (const row of rows) counts[classifySellerOutcome(row)] += 1;

  return {
    total: rows.length,
    complete: { count: counts.complete, rate: safeRate(counts.complete, rows.length) },
    partial: { count: counts.partial, rate: safeRate(counts.partial, rows.length) },
    zero: { count: counts.zero, rate: safeRate(counts.zero, rows.length) },
  };
}

export function filterSellerRowsByOutcome(
  rows: readonly SellerReportRow[],
  outcome: SellerOutcome,
): SellerReportRow[] {
  return rows.filter((row) => classifySellerOutcome(row) === outcome);
}

export function sortSellerReportRowsByAwaiting(
  rows: readonly SellerReportRow[],
): SellerReportRow[] {
  return [...rows].sort(
    (a, b) =>
      b.awaiting - a.awaiting ||
      b.total - a.total ||
      a.rate - b.rate ||
      a.sellerName.localeCompare(b.sellerName, "pt-BR", { numeric: true }) ||
      a.key.localeCompare(b.key, "pt-BR", { numeric: true }),
  );
}

export function summarizeAwaitingByBaseAndRm(
  records: readonly SellerMetricRecord[],
): SellerBaseRmAwaitingSummary[] {
  const groups = new Map<string, Omit<SellerBaseRmAwaitingSummary, "rate">>();

  for (const record of records) {
    const rm = record.rm?.trim() || "Sem RM";
    const base = record.base.trim() || "Sem base";
    const key = `${base}::${rm}`;
    const current = groups.get(key) ?? {
      base,
      rm,
      awaiting: 0,
      processed: 0,
      total: 0,
    };
    current.awaiting += record.awaiting;
    current.processed += record.processed;
    current.total += record.total;
    groups.set(key, current);
  }

  return [...groups.values()]
    .filter((item) => item.awaiting > 0)
    .map((item) => ({
      ...item,
      rate: safeRate(item.processed, item.total),
    }))
    .sort(
      (a, b) =>
        b.awaiting - a.awaiting ||
        a.base.localeCompare(b.base, "pt-BR", { numeric: true }) ||
        a.rm.localeCompare(b.rm, "pt-BR", { numeric: true }),
    );
}

export function selectTopSellersBelowRate(
  rows: readonly SellerReportRow[],
  threshold: number,
  limit = 10,
): SellerReportRow[] {
  return rows
    .filter((row) => row.total > 0 && row.rate < threshold)
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.rate - b.rate ||
        a.sellerName.localeCompare(b.sellerName, "pt-BR", { numeric: true }),
    )
    .slice(0, Math.max(0, limit));
}
