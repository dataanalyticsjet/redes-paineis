import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLECTION_RATE_V2_COLUMNS,
  CollectionRateV2LoadError,
  loadPublishedCollectionRateV2,
  type CollectionRateV2Record,
} from "../src/lib/data-foundation/collection-rate-v2.ts";

function record(sourceRowNo: number): CollectionRateV2Record {
  return {
    data_date: "2026-10-13",
    source_region_code: "REG-1",
    reported_region: "Informada",
    source_base_code: "123",
    source_base_name: "Base",
    order_origin_code: "D67",
    order_origin: "TikTok",
    product_type_code: "EZ",
    product_type: "EZ",
    total_orders: 100,
    quantity_to_collect: 80,
    cancelled_orders: 0,
    collection_rate_reported: "0.5",
    collected_quantity: 40,
    not_collected_quantity: 40,
    not_collected_deadline_pending: 0,
    collected_on_time_quantity: 35,
    not_collected_after_deadline: 0,
    collected_after_deadline: 0,
    collection_on_time_rate_reported: "0.4375",
    attempts_on_time_pending: 50,
    punctuality_rate_pending: "0.625",
    average_collection_pending: "1.2",
    problem_quantity: 0,
    no_problem_quantity: 0,
    seller_collection_rate_pending: "0.3",
    expected_shop_quantity_pending: 0,
    unexpected_shop_quantity_pending: 0,
    publication_id: "pub-2",
    source_row_no: sourceRowNo,
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    effective_base_code: null,
    effective_mapping_resolution: "UNMAPPED",
    mapped_base_name: null,
    mapped_region: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("loader envia período e versão antes da paginação e carrega todas as linhas em páginas até 250", async () => {
  const requests: URL[] = [];
  const publication = {
    publicationId: "pub-2",
    version: 4,
    contractVersion: 2,
    publishedAt: "2026-10-14T14:10:00Z",
    snapshotAsOf: "2026-10-14T14:05:22Z",
    visibleRowCount: 300,
    periodStart: "2026-10-13",
    periodEnd: "2026-10-13",
  };
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "http://local");
    requests.push(url);
    const endpoint = url.pathname.split("/").at(-1);
    if (endpoint === "dates") return jsonResponse({ sourceId: "collection_rate", hasPublishedPublication: true, dates: [{ date: "2026-10-13", rowCount: 300, publicationId: publication.publicationId, publishedAt: publication.publishedAt, snapshotAsOf: publication.snapshotAsOf }] });
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return jsonResponse({ sourceId: "collection_rate", records: Array.from({ length: limit }, (_, index) => record(offset + index + 2)), total: 300, limit, offset });
  };
  const result = await loadPublishedCollectionRateV2({ dateFrom: "2026-10-13", dateTo: "2026-10-13" }, fetcher);
  assert.equal(result.contractVersion, 2);
  assert.equal(result.rowCount, 300);
  assert.equal(result.columnCount, 28);
  assert.equal(result.snapshotAsOf, publication.snapshotAsOf);
  assert.equal(result.publicationId, publication.publicationId);
  assert.deepEqual(result.publicationIds, [publication.publicationId]);
  assert.equal(result.records.length, 300);
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith("/records")).map((url) => [url.searchParams.get("limit"), url.searchParams.get("offset")]), [["250", "0"], ["50", "250"]]);
  for (const url of requests) {
    assert.equal(url.searchParams.get("contract_version"), "2");
    if (url.pathname.endsWith("/records") || url.pathname.endsWith("/dates")) {
      assert.equal(url.searchParams.get("date_from"), "2026-10-13");
      assert.equal(url.searchParams.get("date_to"), "2026-10-13");
    }
  }
  assert.equal(COLLECTION_RATE_V2_COLUMNS.length, 28);
});

test("loader não usa publicação V1 quando V2 ainda não tem publicação", async () => {
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "http://local");
    assert.equal(url.pathname.endsWith("/publications"), false);
    return jsonResponse({ sourceId: "collection_rate", hasPublishedPublication: false, dates: [] });
  };
  await assert.rejects(
    () => loadPublishedCollectionRateV2({ dateFrom: "2026-10-13", dateTo: "2026-10-13" }, fetcher),
    (error: unknown) => error instanceof CollectionRateV2LoadError && error.kind === "empty",
  );
});

test("loader rejeita linhas físicas repetidas em páginas", async () => {
  const publication = { publicationId: "pub-2", version: 4, contractVersion: 2, publishedAt: "2026-10-14", snapshotAsOf: null, visibleRowCount: 2, periodStart: "2026-10-13", periodEnd: "2026-10-13" };
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "http://local");
    if (url.pathname.endsWith("/dates")) return jsonResponse({ sourceId: "collection_rate", hasPublishedPublication: true, dates: [{ date: "2026-10-13", rowCount: 2, publicationId: publication.publicationId, publishedAt: publication.publishedAt, snapshotAsOf: publication.snapshotAsOf }] });
    return jsonResponse({ sourceId: "collection_rate", records: [record(2), record(2)], total: 2, limit: 2, offset: 0 });
  };
  await assert.rejects(
    () => loadPublishedCollectionRateV2({ dateFrom: "2026-10-13", dateTo: "2026-10-13" }, fetcher),
    (error: unknown) => error instanceof CollectionRateV2LoadError && error.kind === "invalid_data",
  );
});

test("loader valida a publicação vigente por dia e resume metadados usados em períodos com várias publicações", async () => {
  const dailyMetadata = [
    { date: "2026-10-12", rowCount: 1, publicationId: "pub-older", publishedAt: "2026-10-13T12:00:00Z", snapshotAsOf: "2026-10-13T11:55:00Z" },
    { date: "2026-10-13", rowCount: 1, publicationId: "pub-newer", publishedAt: "2026-10-14T12:00:00Z", snapshotAsOf: "2026-10-14T11:55:00Z" },
  ];
  const fetcher = async (path: string): Promise<Response> => {
    const url = new URL(path, "http://local");
    if (url.pathname.endsWith("/dates")) {
      return jsonResponse({ sourceId: "collection_rate", hasPublishedPublication: true, dates: dailyMetadata });
    }
    const older = { ...record(2), data_date: "2026-10-12", publication_id: "pub-older" };
    const newer = { ...record(3), data_date: "2026-10-13", publication_id: "pub-newer" };
    return jsonResponse({ sourceId: "collection_rate", records: [older, newer], total: 2, limit: 2, offset: 0 });
  };
  const result = await loadPublishedCollectionRateV2(
    { dateFrom: "2026-10-12", dateTo: "2026-10-13" },
    fetcher,
  );
  assert.equal(result.publicationId, null);
  assert.deepEqual(result.publicationIds, ["pub-newer", "pub-older"]);
  assert.equal(result.publishedAt, "2026-10-14T12:00:00Z");
  assert.equal(result.snapshotAsOf, "2026-10-14T11:55:00Z");
  assert.equal(result.rowCount, 2);
});

test("loader representa período sem linhas sem confundi-lo com ausência de publicação V2", async () => {
  const fetcher = async (): Promise<Response> => jsonResponse({ sourceId: "collection_rate", hasPublishedPublication: true, dates: [] });
  const result = await loadPublishedCollectionRateV2(
    { dateFrom: "2026-10-12", dateTo: "2026-10-13" },
    fetcher,
  );
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.publicationIds, []);
});
