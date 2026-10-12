import {
  summarizeTaxaPeriod,
  type TaxaPeriodSummary,
  type TaxaSummaryMeasure,
} from "./taxa-summary.ts";
import type { CollectionRateV2Record } from "./data-foundation/collection-rate.ts";
import { resolvePublishedRegionalAssignment } from "./data-foundation/regional-assignment.ts";

export const TAXA_V2_UNASSIGNED_REGION = "Sem regional";
export const TAXA_V2_UNASSIGNED_BASE = "Sem base";
export const TAXA_V2_UNASSIGNED_ORIGIN = "Sem origem";
export const TAXA_V2_UNASSIGNED_RM = "Sem RM";
export const TAXA_V2_UNASSIGNED_RM_AREA = "Sem região do RM";

export interface TaxaV2CardRecord extends TaxaSummaryMeasure {
  date: string;
  region: string;
  reportedRegion: string;
  rm: string;
  rmArea: string;
  rgm: string;
  origin: string;
  mappingResolution: string;
  resolvedBaseCode: string | null;
}

export interface TaxaV2DimensionFilters {
  regions?: ReadonlySet<string> | null;
  rms?: ReadonlySet<string> | null;
  rmAreas?: ReadonlySet<string> | null;
  bases?: ReadonlySet<string> | null;
  origins?: ReadonlySet<string> | null;
}

export interface TaxaV2FilterOptions {
  regions: string[];
  rms: string[];
  rmAreas: string[];
  bases: string[];
  origins: string[];
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function countValue(value: unknown, column: string): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Valor inteiro inválido em ${column} na publicação V2 de Taxa de Coleta.`);
  }
  return numeric;
}

/** Converts trusted V2 quantity fields to the dashboard's existing card model. */
export function mapTaxaV2CardRecords(
  records: readonly CollectionRateV2Record[],
): TaxaV2CardRecord[] {
  return records.map((record) => {
    const assignment = resolvePublishedRegionalAssignment(record);
    const base = assignment.effective_base_name || textValue(record.source_base_name, TAXA_V2_UNASSIGNED_BASE);
    return {
      date: String(record.deadline_at ?? "").slice(0, 10),
      region: assignment.effective_region,
      reportedRegion: textValue(record.reported_region, TAXA_V2_UNASSIGNED_REGION),
      base,
      origin: textValue(record.order_origin, TAXA_V2_UNASSIGNED_ORIGIN),
      orders: countValue(record.order_quantity, "order_quantity"),
      toCollect: countValue(record.quantity_to_collect, "quantity_to_collect"),
      collected: countValue(record.collected_quantity, "collected_quantity"),
      notCollected: countValue(record.not_collected_quantity, "not_collected_quantity"),
      onTime: countValue(record.collected_on_time_quantity, "collected_on_time_quantity"),
      collectedWithAttempts: countValue(record.collected_plus_attempts_quantity, "collected_plus_attempts_quantity"),
      rm: assignment.effective_rm,
      rmArea: assignment.effective_rm_area,
      rgm: assignment.effective_rgm,
      mappingResolution: String(record.effective_mapping_resolution ?? record.mapping_resolution ?? "UNMAPPED"),
      resolvedBaseCode: typeof (record.effective_base_code ?? record.resolved_base_code) === "string"
        ? String(record.effective_base_code ?? record.resolved_base_code)
        : null,
    };
  });
}

function selected(filter: ReadonlySet<string> | null | undefined, value: string): boolean {
  return filter == null || filter.has(value);
}

/** Applies all business filters to one shared set of server-period-scoped rows. */
export function filterTaxaV2CardRecords(
  records: readonly TaxaV2CardRecord[],
  filters: TaxaV2DimensionFilters,
): TaxaV2CardRecord[] {
  return records.filter((record) =>
    selected(filters.regions, record.region) &&
    selected(filters.rms, record.rm) &&
    selected(filters.rmAreas, record.rmArea) &&
    selected(filters.bases, record.base) &&
    selected(filters.origins, record.origin));
}

function optionsFor(records: readonly TaxaV2CardRecord[], key: keyof Pick<TaxaV2CardRecord, "region" | "rm" | "rmArea" | "base" | "origin">): string[] {
  return [...new Set(records.map((record) => record[key]))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export function taxaV2FilterOptions(records: readonly TaxaV2CardRecord[]): TaxaV2FilterOptions {
  return {
    regions: optionsFor(records, "region"),
    rms: optionsFor(records, "rm"),
    rmAreas: optionsFor(records, "rmArea"),
    bases: optionsFor(records, "base"),
    origins: optionsFor(records, "origin"),
  };
}

export function summarizeTaxaV2Cards(records: readonly TaxaV2CardRecord[]): TaxaPeriodSummary {
  return summarizeTaxaPeriod(records);
}
