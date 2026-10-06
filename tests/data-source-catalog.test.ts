import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_DATA_SOURCES } from "../src/lib/data-sources/catalog.ts";

test("source catalog lists every dashboard ID and configures only known contracts", () => {
  assert.deepEqual(Object.keys(DASHBOARD_DATA_SOURCES).sort(), [
    "bagging-consolidated-report",
    "bipagem",
    "damage",
    "dispatch-delivery-window",
    "driver-attendance",
    "epop",
    "last-mile-damage",
    "last-mile-sla",
    "loss",
    "monitoring",
    "movement",
    "no-movement-10-days",
    "no-movement-3-14-days",
    "pnr-packages-target",
    "pnr-rate",
    "pod-approval-rate",
    "retained-10-days",
    "return",
    "rollover",
    "sellerPerformance",
    "shipping-time",
    "t0",
    "taxa",
    "tt5cd",
    "volumetry",
  ]);
  assert.deepEqual(
    Object.values(DASHBOARD_DATA_SOURCES).filter((source) => source.configured).map((source) => source.id).sort(),
    ["monitoring", "taxa"],
  );
});

test("configured adapters declare parsing, normalization, preview, import and removal", () => {
  for (const id of ["monitoring", "taxa"] as const) {
    const source = DASHBOARD_DATA_SOURCES[id];
    assert.deepEqual(source.acceptedFormats, [".xlsx", ".xls"]);
    assert.equal(source.sourceModes.includes("MANUAL"), true);
    assert.equal(typeof source.parse, "function");
    assert.equal(typeof source.normalize, "function");
    assert.equal(typeof source.preview, "function");
    assert.equal(typeof source.import, "function");
    assert.equal(typeof source.remove, "function");
    assert.equal(source.status, "SOURCE_CONFIGURED");
  }
  assert.equal(DASHBOARD_DATA_SOURCES.taxa.requiredFields.length, 22);
});

test("unconfigured dashboards declare pending status and no accepted formats or file parser", () => {
  for (const id of [
    "epop", "movement", "sellerPerformance", "bipagem", "damage",
    "tt5cd", "loss", "last-mile-damage", "volumetry", "no-movement-10-days", "no-movement-3-14-days",
    "retained-10-days", "return", "last-mile-sla", "t0", "rollover", "pod-approval-rate", "pnr-rate",
    "pnr-packages-target", "dispatch-delivery-window", "shipping-time", "driver-attendance", "bagging-consolidated-report",
  ] as const) {
    const source = DASHBOARD_DATA_SOURCES[id];
    assert.equal(source.configured, false);
    assert.equal(source.status, "SOURCE_NOT_CONFIGURED");
    assert.deepEqual(source.acceptedFormats, []);
    assert.equal(source.parse, undefined);
    assert.equal(source.normalize, undefined);
  }
});
