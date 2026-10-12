/** Synthetic development fixtures only; suffixes are placeholders, not Brazilian state codes. */
export const REFERENCE_BASE_TEST_NAMES = [
  "UNIDADE-TESTE-ALFA-REGIAO-FAKE-A",
  "UNIDADE-TESTE-BETA-REGIAO-FAKE-B",
  "UNIDADE-TESTE-GAMA-REGIAO-FAKE-C",
  "POLO-SIMULADO-DELTA-LOCALIDADE-QA",
  "BASE-DEMO-EPSILON-CODIGO-0005",
  "BASE-DEMO-ZETA-CODIGO-0006",
] as const;

/** Conservative key for this local comparison: trim/collapse whitespace and ignore case only. */
export function normalizeReferenceBaseName(value: unknown): string {
  return String(value ?? "")

    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

export function uniqueReferenceBaseNames(names: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const name of names) {
    const display = String(name ?? "").trim().replace(/\s+/g, " ");
    const key = normalizeReferenceBaseName(display);
    if (key && !unique.has(key)) unique.set(key, display);
  }
  return [...unique.values()];
}

export function filterRowsByReferenceBaseNames<T>(
  rows: readonly T[],
  selectedNames: ReadonlySet<string>,
  getBaseName: (row: T) => unknown,
): T[] {
  const selectedKeys = new Set([...selectedNames].map(normalizeReferenceBaseName).filter(Boolean));
  return rows.filter((row) => {
    const key = normalizeReferenceBaseName(getBaseName(row));
    return Boolean(key) && selectedKeys.has(key);
  });
}
