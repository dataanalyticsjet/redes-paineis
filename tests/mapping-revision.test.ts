import test from "node:test";
import assert from "node:assert/strict";
import { acceptMappingRevision, resetMappingRevision, mappingGeneration, assertMappingGeneration, monitorMappingRevision, isOperationalMappedBase } from "../src/lib/data-foundation/mapping-revision.ts";
import { mapCollectionMonitoringV2Record, groupCollectionMonitoringV2Rows } from "../src/lib/data-foundation/collection-monitoring-v2-dashboard.ts";
import type { CollectionMonitoringV2Record } from "../src/lib/data-foundation/collection-monitoring-v2.ts";

const A="11111111-1111-1111-1111-111111111111", B="22222222-2222-2222-2222-222222222222";
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test("mapping revisions invalidate prior generations, keep identical versions stable and detect rollback",()=>{
  resetMappingRevision();
  acceptMappingRevision(A);const before=mappingGeneration();acceptMappingRevision(A);assertMappingGeneration(before);
  acceptMappingRevision(B);assert.throws(()=>assertMappingGeneration(before),/mapping_revision_changed/);
  const after=mappingGeneration();acceptMappingRevision(A);assert.throws(()=>assertMappingGeneration(after),/mapping_revision_changed/);
});
test("one revision poll per 30 seconds, focus deduplication, transient errors and disposal",async()=>{
  resetMappingRevision();let callback=()=>{};let focus=()=>{};let period=0,requests=0,changes=0;let current=A;let fail=false;
  const stop=monitorMappingRevision(async()=>{requests++;return fail ? new Response("{}",{status:503}):new Response(JSON.stringify({revision:current}));},()=>{changes++;},{
    setInterval:(cb,ms)=>{callback=cb;period=ms;return 1;},clearInterval:()=>{},
    addFocus:cb=>{focus=cb;},removeFocus:()=>{},
  });
  await tick();assert.equal(period,30000);assert.equal(requests,1);assert.equal(changes,0);
  current=B;focus();focus();await tick();assert.equal(requests,2);assert.equal(changes,1);
  fail=true;callback();await tick();assert.equal(changes,1);
  stop();callback();await tick();assert.equal(requests,3);
});
test("PA DC and SC retain volumes but never inflate canonical operational base counts",()=>{
  const types=["PA","DC","SC","OWN","FRANCHISE"];
  const rows=types.map((kind,index)=>mapCollectionMonitoringV2Record({
    data_date:"2026-10-22",publication_id:"p",source_row_no:index+1,source_base_name:"Unit "+index,
    reported_origin_region:"JMS",order_origin:"JMS",resolved_base_code:String(index),mapping_resolution:"NAME_APPROVED",
    effective_base_code:String(index),effective_mapping_resolution:"NAME_APPROVED",mapped_region:"SR",mapped_unit_type:kind,
    expected_dropoff:10,expected_pickup:0,pending_dropoff:1,pending_pickup:0,status_received_at_base:2,status_dispatched_from_base:3,arrived_sorting_center:4,
  } as CollectionMonitoringV2Record));
  const groups=groupCollectionMonitoringV2Rows(rows,"region");
  assert.equal(groups[0].planned,50);assert.equal(groups[0].retention,10);assert.equal(groups[0].baseCount,2);
  assert.equal(isOperationalMappedBase({}),true);assert.equal(isOperationalMappedBase({mapped_unit_type:"PA"}),false);
});
test("cached data is reloaded after a mapping revision even with the same publication",async()=>{
  const {loadCachedDashboardData}=await import("../src/lib/data-foundation/dashboard-data-cache.ts");
  resetMappingRevision();acceptMappingRevision(A);let loads=0;
  const request={identityKey:"authorized-user",sourceId:"collection_rate",contractVersion:3,periodKey:"2026-10-22",manifest:async()=>"same-publication",load:async()=>++loads};
  assert.equal(await loadCachedDashboardData(request),1);assert.equal(await loadCachedDashboardData(request),1);
  acceptMappingRevision(B);assert.equal(await loadCachedDashboardData(request),2);
});

test("a revision change aborts an in-progress protected export before a complete blob is produced",async(t)=>{
  const {apiFetch}=await import("../src/lib/api-url.ts");
  resetMappingRevision();acceptMappingRevision(A);
  let writer:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(controller){writer=controller;}});
  t.mock.method(globalThis,"fetch",async()=>new Response(stream,{headers:{"X-Doomsday-Revision":A}}));
  const response=await apiFetch("/api/v2/data-sources/collection_monitoring/export.csv");
  const body=response.arrayBuffer();
  writer!.enqueue(new TextEncoder().encode("header\n"));
  acceptMappingRevision(B);
  writer!.enqueue(new TextEncoder().encode("obsolete\n"));writer!.close();
  await assert.rejects(body,/mapping_revision_changed/);
});
test("Sem Movimentação retains package volumes while excluding non-base kinds from critical bases",async()=>{
  const {summarizeMovementSnapshot}=await import("../src/lib/movement-summary.ts");
  const row={region:"SR",code:"1",totalStopped:20,inTransit:5,over2Days:2,over3Days:0,over4Days:0,over5Days:0,over6Days:0,over7Days:0,over10Days:0,over14Days:0,over30Days:0};
  const summary=summarizeMovementSnapshot([{...row,mapped_unit_type:"PA"},{...row,code:"2",mapped_unit_type:"OWN"}]);
  assert.equal(summary.criticalBases,1);assert.equal(summary.totalStopped,40);assert.equal(summary.over2Days,4);
});

test("a delayed old response cannot replace a newer revision learned from another request",async(t)=>{
  const {apiFetch}=await import("../src/lib/api-url.ts");
  const {currentMappingRevision}=await import("../src/lib/data-foundation/mapping-revision.ts");
  resetMappingRevision();
  const pending:((response:Response)=>void)[]=[];
  t.mock.method(globalThis,"fetch",()=>new Promise<Response>(resolve=>pending.push(resolve)));
  const old=apiFetch("/api/v2/data-sources/collection_monitoring/records");
  const newer=apiFetch("/api/v2/data-sources/collection_rate/records");
  pending[1](new Response("{}",{headers:{"X-Doomsday-Revision":B}}));await newer;
  pending[0](new Response("{}",{headers:{"X-Doomsday-Revision":A}}));
  await assert.rejects(old,/mapping_revision_changed/);
  assert.equal(currentMappingRevision(),B);
});
test("a delayed revision poll cannot undo a revision already detected by a data response",async()=>{
  const {currentMappingRevision}=await import("../src/lib/data-foundation/mapping-revision.ts");
  resetMappingRevision();
  let resolvePoll:(response:Response)=>void=()=>{};let changes=0;
  const stop=monitorMappingRevision(()=>new Promise<Response>(resolve=>{resolvePoll=resolve;}),()=>{changes++;},{
    setInterval:()=>1,clearInterval:()=>{},addFocus:()=>{},removeFocus:()=>{},
  });
  acceptMappingRevision(B);
  resolvePoll(new Response(JSON.stringify({revision:A})));
  await tick();
  assert.equal(currentMappingRevision(),B);assert.equal(changes,0);
  stop();
});
