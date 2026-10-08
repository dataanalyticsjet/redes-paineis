export const MOVEMENT_SUMMARY_METRICS = [
  ["totalStopped", "Total sem movimentação"],
  ["from2Days", "Total há 2 dias ou mais"],
  ...[1, 2, 3, 4, 5, 6, 7, 10, 14, 30].map((day) => [`over${day}${day === 1 ? "Day" : "Days"}`, `Sem mov. há mais de ${day} ${day === 1 ? "dia" : "dias"}`]),
] as readonly (readonly string[])[];

export interface MovementResponsibilityRow {
  region: string;
  rm: string;
  rmArea: string;
  base: string;
  rgm: string;
}

export interface MovementFilterSelections {
  regions: ReadonlySet<string>;
  rms: ReadonlySet<string>;
  rmAreas: ReadonlySet<string>;
  bases: ReadonlySet<string>;
  rgms: ReadonlySet<string>;
}

export type MovementFilterName = keyof MovementFilterSelections;

export interface MovementFilterOptions<T extends MovementResponsibilityRow = MovementResponsibilityRow> {
  regions: string[];
  rms: string[];
  rmAreas: string[];
  bases: string[];
  rgms: string[];
  filteredRows: T[];
}

export interface MovementFilterSelectionState {
  regions: Set<string>;
  rms: Set<string>;
  rmAreas: Set<string>;
  bases: Set<string>;
  rgms: Set<string>;
}

const uniqueMovementValues = (values: Iterable<string>) =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right, "pt-BR", { numeric: true }));

const MOVEMENT_ROW_FIELD: Record<MovementFilterName, keyof MovementResponsibilityRow> = {
  regions: "region",
  rms: "rm",
  rmAreas: "rmArea",
  bases: "base",
  rgms: "rgm",
};

function selectMovementRows<T extends MovementResponsibilityRow>(rows: readonly T[], selected: ReadonlySet<string>, field: MovementFilterName): T[] {
  const rowField = MOVEMENT_ROW_FIELD[field];
  return rows.filter((row) => selected.has(row[rowField]));
}

/**
 * Derive each dropdown from rows passing only the filters before it.
 * In particular, RM-area choices never depend on the RM-area selection itself.
 */
export function deriveMovementFilterOptions<T extends MovementResponsibilityRow>(
  rows: readonly T[],
  selected: MovementFilterSelections,
): MovementFilterOptions<T> {
  const regions = uniqueMovementValues(rows.map((row) => row.region));
  const regionalRows = selectMovementRows(rows, selected.regions, "regions");
  const rms = uniqueMovementValues(regionalRows.map((row) => row.rm));
  const rmRows = selectMovementRows(regionalRows, selected.rms, "rms");
  const rmAreas = uniqueMovementValues(rmRows.map((row) => row.rmArea));
  const rmAreaRows = selectMovementRows(rmRows, selected.rmAreas, "rmAreas");
  const bases = uniqueMovementValues(rmAreaRows.map((row) => row.base));
  const baseRows = selectMovementRows(rmAreaRows, selected.bases, "bases");
  const rgms = uniqueMovementValues(baseRows.map((row) => row.rgm));
  const filteredRows = selectMovementRows(baseRows, selected.rgms, "rgms");
  return { regions, rms, rmAreas, bases, rgms, filteredRows };
}

/** Keep every downstream selector on ALL whenever an upstream selector changes. */
export function movementSelectionsAfterChange<T extends MovementResponsibilityRow>(
  rows: readonly T[],
  current: MovementFilterSelectionState,
  changed: MovementFilterName,
  value: Set<string>,
): MovementFilterSelectionState {
  const next: MovementFilterSelectionState = { ...current, [changed]: new Set(value) };
  const regionalRows = selectMovementRows(rows, next.regions, "regions");
  if (changed === "regions") next.rms = new Set(uniqueMovementValues(regionalRows.map((row) => row.rm)));
  const rmRows = selectMovementRows(regionalRows, next.rms, "rms");
  if (changed === "regions" || changed === "rms") next.rmAreas = new Set(uniqueMovementValues(rmRows.map((row) => row.rmArea)));
  const rmAreaRows = selectMovementRows(rmRows, next.rmAreas, "rmAreas");
  if (changed === "regions" || changed === "rms" || changed === "rmAreas") {
    next.bases = new Set(uniqueMovementValues(rmAreaRows.map((row) => row.base)));
  }
  const baseRows = selectMovementRows(rmAreaRows, next.bases, "bases");
  if (changed !== "rgms") next.rgms = new Set(uniqueMovementValues(baseRows.map((row) => row.rgm)));
  return next;
}

export function initialMovementFilterSelections<T extends MovementResponsibilityRow>(
  rows: readonly T[],
  regions?: Set<string>,
): MovementFilterSelectionState {
  const allRegions = regions ?? new Set(uniqueMovementValues(rows.map((row) => row.region)));
  return movementSelectionsAfterChange(
    rows,
    { regions: new Set(), rms: new Set(), rmAreas: new Set(), bases: new Set(), rgms: new Set() },
    "regions",
    allRegions,
  );
}

export interface MovementRegionalTotal {
  region: string;
  rgm: string;
  orders: number;
}

export interface MovementRmTotal {
  rmArea: string;
  rm: string;
  rgm: string;
  orders: number;
}

export function aggregateMovementByRegion<T extends MovementResponsibilityRow & { totalStopped: number }>(rows: readonly T[]): MovementRegionalTotal[] {
  const groups = new Map<string, MovementRegionalTotal>();
  for (const row of rows) {
    const current = groups.get(row.region) ?? { region: row.region, rgm: row.rgm, orders: 0 };
    current.orders += row.totalStopped;
    groups.set(row.region, current);
  }
  return [...groups.values()].sort((left, right) => right.orders - left.orders || left.region.localeCompare(right.region, "pt-BR", { numeric: true }));
}

export function aggregateMovementByRm<T extends MovementResponsibilityRow & { totalStopped: number }>(rows: readonly T[]): MovementRmTotal[] {
  const groups = new Map<string, MovementRmTotal>();
  for (const row of rows) {
    const key = `${row.rmArea}::${row.rm}::${row.rgm}`;
    const current = groups.get(key) ?? { rmArea: row.rmArea, rm: row.rm, rgm: row.rgm, orders: 0 };
    current.orders += row.totalStopped;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.orders - left.orders || left.rmArea.localeCompare(right.rmArea, "pt-BR", { numeric: true }) || left.rm.localeCompare(right.rm, "pt-BR", { numeric: true }));
}

export function selectMovementSummaryMetric<T extends { totalStopped: number; quantity: number }>(record: T, metric: string): T {
  if (metric === "totalStopped") return record;
  const ageKeys = MOVEMENT_SUMMARY_METRICS.slice(2).map(([key]) => key);
  const selectedKeys = metric === "from2Days" ? ageKeys.slice(1) : ageKeys.filter((key) => key === metric);
  const values = record as T & Record<string, unknown>;
  const total = selectedKeys.reduce((sum, key) => sum + Number(values[key] ?? 0), 0);
  return { ...record, ...Object.fromEntries(ageKeys.map((key) => [key, selectedKeys.includes(key) ? values[key] : 0])), totalStopped: total, quantity: total };
}

export function movementFrom2DaysTotal(record: {
  over2Days: number;
  over3Days: number;
  over4Days: number;
  over5Days: number;
  over6Days: number;
  over7Days: number;
  over10Days: number;
  over14Days: number;
  over30Days: number;
}): number {
  return record.over2Days + record.over3Days + record.over4Days + record.over5Days + record.over6Days +
    record.over7Days + record.over10Days + record.over14Days + record.over30Days;
}

export function movementWeightedRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function formatMovementRate(rate: number | null, locale: string): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(rate);
}
