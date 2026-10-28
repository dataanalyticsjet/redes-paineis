import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [component, app, noMovementDialog, operationalDialog, styles] = await Promise.all([
  read("../src/features/dashboards/dashboard-single-select.tsx"),
  read("../src/features/dashboards/dashboard-app.tsx"),
  read("../src/features/dashboards/no-movement-feishu-report-dialog.tsx"),
  read("../src/features/dashboards/operational-feishu-report-dialog.tsx"),
  read("../src/styles/globals.css"),
]);

test("shared single-select exposes accessible listbox state and keyboard navigation", () => {
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /aria-controls=\{open \? listId : undefined\}/);
  assert.match(component, /aria-labelledby=\{labelledBy\}/);
  assert.match(component, /role="listbox"/);
  assert.match(component, /role="option"/);
  assert.match(component, /aria-selected=\{option\.value === value\}/);
  assert.match(component, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(component, /event\.key === "Home" \|\| event\.key === "End"/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key === "Tab"/);
  assert.match(component, /event\.shiftKey \? -1 : 1/);
});

test("shared popup is portaled, anchored below, and limited to available viewport height", () => {
  assert.match(component, /createPortal\([\s\S]*?document\.body/);
  assert.match(component, /top: bounds\.bottom \+ 6/);
  assert.match(component, /Math\.min\(bounds\.width, window\.innerWidth - 16\)/);
  assert.match(component, /Math\.min\(320, window\.innerHeight - bounds\.bottom - 10\)/);
  assert.match(styles, /\.dashboard-single-select-popover\s*\{[\s\S]*?position: fixed;[\s\S]*?overflow-y: auto;/);
  assert.match(component, /scrollForMenu\(triggerRef\.current, 260\)/);
  assert.match(styles, /\.dashboard-single-select-popover\s*\{[\s\S]*?overflow-y: auto;/);
  assert.doesNotMatch(component, /placeAbove|flip\(|data-popover-placement/);
});

test("single-selects coordinate exclusive opening within their own form or modal", () => {
  assert.match(component, /document\.dispatchEvent\(new CustomEvent\("dashboard-multiselect-open"/);
  assert.match(component, /detail\?\.group === filterGroup\(current\)/);
  assert.match(component, /closest\("\.feishu-share-dialog"\)/);
  assert.match(component, /detailsRef\.current\.open = false/);
  assert.match(component, /pointerdown", closeOutside, true/);
  assert.match(component, /detailsRef\.current\.open = false/);
});

test("Aging preserves the source options and original state update", () => {
  const selector = app.match(/<DashboardSingleSelect\s+id="movement-metric"[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(selector);
  assert.match(selector, /MOVEMENT_SUMMARY_METRICS\.map\(\(\[key, label\]\)/);
  assert.match(selector, /setMovementSummaryMetric\(value\)/);
  assert.match(selector, /setMovementPage\(1\)/);
  assert.doesNotMatch(app, /<select[^>]*id="movement-metric"/);
});

test("Feishu modals use only server-returned grouped options and keep unavailable recipients disabled", () => {
  for (const dialog of [noMovementDialog, operationalDialog]) {
    assert.match(dialog, /DashboardSingleSelect id="[^"]+-feishu-region"/);
    assert.match(dialog, /DashboardSingleSelect id="[^"]+-feishu-recipient"/);
    assert.match(dialog, /group: t\("Pessoas"\)/);
    assert.match(dialog, /group: t\("Grupos nacionais"\)/);
    assert.match(dialog, /group: t\("Grupos regionais"\)/);
    assert.match(dialog, /disabled: !item\.available/);
    assert.match(dialog, /value: item\.key/);
    assert.doesNotMatch(dialog, /<select\b/);
  }
  assert.match(noMovementDialog, /scopedOptions\?\.recipients/);
  assert.match(operationalDialog, /scopedOptions\?\.recipients/);
  assert.doesNotMatch(`${noMovementDialog}\n${operationalDialog}`, /oc_[0-9a-f]{20,}|@jtexpress\.com\.br/);
});
