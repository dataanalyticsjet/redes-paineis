import { apiFetch } from "../api-url.ts";
import { withPublishedRegionalAssignment } from "./regional-assignment.ts";
import { yesterdayInSaoPaulo } from "./monitoring.ts";

export const COLLECTION_RATE_V2_SOURCE_ID = "collection_rate";
export const COLLECTION_RATE_V2_PAGE_SIZE = 250;

export const COLLECTION_RATE_V2_COLUMNS = [
  "deadline_at",
  "reported_region",
  "source_base_name",
  "order_origin",
  "product_type",
  "order_quantity",
  "quantity_to_collect",
  "cancelled_quantity",
  "collection_rate",
  "collected_quantity",
  "not_collected_quantity",
  "not_collected_on_time_quantity",
  "collected_on_time_quantity",
  "collection_on_time_rate",
  "collected_plus_attempts_quantity",
  "collection_rate_with_attempts",
  "average_collection_delay_hours",
  "processed_problem_items",
  "unprocessed_problem_items",
  "seller_collection_rate",
  "expected_merchant_visits",
  "merchants_not_visited",
] as const;

const DECIMAL_COLUMNS = new Set<string>([
  "collection_rate",
  "collection_on_time_rate",
  "collection_rate_with_attempts",
  "average_collection_delay_hours",
  "seller_collection_rate",
]);
const INTEGER_COLUMNS = new Set<string>([
  "order_quantity",
  "quantity_to_collect",
  "cancelled_quantity",
  "collected_quantity",
  "not_collected_quantity",
  "not_collected_on_time_quantity",
  "collected_on_time_quantity",
  "collected_plus_attempts_quantity",
  "processed_problem_items",
  "unprocessed_problem_items",
  "expected_merchant_visits",
  "merchants_not_visited",
]);
const TEXT_COLUMNS = new Set<string>([
  "reported_region",
  "source_base_name",
  "order_origin",
  "product_type",
]);

export interface CollectionRateV2Record extends Record<string, unknown> {
  deadline_at: unknown;
  reported_region: unknown;
  source_base_name: unknown;
  order_origin: unknown;
  product_type: unknown;
  order_quantity: unknown;
  quantity_to_collect: unknown;
  cancelled_quantity: unknown;
  collection_rate: unknown;
  collected_quantity: unknown;
  not_collected_quantity: unknown;
  not_collected_on_time_quantity: unknown;
  collected_on_time_quantity: unknown;
  collection_on_time_rate: unknown;
  collected_plus_attempts_quantity: unknown;
  collection_rate_with_attempts: unknown;
  average_collection_delay_hours: unknown;
  processed_problem_items: unknown;
  unprocessed_problem_items: unknown;
  seller_collection_rate: unknown;
  expected_merchant_visits: unknown;
  merchants_not_visited: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface CollectionRateV2Period {
  dateFrom: string;
  dateTo: string;
}

export interface PublishedCollectionRateData {
  sourceId: typeof COLLECTION_RATE_V2_SOURCE_ID;
  publicationId: string;
  updatedAt: string;
  period: CollectionRateV2Period;
  records: CollectionRateV2Record[];
  rowCount: number;
  columnCount: typeof COLLECTION_RATE_V2_COLUMNS["length"];
}

export class CollectionRateV2LoadError extends Error {
  readonly kind: "empty" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: CollectionRateV2LoadError["kind"], message: string) {
    super(message);
    this.name = "CollectionRateV2LoadError";
    this.kind = kind;
  }
}

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface DateCount {
  date: string;
  rowCount: number;
}

interface DatesResponse {
  sourceId: string;
  dates: DateCount[];
}

interface Publication {
  publicationId: string;
  version: number;
  publishedAt: string;
  visibleRowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
}

interface PublicationsResponse {
  sourceId: string;
  publications: Publication[];
  total: number;
  limit: number;
  offset: number;
}

interface RecordsPage {
  sourceId: string;
  records: CollectionRateV2Record[];
  total: number;
  limit: number;
  offset: number;
}

function apiErrorMessage(detail: unknown, status: number): string {
  const known: Record<string, string> = {
    authentication_required: "Sua sessão expirou. Entre novamente para consultar os dados V2.",
    admin_required: "Esta ação administrativa exige perfil ADMIN.",
    matrix_scope_required: "O escopo de matriz não está autorizado.",
    user_scope_unavailable: "Sua regional ainda não foi identificada. Solicite a liberação ao administrador da plataforma.",
    data_foundation_v2_disabled: "As consultas da Data Foundation V2 estão desabilitadas neste backend local.",
    data_store_unavailable: "O banco da Data Foundation V2 está indisponível no momento.",
    official_mapping_unavailable: "O mapa oficial de bases está indisponível; a consulta V2 não pode continuar.",
  };
  if (typeof detail === "string" && known[detail]) return known[detail];
  if (status === 401) return known.authentication_required;
  if (status === 403) return "Sua regional ainda não foi identificada. Solicite a liberação ao administrador da plataforma.";
  return `A API da Data Foundation V2 retornou HTTP ${status}.`;
}

async function requestJson<T>(path: string, fetcher: ApiFetch, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new CollectionRateV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }

  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.json() as { detail?: unknown };
      detail = body.detail;
    } catch {
      // Do not forward arbitrary API response bodies to the UI.
    }
    throw new CollectionRateV2LoadError("request", apiErrorMessage(detail, response.status));
  }

  try {
    return await response.json() as T;
  } catch {
    throw new CollectionRateV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new CollectionRateV2LoadError("invalid_data", "A publicação V2 contém uma data inválida.");
  }
  return date;
}

function recordDate(record: CollectionRateV2Record): string {
  const value = record.deadline_at;
  if (value instanceof Date) return normalizeDate(value);
  if (typeof value !== "string") {
    throw new CollectionRateV2LoadError("invalid_data", "A publicação V2 contém um prazo de coleta inválido.");
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) {
    throw new CollectionRateV2LoadError("invalid_data", "A publicação V2 contém um prazo de coleta inválido.");
  }
  return normalizeDate(match[1]);
}

function stableDateSignature(dates: readonly DateCount[]): string {
  return [...dates]
    .map(({ date, rowCount }) => `${normalizeDate(date)}:${rowCount}`)
    .sort()
    .join("|");
}

function rowIdentity(record: CollectionRateV2Record): string {
  const publicationId = String(record.publication_id ?? "");
  const sourceRowNo = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(sourceRowNo) || sourceRowNo < 1) {
    throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma linha sem identificador físico válido.");
  }
  return `${publicationId}:${sourceRowNo}`;
}

function validateRecord(record: CollectionRateV2Record): void {
  for (const key of COLLECTION_RATE_V2_COLUMNS) {
    if (!Object.hasOwn(record, key)) {
      throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma linha incompatível com o contrato de Taxa de Coleta.");
    }
  }
  recordDate(record);
  for (const [key, value] of Object.entries(record)) {
    if (DECIMAL_COLUMNS.has(key)) {
      if (value === null && key === "average_collection_delay_hours") continue;
      const decimalText = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(decimalText) || !Number.isFinite(Number(decimalText))) {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém um valor decimal inválido em ${key}.`);
      }
    } else if (INTEGER_COLUMNS.has(key)) {
      const numericValue = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(numericValue)) {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém uma quantidade inválida em ${key}.`);
      }
    } else if (TEXT_COLUMNS.has(key)) {
      const nullable = key === "reported_region" || key === "source_base_name";
      if (value === null && nullable) continue;
      if (typeof value !== "string") {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém texto inválido em ${key}.`);
      }
    }
  }
}

function latestPublication(response: PublicationsResponse): Publication | null {
  const first = response.publications[0];
  return first && typeof first.publicationId === "string" ? first : null;
}

export async function loadPublishedCollectionRate(
  period: CollectionRateV2Period,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
): Promise<PublishedCollectionRateData> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new CollectionRateV2LoadError("invalid_data", "O período selecionado para Taxa de Coleta é inválido.");
  }

  const base = `/api/v2/data-sources/${COLLECTION_RATE_V2_SOURCE_ID}`;
  const dateQuery = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString();
  const datesPath = `${base}/dates?${dateQuery}`;
  const [beforePublications, beforeDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (beforePublications.sourceId !== COLLECTION_RATE_V2_SOURCE_ID || beforeDates.sourceId !== COLLECTION_RATE_V2_SOURCE_ID) {
    throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const publication = latestPublication(beforePublications);
  if (!publication || beforePublications.total < 1) {
    throw new CollectionRateV2LoadError("empty", "Ainda não existe publicação vigente para Taxa de Coleta na Data Foundation V2.");
  }

  const expectedByDate = new Map<string, number>();
  for (const item of beforeDates.dates) {
    const date = normalizeDate(item.date);
    if (date < dateFrom || date > dateTo || expectedByDate.has(date) || !Number.isSafeInteger(item.rowCount) || item.rowCount < 0) {
      throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma contagem de data inválida.");
    }
    expectedByDate.set(date, item.rowCount);
  }

  const expectedCount = [...expectedByDate.values()].reduce((sum, count) => sum + count, 0);
  const records: CollectionRateV2Record[] = [];
  const seenRows = new Set<string>();
  for (let offset = 0; offset < expectedCount; offset += COLLECTION_RATE_V2_PAGE_SIZE) {
    const limit = Math.min(COLLECTION_RATE_V2_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== COLLECTION_RATE_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit) {
      throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma página incompatível com a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total !== expectedCount) {
      throw new CollectionRateV2LoadError("inconsistent", "A quantidade de registros mudou durante a consulta; atualize a página e tente novamente.");
    }
    if (page.records.length !== limit) {
      throw new CollectionRateV2LoadError("inconsistent", "A API V2 retornou uma página incompleta; atualize a página e tente novamente.");
    }
    for (const record of page.records) {
      validateRecord(record);
      const date = recordDate(record);
      if (date < dateFrom || date > dateTo) {
        throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou registros fora do período solicitado.");
      }
      const identity = rowIdentity(record);
      if (seenRows.has(identity)) {
        throw new CollectionRateV2LoadError("invalid_data", "A API V2 repetiu uma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(record);
    }
  }

  if (records.length !== expectedCount) {
    throw new CollectionRateV2LoadError("inconsistent", "A paginação V2 não recuperou todas as linhas esperadas.");
  }
  const receivedByDate = new Map<string, number>();
  for (const record of records) {
    const date = recordDate(record);
    receivedByDate.set(date, (receivedByDate.get(date) ?? 0) + 1);
  }
  const expectedDateSignature = stableDateSignature([...expectedByDate].map(([date, rowCount]) => ({ date, rowCount })));
  const receivedDateSignature = stableDateSignature([...receivedByDate].map(([date, rowCount]) => ({ date, rowCount })));
  if (expectedDateSignature !== receivedDateSignature) {
    throw new CollectionRateV2LoadError("inconsistent", "As contagens por data não conferem com os registros recebidos.");
  }

  const [afterPublications, afterDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (afterPublications.sourceId !== COLLECTION_RATE_V2_SOURCE_ID || afterDates.sourceId !== COLLECTION_RATE_V2_SOURCE_ID) {
    throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const finalPublication = latestPublication(afterPublications);
  if (
    publication.publicationId !== finalPublication?.publicationId ||
    stableDateSignature(beforeDates.dates) !== stableDateSignature(afterDates.dates)
  ) {
    throw new CollectionRateV2LoadError("inconsistent", "Uma nova publicação ocorreu durante a consulta; atualize a página e tente novamente.");
  }

  return {
    sourceId: COLLECTION_RATE_V2_SOURCE_ID,
    publicationId: publication.publicationId,
    updatedAt: publication.publishedAt,
    period: { dateFrom, dateTo },
    records: records.map(withPublishedRegionalAssignment),
    rowCount: records.length,
    columnCount: COLLECTION_RATE_V2_COLUMNS.length,
  };
}

export { yesterdayInSaoPaulo };
