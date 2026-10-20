import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dashboardCards } from "../src/features/dashboards/dashboard-catalog.ts";
import {
  DASHBOARD_V2_SOURCE_BY_PANEL,
  dashboardCardsForCategory,
  loadDashboardSourceAvailability,
} from "../src/features/dashboards/dashboard-availability.ts";

test("First Mile lists only the five dashboards connected to official V2 sources", () => {
  const cards = dashboardCardsForCategory("first-mile");

  assert.deepEqual(
    cards.map(({ id }) => id),
    ["monitoramento", "taxa", "sellers", "movimentacao", "bipagem"],
  );
  assert.deepEqual(Object.values(DASHBOARD_V2_SOURCE_BY_PANEL), [
    "collection_monitoring",
    "collection_rate",
    "jt_monitoring",
    "no_movement",
    "pdd_collection_failure",
  ]);
});

test("hiding unconnected First Mile cards does not change categories or global routes", () => {
  const hiddenFirstMileIds = ["epop", "damage"];
  const allCards = dashboardCards.map(({ id, category }) => ({ id, category }));
  const lastMileBefore = allCards.filter(({ category }) => category === "last-mile").map(({ id }) => id);
  const lastMileAfter = dashboardCardsForCategory("last-mile").map(({ id }) => id);

  for (const id of hiddenFirstMileIds) {
    assert.ok(dashboardCards.some((card) => card.id === id && card.category === "first-mile"));
    assert.ok(!dashboardCardsForCategory("first-mile").some((card) => card.id === id));
  }
  assert.deepEqual(lastMileAfter, lastMileBefore);
});

test("dashboard availability checks only the latest publication metadata for each official source", async () => {
  for (const [panelId, sourceId] of Object.entries(DASHBOARD_V2_SOURCE_BY_PANEL)) {
    let requestedPath = "";
    let requestedInit: RequestInit | undefined;
    const result = await loadDashboardSourceAvailability(
      panelId as keyof typeof DASHBOARD_V2_SOURCE_BY_PANEL,
      async (path, init) => {
        requestedPath = path;
        requestedInit = init;
        return Response.json({
          sourceId,
          total: 3,
          publications: [{
            publicationId: "publication-id",
            version: 2,
            publishedAt: "2026-10-05T12:00:00Z",
            visibleRowCount: 151,
            periodStart: sourceId === "no_movement" ? null : "2026-10-05",
            periodEnd: sourceId === "no_movement" ? null : "2026-10-05",
          }],
          limit: 1,
          offset: 0,
        });
      },
    );

    const contractVersion = sourceId === "collection_rate" ? 3 : ["no_movement", "pdd_collection_failure"].includes(sourceId) ? 2 : 1;
    assert.equal(requestedPath, `/api/v2/data-sources/${sourceId}/publications?contract_version=${contractVersion}&limit=1&offset=0`);
    assert.equal(requestedInit?.method, "GET");
    assert.equal(requestedInit?.cache, "no-store");
    assert.equal(result?.status, "available");
    assert.equal(result?.rowCount, 151);
    assert.equal(result?.publicationId, "publication-id");
  }
});

test("dashboard availability reports no publication distinctly and does not request records", async () => {
  const result = await loadDashboardSourceAvailability("monitoramento", async () => Response.json({
    sourceId: "collection_monitoring",
    total: 0,
    publications: [],
    limit: 1,
    offset: 0,
  }));

  assert.deepEqual(result, {
    sourceId: "collection_monitoring",
    status: "unpublished",
    publicationId: null,
    publishedAt: null,
    rowCount: null,
    periodStart: null,
    periodEnd: null,
  });
});

test("dashboard availability keeps authorization and connection failures distinct", async () => {
  await assert.rejects(
    loadDashboardSourceAvailability("taxa", async () => new Response(null, { status: 403 })),
    /restricted/,
  );
  await assert.rejects(
    loadDashboardSourceAvailability("taxa", async () => new Response(null, { status: 503 })),
    /unavailable/,
  );
});

test("Taxa V3 renders its published dashboard while unfinished First Mile panels remain in review", async () => {
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const loader = await readFile(new URL("../src/features/dashboards/dashboard-availability.ts", import.meta.url), "utf8");

  assert.match(source, /isFirstMileUnderReview && view !== "monitoramento" && view !== "movimentacao" && view !== "bipagem" && view !== "taxa" \? \(/);
  assert.match(source, /className=\{view === "home" \? "dashboard-main dashboard-main-presentation-home" : isFirstMileUnderReview && view !== "monitoramento" && view !== "movimentacao" && view !== "bipagem" && view !== "taxa" \? "dashboard-main dashboard-main-under-development"/);
  assert.match(source, /if \(view !== "taxa"\) return undefined;\s+if \(!viewerAuthorization/);
  assert.match(source, /loadPublishedCollectionRateV3\(/);
  assert.match(source, /Fonte operacional: exportação mensal oficial do JMS/);
  assert.match(source, /currentDashboardAvailability\.status === "unavailable"/);
  assert.match(source, /collectionRateV2State\.error \?\? "Sem dados publicados para a data selecionada"/);
  assert.match(source, /\) : view === "taxa" \? \(\s+isAuthorizedDashboardViewer \? \(/);
  assert.match(source, /data-testid="taxa-v2-kpi-grid"/);
  assert.match(source, /label=\{t\("Taxa com tentativa"\)\} value=\{formatTaxaRate\(taxaV2AttemptRate\.rate\)\}/);
  assert.match(source, /label=\{t\("Aguardando coleta"\)\} value=\{formatCompact\(taxaV2Summary\.notCollected\)\}/);
  assert.match(source, /summarizeCollectionRateV3Cards\(taxaV2FilteredRows\)/);
  assert.match(source, /view === "home" \|\| view === "data-foundation" \|\| isFirstMileUnderReview/);
  assert.match(source, /const isFirstMileUnderReview = Object\.hasOwn\(DASHBOARD_V2_SOURCE_BY_PANEL, view\)/);
  assert.match(source, /if \(view !== "movimentacao"\) return undefined/);
  assert.match(source, /if \(view !== "bipagem"\) return undefined/);
  assert.match(source, /loadPublishedPddCollectionFailure\(/);
  assert.match(source, /<PddCollectionFailureV2Dashboard/);
  assert.match(loader, /\/publications\?contract_version=\$\{contractVersion\}&limit=1&offset=0/);
  assert.doesNotMatch(loader, /\/records|export\.csv/);
});
test("Sem Movimentação abre o dashboard V2 oficial e nunca consulta uma fonte legada", async () => {
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../src/lib/data-foundation/no-movement-dashboard.ts", import.meta.url), "utf8");

  assert.match(source, /data-testid=\{view === "movimentacao" \? "no-movement-v2-dashboard"/);
  assert.match(source, /loadCurrentNoMovementSnapshot\(/);
  assert.match(source, /noMovementV2State\.status === "error" && noMovementV2State\.error/);
  assert.match(source, /noMovementHasPublishedRecords \? formatCompact\(movementSummary\.totalStopped\) : "—"/);
  assert.match(adapter, /Aguardando primeira importação/);
  assert.match(source, /"Total sem movimentação"/);
  assert.match(source, /"Pedidos em trânsito"/);
  assert.match(source, /"Acima de 2 dias"/);
  assert.match(source, /"Bases críticas"/);
  assert.match(source, /"Acima de 14 dias"/);
  assert.match(source, /"Acima de 30 dias"/);
  assert.match(source, /"Total de regionais"/);
  assert.match(source, /"Regional mais crítica"/);
  assert.match(source, /"Sem movimentação por regional"/);
  assert.match(source, /"Sem movimentação por RM"/);
  assert.match(source, /"Dados por base"/);
  assert.match(source, /Todas as 18 colunas do contrato oficial/);
  assert.match(source, /disabled=\{!noMovementHasPublishedRecords\}/);
  assert.doesNotMatch(source, /getMovementSource\(|selectNoMovementSource|noMovementFallback|movementFallbackNotice/);
  assert.doesNotMatch(adapter, /LEGACY|selectNoMovementSource|fallback/i);
});
