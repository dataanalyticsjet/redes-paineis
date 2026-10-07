import { buildResponsibilityData, type ResponsibilityData } from "./responsibility.ts";
import type { ParsedWorkbook } from "./workbook.ts";

export type ResponsibilityWorkbookLoadResult =
  | { status: "loaded"; data: ResponsibilityData }
  | { status: "missing"; data: null }
  | { status: "request-failed"; data: null }
  | { status: "http-error"; data: null; httpStatus: number }
  | { status: "invalid"; data: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParsedWorkbook(value: unknown): value is ParsedWorkbook {
  if (!isRecord(value)) return false;
  return (
    typeof value.sheetName === "string" &&
    Array.isArray(value.headers) && value.headers.every((header) => typeof header === "string") &&
    Array.isArray(value.rows) && value.rows.every(isRecord) &&
    Array.isArray(value.statusColumns) && value.statusColumns.every((column) => typeof column === "string") &&
    isRecord(value.metadata) && Array.isArray(value.warnings)
  );
}

/** Parse the same response shape returned by GET /api/workbook?kind=responsibilityList. */
export async function readResponsibilityWorkbookResponse(
  response: Response | null,
): Promise<ResponsibilityWorkbookLoadResult> {
  if (!response) return { status: "request-failed", data: null };
  if (!response.ok) return { status: "http-error", data: null, httpStatus: response.status };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "invalid", data: null };
  }

  if (!isRecord(payload) || !Object.hasOwn(payload, "workbook")) {
    return { status: "invalid", data: null };
  }
  if (payload.workbook === null) return { status: "missing", data: null };

  const workbook = payload.workbook;
  if (
    !isRecord(workbook) ||
    typeof workbook.fileName !== "string" || !workbook.fileName.trim() ||
    !isParsedWorkbook(workbook.parsed)
  ) {
    return { status: "invalid", data: null };
  }

  try {
    const updatedAt = typeof workbook.updatedAt === "string" ? workbook.updatedAt : undefined;
    const data = buildResponsibilityData(workbook.parsed as ParsedWorkbook, workbook.fileName, updatedAt);
    if (data.records.length === 0) return { status: "invalid", data: null };
    return { status: "loaded", data };
  } catch {
    return { status: "invalid", data: null };
  }
}
