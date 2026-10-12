import { dashboardCards, type DashboardCategory, type DashboardPanel } from "./dashboard-catalog.ts";
import type { DashboardDataSourceAvailability } from "../../lib/data-foundation/dashboard-availability.ts";

export const DASHBOARD_V2_SOURCE_BY_PANEL: Partial<Record<DashboardPanel, string>> = {
  monitoramento: "collection_monitoring",
  taxa: "collection_rate",
  sellers: "jt_monitoring",
  movimentacao: "no_movement",
  bipagem: "pdd_collection_failure",
};

export function dashboardHasV2Source(panelId: DashboardPanel): boolean {
  return Object.hasOwn(DASHBOARD_V2_SOURCE_BY_PANEL, panelId);
}

export function dashboardCardsForCategory(category: DashboardCategory) {
  return dashboardCards.filter((card) =>
    card.category === category &&
    (category !== "first-mile" || dashboardHasV2Source(card.id)),
  );
}

export type DashboardAvailabilityFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadDashboardSourceAvailability(
  panelId: DashboardPanel,
  fetcher: DashboardAvailabilityFetcher,
  signal?: AbortSignal,
): Promise<DashboardDataSourceAvailability | null> {
  const sourceId = DASHBOARD_V2_SOURCE_BY_PANEL[panelId];
  if (!sourceId) return null;

  const response = await fetcher(
    `/api/v2/data-sources/${encodeURIComponent(sourceId)}/publications?limit=1&offset=0`,
    { method: "GET", cache: "no-store", signal },
  );
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403 ? "restricted" : "unavailable");
  }

  const payload = await response.json() as {
    sourceId?: unknown;
    total?: unknown;
    publications?: unknown;
  };
  if (payload.sourceId !== sourceId || !Array.isArray(payload.publications)) {
    throw new Error("invalid_response");
  }

  const publication = payload.publications[0] as Record<string, unknown> | undefined;
  if (!publication) {
    return { sourceId, status: "unpublished", publicationId: null, publishedAt: null, rowCount: null, periodStart: null, periodEnd: null };
  }

  if (
    typeof publication.publicationId !== "string" ||
    !Number.isSafeInteger(publication.visibleRowCount) ||
    Number(publication.visibleRowCount) < 0 ||
    !Number.isSafeInteger(publication.version) ||
    Number(publication.version) < 1 ||
    typeof publication.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(publication.publishedAt))
  ) {
    throw new Error("invalid_response");
  }

  const periodStart = publication.periodStart;
  const periodEnd = publication.periodEnd;
  if (
    (periodStart !== null && typeof periodStart !== "string") ||
    (periodEnd !== null && typeof periodEnd !== "string")
  ) {
    throw new Error("invalid_response");
  }

  return {
    sourceId,
    status: "available",
    publicationId: publication.publicationId,
    publishedAt: publication.publishedAt,
    rowCount: Number(publication.visibleRowCount),
    version: Number(publication.version),
    periodStart: periodStart as string | null,
    periodEnd: periodEnd as string | null,
  };
}
