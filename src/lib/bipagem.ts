import type { ParsedWorkbook, WorkbookRow } from "./workbook";

export interface BipagemColumns {
  date: string;
  regionCode: string;
  region: string;
  baseCode: string;
  base: string;
  originCode: string;
  origin: string;
  ordersToScan: string;
  notScannedReceipt: string;
  notScannedCollection: string;
  notScannedDispatch: string;
}

export interface BipagemRecord {
  key: string;
  date: string;
  regionCode: string;
  region: string;
  baseCode: string;
  base: string;
  originCode: string;
  origin: string;
  ordersToScan: number;
  notScannedReceipt: number;
  notScannedCollection: number;
  notScannedDispatch: number;
}

export interface BipagemLoadedData {
  parsed: ParsedWorkbook;
  fileName: string;
  columns: BipagemColumns;
  records: BipagemRecord[];
  dates: string[];
  regions: string[];
  bases: string[];
  origins: string[];
  updatedAt?: string;
}

export interface BipagemMetrics {
  ordersToScan: number;
  scannedCollection: number;
  notScannedReceipt: number;
  notScannedCollection: number;
  notScannedDispatch: number;
  collectionFailureRate: number;
  collectionSuccessRate: number;
}

export interface BipagemBaseSummary extends BipagemMetrics {
  key: string;
  region: string;
  base: string;
  baseCode: string;
  rm: string;
}

export interface BipagemRegionalSummary extends BipagemMetrics {
  region: string;
  activeBases: number;
}

export type BipagemTrend = "improved" | "worsened" | "stable";

export interface BipagemMetricComparison {
  startValue: number;
  endValue: number;
  delta: number;
  variation: number | null;
  trend: BipagemTrend;
}

export interface BipagemPeriodComparison {
  startDate: string;
  endDate: string;
  startMetrics: BipagemMetrics;
  endMetrics: BipagemMetrics;
  receipt: BipagemMetricComparison;
  collection: BipagemMetricComparison;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
}

function findHeader(headers: string[], label: string, candidates: string[]): string {
  const normalizedCandidates = candidates.map(normalizeHeader);
  const exact = headers.find((header) => normalizedCandidates.includes(normalizeHeader(header)));
  if (exact) return exact;
  const partial = headers.find((header) => {
    const normalized = normalizeHeader(header);
    return normalizedCandidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized));
  });
  if (partial) return partial;
  throw new Error(`Não encontramos a coluna obrigatória para “${label}”.`);
}

function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 20_000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return "";
  const [, day, month, rawYear] = match;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function textValue(row: WorkbookRow, column: string, fallback: string): string {
  return String(row[column] ?? "").trim() || fallback;
}

export function buildBipagemLoadedData(
  parsed: ParsedWorkbook,
  fileName: string,
  updatedAt?: string,
): BipagemLoadedData {
  const headers = parsed.headers;
  const columns: BipagemColumns = {
    date: findHeader(headers, "Data considerada", ["Data considerada", "Data"]),
    regionCode: findHeader(headers, "Código da Regional do PDD Responsável", ["Código da Regional do PDD Responsável"]),
    region: findHeader(headers, "Nome da Regional do PDD Responsável", ["Nome da Regional do PDD Responsável", "Regional"]),
    baseCode: findHeader(headers, "Código da base", ["Código da base"]),
    base: findHeader(headers, "Nome do PDD Responsável", ["Nome do PDD Responsável", "Base"]),
    originCode: findHeader(headers, "Código de origem do pedido", ["Código de origem do pedido"]),
    origin: findHeader(headers, "Origem do Pedido", ["Origem do Pedido"]),
    ordersToScan: findHeader(headers, "Qtd pedidos a bipar", ["Qtd pedidos a bipar"]),
    notScannedReceipt: findHeader(headers, "Qtd pedidos não bipados no recebimento da coleta", ["Qtd pedidos não bipados no recebimento da coleta"]),
    notScannedCollection: findHeader(headers, "Qtd pedidos não bipados na coleta", ["Qtd pedidos não bipados na coleta"]),
    notScannedDispatch: findHeader(headers, "Qtd de Pacotes com Falta de Bipe de Envio", ["Qtd de Pacotes com Falta de Bipe de Envio"]),
  };

  const records = parsed.rows.map((row, index) => {
    const date = toIsoDate(row[columns.date]);
    const region = textValue(row, columns.region, "Sem regional");
    const base = textValue(row, columns.base, "Sem base");
    const origin = textValue(row, columns.origin, "Sem origem");
    return {
      key: `${date}::${region}::${base}::${origin}::${index}`,
      date,
      regionCode: textValue(row, columns.regionCode, "—"),
      region,
      baseCode: textValue(row, columns.baseCode, "—"),
      base,
      originCode: textValue(row, columns.originCode, "—"),
      origin,
      ordersToScan: numeric(row[columns.ordersToScan]),
      notScannedReceipt: numeric(row[columns.notScannedReceipt]),
      notScannedCollection: numeric(row[columns.notScannedCollection]),
      notScannedDispatch: numeric(row[columns.notScannedDispatch]),
    } satisfies BipagemRecord;
  }).filter((record) => record.date);

  if (records.length === 0) throw new Error("Nenhuma linha válida foi encontrada no relatório de falta de bipagem.");

  const uniqueSorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  return {
    parsed,
    fileName,
    columns,
    records,
    dates: uniqueSorted(records.map((record) => record.date)),
    regions: uniqueSorted(records.map((record) => record.region)),
    bases: uniqueSorted(records.map((record) => record.base)),
    origins: uniqueSorted(records.map((record) => record.origin)),
    updatedAt,
  };
}

export function summarizeBipagem(records: readonly BipagemRecord[]): BipagemMetrics {
  const totals = records.reduce((acc, record) => {
    acc.ordersToScan += record.ordersToScan;
    acc.notScannedReceipt += record.notScannedReceipt;
    acc.notScannedCollection += record.notScannedCollection;
    acc.notScannedDispatch += record.notScannedDispatch;
    return acc;
  }, { ordersToScan: 0, notScannedReceipt: 0, notScannedCollection: 0, notScannedDispatch: 0 });
  const scannedCollection = Math.max(0, totals.ordersToScan - totals.notScannedCollection);
  return {
    ...totals,
    scannedCollection,
    collectionFailureRate: totals.ordersToScan > 0 ? totals.notScannedCollection / totals.ordersToScan : 0,
    collectionSuccessRate: totals.ordersToScan > 0 ? scannedCollection / totals.ordersToScan : 0,
  };
}

function compareMissingMetric(startValue: number, endValue: number): BipagemMetricComparison {
  const delta = endValue - startValue;
  return {
    startValue,
    endValue,
    delta,
    variation: startValue > 0 ? delta / startValue : endValue === 0 ? 0 : null,
    trend: delta < 0 ? "improved" : delta > 0 ? "worsened" : "stable",
  };
}

export function compareBipagemPeriod(
  records: readonly BipagemRecord[],
  startDate: string,
  endDate: string,
): BipagemPeriodComparison {
  const start = summarizeBipagem(records.filter((record) => record.date === startDate));
  const end = summarizeBipagem(records.filter((record) => record.date === endDate));
  return {
    startDate,
    endDate,
    startMetrics: start,
    endMetrics: end,
    receipt: compareMissingMetric(start.notScannedReceipt, end.notScannedReceipt),
    collection: compareMissingMetric(start.notScannedCollection, end.notScannedCollection),
  };
}

export function summarizeBipagemByBase(
  records: readonly BipagemRecord[],
  rmForBase: (base: string) => string,
): BipagemBaseSummary[] {
  const groups = new Map<string, { region: string; base: string; baseCode: string; rm: string; records: BipagemRecord[] }>();
  for (const record of records) {
    const rm = rmForBase(record.base);
    const key = `${record.region}::${record.base}::${rm}`;
    const current = groups.get(key) ?? { region: record.region, base: record.base, baseCode: record.baseCode, rm, records: [] };
    current.records.push(record);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    region: group.region,
    base: group.base,
    baseCode: group.baseCode,
    rm: group.rm,
    ...summarizeBipagem(group.records),
  })).sort((a, b) =>
    b.notScannedCollection - a.notScannedCollection ||
    b.notScannedReceipt - a.notScannedReceipt ||
    a.region.localeCompare(b.region, "pt-BR") ||
    a.base.localeCompare(b.base, "pt-BR", { numeric: true }));
}

export function summarizeBipagemByRegional(records: readonly BipagemRecord[]): BipagemRegionalSummary[] {
  const groups = new Map<string, BipagemRecord[]>();
  for (const record of records) groups.set(record.region, [...(groups.get(record.region) ?? []), record]);
  return [...groups.entries()].map(([region, regionalRecords]) => ({
    region,
    activeBases: new Set(regionalRecords.map((record) => record.base)).size,
    ...summarizeBipagem(regionalRecords),
  })).sort((a, b) =>
    b.notScannedCollection - a.notScannedCollection ||
    b.ordersToScan - a.ordersToScan ||
    a.region.localeCompare(b.region, "pt-BR"));
}
