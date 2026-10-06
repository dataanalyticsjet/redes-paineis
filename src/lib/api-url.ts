type ViteImportMeta = ImportMeta & {
  env?: { VITE_API_BASE_URL?: string };
};

const API_BASE_URL =
  ((import.meta as ViteImportMeta).env?.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: "include" });
}
