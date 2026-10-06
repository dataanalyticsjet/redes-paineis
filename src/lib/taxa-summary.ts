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
  collectionWithAttemptsRate: number;
  onTimeRate: number;
  activeBases: number;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
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
    collectionWithAttemptsRate: rate(collectedWithAttempts, toCollect),
    onTimeRate: rate(onTime, toCollect),
    activeBases: activeBases.size,
  };
}
