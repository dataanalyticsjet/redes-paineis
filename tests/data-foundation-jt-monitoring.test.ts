import assert from "node:assert/strict";
import test from "node:test";

import {
  JT_MONITORING_V2_COLUMNS,
  JT_MONITORING_V2_MAX_PREVIEW_ROWS,
  JT_MONITORING_V2_PAGE_SIZE,
  JT_MONITORING_V2_SOURCE_ID,
  JtMonitoringV2LoadError,
  jtMonitoringV2RowIdentity,
  loadJtMonitoringPage,
  type JtMonitoringV2Record,
} from "../src/lib/data-foundation/jt-monitoring.ts";

const PUBLICATION_ID = "jt-monitoring-current-publication";

function jtRecord(sourceRowNo: number, date = "2026-10-06", overrides: Partial<JtMonitoringV2Record> = {}): JtMonitoringV2Record {
  return {
    data_date: date,
    reported_region: "Regional original",
    source_base_name: "Base ainda sem vínculo",
    customer_name: "Cliente original",
    store_name: "Loja original",
    seller_id: "seller-001",
    assigned_driver: "Motorista original",
    order_origin: "Origem original",
    awaiting_collection: 4,
    received_at_dropoff: 3,
    collected: 2,
    received: 2,
    received_at_base: 1,
    in_base_dispatch_flow: 1,
    arrived_at_sc: 0,
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

function makeFetcher(
  counts: Array<{ date: string; rowCount: number }>,
  records: JtMonitoringV2Record[],
  options: { publicationIds?: string[]; changedCountsOnFinalRead?: boolean } = {},
) {
  const recordRequests: URL[] = [];
  const metadataRequests = { publications: 0, dates: 0 };
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    requestSignals.push(init?.signal);
    const url = new URL(path, "http://local.test");
    const dateFrom = url.searchParams.get("date_from") ?? "0000-01-01";
    const dateTo = url.searchParams.get("date_to") ?? "9999-12-31";
    const periodCounts = counts.filter(({ date }) => date >= dateFrom && date <= dateTo);
    const periodRecords = records.filter((record) => {
      const date = String(record.data_date).slice(0, 10);
      return date >= dateFrom && date <= dateTo;
    });

    if (url.pathname.endsWith("/publications")) {
      const callIndex = metadataRequests.publications++;
      return jsonResponse({
        sourceId: JT_MONITORING_V2_SOURCE_ID,
        publications: [{
          publicationId: options.publicationIds?.[callIndex] ?? PUBLICATION_ID,
          version: 1,
          publishedAt: "2026-10-07T02:20:00Z",
          visibleRowCount: 159666,
        }],
        total: 1,
        limit: 1,
        offset: 0,
      });
    }

    if (url.pathname.endsWith("/dates")) {
      const callIndex = metadataRequests.dates++;
      const finalRead = callIndex > 0;
      const finalCounts = options.changedCountsOnFinalRead && finalRead
        ? periodCounts.map((item) => ({ ...item, rowCount: item.rowCount + 1 }))
        : periodCounts;
      return jsonResponse({ sourceId: JT_MONITORING_V2_SOURCE_ID, dates: finalCounts });
    }

    if (url.pathname.endsWith("/records")) {
      recordRequests.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const total = periodCounts.reduce((sum, item) => sum + item.rowCount, 0);
      return jsonResponse({
        sourceId: JT_MONITORING_V2_SOURCE_ID,
        records: periodRecords.slice(offset, offset + limit),
        total,
        limit,
        offset,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetcher, recordRequests, metadataRequests, requestSignals };
}

test("preserva as 15 colunas, dimensões originais e linhas sem mapeamento", async () => {
  const duplicateValues = [jtRecord(2), jtRecord(3)];
  const { fetcher } = makeFetcher([{ date: "2026-10-06", rowCount: 2 }], duplicateValues);
  const page = await loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, fetcher);

  assert.equal(JT_MONITORING_V2_SOURCE_ID, "jt_monitoring");
  assert.equal(JT_MONITORING_V2_COLUMNS.length, 15);
  assert.equal(page.columnCount, 15);
  assert.equal(page.totalAvailable, 2);
  assert.equal(page.records.length, 2);
  assert.equal(page.publicationId, PUBLICATION_ID);
  assert.deepEqual(page.publicationIds, [PUBLICATION_ID]);
  assert.equal(page.period.dateFrom, "2026-10-06");
  assert.equal(page.period.dateTo, "2026-10-06");
  assert.equal(page.records[0].reported_region, "Regional original");
  assert.equal(page.records[0].source_base_name, "Base ainda sem vínculo");
  assert.equal(page.records[0].customer_name, "Cliente original");
  assert.equal(page.records[0].store_name, "Loja original");
  assert.equal(page.records[0].seller_id, "seller-001");
  assert.equal(page.records[0].mapping_resolution, "UNMAPPED");
  assert.equal(page.records[0].resolved_base_code, null);
  assert.notEqual(jtMonitoringV2RowIdentity(duplicateValues[0]), jtMonitoringV2RowIdentity(duplicateValues[1]));
});

test("conta volume diário alto sem iniciar centenas de requisições", async () => {
  const firstPage = Array.from({ length: JT_MONITORING_V2_PAGE_SIZE }, (_, index) => jtRecord(index + 2));
  const { fetcher, recordRequests, metadataRequests } = makeFetcher(
    [{ date: "2026-10-06", rowCount: 159666 }],
    firstPage,
  );
  const page = await loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, fetcher);

  assert.equal(JT_MONITORING_V2_MAX_PREVIEW_ROWS, 1000);
  assert.equal(page.totalAvailable, 159666);
  assert.equal(page.records.length, 250);
  assert.equal(recordRequests.length, 1);
  assert.equal(recordRequests[0].searchParams.get("date_from"), "2026-10-06");
  assert.equal(recordRequests[0].searchParams.get("date_to"), "2026-10-06");
  assert.equal(recordRequests[0].searchParams.get("limit"), "250");
  assert.equal(recordRequests[0].searchParams.has("publication_id"), false);
  assert.deepEqual(metadataRequests, { publications: 2, dates: 2 });
});

test("permite buscar páginas seguintes somente sob solicitação e preserva duplicatas de conteúdo", async () => {
  const sameBusinessRow = Array.from({ length: 501 }, (_, index) => jtRecord(index + 2));
  const { fetcher, recordRequests } = makeFetcher([{ date: "2026-10-06", rowCount: 501 }], sameBusinessRow);
  const page = await loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 250, fetcher);

  assert.equal(page.totalAvailable, 501);
  assert.equal(page.offset, 250);
  assert.equal(page.records.length, 250);
  assert.equal(recordRequests.length, 1);
  assert.equal(recordRequests[0].searchParams.get("offset"), "250");
  assert.equal(new Set(sameBusinessRow.slice(0, 250).map(jtMonitoringV2RowIdentity)).size, 250);
});

test("não solicita linhas quando a data está vazia e detecta mudanças durante a consulta", async () => {
  const empty = makeFetcher([], []);
  const emptyPage = await loadJtMonitoringPage({ dateFrom: "2026-10-09", dateTo: "2026-10-09" }, 0, empty.fetcher);
  assert.equal(emptyPage.totalAvailable, 0);
  assert.equal(emptyPage.records.length, 0);
  assert.equal(empty.recordRequests.length, 0);

  const changedPublication = makeFetcher([{ date: "2026-10-06", rowCount: 1 }], [jtRecord(2)], {
    publicationIds: [PUBLICATION_ID, "new-current-publication"],
  });
  await assert.rejects(
    loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, changedPublication.fetcher),
    (error: unknown) => error instanceof JtMonitoringV2LoadError && error.kind === "inconsistent",
  );

  const changedCounts = makeFetcher([{ date: "2026-10-06", rowCount: 1 }], [jtRecord(2)], { changedCountsOnFinalRead: true });
  await assert.rejects(
    loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, changedCounts.fetcher),
    (error: unknown) => error instanceof JtMonitoringV2LoadError && error.kind === "inconsistent",
  );
});

test("rejeita offsets inválidos, identidades físicas duplicadas e respeita cancelamento", async () => {
  const invalidOffset = makeFetcher([], []);
  await assert.rejects(
    loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 1, invalidOffset.fetcher),
    (error: unknown) => error instanceof JtMonitoringV2LoadError && error.kind === "invalid_data",
  );

  const duplicateIdentity = makeFetcher(
    [{ date: "2026-10-06", rowCount: 2 }],
    [jtRecord(2), jtRecord(2)],
  );
  await assert.rejects(
    loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, duplicateIdentity.fetcher),
    (error: unknown) => error instanceof JtMonitoringV2LoadError && error.kind === "invalid_data",
  );

  const controller = new AbortController();
  const cancellation = makeFetcher([{ date: "2026-10-06", rowCount: 1 }], [jtRecord(2)]);
  await loadJtMonitoringPage({ dateFrom: "2026-10-06", dateTo: "2026-10-06" }, 0, cancellation.fetcher, controller.signal);
  assert.equal(cancellation.requestSignals.length, 5);
  assert.equal(cancellation.requestSignals.every((signal) => signal === controller.signal), true);
});
