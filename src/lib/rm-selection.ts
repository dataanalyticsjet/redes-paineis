export type OptionSelection =
  | { mode: "all" }
  | { mode: "custom"; values: ReadonlySet<string> };

export type RmSelection = OptionSelection;

export function allOptionsAreSelected(options: readonly string[], selected: ReadonlySet<string>): boolean {
  return options.length === selected.size && options.every((option) => selected.has(option));
}

export function distinctFilterOptions<T>(rows: readonly T[], getValue: (row: T) => string): string[] {
  return [...new Set(rows.map(getValue))].sort((left, right) => left.localeCompare(right, "pt-BR", { numeric: true }));
}

export function filterRowsByOption<T>(rows: readonly T[], selected: ReadonlySet<string>, getValue: (row: T) => string): T[] {
  return rows.filter((row) => selected.has(getValue(row)));
}

export function selectedOptions(options: readonly string[], selection: OptionSelection): Set<string> {
  const available = new Set(options);
  if (selection.mode === "all") return available;
  return new Set([...selection.values].filter((value) => available.has(value)));
}

export function optionSelectionFromValues(options: readonly string[], values: ReadonlySet<string>): OptionSelection {
  const available = new Set(options);
  const selected = new Set([...values].filter((value) => available.has(value)));
  if (selected.size === available.size && [...available].every((value) => selected.has(value))) {
    return { mode: "all" };
  }
  return { mode: "custom", values: selected };
}

export const selectedRmOptions = selectedOptions;
export const rmSelectionFromValues = optionSelectionFromValues;

export function rmGroupReactKey(rmArea: string, rm: string, rgm: string): string {
  return JSON.stringify([rmArea, rm, rgm]);
}
