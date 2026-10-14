import assert from "node:assert/strict";
import test from "node:test";

import {
  loadCurrentNoMovementSnapshot,
  NO_MOVEMENT_V2_COLUMNS,
  NO_MOVEMENT_V2_PAGE_SIZE,
  NO_MOVEMENT_V2_SOURCE_ID,
  NoMovementV2LoadError,
  type NoMovementV2Record,
} from "../src/lib/data-foundation/no-movement.ts";

const PUBLICATION_ID = "no-movement-publication-v1";

function noMovementRecord(sourceRowNo: number, overrides: Partial<NoMovementV2Record> = {}): NoMovementV2Record {
  return {
    reported_region: "Regional original",
    source_base_code: "000123",
    source_base_name: "Base sem vínculo",
    stopped_orders: 120,
    orders_in_transit: 90,
    stopped_over_1_day: 80,
    stopped_over_2_days: 70,
    stopped_over_3_days: 60,
    stopped_over_4_days: 50,
    stopped_over_5_days: 40,
    stopped_over_6_days: 30,
    stopped_over_7_days: 20,
    stopped_over_10_days: 10,
    stopped_over_14_days: 8,
    stopped_over_30_days: 2,
    last_operation_at: "2026-10-06T10:20:00",
    stopped_14_plus_days_rate: "0.0666666666666667",
    stopped_30_plus_days_rate: "0.0166666666666667",
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
  records: NoMovementV2Record[],
  options: { publicationIds?: string[]; noPublication?: boolean; contractVersion?: number } = {},
) {
  const recordRequests: URL[] = [];
  const metadataRequests = { publications: 0, snapshotCounts: 0 };
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    requestSignals.push(init?.signal);
    const url = new URL(path, "http://local.test");
    if (url.pathname.endsWith("/publications")) {
      const callIndex = metadataRequests.publications++;
      const hasPublication = !options.noPublication;
      const publicationId = options.publicationIds?.[callIndex] ?? PUBLICATION_ID;
      return jsonResponse({
        sourceId: NO_MOVEMENT_V2_SOURCE_ID,
        publications: hasPublication ? [{
          publicationId,
          version: 1,
          contractVersion: options.contractVersion ?? 2,
          publishedAt: "2026-10-06T13:20:00Z",
          snapshotAsOf: "2026-10-06T13:15:00Z",
          periodStart: "2026-10-06",
          periodEnd: "2026-10-06",
          visibleRowCount: records.length,
        }] : [],
        total: hasPublication ? 1 : 0,
        limit: 1,
        offset: 0,
      });
    }
    if (url.pathname.endsWith("/dates")) {
      metadataRequests.snapshotCounts += 1;
      return jsonResponse({ sourceId: NO_MOVEMENT_V2_SOURCE_ID, dates: [], snapshotRowCount: records.length });
    }
    if (url.pathname.endsWith("/records")) {
      recordRequests.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        sourceId: NO_MOVEMENT_V2_SOURCE_ID,
        records: records.slice(offset, offset + limit),
        total: records.length,
        limit,
        offset,
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetcher, recordRequests, metadataRequests, requestSignals };
}

test("usa o contrato oficial de 18 colunas e preserva base, regional, dados sem vínculo e publicação", async () => {
  const { fetcher } = makeFetcher(Array.from({ length: 151 }, (_, index) => noMovementRecord(index + 2)));
  const snapshot = await loadCurrentNoMovementSnapshot(fetcher);

  assert.equal(NO_MOVEMENT_V2_SOURCE_ID, "no_movement");
  assert.equal(NO_MOVEMENT_V2_COLUMNS.length, 18);
  assert.equal(snapshot.columnCount, 18);
  assert.equal(snapshot.rowCount, 151);
  assert.equal(snapshot.records.length, 151);
  assert.equal(snapshot.publicationId, PUBLICATION_ID);
  assert.equal(snapshot.publishedAt, "2026-10-06T13:20:00Z");
  assert.equal(snapshot.updatedAt, "2026-10-06T13:15:00Z");
  assert.equal(snapshot.collectionDate, "2026-10-06");
  assert.equal(snapshot.records[0].reported_region, "Regional original");
  assert.equal(snapshot.records[0].source_base_code, "000123");
  assert.equal(snapshot.records[0].source_base_name, "Base sem vínculo");
  assert.equal(snapshot.records[0].mapping_resolution, "UNMAPPED");
  assert.equal(snapshot.records[0].resolved_base_code, null);
  assert.equal(snapshot.records[0].stopped_14_plus_days_rate, "0.0666666666666667");
});

test("pagina somente o snapshot vigente em lotes de até 250, sem pedir períodos nem versões históricas", async () => {
  const records = Array.from({ length: 501 }, (_, index) => noMovementRecord(index + 2));
  const { fetcher, recordRequests, metadataRequests } = makeFetcher(records);
  const snapshot = await loadCurrentNoMovementSnapshot(fetcher);

  assert.equal(snapshot.rowCount, 501);
  assert.equal(new Set(snapshot.records.map((record) => `${record.publication_id}:${record.source_row_no}`)).size, 501);
  assert.deepEqual(recordRequests.map((url) => Number(url.searchParams.get("offset"))), [0, 250, 500]);
  assert.equal(recordRequests.every((url) =>
    url.pathname === `/api/v2/data-sources/${NO_MOVEMENT_V2_SOURCE_ID}/records` &&
    Number(url.searchParams.get("limit")) <= NO_MOVEMENT_V2_PAGE_SIZE &&
    !url.searchParams.has("publication_id") &&
    !url.searchParams.has("date_from") &&
    !url.searchParams.has("date_to")), true);
  assert.equal(metadataRequests.publications, 2);
  assert.equal(metadataRequests.snapshotCounts, 2);
});

test("recusa publicação que mude enquanto o snapshot está sendo lido", async () => {
  const { fetcher } = makeFetcher([noMovementRecord(2)], { publicationIds: [PUBLICATION_ID, "new-publication"] });
  await assert.rejects(
    loadCurrentNoMovementSnapshot(fetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "inconsistent",
  );
});

test("recusa linhas duplicadas e incompatíveis com o contrato", async () => {
  const duplicated = makeFetcher([noMovementRecord(2), noMovementRecord(2)]);
  await assert.rejects(
    loadCurrentNoMovementSnapshot(duplicated.fetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "invalid_data",
  );

  const missingColumn = noMovementRecord(2);
  delete (missingColumn as Partial<NoMovementV2Record>).stopped_orders;
  const invalid = makeFetcher([missingColumn]);
  await assert.rejects(
    loadCurrentNoMovementSnapshot(invalid.fetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "invalid_data",
  );
});

test("distingue uma fonte sem publicação e propaga cancelamento da consulta", async () => {
  const missingPublication = makeFetcher([], { noPublication: true });
  await assert.rejects(
    loadCurrentNoMovementSnapshot(missingPublication.fetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "empty",
  );

  const controller = new AbortController();
  const { fetcher, requestSignals } = makeFetcher([noMovementRecord(2)]);
  await loadCurrentNoMovementSnapshot(fetcher, controller.signal);
  assert.equal(requestSignals.length, 5);
  assert.equal(requestSignals.every((signal) => signal === controller.signal), true);
});

test("não interpreta a publicação V1 preservada como snapshot V2", async () => {
  const { fetcher, recordRequests } = makeFetcher([noMovementRecord(2)], { contractVersion: 1 });

  await assert.rejects(
    loadCurrentNoMovementSnapshot(fetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "incompatible",
  );
  assert.equal(recordRequests.length, 0);
});

test("recusa metadados sem identificação verificável da versão do contrato", async () => {
  const { fetcher } = makeFetcher([noMovementRecord(2)], { contractVersion: undefined });
  const missingVersionFetcher = async (path: string, init?: RequestInit) => {
    const response = await fetcher(path, init);
    const url = new URL(path, "http://local.test");
    if (!url.pathname.endsWith("/publications")) return response;
    const body = await response.json() as { publications: Array<Record<string, unknown>> };
    delete body.publications[0]?.contractVersion;
    return jsonResponse(body);
  };

  await assert.rejects(
    loadCurrentNoMovementSnapshot(missingVersionFetcher),
    (error: unknown) => error instanceof NoMovementV2LoadError && error.kind === "incompatible",
  );
});

test("um snapshot V2 válido com zero linhas continua sendo a fonte vigente", async () => {
  const { fetcher } = makeFetcher([]);
  const snapshot = await loadCurrentNoMovementSnapshot(fetcher);

  assert.equal(snapshot.rowCount, 0);
  assert.equal(snapshot.publicationId, PUBLICATION_ID);
});
