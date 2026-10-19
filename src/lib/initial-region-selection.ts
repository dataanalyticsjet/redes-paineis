export interface ViewerRegionScope {
  role: "matrix" | "regional" | "unknown";
  organizational_scope?: "matrix" | "regional" | "base" | "unknown";
  region: string | null;
  home_region?: string | null;
}

export function initialRegionSelection(
  regions: string[],
  identity: ViewerRegionScope | null,
): Set<string> {
  if (identity?.role === "unknown" || identity?.organizational_scope === "unknown") {
    return new Set();
  }
  if (!identity || identity.organizational_scope === "matrix" || identity.role === "matrix") {
    return new Set(regions);
  }

  const homeRegion = (identity.home_region ?? identity.region)?.trim().toUpperCase();
  const selected = regions.find((region) => region.trim().toUpperCase() === homeRegion);
  return new Set(selected ? [selected] : regions.slice(0, 1));
}
