import assert from "node:assert/strict";
import test from "node:test";

import {
  monitoringAwaitingRate,
  monitoringCollectedVolume,
  monitoringCollectionRate,
  summarizeMonitoringStatusValues,
} from "../src/lib/monitoring-formulas.ts";

test("reproduces the monitoring workbook formulas", () => {
  const input = { orderVolume: 2_505, awaiting: 849 };
  assert.equal(monitoringCollectedVolume(input), 1_656);
  assert.equal(monitoringCollectionRate(input), (2_505 - 849) / 2_505);
  assert.equal(monitoringAwaitingRate(input), 849 / 2_505);
  assert.equal(monitoringCollectionRate(input) + monitoringAwaitingRate(input), 1);
});

test("handles empty and inconsistent rows safely", () => {
  assert.equal(monitoringCollectionRate({ orderVolume: 0, awaiting: 0 }), 0);
  assert.equal(monitoringAwaitingRate({ orderVolume: 0, awaiting: 10 }), 0);
  assert.equal(monitoringCollectedVolume({ orderVolume: 10, awaiting: 12 }), 0);
});

test("regional summary collection is planned minus awaiting, not a sum of overlapping status stages", () => {
  const statuses = [
    "Coleta Prevista Drop-off", "Coleta Prevista Pick-up", "Aguardando Coleta Drop-off",
    "Aguardando Coleta Pick-up", "Status atual – Coletado", "Status atual – Recebido na base",
    "Expedida pela Base", "Chegada ao Centro de Triagem",
  ];
  const values = new Map([
    [statuses[0], 3_000_000], [statuses[1], 328_879],
    [statuses[2], 40_000], [statuses[3], 8_904],
    [statuses[4], 2_000_000], [statuses[5], 1_000_000],
    [statuses[6], 500_000], [statuses[7], 94_897],
  ]);
  const metrics = summarizeMonitoringStatusValues(statuses, values, (status) => {
    if (status.startsWith("Coleta Prevista")) return "planned";
    if (status.startsWith("Aguardando Coleta")) return "awaiting";
    return "collected";
  });

  assert.equal(metrics.orderVolume, 3_328_879);
  assert.equal(metrics.awaiting, 48_904);
  assert.equal(metrics.collected, 3_279_975);
  assert.equal([...values.entries()].filter(([status]) => !status.startsWith("Coleta Prevista") && !status.startsWith("Aguardando Coleta")).reduce((total, [, value]) => total + value, 0), 3_594_897);
});
