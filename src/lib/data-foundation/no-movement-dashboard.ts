import { UNASSIGNED_RGM, UNASSIGNED_RM, UNASSIGNED_RM_AREA, officialRgmForRegion } from "../responsibility.ts";
import { NoMovementV2LoadError, type NoMovementV2Record } from "./no-movement.ts";

export type NoMovementFallbackReason = "awaiting_v2" | "v2_unavailable" | "v2_invalid";

export type NoMovementSourceSelection<TV2, TLegacy> =
  | { source: "V2"; data: TV2 }
  | {
      source: "LEGACY";
      data: TLegacy | null;
      reason: NoMovementFallbackReason;
      v2Error: string;
      legacyUnavailable: boolean;
    };

export async function selectNoMovementSource<TV2, TLegacy>(
  loadV2: () => Promise<TV2>,
  loadLegacy: () => Promise<TLegacy | null>,
): Promise<NoMovementSourceSelection<TV2, TLegacy>> {
  try {
    return { source: "V2", data: await loadV2() };
  } catch (cause) {
    const reason: NoMovementFallbackReason = cause instanceof NoMovementV2LoadError
      ? cause.kind === "empty" || cause.kind === "incompatible"
        ? "awaiting_v2"
        : cause.kind === "request"
          ? "v2_unavailable"
          : "v2_invalid"
      : "v2_unavailable";
    const v2Error = cause instanceof NoMovementV2LoadError
      ? cause.message
      : "Não foi possível validar a publicação da Data Foundation V2.";
    try {
      return {
        source: "LEGACY",
        data: await loadLegacy(),
        reason,
        v2Error,
        legacyUnavailable: false,
      };
    } catch {
      return {
        source: "LEGACY",
        data: null,
        reason,
        v2Error,
        legacyUnavailable: true,
      };
    }
  }
}

export const NO_MOVEMENT_SOURCE_HEADERS = {
  reported_region: "Regional responsável",
  source_base_code: "Código da unidade responsável",
  source_base_name: "Nome da unidade responsável",
  stopped_orders: "Total de pedidos sem movimentação",
  orders_in_transit: "Qtd pedidos em trânsito",
  stopped_over_1_day: "Sem mov. há mais de 1 dia",
  stopped_over_2_days: "Sem mov. há mais de 2 dias",
  stopped_over_3_days: "Sem mov. há mais de 3 dias",
  stopped_over_4_days: "Sem mov. há mais de 4 dias",
  stopped_over_5_days: "Sem mov. há mais de 5 dias",
  stopped_over_6_days: "Sem mov. há mais de 6 dias",
  stopped_over_7_days: "Sem mov. há mais de 7 dias",
  stopped_over_10_days: "Sem mov. há mais de 10 dias",
  stopped_over_14_days: "Sem mov. há mais de 14 dias",
  stopped_over_30_days: "Sem mov. há mais de 30 dias",
  last_operation_at: "Horário da última operação",
  stopped_14_plus_days_rate: "Taxa de sem mov 14+dias",
  stopped_30_plus_days_rate: "Taxa de sem mov 30+dias",
} as const satisfies Record<keyof Pick<NoMovementV2Record,
  | "reported_region" | "source_base_code" | "source_base_name" | "stopped_orders"
  | "orders_in_transit" | "stopped_over_1_day" | "stopped_over_2_days" | "stopped_over_3_days"
  | "stopped_over_4_days" | "stopped_over_5_days" | "stopped_over_6_days" | "stopped_over_7_days"
  | "stopped_over_10_days" | "stopped_over_14_days" | "stopped_over_30_days" | "last_operation_at"
  | "stopped_14_plus_days_rate" | "stopped_30_plus_days_rate"
>, string>;

export interface NoMovementDashboardRecord {
  key: string;
  region: string;
  rmArea: string;
  rm: string;
  rgm: string;
  code: string;
  base: string;
  totalStopped: number;
  inTransit: number;
  over1Day: number;
  over2Days: number;
  over3Days: number;
  over4Days: number;
  over5Days: number;
  over6Days: number;
  over7Days: number;
  over10Days: number;
  over14Days: number;
  over30Days: number;
  lastOperation: string;
  rate14Days: number | null;
  rate30Days: number | null;
  date: string;
  aging: string;
  status: string;
  origin: string;
  quantity: number;
  values: Record<string, unknown>;
  sourceRegion: string;
  mappingResolution: string;
}

function numericValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown): string {
  return String(value ?? "").trim();
}

export function mapNoMovementV2Record(record: NoMovementV2Record): NoMovementDashboardRecord {
  const sourceRegion = textValue(record.reported_region);
  const region = textValue(record.mapped_region) || "Sem regional";
  const baseCode = textValue(record.source_base_code);
  const baseName = textValue(record.source_base_name);
  const totalStopped = numericValue(record.stopped_orders);
  const values = Object.fromEntries(
    Object.entries(NO_MOVEMENT_SOURCE_HEADERS).map(([key, header]) => [header, record[key as keyof NoMovementV2Record]]),
  );
  return {
    key: `${textValue(record.publication_id)}:${numericValue(record.source_row_no)}`,
    region,
    rmArea: textValue(record.mapped_rm_area) || UNASSIGNED_RM_AREA,
    rm: textValue(record.mapped_rm) || UNASSIGNED_RM,
    rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
    code: baseCode || "—",
    base: baseName || baseCode || "Sem base",
    totalStopped,
    inTransit: numericValue(record.orders_in_transit),
    over1Day: numericValue(record.stopped_over_1_day),
    over2Days: numericValue(record.stopped_over_2_days),
    over3Days: numericValue(record.stopped_over_3_days),
    over4Days: numericValue(record.stopped_over_4_days),
    over5Days: numericValue(record.stopped_over_5_days),
    over6Days: numericValue(record.stopped_over_6_days),
    over7Days: numericValue(record.stopped_over_7_days),
    over10Days: numericValue(record.stopped_over_10_days),
    over14Days: numericValue(record.stopped_over_14_days),
    over30Days: numericValue(record.stopped_over_30_days),
    lastOperation: textValue(record.last_operation_at) || "—",
    rate14Days: record.stopped_14_plus_days_rate == null ? null : numericValue(record.stopped_14_plus_days_rate),
    rate30Days: record.stopped_30_plus_days_rate == null ? null : numericValue(record.stopped_30_plus_days_rate),
    date: "",
    aging: "Todas as faixas",
    status: "Resumo JMS",
    origin: "Sem origem",
    quantity: totalStopped,
    values,
    sourceRegion,
    mappingResolution: textValue(record.mapping_resolution) || "UNMAPPED",
  };
}
