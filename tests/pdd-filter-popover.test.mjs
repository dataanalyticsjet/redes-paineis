import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardSource = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");

test("PDD V2 filter popovers escape only their card and remain usable on mobile", () => {
  assert.match(dashboardSource, /className="filters-card bipagem-filters-card pdd-v2-filters-card"/);
  assert.match(dashboardSource, /<MultiSelect label=\{t\("Regional"\)\}/);
  assert.match(dashboardSource, /<MultiSelect label="RM"/);
  assert.match(dashboardSource, /<MultiSelect label="RGM"/);
  assert.match(dashboardSource, /<MultiSelect label=\{t\("Base"\)\}/);
  assert.match(dashboardSource, /id="pdd-v2-date-start" type="date"/);
  assert.match(dashboardSource, /id="pdd-v2-date-end" type="date"/);
  assert.match(dashboardSource, /<MultiSelect label=\{t\("Origem do pedido"\)\}/);
  assert.match(dashboardSource, /onClick=\{clearFilters\}/);
  assert.match(dashboardSource, /const clearFilters = \(\) => \{[\s\S]*?setSelectedOrigins\(null\);[\s\S]*?\};/);

  assert.match(styles, /section\.filters-card\.pdd-v2-filters-card:not\(\.upload-ready-card\)\s*\{\s*overflow: visible;/);
  assert.match(styles, /\.pdd-v2-filters-card \.multi-select\[open\]\s*\{\s*z-index: 110;/);
  assert.match(styles, /\.pdd-v2-filters-card \.filter-grid > \.filter-field:last-child \.multi-select-popover\s*\{\s*right: 0;\s*left: 0;\s*width: 100%;\s*max-width: 100%;/);
  assert.match(styles, /\.multi-select-popover\s*\{[\s\S]*?max-height: min\(72dvh, 520px\);\s*overflow: auto;/);
  assert.match(styles, /\.menu-options\s*\{[\s\S]*?max-height: 48dvh;[\s\S]*?overflow: auto;/);
});
