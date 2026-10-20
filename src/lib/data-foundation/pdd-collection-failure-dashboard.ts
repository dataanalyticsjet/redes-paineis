import type { PddCollectionFailureV2Period, PddCollectionFailureV2Record } from "./pdd-collection-failure.ts";

export const PDD_COLLECTION_FAILURE_V2_HEADERS = [
  "Data considerada",
  "Código da Regional do PDD Responsável",
  "Nome da Regional do PDD Responsável",
  "Código da base",
  "Nome do PDD Responsável",
  "Código da origem do pedido",
  "Origem do Pedido",
  "Qtd pedidos a bipar",
  "Qtd pedidos não bipados no recebimento da coleta",
  "Taxa de pedidos não bipados no recebimento da coleta",
  "Qtd pedidos não bipados na coleta",
  "Taxa de falta de bipagem na coleta",
  "Qtd de Pacotes com Falta de Bipe de Envio",
  "Taxa de pedidos não bipados na expedição",
  "Taxa geral de falta de bipagem",
] as const;

export const PDD_COLLECTION_FAILURE_V2_FIELDS = [
  "data_date",
  "source_region_code",
  "reported_region",
  "source_base_code",
  "source_base_name",
  "order_origin_code",
  "order_origin",
  "total_orders",
  "orders_unscanned_at_receipt",
  "rate_unscanned_at_receipt",
  "orders_unscanned_at_collection",
  "collection_failure_rate",
  "packages_missing_dispatch_scan",
  "rate_unscanned_at_dispatch",
  "overall_unscanned_rate",
] as const satisfies readonly (keyof PddCollectionFailureV2Record)[];

export const PDD_UNASSIGNED_REGION = "Sem regional";
export const PDD_UNASSIGNED_RM = "Sem RM";
export const PDD_UNASSIGNED_RGM = "Sem RGM";
export const PDD_UNASSIGNED_RM_AREA = "Sem região do RM";

export function isPddCollectionFailureV2SingleOperationalDate(period: PddCollectionFailureV2Period): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(period.dateFrom) && period.dateFrom === period.dateTo;
}

export interface PddCollectionFailureV2Dimensions {
  region: string;
  base: string;
  baseCode: string;
  rmArea: string;
  rm: string;
  rgm: string;
  origin: string;
}

export interface PddCollectionFailureV2Metrics {
  totalOrders: number;
  ordersUnscannedAtReceipt: number;
  ordersUnscannedAtCollection: number;
  collectionFailureRate: number;
}

export interface PddCollectionFailureV2RegionalSummary extends PddCollectionFailureV2Metrics {
  region: string;
  rgm: string;
  baseCount: number;
}

export interface PddCollectionFailureV2RmSummary extends PddCollectionFailureV2Metrics {
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  baseCount: number;
}

export interface PddCollectionFailureV2BaseSummary extends PddCollectionFailureV2Metrics, PddCollectionFailureV2Dimensions {
  key: string;
}

export interface PddCollectionFailureV2Filters {
  regions: ReadonlySet<string>;
  rms: ReadonlySet<string>;
  rgms: ReadonlySet<string>;
  bases: ReadonlySet<string>;
  origins: ReadonlySet<string>;
}

export type PddCollectionFailureV2Selections = {
  [Dimension in keyof PddCollectionFailureV2Filters]?: ReadonlySet<string> | null;
};

export interface PddCollectionFailureV2Analysis {
  options: ReturnType<typeof pddCollectionFailureV2FilterOptions>;
  filteredRecords: PddCollectionFailureV2Record[];
  summary: PddCollectionFailureV2Metrics;
  regionalSummary: PddCollectionFailureV2RegionalSummary[];
  rmSummary: PddCollectionFailureV2RmSummary[];
  baseSummary: PddCollectionFailureV2BaseSummary[];
}

function text(value: unknown, fallback = "—"): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function quantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function assertSingleOperationalDate(records: readonly PddCollectionFailureV2Record[]): void {
  const dates = new Set(records.map((record) => String(record.data_date ?? "").slice(0, 10)));
  if (dates.size > 1) throw new RangeError("pdd_multiple_operational_dates_not_supported");
}

export function pddCollectionFailureV2Dimensions(
  record: PddCollectionFailureV2Record,
): PddCollectionFailureV2Dimensions {
  const baseCode = text(record.effective_base_code ?? record.resolved_base_code ?? record.source_base_code, "Sem código");
  return {
    // Only the published DoomsDay assignment classifies operational region.
    // The source regional field remains available in the raw detail table.
    region: text(record.effective_region, PDD_UNASSIGNED_REGION),
    base: text(record.effective_base_name ?? record.source_base_name, "Sem base"),
    baseCode,
    rmArea: text(record.effective_rm_area, PDD_UNASSIGNED_RM_AREA),
    rm: text(record.effective_rm, PDD_UNASSIGNED_RM),
    rgm: text(record.effective_rgm, PDD_UNASSIGNED_RGM),
    origin: text(record.order_origin, "Sem origem"),
  };
}

export function pddCollectionFailureV2FilterOptions(records: readonly PddCollectionFailureV2Record[]) {
  const regions = new Set<string>();
  const rms = new Set<string>();
  const rgms = new Set<string>();
  const bases = new Set<string>();
  const origins = new Set<string>();
  const rmAreas = new Set<string>();
  for (const record of records) {
    const dimensions = pddCollectionFailureV2Dimensions(record);
    regions.add(dimensions.region);
    rms.add(dimensions.rm);
    rgms.add(dimensions.rgm);
    bases.add(dimensions.base);
    origins.add(dimensions.origin);
    rmAreas.add(dimensions.rmArea);
  }
  const options = (values: ReadonlySet<string>) => [...values].sort((left, right) =>
    left.localeCompare(right, "pt-BR", { numeric: true }),
  );
  return {
    regions: options(regions),
    rms: options(rms),
    rgms: options(rgms),
    bases: options(bases),
    origins: options(origins),
    rmAreas: options(rmAreas),
  };
}

export function filterPddCollectionFailureV2Records(
  records: readonly PddCollectionFailureV2Record[],
  filters: PddCollectionFailureV2Filters,
): PddCollectionFailureV2Record[] {
  return records.filter((record) => {
    const dimension = pddCollectionFailureV2Dimensions(record);
    return filters.regions.has(dimension.region) &&
      filters.rms.has(dimension.rm) &&
      filters.rgms.has(dimension.rgm) &&
      filters.bases.has(dimension.base) &&
      filters.origins.has(dimension.origin);
  });
}

function emptyMetrics(): PddCollectionFailureV2Metrics {
  return { totalOrders: 0, ordersUnscannedAtReceipt: 0, ordersUnscannedAtCollection: 0, collectionFailureRate: 0 };
}

function addRecord(metrics: PddCollectionFailureV2Metrics, record: PddCollectionFailureV2Record): void {
  metrics.totalOrders += quantity(record.total_orders);
  metrics.ordersUnscannedAtReceipt += quantity(record.orders_unscanned_at_receipt);
  metrics.ordersUnscannedAtCollection += quantity(record.orders_unscanned_at_collection);
}

export function summarizePddCollectionFailureV2(
  records: readonly PddCollectionFailureV2Record[],
): PddCollectionFailureV2Metrics {
  assertSingleOperationalDate(records);
  const metrics = emptyMetrics();
  for (const record of records) addRecord(metrics, record);
  metrics.collectionFailureRate = metrics.totalOrders === 0
    ? 0
    : metrics.ordersUnscannedAtCollection / metrics.totalOrders;
  return metrics;
}

export function summarizePddCollectionFailureV2ByRegion(
  records: readonly PddCollectionFailureV2Record[],
): PddCollectionFailureV2RegionalSummary[] {
  assertSingleOperationalDate(records);
  const groups = new Map<string, { dimensions: PddCollectionFailureV2Dimensions; metrics: PddCollectionFailureV2Metrics; bases: Set<string> }>();
  for (const record of records) {
    const dimensions = pddCollectionFailureV2Dimensions(record);
    const group = groups.get(dimensions.region) ?? {
      dimensions, metrics: emptyMetrics(), bases: new Set<string>(),
    };
    addRecord(group.metrics, record);
    group.bases.add(`${dimensions.baseCode}\u0000${dimensions.base}`);
    groups.set(dimensions.region, group);
  }
  return [...groups].map(([region, group]) => ({
    region,
    rgm: group.dimensions.rgm,
    baseCount: group.bases.size,
    ...group.metrics,
    collectionFailureRate: group.metrics.totalOrders === 0 ? 0 : group.metrics.ordersUnscannedAtCollection / group.metrics.totalOrders,
  })).sort((left, right) => right.totalOrders - left.totalOrders || left.region.localeCompare(right.region, "pt-BR"));
}

export function summarizePddCollectionFailureV2ByRm(
  records: readonly PddCollectionFailureV2Record[],
): PddCollectionFailureV2RmSummary[] {
  assertSingleOperationalDate(records);
  const groups = new Map<string, { dimensions: PddCollectionFailureV2Dimensions; metrics: PddCollectionFailureV2Metrics; bases: Set<string> }>();
  for (const record of records) {
    const dimensions = pddCollectionFailureV2Dimensions(record);
    const key = JSON.stringify([dimensions.region, dimensions.rmArea, dimensions.rm, dimensions.rgm]);
    const group = groups.get(key) ?? { dimensions, metrics: emptyMetrics(), bases: new Set<string>() };
    addRecord(group.metrics, record);
    group.bases.add(`${dimensions.baseCode}\u0000${dimensions.base}`);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ dimensions, metrics, bases }) => ({
    region: dimensions.region,
    rmArea: dimensions.rmArea,
    rm: dimensions.rm,
    rgm: dimensions.rgm,
    baseCount: bases.size,
    ...metrics,
    collectionFailureRate: metrics.totalOrders === 0 ? 0 : metrics.ordersUnscannedAtCollection / metrics.totalOrders,
  })).sort((left, right) => right.totalOrders - left.totalOrders || left.rm.localeCompare(right.rm, "pt-BR"));
}

export function summarizePddCollectionFailureV2ByBase(
  records: readonly PddCollectionFailureV2Record[],
): PddCollectionFailureV2BaseSummary[] {
  assertSingleOperationalDate(records);
  const groups = new Map<string, PddCollectionFailureV2BaseSummary>();
  for (const record of records) {
    const dimensions = pddCollectionFailureV2Dimensions(record);
    const key = JSON.stringify([dimensions.region, dimensions.baseCode, dimensions.base]);
    const group = groups.get(key) ?? { key, ...dimensions, ...emptyMetrics() };
    addRecord(group, record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    collectionFailureRate: group.totalOrders === 0 ? 0 : group.ordersUnscannedAtCollection / group.totalOrders,
  })).sort((left, right) => right.ordersUnscannedAtCollection - left.ordersUnscannedAtCollection || left.base.localeCompare(right.base, "pt-BR", { numeric: true }));
}

function finalizeMetrics(metrics: PddCollectionFailureV2Metrics): PddCollectionFailureV2Metrics {
  return {
    ...metrics,
    collectionFailureRate: metrics.totalOrders === 0
      ? 0
      : metrics.ordersUnscannedAtCollection / metrics.totalOrders,
  };
}

/**
 * Build the PDD filter options and all filtered summaries in one source-row pass.
 * This keeps the official formulas and grouping keys shared with the legacy helpers.
 */
export function analyzePddCollectionFailureV2(
  records: readonly PddCollectionFailureV2Record[],
  selections: PddCollectionFailureV2Selections = {},
): PddCollectionFailureV2Analysis {
  const optionSets = {
    regions: new Set<string>(),
    rms: new Set<string>(),
    rgms: new Set<string>(),
    bases: new Set<string>(),
    origins: new Set<string>(),
    rmAreas: new Set<string>(),
  };
  const filteredRecords: PddCollectionFailureV2Record[] = [];
  const summary = emptyMetrics();
  const regions = new Map<string, {
    dimensions: PddCollectionFailureV2Dimensions;
    metrics: PddCollectionFailureV2Metrics;
    bases: Set<string>;
  }>();
  const rms = new Map<string, {
    dimensions: PddCollectionFailureV2Dimensions;
    metrics: PddCollectionFailureV2Metrics;
    bases: Set<string>;
  }>();
  const bases = new Map<string, PddCollectionFailureV2BaseSummary>();

  for (const record of records) {
    const dimensions = pddCollectionFailureV2Dimensions(record);
    optionSets.regions.add(dimensions.region);
    optionSets.rms.add(dimensions.rm);
    optionSets.rgms.add(dimensions.rgm);
    optionSets.bases.add(dimensions.base);
    optionSets.origins.add(dimensions.origin);
    optionSets.rmAreas.add(dimensions.rmArea);

    if (
      (selections.regions && !selections.regions.has(dimensions.region)) ||
      (selections.rms && !selections.rms.has(dimensions.rm)) ||
      (selections.rgms && !selections.rgms.has(dimensions.rgm)) ||
      (selections.bases && !selections.bases.has(dimensions.base)) ||
      (selections.origins && !selections.origins.has(dimensions.origin))
    ) continue;

    filteredRecords.push(record);
    addRecord(summary, record);

    const baseIdentity = `${dimensions.baseCode}\u0000${dimensions.base}`;
    let regionGroup = regions.get(dimensions.region);
    if (!regionGroup) {
      regionGroup = { dimensions, metrics: emptyMetrics(), bases: new Set<string>() };
      regions.set(dimensions.region, regionGroup);
    }
    addRecord(regionGroup.metrics, record);
    regionGroup.bases.add(baseIdentity);

    const rmKey = JSON.stringify([dimensions.region, dimensions.rmArea, dimensions.rm, dimensions.rgm]);
    let rmGroup = rms.get(rmKey);
    if (!rmGroup) {
      rmGroup = { dimensions, metrics: emptyMetrics(), bases: new Set<string>() };
      rms.set(rmKey, rmGroup);
    }
    addRecord(rmGroup.metrics, record);
    rmGroup.bases.add(baseIdentity);

    const baseKey = JSON.stringify([dimensions.region, dimensions.baseCode, dimensions.base]);
    let baseGroup = bases.get(baseKey);
    if (!baseGroup) {
      baseGroup = { key: baseKey, ...dimensions, ...emptyMetrics() };
      bases.set(baseKey, baseGroup);
    }
    addRecord(baseGroup, record);
  }

  assertSingleOperationalDate(filteredRecords);
  const sortedOptions = (values: ReadonlySet<string>) => [...values].sort((left, right) =>
    left.localeCompare(right, "pt-BR", { numeric: true }),
  );
  return {
    options: {
      regions: sortedOptions(optionSets.regions),
      rms: sortedOptions(optionSets.rms),
      rgms: sortedOptions(optionSets.rgms),
      bases: sortedOptions(optionSets.bases),
      origins: sortedOptions(optionSets.origins),
      rmAreas: sortedOptions(optionSets.rmAreas),
    },
    filteredRecords,
    summary: finalizeMetrics(summary),
    regionalSummary: [...regions].map(([region, group]) => ({
      region,
      rgm: group.dimensions.rgm,
      baseCount: group.bases.size,
      ...finalizeMetrics(group.metrics),
    })).sort((left, right) => right.totalOrders - left.totalOrders || left.region.localeCompare(right.region, "pt-BR")),
    rmSummary: [...rms.values()].map((group) => ({
      region: group.dimensions.region,
      rmArea: group.dimensions.rmArea,
      rm: group.dimensions.rm,
      rgm: group.dimensions.rgm,
      baseCount: group.bases.size,
      ...finalizeMetrics(group.metrics),
    })).sort((left, right) => right.totalOrders - left.totalOrders || left.rm.localeCompare(right.rm, "pt-BR")),
    baseSummary: [...bases.values()].map((group) => ({
      ...group,
      collectionFailureRate: group.totalOrders === 0 ? 0 : group.ordersUnscannedAtCollection / group.totalOrders,
    })).sort((left, right) => right.ordersUnscannedAtCollection - left.ordersUnscannedAtCollection || left.base.localeCompare(right.base, "pt-BR", { numeric: true })),
  };
}
