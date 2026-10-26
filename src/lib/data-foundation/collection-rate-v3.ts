import { apiFetch } from "../api-url.ts";

export const COLLECTION_RATE_V3_SOURCE_ID = "collection_rate";
export const COLLECTION_RATE_V3_CONTRACT_VERSION = 3;
export const COLLECTION_RATE_V3_PAGE_SIZE = 250;

export const COLLECTION_RATE_V3_COLUMNS = [
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

export const COLLECTION_RATE_V3_HEADERS: Readonly<Record<(typeof COLLECTION_RATE_V3_COLUMNS)[number], string>> = {
  deadline_at: "Horário de término do prazo de coleta",
  reported_region: "Nome da regional",
  source_base_name: "Nome da base de coleta",
  order_origin: "Origem do Pedido",
  product_type: "Tipo de produto",
  order_quantity: "Quantidade de pedidos",
  quantity_to_collect: "Qtd a coletar",
  cancelled_quantity: "Qtd cancelada",
  collection_rate: "Taxa de coleta",
  collected_quantity: "揽收量",
  not_collected_quantity: "未揽收量",
  not_collected_on_time_quantity: "Qtd não coletada no prazo",
  collected_on_time_quantity: "Qtd coletada no prazo",
  collection_on_time_rate: "Taxa de coleta no prazo",
  collected_plus_attempts_quantity: "Pedidos coletados + Tentativas de coleta",
  collection_rate_with_attempts: "Taxa de coleta com tentativas de coleta",
  average_collection_delay_hours: "Prazo médio demorado para coleta(h)",
  processed_problem_items: "已做问题件的量",
  unprocessed_problem_items: "未做问题件的量",
  seller_collection_rate: "Taxa de coleta do vendedor",
  expected_merchant_visits: "应上门商家量",
  merchants_not_visited: "未上门商家量",
};

const INTEGER_COLUMNS = new Set<string>([
  "order_quantity", "quantity_to_collect", "cancelled_quantity", "collected_quantity",
  "not_collected_quantity", "not_collected_on_time_quantity", "collected_on_time_quantity",
  "collected_plus_attempts_quantity", "processed_problem_items", "unprocessed_problem_items",
  "expected_merchant_visits", "merchants_not_visited",
]);
const RATE_COLUMNS = new Set<string>([
  "collection_rate", "collection_on_time_rate", "collection_rate_with_attempts", "seller_collection_rate",
]);
const DECIMAL_COLUMNS = new Set<string>([...RATE_COLUMNS, "average_collection_delay_hours"]);
const TEXT_COLUMNS = new Set<string>(["reported_region", "source_base_name", "order_origin", "product_type"]);
const NULLABLE_COLUMNS = new Set<string>(["reported_region", "source_base_name", "average_collection_delay_hours"]);

export interface CollectionRateV3Record extends Record<string, unknown> {
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
  effective_base_code: unknown;
  effective_mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
  mapped_base_name?: unknown;
}

export interface CollectionRateV3Period {
  dateFrom: string;
  dateTo: string;
}

export interface CollectionRateV3LoadProgress {
  loaded: number;
  total: number;
  stage: "records" | "validation";
}

export interface PublishedCollectionRateV3Data {
  sourceId: typeof COLLECTION_RATE_V3_SOURCE_ID;
  contractVersion: typeof COLLECTION_RATE_V3_CONTRACT_VERSION;
  publicationId: string | null;
  publicationIds: string[];
  publishedAt: string | null;
  snapshotAsOf: string | null;
  latestDayMayBeIncomplete: boolean;
  period: CollectionRateV3Period;
  records: CollectionRateV3Record[];
  rowCount: number;
  columnCount: typeof COLLECTION_RATE_V3_COLUMNS["length"];
}

export class CollectionRateV3LoadError extends Error {
  readonly kind: "empty" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: CollectionRateV3LoadError["kind"], message: string) {
    super(message);
    this.name = "CollectionRateV3LoadError";
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
interface DatesResponse { sourceId: string; dates: DateCount[]; hasPublishedPublication: boolean; }
interface RecordsPage {
  sourceId: string;
  records: CollectionRateV3Record[];
  total: number;
  limit: number;
  offset: number;
}

function apiErrorMessage(detail: unknown, status: number): string {
  const known: Record<string, string> = {
    authentication_required: "Sua sessão expirou. Entre novamente para consultar a Taxa de Coleta.",
    user_scope_unavailable: "Sua regional ainda não foi identificada. Solicite a liberação ao administrador da plataforma.",
    data_foundation_v2_disabled: "As consultas da Data Foundation estão desabilitadas neste backend.",
    data_store_unavailable: "O banco da Data Foundation está indisponível no momento.",
    official_mapping_unavailable: "O mapa oficial de bases está indisponível; a consulta não pode continuar.",
  };
  if (typeof detail === "string" && known[detail]) return known[detail];
  if (status === 401) return known.authentication_required;
  if (status === 403) return "Sua regional ainda não foi identificada. Solicite a liberação ao administrador da plataforma.";
  return `A API da Data Foundation retornou HTTP ${status}.`;
}

async function requestJson<T>(path: string, fetcher: ApiFetch, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { cache: "no-store", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new CollectionRateV3LoadError("request", "Não foi possível conectar à API da Data Foundation.");
  }
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json() as { detail?: unknown }).detail; } catch { /* omit backend body */ }
    throw new CollectionRateV3LoadError("request", apiErrorMessage(detail, response.status));
  }
  try { return await response.json() as T; } catch {
    throw new CollectionRateV3LoadError("invalid_data", "A API da Data Foundation retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new CollectionRateV3LoadError("invalid_data", "A publicação da Taxa de Coleta contém uma data inválida.");
  }
  return date;
}

function recordDate(record: CollectionRateV3Record): string {
  const value = record.deadline_at;
  if (value instanceof Date) return normalizeDate(value);
  if (typeof value !== "string") {
    throw new CollectionRateV3LoadError("invalid_data", "A publicação contém um horário de referência inválido.");
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) {
    throw new CollectionRateV3LoadError("invalid_data", "A publicação contém um horário de referência inválido.");
  }
  return normalizeDate(match[1]);
}

function dateSignature(dates: readonly DateCount[]): string {
  return [...dates].map(({ date, rowCount, publicationId, publishedAt, snapshotAsOf }) =>
    `${normalizeDate(date)}:${rowCount}:${publicationId}:${publishedAt ?? ""}:${snapshotAsOf ?? ""}`
  ).sort().join("|");
}

function rowIdentity(record: CollectionRateV3Record): string {
  const publicationId = String(record.publication_id ?? "");
  const rowNumber = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(rowNumber) || rowNumber < 1) {
    throw new CollectionRateV3LoadError("invalid_data", "A API retornou uma linha sem identificador físico válido.");
  }
  return `${publicationId}:${rowNumber}`;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function validateRecord(record: CollectionRateV3Record): void {
  for (const key of COLLECTION_RATE_V3_COLUMNS) {
    if (!Object.hasOwn(record, key)) {
      throw new CollectionRateV3LoadError("invalid_data", "A API retornou uma linha incompatível com o contrato JMS V3.");
    }
    const value = record[key];
    if (value === null && NULLABLE_COLUMNS.has(key)) continue;
    if (DECIMAL_COLUMNS.has(key)) {
      const parsed = numeric(value);
      if (parsed === null || (RATE_COLUMNS.has(key) && (parsed < 0 || parsed > 1))) {
        throw new CollectionRateV3LoadError("invalid_data", `A publicação contém um decimal inválido em ${key}.`);
      }
    } else if (INTEGER_COLUMNS.has(key)) {
      const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new CollectionRateV3LoadError("invalid_data", `A publicação contém uma quantidade inválida em ${key}.`);
      }
    } else if (TEXT_COLUMNS.has(key)) {
      if (typeof value !== "string") {
        throw new CollectionRateV3LoadError("invalid_data", `A publicação contém um texto inválido em ${key}.`);
      }
    }
  }
  recordDate(record);
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return present.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function mayBePartial(lastDate: string | undefined, snapshotAsOf: string | null): boolean {
  if (!lastDate || !snapshotAsOf) return false;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(snapshotAsOf);
  if (!match || match[1] !== lastDate) return false;
  const secondsIntoDay = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
  return secondsIntoDay < (23 * 3600 + 59 * 60 + 59);
}

export async function loadPublishedCollectionRateV3(
  period: CollectionRateV3Period,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
  onProgress?: (progress: CollectionRateV3LoadProgress) => void,
): Promise<PublishedCollectionRateV3Data> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new CollectionRateV3LoadError("invalid_data", "O período selecionado para Taxa de Coleta é inválido.");
  }

  const base = `/api/v2/data-sources/${COLLECTION_RATE_V3_SOURCE_ID}`;
  const shared = { contract_version: String(COLLECTION_RATE_V3_CONTRACT_VERSION) };
  const datesPath = `${base}/dates?${new URLSearchParams({ ...shared, date_from: dateFrom, date_to: dateTo })}`;
  const initial = await requestJson<DatesResponse>(datesPath, fetcher, signal);
  if (initial.sourceId !== COLLECTION_RATE_V3_SOURCE_ID || typeof initial.hasPublishedPublication !== "boolean" || !Array.isArray(initial.dates)) {
    throw new CollectionRateV3LoadError("invalid_data", "A API retornou metadados incompatíveis com a Taxa JMS V3.");
  }
  if (!initial.hasPublishedPublication) {
    throw new CollectionRateV3LoadError("empty", "Aguardando primeira importação");
  }

  const expectedByDate = new Map<string, DateCount>();
  for (const item of initial.dates) {
    const date = normalizeDate(item.date);
    if (
      date < dateFrom || date > dateTo || expectedByDate.has(date) ||
      !Number.isSafeInteger(item.rowCount) || item.rowCount < 0 ||
      typeof item.publicationId !== "string" || !item.publicationId.trim() ||
      (item.publishedAt !== null && (typeof item.publishedAt !== "string" || !Number.isFinite(Date.parse(item.publishedAt)))) ||
      (item.snapshotAsOf !== null && (typeof item.snapshotAsOf !== "string" || !Number.isFinite(Date.parse(item.snapshotAsOf))))
    ) {
      throw new CollectionRateV3LoadError("invalid_data", "A API retornou uma contagem diária incompatível.");
    }
    expectedByDate.set(date, { ...item, date });
  }

  const expectedDates = [...expectedByDate.values()];
  const expectedCount = expectedDates.reduce((sum, item) => sum + item.rowCount, 0);
  onProgress?.({ loaded: 0, total: expectedCount, stage: "records" });
  const publicationIds = [...new Set(expectedDates.map((item) => item.publicationId))].sort();
  const publishedAt = latestTimestamp(expectedDates.map((item) => item.publishedAt));
  const snapshotAsOf = latestTimestamp(expectedDates.map((item) => item.snapshotAsOf));
  if (expectedCount === 0) {
    return {
      sourceId: COLLECTION_RATE_V3_SOURCE_ID,
      contractVersion: COLLECTION_RATE_V3_CONTRACT_VERSION,
      publicationId: null,
      publicationIds: [],
      publishedAt,
      snapshotAsOf,
      latestDayMayBeIncomplete: false,
      period: { dateFrom, dateTo },
      records: [],
      rowCount: 0,
      columnCount: COLLECTION_RATE_V3_COLUMNS.length,
    };
  }

  const records: CollectionRateV3Record[] = [];
  const seenRows = new Set<string>();
  for (let offset = 0; offset < expectedCount; offset += COLLECTION_RATE_V3_PAGE_SIZE) {
    const limit = Math.min(COLLECTION_RATE_V3_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ ...shared, date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== COLLECTION_RATE_V3_SOURCE_ID || page.offset !== offset || page.limit !== limit || page.total !== expectedCount || page.records.length !== limit) {
      throw new CollectionRateV3LoadError("inconsistent", "A paginação da publicação mudou ou retornou uma página incompleta.");
    }
    for (const record of page.records) {
      validateRecord(record);
      const date = recordDate(record);
      if (date < dateFrom || date > dateTo) {
        throw new CollectionRateV3LoadError("invalid_data", "A API retornou linhas fora do período selecionado.");
      }
      if (String(record.publication_id ?? "") !== expectedByDate.get(date)?.publicationId) {
        throw new CollectionRateV3LoadError("inconsistent", "As linhas recebidas não correspondem à publicação diária vigente.");
      }
      const identity = rowIdentity(record);
      if (seenRows.has(identity)) throw new CollectionRateV3LoadError("invalid_data", "A API repetiu uma linha física durante a paginação.");
      seenRows.add(identity);
      records.push(record);
    }
    onProgress?.({ loaded: records.length, total: expectedCount, stage: "records" });
  }
  if (records.length !== expectedCount) throw new CollectionRateV3LoadError("inconsistent", "A paginação não recuperou todas as linhas esperadas.");

  onProgress?.({ loaded: 0, total: 0, stage: "validation" });
  const receivedByDate = new Map<string, number>();
  for (const record of records) {
    const date = recordDate(record);
    receivedByDate.set(date, (receivedByDate.get(date) ?? 0) + 1);
  }
  const expectedSignature = expectedDates.map(({ date, rowCount }) => `${date}:${rowCount}`).sort().join("|");
  const receivedSignature = [...receivedByDate].map(([date, count]) => `${date}:${count}`).sort().join("|");
  if (expectedSignature !== receivedSignature) {
    throw new CollectionRateV3LoadError("inconsistent", "As contagens por data não conferem com os registros recebidos.");
  }

  const after = await requestJson<DatesResponse>(datesPath, fetcher, signal);
  if (after.sourceId !== COLLECTION_RATE_V3_SOURCE_ID || after.hasPublishedPublication !== initial.hasPublishedPublication || dateSignature(initial.dates) !== dateSignature(after.dates)) {
    throw new CollectionRateV3LoadError("inconsistent", "Uma publicação mudou durante a consulta; atualize a página e tente novamente.");
  }

  const lastDate = [...receivedByDate.keys()].sort().at(-1);
  const latestDateSnapshot = lastDate ? expectedByDate.get(lastDate)?.snapshotAsOf ?? null : null;
  return {
    sourceId: COLLECTION_RATE_V3_SOURCE_ID,
    contractVersion: COLLECTION_RATE_V3_CONTRACT_VERSION,
    publicationId: publicationIds.length === 1 ? publicationIds[0] : null,
    publicationIds,
    publishedAt,
    snapshotAsOf,
    latestDayMayBeIncomplete: mayBePartial(lastDate, latestDateSnapshot),
    period: { dateFrom, dateTo },
    records,
    rowCount: records.length,
    columnCount: COLLECTION_RATE_V3_COLUMNS.length,
  };
}
