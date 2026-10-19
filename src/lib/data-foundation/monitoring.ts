import { apiFetch } from "../api-url.ts";
import { resolvePublishedRegionalAssignment } from "./regional-assignment.ts";
import type { ParsedWorkbook, WorkbookColumn, WorkbookRow } from "../workbook";

export const MONITORING_V2_SOURCE_ID = "collection_monitoring";
export const MONITORING_V2_PAGE_SIZE = 250;

export interface MonitoringViewerAuthorization {
  platform_role?: string | null;
  administrative_scope?: string | null;
  organizational_scope?: string | null;
  role?: string | null;
  home_region?: string | null;
  home_base?: string | null;
  effective_regions?: readonly string[] | null;
  additional_regions?: readonly string[] | null;
  data_scope_source?: "feishu" | "admin_grant" | "none" | null;
  region_resolution_status?: "RESOLVED" | "UNKNOWN" | "AMBIGUOUS" | "SYNC_FAILED" | string | null;
  is_active?: boolean;
}

export function canReadMonitoringV2(identity: MonitoringViewerAuthorization | null | undefined): boolean {
  return identity?.platform_role === "ADMIN" &&
    identity.administrative_scope?.trim().toLowerCase() === "matrix";
}

/** Data scope is independent from the ADMIN permission. Unknown scopes fail closed. */
export function canReadDashboardV2Data(identity: MonitoringViewerAuthorization | null | undefined): boolean {
  if (!identity || identity.is_active === false) return false;
  const scope = identity.organizational_scope?.trim().toLowerCase();
  const role = identity.role?.trim().toLowerCase();
  const syncFailed = identity.region_resolution_status === "SYNC_FAILED";
  if (syncFailed) {
    return scope === "regional" && role === "regional" && identity.data_scope_source === "admin_grant" &&
      Boolean(identity.effective_regions?.some((region) => region.trim()));
  }
  if (scope === "matrix" && role === "matrix") return true;
  if (scope === "regional" && role === "regional") {
    return Boolean(
      identity.home_region?.trim() ||
      identity.effective_regions?.some((region) => region.trim()) ||
      identity.additional_regions?.some((region) => region.trim()),
    );
  }
  if (scope === "base" && role === "regional") return Boolean(identity.home_base?.trim());
  return false;
}

export interface MonitoringV2Record extends Record<string, unknown> {
  data_date: unknown;
  reported_region: unknown;
  source_base_name: unknown;
  seller_collection_rate: unknown;
  collection_visit_rate: unknown;
  expected_dropoff_collection: unknown;
  expected_pickup_collection: unknown;
  awaiting_collection_dropoff: unknown;
  awaiting_collection_pickup: unknown;
  collected_current: unknown;
  received_at_base_current: unknown;
  dispatched_by_base: unknown;
  in_transit_from_base: unknown;
  branch_outbound_transit_center: unknown;
  branch_outbound_transit_sorting: unknown;
  arrived_at_sorting_center: unknown;
  dispatched_by_sorting_center: unknown;
  sorting_outbound_transit: unknown;
  arrived_at_sc: unknown;
  package_created_by_base: unknown;
  processed_problem_items: unknown;
  unprocessed_problem_items: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

interface RecordsPage {
  sourceId: string;
  records: MonitoringV2Record[];
  total: number;
  limit: number;
  offset: number;
}

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

export interface PublishedMonitoringWorkbook {
  parsed: ParsedWorkbook;
  fileName: string;
  updatedAt: string;
  publicationId: string;
  rowCount: number;
}

export class MonitoringV2LoadError extends Error {
  readonly kind: "empty" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: MonitoringV2LoadError["kind"], message: string) {
    super(message);
    this.name = "MonitoringV2LoadError";
    this.kind = kind;
  }
}

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

const VALUE_FIELDS = [
  { key: "data_date", header: "Data", role: "date" as const },
  { key: "reported_region", header: "Regional Origem", role: "data" as const },
  { key: "source_base_name", header: "PDD de saida", role: "base" as const },
  { key: "seller_collection_rate", header: "Taxa de coleta do vendedor", role: "data" as const, decimal: true },
  { key: "collection_visit_rate", header: "Taxa de Visita de Coleta", role: "data" as const, decimal: true },
  { key: "expected_dropoff_collection", header: "Coleta Prevista Drop-off", role: "status-metric" as const },
  { key: "expected_pickup_collection", header: "Coleta Prevista Pick-up", role: "status-metric" as const },
  { key: "awaiting_collection_dropoff", header: "Aguardando Coleta Drop-off", role: "status-metric" as const },
  { key: "awaiting_collection_pickup", header: "Aguardando Coleta Pick-up", role: "status-metric" as const },
  { key: "collected_current", header: "Status atual – Coletado", role: "status-metric" as const },
  { key: "received_at_base_current", header: "Status atual – Recebido na base", role: "status-metric" as const },
  { key: "dispatched_by_base", header: "Expedida pela Base", role: "status-metric" as const },
  { key: "in_transit_from_base", header: "Status atual – Em trânsito a partir da base", role: "status-metric" as const },
  { key: "branch_outbound_transit_center", header: "网点发件在途(中心)", role: "status-metric" as const },
  { key: "branch_outbound_transit_sorting", header: "网点发件在途(集散)", role: "status-metric" as const },
  { key: "arrived_at_sorting_center", header: "Chegada ao Centro de Triagem", role: "status-metric" as const },
  { key: "dispatched_by_sorting_center", header: "Expedido pelo Centro de Triagem", role: "status-metric" as const },
  { key: "sorting_outbound_transit", header: "集散发件在途", role: "status-metric" as const },
  { key: "arrived_at_sc", header: "Status atual – Chegou ao SC", role: "status-metric" as const },
  { key: "package_created_by_base", header: "Pacote Criado pela Base", role: "status-metric" as const },
  { key: "processed_problem_items", header: "已处理问题件", role: "status-metric" as const },
  { key: "unprocessed_problem_items", header: "未处理问题件", role: "status-metric" as const },
] as const;

const STATUS_COLUMNS = VALUE_FIELDS
  .filter((field) => field.role === "status-metric")
  .map((field) => field.header);

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
    throw new MonitoringV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }

  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.json() as { detail?: unknown };
      detail = body.detail;
    } catch {
      // API response bodies are not forwarded to the UI.
    }
    throw new MonitoringV2LoadError("request", apiErrorMessage(detail, response.status));
  }

  try {
    return await response.json() as T;
  } catch {
    throw new MonitoringV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function normalizeDate(value: unknown): string {
  const date = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10)
    : String(value ?? "").slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new MonitoringV2LoadError("invalid_data", "A publicação V2 contém uma data inválida.");
  }
  return date;
}

function numericValue(value: unknown, field: string, nullable = false): number | null {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new MonitoringV2LoadError("invalid_data", `A publicação V2 contém um valor ausente em ${field}.`);
  }
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(number)) {
    throw new MonitoringV2LoadError("invalid_data", `A publicação V2 contém um valor inválido em ${field}.`);
  }
  return number;
}

function stableDateSignature(dates: readonly DateCount[]): string {
  return [...dates]
    .map(({ date, rowCount }) => `${normalizeDate(date)}:${rowCount}`)
    .sort()
    .join("|");
}

function rowIdentity(record: MonitoringV2Record): string {
  const publicationId = String(record.publication_id ?? "");
  const sourceRowNo = Number(record.source_row_no);
  if (!publicationId || !Number.isSafeInteger(sourceRowNo) || sourceRowNo < 1) {
    throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou uma linha sem identificador físico válido.");
  }
  return `${publicationId}:${sourceRowNo}`;
}

function latestPublication(response: PublicationsResponse): Publication | null {
  const first = response.publications[0];
  return first && typeof first.publicationId === "string" ? first : null;
}

function mapRecord(record: MonitoringV2Record): WorkbookRow {
  const row: WorkbookRow = {};
  const assignment = resolvePublishedRegionalAssignment(record);
  for (const field of VALUE_FIELDS) {
    const value = field.key === "reported_region"
      ? assignment.effective_region
      : field.key === "source_base_name"
        ? assignment.effective_base_name
        : record[field.key];
    if (field.role === "date") {
      row[field.header] = normalizeDate(value);
    } else if (field.role === "base" || field.key === "reported_region") {
      row[field.header] = value == null ? null : String(value);
    } else {
      const number = numericValue(value, field.key, "decimal" in field && field.decimal);
      if (field.role === "status-metric" && number !== null && !Number.isSafeInteger(number)) {
        throw new MonitoringV2LoadError("invalid_data", `A publicação V2 contém uma contagem não inteira em ${field.key}.`);
      }
      row[field.header] = number;
    }
  }
  // Keep V2 identity and mapping metadata available for audits without turning
  // an unresolved candidate into an approved base association in the UI.
  row.__publicationId = String(record.publication_id ?? "");
  row.__sourceRowNo = Number(record.source_row_no);
  row.__resolvedBaseCode = record.effective_base_code ?? record.resolved_base_code ?? null;
  row.__sourceResolvedBaseCode = record.resolved_base_code ?? null;
  row.__mappingResolution = record.effective_mapping_resolution ?? record.mapping_resolution ?? null;
  row.__sourceMappingResolution = record.mapping_resolution ?? null;
  row.__mappingMatchMethod = record.mapping_match_method ?? null;
  row.__reportedRegion = record.reported_region ?? null;
  row.__sourceBaseName = record.source_base_name ?? null;
  row.__effectiveBaseName = assignment.effective_base_name;
  row.__mappedRegion = record.mapped_region ?? null;
  row.__mappedUf = record.mapped_uf ?? null;
  row.__mappedRmArea = record.mapped_rm_area ?? null;
  row.__mappedRm = record.mapped_rm ?? null;
  row.__effectiveRegion = assignment.effective_region;
  row.__effectiveUf = assignment.effective_uf;
  row.__effectiveRmArea = assignment.effective_rm_area;
  row.__effectiveRm = assignment.effective_rm;
  row.__effectiveRgm = assignment.effective_rgm;
  row.__mappingApproved = assignment.mapping_is_approved;
  return row;
}

export function adaptMonitoringV2Records(records: readonly MonitoringV2Record[]): ParsedWorkbook {
  const headers = VALUE_FIELDS.map((field) => field.header);
  const rows = records.map(mapRecord);
  const dates = rows.map((row) => String(row["Data"])).sort();
  const columns: WorkbookColumn[] = VALUE_FIELDS.map((field, index) => ({
    key: field.header,
    originalHeader: field.header,
    normalizedHeader: field.header.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR"),
    index,
    role: field.role,
  }));

  return {
    sheetName: "Data Foundation V2",
    headers,
    rows,
    dateColumn: "Data",
    baseColumn: "PDD de saida",
    regionColumn: "Regional Origem",
    originColumn: undefined,
    statusColumn: undefined,
    statusColumns: [...STATUS_COLUMNS],
    warnings: [],
    metadata: {
      sheetNames: ["collection_monitoring"],
      headerRow: 1,
      rowCount: rows.length,
      columnCount: headers.length,
      columns,
      date1904: false,
      dateRange: dates.length ? { min: dates[0], max: dates.at(-1) as string } : undefined,
    },
  };
}

export interface MonitoringPeriod {
  dateFrom: string;
  dateTo: string;
}

export function yesterdayInSaoPaulo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const yesterday = new Date(Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")) - 1));
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

export async function loadPublishedMonitoringWorkbook(
  period: MonitoringPeriod,
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
): Promise<PublishedMonitoringWorkbook> {
  const dateFrom = normalizeDate(period.dateFrom);
  const dateTo = normalizeDate(period.dateTo);
  if (dateFrom !== period.dateFrom || dateTo !== period.dateTo || dateFrom > dateTo) {
    throw new MonitoringV2LoadError("invalid_data", "O período selecionado para Monitoramento de Coleta é inválido.");
  }
  const base = `/api/v2/data-sources/${MONITORING_V2_SOURCE_ID}`;
  const dateQuery = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString();
  const datesPath = `${base}/dates?${dateQuery}`;
  const [beforePublications, beforeDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (beforePublications.sourceId !== MONITORING_V2_SOURCE_ID || beforeDates.sourceId !== MONITORING_V2_SOURCE_ID) {
    throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const publication = latestPublication(beforePublications);
  if (!publication || beforePublications.total < 1) {
    throw new MonitoringV2LoadError("empty", "Ainda não existe publicação vigente para Monitoramento de Coleta na Data Foundation V2.");
  }

  const expectedByDate = new Map<string, number>();
  for (const item of beforeDates.dates) {
    const date = normalizeDate(item.date);
    if (date < dateFrom || date > dateTo || expectedByDate.has(date) || !Number.isSafeInteger(item.rowCount) || item.rowCount < 0) {
      throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou uma contagem de data inválida.");
    }
    expectedByDate.set(date, item.rowCount);
  }
  const expectedCount = [...expectedByDate.values()].reduce((sum, count) => sum + count, 0);
  const records: MonitoringV2Record[] = [];
  const seenRows = new Set<string>();
  const expectedTotal = expectedCount;
  for (let offset = 0; offset < expectedCount; offset += MONITORING_V2_PAGE_SIZE) {
    const limit = Math.min(MONITORING_V2_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, limit: String(limit), offset: String(offset) });
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== MONITORING_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit) {
      throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou uma página incompatível com a consulta.");
    }
    if (!Number.isSafeInteger(page.total) || page.total !== expectedTotal || page.total !== expectedCount) {
      throw new MonitoringV2LoadError("inconsistent", "A quantidade de registros mudou durante a consulta; atualize a página e tente novamente.");
    }
    if (page.records.length !== limit) {
      throw new MonitoringV2LoadError("inconsistent", "A API V2 retornou uma página incompleta; atualize a página e tente novamente.");
    }
    for (const record of page.records) {
      const recordDate = normalizeDate(record.data_date);
      if (recordDate < dateFrom || recordDate > dateTo) {
        throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou registros fora do período solicitado.");
      }
      const identity = rowIdentity(record);
      if (seenRows.has(identity)) {
        throw new MonitoringV2LoadError("invalid_data", "A API V2 repetiu uma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(record);
    }
  }

  if (records.length !== expectedCount) {
    throw new MonitoringV2LoadError("inconsistent", "A paginação V2 não recuperou todas as linhas esperadas.");
  }
  const receivedByDate = new Map<string, number>();
  for (const record of records) {
    const date = normalizeDate(record.data_date);
    receivedByDate.set(date, (receivedByDate.get(date) ?? 0) + 1);
  }
  const expectedDateSignature = stableDateSignature(
    [...expectedByDate].map(([date, rowCount]) => ({ date, rowCount })),
  );
  const receivedDateSignature = stableDateSignature(
    [...receivedByDate].map(([date, rowCount]) => ({ date, rowCount })),
  );
  if (expectedDateSignature !== receivedDateSignature) {
    throw new MonitoringV2LoadError("inconsistent", "As contagens por data não conferem com os registros recebidos.");
  }

  const [afterPublications, afterDates] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<DatesResponse>(datesPath, fetcher, signal),
  ]);
  if (afterPublications.sourceId !== MONITORING_V2_SOURCE_ID || afterDates.sourceId !== MONITORING_V2_SOURCE_ID) {
    throw new MonitoringV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  const finalPublication = latestPublication(afterPublications);
  if (
    publication.publicationId !== finalPublication?.publicationId ||
    stableDateSignature(beforeDates.dates) !== stableDateSignature(afterDates.dates)
  ) {
    throw new MonitoringV2LoadError("inconsistent", "Uma nova publicação ocorreu durante a consulta; atualize a página e tente novamente.");
  }

  const parsed = adaptMonitoringV2Records(records);
  if (parsed.rows.length !== expectedCount) {
    throw new MonitoringV2LoadError("inconsistent", "A conversão V2 não preservou a quantidade de registros.");
  }
  return {
    parsed,
    fileName: `Data Foundation V2 — ${MONITORING_V2_SOURCE_ID}`,
    updatedAt: publication.publishedAt,
    publicationId: publication.publicationId,
    rowCount: records.length,
  };
}
