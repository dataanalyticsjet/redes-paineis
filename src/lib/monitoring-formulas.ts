export interface MonitoringFormulaInput {
  orderVolume: number;
  awaiting: number;
}

export function monitoringCollectedVolume({ orderVolume, awaiting }: MonitoringFormulaInput): number {
  return Math.max(0, orderVolume - awaiting);
}

export function monitoringCollectionRate(input: MonitoringFormulaInput): number {
  return input.orderVolume > 0 ? monitoringCollectedVolume(input) / input.orderVolume : 0;
}

export function monitoringAwaitingRate({ orderVolume, awaiting }: MonitoringFormulaInput): number {
  return orderVolume > 0 ? awaiting / orderVolume : 0;
}
