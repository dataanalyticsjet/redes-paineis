import test from "node:test";
import assert from "node:assert/strict";

import { extractSpecialSellerCodes } from "../app/lib/special-sellers.ts";
import type { ParsedWorkbook } from "../app/lib/workbook.ts";

function workbook(header: string, values: unknown[]): ParsedWorkbook {
  return {
    sheetName: "Sellers",
    headers: [header, "Descrição"],
    rows: values.map((value) => ({ [header]: value, "Descrição": "ignorar 7499999999999999999" })),
    statusColumns: [],
    metadata: {
      sheetNames: ["Sellers"],
      headerRow: 1,
      rowCount: values.length,
      columnCount: 2,
      columns: [],
      date1904: false,
    },
    warnings: [],
  };
}

test("separa IDs agrupados na coluna de seller especial e remove duplicidades", () => {
  const parsed = workbook("商家ID", [
    "7494338242350319306,7494327443009734152",
    "7494327443009734152；7494327632097609053\ntexto",
  ]);
  assert.deepEqual(extractSpecialSellerCodes(parsed), [
    "7494327443009734152",
    "7494327632097609053",
    "7494338242350319306",
  ]);
});

test("ignora outras colunas e números que não tenham 19 dígitos", () => {
  const parsed = workbook("Seller especial", ["123, 7496321911199664857"]);
  assert.deepEqual(extractSpecialSellerCodes(parsed), ["7496321911199664857"]);
});
