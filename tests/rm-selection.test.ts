import test from "node:test";
import assert from "node:assert/strict";
import { allOptionsAreSelected, distinctFilterOptions, filterRowsByOption, optionSelectionFromValues, rmGroupReactKey, rmSelectionFromValues, selectedOptions, selectedRmOptions } from "../src/lib/rm-selection.ts";

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

test("RM-area options stay based on pre-area rows when a single area is selected and return to ALL", () => {
  const preAreaRows = [
    { base: "A", rmArea: "Região 1" },
    { base: "B", rmArea: "Região 2" },
    { base: "C", rmArea: "Sem região do RM" },
  ];
  const options = distinctFilterOptions(preAreaRows, (row) => row.rmArea);
  const allSelection = { mode: "all" } as const;
  const initiallySelected = selectedOptions(options, allSelection);

  assert.deepEqual(options, ["Região 1", "Região 2", "Sem região do RM"]);
  assert.deepEqual([...initiallySelected].sort(), [...options].sort());
  assert.equal(allOptionsAreSelected(options, initiallySelected), true);

  const oneAreaSelection = optionSelectionFromValues(options, new Set(["Região 1"]));
  const finalRows = filterRowsByOption(preAreaRows, selectedOptions(options, oneAreaSelection), (row) => row.rmArea);
  assert.deepEqual(finalRows.map((row) => row.base), ["A"]);
  assert.deepEqual(distinctFilterOptions(preAreaRows, (row) => row.rmArea), options);

  const returnedToAll = optionSelectionFromValues(options, new Set(options));
  assert.equal(returnedToAll.mode, "all");
  assert.deepEqual(filterRowsByOption(preAreaRows, selectedOptions(options, returnedToAll), (row) => row.rmArea), preAreaRows);
});

test("an ALL selection with one available RM area displays as ALL, not the area's name", () => {
  const options = ["Sem região do RM"];
  const selected = selectedOptions(options, { mode: "all" });

  assert.equal(allOptionsAreSelected(options, selected), true);
  assert.equal(allOptionsAreSelected(options, selected) ? "Todas as regiões do RM" : [...selected][0], "Todas as regiões do RM");
});

test("RM table keys distinguish groups with the same area and RM but different RGM", () => {
  const first = rmGroupReactKey("Sem região do RM", "Sem RM", "RGM A");
  const second = rmGroupReactKey("Sem região do RM", "Sem RM", "RGM B");

  assert.notEqual(first, second);
  assert.equal(first, rmGroupReactKey("Sem região do RM", "Sem RM", "RGM A"));
});
