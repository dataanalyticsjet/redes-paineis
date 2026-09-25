import {
  normalizeHeader,
  toISODate,
  type ParsedWorkbook,
  type WorkbookRow,
} from "./workbook.ts";

export interface TaxaHistoryMergeResult {
  parsed: ParsedWorkbook;
  addedDates: number;
  replacedDates: number;
  totalDates: number;
  totalRows: number;
}

function dateColumnOf(parsed: ParsedWorkbook): string {
  if (parsed.dateColumn && parsed.headers.includes(parsed.dateColumn)) return parsed.dateColumn;
  const fallback = parsed.headers.find((header) => {
    const normalized = normalizeHeader(header);
    return normalized.includes("horario de termino do prazo de coleta") || normalized === "data" || normalized.includes("data de declaracao");
  });
  if (!fallback) throw new Error("A planilha de taxa precisa conter uma coluna de data válida.");
  return fallback;
}

function canonicalHeaderMap(headers: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of headers) result.set(normalizeHeader(header), header);
  return result;
}

function mapRowsToCanonical(
  source: ParsedWorkbook,
  canonical: ParsedWorkbook,
): Array<{ date: string; row: WorkbookRow }> {
  const canonicalByNormalized = canonicalHeaderMap(canonical.headers);
  const sourceByNormalized = canonicalHeaderMap(source.headers);
  const missing = canonical.headers.filter((header) => !sourceByNormalized.has(normalizeHeader(header)));
  const extra = source.headers.filter((header) => !canonicalByNormalized.has(normalizeHeader(header)));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error("As planilhas de taxa precisam ter as mesmas colunas para formar o histórico.");
  }

  const sourceDateColumn = dateColumnOf(source);
  return source.rows.map((sourceRow, index) => {
    const date = toISODate(sourceRow[sourceDateColumn], { date1904: source.metadata.date1904 });
    if (!date) {
      throw new Error(`A linha ${index + source.metadata.headerRow + 1} possui uma data inválida.`);
    }
    const row: WorkbookRow = {};
    for (const canonicalHeader of canonical.headers) {
      const sourceHeader = sourceByNormalized.get(normalizeHeader(canonicalHeader));
      row[canonicalHeader] = sourceHeader ? sourceRow[sourceHeader] ?? null : null;
    }
    row[canonical.dateColumn ?? dateColumnOf(canonical)] = date;
    return { date, row };
  });
}

export function mergeTaxaHistory(
  existing: ParsedWorkbook | null,
  incoming: readonly ParsedWorkbook[],
): TaxaHistoryMergeResult {
  if (incoming.length === 0) throw new Error("Selecione ao menos uma planilha de taxa.");
  const canonical = existing ?? incoming[0];
  const canonicalDateColumn = dateColumnOf(canonical);
  const existingRows = existing ? mapRowsToCanonical(existing, canonical) : [];
  const existingDates = new Set(existingRows.map((item) => item.date));
  const incomingRows = incoming.map((parsed) => mapRowsToCanonical(parsed, canonical));
  const incomingDates = new Set(incomingRows.flatMap((rows) => rows.map((item) => item.date)));

  // Each workbook is a snapshot of the dates it contains. Apply the uploads in
  // order so that a newer workbook replaces those dates completely, while
  // preserving every source row (including visually identical JMS rows).
  let mergedRows = [...existingRows];
  for (const rows of incomingRows) {
    const snapshotDates = new Set(rows.map((item) => item.date));
    mergedRows = [
      ...mergedRows.filter((item) => !snapshotDates.has(item.date)),
      ...rows,
    ];
  }

  mergedRows.sort((left, right) => {
    const dateOrder = left.date.localeCompare(right.date);
    if (dateOrder !== 0) return dateOrder;
    return 0;
  });
  const dates = [...new Set(mergedRows.map((item) => item.date))].sort();
  const addedDates = [...incomingDates].filter((date) => !existingDates.has(date)).length;
  const replacedDates = [...incomingDates].filter((date) => existingDates.has(date)).length;

  return {
    parsed: {
      ...canonical,
      rows: mergedRows.map((item) => item.row),
      dateColumn: canonicalDateColumn,
      warnings: [...new Set([
        ...canonical.warnings,
        ...incoming.flatMap((parsed) => parsed.warnings),
        "Histórico acumulado: novas cargas preservam as datas que não estão no arquivo enviado.",
      ])],
      metadata: {
        ...canonical.metadata,
        rowCount: mergedRows.length,
        dateRange: dates.length > 0 ? { min: dates[0], max: dates[dates.length - 1] } : undefined,
      },
    },
    addedDates,
    replacedDates,
    totalDates: dates.length,
    totalRows: mergedRows.length,
  };
}
