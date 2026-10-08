import { normalizeHeader, parseWorkbook, type ParsedWorkbook, type WorkbookRow } from "../workbook.ts";
import {
  getDashboardDataSource,
  importDashboardDataSource,
  previewDashboardDataSource,
  removeDashboardDataSource,
  validateWorkbookFile,
  type DataSourcePreview,
  type ManualDataSource,
} from "./api.ts";

export const MOVEMENT_REQUIRED_FIELDS = [
  "Regional responsável",
  "Código da unidade responsável",
  "Nome da unidade responsável",
  "Total de pedidos sem movimentação",
  "Qtd pedidos em trânsito",
  "Sem mov. há mais de 1 dia",
  "Sem mov. há mais de 2 dias",
  "Sem mov. há mais de 3 dias",
  "Sem mov. há mais de 4 dias",
  "Sem mov. há mais de 5 dias",
  "Sem mov. há mais de 6 dias",
  "Sem mov. há mais de 7 dias",
  "Sem mov. há mais de 10 dias",
  "Sem mov. há mais de 14 dias",
  "Sem mov. há mais de 30 dias",
  "Horário da última operação",
  "Taxa de sem mov 14+dias",
  "Taxa de sem mov 30+dias",
] as const;

const MOVEMENT_NUMERIC_FIELDS = MOVEMENT_REQUIRED_FIELDS.slice(3, 15).concat(
  MOVEMENT_REQUIRED_FIELDS.slice(16),
);

export type MovementSourcePreview = DataSourcePreview;
export type ManualMovementDataSource = ManualDataSource;
export type MovementDataSourceResponse = { source: ManualMovementDataSource | null };

function numericCell(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return 0;
  const percent = text.endsWith("%");
  const normalized = text.replace(/%$/, "").includes(",")
    ? text.replace(/%$/, "").replace(/\./g, "").replace(",", ".")
    : text.replace(/%$/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return percent ? parsed / 100 : parsed;
}

export async function parseMovementWorkbookFile(file: File): Promise<ParsedWorkbook> {
  validateWorkbookFile(file);
  try {
    return parseWorkbook(await file.arrayBuffer());
  } catch {
    throw new Error("data_source_parse_failed");
  }
}

export function normalizeMovementWorkbook(parsed: ParsedWorkbook): ParsedWorkbook {
  const byNormalizedHeader = new Map(parsed.headers.map((header) => [normalizeHeader(header), header]));
  const columns = MOVEMENT_REQUIRED_FIELDS.map((field) => byNormalizedHeader.get(normalizeHeader(field)));
  if (columns.some((column) => !column)) throw new Error("data_source_movement_required_columns_missing");

  const actualColumns = columns as string[];
  const rows: WorkbookRow[] = parsed.rows.map((row) => ({
    ...row,
    ...Object.fromEntries(MOVEMENT_NUMERIC_FIELDS.map((field) => {
      const column = byNormalizedHeader.get(normalizeHeader(field))!;
      return [column, numericCell(row[column])];
    })),
  }));
  const regionColumn = byNormalizedHeader.get(normalizeHeader(MOVEMENT_REQUIRED_FIELDS[0]))!;
  const baseColumn = byNormalizedHeader.get(normalizeHeader(MOVEMENT_REQUIRED_FIELDS[2]))!;
  return {
    ...parsed,
    rows,
    dateColumn: undefined,
    regionColumn,
    baseColumn,
    originColumn: undefined,
    statusColumn: undefined,
    statusColumns: [],
    metadata: {
      ...parsed.metadata,
      rowCount: rows.length,
      columnCount: actualColumns.length,
      dateRange: undefined,
    },
  };
}

export async function parseMovementSourceFile(file: File): Promise<ParsedWorkbook> {
  return normalizeMovementWorkbook(await parseMovementWorkbookFile(file));
}

export async function previewMovementSource(file: File, parsed: ParsedWorkbook): Promise<MovementSourcePreview> {
  validateWorkbookFile(file);
  return previewDashboardDataSource("movement", file, parsed);
}

export async function importMovementSource(previewId: string): Promise<ManualMovementDataSource> {
  return importDashboardDataSource("movement", previewId);
}

export async function getMovementSource(): Promise<MovementDataSourceResponse> {
  return getDashboardDataSource("movement");
}

export async function removeMovementSource(): Promise<void> {
  return removeDashboardDataSource("movement");
}
