type T4T5ImportProgressStatus = {
  phase?: unknown;
  inputRowCount?: unknown;
  validRowCount?: unknown;
  analyzedRowCount?: unknown;
  writtenRowCount?: unknown;
  committedRowCount?: unknown;
  totalExpectedRowCount?: unknown;
};

export type T4T5ImportProgressView = {
  phaseLabel: "Validação do arquivo" | "Publicação" | "Etapa indisponível";
  analyzedRowCount: number;
  writtenRowCount: number | null;
  committedRowCount: number | null;
  totalExpectedRowCount: number | null;
  progressPercent: number | null;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function buildT4T5ImportProgressView(
  status: T4T5ImportProgressStatus,
): T4T5ImportProgressView {
  const isPublication = status.phase === "PUBLICATION";
  const isValidation = status.phase === "VALIDATION";
  const expected = count(status.totalExpectedRowCount) ?? count(status.validRowCount);
  const committed = isPublication ? count(status.committedRowCount) : null;
  const percent = isPublication && expected !== null && expected > 0 && committed !== null
    ? Math.min(100, (committed / expected) * 100)
    : null;

  return {
    phaseLabel: isPublication ? "Publicação" : isValidation ? "Validação do arquivo" : "Etapa indisponível",
    analyzedRowCount: isPublication
      ? count(status.analyzedRowCount) ?? 0
      : isValidation ? count(status.analyzedRowCount) ?? count(status.inputRowCount) ?? 0 : 0,
    writtenRowCount: isPublication ? count(status.writtenRowCount) : null,
    committedRowCount: committed,
    totalExpectedRowCount: isPublication ? expected : null,
    progressPercent: percent,
  };
}
