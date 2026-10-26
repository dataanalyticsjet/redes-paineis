import { apiFetch } from "../api-url.ts";
import { withPublishedRegionalAssignment } from "./regional-assignment.ts";

export const NO_MOVEMENT_V2_SOURCE_ID = "no_movement";
export const NO_MOVEMENT_V2_CONTRACT_VERSION = 2;
export const NO_MOVEMENT_V2_PAGE_SIZE = 250;

export const NO_MOVEMENT_V2_COLUMNS = [
  "reported_region",
  "source_base_code",
  "source_base_name",
  "stopped_orders",
  "orders_in_transit",
  "stopped_over_1_day",
  "stopped_over_2_days",
  "stopped_over_3_days",
  "stopped_over_4_days",
  "stopped_over_5_days",
  "stopped_over_6_days",
  "stopped_over_7_days",
  "stopped_over_10_days",
  "stopped_over_14_days",
  "stopped_over_30_days",
  "last_operation_at",
  "stopped_14_plus_days_rate",
  "stopped_30_plus_days_rate",
] as const;

export interface NoMovementV2Record extends Record<string, unknown> {
  reported_region: unknown;
  source_base_code: unknown;
  source_base_name: unknown;
  stopped_orders: unknown;
  orders_in_transit: unknown;
  stopped_over_1_day: unknown;
  stopped_over_2_days: unknown;
  stopped_over_3_days: unknown;
  stopped_over_4_days: unknown;
  stopped_over_5_days: unknown;
  stopped_over_6_days: unknown;
  stopped_over_7_days: unknown;
  stopped_over_10_days: unknown;
  stopped_over_14_days: unknown;
  stopped_over_30_days: unknown;
  last_operation_at: unknown;
  stopped_14_plus_days_rate: unknown;
  stopped_30_plus_days_rate: unknown;
  publication_id: unknown;
  source_row_no: unknown;
  resolved_base_code: unknown;
  mapping_resolution: unknown;
  mapped_region: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface PublishedNoMovementSnapshot {
  sourceId: typeof NO_MOVEMENT_V2_SOURCE_ID;
  publicationId: string;
  publishedAt: string;
  updatedAt: string | null;
  collectionDate: string | null;
  records: NoMovementV2Record[];
  rowCount: number;
  columnCount: typeof NO_MOVEMENT_V2_COLUMNS["length"];
}

export class NoMovementV2LoadError extends Error {
  readonly kind: "empty" | "incompatible" | "request" | "inconsistent" | "invalid_data";

  constructor(kind: NoMovementV2LoadError["kind"], message: string) {
    super(message);
    this.name = "NoMovementV2LoadError";
    this.kind = kind;
  }
}

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Publication {
  publicationId: string;
  version: number;
  contractVersion: number;
  publishedAt: string;
  snapshotAsOf?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  visibleRowCount: number;
}

interface PublicationsResponse {
  sourceId: string;
  publications: Publication[];
  total: number;
  limit: number;
  offset: number;
}

interface SnapshotCountResponse {
  sourceId: string;
  snapshotRowCount: number;
}

interface RecordsPage {
  sourceId: string;
  records: NoMovementV2Record[];
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
    throw new NoMovementV2LoadError("request", "Não foi possível conectar à API da Data Foundation V2.");
  }

  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.json() as { detail?: unknown };
      detail = body.detail;
    } catch {
      // Do not forward arbitrary API response bodies to the UI.
    }
    throw new NoMovementV2LoadError("request", apiErrorMessage(detail, response.status));
  }

  try {
    return await response.json() as T;
  } catch {
    throw new NoMovementV2LoadError("invalid_data", "A API da Data Foundation V2 retornou uma resposta inválida.");
  }
}

function latestPublication(response: PublicationsResponse): Publication | null {
  const first = response.publications[0];
  return first && typeof first.publicationId === "string" ? first : null;
}

function snapshotCountPath(): string {
  return `/api/v2/data-sources/${NO_MOVEMENT_V2_SOURCE_ID}/dates`;
}

async function readCurrentSnapshotMetadata(
  base: string,
  fetcher: ApiFetch,
  signal?: AbortSignal,
): Promise<{ publication: Publication | null; snapshotRowCount: number; totalPublications: number }> {
  const [publications, snapshot] = await Promise.all([
    requestJson<PublicationsResponse>(`${base}/publications?limit=1&offset=0`, fetcher, signal),
    requestJson<SnapshotCountResponse>(snapshotCountPath(), fetcher, signal),
  ]);
  if (publications.sourceId !== NO_MOVEMENT_V2_SOURCE_ID || snapshot.sourceId !== NO_MOVEMENT_V2_SOURCE_ID) {
    throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou metadados de outra fonte.");
  }
  if (
    !Number.isSafeInteger(publications.total) || publications.total < 0 ||
    !Number.isSafeInteger(snapshot.snapshotRowCount) || snapshot.snapshotRowCount < 0
  ) {
    throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou uma contagem inválida para o snapshot.");
  }
  const publication = latestPublication(publications);
  if (publications.total > 0 && (!publication || publication.visibleRowCount !== snapshot.snapshotRowCount)) {
    throw new NoMovementV2LoadError("inconsistent", "A publicação mais recente não corresponde ao snapshot vigente.");
  }
  if (publication?.periodStart && publication.periodEnd && publication.periodStart !== publication.periodEnd) {
    throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou mais de uma data de coleta para o snapshot.");
  }
  if (publications.total === 0 && snapshot.snapshotRowCount > 0) {
    throw new NoMovementV2LoadError("inconsistent", "O snapshot contém registros sem uma publicação identificável.");
  }
  return { publication, snapshotRowCount: snapshot.snapshotRowCount, totalPublications: publications.total };
}

function rowIdentity(record: NoMovementV2Record, publicationId: string): string {
  const recordPublicationId = String(record.publication_id ?? "");
  const sourceRowNo = Number(record.source_row_no);
  if (recordPublicationId !== publicationId || !Number.isSafeInteger(sourceRowNo) || sourceRowNo < 1) {
    throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou uma linha fora do snapshot ou sem número físico válido.");
  }
  for (const column of NO_MOVEMENT_V2_COLUMNS) {
    if (!Object.hasOwn(record, column)) {
      throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou uma linha incompatível com o contrato de Sem Movimentação.");
    }
  }
  return `${recordPublicationId}:${sourceRowNo}`;
}

export async function loadCurrentNoMovementSnapshot(
  fetcher: ApiFetch = apiFetch,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number, stage: "records" | "validation") => void,
): Promise<PublishedNoMovementSnapshot> {
  const base = `/api/v2/data-sources/${NO_MOVEMENT_V2_SOURCE_ID}`;
  const before = await readCurrentSnapshotMetadata(base, fetcher, signal);
  if (!before.publication || before.totalPublications < 1) {
    throw new NoMovementV2LoadError("empty", "Ainda não existe snapshot publicado para Sem Movimentação na Data Foundation V2.");
  }

  const publication = before.publication;
  if (publication.contractVersion !== NO_MOVEMENT_V2_CONTRACT_VERSION) {
    throw new NoMovementV2LoadError(
      "incompatible",
      "A publicação vigente não utiliza o contrato V2 de Sem Movimentação.",
    );
  }
  const expectedCount = before.snapshotRowCount;
  const records: NoMovementV2Record[] = [];
  const seenRows = new Set<string>();
  onProgress?.(0, expectedCount, "records");
  for (let offset = 0; offset < expectedCount; offset += NO_MOVEMENT_V2_PAGE_SIZE) {
    const limit = Math.min(NO_MOVEMENT_V2_PAGE_SIZE, expectedCount - offset);
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    // Omitting publication_id makes the API use source_snapshot_head, so only
    // the current SNAPSHOT_REPLACE_ALL dataset is read, never historical rows.
    const page = await requestJson<RecordsPage>(`${base}/records?${query}`, fetcher, signal);
    if (page.sourceId !== NO_MOVEMENT_V2_SOURCE_ID || page.offset !== offset || page.limit !== limit) {
      throw new NoMovementV2LoadError("invalid_data", "A API V2 retornou uma página incompatível com a consulta.");
    }
    if (page.total !== expectedCount || page.records.length !== limit) {
      throw new NoMovementV2LoadError("inconsistent", "A quantidade do snapshot mudou durante a paginação; atualize a página e tente novamente.");
    }
    for (const record of page.records) {
      const identity = rowIdentity(record, publication.publicationId);
      if (seenRows.has(identity)) {
        throw new NoMovementV2LoadError("invalid_data", "A API V2 repetiu uma linha física durante a paginação.");
      }
      seenRows.add(identity);
      records.push(record);
    }
    onProgress?.(records.length, expectedCount, "records");
  }

  if (records.length !== expectedCount) {
    throw new NoMovementV2LoadError("inconsistent", "A paginação V2 não recuperou todas as linhas esperadas.");
  }
  onProgress?.(0, 0, "validation");
  const after = await readCurrentSnapshotMetadata(base, fetcher, signal);
  if (
    publication.publicationId !== after.publication?.publicationId ||
    expectedCount !== after.snapshotRowCount
  ) {
    throw new NoMovementV2LoadError("inconsistent", "Uma nova publicação ocorreu durante a consulta; atualize a página e tente novamente.");
  }

  return {
    sourceId: NO_MOVEMENT_V2_SOURCE_ID,
    publicationId: publication.publicationId,
    publishedAt: publication.publishedAt,
    updatedAt: publication.snapshotAsOf ?? null,
    collectionDate: publication.periodStart ?? null,
    records: records.map(withPublishedRegionalAssignment),
    rowCount: records.length,
    columnCount: NO_MOVEMENT_V2_COLUMNS.length,
  };
}
