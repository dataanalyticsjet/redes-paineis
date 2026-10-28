import assert from "node:assert/strict";
import test from "node:test";
import { apiFetch, subscribeToProtectedApiAuthorizationFailure } from "../src/lib/api-url.ts";
import {
  dashboardDataCacheSize,
  invalidateDashboardDataCache,
  loadCachedDashboardData,
  readDashboardDataManifest,
} from "../src/lib/data-foundation/dashboard-data-cache.ts";

test("reuses a dashboard result only for the same identity, source, period and manifest", async () => {
  invalidateDashboardDataCache();
  let manifest = "publication-a/map-1";
  let loads = 0;
  const request = (identityKey: string) => ({
    identityKey,
    sourceId: "collection_rate",
    contractVersion: 2,
    periodKey: "2026-10-13:2026-10-13:unfiltered",
    manifest: async () => manifest,
    load: async () => ({ value: ++loads }),
  });

  assert.deepEqual(await loadCachedDashboardData(request("user-a:SPE")), { value: 1 });
  assert.deepEqual(await loadCachedDashboardData(request("user-a:SPE")), { value: 1 });
  assert.equal(loads, 1);

  manifest = "publication-b/map-1";
  assert.deepEqual(await loadCachedDashboardData(request("user-a:SPE")), { value: 2 });
  assert.deepEqual(await loadCachedDashboardData(request("user-b:MG")), { value: 3 });
  assert.equal(loads, 3);
});

test("reuses concurrent loads and clears sensitive in-memory results on invalidation", async () => {
  invalidateDashboardDataCache();
  let loads = 0;
  let release: ((value: { rows: number[] }) => void) | undefined;
  const request = {
    identityKey: "user-a:SPE",
    sourceId: "no_movement",
    contractVersion: 2,
    periodKey: "current-snapshot",
    manifest: async () => "publication-1/map-1",
    load: async () => {
      loads += 1;
      return await new Promise<{ rows: number[] }>((resolve) => { release = resolve; });
    },
  };

  const first = loadCachedDashboardData(request);
  const second = loadCachedDashboardData(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads, 1);
  release?.({ rows: [1, 2, 3] });
  assert.deepEqual(await first, { rows: [1, 2, 3] });
  assert.deepEqual(await second, { rows: [1, 2, 3] });
  assert.equal(dashboardDataCacheSize(), 1);

  invalidateDashboardDataCache();
  assert.equal(dashboardDataCacheSize(), 0);
});

test("does not cache a result when its publication or mapping manifest changes during loading", async () => {
  invalidateDashboardDataCache();
  let manifestCalls = 0;
  await assert.rejects(
    loadCachedDashboardData({
      identityKey: "user-a:SPE",
      sourceId: "pdd_collection_failure",
      contractVersion: 2,
      periodKey: "2026-10-05:2026-10-05",
      manifest: async () => `manifest-${++manifestCalls}`,
      load: async () => ({ records: [1] }),
    }),
    /dashboard_data_changed_during_load/,
  );
  assert.equal(dashboardDataCacheSize(), 0);
});

test("invalidates a date-range cache when the publication changes without changing its date signature", async () => {
  invalidateDashboardDataCache();
  let publicationToken = "publication-a";
  let loads = 0;
  const fetcher = async (path: string) => {
    const payload = path === "/api/auth/me"
      ? { authenticated: true, is_active: true, platform_role: "USER", administrative_scope: "base", organizational_scope: "regional", role: "regional", home_region: "SPE", effective_regions: ["SPE"], data_scope_source: "feishu", organizational_region_code: "SPE", region_resolution_status: "RESOLVED" }
      : path === "/api/v2/base-mapping/current"
        ? { state: "PUBLISHED", mappingVersionId: "mapping-1" }
        : { sourceId: "collection_monitoring", dates: [{ date: "2026-10-05", rowCount: 10 }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const request = {
    identityKey: "user-a:SPE",
    sourceId: "collection_monitoring",
    contractVersion: 1,
    periodKey: "2026-10-05:2026-10-05:unfiltered-rows",
    manifest: (signal: AbortSignal) => readDashboardDataManifest({
      sourceId: "collection_monitoring",
      contractVersion: 1,
      dateFrom: "2026-10-05",
      dateTo: "2026-10-05",
      publicationToken,
      fetcher,
    }, signal),
    load: async () => ({ value: ++loads }),
  };

  assert.deepEqual(await loadCachedDashboardData(request), { value: 1 });
  assert.deepEqual(await loadCachedDashboardData(request), { value: 1 });
  publicationToken = "publication-b";
  assert.deepEqual(await loadCachedDashboardData(request), { value: 2 });
  assert.equal(loads, 2);
});

test("a server-side region change invalidates cached data even before the frontend refreshes identity", async () => {
  invalidateDashboardDataCache();
  let serverRegion = "CE";
  let loads = 0;
  const fetcher = async (path: string) => {
    const payload = path === "/api/auth/me"
      ? { authenticated: true, is_active: true, platform_role: "USER", administrative_scope: "base", organizational_scope: "regional", role: "regional", home_region: serverRegion, effective_regions: [serverRegion], data_scope_source: "feishu", organizational_region_code: serverRegion, region_resolution_status: "RESOLVED" }
      : path === "/api/v2/base-mapping/current"
        ? { state: "PUBLISHED", mappingVersionId: "mapping-1" }
        : { sourceId: "no_movement", total: 1, publications: [{ publicationId: "publication-1", version: 1, visibleRowCount: 1 }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const request = {
    identityKey: "page-session:user:SPE",
    sourceId: "no_movement",
    contractVersion: 2,
    periodKey: "current-snapshot",
    manifest: (signal: AbortSignal) => readDashboardDataManifest({
      sourceId: "no_movement",
      contractVersion: 2,
      fetcher,
    }, signal),
    load: async () => ({ region: ++loads === 1 ? "CE" : "SPS" }),
  };

  assert.deepEqual(await loadCachedDashboardData(request), { region: "CE" });
  serverRegion = "SPS";
  assert.deepEqual(await loadCachedDashboardData(request), { region: "SPS" });
  assert.equal(loads, 2);
});

test("an unknown or revoked server scope refuses cache use and clears that source", async () => {
  invalidateDashboardDataCache();
  let allowed = true;
  let loads = 0;
  const fetcher = async (path: string) => {
    const payload = path === "/api/auth/me"
      ? allowed
        ? { authenticated: true, is_active: true, platform_role: "USER", organizational_scope: "regional", role: "regional", home_region: "CE", effective_regions: ["CE"] }
        : { authenticated: true, is_active: true, platform_role: "USER", organizational_scope: "unknown", role: "unknown", effective_regions: [] }
      : path === "/api/v2/base-mapping/current"
        ? { state: "PUBLISHED", mappingVersionId: "mapping-1" }
        : { sourceId: "no_movement", total: 1, publications: [{ publicationId: "publication-1", version: 1, visibleRowCount: 1 }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const request = {
    identityKey: "page-session:user:CE",
    sourceId: "no_movement",
    contractVersion: 2,
    periodKey: "current-snapshot",
    manifest: (signal: AbortSignal) => readDashboardDataManifest({ sourceId: "no_movement", contractVersion: 2, fetcher }, signal),
    load: async () => ({ value: ++loads }),
  };

  await loadCachedDashboardData(request);
  assert.equal(dashboardDataCacheSize(), 1);
  allowed = false;
  await assert.rejects(loadCachedDashboardData(request), /dashboard_manifest_unauthorized/);
  assert.equal(loads, 1);
  assert.equal(dashboardDataCacheSize(), 0);
});

test("an expired session response clears cached dashboard data", async () => {
  invalidateDashboardDataCache();
  let expired = false;
  let loads = 0;
  const fetcher = async (path: string) => {
    if (path === "/api/auth/me" && expired) return new Response(null, { status: 401 });
    const payload = path === "/api/auth/me"
      ? { authenticated: true, is_active: true, platform_role: "USER", organizational_scope: "regional", role: "regional", home_region: "CE", effective_regions: ["CE"] }
      : path === "/api/v2/base-mapping/current"
        ? { state: "PUBLISHED", mappingVersionId: "mapping-1" }
        : { sourceId: "no_movement", total: 1, publications: [{ publicationId: "publication-1", version: 1, visibleRowCount: 1 }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const request = {
    identityKey: "page-session:user:CE",
    sourceId: "no_movement",
    contractVersion: 2,
    periodKey: "current-snapshot",
    manifest: (signal: AbortSignal) => readDashboardDataManifest({ sourceId: "no_movement", contractVersion: 2, fetcher }, signal),
    load: async () => ({ value: ++loads }),
  };

  await loadCachedDashboardData(request);
  assert.equal(dashboardDataCacheSize(), 1);
  expired = true;
  await assert.rejects(loadCachedDashboardData(request), /dashboard_manifest_unavailable/);
  assert.equal(loads, 1);
  assert.equal(dashboardDataCacheSize(), 0);
});

test("SYNC_FAILED denies cached data except for the exact explicit regional grant", async () => {
  invalidateDashboardDataCache();
  let authorization: Record<string, unknown> = {
    authenticated: true,
    is_active: true,
    platform_role: "USER",
    organizational_scope: "matrix",
    role: "matrix",
    data_scope_source: "none",
    region_resolution_status: "SYNC_FAILED",
    effective_regions: [],
  };
  let loads = 0;
  const fetcher = async (path: string) => {
    const payload = path === "/api/auth/me"
      ? authorization
      : path === "/api/v2/base-mapping/current"
        ? { state: "PUBLISHED", mappingVersionId: "mapping-1" }
        : { sourceId: "no_movement", total: 1, publications: [{ publicationId: "publication-1", visibleRowCount: 1 }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const request = {
    identityKey: "user-sync-failed",
    sourceId: "no_movement",
    contractVersion: 2,
    periodKey: "current-snapshot",
    manifest: (signal: AbortSignal) => readDashboardDataManifest({ sourceId: "no_movement", contractVersion: 2, fetcher }, signal),
    load: async () => ({ value: ++loads }),
  };

  await assert.rejects(loadCachedDashboardData(request), /dashboard_manifest_unauthorized/);
  assert.equal(loads, 0);
  assert.equal(dashboardDataCacheSize(), 0);

  authorization = {
    ...authorization,
    organizational_scope: "regional",
    role: "regional",
    data_scope_source: "admin_override",
    organizational_scope_policy: "V2",
    effective_regions: ["PR"],
  };
  await assert.rejects(loadCachedDashboardData(request), /dashboard_manifest_unauthorized/);
  assert.equal(loads, 0);

  authorization = {
    ...authorization,
    organizational_scope: "regional",
    role: "regional",
    data_scope_source: "admin_grant",
    organizational_scope_policy: "LEGACY",
    effective_regions: ["CE", "SPE"],
  };
  assert.deepEqual(await loadCachedDashboardData(request), { value: 1 });
  assert.equal(dashboardDataCacheSize(), 1);
});

test("protected API 401 and 403 responses invalidate the cache and notify the dashboard", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403] as const) {
      invalidateDashboardDataCache();
      await loadCachedDashboardData({
        identityKey: `user-${status}`,
        sourceId: "no_movement",
        contractVersion: 2,
        periodKey: "current-snapshot",
        manifest: async () => `manifest-${status}`,
        load: async () => ({ value: status }),
      });
      assert.equal(dashboardDataCacheSize(), 1);

      let received: { path: string; status: 401 | 403 } | null = null;
      const unsubscribe = subscribeToProtectedApiAuthorizationFailure((failure) => { received = failure; });
      globalThis.fetch = async () => new Response(null, { status });
      try {
        const response = await apiFetch("/api/v2/data-sources/no_movement/records");
        assert.equal(response.status, status);
        assert.deepEqual(received, { path: "/api/v2/data-sources/no_movement/records", status });
        assert.equal(dashboardDataCacheSize(), 0);
      } finally {
        unsubscribe();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    invalidateDashboardDataCache();
  }
});
