import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("../src/features/dashboards/dashboard-loading-skeleton.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const dashboards = await readFile(new URL("../src/features/dashboards/dashboard-app.tsx", import.meta.url), "utf8");
const monitoring = await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx", import.meta.url), "utf8");

test("loading shared shows percent only from a measurable total and supports indeterminate state", () => {
  assert.match(component, /progress\.total > 0/);
  assert.match(component, /measuredPercent !== null \? <strong/);
  assert.match(component, /is-indeterminate/);
  assert.match(component, /loaded: number/);
  assert.match(component, /total: number/);
});

test("loading shared exposes accessible status, retry, stale-data label, and responsive motion-safe skeletons", () => {
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /onRetry/);
  assert.match(component, /previousDataLabel/);
  assert.match(component, /dashboard-loading-kpis/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the three dashboards preserve prior data only within the active authorization scope", () => {
  assert.match(monitoring, /loadedScope === scopeKey && rows\.length > 0/);
  assert.match(dashboards, /<CollectionMonitoringV2Dashboard key=\{dashboardCacheIdentity\}/);
  assert.match(dashboards, /current\.identityKey === dashboardCacheIdentity \? current\.records : \[\]/);
  assert.match(dashboards, /pddDataAuthorized \? pddCollectionFailureV2State\.records : \[\]/);
  assert.match(dashboards, /hasPreviousData = hasData && \(status === "loading" \|\| status === "error"\)/);
});
