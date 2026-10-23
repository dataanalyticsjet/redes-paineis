import { officialRgmForRegion, UNASSIGNED_RGM } from "../responsibility.ts";
import { COLLECTION_MONITORING_V2_STATUS_FIELDS } from "./collection-monitoring-v2-dashboard.ts";
import { collectionMonitoringV2PercentageVariation, filterCollectionMonitoringV2Rows, groupCollectionMonitoringV2Rows, type CollectionMonitoringV2Filters, type CollectionMonitoringV2Row } from "./collection-monitoring-v2-dashboard.ts";

export const RETENTION_MEASURES = COLLECTION_MONITORING_V2_STATUS_FIELDS.map(({ field, label }) => ({ key: field, label }));
type Measure = typeof RETENTION_MEASURES[number]["key"];
export interface RegionalRetentionRow {
  region: string;
  rgm: string;
  planned: number | null;
  values: Record<Measure, (number | null)[]>;
  variations: Record<Measure, number | null>;
}
export interface RegionalRetentionModel {
  dates: string[];
  rows: RegionalRetentionRow[];
  total: RegionalRetentionRow;
}

export function regionalRetentionModel(rows: readonly CollectionMonitoringV2Row[], filters: CollectionMonitoringV2Filters): RegionalRetentionModel {
  const filtered = filterCollectionMonitoringV2Rows(rows, filters);
  const dates = [...new Set(filtered.map((row) => String(row.data_date).slice(0, 10)))].sort().slice(-3);
  const daily = dates.map((date) => groupCollectionMonitoringV2Rows(filtered.filter((row) => String(row.data_date).slice(0, 10) === date), "region"));
  const regions = [...new Set(daily.flatMap((groups) => groups.map((group) => group.region)))];
  const build = (region: string, total = false): RegionalRetentionRow => {
    const groups = daily.map((items) => total ? items : items.filter((item) => item.region === region));
    const sum = (index: number, key: Measure | "planned") => groups[index]?.length ? groups[index].reduce((value, group) => value + group[key], 0) : null;
    const values = Object.fromEntries(RETENTION_MEASURES.map(({ key }) => [key, dates.map((_, index) => sum(index, key))])) as RegionalRetentionRow["values"];
    const variations = Object.fromEntries(RETENTION_MEASURES.map(({ key }) => [key, collectionMonitoringV2PercentageVariation(values[key].at(-1), values[key].at(-2))])) as RegionalRetentionRow["variations"];
    return { region, rgm: total ? "—" : officialRgmForRegion(region) ?? UNASSIGNED_RGM, planned: sum(dates.length - 1, "planned"), values, variations };
  };
  const result = regions.map((region) => build(region)).sort((a, b) => {
    if (a.region === "Sem regional") return 1;
    if (b.region === "Sem regional") return -1;
    return (b.values.retention.at(-1) ?? -1) - (a.values.retention.at(-1) ?? -1) || a.region.localeCompare(b.region, "pt-BR");
  });
  return { dates, rows: result, total: build("Total geral", true) };
}

export function regionalRetentionMatrix(model: RegionalRetentionModel, t: (label: string) => string = (label) => label): (string | number | null)[][] {
  const cells = (row: RegionalRetentionRow) => [t(row.region), t(row.rgm), row.planned, ...RETENTION_MEASURES.flatMap(({ key }) => [...row.values[key], row.variations[key]])];
  return [
    [t("Regional"), "RGM", t("Volume previsto"), ...RETENTION_MEASURES.flatMap(({ label }) => [...model.dates.map((date) => `${t(label)} — ${date}`), `${t(label)} — ${t("Variação")}`])],
    ...model.rows.map(cells), cells(model.total),
  ];
}
