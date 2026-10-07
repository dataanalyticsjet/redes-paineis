export interface ViewerRegionScope {
  role: "matrix" | "regional";
  organizational_scope?: "matrix" | "regional" | "base";
  region: string | null;
  home_region?: string | null;
}

export function initialRegionSelection(
  regions: string[],
  identity: ViewerRegionScope | null,
): Set<string> {
  if (!identity || identity.organizational_scope === "matrix" || identity.role === "matrix") {
    return new Set(regions);
  }

  const homeRegion = (identity.home_region ?? identity.region)?.trim().toUpperCase();
  const selected = regions.find((region) => region.trim().toUpperCase() === homeRegion);
  return new Set(selected ? [selected] : regions.slice(0, 1));
}
