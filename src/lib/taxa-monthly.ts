export interface TaxaMonthlyRecord {
  date: string;
  region: string;
  toCollect: number;
  collectedWithAttempts: number;
}

export interface TaxaMonthlyPoint {
  monthKey: string;
  toCollect: number;
  collectedWithAttempts: number;
  rate: number | null;
}

export interface TaxaMonthlyRegionalSeries {
  region: string;
  points: TaxaMonthlyPoint[];
  latestRate: number;
  totalToCollect: number;
}

export interface TaxaMonthlyResult {
  months: string[];
  regions: TaxaMonthlyRegionalSeries[];
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function isExcludedMonthlyRegion(region: string): boolean {
  const normalized = normalizeLabel(region);
  return normalized === "sem regional" || normalized === "bahia";
}

export function buildTaxaMonthlyRegionalSeries(
  records: readonly TaxaMonthlyRecord[],
): TaxaMonthlyResult {
  const eligible = records.filter(
    (record) => /^\d{4}-\d{2}-\d{2}$/.test(record.date) && !isExcludedMonthlyRegion(record.region),
  );
  const months = [...new Set(eligible.map((record) => record.date.slice(0, 7)))].sort();
  const groups = new Map<
    string,
    Map<string, { toCollect: number; collectedWithAttempts: number }>
  >();

  for (const record of eligible) {
    const monthKey = record.date.slice(0, 7);
    const byMonth = groups.get(record.region) ?? new Map();
    const current = byMonth.get(monthKey) ?? { toCollect: 0, collectedWithAttempts: 0 };
    current.toCollect += record.toCollect;
    current.collectedWithAttempts += record.collectedWithAttempts;
    byMonth.set(monthKey, current);
    groups.set(record.region, byMonth);
  }

  const regions = [...groups.entries()]
    .map(([region, byMonth]) => {
      const points = months.map((monthKey) => {
        const aggregate = byMonth.get(monthKey);
        const toCollect = aggregate?.toCollect ?? 0;
        const collectedWithAttempts = aggregate?.collectedWithAttempts ?? 0;
        return {
          monthKey,
          toCollect,
          collectedWithAttempts,
          rate: toCollect > 0 ? collectedWithAttempts / toCollect : null,
        };
      });
      const latestRate = [...points].reverse().find((point) => point.rate !== null)?.rate ?? 0;
      return {
        region,
        points,
        latestRate,
        totalToCollect: points.reduce((sum, point) => sum + point.toCollect, 0),
      };
    })
    .filter((series) => series.totalToCollect > 0)
    .sort((a, b) => a.region.localeCompare(b.region, "pt-BR", { numeric: true }));

  return { months, regions };
}
