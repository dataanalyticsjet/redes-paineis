import type { ParsedWorkbook } from "./workbook";
import { UPDATED_RM_BY_BASE } from "./updated-rm.ts";

export const UNASSIGNED_RM = "Sem RM";
export const UNASSIGNED_RGM = "Sem RGM";
export const UNASSIGNED_RM_AREA = "Sem região do RM";

export const OFFICIAL_RGM_BY_REGION: Readonly<Record<string, string>> = Object.freeze({
  SPS: "@熊志远 XIONG ZHIYUAN（Amos）",
  SPN: "@王龙 LONG WANG（Matt）",
  SPE: "@李鑫亮 XINLIANG LI（Oliver）",
  RJ: "@毕富有 FUYOU BI（Jason）",
  PR: "@高俊波",
  MG: "@王龙 LONG WANG（Matt）",
  GP: "@王存超 CUNCHAO WANG（Wagner）",
  CE: "@彭龙颂 LONGSONG PENG（Lucas）",
  BA: "@董妍 (YAN SANTOS)",
});

export interface ResponsibilityRecord {
  region: string;
  baseCode: string;
  base: string;
  rmArea: string;
  rm: string;
  rmGroup: string;
  rgm: string;
}

export interface ResponsibilityData {
  parsed: ParsedWorkbook;
  fileName: string;
  records: ResponsibilityRecord[];
  rms: string[];
  rgms: string[];
  rmAreas: string[];
  byBase: Map<string, ResponsibilityRecord>;
  byExactBaseName: Map<string, ResponsibilityRecord>;
  exactNameJoinOnly: boolean;
  updatedAt?: string;
}

export type ResponsibilityResolutionSource = "de-para" | "legado" | "não encontrado";

export interface ResponsibilityResolution {
  rm: string;
  rgm: string;
  rmArea: string;
  source: ResponsibilityResolutionSource;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function responsibleName(value: unknown, fallback: string): string {
  const text = clean(value);
  return !text || text === "—" || text === "-" ? fallback : text;
}

export function officialRgmForRegion(value: unknown): string | undefined {
  const region = clean(value).toUpperCase();
  return OFFICIAL_RGM_BY_REGION[region];
}

function normalizedHeader(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "").toLowerCase();
}

function findHeader(headers: string[], candidates: string[]): string {
  const normalized = candidates.map(normalizedHeader);
  for (const candidate of normalized) {
    const exact = headers.find((header) => normalizedHeader(header) === candidate);
    if (exact) return exact;
    if (candidate.length < 4) continue;
    const partial = headers.find((header) => normalizedHeader(header).includes(candidate));
    if (partial) return partial;
  }
  return "";
}

export function normalizeBaseKey(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Conservative name key for joining a monitoring base to an official de-para.
 * Keeps punctuation and words intact; only removes invisible Excel characters,
 * normalizes NBSP/whitespace and spaces around a hyphen, and folds case.
 */
export function normalizeMappedBaseName(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function buildResponsibilityData(
  parsed: ParsedWorkbook,
  fileName: string,
  updatedAt?: string,
): ResponsibilityData {
  // Prefer the explicit name column before the generic "Base" alias, which
  // can otherwise match "Código da base" in the official de-para sheet.
  const baseColumn = findHeader(parsed.headers, ["网点名称", "Nome da base", "Base"]);
  const baseCodeColumn = findHeader(parsed.headers, ["网点编号", "Código da base", "Codigo da base", "Código base", "Codigo base"]);
  const regionColumn = findHeader(parsed.headers, ["区域", "Regional"]);
  const rmAreaColumn = findHeader(parsed.headers, ["Região RM", "Região do RM", "Nome da Região do RM", "RM区域", "Área RM", "Area RM"]);
  const rmTemporaryColumn = findHeader(parsed.headers, ["RM临时名称"]);
  const rmResponsibleColumn = findHeader(parsed.headers, ["Responsável do RM", "Responsável RM", "RM负责人"]);
  const rmColumn = rmTemporaryColumn && rmResponsibleColumn
    ? rmResponsibleColumn
    : findHeader(parsed.headers, ["RM名称"]) || findHeader(parsed.headers, ["RM"]) || rmResponsibleColumn || rmTemporaryColumn;
  const rmGroupColumn = findHeader(parsed.headers, ["RM分组", "Grupo RM"]);
  const rgmColumn = findHeader(parsed.headers, ["RGM", "RGM负责人", "RGM Responsável"]);
  const exactNameJoinOnly = Boolean(
    rmAreaColumn && rmResponsibleColumn && baseCodeColumn &&
    parsed.headers.some((header) => normalizedHeader(header) === normalizedHeader("Descrição")),
  );
  if (!baseColumn || !rmColumn || (!rgmColumn && !regionColumn)) {
    throw new Error("A planilha de responsáveis precisa conter Base, RM e RGM ou Regional para localizar o RGM oficial.");
  }

  const byBase = new Map<string, ResponsibilityRecord>();
  const byExactBaseName = new Map<string, ResponsibilityRecord>();
  for (const row of parsed.rows) {
    const base = clean(row[baseColumn]);
    const key = normalizeBaseKey(base);
    const exactKey = normalizeMappedBaseName(base);
    if (!key || !exactKey) continue;
    const region = regionColumn ? clean(row[regionColumn]) || "Sem regional" : "Sem regional";
    const record: ResponsibilityRecord = {
      region,
      baseCode: baseCodeColumn ? clean(row[baseCodeColumn]) : "",
      base,
      rmArea: rmAreaColumn ? clean(row[rmAreaColumn]) || UNASSIGNED_RM_AREA : UNASSIGNED_RM_AREA,
      // Keep the loaded row intact. The legacy static map is consulted only
      // after an exact official-name lookup fails in responsibilityForBase.
      rm: responsibleName(row[rmColumn], UNASSIGNED_RM),
      rmGroup: rmGroupColumn ? clean(row[rmGroupColumn]) : "",
      rgm: officialRgmForRegion(region) || responsibleName(rgmColumn ? row[rgmColumn] : "", UNASSIGNED_RGM),
    };
    const current = byBase.get(key);
    if (!exactNameJoinOnly && current && (current.rm !== record.rm || current.rgm !== record.rgm)) {
      throw new Error(`A base ${base} aparece ligada a responsáveis diferentes.`);
    }
    const exactCurrent = byExactBaseName.get(exactKey);
    if (exactCurrent && (exactCurrent.rm !== record.rm || exactCurrent.rgm !== record.rgm || exactCurrent.rmArea !== record.rmArea)) {
      throw new Error(`A base ${base} aparece ligada a responsáveis diferentes.`);
    }
    byBase.set(key, record);
    byExactBaseName.set(exactKey, record);
  }
  const records = [...(exactNameJoinOnly ? byExactBaseName.values() : byBase.values())]
    .sort((a, b) => a.base.localeCompare(b.base, "pt-BR", { numeric: true }));
  if (records.length === 0) throw new Error("Nenhuma base foi encontrada na planilha de responsáveis.");
  const rms = [...new Set(records.map((record) => record.rm))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const rgms = [...new Set(records.map((record) => record.rgm))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const rmAreas = [...new Set(records.map((record) => record.rmArea))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return { parsed, fileName, records, rms, rgms, rmAreas, byBase, byExactBaseName, exactNameJoinOnly, updatedAt };
}

function recordForBase(data: ResponsibilityData | null, base: string): ResponsibilityRecord | undefined {
  if (!data) return undefined;
  const exact = data.byExactBaseName.get(normalizeMappedBaseName(base));
  if (exact || data.exactNameJoinOnly) return exact;
  return data.byBase.get(normalizeBaseKey(base));
}

export function rmAreaForBase(data: ResponsibilityData | null, base: string): string {
  return recordForBase(data, base)?.rmArea || UNASSIGNED_RM_AREA;
}

/** Resolve a base using the official name join first and the legacy exact key map second. */
export function resolveResponsibilityForBase(data: ResponsibilityData | null, base: string): ResponsibilityResolution {
  const record = recordForBase(data, base);
  const hasOfficialNameMatch = Boolean(data?.exactNameJoinOnly && record);
  if (record && record.rm !== UNASSIGNED_RM) {
    return {
      rm: record.rm,
      rgm: record.rgm,
      rmArea: record.rmArea || UNASSIGNED_RM_AREA,
      source: hasOfficialNameMatch ? "de-para" : "legado",
    };
  }

  // A matching official row is authoritative even when its RM field is blank
  // or marked "-"; do not override that row with a coincidental legacy key.
  if (hasOfficialNameMatch && record) {
    return {
      rm: UNASSIGNED_RM,
      rgm: record.rgm || UNASSIGNED_RGM,
      rmArea: record.rmArea || UNASSIGNED_RM_AREA,
      source: "não encontrado",
    };
  }

  const legacyRm = responsibleName(UPDATED_RM_BY_BASE[normalizeBaseKey(base)], UNASSIGNED_RM);
  if (legacyRm !== UNASSIGNED_RM) {
    return { rm: legacyRm, rgm: record?.rgm || UNASSIGNED_RGM, rmArea: record?.rmArea || UNASSIGNED_RM_AREA, source: "legado" };
  }

  return {
    rm: UNASSIGNED_RM,
    rgm: record?.rgm || UNASSIGNED_RGM,
    rmArea: record?.rmArea || UNASSIGNED_RM_AREA,
    source: "não encontrado",
  };
}

export function responsibilityForBase(data: ResponsibilityData | null, base: string): { rm: string; rgm: string } {
  const { rm, rgm } = resolveResponsibilityForBase(data, base);
  return { rm, rgm };
}

/** Monitoring keeps RM from the resolver but always sources RGM from the Excel regional. */
export function monitoringResponsibilityForBase(
  data: ResponsibilityData | null,
  base: string,
  regionalOrigin: string,
): ResponsibilityResolution {
  const assignment = resolveResponsibilityForBase(data, base);
  return { ...assignment, rgm: officialRgmForRegion(regionalOrigin) ?? assignment.rgm };
}

export function registeredRegionForBase(data: ResponsibilityData | null, base: string, fallback: string): string {
  return recordForBase(data, base)?.region || fallback;
}

export function matchesResponsibility(
  data: ResponsibilityData | null,
  base: string,
  selectedRms: ReadonlySet<string>,
  selectedRgms: ReadonlySet<string>,
): boolean {
  const { rm, rgm } = responsibilityForBase(data, base);
  return selectedRms.has(rm) && selectedRgms.has(rgm);
}

export function responsibilityOptions(data: ResponsibilityData | null, bases: Iterable<string>) {
  const rms = new Set<string>();
  const rgms = new Set<string>();
  const rmAreas = new Set<string>();
  for (const base of bases) {
    const responsibility = responsibilityForBase(data, base);
    rms.add(responsibility.rm);
    rgms.add(responsibility.rgm);
    rmAreas.add(rmAreaForBase(data, base));
  }
  return {
    rms: [...rms].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rgms: [...rgms].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rmAreas: [...rmAreas].sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}
