import { apiFetch } from "../api-url.ts";
import { parseWorkbook, type ParsedWorkbook } from "../workbook.ts";

export interface ResponsibilitySourceStats {
  rowCount: number;
  baseCount: number;
  duplicateBaseCount: number;
  canPublish: boolean;
  regionalCounts: Record<string, number>;
  ufCounts: Record<string, number>;
}

export interface ResponsibilitySourcePreview extends ResponsibilitySourceStats {
  previewId: string | null;
  fileName: string;
  sheetName: string;
}

export interface ResponsibilitySourceMetadata extends ResponsibilitySourceStats {
  fileName: string;
  updatedAt?: string;
  publishedAt?: string;
  sheetName?: string;
  versionId?: string;
  status?: "ACTIVE";
}

async function readError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && /^[a-z0-9_]+$/.test(body.error)) return new Error(body.error);
  } catch {
    // Keep server diagnostics safe for display.
  }
  return new Error("responsibility_list_request_failed");
}

export async function parseResponsibilitySource(file: File): Promise<ParsedWorkbook> {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (!extension || !["xlsx", "xls"].includes(extension)) throw new Error("responsibility_list_file_type_invalid");
  if (file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error("responsibility_list_file_size_invalid");
  try {
    return parseWorkbook(await file.arrayBuffer(), { preferredSheetName: "Ativas" });
  } catch {
    throw new Error("responsibility_list_parse_failed");
  }
}

export async function previewResponsibilitySource(file: File, parsed: ParsedWorkbook): Promise<ResponsibilitySourcePreview> {
  const body = new FormData();
  body.append("payload", JSON.stringify({ kind: "responsibilityList", fileName: file.name, parsed }));
  body.append("files", file, file.name);
  const response = await apiFetch("/api/workbook/responsibility-list/preview", { method: "POST", body, cache: "no-store" });
  if (!response.ok) throw await readError(response);
  return await response.json() as ResponsibilitySourcePreview;
}

export async function publishResponsibilitySource(previewId: string): Promise<ResponsibilitySourceMetadata> {
  const response = await apiFetch("/api/workbook/responsibility-list/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId }),
    cache: "no-store",
  });
  if (!response.ok) throw await readError(response);
  const payload = await response.json() as { source?: ResponsibilitySourceMetadata };
  if (!payload.source) throw new Error("responsibility_list_publish_failed");
  return payload.source;
}

export async function getResponsibilitySource(): Promise<ResponsibilitySourceMetadata | null> {
  const response = await apiFetch("/api/workbook/responsibility-list", { cache: "no-store" });
  if (!response.ok) throw await readError(response);
  const payload = await response.json() as { source?: ResponsibilitySourceMetadata | null };
  return payload.source ?? null;
}
