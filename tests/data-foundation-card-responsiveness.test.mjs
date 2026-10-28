import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("src/styles/globals.css", "utf8");
const admin = readFileSync("src/features/data-foundation/data-foundation-admin.tsx", "utf8");

test("Data Foundation cards use responsive columns capped at three on wide screens", () => {
  assert.match(css, /\.data-foundation-source-cards\s*\{[^}]*max-width:\s*1212px;[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*390px\),\s*1fr\)\)/s);
  assert.doesNotMatch(css, /\.data-foundation-source-cards\s*\{[^}]*repeat\(4,/s);
  assert.match(css, /@media\s*\(max-width:\s*650px\)[\s\S]*?\.data-foundation-source-card\s*\{\s*grid-template-columns:\s*36px\s+minmax\(0,\s*1fr\)/);
});

test("source-card metadata wraps fully and the update action sits below the content", () => {
  assert.match(css, /\.data-foundation-source-card\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.data-foundation-source-card-copy p strong\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal/s);
  assert.doesNotMatch(css, /\.data-foundation-source-card-copy p strong\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.data-foundation-update-button\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*end/s);
  assert.match(css, /@media\s*\(max-width:\s*650px\)[\s\S]*?\.data-foundation-source-card-copy p\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("the six source cards and single Depara keep their published file metadata", () => {
  assert.match(admin, /sources\.filter\(\(source\) => source\.source_id !== "base_mapping_official"\)/);
  assert.match(admin, /publication\?\.fileName \|\| "—"/);
  assert.match(admin, /formatDataFoundationDateTime\(publication\?\.attachedAt\)/);
  assert.match(admin, /\{mapping \? <article className="data-foundation-source-card data-foundation-map-card"/);
  assert.match(admin, /mapping\.fileName \|\| "—"/);
  assert.match(admin, /formatDataFoundationDateTime\(mapping\.attachedAt\)/);
});
