import * as XLSX from "xlsx";

export type WorkbookRow = Record<string, unknown>;

export type ColumnRole =
  | "date"
  | "base"
  | "origin"
  | "status"
  | "status-metric"
  | "data";

export interface WorkbookColumn {
  /** Unique key used in each row object. */
  key: string;
  /** Header as it appeared in the worksheet, with whitespace cleaned up. */
  originalHeader: string;
  /** Accent- and punctuation-insensitive form used only for detection. */
  normalizedHeader: string;
  index: number;
  role: ColumnRole;
}

export interface WorkbookMetadata {
  sheetNames: string[];
  /** One-based worksheet row containing the detected headers. */
  headerRow: number;
  rowCount: number;
  columnCount: number;
  columns: WorkbookColumn[];
  date1904: boolean;
  dateRange?: {
    min: string;
    max: string;
  };
}

export interface ParsedWorkbook {
  sheetName: string;
  headers: string[];
  rows: WorkbookRow[];
  dateColumn?: string;
  baseColumn?: string;
  /** Optional regional grouping, for example "Regional Origem". */
  regionColumn?: string;
  /** Optional order-source grouping, for example "Origem do Pedido". */
  originColumn?: string;
  /** Present when the source has one categorical status column. */
  statusColumn?: string;
  /** Includes the categorical status column and/or status metric columns. */
  statusColumns: string[];
  metadata: WorkbookMetadata;
  warnings: string[];
}

/**
 * Monitoring views only need their grouping dimensions and numeric status
 * metrics. Consolidating equal rows before upload keeps large daily JMS files
 * safely below the Worker request-memory limit without changing any totals.
 */
export function compactMonitoringWorkbook(parsed: ParsedWorkbook): ParsedWorkbook {
  const dimensions = [
    parsed.dateColumn,
    parsed.regionColumn,
    parsed.baseColumn,
    parsed.originColumn,
    parsed.statusColumn,
  ].filter((header): header is string => Boolean(header));
  const metricHeaders = parsed.statusColumns.filter((header) => header !== parsed.statusColumn);
  const headers = [...new Set([...dimensions, ...metricHeaders])];

  // Do not alter unfamiliar workbook shapes. The regular parser remains the
  // fallback whenever the monitoring columns cannot be identified.
  if (!parsed.dateColumn || !parsed.baseColumn || metricHeaders.length === 0) return parsed;

  const grouped = new Map<string, WorkbookRow>();
  for (const source of parsed.rows) {
    const dimensionValues = dimensions.map((header) => source[header] ?? null);
    const key = JSON.stringify(dimensionValues);
    let row = grouped.get(key);
    if (!row) {
      row = {};
      dimensions.forEach((header, index) => { row![header] = dimensionValues[index]; });
      metricHeaders.forEach((header) => { row![header] = 0; });
      grouped.set(key, row);
    }
    metricHeaders.forEach((header) => {
      const value = source[header];
      const number = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
      row![header] = Number(row![header] ?? 0) + (Number.isFinite(number) ? number : 0);
    });
  }

  const rows = [...grouped.values()];
  return {
    ...parsed,
    headers,
    rows,
    metadata: {
      ...parsed.metadata,
      rowCount: rows.length,
      columnCount: headers.length,
      columns: parsed.metadata.columns.filter((column) => headers.includes(column.key)),
    },
    warnings: [
      ...parsed.warnings,
      `Arquivo consolidado para upload: ${parsed.rows.length.toLocaleString("pt-BR")} linhas em ${rows.length.toLocaleString("pt-BR")} grupos.`,
    ],
  };
}

export interface ColumnDetection {
  dateColumn?: string;
  baseColumn?: string;
  originColumn?: string;
  statusColumn?: string;
  statusColumns: string[];
}

export interface ParseTabularOptions {
  sheetName?: string;
  sheetNames?: string[];
  date1904?: boolean;
  /** Zero-based override. Normally the parser detects the header row. */
  headerRowIndex?: number;
  initialWarnings?: string[];
}

const DAY_IN_MS = 86_400_000;
const EXCEL_1900_EPOCH = Date.UTC(1899, 11, 30);
const EXCEL_1904_EPOCH = Date.UTC(1904, 0, 1);

const DATE_ALIASES = normalizedSet([
  "data",
  "date",
  "dia",
  "data coleta",
  "data de coleta",
  "data da coleta",
  "data criação",
  "data de criação",
  "data atualização",
  "data de atualização",
  "fecha",
  "fecha de recogida",
  "pickup date",
  "collection date",
  "created date",
  "日期",
  "揽收日期",
  "收件日期",
  "创建日期",
  "更新时间",
]);

const BASE_ALIASES = normalizedSet([
  "base",
  "base origem",
  "base de origem",
  "base operacional",
  "pdd",
  "pdd de saída",
  "pdd saída",
  "pdd de saida",
  "pdd saida",
  "unidade",
  "filial",
  "agência",
  "agencia",
  "estação",
  "estacao",
  "hub",
  "centro operacional",
  "regional origem",
  "origem",
  "station",
  "branch",
  "origin base",
  "网点",
  "站点",
  "始发站",
  "始发网点",
  "揽收网点",
  "分拨中心",
]);

const ORIGIN_ALIASES = normalizedSet([
  "origem do pedido",
  "origem pedido",
  "order origin",
  "order source",
  "source of order",
  "订单来源",
  "订单渠道",
  "订单平台",
]);

const CATEGORICAL_STATUS_ALIASES = normalizedSet([
  "status",
  "status atual",
  "status da coleta",
  "status de coleta",
  "situação",
  "situacao",
  "estado",
  "etapa",
  "current status",
  "pickup status",
  "collection status",
  "状态",
  "当前状态",
  "揽收状态",
  "包裹状态",
  "物流状态",
  "运输状态",
]);

const STATUS_METRIC_PHRASES = [
  "coleta prevista",
  "aguardando coleta",
  "coletado",
  "recebido na base",
  "recebida na base",
  "expedida pela base",
  "expedido pela base",
  "em transito a partir da base",
  "chegada ao centro de triagem",
  "chegou ao centro de triagem",
  "expedido pelo centro de triagem",
  "expedida pelo centro de triagem",
  "chegou ao sc",
  "pacote criado pela base",
  "problematicos registrados",
  "problematicos nao registrados",
  "problemas registrados",
  "problemas nao registrados",
  "drop off esperado",
  "drop off aguardando",
  "dorp off esperado",
  "dorp off aguardando",
  "expected pickup",
  "awaiting pickup",
  "picked up",
  "received at base",
  "dispatched from base",
  "in transit",
  "arrived at sorting center",
  "dispatched from sorting center",
  "problem parcels",
  "应揽收",
  "待揽收",
  "已揽收",
  "已收件",
  "已入库",
  "已出库",
  "运输中",
  "网点发件在途",
  "集散发件在途",
  "已到达",
  "到达分拨",
  "分拨发出",
  "异常件",
  "问题件",
].map(normalizeHeader);

/**
 * Produces a stable comparison key without changing the displayed header.
 * It intentionally preserves CJK characters while removing Latin accents.
 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Converts an Excel serial, Date, or common date string to YYYY-MM-DD.
 * Calendar fields are read directly so an ISO string is never shifted by the
 * browser's timezone.
 */
export function toISODate(
  value: unknown,
  options: { date1904?: boolean } = {},
): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;

    const localIsMidnight =
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0 &&
      value.getMilliseconds() === 0;
    const utcIsMidnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;

    if (utcIsMidnight && !localIsMidnight) {
      return formatDateParts(
        value.getUTCFullYear(),
        value.getUTCMonth() + 1,
        value.getUTCDate(),
      );
    }

    return formatDateParts(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
    );
  }

  if (typeof value === "number") {
    return excelSerialToISO(value, Boolean(options.date1904));
  }

  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;

  // Keeping the literal date portion avoids UTC/local rollover for timestamps.
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (match) {
    return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (match) {
    return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  // Portuguese/Spanish dashboards conventionally use day before month.
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\D|$)/);
  if (match) {
    const rawYear = Number(match[3]);
    const year = match[3].length === 2 ? (rawYear >= 70 ? 1900 : 2000) + rawYear : rawYear;
    return formatDateParts(year, Number(match[2]), Number(match[1]));
  }

  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) {
    return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return excelSerialToISO(Number(text), Boolean(options.date1904));
  }

  return undefined;
}

/** Detects dashboard dimensions using multilingual aliases and value profiles. */
export function detectColumns(
  headers: readonly string[],
  rows: readonly WorkbookRow[] = [],
): ColumnDetection {
  const profiles = new Map(headers.map((header) => [header, profileColumn(rows, header)]));

  let dateColumn: string | undefined;
  let dateScore = 0;
  let baseColumn: string | undefined;
  let baseScore = 0;
  let statusColumn: string | undefined;
  let statusScore = 0;
  const statusColumns: string[] = [];

  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const profile = profiles.get(header) ?? emptyProfile();
    const dateCandidateScore = scoreDateColumn(normalized, profile, index);
    const baseCandidateScore = scoreBaseColumn(normalized, profile, index);
    const categoricalScore = scoreCategoricalStatus(normalized, profile);

    if (dateCandidateScore > dateScore) {
      dateScore = dateCandidateScore;
      dateColumn = header;
    }

    if (baseCandidateScore > baseScore) {
      baseScore = baseCandidateScore;
      baseColumn = header;
    }

    if (categoricalScore > statusScore) {
      statusScore = categoricalScore;
      statusColumn = header;
    }

    if (
      categoricalScore >= 100 ||
      isStatusMetricHeader(normalized)
    ) {
      statusColumns.push(header);
    }
  });

  return {
    dateColumn: dateScore >= 70 ? dateColumn : undefined,
    baseColumn: baseScore >= 70 ? baseColumn : undefined,
    originColumn: headers.find((header) => ORIGIN_ALIASES.has(normalizeHeader(header))),
    statusColumn: statusScore >= 100 ? statusColumn : undefined,
    statusColumns: unique(statusColumns),
  };
}

/** Pure parser for tests, CSV adapters, and already-extracted worksheet matrices. */
export function parseTabularData(
  matrix: readonly (readonly unknown[])[],
  options: ParseTabularOptions = {},
): ParsedWorkbook {
  const warnings = [...(options.initialWarnings ?? [])];
  const nonEmptyMatrix = trimUnusedArea(matrix);

  if (nonEmptyMatrix.length === 0) {
    return emptyParsedWorkbook(options, [
      ...warnings,
      "A aba selecionada não contém dados.",
    ]);
  }

  const headerRowIndex = clampHeaderIndex(
    options.headerRowIndex ?? findHeaderRowIndex(nonEmptyMatrix),
    nonEmptyMatrix.length,
  );
  const width = findUsedWidth(nonEmptyMatrix.slice(headerRowIndex));
  const rawHeaders = Array.from({ length: width }, (_, index) =>
    cleanHeaderLabel(nonEmptyMatrix[headerRowIndex]?.[index]),
  );
  const headers = makeUniqueHeaders(rawHeaders, warnings);

  const rows: WorkbookRow[] = [];
  for (const sourceRow of nonEmptyMatrix.slice(headerRowIndex + 1)) {
    if (isRowEmpty(sourceRow)) continue;

    const row: WorkbookRow = {};
    headers.forEach((header, index) => {
      row[header] = sourceRow[index] ?? null;
    });
    rows.push(row);
  }

  const detection = detectColumns(headers, rows);
  const date1904 = Boolean(options.date1904);

  if (detection.dateColumn) {
    let invalidDates = 0;
    for (const row of rows) {
      const original = row[detection.dateColumn];
      if (isCellEmpty(original)) continue;
      const normalizedDate = toISODate(original, { date1904 });
      if (normalizedDate) row[detection.dateColumn] = normalizedDate;
      else invalidDates += 1;
    }

    if (invalidDates > 0) {
      warnings.push(
        `${invalidDates} valor(es) da coluna de data não puderam ser normalizados.`,
      );
    }
  } else {
    warnings.push(
      "Não foi possível identificar uma coluna de data; selecione-a manualmente.",
    );
  }

  if (!detection.baseColumn) {
    warnings.push(
      "Não foi possível identificar uma coluna de base; selecione-a manualmente.",
    );
  }

  if (detection.statusColumns.length === 0) {
    warnings.push(
      "Não foi possível identificar colunas de status; selecione-as manualmente.",
    );
  }

  if (rows.length === 0) {
    warnings.push("A aba contém cabeçalhos, mas nenhuma linha de dados.");
  }

  const statusColumnSet = new Set(detection.statusColumns);
  const columns: WorkbookColumn[] = headers.map((key, index) => ({
    key,
    originalHeader: rawHeaders[index] || `Coluna ${index + 1}`,
    normalizedHeader: normalizeHeader(rawHeaders[index]),
    index,
    role:
      key === detection.dateColumn
        ? "date"
        : key === detection.baseColumn
          ? "base"
          : key === detection.originColumn
            ? "origin"
            : key === detection.statusColumn
              ? "status"
              : statusColumnSet.has(key)
                ? "status-metric"
                : "data",
  }));

  const parsed: ParsedWorkbook = {
    sheetName: options.sheetName ?? "Planilha 1",
    headers,
    rows,
    dateColumn: detection.dateColumn,
    baseColumn: detection.baseColumn,
    regionColumn: headers.find((header) => {
      const normalized = normalizeHeader(header);
      return normalized === "regional origem" || normalized === "regional";
    }),
    originColumn: detection.originColumn,
    statusColumn: detection.statusColumn,
    statusColumns: detection.statusColumns,
    warnings: unique(warnings),
    metadata: {
      sheetNames: options.sheetNames ?? [options.sheetName ?? "Planilha 1"],
      headerRow: headerRowIndex + 1,
      rowCount: rows.length,
      columnCount: headers.length,
      columns,
      date1904,
    },
  };

  const dates = detection.dateColumn
    ? rows
        .map((row) => toISODate(row[detection.dateColumn as string], { date1904 }))
        .filter((value): value is string => Boolean(value))
        .sort()
    : [];
  if (dates.length > 0) {
    parsed.metadata.dateRange = {
      min: dates[0],
      max: dates[dates.length - 1],
    };
  }

  return parsed;
}

interface ParseWorkbookOptions {
  preferredSheetName?: string;
}

/** Reads an .xlsx ArrayBuffer and parses the first worksheet containing a table. */
export function parseWorkbook(buffer: ArrayBuffer, options: ParseWorkbookOptions = {}): ParsedWorkbook {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "array",
      cellDates: false,
      dense: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(`Não foi possível ler o arquivo Excel${detail}`);
  }

  const candidates: Array<{
    sheetName: string;
    matrix: unknown[][];
    tabular: boolean;
  }> = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const matrix = sheetToMatrix(worksheet);
    const nonEmptyRows = matrix.filter((row) => !isRowEmpty(row));
    if (nonEmptyRows.length === 0) continue;

    candidates.push({
      sheetName,
      matrix,
      tabular: nonEmptyRows.length >= 2,
    });
  }

  const normalizedPreferred = options.preferredSheetName ? normalizeHeader(options.preferredSheetName) : "";
  const preferred =
    normalizedPreferred
      ? candidates.find((candidate) => normalizeHeader(candidate.sheetName) === normalizedPreferred && candidate.tabular) ??
        candidates.find(
          (candidate) =>
            candidate.tabular &&
            (normalizeHeader(candidate.sheetName).includes(normalizedPreferred) ||
              normalizedPreferred.includes(normalizeHeader(candidate.sheetName))),
        )
      : undefined;
  const selected = preferred ?? candidates.find((candidate) => candidate.tabular) ?? candidates[0];
  if (!selected) {
    throw new Error("O arquivo Excel não contém nenhuma aba com dados.");
  }

  const firstNonEmpty = candidates[0];
  const initialWarnings: string[] = [];
  if (firstNonEmpty && firstNonEmpty !== selected) {
    initialWarnings.push(
      `A aba “${firstNonEmpty.sheetName}” foi ignorada por não conter uma tabela; usando “${selected.sheetName}”.`,
    );
  }

  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  return parseTabularData(selected.matrix, {
    sheetName: selected.sheetName,
    sheetNames: [...workbook.SheetNames],
    date1904,
    initialWarnings,
  });
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeHeader));
}

function cleanHeaderLabel(value: unknown): string {
  if (isCellEmpty(value)) return "";
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeUniqueHeaders(rawHeaders: readonly string[], warnings: string[]): string[] {
  const counts = new Map<string, number>();
  let missing = 0;
  let duplicates = 0;

  const headers = rawHeaders.map((rawHeader, index) => {
    const base = rawHeader || `Coluna ${index + 1}`;
    if (!rawHeader) missing += 1;
    const identity = normalizeHeader(base) || `coluna ${index + 1}`;
    const count = (counts.get(identity) ?? 0) + 1;
    counts.set(identity, count);
    if (count > 1) duplicates += 1;
    return count === 1 ? base : `${base} (${count})`;
  });

  if (missing > 0) {
    warnings.push(
      `${missing} cabeçalho(s) vazio(s) receberam nomes automáticos para preservar as colunas.`,
    );
  }
  if (duplicates > 0) {
    warnings.push(
      `${duplicates} cabeçalho(s) duplicado(s) receberam sufixos numéricos.`,
    );
  }

  return headers;
}

function decodeXmlText(value: string): string {
  return value.replace(/&#(x?[0-9a-f]+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const codePoint = Number.parseInt(numeric.startsWith("x") ? numeric.slice(1) : numeric, numeric.startsWith("x") ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named?.toLowerCase() ?? ""] ?? match;
  });
}

export function richTextXmlToPlainText(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)]
    .map((match) => decodeXmlText(match[1].replace(/<[^>]+>/g, "")))
    .join("")
    .trim();
}

function sheetToMatrix(worksheet: XLSX.WorkSheet): unknown[][] {
  const actualRange = findActualSheetRange(worksheet);
  if (!actualRange) return [];

  for (const [address, rawCell] of Object.entries(worksheet)) {
    if (address.startsWith("!") || !rawCell || typeof rawCell !== "object") continue;
    const cell = rawCell as XLSX.CellObject & { r?: string };
    if ((cell.v === "" || cell.v == null) && typeof cell.r === "string") {
      const richText = richTextXmlToPlainText(cell.r);
      if (richText) cell.v = richText;
    }
  }

  return XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    range: actualRange,
    raw: true,
    defval: null,
    blankrows: true,
  });
}

/** Some exporters incorrectly write !ref="A1"; scan real cell keys instead. */
function findActualSheetRange(worksheet: XLSX.WorkSheet): string | undefined {
  let minRow = Number.POSITIVE_INFINITY;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxRow = -1;
  let maxColumn = -1;

  for (const address of Object.keys(worksheet)) {
    if (address.startsWith("!")) continue;
    try {
      const cell = XLSX.utils.decode_cell(address);
      minRow = Math.min(minRow, cell.r);
      minColumn = Math.min(minColumn, cell.c);
      maxRow = Math.max(maxRow, cell.r);
      maxColumn = Math.max(maxColumn, cell.c);
    } catch {
      // Ignore non-cell extension keys.
    }
  }

  if (maxRow < 0 || maxColumn < 0) return undefined;
  return XLSX.utils.encode_range({
    s: { r: minRow, c: minColumn },
    e: { r: maxRow, c: maxColumn },
  });
}

function findHeaderRowIndex(matrix: readonly (readonly unknown[])[]): number {
  const limit = Math.min(matrix.length, 30);
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < limit; index += 1) {
    const row = matrix[index];
    if (isRowEmpty(row)) continue;
    const values = row.filter((value) => !isCellEmpty(value));
    const textValues = values.filter((value) => typeof value === "string");
    const numericValues = values.filter((value) => typeof value === "number");
    const uniqueText = new Set(textValues.map(normalizeHeader)).size;
    const recognized = textValues.reduce(
      (sum, value) => sum + headerRecognitionWeight(normalizeHeader(value)),
      0,
    );
    const nextRow = matrix.slice(index + 1).find((candidate) => !isRowEmpty(candidate));
    const hasFollowingData = nextRow ? 4 : 0;

    const score =
      textValues.length * 3 +
      uniqueText * 1.5 +
      recognized * 12 +
      hasFollowingData -
      numericValues.length * 0.5 -
      index * 0.05;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function headerRecognitionWeight(normalized: string): number {
  if (
    DATE_ALIASES.has(normalized) ||
    BASE_ALIASES.has(normalized) ||
    CATEGORICAL_STATUS_ALIASES.has(normalized)
  ) {
    return 2;
  }
  if (isStatusMetricHeader(normalized)) return 1.5;
  if (hasAnyTerm(normalized, ["taxa", "rate", "数量", "总量"])) return 0.5;
  return 0;
}

interface ColumnProfile {
  nonEmpty: number;
  strings: number;
  numbers: number;
  dateStrings: number;
  distinct: number;
}

function emptyProfile(): ColumnProfile {
  return { nonEmpty: 0, strings: 0, numbers: 0, dateStrings: 0, distinct: 0 };
}

function profileColumn(rows: readonly WorkbookRow[], header: string): ColumnProfile {
  const profile = emptyProfile();
  const distinct = new Set<string>();

  for (const row of rows.slice(0, 500)) {
    const value = row[header];
    if (isCellEmpty(value)) continue;
    profile.nonEmpty += 1;
    if (typeof value === "string") {
      profile.strings += 1;
      if (toISODate(value)) profile.dateStrings += 1;
    } else if (typeof value === "number") {
      profile.numbers += 1;
    } else if (value instanceof Date) {
      profile.dateStrings += 1;
    }
    distinct.add(stableValue(value));
  }

  profile.distinct = distinct.size;
  return profile;
}

function scoreDateColumn(
  normalized: string,
  profile: ColumnProfile,
  index: number,
): number {
  let score = 0;
  if (DATE_ALIASES.has(normalized)) score += 150;
  else if (
    startsWithTerm(normalized, "data") ||
    startsWithTerm(normalized, "date") ||
    normalized.includes("日期") ||
    normalized.endsWith("时间")
  ) {
    score += 100;
  }

  if (profile.nonEmpty > 0 && profile.dateStrings / profile.nonEmpty >= 0.7) {
    score += 80;
  }
  if (index === 0 && score > 0) score += 5;
  return score;
}

function scoreBaseColumn(
  normalized: string,
  profile: ColumnProfile,
  index: number,
): number {
  let score = 0;
  if (normalized === normalizeHeader("pdd de saída") || normalized === "pdd saida") {
    score += 220;
  } else if (normalized === "base" || normalized.includes("base origem")) {
    score += 200;
  } else if (BASE_ALIASES.has(normalized)) {
    score += normalized === "regional origem" || normalized === "origem" ? 110 : 170;
  } else if (
    hasAnyTerm(normalized, [
      " base ",
      "unidade",
      "filial",
      "estacao",
      "station",
      "branch",
      "网点",
      "站点",
    ])
  ) {
    score += 100;
  }

  const stringRatio = profile.nonEmpty > 0 ? profile.strings / profile.nonEmpty : 0;
  if (score > 0 && stringRatio >= 0.6) score += 20;
  if (index === 0 && score > 0) score += 2;
  return score;
}

function scoreCategoricalStatus(
  normalized: string,
  profile: ColumnProfile,
): number {
  if (CATEGORICAL_STATUS_ALIASES.has(normalized)) return 220;

  const statusLabel =
    startsWithTerm(normalized, "status") ||
    normalized.includes("状态") ||
    startsWithTerm(normalized, "situacao");
  if (!statusLabel || isStatusMetricHeader(normalized)) return 0;

  const stringRatio = profile.nonEmpty > 0 ? profile.strings / profile.nonEmpty : 0;
  const reasonablyCategorical =
    profile.nonEmpty === 0 ||
    (stringRatio >= 0.6 && profile.distinct <= Math.max(40, profile.nonEmpty * 0.7));
  return reasonablyCategorical ? 130 : 0;
}

function isStatusMetricHeader(normalized: string): boolean {
  if (!normalized) return false;
  if (hasAnyTerm(normalized, ["taxa de", "rate", "percentual", "比例", "率"])) {
    return false;
  }
  if (CATEGORICAL_STATUS_ALIASES.has(normalized)) return false;

  return STATUS_METRIC_PHRASES.some((phrase) => normalized.includes(phrase));
}

function hasAnyTerm(value: string, terms: readonly string[]): boolean {
  const padded = ` ${value} `;
  return terms.some((term) => {
    const normalizedTerm = normalizeHeader(term);
    if (!normalizedTerm) return false;
    if (/^[\u3400-\u9fff]/.test(normalizedTerm)) return value.includes(normalizedTerm);
    return padded.includes(` ${normalizedTerm} `) || value.includes(normalizedTerm);
  });
}

function startsWithTerm(value: string, term: string): boolean {
  const normalizedTerm = normalizeHeader(term);
  return value === normalizedTerm || value.startsWith(`${normalizedTerm} `);
}

function excelSerialToISO(serial: number, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) {
    return undefined;
  }
  const wholeDays = Math.floor(serial);
  const epoch = date1904 ? EXCEL_1904_EPOCH : EXCEL_1900_EPOCH;
  const date = new Date(epoch + wholeDays * DAY_IN_MS);
  if (Number.isNaN(date.getTime())) return undefined;
  return formatDateParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function formatDateParts(year: number, month: number, day: number): string | undefined {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 100 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function trimUnusedArea(
  matrix: readonly (readonly unknown[])[],
): readonly (readonly unknown[])[] {
  const first = matrix.findIndex((row) => !isRowEmpty(row));
  if (first < 0) return [];
  let last = matrix.length - 1;
  while (last > first && isRowEmpty(matrix[last])) last -= 1;
  return matrix.slice(first, last + 1);
}

function findUsedWidth(matrix: readonly (readonly unknown[])[]): number {
  let width = 0;
  for (const row of matrix) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (!isCellEmpty(row[index])) {
        width = Math.max(width, index + 1);
        break;
      }
    }
  }
  return width;
}

function isRowEmpty(row: readonly unknown[]): boolean {
  return row.every(isCellEmpty);
}

function isCellEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function stableValue(value: unknown): string {
  if (value instanceof Date) return `date:${value.getTime()}`;
  return `${typeof value}:${String(value)}`;
}

function clampHeaderIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.floor(index), 0), Math.max(length - 1, 0));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function emptyParsedWorkbook(
  options: ParseTabularOptions,
  warnings: string[],
): ParsedWorkbook {
  const sheetName = options.sheetName ?? "Planilha 1";
  return {
    sheetName,
    headers: [],
    rows: [],
    statusColumns: [],
    warnings: unique(warnings),
    metadata: {
      sheetNames: options.sheetNames ?? [sheetName],
      headerRow: 1,
      rowCount: 0,
      columnCount: 0,
      columns: [],
      date1904: Boolean(options.date1904),
    },
  };
}
