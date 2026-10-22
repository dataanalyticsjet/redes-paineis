import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const collectionRateV2Contract = await readFile(new URL("../src/lib/data-foundation/collection-rate-v2.ts", import.meta.url), "utf8");
const collectionRateV3Contract = await readFile(new URL("../src/lib/data-foundation/collection-rate-v3.ts", import.meta.url), "utf8");

test("Taxa V3 detail table follows the compact J&T layout with scoped sizing", () => {
  const selector = ".taxa-v2-detail-card .taxa-v3-detail-table";
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table-wrap\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v3-detail-table\s*\{[^}]*min-width:\s*2920px/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table thead th\s*\{[^}]*height:\s*50px;[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v3-detail-table th:nth-child\(22\),[\s\S]*?\.taxa-v2-detail-card \.taxa-v3-detail-table td:nth-child\(22\)\s*\{[^}]*width:\s*144px/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-v2-summary-table thead th(?:,\s*\.dashboard-main-taxa-v2 \.taxa-v2-detail-table thead th)?\s*\{[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-filter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.ok(dashboard.includes('view === "taxa" && isAuthorizedDashboardViewer ? "dashboard-main dashboard-main-taxa-v2"'));
  assert.ok(dashboard.includes("taxa-v2-export-button"));
  assert.ok(styles.includes('html[data-theme="dark"] .dashboard-main-taxa-v2 .taxa-v2-detail-table tbody tr:nth-child(even)'));
  assert.ok(styles.includes(selector));
});

test("Taxa V3 renders the 22 official columns while preserving the historical V2 contract", () => {
  const v2Declaration = collectionRateV2Contract.match(/export const COLLECTION_RATE_V2_COLUMNS = \[([\s\S]*?)\] as const;/);
  const v3Declaration = collectionRateV3Contract.match(/export const COLLECTION_RATE_V3_COLUMNS = \[([\s\S]*?)\] as const;/);
  assert.ok(v2Declaration, "historical Taxa V2 column list remains available");
  assert.ok(v3Declaration, "official Taxa V3 column list exists");
  const v2Columns = [...v2Declaration[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const v3Columns = [...v3Declaration[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  assert.equal(v2Columns.length, 28);
  assert.equal(v3Columns.length, 22);
  assert.equal(new Set(v3Columns).size, 22);
  assert.ok(dashboard.includes("COLLECTION_RATE_V3_COLUMNS.map((field) => <th key={field}>"));
  assert.ok(dashboard.includes("COLLECTION_RATE_V3_COLUMNS.map((field) => <td key={field}>"));
});


test("Taxa detail shares the regional red header and rounded scroll container without compressing 22 columns", () => {
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-v2-summary-table thead th,\s*\.dashboard-main-taxa-v2 \.taxa-v2-detail-table thead th\s*\{[^}]*position:\s*sticky;[^}]*color:\s*#fff;[^}]*background:\s*var\(--table-header\);[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-v2-summary-table-wrap,\s*\.dashboard-main-taxa-v2 \.taxa-v2-detail-table-wrap\s*\{[^}]*overflow:\s*auto;[^}]*border:\s*1px solid var\(--table-grid\);[^}]*border-radius:\s*12px/s);
  assert.match(styles, /\.dashboard-main-taxa-v2 \.taxa-v2-detail-card \.taxa-v3-detail-table thead th\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere/s);
});
