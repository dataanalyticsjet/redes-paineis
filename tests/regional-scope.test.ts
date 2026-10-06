import assert from "node:assert/strict";
import test from "node:test";
import { filterWorkbookForRegion, filterSellerReferenceForRegion, readRegionalWorkbook } from "../src/lib/regional-scope.ts";
import type { ParsedWorkbook } from "../src/lib/workbook.ts";

function workbook(headers: string[], rows: Record<string, unknown>[]): ParsedWorkbook {
  return { sheetName: "Dados", headers, rows, statusColumns: [], warnings: [], metadata: { sheetNames: ["Dados"], headerRow: 1, rowCount: rows.length, columnCount: headers.length, columns: [], date1904: false } };
}

test("all operational header formats restrict rows and export source to the requested region", () => {
  for (const header of ["Regional Origem", "Nome da regional", "Regional 区域", "Regional responsável", "Regional"]) {
    const original = workbook([header, "Pedidos"], [{ [header]: "SPS", Pedidos: 10 }, { [header]: "PR", Pedidos: 20 }]);
    const scoped = filterWorkbookForRegion(original, "SPS");
    assert.equal(scoped.rows.length, 1);
    assert.equal(scoped.rows[0][header], "SPS");
    assert.equal(scoped.metadata.rowCount, 1);
    assert.equal(original.rows.length, 2);
  }
});

test("movement access uses the responsible regional, not the sender", () => {
  const original = workbook(["Regional Remetente", "Regional responsável"], [{ "Regional Remetente": "SPS", "Regional responsável": "PR" }, { "Regional Remetente": "PR", "Regional responsável": "SPS" }]);
  assert.equal(filterWorkbookForRegion(original, "SPS").rows[0]["Regional Remetente"], "PR");
});

test("unknown or missing regional ownership fails closed", () => {
  assert.equal(filterWorkbookForRegion(workbook(["Pedidos"], [{ Pedidos: 500 }]), "SPS").rows.length, 0);
  assert.equal(filterWorkbookForRegion(workbook(["Regional"], [{ Regional: "" }, { Regional: "SPE" }]), "SPS").rows.length, 0);
});

test("simultaneous regional requests remain independent", async () => {
  const original = workbook(["Regional"], [{ Regional: "SPS" }, { Regional: "PR" }, { Regional: "MG" }]);
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => {
    const region = ["SPS", "PR", "MG"][index % 3];
    return Promise.resolve(filterWorkbookForRegion(original, region)).then((result) => assert.deepEqual(result.rows, [{ Regional: region }]));
  }));
  assert.equal(results.length, 30);
  assert.equal(original.rows.length, 3);
});

test("seller reference lists contain only sellers with records in the authorized regional", () => {
  const a = "1234567890123456789", b = "2234567890123456789";
  const performance = workbook(["Regional Origem", "Id Seller/remetente"], [{ "Regional Origem": "SPS", "Id Seller/remetente": a }, { "Regional Origem": "PR", "Id Seller/remetente": b }]);
  const reference = workbook(["global_seller_id"], [{ global_seller_id: a }, { global_seller_id: b }]);
  assert.deepEqual(filterSellerReferenceForRegion(reference, performance, "SPS").rows, [{ global_seller_id: a }]);
  const special = workbook(["商家ID"], [{ "商家ID": `${a},${b}` }]);
  assert.deepEqual(filterSellerReferenceForRegion(special, performance, "SPS", true).rows, [{ "商家ID": a }]);
  assert.equal(filterSellerReferenceForRegion(reference, null, "SPS").rows.length, 0);
});

test("streaming isolation handles split UTF-8, quoted braces and concurrent regional reads", async () => {
  const source = workbook(["Regional Origem", "Id Seller/remetente", "Nome"], [
    { "Regional Origem": "SPS", "Id Seller/remetente": "1234567890123456789", Nome: '李 "{[]}\\"', nested: { data: [1, 2] } },
    { "Regional Origem": "PR", "Id Seller/remetente": "2234567890123456789", Nome: "PR" },
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  function stream(size: number) {
    let offset = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
    } });
  }
  await Promise.all([1, 7, 64, 10000].map(async (size) => {
    for (const region of ["SPS", "PR"]) {
      const result = await readRegionalWorkbook(stream(size), region);
      assert.deepEqual(result.parsed.rows, filterWorkbookForRegion(source, region).rows);
      assert.equal(result.parsed.metadata.rowCount, 1);
    }
  }));
  const ids = await readRegionalWorkbook(stream(7), "SPS", true);
  assert.equal(ids.parsed.rows.length, 0);
  assert.deepEqual([...ids.sellerIds], ["1234567890123456789"]);
});
