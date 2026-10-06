import type { ParsedWorkbook } from "../workbook";
import {
  getDashboardDataSource,
  importDashboardDataSource,
  previewDashboardDataSource,
  removeDashboardDataSource,
  validateWorkbookFile,
  type DataSourcePreview,
  type ManualDataSource,
} from "./api.ts";

export type MonitoringSourcePreview = DataSourcePreview;
export type ManualMonitoringDataSource = ManualDataSource;
export type MonitoringDataSourceResponse = { source: ManualMonitoringDataSource | null };

export async function parseMonitoringWorkbookFile(file: File): Promise<ParsedWorkbook> {
  validateWorkbookFile(file);
  try {
    const { parseWorkbook } = await import("../workbook");
    return parseWorkbook(await file.arrayBuffer());
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("data_source_")) throw cause;
    throw new Error("data_source_parse_failed");
  }
}

export async function normalizeMonitoringWorkbook(parsed: ParsedWorkbook): Promise<ParsedWorkbook> {
  const { compactMonitoringWorkbook } = await import("../workbook");
  return compactMonitoringWorkbook(parsed);
}

export async function parseMonitoringSourceFile(file: File): Promise<ParsedWorkbook> {
  return normalizeMonitoringWorkbook(await parseMonitoringWorkbookFile(file));
}

export async function previewMonitoringSource(file: File, parsed?: ParsedWorkbook): Promise<MonitoringSourcePreview> {
  validateWorkbookFile(file);
  return previewDashboardDataSource("monitoring", file, parsed ?? await parseMonitoringSourceFile(file));
}

export async function importMonitoringSource(previewId: string): Promise<ManualMonitoringDataSource> {
  return importDashboardDataSource("monitoring", previewId);
}

export async function getMonitoringSource(): Promise<MonitoringDataSourceResponse> {
  return getDashboardDataSource("monitoring");
}

export async function removeMonitoringSource(): Promise<void> {
  return removeDashboardDataSource("monitoring");
}
