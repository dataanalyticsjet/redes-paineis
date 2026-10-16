import { apiFetch } from "../api-url.ts";
import { withPublishedRegionalAssignment } from "./regional-assignment.ts";

export const COLLECTION_RATE_V2_SOURCE_ID = "collection_rate";
export const COLLECTION_RATE_V2_CONTRACT_VERSION = 2;
export const COLLECTION_RATE_V2_PAGE_SIZE = 250;

export const COLLECTION_RATE_V2_COLUMNS = [
  "data_date",
  "source_region_code",
  "reported_region",
  "source_base_code",
  "source_base_name",
  "order_origin_code",
  "order_origin",
  "product_type_code",
  "product_type",
  "total_orders",
  "quantity_to_collect",
  "cancelled_orders",
  "collection_rate_reported",
  "collected_quantity",
  "not_collected_quantity",
  "not_collected_deadline_pending",
  "collected_on_time_quantity",
  "not_collected_after_deadline",
  "collected_after_deadline",
  "collection_on_time_rate_reported",
  "attempts_on_time_pending",
  "punctuality_rate_pending",
  "average_collection_pending",
  "problem_quantity",
  "no_problem_quantity",
  "seller_collection_rate_pending",
  "expected_shop_quantity_pending",
  "unexpected_shop_quantity_pending",
] as const;

export const COLLECTION_RATE_V2_HEADERS: Readonly<Record<(typeof COLLECTION_RATE_V2_COLUMNS)[number], string>> = {
  data_date: "Data de referência",
  source_region_code: "Código da regional",
  reported_region: "Regional",
  source_base_code: "Código da base de coleta",
  source_base_name: "Base de coleta",
  order_origin_code: "Código da origem do pedido",
  order_origin: "Origem do pedido",
  product_type_code: "Código do tipo de encomenda",
  product_type: "Tipo de encomenda",
  total_orders: "Total de pedidos",
  quantity_to_collect: "Quantidade prevista para coleta",
  cancelled_orders: "Total de cancelamentos",
  collection_rate_reported: "Taxa de coleta",
  collected_quantity: "Quantidade coletada",
  not_collected_quantity: "Quantidade não coletada",
  not_collected_deadline_pending: "Não coletados — indicador de prazo",
  collected_on_time_quantity: "Coletas no prazo",
  not_collected_after_deadline: "Não coletados fora do prazo",
  collected_after_deadline: "Coletas fora do prazo",
  collection_on_time_rate_reported: "Taxa de coleta no prazo",
  attempts_on_time_pending: "Tentativas de coleta no prazo",
  punctuality_rate_pending: "Taxa de pontualidade",
  average_collection_pending: "Média de coleta",
  problem_quantity: "Quantidade com problema",
  no_problem_quantity: "Quantidade sem problema",
  seller_collection_rate_pending: "Taxa relacionada à loja",
  expected_shop_quantity_pending: "Quantidade prevista — loja",
  unexpected_shop_quantity_pending: "Quantidade não prevista — loja",
};

const DECIMAL_COLUMNS = new Set<string>([
  "collection_rate_reported",
  "collection_on_time_rate_reported",
  "punctuality_rate_pending",
  "average_collection_pending",
  "seller_collection_rate_pending",
]);
const INTEGER_COLUMNS = new Set<string>([
  "total_orders",
  "quantity_to_collect",
  "cancelled_orders",
  "collected_quantity",
  "not_collected_quantity",
  "not_collected_deadline_pending",
  "collected_on_time_quantity",
  "not_collected_after_deadline",
  "collected_after_deadline",
  "attempts_on_time_pending",
  "problem_quantity",
  "no_problem_quantity",
  "expected_shop_quantity_pending",
  "unexpected_shop_quantity_pending",
]);
const TEXT_COLUMNS = new Set<string>([
  "source_region_code",
  "reported_region",
  "source_base_code",
  "source_base_name",
  "order_origin_code",
  "order_origin",
  "product_type_code",
  "product_type",
]);
const NULLABLE_COLUMNS = new Set<string>([
  "source_region_code",
  "reported_region",
  "source_base_code",
  "source_base_name",
  "average_collection_pending",
]);

export interface CollectionRateV2Record extends Record<string, unknown> {
  data_date: unknown;
  source_region_code: unknown;
  reported_region: unknown;
  source_base_code: unknown;
  source_base_name: unknown;
  order_origin_code: unknown;
  order_origin: unknown;
  product_type_code: unknown;
  product_type: unknown;
  total_orders: unknown;
  quantity_to_collect: unknown;
  cancelled_orders: unknown;
  collection_rate_reported: unknown;
  collected_quantity: unknown;
  not_collected_quantity: unknown;
  not_collected_deadline_pending: unknown;
  collected_on_time_quantity: unknown;
  not_collected_after_deadline: unknown;
  collected_after_deadline: unknown;
  collection_on_time_rate_reported: unknown;
  attempts_on_time_pending: unknown;
  punctuality_rate_pending: unknown;
  average_collection_pending: unknown;
  problem_quantity: unknown;
  no_problem_quantity: unknown;
  seller_collection_rate_pending: unknown;
  expected_shop_quantity_pending: unknown;
  unexpected_shop_quantity_pending: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  effective_base_code: unknown;
  effective_mapping_resolution: unknown;
  mapped_base_name: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface CollectionRateV2Period {
  dateFrom: string;
  dateTo: string;
}

export interface PublishedCollectionRateV2Data {
  sourceId: typeof COLLECTION_RATE_V2_SOURCE_ID;
  contractVersion: typeof COLLECTION_RATE_V2_CONTRACT_VERSION;
  publicationId: string | null;
  publicationIds: string[];
  publishedAt: string | null;
  snapshotAsOf: string | null;
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
  publicationId: string;
  publishedAt: string | null;
  snapshotAsOf: string | null;
}
interface DatesResponse {
  sourceId: string;
  dates: DateCount[];
  hasPublishedPublication: boolean;
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
    admin_required: "A consulta V2 exige um usuário ADMIN.",
    matrix_scope_required: "A consulta V2 exige perfil ADMIN com escopo matrix.",
    data_foundation_v2_disabled: "As consultas da Data Foundation V2 estão desabilitadas neste backend.",
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
    throw new CollectionRateV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json() as { detail?: unknown }).detail; } catch { /* omit backend body */ }
    throw new CollectionRateV2LoadError("request", apiErrorMessage(detail, response.status));
  }
  try { return await response.json() as T; } catch {
    throw new CollectionRateV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "");
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new CollectionRateV2LoadError("invalid_data", "A publicação V2 contém uma data inválida.");
  }
  return date;
}

function recordDate(record: CollectionRateV2Record): string {
  return normalizeDate(record.data_date);
}

function dateSignature(dates: readonly DateCount[]): string {
  return dates.map(({ date, rowCount, publicationId, publishedAt, snapshotAsOf }) =>
    `${normalizeDate(date)}:${rowCount}:${publicationId}:${publishedAt ?? ""}:${snapshotAsOf ?? ""}`
  ).sort().join("|");
}

function rowIdentity(record: CollectionRateV2Record): string {
  const publicationId = String(record.publication_id ?? "");
  const rowNumber = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(rowNumber) || rowNumber < 1) {
    throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma linha sem identificador físico válido.");
  }
  return `${publicationId}:${rowNumber}`;
}

function validateRecord(record: CollectionRateV2Record): void {
  for (const key of COLLECTION_RATE_V2_COLUMNS) {
    if (!Object.hasOwn(record, key)) {
      throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma linha incompatível com o contrato de Taxa de Coleta.");
    }
    const value = record[key];
    if (value === null && NULLABLE_COLUMNS.has(key)) continue;
    if (DECIMAL_COLUMNS.has(key)) {
      const numeric = typeof value === "number" ? value : typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(numeric) || (key !== "average_collection_pending" && (numeric < 0 || numeric > 1))) {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém um decimal inválido em ${key}.`);
      }
    } else if (INTEGER_COLUMNS.has(key)) {
      const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(numeric) || numeric < 0) {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém uma quantidade inválida em ${key}.`);
      }
    } else if (TEXT_COLUMNS.has(key)) {
      if (typeof value !== "string") {
        throw new CollectionRateV2LoadError("invalid_data", `A publicação V2 contém um texto inválido em ${key}.`);
      }
    }
  }
  recordDate(record);
}

export async function loadPublishedCollectionRateV2(
  period: CollectionRateV2Period,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
): Promise<PublishedCollectionRateV2Data> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new CollectionRateV2LoadError("invalid_data", "O período selecionado para Taxa de Coleta é inválido.");
  }

  const base = `/api/v2/data-sources/${COLLECTION_RATE_V2_SOURCE_ID}`;
  const shared = { contract_version: String(COLLECTION_RATE_V2_CONTRACT_VERSION) };
  const dateQuery = new URLSearchParams({ ...shared, date_from: dateFrom, date_to: dateTo }).toString();
  const datesPath = `${base}/dates?${dateQuery}`;
  const initialDates = await requestJson<DatesResponse>(datesPath, fetcher, signal);
  if (
    initialDates.sourceId !== COLLECTION_RATE_V2_SOURCE_ID ||
    typeof initialDates.hasPublishedPublication !== "boolean" ||
    !Array.isArray(initialDates.dates)
  ) {
    throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  if (!initialDates.hasPublishedPublication) {
    throw new CollectionRateV2LoadError("empty", "Ainda não existe publicação V2 para Taxa de Coleta.");
  }

  const expectedByDate = new Map<string, DateCount>();
  for (const item of initialDates.dates) {
    const date = normalizeDate(item.date);
    if (
      date < dateFrom || date > dateTo || expectedByDate.has(date) ||
      !Number.isSafeInteger(item.rowCount) || item.rowCount < 0 ||
      typeof item.publicationId !== "string" || !item.publicationId.trim() ||
      (item.publishedAt !== null && (typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt)))) ||
      (item.snapshotAsOf !== null && (typeof item.snapshotAsOf !== "string" || !Number.isFinite(Date.parse(item.snapshotAsOf))))
    ) {
      throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou uma contagem diária inválida.");
    }
    expectedByDate.set(date, { ...item, date });
  }
  const expectedDates = [...expectedByDate.values()];
  const expectedCount = expectedDates.reduce((sum, item) => sum + item.rowCount, 0);
  if (expectedCount === 0) {
    return {
      sourceId: COLLECTION_RATE_V2_SOURCE_ID,
      contractVersion: COLLECTION_RATE_V2_CONTRACT_VERSION,
      publicationId: null,
      publicationIds: [],
      publishedAt: null,
      snapshotAsOf: null,
      period: { dateFrom, dateTo },
      records: [],
      rowCount: 0,
      columnCount: COLLECTION_RATE_V2_COLUMNS.length,
    };
  }
  const records: CollectionRateV2Record[] = [];
  const seenRows = new Set<string>();
  for (let offset = 0; offset < expectedCount; offset += COLLECTION_RATE_V2_PAGE_SIZE) {
    const limit = Math.min(COLLECTION_RATE_V2_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ ...shared, date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== COLLECTION_RATE_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit || page.total !== expectedCount || page.records.length !== limit) {
      throw new CollectionRateV2LoadError("inconsistent", "A paginação da publicação mudou ou retornou uma página incompleta.");
    }
    for (const record of page.records) {
      validateRecord(record);
      const date = recordDate(record);
      if (date < dateFrom || date > dateTo) {
        throw new CollectionRateV2LoadError("invalid_data", "A API V2 retornou linhas fora do período selecionado.");
      }
      if (String(record.publication_id ?? "") !== expectedByDate.get(date)?.publicationId) {
        throw new CollectionRateV2LoadError("inconsistent", "As linhas recebidas não correspondem à publicação diária vigente.");
      }
      const identity = rowIdentity(record);
      if (seenRows.has(identity)) {
        throw new CollectionRateV2LoadError("invalid_data", "A API V2 repetiu uma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(withPublishedRegionalAssignment(record));
    }
  }
  if (records.length !== expectedCount) {
    throw new CollectionRateV2LoadError("inconsistent", "A paginação não recuperou todas as linhas da publicação.");
  }
  const receivedCounts = new Map<string, number>();
  for (const record of records) receivedCounts.set(recordDate(record), (receivedCounts.get(recordDate(record)) ?? 0) + 1);
  const receivedDates = [...receivedCounts].map(([date, rowCount]) => ({ date, rowCount }));
  if (receivedDates.length !== expectedDates.length || receivedDates.some(({ date, rowCount }) => expectedByDate.get(date)?.rowCount !== rowCount)) {
    throw new CollectionRateV2LoadError("inconsistent", "As contagens por data não conferem com as linhas recebidas.");
  }

  const finalDates = await requestJson<DatesResponse>(datesPath, fetcher, signal);
  if (
    finalDates.sourceId !== COLLECTION_RATE_V2_SOURCE_ID ||
    finalDates.hasPublishedPublication !== initialDates.hasPublishedPublication ||
    dateSignature(finalDates.dates) !== dateSignature(expectedDates)
  ) {
    throw new CollectionRateV2LoadError("inconsistent", "A publicação mudou durante a consulta; atualize o período e tente novamente.");
  }

  const publicationIds = [...new Set(expectedDates.map((item) => item.publicationId))].sort();
  const latestPublishedAt = expectedDates
    .map((item) => item.publishedAt)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const latestSnapshotAsOf = expectedDates
    .map((item) => item.snapshotAsOf)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

  return {
    sourceId: COLLECTION_RATE_V2_SOURCE_ID,
    contractVersion: COLLECTION_RATE_V2_CONTRACT_VERSION,
    publicationId: publicationIds.length === 1 ? publicationIds[0] : null,
    publicationIds,
    publishedAt: latestPublishedAt,
    snapshotAsOf: latestSnapshotAsOf,
    period: { dateFrom, dateTo },
    records,
    rowCount: records.length,
    columnCount: COLLECTION_RATE_V2_COLUMNS.length,
  };
}
