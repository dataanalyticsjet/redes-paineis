import test from "node:test";
import assert from "node:assert/strict";
import { initialRegionSelection } from "../src/lib/initial-region-selection.ts";

const available = ["SPE", "MG", "RJ"];

test("matrix starts with all rows available to its national scope", () => {
  assert.deepEqual(
    [...initialRegionSelection(available, {
      role: "matrix",
      organizational_scope: "matrix",
      region: null,
      home_region: null,
    })],
    available,
  );
});

test("regional users start at home region while extra regions remain selectable", () => {
  assert.deepEqual(
    [...initialRegionSelection(available, {
      role: "regional",
      organizational_scope: "regional",
      region: "SPE",
      home_region: "SPE",
    })],
    ["SPE"],
  );
});

test("home region matching trims whitespace and ignores case", () => {
  assert.deepEqual(
    [...initialRegionSelection(available, {
      role: "regional",
      region: "spe ",
    })],
    ["SPE"],
  );
});

test("regional users never default to all regions when their home region is unavailable", () => {
  assert.deepEqual(
    [...initialRegionSelection(available, {
      role: "regional",
      organizational_scope: "base",
      region: null,
      home_region: null,
    })],
    ["SPE"],
  );
});
