import { apiFetch } from "./api-url.ts";

export interface AdminRegion {
  code: string;
  name: string;
}

export interface ManagedUser {
  id: number;
  name: string;
  email: string;
  platformRole: "USER" | "ADMIN";
  organizationalScope: "matrix" | "regional" | "base";
  homeRegion: string | null;
  homeBase: string | null;
  additionalRegions: string[];
  isActive: boolean;
}

export interface ManagedUsersResponse {
  users: ManagedUser[];
  total: number;
  limit: number;
  offset: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, { cache: "no-store", ...init });
  } catch {
    throw new Error("user_admin_api_unavailable");
  }

  if (!response.ok) {
    let code = "user_admin_request_failed";
    try {
      const payload = await response.json() as { detail?: unknown };
      if (typeof payload.detail === "string" && /^[a-z][a-z0-9_]{2,80}$/.test(payload.detail)) {
        code = payload.detail;
      }
    } catch {
      // Keep server response details out of the UI.
    }
    throw new Error(code);
  }
  return await response.json() as T;
}

export function getManagedUsers(query = ""): Promise<ManagedUsersResponse> {
  const params = new URLSearchParams({ limit: "100", offset: "0" });
  if (query.trim()) params.set("q", query.trim());
  return request(`/api/admin/users?${params.toString()}`);
}

export function getAdminRegions(): Promise<{ regions: AdminRegion[] }> {
  return request("/api/admin/regions");
}

export function updateManagedUser(
  userId: number,
  update: Partial<Pick<ManagedUser, "platformRole" | "additionalRegions" | "isActive">>,
): Promise<{ user: ManagedUser }> {
  const body: Record<string, unknown> = {};
  if (update.platformRole !== undefined) body.platformRole = update.platformRole;
  if (update.additionalRegions !== undefined) body.additionalRegions = update.additionalRegions;
  if (update.isActive !== undefined) body.isActive = update.isActive;
  return request(`/api/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
