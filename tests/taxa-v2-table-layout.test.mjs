import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");

test("Taxa V2 detailed table has a scoped compact horizontal-scroll layout", () => {
  const selector = ".taxa-v2-detail-card .taxa-v2-detail-table";
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table-wrap\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table\s*\{[^}]*min-width:\s*2340px;[^}]*table-layout:\s*fixed/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table thead th\s*\{[^}]*height:\s*48px;[^}]*font-size:\s*11px;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.taxa-v2-detail-card \.taxa-v2-detail-table th:nth-child\(n \+ 10\),[\s\S]*?\.taxa-v2-detail-card \.taxa-v2-detail-table td:nth-child\(n \+ 10\)\s*\{[^}]*text-align:\s*right/s);
  assert.ok(dashboard.includes(`className="dashboard-data-table bipagem-detail-table pdd-v2-detail-table taxa-v2-detail-table"`));
  assert.equal((dashboard.match(/COLLECTION_RATE_V2_COLUMNS\.map\(\(field\) => <td key=\{field\}>/g) ?? []).length > 0, true);
  assert.ok(styles.includes(selector));
});
