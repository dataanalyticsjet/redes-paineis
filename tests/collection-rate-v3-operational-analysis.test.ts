import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionRateV3DashboardRow } from "../src/lib/data-foundation/collection-rate-v3-dashboard.ts";
import { filterCollectionRateV3Rows } from "../src/lib/data-foundation/collection-rate-v3-dashboard.ts";
import { buildCollectionRateV3OperationalAnalysis, digestCollectionRateV3Rows } from "../src/lib/data-foundation/collection-rate-v3-operational-analysis.ts";

function row(overrides: Partial<CollectionRateV3DashboardRow> = {}): CollectionRateV3DashboardRow {
  return {
    deadline_at: "2026-10-20 00:00:00",
    reported_region: "SPE",
    source_base_name: "Base 1",
    order_origin: "TikTok",
    product_type: "EXPRESS",
    order_quantity: 100,
    quantity_to_collect: 100,
    cancelled_quantity: 0,
    collection_rate: 0.5,
    collected_quantity: 50,
    not_collected_quantity: 50,
    not_collected_on_time_quantity: 0,
    collected_on_time_quantity: 40,
    collection_on_time_rate: 0.4,
    collected_plus_attempts_quantity: 80,
    collection_rate_with_attempts: 0.8,
    average_collection_delay_hours: null,
    processed_problem_items: 0,
    unprocessed_problem_items: 0,
    seller_collection_rate: 0.5,
    expected_merchant_visits: 0,
    merchants_not_visited: 0,
    publication_id: "pub-1",
    source_row_no: 1,
    resolved_base_code: "B1",
    mapping_resolution: "NAME_APPROVED",
    effective_base_code: "B1",
    effective_mapping_resolution: "NAME_APPROVED",
    mapped_region: "SPE",
    mapped_uf: "SP",
    mapped_rm_area: "SPE-GRU",
    mapped_rm: "RM SPE",
    mapped_base_name: "Base 1",
    data_date: "2026-10-20",
    region: "SPE",
    rmArea: "SPE-GRU",
    rm: "RM SPE",
    rgm: "RGM SPE",
    base: "Base 1",
    baseCode: "B1",
    origin: "TikTok",
    productType: "EXPRESS",
    ...overrides,
  };
}

const period = { dateFrom: "2026-10-20", dateTo: "2026-10-20" };
const fixedTime = new Date("2026-10-20T09:00:00-03:00");

test("content digest matches backend canonical encoding and detects changed values with stable row identity", async () => {
  const original = row({ deadline_at: "2026-10-20T03:00:00", publication_id: "same-publication", source_row_no: 17,
    collection_rate: "0.5", collection_on_time_rate: "0.4", collection_rate_with_attempts: "0.8", seller_collection_rate: "0.5" });
  const originalDigest = await digestCollectionRateV3Rows([original]);
  assert.equal(originalDigest, "bc5130064f434851dd15eb0135c650e1720ceadec8cfb0f31d119545c1c102aa");
  const updated = { ...original, collected_plus_attempts_quantity: 81 };
  assert.equal(updated.publication_id, original.publication_id);
  assert.equal(updated.source_row_no, original.source_row_no);
  assert.notEqual(await digestCollectionRateV3Rows([updated]), originalDigest);
  assert.equal(await digestCollectionRateV3Rows([original]), originalDigest);
});

test("uses the dashboard's official attempt numerator and weighted denominator for the filtered period", () => {
  const rows = [
    row({ collected_plus_attempts_quantity: 50, quantity_to_collect: 100, baseCode: "A", base: "A" }),
    row({ collected_plus_attempts_quantity: 80, quantity_to_collect: 200, region: "SR", baseCode: "C", base: "C" }),
    row({ data_date: "2026-10-19", collected_plus_attempts_quantity: 0, quantity_to_collect: 10_000 }),
  ];
  const analysis = buildCollectionRateV3OperationalAnalysis(rows, { period, generatedAt: fixedTime });
  assert.equal(analysis.numerator, 130);
  assert.equal(analysis.denominator, 300);
  assert.equal(analysis.rate, 130 / 300);
  assert.equal(analysis.rowCount, 2);
  assert.notEqual(analysis.rate, (0.5 + 0.8) / 2);
  assert.match(analysis.message, /TAXA DE TENTATIVA/);
  assert.match(analysis.message, /Numerador oficial \(coleta \+ tentativas\)/);
  assert.match(analysis.message, /Denominador oficial \(quantidade a coletar\)/);
  assert.doesNotMatch(analysis.message, /Pedidos únicos|tentativas únicas/);
});

test("one-region and combined dashboard filters cannot leak other regional rows", () => {
  const rows = [
    row({ region: "SPE", origin: "TikTok", productType: "EXPRESS", publication_id: "pub-spe" }),
    row({ region: "SPS", origin: "Temu", productType: "ECONOMY", baseCode: "B2", base: "Base 2", publication_id: "pub-sps" }),
  ];
  const filtered = filterCollectionRateV3Rows(rows, {
    regions: new Set(["SPE"]),
    origins: new Set(["TikTok"]),
    productTypes: new Set(["EXPRESS"]),
  });
  const analysis = buildCollectionRateV3OperationalAnalysis(filtered, {
    period,
    filters: [
      { label: "Regional", values: ["SPE"] },
      { label: "Origem", values: ["TikTok"] },
      { label: "Tipo de produto", values: ["EXPRESS"] },
    ],
    publicationIds: ["pub-sps", "pub-spe"],
    generatedAt: fixedTime,
  });
  assert.equal(analysis.rowCount, 1);
  assert.deepEqual(analysis.regions.map((item) => item.region), ["SPE"]);
  assert.doesNotMatch(analysis.message, /SPS|Temu|Base 2/);
  assert.match(analysis.message, /Regional: SPE/);
  assert.match(analysis.message, /区域: SPE/);
  assert.equal(analysis.publicationCount, 1);
});

test("regional and base rankings use weighted rates and volume-sensitive deviation, not a fixed target", () => {
  const rows = [
    row({ region: "SPE", baseCode: "A", base: "Grande", quantity_to_collect: 1_000, collected_plus_attempts_quantity: 500 }),
    row({ region: "SPE", baseCode: "B", base: "Pequena", quantity_to_collect: 10, collected_plus_attempts_quantity: 0 }),
    row({ region: "SR", baseCode: "C", base: "Alta", quantity_to_collect: 100, collected_plus_attempts_quantity: 90 }),
  ];
  const analysis = buildCollectionRateV3OperationalAnalysis(rows, { period, generatedAt: fixedTime });
  assert.equal(analysis.rate, 590 / 1_110);
  assert.equal(analysis.targetRate, null);
  assert.equal(analysis.regionalPriorities[0]?.region, "SPE");
  assert.equal(analysis.basePriorities[0]?.name, "Grande");
  assert.ok((analysis.basePriorities[0]?.denominator ?? 0) > (analysis.basePriorities[1]?.denominator ?? 0));
  assert.match(analysis.message, /Não foi identificada uma meta oficial única/);
  assert.doesNotMatch(analysis.message, /Meta: \*\*98%|target gap|abaixo da meta/);
  assert.match(analysis.message, /não representa backlog observado/);
});

test("unmapped records remain in the weighted national and regional totals but are not assigned to a base ranking", () => {
  const rows = [
    row({ region: "SPE", baseCode: "A", base: "Mapped", quantity_to_collect: 100, collected_plus_attempts_quantity: 90 }),
    row({ region: "Sem regional", baseCode: "—", base: "Nome não confirmado", quantity_to_collect: 50, collected_plus_attempts_quantity: 0 }),
  ];
  const analysis = buildCollectionRateV3OperationalAnalysis(rows, { period, generatedAt: fixedTime });
  assert.equal(analysis.numerator, 90);
  assert.equal(analysis.denominator, 150);
  assert.equal(analysis.unmappedDenominator, 50);
  assert.equal(analysis.rate, 0.6);
  assert.ok(analysis.regions.some((item) => item.region === "Sem regional" && item.denominator === 50));
  assert.equal(analysis.basePriorities.some((item) => item.name === "Nome não confirmado"), false);
  assert.match(analysis.message, /mantido no consolidado/);
  assert.match(analysis.message, /未正式关联区域\/网点的数量仍计入汇总/);
});

test("zero denominator and empty data are reported without an artificial zero rate or rankings", () => {
  const rows = [row({ quantity_to_collect: 0, collected_plus_attempts_quantity: 25 })];
  const analysis = buildCollectionRateV3OperationalAnalysis(rows, { period, generatedAt: fixedTime });
  assert.equal(analysis.rate, null);
  assert.equal(analysis.targetRate, null);
  assert.equal(analysis.regionalPriorities.length, 0);
  assert.equal(analysis.basePriorities.length, 0);
  assert.match(analysis.message, /Taxa consolidada: \*\*—\*\*/);
  assert.match(analysis.message, /Denominador sem volume positivo/);
});

test("message preserves bilingual presentation, selected period, source fields, and filter scope", () => {
  const analysis = buildCollectionRateV3OperationalAnalysis([row()], {
    period: { dateFrom: "2026-10-20", dateTo: "2026-10-21" },
    filters: [
      { label: "RM", values: ["RM SPE"] },
      { label: "Base", values: ["Base 1"] },
    ],
    locale: "zh-CN",
    publicationIds: ["pub-1"],
    generatedAt: fixedTime,
  });
  assert.match(analysis.message, /尝试揽收率/);
  assert.match(analysis.message, /加权汇总比率/);
  assert.match(analysis.message, /分析期间：\*\*20\/10\/2026 a 21\/10\/2026\*\*/);
  assert.match(analysis.message, /RM: RM SPE/);
  assert.match(analysis.message, /网点: Base 1/);
});
