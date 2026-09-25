import { normalizeHeader, toISODate, type ParsedWorkbook, type WorkbookRow } from "./workbook";

export interface DamageRecord { date: string; ticket: string; shipment: string; region: string; base: string; type: string; reason: string; origin: string; tickets: number; value: number; }
export interface DamageData { parsed: ParsedWorkbook; fileName: string; updatedAt?: string; records: DamageRecord[]; dates: string[]; regions: string[]; bases: string[]; }

function column(parsed: ParsedWorkbook, labels: string[]) {
  return parsed.headers.find((header) => labels.some((label) => normalizeHeader(header) === normalizeHeader(label)));
}
function number(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().replace(/R\$|\s/g, "");
  if (!text) return 0;
  // Exportações JMS usam ponto decimal (29.90); importações locais podem
  // usar 1.234,56. Preserve os centavos nos dois formatos.
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  return Number(normalized) || 0;
}
export function buildDamageData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): DamageData {
  const date = column(parsed, ["Data de declaração"]); const region = column(parsed, ["Regional responsável"]);
  const base = column(parsed, ["Base responsável"]); const type = column(parsed, ["Tipo primário"]);
  const reason = column(parsed, ["Tipo secundário"]); const origin = column(parsed, ["Código da origem do pedido"]);
  const value = column(parsed, ["Valor da arbitragem"]); const tickets = column(parsed, ["Qtd de pedidos de responsabilidade"]);
  const ticket = column(parsed, ["Número do ticket"]); const shipment = column(parsed, ["Número da Remessa"]);
  if (!date || !region || !base || !type || !reason || !origin || !value || !tickets) throw new Error("A planilha de Avaria e Extravio não contém todas as colunas obrigatórias.");
  const records = parsed.rows.map((row): DamageRecord | null => { const normalized = toISODate(row[date], { date1904: parsed.metadata.date1904 }); if (!normalized) return null; return { date: normalized, ticket: String(ticket ? row[ticket] ?? "" : ""), shipment: String(shipment ? row[shipment] ?? "" : ""), region: String(row[region] ?? "Sem regional").trim() || "Sem regional", base: String(row[base] ?? "Sem base").trim() || "Sem base", type: String(row[type] ?? "Sem classificação").trim(), reason: String(row[reason] ?? "Sem motivo").trim(), origin: String(row[origin] ?? "Sem origem").trim(), tickets: number(row[tickets]), value: number(row[value]) }; }).filter((item): item is DamageRecord => Boolean(item));
  return { parsed, fileName, updatedAt, records, dates: [...new Set(records.map((item) => item.date))].sort(), regions: [...new Set(records.map((item) => item.region))].sort(), bases: [...new Set(records.map((item) => item.base))].sort() };
}
