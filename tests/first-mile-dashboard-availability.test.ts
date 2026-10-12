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

    assert.equal(requestedPath, `/api/v2/data-sources/${sourceId}/publications?limit=1&offset=0`);
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

test("review presentation preserves the five dashboard routes and the source metadata check", async () => {
  const source = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
  const loader = await readFile(new URL("../src/features/dashboards/dashboard-availability.ts", import.meta.url), "utf8");

  assert.match(source, /isFirstMileUnderReview \? \(/);
  assert.match(source, /<DashboardUnderDevelopment/);
  assert.match(source, /Os indicadores e as fórmulas deste painel estão em revisão/);
  assert.match(source, /view !== "monitoramento" \|\| isFirstMileUnderReview/);
  assert.match(source, /view !== "taxa" \|\| isFirstMileUnderReview/);
  assert.match(source, /view !== "sellers" \|\| isFirstMileUnderReview/);
  assert.match(source, /view !== "movimentacao" \|\| isFirstMileUnderReview/);
  assert.match(source, /view !== "bipagem" \|\| isFirstMileUnderReview/);
  assert.match(loader, /\/publications\?limit=1&offset=0/);
  assert.doesNotMatch(loader, /\/records|export\.csv/);
});
