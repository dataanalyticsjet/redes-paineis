export type OrganizationalRegionStatus =
  | "RESOLVED"
  | "UNKNOWN"
  | "AMBIGUOUS"
  | "SYNC_FAILED";

export function organizationalRegionLabel(
  regionCode: string | null | undefined,
  status: OrganizationalRegionStatus | string | null | undefined,
  unknownLabel: string,
): string {
  const code = regionCode?.trim();
  if (code && (status === "RESOLVED" || status === "SYNC_FAILED")) return code;
  return unknownLabel;
}
