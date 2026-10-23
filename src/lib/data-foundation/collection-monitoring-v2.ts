import { apiFetch } from "../api-url.ts";

export const COLLECTION_MONITORING_V2_SOURCE_ID = "collection_monitoring";
export const COLLECTION_MONITORING_V2_CONTRACT_VERSION = 2;
export const COLLECTION_MONITORING_V2_PAGE_SIZE = 250;
export const COLLECTION_MONITORING_V2_REQUEST_TIMEOUT_MS = 30_000;

export const COLLECTION_MONITORING_V2_COLUMNS = [
  "data_date", "reported_origin_region", "source_base_name", "order_origin",
  "seller_collection_rate", "collection_visit_rate", "expected_dropoff", "expected_pickup",
  "pending_dropoff", "pending_pickup", "status_collected", "status_received_at_base",
  "status_dispatched_from_base", "status_in_transit_from_base", "in_transit_to_center",
  "in_transit_to_distribution", "arrived_sorting_center", "departed_sorting_center",
  "distribution_in_transit", "arrived_sc", "package_created_at_base", "processed_problem_items",
  "unprocessed_problem_items",
] as const;

export const COLLECTION_MONITORING_V2_HEADERS: Readonly<Record<(typeof COLLECTION_MONITORING_V2_COLUMNS)[number], string>> = {
  data_date: "Data",
  reported_origin_region: "Regional Origem",
  source_base_name: "PDD de saida",
  order_origin: "Origem do Pedido",
  seller_collection_rate: "Taxa de coleta do vendedor",
  collection_visit_rate: "Taxa de Visita de Coleta",
  expected_dropoff: "Coleta Prevista Drop-off",
  expected_pickup: "Coleta Prevista Pick-up",
  pending_dropoff: "Aguardando Coleta Drop-off",
  pending_pickup: "Aguardando Coleta Pick-up",
  status_collected: "Status atual – Coletado",
  status_received_at_base: "Status atual – Recebido na base",
  status_dispatched_from_base: "Expedida pela Base",
  status_in_transit_from_base: "Status atual – Em trânsito a partir da base",
  in_transit_to_center: "网点发件在途(中心)",
  in_transit_to_distribution: "网点发件在途(集散)",
  arrived_sorting_center: "Chegada ao Centro de Triagem",
  departed_sorting_center: "Expedido pelo Centro de Triagem",
  distribution_in_transit: "集散发件在途",
  arrived_sc: "Status atual – Chegou ao SC",
  package_created_at_base: "Pacote Criado pela Base",
  processed_problem_items: "已处理问题件",
  unprocessed_problem_items: "未处理问题件",
};

const INTEGER_COLUMNS = new Set<string>([
  "expected_dropoff", "expected_pickup", "pending_dropoff", "pending_pickup", "status_collected",
  "status_received_at_base", "status_dispatched_from_base", "status_in_transit_from_base",
  "in_transit_to_center", "in_transit_to_distribution", "arrived_sorting_center",
  "departed_sorting_center", "distribution_in_transit", "arrived_sc", "package_created_at_base",
  "processed_problem_items", "unprocessed_problem_items",
]);
const DECIMAL_COLUMNS = new Set<string>(["seller_collection_rate", "collection_visit_rate"]);
const NULLABLE_COLUMNS = new Set<string>([
  "reported_origin_region", "source_base_name", "seller_collection_rate", "collection_visit_rate",
]);

export interface CollectionMonitoringV2Record extends Record<string, unknown> {
  data_date: unknown;
  reported_origin_region: unknown;
  source_base_name: unknown;
  order_origin: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  effective_base_code: unknown;
  mapping_resolution: unknown;
  effective_mapping_resolution: unknown;
  mapped_base_name?: unknown;
  mapped_region?: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface CollectionMonitoringV2Date {
  date: string;
  rowCount: number;
  publicationId: string;
  publishedAt: string | null;
  snapshotAsOf: string | null;
}

export interface PublishedCollectionMonitoringV2 {
  dates: CollectionMonitoringV2Date[];
  period: { dateFrom: string; dateTo: string };
  records: CollectionMonitoringV2Record[];
  rowCount: number;
  publicationIds: string[];
  publishedAt: string | null;
  columnCount: typeof COLLECTION_MONITORING_V2_COLUMNS["length"];
}

export class CollectionMonitoringV2LoadError extends Error {
  readonly kind: "empty" | "request" | "timeout" | "inconsistent" | "invalid_data";

  constructor(kind: CollectionMonitoringV2LoadError["kind"], message: string) {
    super(message);
    this.name = "CollectionMonitoringV2LoadError";
    this.kind = kind;
  }
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
export interface CollectionMonitoringV2LoadOptions {
  requestTimeoutMs?: number;
  onProgress?: (loadedRows: number, totalRows: number) => void;
}
interface DatesResponse { sourceId: string; dates: CollectionMonitoringV2Date[]; hasPublishedPublication: boolean; }
interface RecordsPage { sourceId: string; records: CollectionMonitoringV2Record[]; total: number; limit: number; offset: number; }

function validDate(value: unknown): string {
  const candidate = String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? new Date(`${candidate}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "A publicação contém uma data inválida.");
  }
  return candidate;
}

function signature(dates: readonly CollectionMonitoringV2Date[]): string {
  return [...dates].map((item) =>
    `${validDate(item.date)}:${item.rowCount}:${item.publicationId}:${item.publishedAt ?? ""}:${item.snapshotAsOf ?? ""}`
  ).sort().join("|");
}

type ComparisonSnapshotResult =
  | { date: string; records: CollectionMonitoringV2Record[]; failed: false }
  | { date: string; records: []; failed: true };

async function loadComparisonSnapshot(
  date: string,
  base: string,
  fetcher: Fetcher,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ComparisonSnapshotResult> {
  const period = { dateFrom: date, dateTo: date };
  const initial = await json<DatesResponse>(`${base}/dates?${query(period)}`, fetcher, signal, timeoutMs);
  if (initial.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "A API retornou outra fonte de dados.");
  }
  const expectedDate = initial.dates.map((item) => ({ ...item, date: validDate(item.date) })).find((item) => item.date === date);
  if (!expectedDate) return { date, records: [], failed: false };
  if (!Number.isSafeInteger(expectedDate.rowCount) || expectedDate.rowCount < 0) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "A contagem da data de comparação é inválida.");
  }

  const records: CollectionMonitoringV2Record[] = [];
  const identities = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  do {
    const page = await json<RecordsPage>(`${base}/records?${query(period)}&limit=${COLLECTION_MONITORING_V2_PAGE_SIZE}&offset=${offset}`, fetcher, signal, timeoutMs);
    if (page.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID || page.offset !== offset || page.limit !== COLLECTION_MONITORING_V2_PAGE_SIZE) {
      throw new CollectionMonitoringV2LoadError("inconsistent", "A paginação da comparação diária mudou durante a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total < 0 || (total !== null && page.total !== total)) {
      throw new CollectionMonitoringV2LoadError("inconsistent", "A quantidade da comparação diária mudou durante a consulta.");
    }
    total = page.total;
    for (const row of page.records) {
      validateRow(row);
      if (validDate(row.data_date) !== date) {
        throw new CollectionMonitoringV2LoadError("inconsistent", "A comparação diária retornou uma data diferente da solicitada.");
      }
      const identity = rowId(row);
      if (identities.has(identity)) throw new CollectionMonitoringV2LoadError("inconsistent", "A comparação diária retornou uma linha repetida.");
      identities.add(identity);
      records.push(row);
    }
    offset += page.records.length;
    if (offset < page.total && page.records.length === 0) {
      throw new CollectionMonitoringV2LoadError("inconsistent", "A comparação diária terminou antes de carregar todas as linhas.");
    }
  } while ((total ?? 0) > offset);
  if (total !== expectedDate.rowCount || records.length !== expectedDate.rowCount) {
    throw new CollectionMonitoringV2LoadError("inconsistent", "A comparação diária não corresponde à partição publicada.");
  }
  const confirmed = await json<DatesResponse>(`${base}/dates?${query(period)}`, fetcher, signal, timeoutMs);
  const confirmedDate = confirmed.dates.map((item) => ({ ...item, date: validDate(item.date) })).filter((item) => item.date === date);
  if (confirmed.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID || signature(confirmedDate) !== signature([expectedDate])) {
    throw new CollectionMonitoringV2LoadError("inconsistent", "A publicação da comparação mudou durante o carregamento.");
  }
  return { date, records, failed: false };
}

async function json<T>(path: string, fetcher: Fetcher, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  if (signal?.aborted) throw new Error("Request aborted");
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abortFromParent = () => {
    controller.abort(signal?.reason);
    rejectAbort?.(new Error("Request aborted"));
  };
  signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout?.(new CollectionMonitoringV2LoadError("timeout", "A consulta demorou mais que o esperado. Tente novamente ou selecione um período menor."));
  }, timeoutMs);
  try {
    const request = (async () => {
      const response = await fetcher(path, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        let detail = "";
        try { detail = String((await response.json() as { detail?: unknown }).detail ?? ""); } catch { /* omit response body */ }
        const message = response.status === 401
          ? "Sua sessão expirou. Entre novamente para consultar o Monitoramento de Coleta."
          : response.status === 403
            ? "O acesso aos dados desta fonte não está autorizado para sua regional."
            : detail === "data_store_unavailable"
              ? "O serviço de dados está indisponível. Tente novamente mais tarde."
              : `A consulta do Monitoramento de Coleta falhou (HTTP ${response.status}).`;
        throw new CollectionMonitoringV2LoadError("request", message);
      }
      try { return await response.json() as T; } catch {
        throw new CollectionMonitoringV2LoadError("invalid_data", "A Data Foundation V2 retornou uma resposta inválida.");
      }
    })();
    return await Promise.race([request, timeout, aborted]);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof CollectionMonitoringV2LoadError) throw error;
    if (timedOut) throw new CollectionMonitoringV2LoadError("timeout", "A consulta demorou mais que o esperado. Tente novamente ou selecione um período menor.");
    throw new CollectionMonitoringV2LoadError("request", "Não foi possível conectar à Data Foundation V2.");
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function query(period?: { dateFrom?: string; dateTo?: string }, latestOnly = false): string {
  const params = new URLSearchParams({ contract_version: String(COLLECTION_MONITORING_V2_CONTRACT_VERSION) });
  if (latestOnly) params.set("latest_only", "true");
  if (period?.dateFrom) params.set("date_from", validDate(period.dateFrom));
  if (period?.dateTo) params.set("date_to", validDate(period.dateTo));
  return params.toString();
}

function rowId(row: CollectionMonitoringV2Record): string {
  const publication = String(row.publication_id ?? "");
  const rowNo = Number(row.source_row_no);
  if (!publication || !Number.isSafeInteger(rowNo) || rowNo < 1) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "Uma linha retornada não possui referência física válida.");
  }
  return `${publication}:${rowNo}`;
}

function validateRow(row: CollectionMonitoringV2Record): void {
  for (const column of COLLECTION_MONITORING_V2_COLUMNS) {
    if (!Object.hasOwn(row, column)) throw new CollectionMonitoringV2LoadError("invalid_data", "A publicação não corresponde às 23 colunas da V2.");
    const value = row[column];
    if (value == null && NULLABLE_COLUMNS.has(column)) continue;
    if (column === "data_date") validDate(value);
    else if (INTEGER_COLUMNS.has(column)) {
      const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || number < 0) throw new CollectionMonitoringV2LoadError("invalid_data", `A quantidade ${column} é inválida.`);
    } else if (DECIMAL_COLUMNS.has(column)) {
      const number = typeof value === "number" ? value : Number(String(value));
      if (!Number.isFinite(number) || number < 0 || number > 1) throw new CollectionMonitoringV2LoadError("invalid_data", `A taxa ${column} é inválida.`);
    } else if (typeof value !== "string") {
      throw new CollectionMonitoringV2LoadError("invalid_data", `O campo ${column} é inválido.`);
    }
  }
}

export async function loadPublishedCollectionMonitoringV2(
  period?: { dateFrom?: string; dateTo?: string },
  fetcher: Fetcher = apiFetch,
  signal?: AbortSignal,
  options: CollectionMonitoringV2LoadOptions = {},
): Promise<PublishedCollectionMonitoringV2> {
  const base = `/api/v2/data-sources/${COLLECTION_MONITORING_V2_SOURCE_ID}`;
  const timeoutMs = options.requestTimeoutMs ?? COLLECTION_MONITORING_V2_REQUEST_TIMEOUT_MS;
  const hasPeriod = Boolean(period?.dateFrom || period?.dateTo);
  const initial = await json<DatesResponse>(`${base}/dates?${query(period, !hasPeriod)}`, fetcher, signal, timeoutMs);
  if (initial.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID) throw new CollectionMonitoringV2LoadError("invalid_data", "A API retornou outra fonte de dados.");
  if (!initial.hasPublishedPublication || initial.dates.length === 0) {
    const message = hasPeriod ? "Não há dados publicados para o período selecionado." : "Aguardando primeira importação.";
    throw new CollectionMonitoringV2LoadError("empty", message);
  }
  const availableDates = [...initial.dates].map((item) => ({ ...item, date: validDate(item.date) }));
  const latestAvailableDate = availableDates.reduce((latest, item) => item.date > latest ? item.date : latest, availableDates[0].date);
  const dateFrom = period?.dateFrom
    ? validDate(period.dateFrom)
    : hasPeriod
      ? availableDates.reduce((min, item) => item.date < min ? item.date : min, availableDates[0].date)
      : latestAvailableDate;
  const dateTo = period?.dateTo
    ? validDate(period.dateTo)
    : hasPeriod
      ? availableDates.reduce((max, item) => item.date > max ? item.date : max, availableDates[0].date)
      : latestAvailableDate;
  if (dateFrom > dateTo) throw new CollectionMonitoringV2LoadError("invalid_data", "O período informado é inválido.");
  const dates = hasPeriod ? availableDates : availableDates.filter((item) => item.date === latestAvailableDate);
  const expectedDates = dates.filter((item) => item.date >= dateFrom && item.date <= dateTo);
  const expectedCount = expectedDates.reduce((sum, item) => sum + item.rowCount, 0);
  options.onProgress?.(0, expectedCount);
  const records: CollectionMonitoringV2Record[] = [];
  const identities = new Set<string>();
  let expectedOffset = 0;
  let reportedTotal: number | null = null;
  const params = query({ dateFrom, dateTo });
  for (;;) {
    const page = await json<RecordsPage>(`${base}/records?${params}&limit=${COLLECTION_MONITORING_V2_PAGE_SIZE}&offset=${expectedOffset}`, fetcher, signal, timeoutMs);
    if (page.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID || page.offset !== expectedOffset || page.limit !== COLLECTION_MONITORING_V2_PAGE_SIZE) {
      throw new CollectionMonitoringV2LoadError("inconsistent", "A paginação da publicação mudou durante a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total < 0 || (reportedTotal !== null && page.total !== reportedTotal)) {
      throw new CollectionMonitoringV2LoadError("inconsistent", "A quantidade de registros mudou durante a consulta.");
    }
    reportedTotal = page.total;
    for (const row of page.records) {
      validateRow(row);
      const identity = rowId(row);
      if (identities.has(identity)) throw new CollectionMonitoringV2LoadError("inconsistent", "A paginação retornou uma linha repetida.");
      identities.add(identity);
      records.push(row);
    }
    expectedOffset += page.records.length;
    options.onProgress?.(expectedOffset, expectedCount);
    if (expectedOffset >= page.total) break;
    if (page.records.length === 0) throw new CollectionMonitoringV2LoadError("inconsistent", "A consulta terminou antes de carregar todas as linhas.");
  }
  if (reportedTotal !== expectedCount || records.length !== expectedCount) {
    throw new CollectionMonitoringV2LoadError("inconsistent", "A quantidade de linhas não corresponde às partições diárias publicadas.");
  }
  const confirmed = await json<DatesResponse>(`${base}/dates?${query({ dateFrom, dateTo })}`, fetcher, signal, timeoutMs);
  if (signature(confirmed.dates) !== signature(expectedDates)) {
    throw new CollectionMonitoringV2LoadError("inconsistent", "A publicação foi alterada durante o carregamento. Tente novamente.");
  }
  return {
    dates: expectedDates,
    period: { dateFrom, dateTo },
    records,
    rowCount: records.length,
    columnCount: COLLECTION_MONITORING_V2_COLUMNS.length,
    publicationIds: [...new Set(expectedDates.map((item) => item.publicationId))],
    publishedAt: expectedDates.map((item) => item.publishedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
  };
}

export function collectionMonitoringV2ComparisonDates(
  dates: readonly CollectionMonitoringV2Date[],
  period: { dateFrom: string; dateTo: string },
): string[] {
  if (dates.length === 0) return [];
  const referenceDate = dates.reduce((latest, item) => item.date > latest ? item.date : latest, validDate(dates[0]!.date));
  return [-2, -1].map((offset) => {
    const value = new Date(`${referenceDate}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  }).filter((date) => date < period.dateFrom || date > period.dateTo);
}

export async function loadCollectionMonitoringV2ComparisonSnapshots(
  dates: readonly CollectionMonitoringV2Date[],
  period: { dateFrom: string; dateTo: string },
  fetcher: Fetcher = apiFetch,
  signal?: AbortSignal,
  options: CollectionMonitoringV2LoadOptions = {},
): Promise<{ records: CollectionMonitoringV2Record[]; failedDates: string[] }> {
  const base = `/api/v2/data-sources/${COLLECTION_MONITORING_V2_SOURCE_ID}`;
  const timeoutMs = options.requestTimeoutMs ?? COLLECTION_MONITORING_V2_REQUEST_TIMEOUT_MS;
  const comparisonDates = collectionMonitoringV2ComparisonDates(dates, period);
  const results = await Promise.all(comparisonDates.map(async (date): Promise<ComparisonSnapshotResult> => {
    try {
      return await loadComparisonSnapshot(date, base, fetcher, signal, timeoutMs);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { date, records: [], failed: true };
    }
  }));
  return {
    records: results.flatMap((item) => item.records),
    failedDates: results.filter((item) => item.failed).map((item) => item.date),
  };
}


export interface CollectionMonitoringV2RetentionRecord extends Record<string, unknown> {
  data_date: string;
  publication_id: string;
  region: string;
  row_count: number;
  expected_dropoff: number;
  expected_pickup: number;
  pending_dropoff: number;
  pending_pickup: number;
  status_collected: number;
  status_received_at_base: number;
  status_dispatched_from_base: number;
  status_in_transit_from_base: number;
  in_transit_to_center: number;
  in_transit_to_distribution: number;
  arrived_sorting_center: number;
  arrived_sc: number;
}

export interface CollectionMonitoringV2RmRetentionRecord extends CollectionMonitoringV2RetentionRecord {
  rm_area: string;
  rm: string;
}

export async function loadCollectionMonitoringV2Retention(
  period: { dateFrom?: string; dateTo?: string },
  fetcher: Fetcher = apiFetch,
  signal?: AbortSignal,
  filters: { region?: string; rm?: string; rmArea?: string; base?: string; origin?: string; rgmRegions?: readonly string[] } = {},
): Promise<{ dates: string[]; aggregates: CollectionMonitoringV2RetentionRecord[]; rmAggregates: CollectionMonitoringV2RmRetentionRecord[] }> {
  if (!period.dateFrom || !period.dateTo || validDate(period.dateFrom) > validDate(period.dateTo)) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "O período informado é inválido.");
  }
  const params = new URLSearchParams(query(period));
  for (const [field, value] of Object.entries({ region: filters.region, rm: filters.rm, rm_area: filters.rmArea, base: filters.base, origin: filters.origin })) if (value) params.set(field, value);
  if (filters.rgmRegions !== undefined) {
    params.set("rgm_filter", "true");
    for (const region of filters.rgmRegions) params.append("rgm_regions", region);
  }
  const result = await json<{ sourceId: string; contractVersion: number; dates: string[]; aggregates: CollectionMonitoringV2RetentionRecord[]; rmAggregates: CollectionMonitoringV2RmRetentionRecord[] }>(
    `/api/v2/collection-monitoring-v2/regional-retention?${params}`, fetcher, signal, COLLECTION_MONITORING_V2_REQUEST_TIMEOUT_MS,
  );
  if (result.sourceId !== COLLECTION_MONITORING_V2_SOURCE_ID || result.contractVersion !== 2 || !Array.isArray(result.dates) || !Array.isArray(result.aggregates) || !Array.isArray(result.rmAggregates)) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "A API retornou outra fonte de dados.");
  }
  result.dates = result.dates.map(validDate);
  if (result.dates.length > 3 || result.dates.some((date, index) => date < period.dateFrom! || date > period.dateTo! || (index > 0 && date <= result.dates[index - 1]))) {
    throw new CollectionMonitoringV2LoadError("invalid_data", "As datas da tabela de retenção são inválidas.");
  }
  for (const row of result.aggregates) {
    const date = validDate(row.data_date);
    if (date < period.dateFrom || date > period.dateTo || !result.dates.includes(date) || !row.publication_id) throw new CollectionMonitoringV2LoadError("inconsistent", "A publicação da comparação mudou durante o carregamento.");
    if (typeof row.region !== "string" || !row.region) throw new CollectionMonitoringV2LoadError("invalid_data", "A API retornou outra fonte de dados.");
    for (const field of ["expected_dropoff", "expected_pickup", "pending_dropoff", "pending_pickup", "status_collected", "status_received_at_base", "status_dispatched_from_base", "status_in_transit_from_base", "in_transit_to_center", "in_transit_to_distribution", "arrived_sorting_center", "arrived_sc", "row_count"]) {
      if (row[field] == null || !Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0) throw new CollectionMonitoringV2LoadError("invalid_data", `A quantidade ${field} é inválida.`);
      row[field] = Number(row[field]);
    }
  }
  for (const row of result.rmAggregates) {
    if (!row.rm_area || !row.rm || !row.region || !row.publication_id || validDate(row.data_date) !== result.dates.at(-1)) {
      throw new CollectionMonitoringV2LoadError("invalid_data", "A API retornou um agrupamento de RM inválido.");
    }
    for (const field of ["expected_dropoff", "expected_pickup", "status_received_at_base", "status_dispatched_from_base", "in_transit_to_center", "in_transit_to_distribution", "arrived_sorting_center", "arrived_sc", "row_count"]) {
      if (row[field] == null || !Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0) throw new CollectionMonitoringV2LoadError("invalid_data", `A quantidade ${field} é inválida.`);
      row[field] = Number(row[field]);
    }
  }
  return result;
}
