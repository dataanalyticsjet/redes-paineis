import {
  officialRgmForRegion,
  UNASSIGNED_RGM,
  UNASSIGNED_RM,
  UNASSIGNED_RM_AREA,
} from "../responsibility.ts";

export const V2_UNASSIGNED_REGION = "Sem regional";

export interface PublishedBaseMappingFields extends Record<string, unknown> {
  reported_region?: unknown;
  resolved_base_code?: unknown;
  mapping_resolution?: unknown;
  effective_base_code?: unknown;
  effective_mapping_resolution?: unknown;
  mapping_match_method?: unknown;
  mapped_base_name?: unknown;
  mapped_region?: unknown;
  mapped_uf?: unknown;
  mapped_rm_area?: unknown;
  mapped_rm?: unknown;
}

export interface PublishedRegionalAssignment {
  effective_base_name: string;
  effective_region: string;
  effective_uf: string | null;
  effective_rm_area: string;
  effective_rm: string;
  effective_rgm: string;
  mapping_is_approved: boolean;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * V2 facts retain their persisted fields and expose a read-time effective
 * mapping from the current published map. Code matches, unique exact/normalized
 * name matches, and explicit manual decisions can change grouping and
 * responsibility. Unresolved rows stay unclassified instead of inheriting a
 * possibly stale source region.
 */
export function resolvePublishedRegionalAssignment(
  record: PublishedBaseMappingFields,
): PublishedRegionalAssignment {
  const resolution = clean(record.effective_mapping_resolution ?? record.mapping_resolution).toUpperCase();
  const resolvedBaseCode = clean(record.effective_base_code ?? record.resolved_base_code);
  const mappedRegion = clean(record.mapped_region);
  const sourceBaseNameRaw = String(record.source_base_name ?? "");
  const sourceBaseName = clean(sourceBaseNameRaw);
  const mappedBaseName = clean(record.mapped_base_name);
  const mappingIsApproved = Boolean(
    resolvedBaseCode && mappedRegion &&
    (resolution === "NAME_APPROVED" || resolution === "CODE_MATCH"),
  );
  const effectiveRegion = mappingIsApproved ? mappedRegion : V2_UNASSIGNED_REGION;

  return {
    effective_base_name: mappingIsApproved ? mappedBaseName || sourceBaseName : sourceBaseNameRaw,
    effective_region: effectiveRegion,
    effective_uf: mappingIsApproved ? clean(record.mapped_uf) || null : null,
    effective_rm_area: mappingIsApproved ? clean(record.mapped_rm_area) || UNASSIGNED_RM_AREA : UNASSIGNED_RM_AREA,
    effective_rm: mappingIsApproved ? clean(record.mapped_rm) || UNASSIGNED_RM : UNASSIGNED_RM,
    effective_rgm: mappingIsApproved ? officialRgmForRegion(effectiveRegion) || UNASSIGNED_RGM : UNASSIGNED_RGM,
    mapping_is_approved: mappingIsApproved,
  };
}

/** Adds derived dimensions while preserving every original V2 field unchanged. */
export function withPublishedRegionalAssignment<T extends PublishedBaseMappingFields>(
  record: T,
): T & PublishedRegionalAssignment {
  return { ...record, ...resolvePublishedRegionalAssignment(record) };
}
