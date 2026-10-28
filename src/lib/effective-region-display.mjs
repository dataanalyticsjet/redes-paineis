export function effectiveRegionDisplay(identity, { pendingLabel, unavailable = false }) {
  if (unavailable) return pendingLabel;

  const isResolvedMatrix = identity?.region_resolution_status === "RESOLVED" &&
    identity?.organizational_region_code === "MATRIZ";
  if (isResolvedMatrix) return "MATRIZ";

  const regions = Array.isArray(identity?.effective_regions)
    ? identity.effective_regions.filter((region) => typeof region === "string" && region.trim())
    : [];
  const isEffectiveRegionalOverride =
    (identity?.effective_scope_source === "ADMIN_OVERRIDE" || identity?.effective_scope_source === "LEGACY_GRANT") &&
    identity?.organizational_scope === "regional" && regions.length > 0;
  if (isEffectiveRegionalOverride) return regions.join(", ");

  if (
    identity?.region_resolution_status === "RESOLVED" &&
    typeof identity?.organizational_region_code === "string" &&
    identity.organizational_region_code.trim() &&
    identity.organizational_region_code !== "MATRIZ"
  ) {
    return identity.organizational_region_code;
  }

  return pendingLabel;
}
