export interface TaxaSummaryMeasure {
  orders: number;
  toCollect: number;
  collected: number;
  notCollected: number;
  onTime: number;
  collectedWithAttempts: number;
  base: string;
}

export interface TaxaPeriodSummary {
  orders: number;
  toCollect: number;
  collected: number;
  notCollected: number;
  onTime: number;
  collectedWithAttempts: number;
  collectionWithAttemptsRate: number | null;
  onTimeRate: number | null;
  awaitingRate: number | null;
  activeBases: number;
}

export interface TaxaMonthlyMeasure {
  date: string;
  toCollect: number;
  onTime: number;
  collectedWithAttempts: number;
}

export interface TaxaMonthlySummary {
  monthKey: string;
  toCollect: number;
  onTime: number;
  collectedWithAttempts: number;
  onTimeRate: number | null;
  attemptRate: number | null;
}

export interface TaxaLegacyAverageMeasure {
  toCollect: number;
  collected: number;
  averageCollectionHours: number;
}

/** A Taxa rate is undefined when there is no planned volume to divide by. */
export function taxaRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function formatTaxaRate(value: number | null, locale = "pt-BR"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Group every selected record by YYYY-MM and calculate rates from monthly sums.
 * This intentionally includes every source regional value, including blank or
 * otherwise unmapped region labels.
 */
export function summarizeTaxaByMonth(records: readonly TaxaMonthlyMeasure[]): TaxaMonthlySummary[] {
  const groups = new Map<string, Omit<TaxaMonthlySummary, "onTimeRate" | "attemptRate">>();
  for (const record of records) {
    const monthKey = record.date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(monthKey)) continue;
    const current = groups.get(monthKey) ?? {
      monthKey,
      toCollect: 0,
      onTime: 0,
      collectedWithAttempts: 0,
    };
    current.toCollect += record.toCollect;
    current.onTime += record.onTime;
    current.collectedWithAttempts += record.collectedWithAttempts;
    groups.set(monthKey, current);
  }
  return [...groups.values()]
    .sort((left, right) => left.monthKey.localeCompare(right.monthKey))
    .map((month) => ({
      ...month,
      onTimeRate: taxaRate(month.onTime, month.toCollect),
      attemptRate: taxaRate(month.collectedWithAttempts, month.toCollect),
    }));
}

/**
 * Preserve the dashboard's existing Prazo médio aggregation while isolating it
 * for later validation. The source does not document this weighting as the
 * official formula: each row uses max(planned, collected, 1) as its weight.
 */
export function legacyTaxaAverageCollectionHours(records: readonly TaxaLegacyAverageMeasure[]): number {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const record of records) {
    const weight = Math.max(record.toCollect, record.collected, 1);
    weightedTotal += record.averageCollectionHours * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedTotal / totalWeight : 0;
}

/**
 * Reproduces the JMS total row: sum the source volumes first and calculate
 * both percentages only after the selected rows have been consolidated.
 */
export function summarizeTaxaPeriod(
  records: readonly TaxaSummaryMeasure[],
): TaxaPeriodSummary {
  let orders = 0;
  let toCollect = 0;
  let collected = 0;
  let notCollected = 0;
  let onTime = 0;
  let collectedWithAttempts = 0;
  const activeBases = new Set<string>();

  for (const record of records) {
    orders += record.orders;
    toCollect += record.toCollect;
    collected += record.collected;
    notCollected += record.notCollected;
    onTime += record.onTime;
    collectedWithAttempts += record.collectedWithAttempts;
    if (record.toCollect > 0 || record.orders > 0) activeBases.add(record.base);
  }

  return {
    orders,
    toCollect,
    collected,
    notCollected,
    onTime,
    collectedWithAttempts,
    collectionWithAttemptsRate: taxaRate(collectedWithAttempts, toCollect),
    onTimeRate: taxaRate(onTime, toCollect),
    awaitingRate: taxaRate(notCollected, toCollect),
    activeBases: activeBases.size,
  };
}
