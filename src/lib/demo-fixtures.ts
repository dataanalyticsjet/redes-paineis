import { normalizeHeader, type ParsedWorkbook, type WorkbookColumn, type WorkbookRow } from "./workbook.ts";
import {
  filterSellerReferenceForBase,
  filterSellerReferenceForRegion,
  filterWorkbookForBase,
  filterWorkbookForRegion,
  regionalColumn,
} from "./regional-scope.ts";

export interface DemoViewerScope {
  region: string | null;
  base: string | null;
}

/** Synthetic inputs shaped like the ParsedWorkbook objects produced by parseWorkbook. */
export interface DashboardDemoFixtures {
  monitoring: ParsedWorkbook;
  taxa: ParsedWorkbook;
  epop: ParsedWorkbook;
  movement: ParsedWorkbook;
  sellerList: ParsedWorkbook;
  sellerSpecialList: ParsedWorkbook;
  sellerPerformance: ParsedWorkbook;
  responsibilityList: ParsedWorkbook;
  bipagem: ParsedWorkbook;
  damage: ParsedWorkbook;
}

export const DEMO_WORKBOOK_NAME = "Demonstração local — dados fictícios.xlsx";
export const DEMO_TEMPLATE_BASE = "DEMO SPS Base 1";

const dates = ["2026-09-21", "2026-09-22", "2026-09-23"];
const regions = [
  { name: "SPS", code: 350000 },
  { name: "RJ", code: 210000 },
  { name: "PR", code: 410000 },
];
const bases = regions.flatMap((region, regionIndex) => [0, 1].map((baseIndex) => ({
  region: region.name,
  regionCode: region.code,
  code: (regionIndex + 1) * 1000 + baseIndex + 1,
  name: `DEMO ${region.name} Base ${baseIndex + 1}`,
})));
const origins = ["TikTok", "TEMU D2D"];

function parsedWorkbook(
  sheetName: string,
  headers: string[],
  rows: WorkbookRow[],
  options: { date?: string; base?: string; region?: string; origin?: string; status?: string; statusMetrics?: string[] } = {},
): ParsedWorkbook {
  const metricHeaders = options.statusMetrics ?? [];
  const statusColumns = [...(options.status ? [options.status] : []), ...metricHeaders];
  const columns: WorkbookColumn[] = headers.map((key, index) => ({
    key,
    originalHeader: key,
    normalizedHeader: normalizeHeader(key),
    index,
    role: key === options.date ? "date"
      : key === options.base ? "base"
        : key === options.origin ? "origin"
          : key === options.status ? "status"
            : metricHeaders.includes(key) ? "status-metric" : "data",
  }));
  const workbookDates = options.date
    ? rows.map((row) => String(row[options.date!] ?? "")).filter((value) => /^\d{4}-\d{2}-\d{2}/.test(value)).sort()
    : [];
  return {
    sheetName,
    headers,
    rows,
    dateColumn: options.date,
    baseColumn: options.base,
    regionColumn: options.region,
    originColumn: options.origin,
    statusColumn: options.status,
    statusColumns,
    metadata: {
      sheetNames: [sheetName],
      headerRow: 1,
      rowCount: rows.length,
      columnCount: headers.length,
      columns,
      date1904: false,
      ...(workbookDates.length ? { dateRange: { min: workbookDates[0].slice(0, 10), max: workbookDates.at(-1)!.slice(0, 10) } } : {}),
    },
    warnings: ["Demonstração local: dados inteiramente fictícios."],
  };
}

function dailyCollection(dateIndex: number, baseIndex: number, originIndex: number) {
  const toCollect = 120 + baseIndex * 11 + dateIndex * 7 + originIndex * 5;
  const notCollected = 14 + (baseIndex % 2) * 3 + dateIndex * 2 + originIndex;
  const collected = toCollect - notCollected;
  const onTime = collected - 4 - dateIndex;
  const attempted = collected + Math.floor(notCollected / 2);
  return {
    orders: toCollect + 2 + originIndex,
    canceled: 2 + originIndex,
    toCollect,
    notCollected,
    collected,
    onTime,
    collectedWithAttempts: attempted,
  };
}

function sellerCode(index: number) {
  return `9000000000000000${String(index).padStart(3, "0")}`;
}

const monitoringHeaders = [
  "Data", "Regional Origem", "PDD de saída", "Origem do Pedido",
  "dorp off应揽收", "dorp off待揽收", "当前状态 网点发件流程中",
];
const monitoringRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => origins.map((origin, originIndex) => {
  const amounts = dailyCollection(dateIndex, baseIndex, originIndex);
  return {
    Data: date,
    "Regional Origem": base.region,
    "PDD de saída": base.name,
    "Origem do Pedido": origin,
    "dorp off应揽收": amounts.toCollect,
    "dorp off待揽收": amounts.notCollected,
    "当前状态 网点发件流程中": amounts.collected,
  };
})));

const taxaHeaders = [
  "Horário de término do prazo de coleta", "Nome da regional", "Nome da base de coleta", "Origem do Pedido",
  "Tipo de produto", "Quantidade de pedidos", "Qtd a coletar", "Qtd cancelada", "Taxa de coleta",
  "揽收量", "未揽收量", "Qtd não coletada no prazo", "Qtd coletada no prazo", "Taxa de coleta no prazo",
  "Pedidos coletados + Tentativas de coleta", "Taxa de coleta com tentativas de coleta", "Prazo médio demorado para coleta(h)",
  "已做问题件的量", "未做问题件的量", "Taxa de coleta do vendedor", "应上门商家量", "未上门商家量",
];
const taxaRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => origins.map((origin, originIndex) => {
  const amounts = dailyCollection(dateIndex, baseIndex, originIndex);
  return {
    "Horário de término do prazo de coleta": date,
    "Nome da regional": base.region,
    "Nome da base de coleta": base.name,
    "Origem do Pedido": origin,
    "Tipo de produto": origin === "TikTok" ? "Coleta seller" : "Drop-off",
    "Quantidade de pedidos": amounts.orders,
    "Qtd a coletar": amounts.toCollect,
    "Qtd cancelada": amounts.canceled,
    "Taxa de coleta": amounts.collected / amounts.toCollect,
    "揽收量": amounts.collected,
    "未揽收量": amounts.notCollected,
    "Qtd não coletada no prazo": amounts.notCollected + 2,
    "Qtd coletada no prazo": amounts.onTime,
    "Taxa de coleta no prazo": amounts.onTime / amounts.toCollect,
    "Pedidos coletados + Tentativas de coleta": amounts.collectedWithAttempts,
    "Taxa de coleta com tentativas de coleta": amounts.collectedWithAttempts / amounts.toCollect,
    "Prazo médio demorado para coleta(h)": 3.5 + baseIndex * 0.4 + dateIndex * 0.2 + originIndex * 0.3,
    "已做问题件的量": 1 + (baseIndex + dateIndex + originIndex) % 4,
    "未做问题件的量": 1 + (baseIndex + originIndex) % 3,
    "Taxa de coleta do vendedor": Math.max(0, (amounts.collected - 3) / amounts.toCollect),
    "应上门商家量": 5 + baseIndex,
    "未上门商家量": 1 + (dateIndex + originIndex) % 2,
  };
})));

const epopHeaders = [
  "Data", "Origem do Pedido", "Id Seller/remetente", "Endereço da loja", "Nome da base", "Código da base", "Regional",
  "Quantidade prevista para coleta", "Quantidade coletada", "Qtd não coletada", "Transferência POC",
];
const epopRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => [0, 1].map((sellerIndex) => {
  const planned = 18 + baseIndex * 3 + dateIndex * 2 + sellerIndex;
  const notCollected = 2 + (baseIndex + dateIndex + sellerIndex) % 4;
  return {
    Data: date,
    "Origem do Pedido": "TikTok",
    "Id Seller/remetente": sellerCode(baseIndex * 3 + sellerIndex + 1),
    "Endereço da loja": `Endereço fictício ${base.name} ${sellerIndex + 1}`,
    "Nome da base": base.name,
    "Código da base": base.code,
    Regional: base.region,
    "Quantidade prevista para coleta": planned,
    "Quantidade coletada": planned - notCollected,
    "Qtd não coletada": notCollected,
    "Transferência POC": (dateIndex + baseIndex + sellerIndex) % 3 === 0 ? "" : "POC fictício",
  };
})));

const movementHeaders = [
  "Regional responsável", "Código da unidade responsável", "Nome da unidade responsável", "Aging",
  "Tipo da última operação", "Origem do Pedido", "Pedidos", "Horário da última operação",
];
const movementRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => [1, 2, 7].flatMap((age, ageIndex) => origins.map((origin, originIndex) => ({
  "Regional responsável": base.region,
  "Código da unidade responsável": base.code,
  "Nome da unidade responsável": base.name,
  Aging: `${age} dia${age === 1 ? "" : "s"}`,
  "Tipo da última operação": ["Aguardando coleta", "Em trânsito", "Aguardando transferência"][(dateIndex + ageIndex + originIndex) % 3],
  "Origem do Pedido": origin,
  Pedidos: 3 + baseIndex * 2 + dateIndex + ageIndex + originIndex,
  "Horário da última operação": `${date}T${String(8 + ageIndex * 3).padStart(2, "0")}:30:00`,
})))));

const sellerReferenceHeaders = ["global_seller_id", "重点保障商家类型", "进线情况"];
const sellerReferenceRows: WorkbookRow[] = [];
const specialSellerRows: WorkbookRow[] = [];
const sellerPerformanceHeaders = [
  "Data", "Regional Origem", "PDD de saída", "Cliente", "Loja", "Id Seller/remetente", "Origem do Pedido",
  "Status atual – Aguardando coleta", "Status atual – Recebido no Drop-off", "Status atual – Coletado",
  "Status atual – Recebido", "Status atual – Recebido na base", "Status atual – Em trânsito a partir da base", "Status atual – Chegou ao SC",
];
const sellerPerformanceRows: WorkbookRow[] = [];
for (let baseIndex = 0; baseIndex < bases.length; baseIndex += 1) {
  const base = bases[baseIndex];
  for (let typeIndex = 0; typeIndex < 3; typeIndex += 1) {
    const code = sellerCode(baseIndex * 3 + typeIndex + 1);
    const sellerName = `Loja fictícia ${base.region}-${baseIndex + 1}-${typeIndex + 1}`;
    if (typeIndex === 2) specialSellerRows.push({ "商家ID": code });
    else sellerReferenceRows.push({ global_seller_id: code, "重点保障商家类型": typeIndex === 0 ? "T4" : "T5", "进线情况": "Atendimento demonstrativo" });
    for (let dateIndex = 0; dateIndex < dates.length; dateIndex += 1) {
      const processed = typeIndex === 0 ? 31 + dateIndex * 2 : typeIndex === 1 ? 16 + dateIndex : 0;
      const awaiting = typeIndex === 0 ? 0 : typeIndex === 1 ? 9 + dateIndex * 2 : 24 + dateIndex * 3;
      const collected = Math.floor(processed * 0.45);
      const receivedBase = Math.floor(processed * 0.2);
      const inTransitBase = Math.floor(processed * 0.15);
      const arrivedSc = Math.floor(processed * 0.1);
      const received = Math.floor(processed * 0.05);
      const dropOff = processed - collected - receivedBase - inTransitBase - arrivedSc - received;
      sellerPerformanceRows.push({
        Data: dates[dateIndex],
        "Regional Origem": base.region,
        "PDD de saída": base.name,
        Cliente: `Cliente fictício ${typeIndex + 1}`,
        Loja: sellerName,
        "Id Seller/remetente": code,
        "Origem do Pedido": typeIndex === 0 ? "TikTok" : typeIndex === 1 ? "TEMU D2D" : "Shopee",
        "Status atual – Aguardando coleta": awaiting,
        "Status atual – Recebido no Drop-off": dropOff,
        "Status atual – Coletado": collected,
        "Status atual – Recebido": received,
        "Status atual – Recebido na base": receivedBase,
        "Status atual – Em trânsito a partir da base": inTransitBase,
        "Status atual – Chegou ao SC": arrivedSc,
      });
    }
  }
}

const responsibilityHeaders = ["Regional", "Código base", "Nome da Base", "Região do RM", "RM", "RGM"];
const responsibilityRows = bases.map((base) => ({
  Regional: base.region,
  "Código base": base.code,
  "Nome da Base": base.name,
  "Região do RM": `Área fictícia ${base.region}`,
  RM: `RM Demonstração ${base.region}`,
  RGM: `RGM Demonstração ${base.region}`,
}));

const bipagemHeaders = [
  "Data considerada", "Código da Regional do PDD Responsável", "Nome da Regional do PDD Responsável", "Código da base",
  "Nome do PDD Responsável", "Código de origem do pedido", "Origem do Pedido", "Qtd pedidos a bipar",
  "Qtd pedidos não bipados no recebimento da coleta", "Qtd pedidos não bipados na coleta", "Qtd de Pacotes com Falta de Bipe de Envio",
];
const bipagemRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => origins.map((origin, originIndex) => ({
  "Data considerada": date,
  "Código da Regional do PDD Responsável": base.regionCode,
  "Nome da Regional do PDD Responsável": base.region,
  "Código da base": base.code,
  "Nome do PDD Responsável": base.name,
  "Código de origem do pedido": originIndex === 0 ? "D67" : "D899",
  "Origem do Pedido": origin,
  "Qtd pedidos a bipar": 96 + baseIndex * 8 + dateIndex * 4,
  "Qtd pedidos não bipados no recebimento da coleta": 12 + baseIndex % 4 + dateIndex * 2,
  "Qtd pedidos não bipados na coleta": 3 + (baseIndex + dateIndex + originIndex) % 5,
  "Qtd de Pacotes com Falta de Bipe de Envio": 2 + (baseIndex + originIndex) % 3,
}))));

const damageHeaders = [
  "Data de declaração", "Número do ticket", "Número da Remessa", "Regional responsável", "Base responsável",
  "Tipo primário", "Tipo secundário", "Código da origem do pedido", "Qtd de pedidos de responsabilidade", "Valor da arbitragem",
];
const damageRows = dates.flatMap((date, dateIndex) => bases.flatMap((base, baseIndex) => [0, 1].map((issueIndex) => ({
  "Data de declaração": date,
  "Número do ticket": `DEMO-TICKET-${dateIndex + 1}${baseIndex + 1}${issueIndex + 1}`,
  "Número da Remessa": `DEMO-SHIPMENT-${baseIndex + 1}${dateIndex + 1}${issueIndex + 1}`,
  "Regional responsável": base.region,
  "Base responsável": base.name,
  "Tipo primário": issueIndex === 0 ? "Avaria" : "Extravio",
  "Tipo secundário": issueIndex === 0 ? "Embalagem danificada" : "Sem atualização fictícia",
  "Código da origem do pedido": issueIndex === 0 ? "D67" : "D899",
  "Qtd de pedidos de responsabilidade": 1 + ((baseIndex + dateIndex + issueIndex) % 2),
  "Valor da arbitragem": 45.5 + baseIndex * 11 + dateIndex * 7 + issueIndex * 13.25,
}))));

export const DASHBOARD_DEMO_FIXTURES: DashboardDemoFixtures = {
  monitoring: parsedWorkbook("Dados", monitoringHeaders, monitoringRows, {
    date: "Data", base: "PDD de saída", region: "Regional Origem", origin: "Origem do Pedido",
    statusMetrics: monitoringHeaders.slice(4),
  }),
  taxa: parsedWorkbook("Dados", taxaHeaders, taxaRows, {
    date: "Horário de término do prazo de coleta", base: "Nome da base de coleta", region: "Nome da regional", origin: "Origem do Pedido",
  }),
  epop: parsedWorkbook("Dados", epopHeaders, epopRows, {
    date: "Data", base: "Nome da base", region: "Regional", origin: "Origem do Pedido",
  }),
  movement: parsedWorkbook("Dados", movementHeaders, movementRows, {
    date: "Horário da última operação", base: "Nome da unidade responsável", region: "Regional responsável", origin: "Origem do Pedido",
  }),
  sellerList: parsedWorkbook("SELLERS", sellerReferenceHeaders, sellerReferenceRows),
  sellerSpecialList: parsedWorkbook("SELLERS ESPECIAIS", ["商家ID"], specialSellerRows),
  sellerPerformance: parsedWorkbook("Resumo JMS", sellerPerformanceHeaders, sellerPerformanceRows, {
    date: "Data", base: "PDD de saída", region: "Regional Origem", origin: "Origem do Pedido",
  }),
  responsibilityList: parsedWorkbook("Responsáveis", responsibilityHeaders, responsibilityRows, {
    base: "Nome da Base", region: "Regional",
  }),
  bipagem: parsedWorkbook("Dados", bipagemHeaders, bipagemRows, {
    date: "Data considerada", base: "Nome do PDD Responsável", region: "Nome da Regional do PDD Responsável", origin: "Origem do Pedido",
  }),
  damage: parsedWorkbook("Dados", damageHeaders, damageRows, {
    date: "Data de declaração", base: "Base responsável", region: "Regional responsável",
  }),
};

/**
 * Reassigns synthetic rows to the authenticated viewer's exact scope, then
 * applies the same workbook filters used by the protected workbook API.
 */
export function scopeDemoWorkbook(parsed: ParsedWorkbook, scope: DemoViewerScope): ParsedWorkbook {
  if (scope.base) {
    if (!parsed.baseColumn) return parsed;
    const template = filterWorkbookForBase(parsed, DEMO_TEMPLATE_BASE);
    const regionHeader = regionalColumn(template);
    const rows = template.rows.map((row) => ({
      ...row,
      [template.baseColumn as string]: scope.base,
      ...(regionHeader && scope.region ? { [regionHeader]: scope.region } : {}),
    }));
    return filterWorkbookForBase({ ...template, rows }, scope.base);
  }

  if (scope.region) {
    const region = scope.region.trim().toUpperCase();
    const regionHeader = regionalColumn(parsed);
    if (!regionHeader) return filterWorkbookForRegion(parsed, region);
    const rows = parsed.rows.map((row) => ({ ...row, [regionHeader]: region }));
    return filterWorkbookForRegion({ ...parsed, rows }, region);
  }

  return parsed;
}

export function scopeDemoSellerReference(
  parsed: ParsedWorkbook,
  performance: ParsedWorkbook,
  scope: DemoViewerScope,
  special: boolean,
): ParsedWorkbook {
  if (scope.base) return filterSellerReferenceForBase(parsed, performance, scope.base, special);
  if (scope.region) return filterSellerReferenceForRegion(parsed, performance, scope.region, special);
  return parsed;
}
