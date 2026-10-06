import { normalizeHeader, parseWorkbook, toISODate, type ParsedWorkbook } from "../workbook.ts";
import {
  getDashboardDataSource,
  importDashboardDataSource,
  previewDashboardDataSource,
  removeDashboardDataSource,
  validateWorkbookFile,
  type DataSourcePreview,
  type ManualDataSource,
} from "./api.ts";

export const TAXA_REQUIRED_FIELDS = [
  "Horário de término do prazo de coleta",
  "Nome da regional",
  "Nome da base de coleta",
  "Origem do Pedido",
  "Tipo de produto",
  "Quantidade de pedidos",
  "Qtd a coletar",
  "Qtd cancelada",
  "Taxa de coleta",
  "揽收量",
  "未揽收量",
  "Qtd não coletada no prazo",
  "Qtd coletada no prazo",
  "Taxa de coleta no prazo",
  "Pedidos coletados + Tentativas de coleta",
  "Taxa de coleta com tentativas de coleta",
  "Prazo médio demorado para coleta(h)",
  "已做问题件的量",
  "未做问题件的量",
  "Taxa de coleta do vendedor",
  "应上门商家量",
  "未上门商家量",
] as const;

export type TaxaSourcePreview = DataSourcePreview;
export type ManualTaxaDataSource = ManualDataSource;
export type TaxaDataSourceResponse = { source: ManualTaxaDataSource | null };

export async function parseTaxaWorkbookFile(file: File): Promise<ParsedWorkbook> {
  validateWorkbookFile(file);
  try {
    return parseWorkbook(await file.arrayBuffer());
  } catch {
    throw new Error("data_source_parse_failed");
  }
}

export function normalizeTaxaWorkbook(parsed: ParsedWorkbook): ParsedWorkbook {
  try {
    const findHeader = (expected: string) => parsed.headers.find((header) => normalizeHeader(header) === normalizeHeader(expected));
    const dateColumn = parsed.dateColumn ?? findHeader(TAXA_REQUIRED_FIELDS[0]);
    const regionColumn = parsed.regionColumn ?? findHeader(TAXA_REQUIRED_FIELDS[1]);
    const baseColumn = parsed.baseColumn ?? findHeader(TAXA_REQUIRED_FIELDS[2]);
    const originColumn = parsed.originColumn ?? findHeader(TAXA_REQUIRED_FIELDS[3]);
    if (!dateColumn) throw new Error("data_source_taxa_date_column_missing");

    const rows = parsed.rows.map((row) => {
      const date = toISODate(row[dateColumn], { date1904: parsed.metadata.date1904 });
      return date ? { ...row, [dateColumn]: date } : row;
    });
    const dates = rows
      .map((row) => typeof row[dateColumn] === "string" ? row[dateColumn] as string : "")
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort();

    return {
      ...parsed,
      rows,
      dateColumn,
      regionColumn,
      baseColumn,
      originColumn,
      metadata: {
        ...parsed.metadata,
        rowCount: rows.length,
        dateRange: dates.length > 0 ? { min: dates[0], max: dates.at(-1)! } : undefined,
      },
    };
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("data_source_")) throw cause;
    throw new Error("data_source_parse_failed");
  }
}

export async function parseTaxaSourceFile(file: File): Promise<ParsedWorkbook> {
  return normalizeTaxaWorkbook(await parseTaxaWorkbookFile(file));
}

export async function previewTaxaSource(file: File, parsed: ParsedWorkbook): Promise<TaxaSourcePreview> {
  validateWorkbookFile(file);
  return previewDashboardDataSource("taxa", file, parsed);
}

export async function importTaxaSource(previewId: string): Promise<ManualTaxaDataSource> {
  return importDashboardDataSource("taxa", previewId);
}

export async function getTaxaSource(): Promise<TaxaDataSourceResponse> {
  return getDashboardDataSource("taxa");
}

export async function removeTaxaSource(): Promise<void> {
  return removeDashboardDataSource("taxa");
}
