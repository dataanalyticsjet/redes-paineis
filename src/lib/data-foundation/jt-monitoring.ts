import { apiFetch } from "../api-url.ts";
import { withPublishedRegionalAssignment } from "./regional-assignment.ts";

export const JT_MONITORING_V2_SOURCE_ID = "jt_monitoring";
export const JT_MONITORING_V2_PAGE_SIZE = 250;
export const JT_MONITORING_V2_MAX_PREVIEW_ROWS = 1000;

export const JT_MONITORING_V2_COLUMNS = [
  "data_date",
  "reported_region",
  "source_base_name",
  "customer_name",
  "store_name",
  "seller_id",
  "assigned_driver",
  "order_origin",
  "awaiting_collection",
  "received_at_dropoff",
  "collected",
  "received",
  "received_at_base",
  "in_base_dispatch_flow",
  "arrived_at_sc",
] as const;

export interface JtMonitoringV2Record extends Record<string, unknown> {
  data_date: unknown;
  reported_region: unknown;
  source_base_name: unknown;
  customer_name: unknown;
  store_name: unknown;
  seller_id: unknown;
  assigned_driver: unknown;
  order_origin: unknown;
  awaiting_collection: unknown;
  received_at_dropoff: unknown;
  collected: unknown;
  received: unknown;
  received_at_base: unknown;
  in_base_dispatch_flow: unknown;
  arrived_at_sc: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface JtMonitoringV2Period {
  dateFrom: string;
  dateTo: string;
}

export interface JtMonitoringV2Page {
  sourceId: typeof JT_MONITORING_V2_SOURCE_ID;
  publicationId: string;
  publicationIds: string[];
  publishedAt: string;
  period: JtMonitoringV2Period;
  dateCountsSignature: string;
  records: JtMonitoringV2Record[];
  totalAvailable: number;
  offset: number;
  columnCount: typeof JT_MONITORING_V2_COLUMNS["length"];
}

export class JtMonitoringV2LoadError extends Error {
  readonly kind: "empty" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: JtMonitoringV2LoadError["kind"], message: string) {
    super(message);
    this.name = "JtMonitoringV2LoadError";
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
  records: JtMonitoringV2Record[];
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
    throw new JtMonitoringV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }
  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.json() as { detail?: unknown };
      detail = body.detail;
    } catch {
      // Do not forward arbitrary API response bodies to the UI.
    }
    throw new JtMonitoringV2LoadError("request", apiErrorMessage(detail, response.status));
  }
  try {
    return await response.json() as T;
  } catch {
    throw new JtMonitoringV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new JtMonitoringV2LoadError("invalid_data", "A publicação V2 contém uma data inválida.");
  }
  return date;
}

function recordDate(record: JtMonitoringV2Record): string {
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

export function jtMonitoringV2RowIdentity(record: JtMonitoringV2Record): string {
  const publicationId = String(record.publication_id ?? "");
  const sourceRowNo = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(sourceRowNo) || sourceRowNo < 1) {
    throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou uma linha sem identificador físico válido.");
  }
  for (const column of JT_MONITORING_V2_COLUMNS) {
    if (!Object.hasOwn(record, column)) {
      throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou uma linha incompatível com o contrato do Monitoramento J&T.");
    }
  }
  // Physical source identity preserves legitimate duplicate source values.
  return `${publicationId}:${sourceRowNo}`;
}

export async function loadJtMonitoringPage(
  period: JtMonitoringV2Period,
  offset = 0,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
): Promise<JtMonitoringV2Page> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new JtMonitoringV2LoadError("invalid_data", "O período selecionado para Monitoramento J&T é inválido.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % JT_MONITORING_V2_PAGE_SIZE !== 0) {
    throw new JtMonitoringV2LoadError("invalid_data", "A posição da página solicitada é inválida.");
  }

  const base = `/api/v2/data-sources/${JT_MONITORING_V2_SOURCE_ID}`;
  const dateQuery = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString();
  const datesPath = `${base}/dates?${dateQuery}`;
  const [beforePublications, beforeDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (beforePublications.sourceId !== JT_MONITORING_V2_SOURCE_ID || beforeDates.sourceId !== JT_MONITORING_V2_SOURCE_ID) {
    throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const publication = latestPublication(beforePublications);
  if (!publication || beforePublications.total < 1) {
    throw new JtMonitoringV2LoadError("empty", "Ainda não existe publicação vigente para Monitoramento J&T na Data Foundation V2.");
  }

  const expectedByDate = new Map<string, number>();
  for (const item of beforeDates.dates) {
    const date = normalizeDate(item.date);
    if (date < dateFrom || date > dateTo || expectedByDate.has(date) || !Number.isSafeInteger(item.rowCount) || item.rowCount < 0) {
      throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou uma contagem diária inválida.");
    }
    expectedByDate.set(date, item.rowCount);
  }
  const totalAvailable = [...expectedByDate.values()].reduce((sum, count) => sum + count, 0);
  if (offset > totalAvailable) {
    throw new JtMonitoringV2LoadError("invalid_data", "A posição da página ultrapassa o total disponível para o período.");
  }
  const dateCountsSignature = stableDateSignature(beforeDates.dates);
  const limit = Math.min(JT_MONITORING_V2_PAGE_SIZE, totalAvailable - offset);
  const records: JtMonitoringV2Record[] = [];
  const seenRows = new Set<string>();
  if (limit > 0) {
    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    // Omitting publication_id lets source_daily_head select the current
    // publication for every date in this DAILY_REPLACE_DATES query.
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== JT_MONITORING_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit) {
      throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou uma página incompatível com a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total !== totalAvailable) {
      throw new JtMonitoringV2LoadError("inconsistent", "A quantidade mudou durante a consulta; atualize o período e tente novamente.");
    }
    if (page.records.length !== limit) {
      throw new JtMonitoringV2LoadError("inconsistent", "A API V2 retornou uma página incompleta.");
    }
    for (const record of page.records) {
      const date = recordDate(record);
      if (date < dateFrom || date > dateTo) {
        throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou registros fora do período solicitado.");
      }
      const identity = jtMonitoringV2RowIdentity(record);
      if (seenRows.has(identity)) {
        throw new JtMonitoringV2LoadError("invalid_data", "A API V2 repetiu a mesma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(record);
    }
  }

  const [afterPublications, afterDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (afterPublications.sourceId !== JT_MONITORING_V2_SOURCE_ID || afterDates.sourceId !== JT_MONITORING_V2_SOURCE_ID) {
    throw new JtMonitoringV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  if (
    publication.publicationId !== latestPublication(afterPublications)?.publicationId ||
    dateCountsSignature !== stableDateSignature(afterDates.dates)
  ) {
    throw new JtMonitoringV2LoadError("inconsistent", "Uma nova publicação ocorreu durante a consulta; atualize a página e tente novamente.");
  }

  return {
    sourceId: JT_MONITORING_V2_SOURCE_ID,
    publicationId: publication.publicationId,
    publicationIds: [...new Set(records.map((record) => String(record.publication_id)))].sort(),
    publishedAt: publication.publishedAt,
    period: { dateFrom, dateTo },
    dateCountsSignature,
    records: records.map(withPublishedRegionalAssignment),
    totalAvailable,
    offset,
    columnCount: JT_MONITORING_V2_COLUMNS.length,
  };
}
