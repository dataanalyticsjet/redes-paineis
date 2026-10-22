import { invalidateDashboardDataCache } from "./dashboard-data-cache.ts";

let revision: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export function currentMappingRevision(): string | null { return revision; }
export function mappingGeneration(): number { return generation; }
export function acceptMappingRevision(value: string): void {
  if (!/^[0-9a-f-]{36}(?::[0-9a-f]{64})?$/i.test(value)) throw new Error("mapping_revision_invalid");
  if (revision === value) return;
  const changed = revision !== null;
  revision = value;
  if (!changed) return;
  generation += 1;
  invalidateDashboardDataCache("base_mapping_official");
  for (const listener of listeners) listener();
}
export function subscribeMappingRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function resetMappingRevision(): void {
  revision = null;
  generation += 1;
  invalidateDashboardDataCache("base_mapping_official");
}
export function assertMappingGeneration(expected: number): void {
  if (generation !== expected) throw new Error("mapping_revision_changed");
}
export function isOrganizationalDataPath(path: string): boolean {
  const pathname = new URL(path, "http://new-bi.local").pathname;
  return pathname.startsWith("/api/v2/") && !pathname.startsWith("/api/v2/base-mapping/");
}

export function monitorMappingRevision(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  onChange: () => void,
  environment: { setInterval: (callback: () => void, ms: number) => unknown; clearInterval: (id: unknown) => void;
    addFocus: (callback: () => void) => void; removeFocus: (callback: () => void) => void },
): () => void {
  let active = true;
  let pending = false;
  const controller = new AbortController();
  const unsubscribe = subscribeMappingRevision(onChange);
  const check = () => {
    if (!active || pending) return;
    pending = true;
    const startingRevision = revision;
    const startingGeneration = generation;
    void fetcher("/api/v2/base-mapping/revision", { method: "GET", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async response => {
        if (!response.ok) return; // Authorization failures are handled centrally; network errors don't grant/revoke scope.
        const result = await response.json() as { revision?: unknown };
        if (active && typeof result.revision === "string" && generation === startingGeneration &&
            (revision === startingRevision || result.revision === revision)) acceptMappingRevision(result.revision);
      }).catch(() => undefined).finally(() => { pending = false; });
  };
  check();
  const timer = environment.setInterval(check, 30_000);
  environment.addFocus(check);
  return () => { active = false; controller.abort(); unsubscribe(); environment.clearInterval(timer); environment.removeFocus(check); };
}

/** Legacy entries have no type. Known PA/DC/SC never count as operational bases. */
export function isOperationalMappedBase(record: object): boolean {
  const type = (record as { mapped_unit_type?: unknown }).mapped_unit_type;
  return type == null || type === "OWN" || type === "FRANCHISE";
}
