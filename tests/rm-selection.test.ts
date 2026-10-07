import test from "node:test";
import assert from "node:assert/strict";
import { optionSelectionFromValues, rmGroupReactKey, rmSelectionFromValues, selectedOptions, selectedRmOptions } from "../src/lib/rm-selection.ts";

test("initial all-RM selection includes every enriched dataset group including Sem RM", () => {
  const options = ["RM A", "RM B", "RM C", "Sem RM", "Sem RM"];
  const selected = selectedRmOptions(options, { mode: "all" });

  assert.deepEqual([...selected].sort(), ["RM A", "RM B", "RM C", "Sem RM"].sort());
  const groups = options.slice(0, 4).map((rm) => ({ rm, orders: 1 }));
  const totalOrders = groups.filter((group) => selected.has(group.rm)).reduce((sum, group) => sum + group.orders, 0);
  assert.equal(totalOrders, 4);
});

test("all-RM selection automatically includes an RM added by a source update", () => {
  const allSelection = { mode: "all" } as const;
  const firstSourceOptions = ["RM A", "Sem RM"];
  const updatedSourceOptions = ["RM A", "RM B", "Sem RM"];

  assert.deepEqual([...selectedRmOptions(firstSourceOptions, allSelection)].sort(), [...firstSourceOptions].sort());
  assert.deepEqual([...selectedRmOptions(updatedSourceOptions, allSelection)].sort(), [...updatedSourceOptions].sort());
});

test("custom RM selection survives source updates without selecting newly added groups", () => {
  const initialOptions = ["RM A", "RM B", "Sem RM"];
  const customSelection = rmSelectionFromValues(initialOptions, new Set(["RM B"]));
  const updatedOptions = ["RM A", "RM B", "RM C", "Sem RM"];

  assert.deepEqual([...selectedRmOptions(updatedOptions, customSelection)], ["RM B"]);
});

test("all RM-area selection includes areas added by a source update and supports a manual area filter", () => {
  const firstSourceOptions = ["SPE-MGUE", "Sem região do RM"];
  const updatedSourceOptions = ["MG-JDF", "SPE-MGUE", "Sem região do RM"];
  const allSelection = { mode: "all" } as const;
  const records = [
    { rmArea: "SPE-MGUE", orders: 12 },
    { rmArea: "MG-JDF", orders: 23 },
    { rmArea: "Sem região do RM", orders: 4 },
  ];

  assert.deepEqual([...selectedOptions(firstSourceOptions, allSelection)].sort(), [...firstSourceOptions].sort());
  assert.deepEqual([...selectedOptions(updatedSourceOptions, allSelection)].sort(), [...updatedSourceOptions].sort());
  const allSelected = selectedOptions(updatedSourceOptions, allSelection);
  assert.equal(records.filter((record) => allSelected.has(record.rmArea)).reduce((sum, record) => sum + record.orders, 0), 39);

  const manualSelection = optionSelectionFromValues(updatedSourceOptions, new Set(["MG-JDF"]));
  const manuallySelected = selectedOptions(updatedSourceOptions, manualSelection);
  assert.deepEqual([...manuallySelected], ["MG-JDF"]);
  assert.deepEqual(records.filter((record) => manuallySelected.has(record.rmArea)).map((record) => record.rmArea), ["MG-JDF"]);
});

test("RM table keys distinguish groups with the same area and RM but different RGM", () => {
  const first = rmGroupReactKey("Sem região do RM", "Sem RM", "RGM A");
  const second = rmGroupReactKey("Sem região do RM", "Sem RM", "RGM B");

  assert.notEqual(first, second);
  assert.equal(first, rmGroupReactKey("Sem região do RM", "Sem RM", "RGM A"));
});
