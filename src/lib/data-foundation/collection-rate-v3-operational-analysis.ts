import type { CollectionRateV3DashboardRow } from "./collection-rate-v3-dashboard.ts";

export interface CollectionRateV3AnalysisPeriod {
  dateFrom: string;
  dateTo: string;
}

export interface CollectionRateV3AnalysisRegion {
  region: string;
  numerator: number;
  denominator: number;
  rate: number | null;
  deviationImpact: number;
}

export interface CollectionRateV3AnalysisBase extends CollectionRateV3AnalysisRegion {
  code: string;
  name: string;
  rm: string;
  rgm: string;
}

export interface CollectionRateV3OperationalAnalysis {
  period: CollectionRateV3AnalysisPeriod;
  rowCount: number;
  publicationCount: number;
  numerator: number;
  denominator: number;
  unmappedDenominator: number;
  rate: number | null;
  targetRate: null;
  regions: CollectionRateV3AnalysisRegion[];
  worstRegions: CollectionRateV3AnalysisRegion[];
  regionalPriorities: CollectionRateV3AnalysisRegion[];
  basePriorities: CollectionRateV3AnalysisBase[];
  message: string;
}

type Aggregate = { numerator: number; denominator: number };

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function rateOf(value: Aggregate): number | null {
  return value.denominator > 0 ? value.numerator / value.denominator : null;
}

function add(target: Aggregate, row: CollectionRateV3DashboardRow): void {
  target.numerator += count(row.collected_plus_attempts_quantity);
  target.denominator += count(row.quantity_to_collect);
}

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function formatRate(value: number | null, locale: string): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "—";
}

function deviationImpact(overallRate: number | null, value: Aggregate): number {
  if (overallRate === null || value.denominator <= 0) return 0;
  return Math.max(0, overallRate * value.denominator - value.numerator);
}

function formatScope(filters: readonly { label: string; values: readonly string[] }[], chinese = false): string {
  const active = filters.filter((item) => item.values.length > 0);
  if (active.length === 0) {
    return chinese ? "当前授权数据范围内的所有区域和维度" : "todas as opções disponíveis no escopo autorizado";
  }
  const chineseLabels: Record<string, string> = {
    Regional: "区域",
    RM: "RM",
    "Região do RM": "RM区域",
    RGM: "RGM",
    Base: "网点",
    Origem: "来源",
    "Tipo de produto": "产品类型",
  };
  return active.map((item) => `${chinese ? chineseLabels[item.label] ?? item.label : item.label}: ${item.values.join(", ")}`).join(" · ");
}

/**
 * Produces a deterministic operational synthesis from the exact, already-authorized
 * and dashboard-filtered Data Foundation rows. It never fetches or broadens the scope.
 */
export function buildCollectionRateV3OperationalAnalysis(
  rows: readonly CollectionRateV3DashboardRow[],
  options: {
    period: CollectionRateV3AnalysisPeriod;
    publicationIds?: readonly string[];
    filters?: readonly { label: string; values: readonly string[] }[];
    locale?: string;
    latestDayMayBeIncomplete?: boolean;
    generatedAt?: Date;
    regionLimit?: number;
    baseLimit?: number;
  },
): CollectionRateV3OperationalAnalysis {
  const locale = options.locale ?? "pt-BR";
  const periodRows = rows.filter((row) => row.data_date >= options.period.dateFrom && row.data_date <= options.period.dateTo);
  const total: Aggregate = { numerator: 0, denominator: 0 };
  const regionMap = new Map<string, Aggregate>();
  const baseMap = new Map<string, CollectionRateV3AnalysisBase>();
  let unmappedDenominator = 0;

  for (const row of periodRows) {
    add(total, row);
    const regionName = String(row.region || "Sem regional").trim() || "Sem regional";
    const regional = regionMap.get(regionName) ?? { numerator: 0, denominator: 0 };
    add(regional, row);
    regionMap.set(regionName, regional);

    const code = String(row.baseCode || "").trim();
    if (regionName === "Sem regional" || !code || code === "—") {
      unmappedDenominator += count(row.quantity_to_collect);
      continue;
    }
    const name = String(row.base || row.source_base_name || "Sem base").trim() || "Sem base";
    const key = `${regionName}\u0000${code || name}`;
    const base = baseMap.get(key) ?? {
      region: regionName,
      code,
      name,
      rm: String(row.rm || "Sem RM"),
      rgm: String(row.rgm || "Sem RGM"),
      numerator: 0,
      denominator: 0,
      rate: null,
      deviationImpact: 0,
    };
    add(base, row);
    baseMap.set(key, base);
  }

  const overallRate = rateOf(total);
  const regions = [...regionMap.entries()].map(([region, aggregate]) => ({
    region,
    ...aggregate,
    rate: rateOf(aggregate),
    deviationImpact: deviationImpact(overallRate, aggregate),
  }));
  const worstRegions = [...regions]
    .filter((item) => item.rate !== null)
    .sort((left, right) => (left.rate ?? 0) - (right.rate ?? 0) || right.denominator - left.denominator || left.region.localeCompare(right.region, "pt-BR"))
    .slice(0, 3);
  const regionalPriorities = regions
    .filter((item) => item.rate !== null && overallRate !== null && item.rate < overallRate)
    .sort((left, right) => right.deviationImpact - left.deviationImpact || right.denominator - left.denominator || left.region.localeCompare(right.region, "pt-BR"))
    .slice(0, Math.max(0, options.regionLimit ?? 5));
  const basePriorities = [...baseMap.values()]
    .map((item) => ({ ...item, rate: rateOf(item), deviationImpact: deviationImpact(overallRate, item) }))
    .filter((item) => item.denominator > 0 && item.rate !== null && overallRate !== null && item.rate < overallRate)
    .sort((left, right) => right.deviationImpact - left.deviationImpact || right.denominator - left.denominator || left.region.localeCompare(right.region, "pt-BR") || left.name.localeCompare(right.name, "pt-BR"))
    .slice(0, Math.max(0, options.baseLimit ?? 8));

  const now = options.generatedAt ?? new Date();
  const hourInSaoPaulo = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(now));
  const greetingPt = hourInSaoPaulo < 12 ? "Bom dia, pessoal!" : "Boa tarde, pessoal!";
  const greetingZh = hourInSaoPaulo < 12 ? "大家早上好！" : "大家下午好！";
  const scope = formatScope(options.filters ?? []);
  const scopeZh = formatScope(options.filters ?? [], true);
  const start = dateLabel(options.period.dateFrom);
  const end = dateLabel(options.period.dateTo);
  const periodLabel = start === end ? start : `${start} a ${end}`;
  const denominatorLabel = formatCount(total.denominator, locale);
  const numeratorLabel = formatCount(total.numerator, locale);
  const rateLabel = formatRate(overallRate, locale);
  const publicationCount = new Set(options.publicationIds ?? []).size;
  const lines = [
    greetingPt,
    greetingZh,
    "",
    `📊 **TAXA DE TENTATIVA — ${periodLabel} | 尝试揽收率**`,
    `Recorte do painel: ${scope}`,
    `面板筛选范围：${scopeZh}`,
    `Período analisado: **${periodLabel}** | Publicações diárias no conjunto: **${publicationCount}**`,
    `分析期间：**${periodLabel}** | 所含每日发布版本：**${publicationCount}**`,
    ...(options.latestDayMayBeIncomplete ? [
      "⚠️ O último dia do período pode estar incompleto; os valores não foram ajustados.",
      "⚠️ 所选期间的最后一天可能尚未完整，数值未作调整。",
    ] : []),
    `Taxa consolidada: **${rateLabel}**`,
    `加权汇总比率：**${overallRate === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(overallRate)}**`,
    `Numerador oficial (coleta + tentativas): **${numeratorLabel}**`,
    `官方分子（揽收 + 尝试）：**${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(total.numerator)}**`,
    `Denominador oficial (quantidade a coletar): **${denominatorLabel}**`,
    `官方分母（待揽收数量）：**${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(total.denominator)}**`,
    `Linhas no recorte: **${formatCount(periodRows.length, locale)}**`,
    `筛选范围内的行数：**${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(periodRows.length)}**`,
    "",
    "ℹ️ **Meta oficial**",
    "Não foi identificada uma meta oficial única para a Taxa de Tentativa nesta fonte. Nenhuma meta de Taxa de Coleta foi reutilizada.",
    "该数据源未确认统一的尝试揽收率官方目标；未将普通揽收率目标套用于此指标。",
    "",
    "📍 **Desempenho por regional / 区域表现**",
  ];

  if (regions.length === 0) {
    lines.push("Não há linhas no recorte autorizado para calcular resultados regionais.", "授权筛选范围内没有可用于区域分析的数据。");
  } else {
    const sortedRegions = [...regions].sort((left, right) => (right.rate ?? -1) - (left.rate ?? -1) || right.denominator - left.denominator || left.region.localeCompare(right.region, "pt-BR"));
    const best = sortedRegions.slice(0, 3);
    lines.push("Melhores resultados (taxa e volume do denominador):");
    lines.push("最佳表现（比率及分母数量）：");
    for (const item of best) lines.push(`• **${item.region}** — ${formatRate(item.rate, locale)} | volume ${formatCount(item.denominator, locale)}`);
    lines.push("Menores taxas observadas (apenas descritivo; volume apresentado para contexto):");
    lines.push("观察到的较低比率（仅作描述，并列出数量作为背景）：");
    for (const item of worstRegions) lines.push(`• **${item.region}** — ${formatRate(item.rate, locale)} | volume ${formatCount(item.denominator, locale)}`);
    if (regionalPriorities.length) {
      lines.push("Regionais abaixo da taxa consolidada, ordenadas pelo desvio estimado ponderado pelo volume:");
      lines.push("低于加权汇总比率的区域，按数量加权估算偏差排序：");
      for (const item of regionalPriorities) lines.push(`• **${item.region}** — ${formatRate(item.rate, locale)} | volume ${formatCount(item.denominator, locale)} | desvio relativo estimado ${formatCount(Math.round(item.deviationImpact), locale)}`);
    } else {
      lines.push("Nenhuma regional ficou abaixo da taxa consolidada ponderada neste recorte; isso não significa que uma meta oficial foi atingida.");
    }
  }

  if (unmappedDenominator > 0) {
    lines.push(
      "",
      `ℹ️ Volume sem atribuição oficial de regional/base mantido no consolidado: ${formatCount(unmappedDenominator, locale)}. Esses registros não foram atribuídos a bases nos rankings.`,
      `ℹ️ 未正式关联区域/网点的数量仍计入汇总：${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(unmappedDenominator)}。这些记录未被分配到网点排名。`,
    );
  }

  lines.push("", "🏢 **Bases para acompanhamento / 网点跟进**");
  if (basePriorities.length) {
    lines.push("Bases abaixo da taxa consolidada, priorizadas pelo volume e pelo desvio relativo estimado (não por baixa taxa isolada):");
    lines.push("低于加权汇总比率的网点，按数量及估算偏差排序（并非仅按低比率）：");
    for (const item of basePriorities) {
      lines.push(`• **${item.name}** (${item.code || "código não informado"}) — ${item.region} | ${formatRate(item.rate, locale)} | volume ${formatCount(item.denominator, locale)} | desvio relativo estimado ${formatCount(Math.round(item.deviationImpact), locale)} | RM: ${item.rm} | RGM: ${item.rgm}`);
    }
  } else {
    lines.push("Não há bases com volume positivo abaixo da taxa consolidada neste recorte, ou os dados são insuficientes para priorização.");
  }

  lines.push(
    "",
    "🔎 **Diagnóstico e recomendações / 运营诊断与建议**",
    overallRate === null
      ? "Denominador sem volume positivo: a taxa não pode ser calculada. Não há base suficiente para diagnosticar desempenho ou montar rankings."
      : regionalPriorities.length || basePriorities.length
        ? "O desvio observado é exclusivamente estatístico em relação à taxa consolidada deste mesmo recorte; os dados não identificam a causa operacional. Investigue os registros e processos das prioridades listadas e acompanhe novamente a mesma métrica e o mesmo período após as ações."
        : "Os dados não mostram desvio regional/base abaixo da taxa consolidada do recorte. Sem uma meta oficial confirmada ou dados de causa, não é possível concluir conformidade nem apontar causas. Continue monitorando esta taxa no mesmo escopo e período comparável.",
    "当前数据只能证明与本筛选范围加权汇总值的统计差异，不能确定运营原因。应检查相关记录和流程，并在后续以相同指标、范围和可比期间复核。",
    "",
    "Prioridade estimada é uma comparação matemática com a taxa ponderada do recorte, não representa backlog observado, meta nem causa operacional.",
    "排序为与当前范围加权比率的数学比较，不代表实际积压、目标或运营原因。",
  );

  return {
    period: options.period,
    rowCount: periodRows.length,
    publicationCount,
    numerator: total.numerator,
    denominator: total.denominator,
    unmappedDenominator,
    rate: overallRate,
    targetRate: null,
    regions,
    worstRegions,
    regionalPriorities,
    basePriorities,
    message: lines.join("\n"),
  };
}
