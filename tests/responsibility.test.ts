import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsibilityData,
  matchesResponsibility,
  normalizeBaseKey,
  officialRgmForRegion,
  registeredRegionForBase,
  rmAreaForBase,
  responsibilityForBase,
} from "../app/lib/responsibility.ts";
import type { ParsedWorkbook } from "../app/lib/workbook.ts";

function workbook(rows: ParsedWorkbook["rows"]): ParsedWorkbook {
  return {
    sheetName: "RM区域网点明细",
    headers: ["区域", "网点编号", "网点名称", "RM区域", "RM名称", "RM分组", "RM\n负责人"],
    rows,
    statusColumns: [],
    warnings: [],
  };
}

test("parses the Chinese responsibility columns and links a base to RM and RGM", () => {
  const data = buildResponsibilityData(workbook([
    {
      "区域": "SPS",
      "网点编号": 311428,
      "网点名称": "TEST-BASE-SPS",
      "RM区域": "SPS-CAP",
      "RM名称": "Rick",
      "RM分组": "产粮组",
      "RM\n负责人": "Ana",
    },
  ]), "responsaveis.xlsx");
  assert.deepEqual(responsibilityForBase(data, "TEST-BASE-SPS"), { rm: "Rick", rgm: "@熊志远 XIONG ZHIYUAN（Amos）" });
  assert.equal(registeredRegionForBase(data, "TEST-BASE-SPS", "SPN"), "SPS");
  assert.equal(rmAreaForBase(data, "TEST-BASE-SPS"), "SPS-CAP");
  assert.equal(data.records[0]?.baseCode, "311428");
});

test("uses the registered regional for a base and keeps the operational fallback when unmatched", () => {
  const data = buildResponsibilityData(workbook([
    { "区域": "MG", "网点名称": "F EXT-MG", "RM名称": "RM MG", "RM\n负责人": "RGM MG" },
  ]), "responsaveis.xlsx");
  assert.equal(registeredRegionForBase(data, "F EXT-MG", "SPN"), "MG");
  assert.equal(registeredRegionForBase(data, "BASE NOVA", "SPN"), "SPN");
});

test("prioritizes the official REGIONAL, BASE and RM columns and applies the regional RGM map", () => {
  const parsed: ParsedWorkbook = {
    sheetName: "Responsáveis",
    headers: ["REGIONAL", "BASE", "RM ", "RGM", "RM\n负责人"],
    rows: [{
      "REGIONAL": "MG",
      "BASE": "TEST-BASE-MG",
      "RM ": "Alex",
      "RGM": "Grupo oficial",
      "RM\n负责人": "Valor antigo que deve ser ignorado",
    }],
    statusColumns: [],
    warnings: [],
  };
  const data = buildResponsibilityData(parsed, "novo.xlsx");
  assert.equal(data.records[0]?.region, "MG");
  assert.equal(data.records[0]?.base, "TEST-BASE-MG");
  assert.equal(data.records[0]?.rm, "Alex");
  assert.equal(data.records[0]?.rgm, "@王龙 LONG WANG（Matt）");
});

test("uses the official RGM responsible for every configured regional", () => {
  assert.equal(officialRgmForRegion("SPS"), "@熊志远 XIONG ZHIYUAN（Amos）");
  assert.equal(officialRgmForRegion(" spn "), "@王龙 LONG WANG（Matt）");
  assert.equal(officialRgmForRegion("SPE"), "@李鑫亮 XINLIANG LI（Oliver）");
  assert.equal(officialRgmForRegion("RJ"), "@毕富有 FUYOU BI（Jason）");
  assert.equal(officialRgmForRegion("PR"), "@高俊波");
  assert.equal(officialRgmForRegion("MG"), "@王龙 LONG WANG（Matt）");
  assert.equal(officialRgmForRegion("GP"), "@王存超 CUNCHAO WANG（Wagner）");
  assert.equal(officialRgmForRegion("CE"), "@彭龙颂 LONGSONG PENG（Lucas）");
  assert.equal(officialRgmForRegion("BA"), "@董妍 (YAN SANTOS)");
  assert.equal(officialRgmForRegion("Sem regional"), undefined);
});

test("normalizes punctuation and keeps unmatched bases visible under fallback owners", () => {
  const data = buildResponsibilityData(workbook([
    { "网点名称": "S-IPRG-SP", "RM名称": "RM 1", "RM\n负责人": "RGM 1" },
  ]), "responsaveis.xlsx");
  assert.equal(normalizeBaseKey(" S IPRG–SP "), "SIPRGSP");
  assert.deepEqual(responsibilityForBase(data, "Base nova"), { rm: "Sem RM", rgm: "Sem RGM" });
  assert.equal(rmAreaForBase(data, "Base nova"), "Sem região do RM");
});

test("reads the new workbook's RM responsible name and RM region columns", () => {
  const parsed: ParsedWorkbook = {
    sheetName: "Detalhamento de Base por Região",
    headers: ["Regional\n区域", "Nome da Base\n网点名称", "RM临时名称", "Região do RM\nRM区域", "Responsável do RM\nRM负责人", "RM"],
    rows: [{
      "Regional\n区域": "SPS",
      "Nome da Base\n网点名称": "TEST-BASE-SPS",
      "RM临时名称": "SPS1",
      "Região do RM\nRM区域": "SPS-CAP",
      "Responsável do RM\nRM负责人": "Rick",
      "RM": "—",
    }],
    statusColumns: [],
    warnings: [],
  };
  const data = buildResponsibilityData(parsed, "novo.xlsx");
  assert.equal(data.records[0]?.rm, "Rick");
  assert.equal(data.records[0]?.rmArea, "SPS-CAP");
  assert.deepEqual(data.rmAreas, ["SPS-CAP"]);
});

test("filters every base by the selected RM and RGM intersection", () => {
  const data = buildResponsibilityData(workbook([
    { "网点名称": "BASE-A", "RM名称": "RM A", "RM\n负责人": "RGM 1" },
    { "网点名称": "BASE-B", "RM名称": "RM B", "RM\n负责人": "RGM 2" },
  ]), "responsaveis.xlsx");
  assert.equal(matchesResponsibility(data, "BASE-A", new Set(["RM A"]), new Set(["RGM 1"])), true);
  assert.equal(matchesResponsibility(data, "BASE-B", new Set(["RM A"]), new Set(["RGM 1"])), false);
});

test("rejects a base assigned to conflicting owners", () => {
  assert.throws(() => buildResponsibilityData(workbook([
    { "网点名称": "BASE-A", "RM名称": "RM A", "RM\n负责人": "RGM 1" },
    { "网点名称": "BASE A", "RM名称": "RM B", "RM\n负责人": "RGM 1" },
  ]), "responsaveis.xlsx"), /responsáveis diferentes/);
});
