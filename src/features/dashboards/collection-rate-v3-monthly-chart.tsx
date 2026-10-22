import type { CollectionRateV3MonthlyChartPoint } from "../../lib/data-foundation/collection-rate-v3-dashboard.ts";

interface Props {
  points: readonly CollectionRateV3MonthlyChartPoint[];
  locale: string;
  formatRate: (value: number | null) => string;
  t: (text: string, values?: Record<string, string | number>) => string;
}

export function CollectionRateV3MonthlyChart({ points, locale, formatRate, t }: Props) {
  const years = [...new Set(points.map((point) => point.month.slice(0, 4)))];
  const rates = points.flatMap((point) => [point.collectionRate, point.attemptRate]).filter((rate): rate is number => rate !== null && Number.isFinite(rate));
  const min = Math.min(0.75, Math.floor(Math.min(1, ...rates) * 10) / 10);
  const max = Math.max(1, Math.ceil(Math.max(0, ...rates) * 10) / 10);
  const ticks = min === 0.75 && max === 1 ? [0.75, 0.85, 0.95, 1] : Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  const x = (index: number) => points.length <= 1 ? 462 : 66 + index * 794 / (points.length - 1);
  const y = (rate: number) => 220 - (rate - min) / (max - min) * 178;
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", ...(years.length > 1 ? { year: "numeric" } as const : {}), timeZone: "UTC" });
  // A missing value breaks the line instead of connecting across unavailable months.
  const lines = (key: "collectionRate" | "attemptRate") => {
    const segments: string[] = [];
    let segment: string[] = [];
    points.forEach((point, index) => {
      const rate = point[key];
      if (rate === null) { if (segment.length) segments.push(segment.join(" ")); segment = []; }
      else segment.push(`${x(index)},${y(rate)}`);
    });
    if (segment.length) segments.push(segment.join(" "));
    return segments;
  };
  return <section className="chart-card taxa-v3-comparison-card" data-testid="taxa-v3-monthly-chart">
    <div className="card-heading"><div><span className="card-eyebrow">{t("RESULTADO GERAL")}</span><h2>{t("Taxa de coleta x taxa com tentativa")}</h2></div>{years.length ? <span className="taxa-v3-year-badge">{years.length === 1 ? t("Ano {year}", { year: years[0] }) : t("Período {period}", { period: `${years[0]}–${years.at(-1)}` })}</span> : null}</div>
    {points.length ? <>
      <div className="taxa-v3-comparison-plot">
        <svg viewBox="0 0 900 270" preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("Taxa de coleta x taxa com tentativa")}>
          {ticks.map((rate) => <g key={rate}><line className="taxa-v3-comparison-grid" x1="66" x2="860" y1={y(rate)} y2={y(rate)} /><text className="taxa-v3-comparison-axis" x="8" y={y(rate) + 4}>{formatRate(rate)}</text></g>)}
          {(["collectionRate", "attemptRate"] as const).map((key) => <g key={key} className={key === "collectionRate" ? "taxa-v3-series-collection" : "taxa-v3-series-attempt"}>
            {lines(key).map((line, index) => <polyline key={index} points={line} />)}
            {points.map((point, index) => point[key] === null ? null : <g key={point.month}><circle cx={x(index)} cy={y(point[key])} r="5" /><text x={x(index)} y={y(point[key]) + (key === "collectionRate" ? -12 : 19)} textAnchor="middle">{formatRate(point[key])}</text><title>{`${point.month}: ${formatRate(point[key])}`}</title></g>)}
          </g>)}
          {points.map((point, index) => <text key={point.month} className="taxa-v3-comparison-axis" x={x(index)} y="252" textAnchor="middle">{monthFormat.format(new Date(`${point.month}-01T12:00:00Z`))}</text>)}
        </svg>
      </div>
      <div className="taxa-v3-comparison-legend"><span><i className="taxa-v3-legend-collection" />{t("Taxa de coleta")}</span><span><i className="taxa-v3-legend-attempt" />{t("Taxa com tentativa")}</span></div>
    </> : <p className="filter-note">{t("Sem datas publicadas no período.")}</p>}
  </section>;
}
