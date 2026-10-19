import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptMonitoringV2Records,
  canReadDashboardV2Data,
  canReadMonitoringV2,
  loadPublishedMonitoringWorkbook,
  MonitoringV2LoadError,
  type MonitoringV2Record,
  yesterdayInSaoPaulo,
} from "../src/lib/data-foundation/monitoring.ts";

const PUBLICATION_ID = "publication-current";

function monitoringRecord(sourceRowNo: number, overrides: Partial<MonitoringV2Record> = {}): MonitoringV2Record {
  return {
    data_date: "2026-10-01",
    reported_region: "Regional Norte",
    source_base_name: "Base sem vínculo",
    seller_collection_rate: "0.8750",
    collection_visit_rate: null,
    expected_dropoff_collection: 4,
    expected_pickup_collection: 6,
    awaiting_collection_dropoff: 2,
    awaiting_collection_pickup: 1,
    collected_current: 3,
    received_at_base_current: 2,
    dispatched_by_base: 1,
    in_transit_from_base: 1,
    branch_outbound_transit_center: 1,
    branch_outbound_transit_sorting: 0,
    arrived_at_sorting_center: 1,
    dispatched_by_sorting_center: 0,
    sorting_outbound_transit: 0,
    arrived_at_sc: 0,
    package_created_by_base: 0,
    processed_problem_items: 0,
    unprocessed_problem_items: 0,
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

function makeFetcher(records: MonitoringV2Record[], publicationId = PUBLICATION_ID) {
  const recordRequests: URL[] = [];
  const metadataRequests = { publications: 0, dates: 0 };
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    requestSignals.push(init?.signal);
    const url = new URL(path, "http://local.test");
    const dateFrom = url.searchParams.get("date_from") ?? "0000-01-01";
    const dateTo = url.searchParams.get("date_to") ?? "9999-12-31";
    const periodRecords = records.filter((record) => String(record.data_date) >= dateFrom && String(record.data_date) <= dateTo);
    if (url.pathname.endsWith("/publications")) {
      metadataRequests.publications += 1;
      return jsonResponse({
        sourceId: "collection_monitoring",
        publications: [{
          publicationId,
          version: 1,
          publishedAt: "2026-10-06T12:00:00Z",
          visibleRowCount: records.length,
          periodStart: "2026-10-01",
          periodEnd: "2026-10-06",
        }],
        total: 1,
        limit: 1,
        offset: 0,
      });
    }
    if (url.pathname.endsWith("/dates")) {
      const counts = new Map<string, number>();
      for (const record of periodRecords) {
        const date = String(record.data_date);
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
      metadataRequests.dates += 1;
      return jsonResponse({
        sourceId: "collection_monitoring",
        dates: [...counts].map(([date, rowCount]) => ({ date, rowCount })),
      });
    }
    if (url.pathname.endsWith("/records")) {
      recordRequests.push(url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        sourceId: "collection_monitoring",
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

test("ferramentas administrativas de matriz continuam limitadas a ADMIN/matrix", () => {
  assert.equal(canReadMonitoringV2({ platform_role: "ADMIN", administrative_scope: "matrix", organizational_scope: "regional", role: "regional" }), true);
  assert.equal(canReadMonitoringV2({ platform_role: "USER", administrative_scope: "matrix", organizational_scope: "matrix", role: "matrix" }), false);
  assert.equal(canReadMonitoringV2({ platform_role: "ADMIN", administrative_scope: "base", organizational_scope: "matrix", role: "matrix" }), false);
  assert.equal(canReadMonitoringV2({ platform_role: "ADMIN", administrative_scope: "regional", organizational_scope: "regional", role: "regional" }), false);
  assert.equal(canReadMonitoringV2(null), false);
});

test("consulta V2 aceita qualquer perfil com escopo regional, base ou matriz válido", () => {
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "regional",
    role: "regional",
    home_region: "SPE",
  }), true);
  assert.equal(canReadDashboardV2Data({
    platform_role: "ADMIN",
    organizational_scope: "regional",
    role: "regional",
    effective_regions: ["SPE"],
  }), true);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "base",
    role: "regional",
    home_base: "311197",
  }), true);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "matrix",
    role: "matrix",
  }), true);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "matrix",
    role: "matrix",
    region_resolution_status: "SYNC_FAILED",
    data_scope_source: "none",
  }), false);
  assert.equal(canReadDashboardV2Data({
    platform_role: "ADMIN",
    organizational_scope: "regional",
    role: "regional",
    home_region: "MATRIZ",
    effective_regions: ["MATRIZ"],
    region_resolution_status: "SYNC_FAILED",
    data_scope_source: "feishu",
  }), false);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "base",
    role: "regional",
    home_base: "base-001",
    effective_regions: [],
    region_resolution_status: "SYNC_FAILED",
    data_scope_source: "admin_grant",
  }), false);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "regional",
    role: "regional",
    effective_regions: ["CE"],
    region_resolution_status: "SYNC_FAILED",
    data_scope_source: "admin_grant",
  }), true);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "unknown",
    role: "unknown",
  }), false);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "regional",
    role: "regional",
  }), false);
  assert.equal(canReadDashboardV2Data({
    platform_role: "USER",
    organizational_scope: "matrix",
    role: "matrix",
    is_active: false,
  }), false);
});

test("adaptador preserva os 22 campos, taxas nulas, dados originais e estado sem vínculo", () => {
  const parsed = adaptMonitoringV2Records([monitoringRecord(2)]);

  assert.equal(parsed.headers.length, 22);
  assert.equal(parsed.metadata.columnCount, 22);
  assert.equal(parsed.rows[0]["Regional Origem"], "Sem regional");
  assert.equal(parsed.rows[0]["PDD de saida"], "Base sem vínculo");
  assert.equal(parsed.rows[0]["Taxa de coleta do vendedor"], 0.875);
  assert.equal(parsed.rows[0]["Taxa de Visita de Coleta"], null);
  assert.equal(parsed.rows[0]["Coleta Prevista Drop-off"], 4);
  assert.equal(parsed.rows[0]["Coleta Prevista Pick-up"], 6);
  assert.equal(parsed.rows[0]["Aguardando Coleta Drop-off"], 2);
  assert.equal(parsed.rows[0]["Aguardando Coleta Pick-up"], 1);
  assert.equal(parsed.rows[0].__sourceRowNo, 2);
  assert.equal(parsed.rows[0].__resolvedBaseCode, null);
  assert.equal(parsed.rows[0].__mappingResolution, "UNMAPPED");
  assert.equal(parsed.rows[0].__mappedRegion, null);
  assert.equal(parsed.rows[0].__reportedRegion, "Regional Norte");
  assert.equal(parsed.rows[0].__effectiveRm, "Sem RM");
  assert.equal(parsed.originColumn, undefined);
  assert.equal(parsed.metadata.dateRange?.min, "2026-10-01");
  assert.equal(parsed.metadata.dateRange?.max, "2026-10-01");
});

test("classifica um registro aprovado por código como SR sem apagar a regional original", () => {
  const parsed = adaptMonitoringV2Records([monitoringRecord(2, {
    reported_region: "PR",
    resolved_base_code: "RS-001",
    mapping_resolution: "NAME_APPROVED",
    mapped_base_name: "Base Rio RS",
    mapped_region: "SR",
    mapped_uf: "RS",
    mapped_rm_area: "SR-RS",
    mapped_rm: " 周正军   Zhengjun Zhou (Victor) ",
  })]);
  const row = parsed.rows[0];
  assert.equal(row["Regional Origem"], "SR");
  assert.equal(row.__reportedRegion, "PR");
  assert.equal(row.__effectiveUf, "RS");
  assert.equal(row.__effectiveRmArea, "SR-RS");
  assert.equal(row.__effectiveRm, "周正军 Zhengjun Zhou (Victor)");
  assert.equal(row.__effectiveRgm, "董文彤 WENTONG DONG (Winta)");
});

test("usa a resolução efetiva do mapa e preserva estado e regional originais", () => {
  const parsed = adaptMonitoringV2Records([monitoringRecord(2, {
    reported_region: "PR",
    resolved_base_code: null,
    mapping_resolution: "UNMAPPED",
    effective_base_code: "RS-001",
    effective_mapping_resolution: "NAME_APPROVED",
    mapping_match_method: "APPROVED_NORMALIZED_NAME",
    mapped_base_name: "Base Rio RS",
    mapped_region: "SR",
    mapped_uf: "RS",
    mapped_rm_area: "SR-RS",
    mapped_rm: "周正军 Zhengjun Zhou (Victor)",
  })]);
  const row = parsed.rows[0];
  assert.equal(row["Regional Origem"], "SR");
  assert.equal(row["PDD de saida"], "Base Rio RS");
  assert.equal(row.__effectiveBaseName, "Base Rio RS");
  assert.equal(row.__sourceBaseName, "Base sem vínculo");
  assert.equal(row.__resolvedBaseCode, "RS-001");
  assert.equal(row.__sourceResolvedBaseCode, null);
  assert.equal(row.__mappingResolution, "NAME_APPROVED");
  assert.equal(row.__sourceMappingResolution, "UNMAPPED");
  assert.equal(row.__mappingMatchMethod, "APPROVED_NORMALIZED_NAME");
  assert.equal(row.__reportedRegion, "PR");
  assert.equal(row.__effectiveRmArea, "SR-RS");
  assert.equal(row.__effectiveRgm, "董文彤 WENTONG DONG (Winta)");
});

test("carrega somente o período solicitado em páginas de no máximo 250 sem fixar uma publicação", async () => {
  const sourceRecords = [
    ...Array.from({ length: 250 }, (_, index) => monitoringRecord(index + 2)),
    monitoringRecord(252, { data_date: "2026-10-02" }),
    monitoringRecord(253, { data_date: "2026-10-03" }),
  ];
  // Duplicate values are legitimate; physical source-row identity keeps both rows.
  const { fetcher, recordRequests, metadataRequests } = makeFetcher(sourceRecords);
  const loaded = await loadPublishedMonitoringWorkbook({ dateFrom: "2026-10-01", dateTo: "2026-10-02" }, fetcher);

  assert.equal(loaded.rowCount, 251);
  assert.equal(loaded.parsed.rows.length, 251);
  assert.deepEqual(recordRequests.map((url) => [url.searchParams.get("limit"), url.searchParams.get("offset")]), [
    ["250", "0"],
    ["1", "250"],
  ]);
  assert.equal(recordRequests.every((url) =>
    url.searchParams.get("date_from") === "2026-10-01" &&
    url.searchParams.get("date_to") === "2026-10-02" &&
    !url.searchParams.has("publication_id")), true);
  assert.deepEqual(metadataRequests, { publications: 2, dates: 2 });
  assert.equal(loaded.parsed.rows[250].Data, "2026-10-02");
  assert.equal(loaded.parsed.rows.some((row) => row.Data === "2026-10-03"), false);
});

test("consulta uma data específica e retorna período vazio sem pedir páginas de registros", async () => {
  const sourceRecords = [
    monitoringRecord(2, { data_date: "2026-10-01" }),
    monitoringRecord(3, { data_date: "2026-10-02" }),
  ];
  const { fetcher, recordRequests } = makeFetcher(sourceRecords);
  const selected = await loadPublishedMonitoringWorkbook({ dateFrom: "2026-10-02", dateTo: "2026-10-02" }, fetcher);
  assert.equal(selected.rowCount, 1);
  assert.deepEqual(selected.parsed.rows.map((row) => row.Data), ["2026-10-02"]);

  const emptyFetcher = makeFetcher(sourceRecords);
  const empty = await loadPublishedMonitoringWorkbook(
    { dateFrom: "2026-10-04", dateTo: "2026-10-04" },
    emptyFetcher.fetcher,
  );
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.parsed.rows.length, 0);
  assert.equal(emptyFetcher.recordRequests.length, 0);
  assert.equal(recordRequests.every((url) => url.searchParams.get("date_from") === "2026-10-02"), true);
});

test("propaga o sinal de cancelamento para todas as requisições do período", async () => {
  const controller = new AbortController();
  const { fetcher, requestSignals } = makeFetcher([monitoringRecord(2)]);
  await loadPublishedMonitoringWorkbook(
    { dateFrom: "2026-10-01", dateTo: "2026-10-01" },
    fetcher,
    controller.signal,
  );
  assert.equal(requestSignals.length, 5);
  assert.equal(requestSignals.every((signal) => signal === controller.signal), true);
});

test("calcula D-1 usando o calendário America/Sao_Paulo, inclusive perto da meia-noite UTC", () => {
  assert.equal(yesterdayInSaoPaulo(new Date("2026-10-09T02:30:00.000Z")), "2026-10-07");
  assert.equal(yesterdayInSaoPaulo(new Date("2026-10-09T15:00:00.000Z")), "2026-10-08");
});

test("recusa paginação com identificador físico duplicado", async () => {
  const records = [monitoringRecord(2), monitoringRecord(2)];
  const { fetcher } = makeFetcher(records);

  await assert.rejects(
    loadPublishedMonitoringWorkbook({ dateFrom: "2026-10-01", dateTo: "2026-10-01" }, fetcher),
    (error: unknown) => error instanceof MonitoringV2LoadError && error.kind === "invalid_data",
  );
});

test("recusa datas de calendário inválidas", () => {
  assert.throws(
    () => adaptMonitoringV2Records([monitoringRecord(2, { data_date: "2026-02-31" })]),
    (error: unknown) => error instanceof MonitoringV2LoadError && error.kind === "invalid_data",
  );
});
