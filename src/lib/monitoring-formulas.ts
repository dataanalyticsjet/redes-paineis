export interface MonitoringFormulaInput {
  orderVolume: number;
  awaiting: number;
}

export type MonitoringStatusMeasure = "planned" | "awaiting" | "collected";

export interface MonitoringStatusMetrics extends MonitoringFormulaInput {
  collected: number;
}

export function monitoringCollectedVolume({ orderVolume, awaiting }: MonitoringFormulaInput): number {
  return Math.max(0, orderVolume - awaiting);
}

export function summarizeMonitoringStatusValues(
  statuses: readonly string[],
  values: ReadonlyMap<string, number>,
  measureForStatus: (status: string) => MonitoringStatusMeasure | null,
): MonitoringStatusMetrics {
  const totals: MonitoringFormulaInput = { orderVolume: 0, awaiting: 0 };
  for (const status of statuses) {
    const value = values.get(status) ?? 0;
    const measure = measureForStatus(status);
    if (measure === "planned") totals.orderVolume += value;
    if (measure === "awaiting") totals.awaiting += value;
  }
  return { ...totals, collected: monitoringCollectedVolume(totals) };
}

export function monitoringCollectionRate(input: MonitoringFormulaInput): number {
  return input.orderVolume > 0 ? monitoringCollectedVolume(input) / input.orderVolume : 0;
}

export function monitoringAwaitingRate({ orderVolume, awaiting }: MonitoringFormulaInput): number {
  return orderVolume > 0 ? awaiting / orderVolume : 0;
}
