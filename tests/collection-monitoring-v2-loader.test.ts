import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_PAGE_SIZE,
  loadPublishedCollectionMonitoringV2,
  type CollectionMonitoringV2Record,
} from "../src/lib/data-foundation/collection-monitoring-v2.ts";

const publicationId = "12345678-1234-5678-1234-567812345678";

function record(sourceRowNo: number): CollectionMonitoringV2Record {
  const row: Record<string, unknown> = {};
  for (const key of COLLECTION_MONITORING_V2_COLUMNS) {
    if (key === "data_date") row[key] = "2026-10-18";
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

test("Monitoramento V2 requests only contract version 2 and verifies complete paginated rows", async () => {
  const dates = [{ date: "2026-10-18", rowCount: 2, publicationId, publishedAt: "2026-10-20 08:22:16", snapshotAsOf: null }];
  const rows = [record(2), record(3)];
  const requested: string[] = [];
  const fetcher = async (path: string): Promise<Response> => {
    requested.push(path);
    const url = new URL(path, "https://new-bi.test");
    assert.equal(url.searchParams.get("contract_version"), "2");
    if (url.pathname.endsWith("/dates")) return response({ sourceId: "collection_monitoring", dates, hasPublishedPublication: true });
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
  assert.equal(requested.filter((path) => path.includes("/dates?")).length, 2);
  assert.equal(requested.filter((path) => path.includes("/records?")).length, 1);
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
