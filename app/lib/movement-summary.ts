export const MOVEMENT_SUMMARY_METRICS = [
  ["totalStopped", "Total sem movimentação"],
  ["from2Days", "Total há 2 dias ou mais"],
  ...[1, 2, 3, 4, 5, 6, 7, 10, 14, 30].map((day) => [`over${day}${day === 1 ? "Day" : "Days"}`, `Sem mov. há mais de ${day} ${day === 1 ? "dia" : "dias"}`]),
] as readonly (readonly string[])[];

export function selectMovementSummaryMetric<T extends { totalStopped: number; quantity: number }>(record: T, metric: string): T {
  if (metric === "totalStopped") return record;
  const ageKeys = MOVEMENT_SUMMARY_METRICS.slice(2).map(([key]) => key);
  const selectedKeys = metric === "from2Days" ? ageKeys.slice(1) : ageKeys.filter((key) => key === metric);
  const values = record as T & Record<string, unknown>;
  const total = selectedKeys.reduce((sum, key) => sum + Number(values[key] ?? 0), 0);
  return { ...record, ...Object.fromEntries(ageKeys.map((key) => [key, selectedKeys.includes(key) ? values[key] : 0])), totalStopped: total, quantity: total };
}
