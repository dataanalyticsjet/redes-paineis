import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const accounts = [
  { username: "Matriz", password: "matrix-test", role: "matrix" },
  ...["SPS", "SPN", "SPE", "RJ", "PR", "MG", "GP", "CE", "BA"].map((region) => ({ username: `JT_${region}`, password: `test-${region}`, role: "regional", region })),
  { username: "invalid-config", password: "test", role: "regional" },
];
const source = (await readFile(new URL("../app/lib/view-auth.server.ts", import.meta.url), "utf8"))
  .replace('import { env } from "cloudflare:workers";', `const env = ${JSON.stringify({ VIEWER_ACCOUNTS_JSON: JSON.stringify(accounts) })};`)
  .replace('"./upload-auth"', JSON.stringify(new URL("../app/lib/upload-auth.ts", import.meta.url).href));
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { authenticateViewer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function request(username, password) {
  return new Request("https://example.test/api/workbook", { headers: { authorization: `Basic ${btoa(`${username}:${password}`)}` } });
}

test("regional logins never inherit the first (Matriz) account", async () => {
  for (const account of accounts.filter((account) => account.region)) {
    assert.deepEqual(await authenticateViewer(request(account.username, account.password)), {
      username: account.username, role: "regional", region: account.region,
    });
  }
});

test("only matching Matriz credentials grant matrix access", async () => {
  assert.deepEqual(await authenticateViewer(request("Matriz", "matrix-test")), { username: "Matriz", role: "matrix", region: null });
  assert.equal(await authenticateViewer(request("JT_SPS", "matrix-test")), null);
  assert.equal(await authenticateViewer(request("Matriz", "test-SPS")), null);
  assert.equal(await authenticateViewer(request("JT_SPS", "wrong")), null);
  assert.equal(await authenticateViewer(request("unknown", "test-SPS")), null);
  assert.equal(await authenticateViewer(request("invalid-config", "test")), null);
  assert.equal(await authenticateViewer(new Request("https://example.test")), null);
});

test("every viewer endpoint awaits authentication before returning data", async () => {
  for (const path of ["../app/api/view-auth/route.ts", "../app/api/workbook/route.ts"]) {
    const route = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(route, /await authenticateViewer\(request\)/);
  }
});
