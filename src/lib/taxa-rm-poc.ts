import {
  officialRgmForRegion,
  responsibilityForBase,
  rmAreaForBase,
  type ResponsibilityData,
  UNASSIGNED_RM_AREA,
} from "./responsibility.ts";
import { taxaRate } from "./taxa-summary.ts";

export interface TaxaRmPocRecord {
  date: string;
  region: string;
  base: string;
  orders: number;
  toCollect: number;
  collectedWithAttempts: number;
}

export interface TaxaRmPocValue {
  orders: number;
  toCollect: number;
  withAttempts: number;
  rate: number | null;
}

export interface TaxaRmPocRow {
  rmArea: string;
  rm: string;
  rgm: string;
  values: TaxaRmPocValue[];
  totalOrders: number;
}

/** Enrich each source row before grouping so RM area, RM and RGM stay aligned. */
export function aggregateTaxaRmPoc(
  records: readonly TaxaRmPocRecord[],
  dates: readonly string[],
  responsibility: ResponsibilityData | null,
  locale: string,
): TaxaRmPocRow[] {
  const dateSet = new Set(dates);
  const rmGroups = new Map<
    string,
    {
      rmArea: string;
      rm: string;
      rgm: string;
      byDate: Map<string, { orders: number; toCollect: number; withAttempts: number }>;
    }
  >();

  for (const record of records) {
    if (!dateSet.has(record.date)) continue;

    const responsibilityForRecord = responsibilityForBase(responsibility, record.base);
    const rm = responsibilityForRecord.rm;
    const rgm = officialRgmForRegion(record.region) ?? responsibilityForRecord.rgm;
    const rmArea = rmAreaForBase(responsibility, record.base) || UNASSIGNED_RM_AREA;
    const groupKey = `${rmArea}\u0000${rm}\u0000${rgm}`;
    const group = rmGroups.get(groupKey) ?? {
      rmArea,
      rm,
      rgm,
      byDate: new Map<string, { orders: number; toCollect: number; withAttempts: number }>(),
    };
    const current = group.byDate.get(record.date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
    current.orders += record.orders;
    current.toCollect += record.toCollect;
    current.withAttempts += record.collectedWithAttempts;
    group.byDate.set(record.date, current);
    rmGroups.set(groupKey, group);
  }

  return [...rmGroups.values()]
    .map(({ rmArea, rm, rgm, byDate }) => {
      const values = dates.map((date) => {
        const value = byDate.get(date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
        return { ...value, rate: taxaRate(value.withAttempts, value.toCollect) };
      });
      return { rmArea, rm, rgm, values, totalOrders: values.reduce((sum, value) => sum + value.orders, 0) };
    })
    .filter((row) => row.totalOrders > 0 || row.values.some((value) => value.toCollect > 0))
    .sort((a, b) => {
      const aLatest = a.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: null };
      const bLatest = b.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: null };
      return (
        Number(bLatest.toCollect > 0) - Number(aLatest.toCollect > 0) ||
        (bLatest.rate ?? -1) - (aLatest.rate ?? -1) ||
        bLatest.toCollect - aLatest.toCollect ||
        a.rmArea.localeCompare(b.rmArea, locale, { numeric: true }) ||
        a.rm.localeCompare(b.rm, locale, { numeric: true })
      );
    });
}
