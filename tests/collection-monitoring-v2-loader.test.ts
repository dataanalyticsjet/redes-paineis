import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_PAGE_SIZE,
  loadPublishedCollectionMonitoringV2,
  type CollectionMonitoringV2Record,
} from "../src/lib/data-foundation/collection-monitoring-v2.ts";

const publicationId = "12345678-1234-5678-1234-567812345678";

function record(sourceRowNo: number, dataDate = "2026-10-18"): CollectionMonitoringV2Record {
  const row: Record<string, unknown> = {};
  for (const key of COLLECTION_MONITORING_V2_COLUMNS) {
    if (key === "data_date") row[key] = dataDate;
    else if (["reported_origin_region", "source_base_name", "seller_collection_rate", "collection_visit_rate"].includes(key)) row[key] = null;
    else if (key === "order_origin") row[key] = "Marketplace";
    else row[key] = 0;
  }
  return {
    ...row,
    publication_id: publicationId,
    source_row_no: sourceRowNo,
    resolved_base_code: null,
    effective_base_code: null,
    mapping_resolution: "MISSING_IDENTIFIER",
    effective_mapping_resolution: "MISSING_IDENTIFIER",
    mapped_region: null,
  } as CollectionMonitoringV2Record;
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("Monitoramento V2 starts with the latest day and verifies all rows before resolving", async () => {
  const dates = [
    { date: "2026-10-17", rowCount: 1, publicationId, publishedAt: "2026-10-19 08:22:16", snapshotAsOf: null },
    { date: "2026-10-18", rowCount: 2, publicationId, publishedAt: "2026-10-20 08:22:16", snapshotAsOf: null },
  ];
  const rows = [record(2), record(3)];
  const requested: string[] = [];
  const fetcher = async (path: string): Promise<Response> => {
    requested.push(path);
    const url = new URL(path, "https://new-bi.test");
    assert.equal(url.searchParams.get("contract_version"), "2");
    if (url.pathname.endsWith("/dates")) {
      if (url.searchParams.get("latest_only") === "true") {
        return response({ sourceId: "collection_monitoring", dates, hasPublishedPublication: true });
      }
      return response({ sourceId: "collection_monitoring", dates: dates.filter((item) => item.date === "2026-10-18"), hasPublishedPublication: true });
    }
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    assert.ok(limit <= COLLECTION_MONITORING_V2_PAGE_SIZE);
    return response({ sourceId: "collection_monitoring", records: rows.slice(offset, offset + limit), total: rows.length, limit, offset });
  };
  const loaded = await loadPublishedCollectionMonitoringV2(undefined, fetcher);
  assert.equal(loaded.rowCount, 2);
  assert.equal(loaded.columnCount, 23);
  assert.deepEqual(loaded.publicationIds, [publicationId]);
  assert.equal(loaded.period.dateFrom, "2026-10-18");
  assert.equal(loaded.period.dateTo, "2026-10-18");
  assert.equal(requested.filter((path) => path.includes("/dates?")).length, 2);
  assert.equal(new URL(requested[0], "https://new-bi.test").searchParams.get("latest_only"), "true");
  assert.equal(requested.filter((path) => path.includes("/records?")).length, 1);
  assert.ok(requested.filter((path) => path.includes("/records?")).every((path) => {
    const url = new URL(path, "https://new-bi.test");
    return url.searchParams.get("date_from") === "2026-10-18" && url.searchParams.get("date_to") === "2026-10-18";
  }));
});

test("Monitoramento V2 loads only the selected historical period", async () => {
  const dates = [
    { date: "2026-10-17", rowCount: 1, publicationId, publishedAt: null, snapshotAsOf: null },
    { date: "2026-10-18", rowCount: 1, publicationId, publishedAt: null, snapshotAsOf: null },
    { date: "2026-10-19", rowCount: 1, publicationId, publishedAt: null, snapshotAsOf: null },
  ];
  const requested: string[] = [];
  const fetcher = async (path: string): Promise<Response> => {
    requested.push(path);
    const url = new URL(path, "https://new-bi.test");
    if (url.pathname.endsWith("/dates")) {
      const from = url.searchParams.get("date_from");
      const to = url.searchParams.get("date_to");
      return response({
        sourceId: "collection_monitoring",
        dates: dates.filter((item) => (!from || item.date >= from) && (!to || item.date <= to)),
        hasPublishedPublication: true,
      });
    }
    const offset = Number(url.searchParams.get("offset"));
    const periodRows = [record(4, "2026-10-18"), record(5, "2026-10-19")];
    return response({ sourceId: "collection_monitoring", records: periodRows.slice(offset, offset + 250), total: 2, limit: 250, offset });
  };
  const progress: Array<[number, number]> = [];
  const loaded = await loadPublishedCollectionMonitoringV2(
    { dateFrom: "2026-10-18", dateTo: "2026-10-19" },
    fetcher,
    undefined,
    { onProgress: (loadedRows, totalRows) => progress.push([loadedRows, totalRows]) },
  );
  assert.deepEqual(loaded.records.map((item) => item.data_date), ["2026-10-18", "2026-10-19"]);
  assert.deepEqual(loaded.dates.map((item) => item.date), ["2026-10-18", "2026-10-19"]);
  assert.deepEqual(progress, [[0, 2], [2, 2]]);
  assert.ok(requested.filter((path) => path.includes("/records?")).every((path) => {
    const url = new URL(path, "https://new-bi.test");
    return url.searchParams.get("date_from") === "2026-10-18" && url.searchParams.get("date_to") === "2026-10-19";
  }));
});

test("Monitoramento V2 loader keeps first-import state when the V2 contract has no publication", async () => {
  const fetcher = async (): Promise<Response> => response({ sourceId: "collection_monitoring", dates: [], hasPublishedPublication: false });
  await assert.rejects(loadPublishedCollectionMonitoringV2(undefined, fetcher), /Aguardando primeira importação/);
});

test("Monitoramento V2 loader rejects a publication that changes between date snapshots", async () => {
  let dateReads = 0;
  const before = [{ date: "2026-10-18", rowCount: 1, publicationId, publishedAt: null, snapshotAsOf: null }];
  const after = [{ date: "2026-10-18", rowCount: 2, publicationId, publishedAt: null, snapshotAsOf: null }];
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "https://new-bi.test");
    if (url.pathname.endsWith("/dates")) {
      dateReads += 1;
      return response({ sourceId: "collection_monitoring", dates: dateReads === 1 ? before : after, hasPublishedPublication: true });
    }
    return response({ sourceId: "collection_monitoring", records: [record(2)], total: 1, limit: 250, offset: 0 });
  };
  await assert.rejects(loadPublishedCollectionMonitoringV2(undefined, fetcher), /alterada durante o carregamento/);
});

test("Monitoramento V2 reports a clear timeout and respects cancellation of obsolete loads", async () => {
  const hangingFetcher = async (_path: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(
    loadPublishedCollectionMonitoringV2(undefined, hangingFetcher, undefined, { requestTimeoutMs: 5 }),
    (error: unknown) => error instanceof Error && error.message.includes("demorou mais que o esperado"),
  );

  const controller = new AbortController();
  const pending = loadPublishedCollectionMonitoringV2(undefined, hangingFetcher, controller.signal, { requestTimeoutMs: 5_000 });
  controller.abort();
  await assert.rejects(pending, /aborted|Request aborted/);
});
