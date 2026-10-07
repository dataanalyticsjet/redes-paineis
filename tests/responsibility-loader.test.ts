import assert from "node:assert/strict";
import test from "node:test";
import { readResponsibilityWorkbookResponse } from "../src/lib/responsibility-loader.ts";
import { officialRgmForRegion, responsibilityForBase, resolveResponsibilityForBase, rmAreaForBase, UNASSIGNED_RM_AREA } from "../src/lib/responsibility.ts";

const headers = ["Regional", "UF", "Região RM", "Responsável Rm", "Código da base", "Nome da base", "Descrição"];
const rows = [
  { Regional: "PR", UF: "PR", "Região RM": "PR-CWB", "Responsável Rm": "Diego Souza Braga Da Silva", "Código da base": "1", "Nome da base": "F MGR 02-PR", Descrição: "Própria" },
  { Regional: "GP", UF: "GO", "Região RM": "GP-GO", "Responsável Rm": "张文娟 Wenjuan Zhang (Nanda)", "Código da base": "2", "Nome da base": "F RVD 02-GO", Descrição: "Própria" },
  { Regional: "RJ", UF: "ES", "Região RM": "RJ-ESN", "Responsável Rm": "高洋 Yang Gao (Sunny)", "Código da base": "3", "Nome da base": "CLN -ES", Descrição: "Própria" },
  { Regional: "SR", UF: "SC", "Região RM": "SR-SC", "Responsável Rm": "樊善方 Shanfang Fan (Sean Fan)", "Código da base": "4", "Nome da base": "BNU -SC", Descrição: "Própria" },
  { Regional: "SR", UF: "RS", "Região RM": "SR-RS", "Responsável Rm": "周正军 Zhengjun Zhou (Victor)", "Código da base": "5", "Nome da base": "CQA -RS", Descrição: "Própria" },
];
const parsed = {
  sheetName: "Ativas",
  headers,
  rows,
  statusColumns: [],
  metadata: { sheetNames: ["Ativas"], headerRow: 1, rowCount: rows.length, columnCount: headers.length, columns: [], date1904: false },
  warnings: [],
};

test("reads the production responsibilityList response and resolves official RM areas", async () => {
  const response = new Response(JSON.stringify({
    workbook: { fileName: "De_para DoomsDay.xlsx", updatedAt: "2026-10-06T00:00:00Z", parsed },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await readResponsibilityWorkbookResponse(response);

  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  assert.deepEqual(
    [
      ["F MGR 02-PR", responsibilityForBase(result.data, "F MGR 02-PR").rm, rmAreaForBase(result.data, "F MGR 02-PR")],
      ["F RVD 02-GO", responsibilityForBase(result.data, "F RVD 02-GO").rm, rmAreaForBase(result.data, "F RVD 02-GO")],
      ["CLN -ES", responsibilityForBase(result.data, "CLN -ES").rm, rmAreaForBase(result.data, "CLN -ES")],
      ["BNU -SC", responsibilityForBase(result.data, "BNU -SC").rm, rmAreaForBase(result.data, "BNU -SC")],
      ["CQA -RS", responsibilityForBase(result.data, "CQA -RS").rm, rmAreaForBase(result.data, "CQA -RS")],
    ],
    [
      ["F MGR 02-PR", "Diego Souza Braga Da Silva", "PR-CWB"],
      ["F RVD 02-GO", "张文娟 Wenjuan Zhang (Nanda)", "GP-GO"],
      ["CLN -ES", "高洋 Yang Gao (Sunny)", "RJ-ESN"],
      ["BNU -SC", "樊善方 Shanfang Fan (Sean Fan)", "SR-SC"],
      ["CQA -RS", "周正军 Zhengjun Zhou (Victor)", "SR-RS"],
    ],
  );
  assert.deepEqual(
    [
      officialRgmForRegion("PR"),
      officialRgmForRegion("GP"),
      officialRgmForRegion("RJ"),
      officialRgmForRegion("SR"),
    ],
    ["@高俊波", "@王存超 CUNCHAO WANG（Wagner）", "@毕富有 FUYOU BI（Jason）", "董文彤 WENTONG DONG (Winta)"],
  );
});

test("missing or invalid responsibilityList is detectable and never invents an RM area", async () => {
  const missing = await readResponsibilityWorkbookResponse(new Response(JSON.stringify({ workbook: null }), { status: 200 }));
  assert.deepEqual(missing, { status: "missing", data: null });
  assert.equal(rmAreaForBase(missing.data, "CARAP-SP"), UNASSIGNED_RM_AREA);
  assert.equal(resolveResponsibilityForBase(missing.data, "CARAP-SP").source, "legado");

  const invalid = await readResponsibilityWorkbookResponse(new Response(JSON.stringify({ workbook: { fileName: "bad.xlsx", parsed: { headers: [], rows: [] } } }), { status: 200 }));
  assert.deepEqual(invalid, { status: "invalid", data: null });
  assert.equal(rmAreaForBase(invalid.data, "CARAP-SP"), UNASSIGNED_RM_AREA);
});

test("responsibilityList HTTP and network failures have explicit load states", async () => {
  assert.deepEqual(await readResponsibilityWorkbookResponse(null), { status: "request-failed", data: null });
  assert.deepEqual(await readResponsibilityWorkbookResponse(new Response(null, { status: 503 })), {
    status: "http-error", data: null, httpStatus: 503,
  });
});
