export type DashboardDataSourceAvailability = {
  sourceId: string;
  status: "available" | "unpublished";
  publicationId: string | null;
  publishedAt: string | null;
  rowCount: number | null;
  version?: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type DashboardAvailabilityState =
  | { status: "idle" }
  | { status: "loading" | "restricted" | "unavailable"; sourceId: string }
  | { status: "ready"; data: DashboardDataSourceAvailability }
  | { status: "unpublished"; data: DashboardDataSourceAvailability };
