import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPublishedPddCollectionFailure,
  PDD_COLLECTION_FAILURE_V2_COLUMNS,
  PDD_COLLECTION_FAILURE_V2_PAGE_SIZE,
  PDD_COLLECTION_FAILURE_V2_SOURCE_ID,
  PddCollectionFailureV2LoadError,
  type PddCollectionFailureV2Record,
} from "../src/lib/data-foundation/pdd-collection-failure.ts";

const PUBLICATION_ID = "pdd-failure-publication-v1";

function pddRecord(sourceRowNo: number, date: string, overrides: Partial<PddCollectionFailureV2Record> = {}): PddCollectionFailureV2Record {
  return {
    data_date: date,
    source_base_code: "000123",
    source_base_name: "Base sem vínculo",
    source_region_code: "0004",
    reported_region: "Regional original",
    orders_to_scan: 100,
    orders_unscanned_at_receipt: 10,
    rate_unscanned_at_receipt: "0.1000000000",
    orders_unscanned_for_delivery: 7,
    rate_unscanned_for_delivery: "0.0700000000",
    overall_unscanned_rate: "0.1700000000",
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

function makeFetcher(records: PddCollectionFailureV2Record[], options: { publicationIds?: string[] } = {}) {
  const recordRequests: URL[] = [];
  const metadataRequests = { publications: 0, dates: 0 };
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    requestSignals.push(init?.signal);
    const url = new URL(path, "http://local.test");
    const dateFrom = url.searchParams.get("date_from") ?? "0000-01-01";
    const dateTo = url.searchParams.get("date_to") ?? "9999-12-31";
    const periodRecords = records.filter((record) => {
      const date = String(record.data_date).slice(0, 10);
      return date >= dateFrom && date <= dateTo;
    });
    if (url.pathname.endsWith("/publications")) {
      const callIndex = metadataRequests.publications++;
      return jsonResponse({
        sourceId: PDD_COLLECTION_FAILURE_V2_SOURCE_ID,
        publications: [{
          publicationId: options.publicationIds?.[callIndex] ?? PUBLICATION_ID,
          version: 1,
          publishedAt: "2026-10-06T13:20:00Z",
          visibleRowCount: records.length,
        }],
        total: 1,
        limit: 1,
        offset: 0,
      });
    }
    if (url.pathname.endsWith("/dates")) {
      metadataRequests.dates += 1;
      const counts = new Map<string, number>();
      for (const record of periodRecords) {
        const date = String(record.data_date).slice(0, 10);
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
      return jsonResponse({
        sourceId: PDD_COLLECTION_FAILURE_V2_SOURCE_ID,
        dates: [...counts].map(([date, rowCount]) => ({ date, rowCount })),
      });
    }
    if (url.pathname.endsWith("/records")) {
      recordRequests.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        sourceId: PDD_COLLECTION_FAILURE_V2_SOURCE_ID,
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

test("preserva o contrato de 11 campos, os códigos e os registros sem mapeamento", async () => {
  const { fetcher } = makeFetcher([pddRecord(2, "2026-10-05")]);
  const published = await loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, fetcher);

  assert.equal(PDD_COLLECTION_FAILURE_V2_SOURCE_ID, "pdd_collection_failure");
  assert.equal(PDD_COLLECTION_FAILURE_V2_COLUMNS.length, 11);
  assert.equal(published.columnCount, 11);
  assert.equal(published.rowCount, 1);
  assert.equal(published.publicationId, PUBLICATION_ID);
  assert.deepEqual(published.publicationIds, [PUBLICATION_ID]);
  assert.equal(published.updatedAt, "2026-10-06T13:20:00Z");
  assert.equal(published.records[0].source_base_code, "000123");
  assert.equal(published.records[0].source_region_code, "0004");
  assert.equal(published.records[0].source_base_name, "Base sem vínculo");
  assert.equal(published.records[0].reported_region, "Regional original");
  assert.equal(published.records[0].mapping_resolution, "UNMAPPED");
  assert.equal(published.records[0].resolved_base_code, null);
  assert.equal(published.records[0].rate_unscanned_at_receipt, "0.1000000000");
  assert.equal(published.period.dateFrom, "2026-10-05");
  assert.equal(published.period.dateTo, "2026-10-05");
});

test("busca somente as datas solicitadas com paginação de até 250 e confere todas as linhas", async () => {
  const sourceRecords = Array.from({ length: 1617 }, (_, index) => pddRecord(
    index + 2,
    `2026-10-${String((index % 5) + 1).padStart(2, "0")}`,
  ));
  const { fetcher, recordRequests, metadataRequests } = makeFetcher(sourceRecords);
  const published = await loadPublishedPddCollectionFailure({ dateFrom: "2026-10-01", dateTo: "2026-10-05" }, fetcher);

  assert.equal(published.rowCount, 1617);
  assert.equal(new Set(published.records.map((record) => `${record.publication_id}:${record.source_row_no}`)).size, 1617);
  assert.deepEqual(recordRequests.map((url) => Number(url.searchParams.get("offset"))), [0, 250, 500, 750, 1000, 1250, 1500]);
  assert.equal(recordRequests.every((url) =>
    url.pathname === `/api/v2/data-sources/${PDD_COLLECTION_FAILURE_V2_SOURCE_ID}/records` &&
    url.searchParams.get("date_from") === "2026-10-01" &&
    url.searchParams.get("date_to") === "2026-10-05" &&
    Number(url.searchParams.get("limit")) <= PDD_COLLECTION_FAILURE_V2_PAGE_SIZE &&
    !url.searchParams.has("publication_id")), true);
  assert.deepEqual(metadataRequests, { publications: 2, dates: 2 });

  const oneDay = makeFetcher(sourceRecords);
  const selected = await loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, oneDay.fetcher);
  assert.equal(selected.rowCount, 323);
  assert.equal(oneDay.recordRequests.every((url) =>
    url.searchParams.get("date_from") === "2026-10-05" && url.searchParams.get("date_to") === "2026-10-05"), true);
});

test("não solicita páginas quando o período selecionado não possui registros", async () => {
  const { fetcher, recordRequests } = makeFetcher([pddRecord(2, "2026-10-05")]);
  const empty = await loadPublishedPddCollectionFailure({ dateFrom: "2026-10-04", dateTo: "2026-10-04" }, fetcher);
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.records.length, 0);
  assert.equal(empty.publicationId, PUBLICATION_ID);
  assert.equal(recordRequests.length, 0);
});

test("recusa mudança de publicação, linhas duplicadas e resposta incompatível com o contrato", async () => {
  const changedPublication = makeFetcher([pddRecord(2, "2026-10-05")], {
    publicationIds: [PUBLICATION_ID, "new-publication"],
  });
  await assert.rejects(
    loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, changedPublication.fetcher),
    (error: unknown) => error instanceof PddCollectionFailureV2LoadError && error.kind === "inconsistent",
  );

  const duplicateRows = makeFetcher([pddRecord(2, "2026-10-05"), pddRecord(2, "2026-10-05")]);
  await assert.rejects(
    loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, duplicateRows.fetcher),
    (error: unknown) => error instanceof PddCollectionFailureV2LoadError && error.kind === "invalid_data",
  );

  const missingColumn = pddRecord(2, "2026-10-05");
  delete (missingColumn as Partial<PddCollectionFailureV2Record>).overall_unscanned_rate;
  const invalidResponse = makeFetcher([missingColumn]);
  await assert.rejects(
    loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, invalidResponse.fetcher),
    (error: unknown) => error instanceof PddCollectionFailureV2LoadError && error.kind === "invalid_data",
  );
});

test("rejeita intervalos inválidos e propaga cancelamento da consulta", async () => {
  const { fetcher, requestSignals } = makeFetcher([pddRecord(2, "2026-10-05")]);
  await assert.rejects(
    loadPublishedPddCollectionFailure({ dateFrom: "2026-10-06", dateTo: "2026-10-05" }, fetcher),
    (error: unknown) => error instanceof PddCollectionFailureV2LoadError && error.kind === "invalid_data",
  );

  const controller = new AbortController();
  await loadPublishedPddCollectionFailure({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, fetcher, controller.signal);
  assert.equal(requestSignals.length, 5);
  assert.equal(requestSignals.every((signal) => signal === controller.signal), true);
});
