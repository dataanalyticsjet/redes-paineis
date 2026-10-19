export interface DashboardDataCacheRequest<T> {
  identityKey: string;
  sourceId: string;
  contractVersion: number;
  periodKey: string;
  manifest: (signal: AbortSignal) => Promise<string>;
  load: (signal: AbortSignal) => Promise<T>;
}

export type DashboardCacheFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface DashboardDataManifestRequest {
  sourceId: string;
  contractVersion: number;
  dateFrom?: string;
  dateTo?: string;
  publicationToken?: string | null;
  fetcher: DashboardCacheFetcher;
}

interface CacheEntry {
  manifest: string;
  expiresAt: number;
  size: number;
  sourceId: string;
  value: unknown;
}

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<unknown>;
  generation: number;
  sourceId: string;
}

const MAX_ENTRIES = 8;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightEntry>();
let generation = 0;

function stableKey(request: DashboardDataCacheRequest<unknown>): string {
  return JSON.stringify([
    request.identityKey,
    request.sourceId,
    request.contractVersion,
    request.periodKey,
  ]);
}

function serializedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_ENTRY_BYTES + 1;
  }
}

function trimCache(): void {
  let totalSize = [...entries.values()].reduce((total, entry) => total + entry.size, 0);
  while (entries.size > MAX_ENTRIES || totalSize > MAX_TOTAL_BYTES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    const removed = entries.get(oldest);
    entries.delete(oldest);
    totalSize -= removed?.size ?? 0;
  }
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function loadCachedDashboardData<T>(
  request: DashboardDataCacheRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!request.identityKey) return request.load(signal ?? new AbortController().signal);
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const key = stableKey(request);
  const currentManifest = await request.manifest(signal ?? new AbortController().signal);
  const cached = entries.get(key);
  if (cached && cached.expiresAt > Date.now() && cached.manifest === currentManifest) {
    entries.delete(key);
    entries.set(key, cached);
    return cached.value as T;
  }
  if (cached) entries.delete(key);

  const flightKey = `${key}\u0000${currentManifest}`;
  const existingFlight = inFlight.get(flightKey);
  if (existingFlight) return waitForCaller(existingFlight.promise as Promise<T>, signal);

  const currentGeneration = generation;
  const controller = new AbortController();
  const promise = request.load(controller.signal).then(async (value) => {
    const finalManifest = await request.manifest(controller.signal);
    if (finalManifest !== currentManifest) {
      throw new Error("dashboard_data_changed_during_load");
    }
    const size = serializedSize(value);
    if (!controller.signal.aborted && currentGeneration === generation && size <= MAX_ENTRY_BYTES) {
      entries.set(key, {
        manifest: currentManifest,
        expiresAt: Date.now() + CACHE_TTL_MS,
        size,
        sourceId: request.sourceId,
        value,
      });
      trimCache();
    }
    return value;
  }).finally(() => {
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, { controller, promise, generation: currentGeneration, sourceId: request.sourceId });
  return waitForCaller(promise, signal);
}

export async function readDashboardDataManifest(
  request: DashboardDataManifestRequest,
  signal: AbortSignal,
): Promise<string> {
  const [authorizationResponse, mappingResponse, publicationResponse] = await Promise.all([
    request.fetcher("/api/auth/me", { method: "GET", cache: "no-store", signal }),
    request.fetcher("/api/v2/base-mapping/current", { method: "GET", cache: "no-store", signal }),
    request.dateFrom && request.dateTo
      ? Promise.resolve(null)
      : request.fetcher(`/api/v2/data-sources/${encodeURIComponent(request.sourceId)}/publications?${new URLSearchParams({ contract_version: String(request.contractVersion), limit: "1", offset: "0" })}`, { method: "GET", cache: "no-store", signal }),
  ]);
  if (!authorizationResponse.ok) {
    invalidateDashboardDataCache(request.sourceId);
    throw new Error("dashboard_manifest_unavailable");
  }
  if (!mappingResponse.ok || (publicationResponse && !publicationResponse.ok)) {
    throw new Error("dashboard_manifest_unavailable");
  }
  const authorization = await authorizationResponse.json() as {
    authenticated?: unknown;
    is_active?: unknown;
    platform_role?: unknown;
    administrative_scope?: unknown;
    organizational_scope?: unknown;
    role?: unknown;
    home_region?: unknown;
    effective_regions?: unknown;
    data_scope_source?: unknown;
    organizational_region_code?: unknown;
    region_resolution_status?: unknown;
  };
  const syncFailed = authorization.region_resolution_status === "SYNC_FAILED";
  const explicitGrantDuringSyncFailure = syncFailed && authorization.data_scope_source === "admin_grant";
  const authorizedMatrix = !syncFailed && authorization.organizational_scope === "matrix" && authorization.role === "matrix";
  const authorizedRegional = authorization.organizational_scope === "regional" && authorization.role === "regional" &&
    (!syncFailed || explicitGrantDuringSyncFailure) &&
    Array.isArray(authorization.effective_regions) && authorization.effective_regions.length > 0;
  if (authorization.authenticated !== true || authorization.is_active !== true || (!authorizedMatrix && !authorizedRegional)) {
    invalidateDashboardDataCache(request.sourceId);
    throw new Error("dashboard_manifest_unauthorized");
  }
  const mapping = await mappingResponse.json() as { state?: unknown; mappingVersionId?: unknown };
  const publications = publicationResponse ? await publicationResponse.json() as {
    sourceId?: unknown;
    total?: unknown;
    publications?: unknown[];
  } : null;
  if (
    mapping.state !== "PUBLISHED" || typeof mapping.mappingVersionId !== "string" ||
    (publications && (publications.sourceId !== request.sourceId || !Array.isArray(publications.publications) || !Number.isSafeInteger(publications.total)))
  ) {
    throw new Error("dashboard_manifest_invalid");
  }

  let dateSignature: unknown = null;
  if (request.dateFrom && request.dateTo) {
    const datesQuery = new URLSearchParams({
      contract_version: String(request.contractVersion),
      date_from: request.dateFrom,
      date_to: request.dateTo,
    });
    const datesResponse = await request.fetcher(
      `/api/v2/data-sources/${encodeURIComponent(request.sourceId)}/dates?${datesQuery}`,
      { method: "GET", cache: "no-store", signal },
    );
    if (!datesResponse.ok) throw new Error("dashboard_manifest_unavailable");
    const dates = await datesResponse.json() as { sourceId?: unknown; dates?: unknown };
    if (dates.sourceId !== request.sourceId || !Array.isArray(dates.dates)) {
      throw new Error("dashboard_manifest_invalid");
    }
    dateSignature = dates.dates;
  }

  const publicationSignature = publications?.publications?.map((value: unknown) => {
    const item = value as Record<string, unknown>;
    return [item.publicationId, item.version, item.contractVersion, item.visibleRowCount, item.periodStart, item.periodEnd];
  }) ?? null;
  return JSON.stringify({
    authorization: {
      platformRole: authorization.platform_role,
      administrativeScope: authorization.administrative_scope,
      organizationalScope: authorization.organizational_scope,
      role: authorization.role,
      homeRegion: authorization.home_region,
      effectiveRegions: authorization.effective_regions,
      dataScopeSource: authorization.data_scope_source,
      organizationalRegionCode: authorization.organizational_region_code,
      regionResolutionStatus: authorization.region_resolution_status,
    },
    sourceId: request.sourceId,
    contractVersion: request.contractVersion,
    mappingVersionId: mapping.mappingVersionId,
    publishedTotal: publications?.total ?? null,
    publicationToken: request.publicationToken ?? null,
    publicationSignature,
    dateSignature,
  });
}

export function invalidateDashboardDataCache(sourceId?: string): void {
  generation += 1;
  for (const [key, entry] of entries) {
    if (!sourceId || entry.sourceId === sourceId || sourceId === "base_mapping_official") {
      entries.delete(key);
    }
  }
  for (const entry of inFlight.values()) {
    if (!sourceId || entry.sourceId === sourceId || sourceId === "base_mapping_official") entry.controller.abort();
  }
  for (const [key, entry] of inFlight) {
    if (!sourceId || entry.sourceId === sourceId || sourceId === "base_mapping_official") inFlight.delete(key);
  }
}

export function dashboardDataCacheSize(): number {
  return entries.size;
}
