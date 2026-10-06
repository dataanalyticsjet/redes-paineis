import type { ParsedWorkbook } from "../workbook";
import { apiFetch } from "../api-url.ts";

export type DashboardSourceId =
  | "monitoring"
  | "taxa"
  | "epop"
  | "movement"
  | "sellerPerformance"
  | "bipagem"
  | "damage"
  | "tt5cd"
  | "loss"
  | "last-mile-damage"
  | "volumetry"
  | "no-movement-10-days"
  | "no-movement-3-14-days"
  | "retained-10-days"
  | "return"
  | "last-mile-sla"
  | "t0"
  | "rollover"
  | "pod-approval-rate"
  | "pnr-rate"
  | "pnr-packages-target"
  | "dispatch-delivery-window"
  | "shipping-time"
  | "driver-attendance"
  | "bagging-consolidated-report";

export interface DataSourcePreviewField {
  name: string;
  classification: "required" | "optional" | "unrecognized";
  present: boolean;
}

export interface DataSourcePreview {
  previewId: string | null;
  fileName: string;
  fileSizeBytes: number;
  contentType: string;
  sheetName: string;
  rowCount: number;
  period: { start: string; end: string } | null;
  headers: string[];
  fields: DataSourcePreviewField[];
  missingFields: string[];
  canImport: boolean;
  errors: string[];
}

export interface ManualDataSource {
  sourceType: "MANUAL_UPLOAD";
  fileName: string;
  fileSizeBytes: number;
  contentType: string;
  importedAt: string;
  rowCount: number;
  period: { start: string; end: string } | null;
  status: "loaded";
  parsed: ParsedWorkbook;
}

export interface DataSourceResponse {
  source: ManualDataSource | null;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function validateWorkbookFile(file: File): void {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension !== "xlsx" && extension !== "xls") throw new Error("data_source_file_type_invalid");
  if (file.size === 0) throw new Error("data_source_file_empty");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("data_source_file_too_large");

  const contentType = file.type.split(";", 1)[0].trim().toLowerCase();
  if (!ACCEPTED_MIME_TYPES.has(contentType)) throw new Error("data_source_mime_invalid");
  const expectedMime = extension === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.ms-excel";
  if (contentType && contentType !== "application/octet-stream" && contentType !== expectedMime) {
    throw new Error("data_source_mime_extension_mismatch");
  }
}

async function requestDataSource<T>(dashboardId: DashboardSourceId, action = "", init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(`/api/data-sources/${encodeURIComponent(dashboardId)}${action}`, {
      cache: "no-store",
      ...init,
    });
  } catch {
    throw new Error("data_source_api_unavailable");
  }

  if (!response.ok) {
    let code = "data_source_request_failed";
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === "string" && /^data_source_[a-z_]+$/.test(body.detail)) code = body.detail;
      if (body.detail === "authentication_required") code = "data_source_auth_required";
    } catch {
      // Keep server details sanitized before they reach the interface.
    }
    throw new Error(code);
  }

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function previewDashboardDataSource(
  dashboardId: DashboardSourceId,
  file: File,
  parsed: ParsedWorkbook,
): Promise<DataSourcePreview> {
  const body = new FormData();
  body.append("payload", JSON.stringify({ fileName: file.name, fileSizeBytes: file.size, contentType: file.type, parsed }));
  body.append("file", file, file.name);
  return requestDataSource(dashboardId, "/preview", {
    method: "POST",
    body,
  });
}

export function importDashboardDataSource(dashboardId: DashboardSourceId, previewId: string): Promise<ManualDataSource> {
  return requestDataSource(dashboardId, "/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId }),
  });
}

export function getDashboardDataSource(dashboardId: DashboardSourceId): Promise<DataSourceResponse> {
  return requestDataSource(dashboardId);
}

export function removeDashboardDataSource(dashboardId: DashboardSourceId): Promise<void> {
  return requestDataSource(dashboardId, "", { method: "DELETE" });
}
