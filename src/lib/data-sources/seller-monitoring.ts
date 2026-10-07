import { normalizeHeader, parseWorkbook, toISODate, type ParsedWorkbook, type WorkbookRow } from "../workbook.ts";
import {
  getDashboardDataSource,
  importDashboardDataSource,
  previewDashboardDataSource,
  removeDashboardDataSource,
  validateWorkbookFile,
  type DataSourcePreview,
  type ManualDataSource,
} from "./api.ts";

export const SELLER_MONITORING_FIELDS = [
  "Data",
  "Regional Origem",
  "PDD de saida",
  "Cliente",
  "Loja",
  "Id Seller/remetente",
  "Motorista Designado",
  "Origem do Pedido",
  "Status atual – Aguardando coleta",
  "Status atual – Recebido no Drop-off",
  "Status atual – Coletado",
  "Status atual – Recebido",
  "Status atual – Recebido na base",
  "当前状态-网点发件流程中",
  "Status atual – Chegou ao SC",
] as const;

export const SELLER_MONITORING_METRICS = SELLER_MONITORING_FIELDS.slice(8);

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return 0;
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SellerMonitoringTotals {
  awaiting: number;
  processed: number;
  total: number;
  rate: number;
}

/** Implements the existing JMS report formula over the raw status columns. */
export function summarizeSellerMonitoring(parsed: ParsedWorkbook): SellerMonitoringTotals {
  const awaitingColumn = SELLER_MONITORING_FIELDS[8];
  const processedColumns = SELLER_MONITORING_METRICS.slice(1);
  const awaiting = parsed.rows.reduce((sum, row) => sum + numberValue(row[awaitingColumn]), 0);
  const processed = parsed.rows.reduce(
    (sum, row) => sum + processedColumns.reduce((rowSum, column) => rowSum + numberValue(row[column]), 0),
    0,
  );
  const total = awaiting + processed;
  return { awaiting, processed, total, rate: total > 0 ? processed / total : 0 };
}

export function normalizeSellerMonitoringWorkbook(parsed: ParsedWorkbook): ParsedWorkbook {
  const byNormalizedHeader = new Map(parsed.headers.map((header) => [normalizeHeader(header), header]));
  const columns = SELLER_MONITORING_FIELDS.map((field) => byNormalizedHeader.get(normalizeHeader(field)));
  const missing = SELLER_MONITORING_FIELDS.filter((_field, index) => !columns[index]);
  if (missing.length) throw new Error("data_source_seller_required_columns_missing");

  const dateColumn = columns[0]!;
  const baseColumn = columns[2]!;
  const regionColumn = columns[1]!;
  const originColumn = columns[7]!;
  const metricColumns = columns.slice(8).map((column) => column!);
  const rows: WorkbookRow[] = parsed.rows.map((source) => {
    const date = toISODate(source[dateColumn], { date1904: parsed.metadata.date1904 });
    return {
      ...source,
      [dateColumn]: date ?? source[dateColumn],
      ...Object.fromEntries(metricColumns.map((column) => [column, numberValue(source[column])])),
    };
  });
  const dates = rows.map((row) => String(row[dateColumn] ?? "")).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  if (!dates.length) throw new Error("data_source_seller_valid_date_missing");
  if (!rows.some((row) => metricColumns.some((column) => numberValue(row[column]) !== 0))) {
    throw new Error("data_source_seller_numeric_metrics_missing");
  }

  return {
    ...parsed,
    rows,
    dateColumn,
    baseColumn,
    regionColumn,
    originColumn,
    statusColumns: metricColumns,
    metadata: {
      ...parsed.metadata,
      rowCount: rows.length,
      dateRange: { min: dates[0], max: dates.at(-1)! },
    },
  };
}

export async function parseSellerMonitoringWorkbookFile(file: File): Promise<ParsedWorkbook> {
  validateWorkbookFile(file);
  try {
    return normalizeSellerMonitoringWorkbook(parseWorkbook(await file.arrayBuffer()));
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("data_source_")) throw cause;
    throw new Error("data_source_parse_failed");
  }
}

export async function previewSellerMonitoringSource(file: File, parsed: ParsedWorkbook): Promise<DataSourcePreview> {
  validateWorkbookFile(file);
  return previewDashboardDataSource("sellerPerformance", file, parsed);
}

export function importSellerMonitoringSource(previewId: string): Promise<ManualDataSource> {
  return importDashboardDataSource("sellerPerformance", previewId);
}

export function getSellerMonitoringSource() {
  return getDashboardDataSource("sellerPerformance");
}

export function removeSellerMonitoringSource(): Promise<void> {
  return removeDashboardDataSource("sellerPerformance");
}
