import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTION_RATE_V2_COLUMNS,
  COLLECTION_RATE_V2_PAGE_SIZE,
  COLLECTION_RATE_V2_SOURCE_ID,
  CollectionRateV2LoadError,
  loadPublishedCollectionRate,
  type CollectionRateV2Record,
  yesterdayInSaoPaulo,
} from "../src/lib/data-foundation/collection-rate.ts";

const PUBLICATION_ID = "collection-rate-publication-v1";

function collectionRateRecord(sourceRowNo: number, overrides: Partial<CollectionRateV2Record> = {}): CollectionRateV2Record {
  return {
    deadline_at: "2026-10-05 12:30:00",
    reported_region: "Regional Norte",
    source_base_name: "Base sem vínculo",
    order_origin: "Marketplace",
    product_type: "Padrão",
    order_quantity: 12,
    quantity_to_collect: 10,
    cancelled_quantity: 2,
    collection_rate: "0.8750000000000000",
    collected_quantity: 7,
    not_collected_quantity: 3,
    not_collected_on_time_quantity: 2,
    collected_on_time_quantity: 5,
    collection_on_time_rate: "0.7142857142857143",
    collected_plus_attempts_quantity: 8,
    collection_rate_with_attempts: "0.8000000000000000",
    average_collection_delay_hours: "1.2500",
    processed_problem_items: 1,
    unprocessed_problem_items: 0,
    seller_collection_rate: "0.7000000000000000",
    expected_merchant_visits: 10,
    merchants_not_visited: 2,
    publication_id: PUBLICATION_ID,
    source_row_no: sourceRowNo,
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    mapped_region: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeFetcher(records: CollectionRateV2Record[], options: { publicationIds?: string[] } = {}) {
  const recordRequests: URL[] = [];
  const metadataRequests = { publications: 0, dates: 0 };
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    requestSignals.push(init?.signal);
    const url = new URL(path, "http://local.test");
    const dateFrom = url.searchParams.get("date_from") ?? "0000-01-01";
    const dateTo = url.searchParams.get("date_to") ?? "9999-12-31";
    const periodRecords = records.filter((record) => {
      const date = String(record.deadline_at).slice(0, 10);
      return date >= dateFrom && date <= dateTo;
    });
    if (url.pathname.endsWith("/publications")) {
      const callIndex = metadataRequests.publications++;
      return jsonResponse({
        sourceId: COLLECTION_RATE_V2_SOURCE_ID,
        publications: [{
          publicationId: options.publicationIds?.[callIndex] ?? PUBLICATION_ID,
          version: 1,
          publishedAt: "2026-10-06T12:00:00Z",
          visibleRowCount: records.length,
          periodStart: "2026-10-01",
          periodEnd: "2026-10-05",
        }],
        total: 1,
        limit: 1,
        offset: 0,
      });
    }
    if (url.pathname.endsWith("/dates")) {
      const counts = new Map<string, number>();
      for (const record of periodRecords) {
        const date = String(record.deadline_at).slice(0, 10);
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
      metadataRequests.dates += 1;
      return jsonResponse({ sourceId: COLLECTION_RATE_V2_SOURCE_ID, dates: [...counts].map(([date, rowCount]) => ({ date, rowCount })) });
    }
    if (url.pathname.endsWith("/records")) {
      recordRequests.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        sourceId: COLLECTION_RATE_V2_SOURCE_ID,
        records: periodRecords.slice(offset, offset + limit),
        total: periodRecords.length,
        limit,
        offset,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetcher, recordRequests, metadataRequests, requestSignals };
}

test("Taxa V2 usa o contrato oficial com 22 colunas e preserva DECIMAL sem arredondar", async () => {
  const sourceRecord = collectionRateRecord(3);
  const { fetcher } = makeFetcher([sourceRecord]);
  const loaded = await loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, fetcher);

  assert.equal(COLLECTION_RATE_V2_SOURCE_ID, "collection_rate");
  assert.equal(COLLECTION_RATE_V2_COLUMNS.length, 22);
  assert.equal(loaded.columnCount, 22);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].collection_rate, "0.8750000000000000");
  assert.equal(loaded.records[0].collection_on_time_rate, "0.7142857142857143");
  assert.equal(loaded.records[0].average_collection_delay_hours, "1.2500");
  assert.equal(loaded.records[0].reported_region, "Regional Norte");
  assert.equal(loaded.records[0].source_base_name, "Base sem vínculo");
  assert.equal(loaded.records[0].mapping_resolution, "UNMAPPED");
  assert.equal(loaded.records[0].mapped_region, null);
  assert.equal(loaded.period.dateFrom, "2026-10-05");
  assert.equal(loaded.period.dateTo, "2026-10-05");
});

test("carrega apenas o intervalo solicitado em páginas de até 250, sem perda ou duplicação", async () => {
  const sourceRecords = Array.from({ length: 3269 }, (_, index) => collectionRateRecord(index + 2, {
    deadline_at: `2026-10-${String((index % 5) + 1).padStart(2, "0")} 12:30:00`,
  }));
  const { fetcher, recordRequests, metadataRequests } = makeFetcher(sourceRecords);
  const loaded = await loadPublishedCollectionRate({ dateFrom: "2026-10-01", dateTo: "2026-10-05" }, fetcher);

  assert.equal(loaded.rowCount, 3269);
  assert.equal(new Set(loaded.records.map((record) => `${record.publication_id}:${record.source_row_no}`)).size, 3269);
  assert.equal(recordRequests.length, 14);
  assert.equal(recordRequests.every((url) => Number(url.searchParams.get("limit")) <= COLLECTION_RATE_V2_PAGE_SIZE), true);
  assert.deepEqual(recordRequests.map((url) => Number(url.searchParams.get("offset"))), Array.from({ length: 14 }, (_, index) => index * 250));
  assert.equal(recordRequests.every((url) =>
    url.pathname === `/api/v2/data-sources/${COLLECTION_RATE_V2_SOURCE_ID}/records` &&
    url.searchParams.get("date_from") === "2026-10-01" &&
    url.searchParams.get("date_to") === "2026-10-05" &&
    !url.searchParams.has("publication_id")), true);
  assert.deepEqual(metadataRequests, { publications: 2, dates: 2 });
});

test("carrega 05/10 isoladamente e não substitui período sem dados pela última data", async () => {
  const sourceRecords = [
    collectionRateRecord(2, { deadline_at: "2026-10-01 08:00:00" }),
    collectionRateRecord(3, { deadline_at: "2026-10-05 18:30:00" }),
  ];
  const selectedFetcher = makeFetcher(sourceRecords);
  const selected = await loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, selectedFetcher.fetcher);
  assert.equal(selected.rowCount, 1);
  assert.equal(String(selected.records[0].deadline_at).slice(0, 10), "2026-10-05");
  assert.equal(selectedFetcher.recordRequests.every((url) => url.searchParams.get("date_from") === "2026-10-05"), true);

  const emptyFetcher = makeFetcher(sourceRecords);
  const empty = await loadPublishedCollectionRate({ dateFrom: "2026-10-04", dateTo: "2026-10-04" }, emptyFetcher.fetcher);
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.records.length, 0);
  assert.equal(emptyFetcher.recordRequests.length, 0);
});

test("verifica que a publicação não mude no meio da consulta", async () => {
  const { fetcher } = makeFetcher([collectionRateRecord(2)], { publicationIds: [PUBLICATION_ID, "new-publication"] });
  await assert.rejects(
    loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, fetcher),
    (error: unknown) => error instanceof CollectionRateV2LoadError && error.kind === "inconsistent",
  );
});

test("recusa linhas duplicadas na paginação e linhas fora do contrato", async () => {
  const duplicated = makeFetcher([collectionRateRecord(2), collectionRateRecord(2)]);
  await assert.rejects(
    loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, duplicated.fetcher),
    (error: unknown) => error instanceof CollectionRateV2LoadError && error.kind === "invalid_data",
  );

  const missingField = collectionRateRecord(2);
  delete (missingField as Partial<CollectionRateV2Record>).order_origin;
  const invalid = makeFetcher([missingField]);
  await assert.rejects(
    loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, invalid.fetcher),
    (error: unknown) => error instanceof CollectionRateV2LoadError && error.kind === "invalid_data",
  );
});

test("propaga cancelamento e calcula D-1 em America/Sao_Paulo", async () => {
  const controller = new AbortController();
  const { fetcher, requestSignals } = makeFetcher([collectionRateRecord(2)]);
  await loadPublishedCollectionRate({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, fetcher, controller.signal);
  assert.equal(requestSignals.length, 5);
  assert.equal(requestSignals.every((signal) => signal === controller.signal), true);
  assert.equal(yesterdayInSaoPaulo(new Date("2026-10-09T02:30:00.000Z")), "2026-10-07");
  assert.equal(yesterdayInSaoPaulo(new Date("2026-10-09T15:00:00.000Z")), "2026-10-08");
});
