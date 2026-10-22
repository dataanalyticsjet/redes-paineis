import { currentMappingRevision, mappingGeneration, acceptMappingRevision, assertMappingGeneration, isOrganizationalDataPath } from "./data-foundation/mapping-revision.ts";
import { invalidateDashboardDataCache } from "./data-foundation/dashboard-data-cache.ts";

type ViteImportMeta = ImportMeta & {
  env?: { VITE_API_BASE_URL?: string };
};

const API_BASE_URL =
  ((import.meta as ViteImportMeta).env?.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export interface ProtectedApiAuthorizationFailure {
  path: string;
  status: 401 | 403;
}

type ProtectedApiAuthorizationFailureListener = (failure: ProtectedApiAuthorizationFailure) => void;
const protectedApiAuthorizationFailureListeners = new Set<ProtectedApiAuthorizationFailureListener>();

export function subscribeToProtectedApiAuthorizationFailure(
  listener: ProtectedApiAuthorizationFailureListener,
): () => void {
  protectedApiAuthorizationFailureListeners.add(listener);
  return () => protectedApiAuthorizationFailureListeners.delete(listener);
}

function isProtectedDataApiPath(path: string): boolean {
  let pathname = path;
  try {
    pathname = new URL(path, "http://new-bi.local").pathname;
  } catch {
    pathname = path.split("?", 1)[0] ?? path;
  }
  return pathname.startsWith("/api/v2/") ||
    pathname === "/api/workbook" ||
    pathname.startsWith("/api/data-sources/");
}

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const organizational = (init?.method ?? "GET") === "GET" && isOrganizationalDataPath(path);
  const expectedGeneration = mappingGeneration();
  const headers = new Headers(init?.headers);
  const revision = currentMappingRevision();
  if (organizational && revision) headers.set("X-Doomsday-Revision", revision);
  return fetch(apiUrl(path), { ...init, headers, credentials: "include" }).then((response) => {
    if ((response.status === 401 || response.status === 403) && isProtectedDataApiPath(path)) {
      invalidateDashboardDataCache();
      const failure: ProtectedApiAuthorizationFailure = { path, status: response.status };
      for (const listener of protectedApiAuthorizationFailureListeners) {
        try {
          listener(failure);
        } catch {
          // A UI listener must never change the API response observed by its caller.
        }
      }
    }
    if (organizational) {
      assertMappingGeneration(expectedGeneration);
      const observed = response.headers.get("X-Doomsday-Revision");
      const activeRevision = currentMappingRevision();
      if (observed && activeRevision && activeRevision !== revision && observed !== activeRevision) {
        throw new Error("mapping_revision_changed");
      }
      if (observed) acceptMappingRevision(observed);
      assertMappingGeneration(expectedGeneration);
      if (response.ok && response.body) {
        const guarded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { assertMappingGeneration(expectedGeneration); controller.enqueue(chunk); },
          flush() { assertMappingGeneration(expectedGeneration); },
        }));
        return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
    }
    return response;
  });
}
