import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const collectionRateContract = await readFile(new URL("../src/lib/data-foundation/collection-rate-v2.ts", import.meta.url), "utf8");

test("Taxa V2 detail table follows the J&T compact table layout with scoped sizing", () => {
  const selector = ".taxa-v2-detail-card .taxa-v2-detail-table";
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table-wrap\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table\s*\{[^}]*min-width:\s*3315px;[^}]*table-layout:\s*fixed/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table thead th\s*\{[^}]*height:\s*50px;[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table th:nth-child\(28\),[\s\S]*?\.taxa-v2-detail-card \.taxa-v2-detail-table td:nth-child\(28\)\s*\{[^}]*width:\s*142px/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-v2-summary-table thead th\s*\{[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-filter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.ok(dashboard.includes('view === "taxa" && isAuthorizedDashboardViewer ? "dashboard-main dashboard-main-taxa-v2"'));
  assert.ok(dashboard.includes("taxa-v2-export-button"));
  assert.ok(styles.includes('html[data-theme="dark"] .dashboard-main-taxa-v2 .taxa-v2-detail-table tbody tr:nth-child(even)'));
  assert.ok(styles.includes(selector));
});

test("Taxa V2 keeps all 28 official columns ordered and rendered from the source list", () => {
  const declaration = collectionRateContract.match(/export const COLLECTION_RATE_V2_COLUMNS = \[([\s\S]*?)\] as const;/);
  assert.ok(declaration, "official Taxa V2 column list exists");
  const columns = [...declaration[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(columns.length, 28);
  assert.equal(new Set(columns).size, 28);
  assert.ok(dashboard.includes("COLLECTION_RATE_V2_COLUMNS.map((field) => <th key={field}>"));
  assert.ok(dashboard.includes("COLLECTION_RATE_V2_COLUMNS.map((field) => <td key={field}>"));
});
