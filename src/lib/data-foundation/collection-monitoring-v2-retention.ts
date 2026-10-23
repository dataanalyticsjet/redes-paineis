import { officialRgmForRegion, UNASSIGNED_RGM } from "../responsibility.ts";
import { collectionMonitoringV2PercentageVariation } from "./collection-monitoring-v2-dashboard.ts";
import type { CollectionMonitoringV2RetentionRecord, CollectionMonitoringV2RmRetentionRecord } from "./collection-monitoring-v2.ts";

export const RETENTION_MEASURES = [
  { key: "retentionTotal", label: "Retenção total" },
  { key: "retainedAtBase", label: "Retido na base" },
  { key: "dispatchedFromBase", label: "Despachado pela base" },
  { key: "arrivedCenter", label: "Chegado ao centro" },
] as const;
export type RetentionMeasure = typeof RETENTION_MEASURES[number]["key"];

export interface RegionalRetentionRow {
  region: string;
  rgm: string;
  planned: number | null;
  values: Record<RetentionMeasure, (number | null)[]>;
  variations: Record<RetentionMeasure, number | null>;
}
export interface RegionalRetentionModel {
  dates: string[];
  rows: RegionalRetentionRow[];
  total: RegionalRetentionRow;
}

export interface RmRetentionRow {
  rmArea: string;
  rm: string;
  region: string;
  rgm: string;
  planned: number;
  retentionTotal: number;
  retentionRate: number | null;
  retainedAtBase: number;
  retainedAtBaseRate: number | null;
  dispatchedFromBase: number;
  dispatchedFromBaseRate: number | null;
  arrivedCenter: number;
  arrivedCenterRate: number | null;
}
export interface RmRetentionModel { rows: RmRetentionRow[]; total: RmRetentionRow }

function quantity(row: CollectionMonitoringV2RetentionRecord, field: string): number {
  return Number(row[field] ?? 0);
}
function planned(row: CollectionMonitoringV2RetentionRecord): number {
  return quantity(row, "status_received_at_base")
    + quantity(row, "in_transit_to_center")
    + quantity(row, "in_transit_to_distribution")
    + quantity(row, "arrived_sc");
}
function values(row: CollectionMonitoringV2RetentionRecord): Record<RetentionMeasure, number> {
  const retainedAtBase = quantity(row, "status_received_at_base");
  const dispatchedFromBase = quantity(row, "status_dispatched_from_base");
  const arrivedCenter = quantity(row, "arrived_sorting_center");
  return { retentionTotal: retainedAtBase + dispatchedFromBase + arrivedCenter, retainedAtBase, dispatchedFromBase, arrivedCenter };
}
function ratio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : numerator / denominator; }

export function regionalRetentionModel(aggregates: readonly CollectionMonitoringV2RetentionRecord[], dates: readonly string[]): RegionalRetentionModel {
  const latestDates = dates.slice(-3);
  const regions = [...new Set(aggregates.map((row) => row.region))];
  const build = (region: string, total = false): RegionalRetentionRow => {
    const valuesByMeasure = Object.fromEntries(RETENTION_MEASURES.map(({ key }) => [key, latestDates.map((date) => {
      const rows = aggregates.filter((row) => row.data_date === date && (total || row.region === region));
      return rows.length ? rows.reduce((sum, row) => sum + values(row)[key], 0) : null;
    })])) as RegionalRetentionRow["values"];
    const measureVariations = Object.fromEntries(RETENTION_MEASURES.map(({ key }) => [key, collectionMonitoringV2PercentageVariation(valuesByMeasure[key].at(-1), valuesByMeasure[key].at(-2))])) as RegionalRetentionRow["variations"];
    const lastDate = latestDates.at(-1);
    const plannedRows = aggregates.filter((row) => row.data_date === lastDate && (total || row.region === region));
    return {
      region, rgm: total ? "—" : officialRgmForRegion(region) ?? UNASSIGNED_RGM,
      planned: plannedRows.length ? plannedRows.reduce((sum, row) => sum + planned(row), 0) : null,
      values: valuesByMeasure, variations: measureVariations,
    };
  };
  const rows = regions.map((region) => build(region)).sort((left, right) => {
    if (left.region === "Sem regional") return 1;
    if (right.region === "Sem regional") return -1;
    return (right.values.retentionTotal.at(-1) ?? -1) - (left.values.retentionTotal.at(-1) ?? -1) || left.region.localeCompare(right.region, "pt-BR");
  });
  return { dates: latestDates, rows, total: build("Total geral", true) };
}

export function regionalRetentionMatrix(model: RegionalRetentionModel, t: (label: string) => string = (label) => label): (string | number | null)[][] {
  const cells = (row: RegionalRetentionRow) => [t(row.region), t(row.rgm), row.planned, ...RETENTION_MEASURES.flatMap(({ key }) => [...row.values[key], row.variations[key]])];
  return [
    [t("Regional"), "RGM", t("Volume previsto"), ...RETENTION_MEASURES.flatMap(({ label }) => [...model.dates.map((date) => `${t(label)} — ${date}`), `${t(label)} — ${t("Variação")}`])],
    ...model.rows.map(cells), cells(model.total),
  ];
}

export function rmRetentionModel(aggregates: readonly CollectionMonitoringV2RmRetentionRecord[]): RmRetentionModel {
  const groups = new Map<string, CollectionMonitoringV2RmRetentionRecord[]>();
  for (const row of aggregates) {
    const key = JSON.stringify([row.rm_area, row.rm, row.region]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const build = (items: readonly CollectionMonitoringV2RmRetentionRecord[], labels: Pick<RmRetentionRow, "rmArea" | "rm" | "region">): RmRetentionRow => {
    const sums = items.reduce((total, row) => {
      total.planned += planned(row);
      const measureValues = values(row);
      total.retainedAtBase += measureValues.retainedAtBase;
      total.dispatchedFromBase += measureValues.dispatchedFromBase;
      total.arrivedCenter += measureValues.arrivedCenter;
      total.retentionTotal += measureValues.retentionTotal;
      return total;
    }, { planned: 0, retentionTotal: 0, retainedAtBase: 0, dispatchedFromBase: 0, arrivedCenter: 0 });
    return {
      ...labels, rgm: officialRgmForRegion(labels.region) ?? UNASSIGNED_RGM, ...sums,
      retentionRate: ratio(sums.retentionTotal, sums.planned),
      retainedAtBaseRate: ratio(sums.retainedAtBase, sums.planned),
      dispatchedFromBaseRate: ratio(sums.dispatchedFromBase, sums.planned),
      arrivedCenterRate: ratio(sums.arrivedCenter, sums.planned),
    };
  };
  const rows = [...groups].map(([key, items]) => {
    const [rmArea, rm, region] = JSON.parse(key) as [string, string, string];
    return build(items, { rmArea, rm, region });
  }).sort((left, right) => right.retentionTotal - left.retentionTotal || left.rmArea.localeCompare(right.rmArea, "pt-BR") || left.rm.localeCompare(right.rm, "pt-BR"));
  const total = build(aggregates, { rmArea: "—", rm: "—", region: "—" });
  return { rows, total };
}

export function rmRetentionMatrix(model: RmRetentionModel, t: (label: string) => string = (label) => label): (string | number | null)[][] {
  const headers = ["Região do RM", "RM", "RGM", "Volume previsto", "Retenção total", "Taxa de retenção", "Retido na base", "Taxa", "Despachado pela base", "Taxa", "Chegado ao centro", "Taxa"];
  const cells = (row: RmRetentionRow, total = false) => [total ? t("Total geral") : t(row.rmArea), total ? "—" : t(row.rm), total ? "—" : t(row.rgm), row.planned, row.retentionTotal, row.retentionRate, row.retainedAtBase, row.retainedAtBaseRate, row.dispatchedFromBase, row.dispatchedFromBaseRate, row.arrivedCenter, row.arrivedCenterRate];
  return [headers.map(t), ...model.rows.map((row) => cells(row)), cells(model.total, true)];
}
