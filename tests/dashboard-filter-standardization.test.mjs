import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [app, v2, t4t5, noMovementFeishu, operationalFeishu, styles] = await Promise.all([
  read("../src/features/dashboards/dashboard-app.tsx"),
  read("../src/features/dashboards/collection-monitoring-v2.tsx"),
  read("../src/features/dashboards/collection-monitoring-t4-t5.tsx"),
  read("../src/features/dashboards/no-movement-feishu-report-dialog.tsx"),
  read("../src/features/dashboards/operational-feishu-report-dialog.tsx"),
  read("../src/styles/globals.css"),
]);

test("multi-selects coordinate exclusivity within their nearest filter set", () => {
  assert.match(app, /function multiSelectGroup\([\s\S]*?closest\("\[data-filter-group\]"\)[\s\S]*?closest\("\.filter-grid"\)[\s\S]*?closest\("\.filters-card"\)/);
  assert.match(app, /document\.addEventListener\("dashboard-multiselect-open", closeOtherMenus\)/);
  assert.match(app, /detail\?\.group === multiSelectGroup\(current\)[\s\S]*?current\.open = false/);
  assert.match(app, /document\.dispatchEvent\(new CustomEvent\("dashboard-multiselect-open"/);
  assert.doesNotMatch(app, /exclusiveGroup="collection-rate-v3"/);
});

test("multiselect selections and searches keep the current list open", () => {
  assert.match(app, /const toggle = \(option: string\) => \{[\s\S]*?onChange\(next\);[\s\S]*?\};/);
  assert.match(app, /onChange=\{\(\) => toggle\(option\)\}/);
  assert.match(app, /onChange=\{\(event\) => setQuery\(event\.target\.value\)\}/);
  assert.match(app, /onToggle=\{\(event\) => \{[\s\S]*?positionMultiSelectPopover\(current\)[\s\S]*?dashboard-multiselect-open/);
  assert.match(app, /pointerdown", closeOutside, true/);
  assert.match(app, /event\.key === "Escape"[\s\S]*?current\.open = false/);
  const toggleHandler = app.match(/onToggle=\{\(event\) => \{([\s\S]*?)\}\}\s*>/)?.[1] ?? "";
  assert.ok(toggleHandler.length > 0, "the details toggle handler should be present");
  assert.doesNotMatch(toggleHandler, /apiFetch|fetch\(|updateFilter|applyFilters/);
});

test("custom dropdown controls expose expanded state and an explicit popover relationship", () => {
  assert.match(app, /const labelId = useId\(\);[\s\S]*?const selectedId = useId\(\);[\s\S]*?const menuId = useId\(\);/);
  assert.match(app, /aria-expanded=\{isOpen\}[\s\S]*?aria-controls=\{menuId\}[\s\S]*?aria-labelledby=\{`\$\{labelId\} \$\{selectedId\}`\}/);
  assert.match(app, /<div id=\{menuId\} className="multi-select-popover">/);
  assert.match(app, /window\.addEventListener\("resize", repositionOpenMenu\)/);
});

test("multiselect popovers remain below the trigger and clamp height to available space", () => {
  assert.match(app, /const popoverWidth = Math\.min\(Math\.max\(bounds\.width, 320\), Math\.max\(120, window\.innerWidth - 32\)\)/);
  assert.match(app, /element\.dataset\.popoverAlign = fitsLeft \|\| !fitsRight \? "left" : "right"/);
  assert.doesNotMatch(app, /placeAbove|popover-placement/);
  assert.match(app, /const availableBelow = Math\.max\(0, window\.innerHeight - bounds\.bottom - 12\)/);
  assert.match(app, /const maxHeight = Math\.min\(desiredHeight, availableBelow\)/);
  assert.match(app, /dataset\.popoverScrollMode = maxHeight < 220 \? "container" : "options"/);
  assert.match(app, /scrollFilterIntoSpaceBelow\(current\)/);
  assert.match(styles, /section\.filters-card:not\(\.upload-ready-card\):has\(\.multi-select\[open\]\)\s*\{\s*z-index: 125;\s*overflow: visible;/);
  assert.match(styles, /\.multi-select-popover\s*\{[\s\S]*?box-sizing: border-box;[\s\S]*?width: min\(var\(--multi-select-popover-width[\s\S]*?max-height: var\(--multi-select-popover-max-height[\s\S]*?overflow: auto;/);
  assert.match(styles, /\.multi-select\[data-popover-scroll-mode="container"\] \.menu-options\s*\{\s*max-height: none;\s*overflow: visible;/);
  assert.doesNotMatch(styles, /data-popover-placement="top"/);
});

test("dashboard selectors retain their existing visual pattern and Feishu selectors are shared", () => {
  for (const source of [v2, t4t5]) {
    assert.match(source, /operational-filter-select/);
  }
  for (const source of [noMovementFeishu, operationalFeishu]) {
    assert.match(source, /DashboardSingleSelect/);
    assert.match(source, /group: t\("Pessoas"\)/);
    assert.match(source, /group: t\("Grupos nacionais"\)/);
    assert.match(source, /group: t\("Grupos regionais"\)/);
    assert.match(source, /disabled: !item\.available/);
    assert.doesNotMatch(source, /<select\b/);
  }
  assert.match(styles, /\.operational-filter-select[\s\S]*?border: 1px solid #e1e4e9[\s\S]*?background-color: #fff/);
  assert.match(styles, /\.operational-filter-select:focus-visible[\s\S]*?border-color: #d71920/);
  assert.match(styles, /\.collection-monitoring-v2-filter-grid \.collection-monitoring-v2-filter input/);
  assert.match(styles, /\.collection-monitoring-t4-t5-filter-grid input/);
  assert.match(styles, /html\[data-theme="dark"\] \.operational-filter-select/);
  assert.match(styles, /\.menu-option\.selected \{ background: #fff7f7; \}/);
  assert.match(styles, /\.dashboard-single-select-popover\s*\{[\s\S]*?position: fixed;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.dashboard-single-select-group-label/);
});

test("Aging uses the reusable single-select and preserves values and pagination reset", () => {
  const block = app.match(/<DashboardSingleSelect\s+id="movement-metric"[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(block, "the Aging selector should use the shared custom control");
  assert.match(block, /MOVEMENT_SUMMARY_METRICS\.map\(\(\[key, label\]\)/);
  assert.match(block, /onChange=\{\(value\) => \{ setMovementSummaryMetric\(value\); setMovementPage\(1\); \}\}/);
  assert.match(app, /MOVEMENT_SUMMARY_METRICS,/);
});
