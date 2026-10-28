export type OrganizationalRegionStatus =
  | "RESOLVED"
  | "UNKNOWN"
  | "AMBIGUOUS"
  | "SYNC_FAILED";

export function organizationalRegionLabel(
  regionCode: string | null | undefined,
  status: OrganizationalRegionStatus | string | null | undefined,
  unknownLabel: string,
  dataScopeSource?: string | null,
): string {
  const code = regionCode?.trim();
  if (
    code &&
    status === "RESOLVED" &&
    (!dataScopeSource || dataScopeSource === "feishu" || dataScopeSource === "feishu_v2")
  ) return code;
  return unknownLabel;
}
