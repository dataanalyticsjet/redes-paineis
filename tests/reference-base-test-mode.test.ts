import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRowsByReferenceBaseNames,
  normalizeReferenceBaseName,
  REFERENCE_BASE_TEST_NAMES,
  uniqueReferenceBaseNames,
} from "../src/lib/data-foundation/reference-base-test.ts";

test("a lista de teste usa nomes fictícios únicos", () => {
  assert.equal(REFERENCE_BASE_TEST_NAMES.length, 6);
  assert.equal(uniqueReferenceBaseNames(REFERENCE_BASE_TEST_NAMES).length, 6);
});

test("deduplica a lista usando somente caixa e espaços", () => {
  assert.deepEqual(uniqueReferenceBaseNames(["DEMO-ALFA-FAKE", " demo-alfa-fake ", "POLO-SIMULADO-QA", " POLO-SIMULADO-QA "]), ["DEMO-ALFA-FAKE", "POLO-SIMULADO-QA"]);
});

test("não normaliza caracteres de compatibilidade Unicode", () => {
  assert.notEqual(normalizeReferenceBaseName("ＡBC"), normalizeReferenceBaseName("ABC"));
});

test("filtro literal preserva nomes e referências geográficas fictícias", () => {
  const rows = [
    { base: "  unidade-teste-alfa-fake-a  ", region: "REGIAO-FAKE-A" },
    { base: "UNIDADE-TESTE-ALFA-FAKE-A", region: "REGIAO-FAKE-A" },
    { base: "POLO-SIMULADO-DELTA-FAKE-D", region: "REGIAO-FAKE-D" },
    { base: "", region: "SEM-REGIAO-FAKE" },
  ];
  const filtered = filterRowsByReferenceBaseNames(rows, new Set(["UNIDADE-TESTE-ALFA-FAKE-A", "POLO-SIMULADO-DELTA-FAKE-D"]), (row) => row.base);
  assert.deepEqual(filtered.map((row) => row.base), ["  unidade-teste-alfa-fake-a  ", "UNIDADE-TESTE-ALFA-FAKE-A", "POLO-SIMULADO-DELTA-FAKE-D"]);
  assert.equal(normalizeReferenceBaseName(" POLO-SIMULADO-DELTA-FAKE-D "), "polo-simulado-delta-fake-d");
});

 test("não aplica prefixos, sufixos nem similaridade", () => {
  const rows = [{ base: "UNIDADE-TESTE-ALFA-FAKE-A" }, { base: "ALFA-FAKE-A" }, { base: "UNIDADE-TESTE-ALFA-FAKE-A-EXTRA" }];
  const filtered = filterRowsByReferenceBaseNames(rows, new Set(["UNIDADE-TESTE-ALFA-FAKE-A"]), (row) => row.base);
  assert.deepEqual(filtered.map((row) => row.base), ["UNIDADE-TESTE-ALFA-FAKE-A"]);
});
