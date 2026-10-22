import test from "node:test";
import assert from "node:assert/strict";
import { mapCollectionMonitoringV2Record } from "../src/lib/data-foundation/collection-monitoring-v2-dashboard.ts";
import { loadCollectionMonitoringV2Retention, type CollectionMonitoringV2Record } from "../src/lib/data-foundation/collection-monitoring-v2.ts";
import { regionalRetentionModel, regionalRetentionMatrix } from "../src/lib/data-foundation/collection-monitoring-v2-retention.ts";

function row(date: string, region: string | null, planned: number, received: number, dispatched: number, arrived: number, origin = "JMS") {
  return mapCollectionMonitoringV2Record({ data_date: date, publication_id: "pub", source_row_no: 1, reported_origin_region: "IGNORED", source_base_name: "PDD", order_origin: origin, mapping_resolution: region ? "NAME_APPROVED" : "UNMAPPED", resolved_base_code: region ? region + "001" : null, effective_base_code: region ? region + "001" : null, effective_mapping_resolution: region ? "NAME_APPROVED" : "UNMAPPED", mapped_region: region, expected_dropoff: planned, expected_pickup: 0, status_received_at_base: received, status_dispatched_from_base: dispatched, arrived_sorting_center: arrived, arrived_sc: 900000 } as CollectionMonitoringV2Record);
}

test("three daily national totals reconcile official workbook; Q is distinct from T and snapshots are not summed", () => {
  const rows = [row("2026-10-20", "SPE", 1999087, 5238, 974, 8520), row("2026-10-21", "SPE", 1784090, 12760, 3781, 19315), row("2026-10-22", "SPE", 1795899, 35029, 4946, 16773)];
  const model = regionalRetentionModel(rows, {dateFrom:"2026-10-20",dateTo:"2026-10-22"});
  assert.deepEqual(model.total.values.retentionTotal, [14732,35856,56748]);
  assert.deepEqual(model.total.values.arrivedAtCenter, [8520,19315,16773]);
  assert.equal(model.total.planned,1795899);
  assert.equal(model.total.variations.retentionTotal,(56748-35856)/35856);
  assert.equal(model.rows[0].rgm,"@李鑫亮 XINLIANG LI（Oliver）");
  const matrix=regionalRetentionMatrix(model);
  assert.equal(matrix[0].length,19);
  assert.deepEqual(matrix.at(-1)?.slice(0,7),["Total geral","—",1795899,14732,35856,56748,(56748-35856)/35856]);
});

test("latest three available filtered dates; missing region/day differs from zero and division by zero is unavailable", () => {
  const rows=[row("2026-10-01","CE",1,1,0,0),row("2026-10-18","CE",10,5,0,0),row("2026-10-20","CE",10,0,0,0),row("2026-10-22","CE",20,0,0,0),row("2026-10-22",null,5,2,0,0),row("2026-10-20","HQ",5,1,0,0)];
  const model=regionalRetentionModel(rows,{dateFrom:"2026-10-18",dateTo:"2026-10-22"});
  assert.deepEqual(model.dates,["2026-10-18","2026-10-20","2026-10-22"]);
  assert.equal(model.rows.at(-1)?.region,"Sem regional");
  assert.deepEqual(model.rows.find(r=>r.region==="CE")?.values.retentionTotal,[5,0,0]);
  assert.equal(model.rows.find(r=>r.region==="CE")?.variations.retentionTotal,null);
  assert.deepEqual(model.rows.find(r=>r.region==="HQ")?.values.retentionTotal,[null,1,null]);
  assert.equal(model.rows.find(r=>r.region==="HQ")?.rgm,"Sem RGM");
  const one=regionalRetentionModel(rows,{region:"CE",dateFrom:"2026-10-22"});
  assert.equal(one.rows.length,1);assert.equal(one.dates.length,1);assert.equal(regionalRetentionMatrix(one)[0].length,11);assert.equal(one.total.variations.retentionTotal,null);
  assert.deepEqual(regionalRetentionModel(rows,{origin:"absent"}).rows,[]);
  assert.equal(regionalRetentionModel(rows,{region:"CE",base:"absent"}).total.planned,null);
});

test("regional totals close across all four measures under combined filters without dropping unmapped records", () => {
  const rows=[row("2026-10-22","SPE",100,1,2,3),row("2026-10-22","CE",50,4,5,6),row("2026-10-22",null,10,7,8,9),row("2026-10-22","CE",999,999,999,999,"OTHER")];
  const model=regionalRetentionModel(rows,{origin:"JMS",dateFrom:"2026-10-22",dateTo:"2026-10-22"});
  assert.equal(model.total.planned,160);assert.equal(model.total.values.retentionTotal[0],45);
  for(const key of ["retainedAtBase","dispatchedFromBase","arrivedAtCenter","retentionTotal"] as const) assert.equal(model.total.values[key][0],model.rows.reduce((sum,r)=>sum+(r.values[key][0]??0),0));
  assert.equal(regionalRetentionModel(rows,{origin:"JMS",region:"CE"}).total.planned,50);
});

test("aggregate loader uses only the dedicated V2 endpoint and blocks errors or incompatible responses", async () => {
  const calls:string[]=[];
  await loadCollectionMonitoringV2Retention({dateFrom:"2026-10-20",dateTo:"2026-10-22"},async(path)=>{calls.push(path);return new Response(JSON.stringify({sourceId:"collection_monitoring",contractVersion:2,aggregates:[]}));});
  assert.equal(calls.length,1);assert.match(calls[0],/collection-monitoring-v2\/regional-retention/);assert.match(calls[0],/date_from=2026-10-20/);assert.doesNotMatch(calls[0],/\/records/);
  await assert.rejects(loadCollectionMonitoringV2Retention({dateFrom:"2026-10-20",dateTo:"2026-10-22"},async()=>new Response("{}",{status:403})),/autorizado/);
  await assert.rejects(loadCollectionMonitoringV2Retention({dateFrom:"2026-10-20",dateTo:"2026-10-22"},async()=>new Response(JSON.stringify({sourceId:"collection_rate",contractVersion:3,aggregates:[]}))),/outra fonte/);
});

test("rendered table has two grouped header rows, four measures, dynamic dates and reconciled export columns", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = await import("typescript");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const componentUrl = new URL("../src/features/dashboards/collection-monitoring-v2-regional-retention.tsx", import.meta.url);
  const require = createRequire(import.meta.url);
  const source = await readFile(componentUrl,"utf8");
  let output = transpileModule(source,{compilerOptions:{jsx:JsxEmit.ReactJSX,module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText;
  output = output.replace(/from "([^"]+)"/g, (_all, specifier: string) => {
    const target = specifier.startsWith(".") ? new URL(specifier + (/\.tsx?$/.test(specifier) ? "" : ".ts"),componentUrl).href : pathToFileURL(require.resolve(specifier)).href;
    return `from ${JSON.stringify(target)}`;
  });
  const { CollectionMonitoringV2RegionalRetentionTable } = await import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
  const model=regionalRetentionModel([row("2026-10-20","SPE",100,1,2,3),row("2026-10-21","SPE",100,2,3,4),row("2026-10-22","SPE",100,3,4,5)],{});
  const html=renderToStaticMarkup(createElement(CollectionMonitoringV2RegionalRetentionTable,{t:(s:string)=>s,language:"pt",model,onExport:()=>{}}));
  assert.equal((html.match(/colSpan="4"/gi)??[]).length,4);
  assert.equal((html.match(/rowSpan="2"/gi)??[]).length,3);
  assert.equal((html.match(/scope="colgroup"/g)??[]).length,4);
  assert.match(html,/20 DE OUT\.|20 OUT\./);assert.match(html,/22 DE OUT\.|22 OUT\./);
  assert.match(html,/<tfoot>/);assert.match(html,/data-direction="up"/);assert.match(html,/Baixar Excel — todas as tabelas/);
  assert.equal((html.match(/<td[ >]/g)??[]).length,38);
  const empty=renderToStaticMarkup(createElement(CollectionMonitoringV2RegionalRetentionTable,{t:(s:string)=>s,language:"en",model:regionalRetentionModel([],{}),onExport:()=>{}}));
  assert.doesNotMatch(empty,/NaN|Infinity/);assert.match(empty,/disabled/);
});

test("all-table Excel retains the raw 23-column sheet and signed numeric retention variations", async () => {
  const {readFile}=await import("node:fs/promises");
  const {createRequire}=await import("node:module");
  const {pathToFileURL}=await import("node:url");
  const {transpileModule,ModuleKind,ScriptTarget}=await import("typescript");
  const require=createRequire(import.meta.url);
  const source=await readFile(new URL("../src/features/dashboards/collection-monitoring-v2.tsx",import.meta.url),"utf8");
  const start=source.indexOf("async function downloadExcel(");
  const end=source.indexOf("export function CollectionMonitoringV2Dashboard",start);
  let exported=source.slice(start,end).replace("async function downloadExcel(","export async function downloadExcel(");
  exported=exported.replace(/XLSX\.writeFile\(workbook, `monitoramento-coleta-v2_[\s\S]*?\{ compression: true \}\);/,"return workbook;");
  assert.doesNotMatch(exported,/XLSX\.writeFile/);
  const modelModule=new URL("../src/lib/data-foundation/collection-monitoring-v2-dashboard.ts",import.meta.url).href;
  const loaderModule=new URL("../src/lib/data-foundation/collection-monitoring-v2.ts",import.meta.url).href;
  exported=`import {collectionMonitoringV2BaseDetailMatrix,collectionMonitoringV2ExcelMatrix} from ${JSON.stringify(modelModule)};import {COLLECTION_MONITORING_V2_COLUMNS} from ${JSON.stringify(loaderModule)};`+exported;
  const output=transpileModule(exported,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replaceAll('"xlsx-js-style"',JSON.stringify(pathToFileURL(require.resolve("xlsx-js-style")).href));
  const {downloadExcel}=await import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
  const rows=[row("2026-10-21","SPE",10,4,3,2),row("2026-10-22","SPE",10,2,1,0)];
  const model=regionalRetentionModel(rows,{}),matrix=regionalRetentionMatrix(model);
  const workbook=await downloadExcel(rows,{},[],(s:string)=>s,[{name:"Retenção por regional",matrix,percentageColumns:[5,8,11,14]}]);
  const XLSX=require("xlsx-js-style");
  const raw=XLSX.utils.sheet_to_json(workbook.Sheets.Dados,{header:1});
  assert.equal(raw[0].length,23);assert.equal(raw.length,3);assert.deepEqual(workbook.SheetNames,["Resumo por base","Dados","Retenção por regional"]);
  const retained=workbook.Sheets["Retenção por regional"];
  assert.equal(retained.F3.v,(3-9)/9);assert.equal(retained.F3.z,"0.0%");
  assert.equal(retained.C3.v,10);assert.equal(retained.E3.v,3);
});

test("aggregate requests forward restrictive dimension filters, preserve counts and honor pre-cancellation", async () => {
  let path="";
  const response={sourceId:"collection_monitoring",contractVersion:2,aggregates:[{data_date:"2026-10-22",publication_id:"pub",region:"SPE",row_count:"2",expected_dropoff:100,expected_pickup:0,status_received_at_base:2,status_dispatched_from_base:3,arrived_sorting_center:4}]};
  const result=await loadCollectionMonitoringV2Retention({dateFrom:"2026-10-22",dateTo:"2026-10-22"},async(url)=>{path=url;return new Response(JSON.stringify(response));},undefined,{region:"SPE",rm:"RM One",base:"Mapped base",origin:"JMS",rgmRegions:["SPE"]});
  const query=new URL(path,"http://localhost").searchParams;
  assert.equal(query.get("region"),"SPE");assert.equal(query.get("rm"),"RM One");assert.equal(query.get("base"),"Mapped base");assert.equal(query.get("origin"),"JMS");assert.equal(query.get("rgm_filter"),"true");assert.deepEqual(query.getAll("rgm_regions"),["SPE"]);assert.equal(result.aggregates[0].row_count,2);
  const controller=new AbortController();controller.abort();
  await assert.rejects(loadCollectionMonitoringV2Retention({dateFrom:"2026-10-22",dateTo:"2026-10-22"},async()=>{throw new Error("Fetcher must not run");},controller.signal),/aborted/);
});
