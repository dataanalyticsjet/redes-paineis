import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_RATE_V3_COLUMNS,
  COLLECTION_RATE_V3_PAGE_SIZE,
  loadPublishedCollectionRateV3,
  type CollectionRateV3Record,
} from "../src/lib/data-foundation/collection-rate-v3.ts";

const publicationId = "12345678-1234-5678-1234-567812345678";
const dailyCounts = [
  726, 739, 710, 603, 574, 767, 758, 743, 745, 739, 620, 575, 654, 789, 682, 639, 652, 481, 388,
];

function officialRecord(date: string, sourceRowNo: number): CollectionRateV3Record {
  return {
    deadline_at: `${date} 00:00:00`,
    reported_region: null,
    source_base_name: null,
    order_origin: "Marketplace",
    product_type: "EXPRESS",
    order_quantity: 100,
    quantity_to_collect: 80,
    cancelled_quantity: 0,
    collection_rate: 0.75,
    collected_quantity: 60,
    not_collected_quantity: 20,
    not_collected_on_time_quantity: 0,
    collected_on_time_quantity: 55,
    collection_on_time_rate: 0.6875,
    collected_plus_attempts_quantity: 70,
    collection_rate_with_attempts: 0.9,
    average_collection_delay_hours: -1,
    processed_problem_items: 1,
    unprocessed_problem_items: 2,
    seller_collection_rate: 0.8,
    expected_merchant_visits: 10,
    merchants_not_visited: 1,
    publication_id: publicationId,
    source_row_no: sourceRowNo,
    resolved_base_code: null,
    mapping_resolution: "MISSING_IDENTIFIER",
    effective_base_code: null,
    effective_mapping_resolution: "MISSING_IDENTIFIER",
    mapped_region: null,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("V3 loader paginates all 12,584 rows across 19 daily partitions and checks publication stability", async () => {
  const dates = dailyCounts.map((rowCount, index) => {
    const date = `2026-10-${String(index + 1).padStart(2, "0")}`;
    return {
      date,
      rowCount,
      publicationId,
      publishedAt: "2026-10-19 14:10:00",
      snapshotAsOf: date === "2026-10-19" ? "2026-10-19 14:03:22" : `${date} 23:59:59`,
    };
  });
  const records: CollectionRateV3Record[] = [];
  let sourceRowNo = 2;
  dates.forEach(({ date, rowCount }) => {
    for (let index = 0; index < rowCount; index += 1) records.push(officialRecord(date, sourceRowNo++));
  });
  assert.equal(records.length, 12_584);
  const requests: string[] = [];

  const fetcher = async (path: string): Promise<Response> => {
    requests.push(path);
    const url = new URL(path, "https://new-bi.test");
    assert.equal(url.searchParams.get("contract_version"), "3");
    if (url.pathname.endsWith("/dates")) {
      return jsonResponse({ sourceId: "collection_rate", dates, hasPublishedPublication: true });
    }
    assert.ok(url.pathname.endsWith("/records"));
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    assert.ok(limit <= COLLECTION_RATE_V3_PAGE_SIZE);
    return jsonResponse({
      sourceId: "collection_rate",
      total: records.length,
      offset,
      limit,
      records: records.slice(offset, offset + limit),
    });
  };

  const published = await loadPublishedCollectionRateV3(
    { dateFrom: "2026-10-01", dateTo: "2026-10-19" },
    fetcher,
  );

  assert.equal(published.contractVersion, 3);
  assert.equal(published.rowCount, 12_584);
  assert.equal(published.columnCount, 22);
  assert.equal(published.records.length, 12_584);
  assert.equal(published.publicationId, publicationId);
  assert.equal(published.latestDayMayBeIncomplete, true);
  assert.equal(COLLECTION_RATE_V3_COLUMNS.length, 22);
  assert.equal(requests.filter((path) => path.includes("/records?")).length, Math.ceil(12_584 / COLLECTION_RATE_V3_PAGE_SIZE));
  assert.equal(requests.filter((path) => path.includes("/dates?")).length, 2);
});

test("V3 loader reports the first import state when no monthly publication exists", async () => {
  let requestCount = 0;
  const fetcher = async (): Promise<Response> => {
    requestCount += 1;
    return jsonResponse({ sourceId: "collection_rate", dates: [], hasPublishedPublication: false });
  };
  await assert.rejects(
    loadPublishedCollectionRateV3({ dateFrom: "2026-10-01", dateTo: "2026-10-19" }, fetcher),
    /Aguardando primeira importação/,
  );
  assert.equal(requestCount, 1);
});
test("V3 loader rejects rate values outside JMS fraction scale", async () => {
  const dates = [{ date: "2026-10-13", rowCount: 1, publicationId, publishedAt: null, snapshotAsOf: null }];
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "https://new-bi.test");
    if (url.pathname.endsWith("/dates")) return jsonResponse({ sourceId: "collection_rate", dates, hasPublishedPublication: true });
    return jsonResponse({
      sourceId: "collection_rate", total: 1, offset: 0, limit: 1,
      records: [{ ...officialRecord("2026-10-13", 2), collection_rate: 75 }],
    });
  };
  await assert.rejects(
    loadPublishedCollectionRateV3({ dateFrom: "2026-10-13", dateTo: "2026-10-13" }, fetcher),
    /decimal inválido em collection_rate/,
  );
});

test("V3 loader reports only page progress against the selected authorized period total", async () => {
  const count = 501;
  const dates = [{ date: "2026-10-13", rowCount: count, publicationId, publishedAt: null, snapshotAsOf: null }];
  const records = Array.from({ length: count }, (_, index) => officialRecord("2026-10-13", index + 2));
  const progress: Array<{ loaded: number; total: number; stage: "records" | "validation" }> = [];
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "https://new-bi.test");
    if (url.pathname.endsWith("/dates")) return jsonResponse({ sourceId: "collection_rate", dates, hasPublishedPublication: true });
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return jsonResponse({ sourceId: "collection_rate", total: count, offset, limit, records: records.slice(offset, offset + limit) });
  };

  const result = await loadPublishedCollectionRateV3(
    { dateFrom: "2026-10-13", dateTo: "2026-10-13" },
    fetcher,
    undefined,
    (value) => progress.push(value),
  );

  assert.equal(result.rowCount, count);
  assert.deepEqual(progress, [
    { loaded: 0, total: count, stage: "records" },
    { loaded: 250, total: count, stage: "records" },
    { loaded: 500, total: count, stage: "records" },
    { loaded: count, total: count, stage: "records" },
    { loaded: 0, total: 0, stage: "validation" },
  ]);
});
