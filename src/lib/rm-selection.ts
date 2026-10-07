export type RmSelection =
  | { mode: "all" }
  | { mode: "custom"; values: ReadonlySet<string> };

export function selectedRmOptions(options: readonly string[], selection: RmSelection): Set<string> {
  const available = new Set(options);
  if (selection.mode === "all") return available;
  return new Set([...selection.values].filter((value) => available.has(value)));
}

export function rmSelectionFromValues(options: readonly string[], values: ReadonlySet<string>): RmSelection {
  const available = new Set(options);
  const selected = new Set([...values].filter((value) => available.has(value)));
  if (selected.size === available.size && [...available].every((value) => selected.has(value))) {
    return { mode: "all" };
  }
  return { mode: "custom", values: selected };
}

export function rmGroupReactKey(rmArea: string, rm: string, rgm: string): string {
  return JSON.stringify([rmArea, rm, rgm]);
}
