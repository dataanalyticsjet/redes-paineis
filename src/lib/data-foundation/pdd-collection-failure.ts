import { apiFetch } from "../api-url.ts";
import { withPublishedRegionalAssignment } from "./regional-assignment.ts";

export const PDD_COLLECTION_FAILURE_V2_SOURCE_ID = "pdd_collection_failure";
export const PDD_COLLECTION_FAILURE_V2_PAGE_SIZE = 250;

export const PDD_COLLECTION_FAILURE_V2_COLUMNS = [
  "data_date",
  "source_base_code",
  "source_base_name",
  "source_region_code",
  "reported_region",
  "orders_to_scan",
  "orders_unscanned_at_receipt",
  "rate_unscanned_at_receipt",
  "orders_unscanned_for_delivery",
  "rate_unscanned_for_delivery",
  "overall_unscanned_rate",
] as const;

export interface PddCollectionFailureV2Record extends Record<string, unknown> {
  data_date: unknown;
  source_base_code: unknown;
  source_base_name: unknown;
  source_region_code: unknown;
  reported_region: unknown;
  orders_to_scan: unknown;
  orders_unscanned_at_receipt: unknown;
  rate_unscanned_at_receipt: unknown;
  orders_unscanned_for_delivery: unknown;
  rate_unscanned_for_delivery: unknown;
  overall_unscanned_rate: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface PddCollectionFailureV2Period {
  dateFrom: string;
  dateTo: string;
}

export interface PublishedPddCollectionFailureData {
  sourceId: typeof PDD_COLLECTION_FAILURE_V2_SOURCE_ID;
  publicationId: string;
  publicationIds: string[];
  updatedAt: string;
  period: PddCollectionFailureV2Period;
  records: PddCollectionFailureV2Record[];
  rowCount: number;
  columnCount: typeof PDD_COLLECTION_FAILURE_V2_COLUMNS["length"];
}

export class PddCollectionFailureV2LoadError extends Error {
  readonly kind: "empty" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: PddCollectionFailureV2LoadError["kind"], message: string) {
    super(message);
    this.name = "PddCollectionFailureV2LoadError";
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
  records: PddCollectionFailureV2Record[];
  total: number;
  limit: number;
  offset: number;
}

function apiErrorMessage(detail: unknown, status: number): string {
  const known: Record<string, string> = {
    authentication_required: "Sua sessão expirou. Entre novamente para consultar os dados V2.",
    admin_required: "A consulta V2 exige um usuário ADMIN.",
    matrix_scope_required: "A consulta V2 exige perfil ADMIN com escopo matrix.",
    data_foundation_v2_disabled: "As consultas da Data Foundation V2 estão desabilitadas neste backend local.",
    data_store_unavailable: "O banco da Data Foundation V2 está indisponível no momento.",
    official_mapping_unavailable: "O mapa oficial de bases está indisponível; a consulta V2 não pode continuar.",
  };
  if (typeof detail === "string" && known[detail]) return known[detail];
  if (status === 401) return known.authentication_required;
  if (status === 403) return "A conta atual não tem autorização ADMIN/matrix para consultar os dados V2.";
  return `A API da Data Foundation V2 retornou HTTP ${status}.`;
}

async function requestJson<T>(path: string, fetcher: ApiFetch, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new PddCollectionFailureV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }

  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.json() as { detail?: unknown };
      detail = body.detail;
    } catch {
      // Do not forward arbitrary API response bodies to the UI.
    }
    throw new PddCollectionFailureV2LoadError("request", apiErrorMessage(detail, response.status));
  }

  try {
    return await response.json() as T;
  } catch {
    throw new PddCollectionFailureV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PddCollectionFailureV2LoadError("invalid_data", "A publicação V2 contém uma data inválida.");
  }
  return date;
}

function recordDate(record: PddCollectionFailureV2Record): string {
  return normalizeDate(record.data_date);
}

function stableDateSignature(dates: readonly DateCount[]): string {
  return [...dates]
    .map(({ date, rowCount }) => `${normalizeDate(date)}:${rowCount}`)
    .sort()
    .join("|");
}

function latestPublication(response: PublicationsResponse): Publication | null {
  const first = response.publications[0];
  return first && typeof first.publicationId === "string" ? first : null;
}

function rowIdentity(record: PddCollectionFailureV2Record): string {
  const publicationId = String(record.publication_id ?? "");
  const sourceRowNo = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(sourceRowNo) || sourceRowNo < 1) {
    throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou uma linha sem identificador físico válido.");
  }
  for (const column of PDD_COLLECTION_FAILURE_V2_COLUMNS) {
    if (!Object.hasOwn(record, column)) {
      throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou uma linha incompatível com o contrato de Falha na Coleta PDD.");
    }
  }
  return `${publicationId}:${sourceRowNo}`;
}

export async function loadPublishedPddCollectionFailure(
  period: PddCollectionFailureV2Period,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
): Promise<PublishedPddCollectionFailureData> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new PddCollectionFailureV2LoadError("invalid_data", "O período selecionado para Falha na Coleta PDD é inválido.");
  }

  const base = `/api/v2/data-sources/${PDD_COLLECTION_FAILURE_V2_SOURCE_ID}`;
  const dateQuery = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString();
  const datesPath = `${base}/dates?${dateQuery}`;
  const [beforePublications, beforeDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (beforePublications.sourceId !== PDD_COLLECTION_FAILURE_V2_SOURCE_ID || beforeDates.sourceId !== PDD_COLLECTION_FAILURE_V2_SOURCE_ID) {
    throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const publication = latestPublication(beforePublications);
  if (!publication || beforePublications.total < 1) {
    throw new PddCollectionFailureV2LoadError("empty", "Ainda não existe publicação vigente para Falha na Coleta PDD na Data Foundation V2.");
  }

  const expectedByDate = new Map<string, number>();
  for (const item of beforeDates.dates) {
    const date = normalizeDate(item.date);
    if (date < dateFrom || date > dateTo || expectedByDate.has(date) || !Number.isSafeInteger(item.rowCount) || item.rowCount < 0) {
      throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou uma contagem de data inválida.");
    }
    expectedByDate.set(date, item.rowCount);
  }

  const expectedCount = [...expectedByDate.values()].reduce((sum, count) => sum + count, 0);
  const records: PddCollectionFailureV2Record[] = [];
  const seenRows = new Set<string>();
  for (let offset = 0; offset < expectedCount; offset += PDD_COLLECTION_FAILURE_V2_PAGE_SIZE) {
    const limit = Math.min(PDD_COLLECTION_FAILURE_V2_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    // Omitting publication_id makes the API read source_daily_head, the current
    // publication for each selected business date under DAILY_REPLACE_DATES.
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== PDD_COLLECTION_FAILURE_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit) {
      throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou uma página incompatível com a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total !== expectedCount) {
      throw new PddCollectionFailureV2LoadError("inconsistent", "A quantidade de registros mudou durante a consulta; atualize a página e tente novamente.");
    }
    if (page.records.length !== limit) {
      throw new PddCollectionFailureV2LoadError("inconsistent", "A API V2 retornou uma página incompleta; atualize a página e tente novamente.");
    }
    for (const record of page.records) {
      const date = recordDate(record);
      if (date < dateFrom || date > dateTo) {
        throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou registros fora do período solicitado.");
      }
      const identity = rowIdentity(record);
      if (seenRows.has(identity)) {
        throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 repetiu uma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(record);
    }
  }

  if (records.length !== expectedCount) {
    throw new PddCollectionFailureV2LoadError("inconsistent", "A paginação V2 não recuperou todas as linhas esperadas.");
  }
  const receivedByDate = new Map<string, number>();
  for (const record of records) {
    const date = recordDate(record);
    receivedByDate.set(date, (receivedByDate.get(date) ?? 0) + 1);
  }
  const expectedDateSignature = stableDateSignature([...expectedByDate].map(([date, rowCount]) => ({ date, rowCount })));
  const receivedDateSignature = stableDateSignature([...receivedByDate].map(([date, rowCount]) => ({ date, rowCount })));
  if (expectedDateSignature !== receivedDateSignature) {
    throw new PddCollectionFailureV2LoadError("inconsistent", "As contagens por data não conferem com os registros recebidos.");
  }

  const [afterPublications, afterDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (afterPublications.sourceId !== PDD_COLLECTION_FAILURE_V2_SOURCE_ID || afterDates.sourceId !== PDD_COLLECTION_FAILURE_V2_SOURCE_ID) {
    throw new PddCollectionFailureV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const finalPublication = latestPublication(afterPublications);
  if (
    publication.publicationId !== finalPublication?.publicationId ||
    stableDateSignature(beforeDates.dates) !== stableDateSignature(afterDates.dates)
  ) {
    throw new PddCollectionFailureV2LoadError("inconsistent", "Uma nova publicação ocorreu durante a consulta; atualize a página e tente novamente.");
  }

  return {
    sourceId: PDD_COLLECTION_FAILURE_V2_SOURCE_ID,
    publicationId: publication.publicationId,
    publicationIds: [...new Set(records.map((record) => String(record.publication_id)))].sort(),
    updatedAt: publication.publishedAt,
    period: { dateFrom, dateTo },
    records: records.map(withPublishedRegionalAssignment),
    rowCount: records.length,
    columnCount: PDD_COLLECTION_FAILURE_V2_COLUMNS.length,
  };
}
