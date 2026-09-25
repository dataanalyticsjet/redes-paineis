"use client";

import Image from "next/image";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Database,
  FileSpreadsheet,
  Filter,
  Info,
  Languages,
  Layers3,
  LockKeyhole,
  MapPin,
  PackageCheck,
  Printer,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  buildBipagemLoadedData,
  compareBipagemPeriod,
  summarizeBipagem,
  summarizeBipagemByBase,
  summarizeBipagemByRegional,
  type BipagemLoadedData,
  type BipagemMetricComparison,
  type BipagemMetrics,
  type BipagemPeriodComparison,
} from "./lib/bipagem";
import {
  buildSellerReportRows,
  filterSellerReportRows,
  filterSellerRowsByOutcome,
  normalizeSellerCategory,
  sortSellerReportRowsByAwaiting,
  summarizeAwaitingByBaseAndRm,
  summarizeSellerOutcomes,
  type SellerOutcome,
  type SellerCategory,
  type SellerReportMode,
  type SellerReportRow,
} from "./lib/seller-monitoring";
import {
  DASHBOARD_LANGUAGES,
  bilingualDashboardText,
  dashboardHtmlLang,
  dashboardLocale,
  isDashboardLanguage,
  translateDashboardText,
  type DashboardLanguage,
  type DashboardTranslator,
} from "./lib/i18n";
import type { ParsedWorkbook, WorkbookRow } from "./lib/workbook";
import { buildDamageData, type DamageData, type DamageRecord } from "./lib/damage";
import { MOVEMENT_SUMMARY_METRICS, selectMovementSummaryMetric } from "./lib/movement-summary";
import { summarizeTaxaPeriod } from "./lib/taxa-summary";
import {
  monitoringAwaitingRate,
  monitoringCollectedVolume,
  monitoringCollectionRate,
} from "./lib/monitoring-formulas";
import { extractSpecialSellerCodes } from "./lib/special-sellers";
import {
  buildResponsibilityData,
  matchesResponsibility,
  officialRgmForRegion,
  registeredRegionForBase,
  rmAreaForBase,
  responsibilityForBase,
  responsibilityOptions,
  UNASSIGNED_RGM,
  UNASSIGNED_RM,
  UNASSIGNED_RM_AREA,
  type ResponsibilityData,
} from "./lib/responsibility";

const STATUS_COLORS = [
  "#e60000",
  "#ff5a5f",
  "#991b1b",
  "#f97316",
  "#b80000",
  "#fb7185",
  "#7f1d1d",
  "#dc2626",
  "#c2410c",
  "#6b7280",
  "#111827",
  "#fca5a5",
  "#9f1239",
  "#d97706",
];

const PAGE_SIZE = 15;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ATTEMPT_RATE_TARGET = 0.99;
const TAXA_MAX_PERIOD_DAYS = 7;
const SELLER_CATEGORIES = ["J&T 重点保障", "单商多服"] as const satisfies readonly SellerCategory[];
const SELLER_REGIONAL_RATE_TARGET = 0.98;
const MONITORING_METRIC_OPTIONS = ["Previsto a coletar", "Aguardando coleta", "Coletado"] as const;
type MonitoringMetric = (typeof MONITORING_METRIC_OPTIONS)[number];
const DASHBOARD_LANGUAGE_STORAGE_KEY = "jt-dashboard-language";
const MODULE_IMPORT_RELOAD_PARAMETER = "module_refresh";
const MODULE_IMPORT_FAILURE_PATTERN = /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk .+ failed/i;

function formatCurrencyBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function recoverFromStaleModuleImport(cause: unknown): boolean {
  if (typeof window === "undefined") return false;
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (!MODULE_IMPORT_FAILURE_PATTERN.test(message)) return false;

  const now = Date.now();
  const reloadUrl = new URL(window.location.href);
  const lastReload = Number(reloadUrl.searchParams.get(MODULE_IMPORT_RELOAD_PARAMETER) ?? 0);
  if (Number.isFinite(lastReload) && now - lastReload < 60_000) return false;
  reloadUrl.searchParams.set(MODULE_IMPORT_RELOAD_PARAMETER, String(now));
  window.location.replace(reloadUrl.toString());
  return true;
}

const SELLER_OUTCOME_LABELS: Record<SellerOutcome, string> = {
  complete: "100%",
  partial: "Parcial",
  zero: "0%",
};
function attemptRateTargetForOrigins(origins: ReadonlySet<string>): number | null {
  if (origins.size !== 1) return null;
  const origin = normalizeSearchText([...origins][0]);
  if (origin.includes("tiktok")) return 0.98;
  if (origin.includes("temu")) return 0.99;
  return null;
}

const MONITORING_STATUS_LABELS: Record<string, string> = {
  "dorp off应揽收": "Coleta prevista no Drop-off",
  "drop off应揽收": "Coleta prevista no Drop-off",
  "pick up应揽收": "Coleta prevista Pick-up",
  "pickup应揽收": "Coleta prevista Pick-up",
  "coleta prevista pick up": "Coleta prevista Pick-up",
  "dorp off待揽收": "Aguardando coleta no Drop-off",
  "drop off待揽收": "Aguardando coleta no Drop-off",
  "pick up待揽收": "Aguardando coleta Pick-up",
  "pickup待揽收": "Aguardando coleta Pick-up",
  "aguardando coleta pick up": "Aguardando coleta Pick-up",
  "status atual coletado": "Status atual – Coletado",
  "status atual recebido na base": "Status atual – Recebido na base",
  "expedida pela base": "Expedida pela Base",
  "status atual em transito a partir da base": "Status atual – Em trânsito a partir da base",
  "chegada ao centro de triagem": "Chegada ao Centro de Triagem",
  "expedido pelo centro de triagem": "Expedido pelo Centro de Triagem",
  "status atual chegou ao sc": "Status atual – Chegou ao SC",
  "em transito sc": "Em trânsito SC",
  "em transito dc": "Em trânsito DC",
  "集散发件在途": "集散发件在途",
  "当前状态 网点发件流程中": "Status atual – Em trânsito a partir da base",
  "pacote criado pela base": "Pacote Criado pela Base",
  "problematicos registrados": "Problemáticos Registrados",
  "problematicos nao registrados": "Problemáticos Não Registrados",
};

type DashboardView = "home" | "monitoramento" | "taxa" | "epop" | "movimentacao" | "sellers" | "bipagem" | "damage";
type BipagemProblemType = "collection" | "receipt";
type SellerTier = SellerCategory;
type UploadKind = "monitoring" | "taxa" | "epop" | "movement" | "sellerList" | "sellerSpecialList" | "sellerPerformance" | "bipagem" | "damage";

interface PendingUpload {
  kind: UploadKind;
  files: File[];
}

interface TaxaHistoryNotice {
  addedDates: number;
  replacedDates: number;
  totalDates: number;
  totalRows: number;
}

interface LoadedData {
  parsed: ParsedWorkbook;
  fileName: string;
  dates: string[];
  bases: string[];
  regions: string[];
  origins: string[];
  originColumn?: string;
  statuses: string[];
  initialStart: string;
  initialEnd: string;
  blankBaseRows: number;
  updatedAt?: string;
}

interface SavedWorkbook {
  fileName: string;
  updatedAt: string;
  parsed: ParsedWorkbook;
}

type SavedWorkbookResponse = { workbook: SavedWorkbook | null };

/**
 * Supplementary dashboards must not prevent the primary dashboard from
 * rendering when a large workbook response is interrupted in transit.
 */
async function readOptionalWorkbook(response: Response | null): Promise<SavedWorkbook | null> {
  if (!response?.ok) return null;

  try {
    const payload = (await response.json()) as SavedWorkbookResponse;
    return payload.workbook ?? null;
  } catch {
    return null;
  }
}

interface TaxaColumns {
  date: string;
  region: string;
  base: string;
  origin: string;
  productType: string;
  orders: string;
  toCollect: string;
  canceled: string;
  collectionRate: string;
  collected: string;
  notCollected: string;
  notOnTime: string;
  onTime: string;
  onTimeRate: string;
  collectedWithAttempts: string;
  collectionWithAttemptsRate: string;
  averageCollectionHours: string;
  problemDone: string;
  problemNotDone: string;
  sellerCollectionRate: string;
  expectedSellerVisits: string;
  missingSellerVisits: string;
}

interface TaxaRecord {
  date: string;
  region: string;
  base: string;
  origin: string;
  productType: string;
  orders: number;
  toCollect: number;
  canceled: number;
  collected: number;
  notCollected: number;
  notOnTime: number;
  onTime: number;
  collectedWithAttempts: number;
  averageCollectionHours: number;
  problemDone: number;
  problemNotDone: number;
  expectedSellerVisits: number;
  missingSellerVisits: number;
}

interface TaxaLoadedData {
  parsed: ParsedWorkbook;
  fileName: string;
  columns: TaxaColumns;
  records: TaxaRecord[];
  dates: string[];
  bases: string[];
  regions: string[];
  origins: string[];
  initialStart: string;
  initialEnd: string;
  blankBaseRows: number;
  blankRegionRows: number;
  updatedAt?: string;
}

interface EpopRecord {
  date: string;
  origin: string;
  sellerId: string;
  address: string;
  base: string;
  baseCode: string;
  region: string;
  planned: number;
  collected: number;
  notCollected: number;
  epop: boolean;
  eligible: boolean;
  exclusionReason: string;
}

interface EpopLoadedData {
  parsed: ParsedWorkbook;
  fileName: string;
  updatedAt?: string;
  records: EpopRecord[];
  dates: string[];
  regions: string[];
  bases: string[];
}

interface MovementColumns {
  region: string;
  code: string;
  base: string;
  totalStopped: string;
  inTransit: string;
  over1Day: string;
  over2Days: string;
  over3Days: string;
  over4Days: string;
  over5Days: string;
  over6Days: string;
  over7Days: string;
  over10Days: string;
  over14Days: string;
  over30Days: string;
  lastOperation: string;
  rate14Days: string;
  rate30Days: string;
  date: string;
  aging: string;
  status: string;
  origin: string;
  quantity: string;
}

interface MovementRecord {
  key: string;
  region: string;
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
  rate14Days: number;
  rate30Days: number;
  date: string;
  aging: string;
  status: string;
  origin: string;
  quantity: number;
  values: Record<string, unknown>;
}

interface MovementLoadedData {
  format: "summary" | "list";
  parsed: ParsedWorkbook;
  fileName: string;
  columns: MovementColumns;
  records: MovementRecord[];
  bases: string[];
  regions: string[];
  dates: string[];
  agings: string[];
  statuses: string[];
  origins: string[];
  initialStart: string;
  initialEnd: string;
  displayColumns: string[];
  blankBaseRows: number;
  blankRegionRows: number;
  updatedAt?: string;
}

function movementFrom2DaysTotal(record: MovementRecord) {
  return (
    record.over2Days +
    record.over3Days +
    record.over4Days +
    record.over5Days +
    record.over6Days +
    record.over7Days +
    record.over10Days +
    record.over14Days +
    record.over30Days
  );
}

interface SellerReferenceRecord {
  sellerCode: string;
  tier: SellerTier;
  contactStatus: string;
  isSpecial: boolean;
}

interface SellerReferenceData {
  parsed: ParsedWorkbook;
  fileName: string;
  records: SellerReferenceRecord[];
  sellers: string[];
  tiers: SellerTier[];
  updatedAt?: string;
}

interface SpecialSellerData {
  parsed: ParsedWorkbook;
  fileName: string;
  sellerCodes: string[];
  updatedAt?: string;
}

interface SellerPerformanceColumns {
  date: string;
  region: string;
  base: string;
  client: string;
  sellerName: string;
  sellerCode: string;
  origin: string;
  awaiting: string;
  dropOff: string;
  collected: string;
  received: string;
  receivedBase: string;
  inTransitBase: string;
  arrivedSc: string;
}

interface SellerPerformanceRecord {
  key: string;
  date: string;
  region: string;
  base: string;
  client: string;
  sellerName: string;
  sellerCode: string;
  origin: string;
  tier: SellerTier;
  isSpecial: boolean;
  awaiting: number;
  dropOff: number;
  collected: number;
  received: number;
  receivedBase: number;
  inTransitBase: number;
  arrivedSc: number;
  processed: number;
  total: number;
}

interface SellerPerformanceData {
  parsed: ParsedWorkbook;
  fileName: string;
  columns: SellerPerformanceColumns;
  records: SellerPerformanceRecord[];
  dates: string[];
  regions: string[];
  bases: string[];
  sellers: string[];
  origins: string[];
  blankBaseRows: number;
  unknownSellerRows: number;
  missingSellerCount: number;
  updatedAt?: string;
}

interface ViewerIdentity {
  username: string;
  role: "matrix" | "regional";
  region: string | null;
}

interface StatusSummary {
  status: string;
  value: number;
  color: string;
}

interface RegionalSummary {
  region: string;
  total: number;
  activeBases: number;
  byStatus: StatusSummary[];
}

interface ConsolidatedBaseRow {
  key: string;
  region: string;
  base: string;
  origin: string;
  period: string;
  values: Map<string, number>;
  total: number;
}

interface MonitoringRegionalSummaryRow {
  region: string;
  rgm: string;
  period: string;
  orderVolume: number;
  awaiting: number;
  collected: number;
}

interface MonitoringRmSummaryRow {
  rmArea: string;
  rm: string;
  rgm: string;
  period: string;
  orderVolume: number;
  awaiting: number;
  collected: number;
}

interface MonitoringMetrics {
  orderVolume: number;
  awaiting: number;
  collected: number;
}

function activeDashboardLanguage(): DashboardLanguage {
  if (typeof document === "undefined") return "pt";
  const htmlLanguage = document.documentElement.lang.toLowerCase();
  if (htmlLanguage.startsWith("zh")) return "zh";
  if (htmlLanguage.startsWith("en")) return "en";
  return "pt";
}

function parseNumeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowBase(row: WorkbookRow, column: string): string {
  const value = String(row[column] ?? "").trim();
  return value || "Sem base";
}

function rowRegion(row: WorkbookRow, column?: string): string {
  if (!column) return "—";
  const value = String(row[column] ?? "").trim();
  return value || "Sem regional";
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(dashboardLocale(activeDashboardLanguage()), {
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function formatCompact(value: number): string {
  if (Math.abs(value) < 1000) return formatNumber(value);
  return new Intl.NumberFormat(dashboardLocale(activeDashboardLanguage()), {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(isoDate: string, compact = false): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  const date = new Date(year, month - 1, day, 12);
  return new Intl.DateTimeFormat(dashboardLocale(activeDashboardLanguage()), {
    day: "2-digit",
    month: compact ? "short" : "2-digit",
    year: compact ? undefined : "numeric",
  })
    .format(date)
    .replace(" de ", " ");
}

function formatDisplayDate(isoDate: string): string {
  return isoDate ? formatDate(isoDate) : "—";
}

function formatWeekday(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return "";
  const label = new Intl.DateTimeFormat(dashboardLocale(activeDashboardLanguage()), {
    weekday: "short",
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(year, month - 1, day, 12)))
    .replace(/\.$/, "");
  return label.charAt(0).toLocaleUpperCase(dashboardLocale(activeDashboardLanguage())) + label.slice(1);
}

function formatTaxaExcelDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const portuguese = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    weekday: "short",
    timeZone: "UTC",
  }).format(date).replace(/\./g, "");
  return `${portuguese}\n${String(month).padStart(2, "0")}月${String(day).padStart(2, "0")}日`;
}

function formatTaxaExcelPeriod(start: string, end: string): string {
  if (!start || !end || start === end) return formatTaxaExcelDate(end || start);
  const [startPt, startZh] = formatTaxaExcelDate(start).split("\n");
  const [endPt, endZh] = formatTaxaExcelDate(end).split("\n");
  return `${startPt} a ${endPt}\n${startZh} 至 ${endZh}`;
}

function taxaExcelOriginLabel(origins: ReadonlySet<string>): string {
  if (origins.size !== 1) return "TODAS AS ORIGENS / 全部订单来源";
  const origin = [...origins][0];
  const normalized = normalizeSearchText(origin);
  if (normalized.includes("tiktok")) return "TIK TOK";
  if (normalized.includes("temu")) return "TEMU";
  return origin.toLocaleUpperCase("pt-BR");
}

function isWeekendDate(isoDate: string): boolean {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function formatPeriod(start: string, end: string): string {
  const language = activeDashboardLanguage();
  if (!start || !end) return translateDashboardText(language, "Período não definido");
  const separator = language === "zh" ? " 至 " : language === "en" ? " to " : " a ";
  return `${formatDate(start)}${separator}${formatDate(end)}`;
}

function formatDateTime(value?: string): string {
  const language = activeDashboardLanguage();
  if (!value) return translateDashboardText(language, "Ainda não publicado");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(dashboardLocale(language), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function bipagemTrendLabel(comparison: BipagemMetricComparison, t: DashboardTranslator): string {
  if (comparison.trend === "improved") return t("Melhora");
  if (comparison.trend === "worsened") return t("Piora");
  return t("Estável");
}

function bipagemVariationLabel(comparison: BipagemMetricComparison, t: DashboardTranslator): string {
  if (comparison.variation === null) return t("Novo");
  return formatRate(Math.abs(comparison.variation));
}

function BipagemComparisonCell({ comparison, t }: { comparison: BipagemMetricComparison; t: DashboardTranslator }) {
  const arrow = comparison.trend === "improved" ? "↓" : comparison.trend === "worsened" ? "↑" : "→";
  return (
    <div className={`bipagem-comparison is-${comparison.trend}`}>
      <span className="bipagem-comparison-values">{formatNumber(comparison.startValue)} → {formatNumber(comparison.endValue)}</span>
      <strong>{arrow} {bipagemVariationLabel(comparison, t)}</strong>
      <small>{bipagemTrendLabel(comparison, t)}</small>
    </div>
  );
}

function bipagemComparisonExportLabel(comparison: BipagemMetricComparison, t: DashboardTranslator): string {
  const arrow = comparison.trend === "improved" ? "↓" : comparison.trend === "worsened" ? "↑" : "→";
  return `${formatNumber(comparison.startValue)} → ${formatNumber(comparison.endValue)} | ${arrow} ${bipagemVariationLabel(comparison, t)} (${bipagemTrendLabel(comparison, t)})`;
}

function bipagemScannedForProblem(metrics: BipagemMetrics, problem: BipagemProblemType): number {
  return problem === "collection"
    ? metrics.scannedCollection
    : Math.max(0, metrics.ordersToScan - metrics.notScannedReceipt);
}

function bipagemMissingForProblem(metrics: BipagemMetrics, problem: BipagemProblemType): number {
  return problem === "collection" ? metrics.notScannedCollection : metrics.notScannedReceipt;
}

function bipagemFailureRateForProblem(metrics: BipagemMetrics, problem: BipagemProblemType): number {
  return safeRate(bipagemMissingForProblem(metrics, problem), metrics.ordersToScan);
}

function bipagemComparisonForProblem(comparison: BipagemPeriodComparison, problem: BipagemProblemType): BipagemMetricComparison {
  return problem === "collection" ? comparison.collection : comparison.receipt;
}

function colorForStatus(status: string, allStatuses: string[]): string {
  const index = Math.max(0, allStatuses.indexOf(status));
  return STATUS_COLORS[index % STATUS_COLORS.length];
}

function monitoringStatusLabel(status: string, t: DashboardTranslator): string {
  return t(MONITORING_STATUS_LABELS[normalizeSearchText(status)] ?? status);
}

function monitoringMetricForStatus(status: string): MonitoringMetric | null {
  const normalized = normalizeSearchText(status).replace(/[–—_-]+/g, " ").replace(/\s+/g, " ").trim();
  const canonical = normalizeSearchText(MONITORING_STATUS_LABELS[normalized] ?? status)
    .replace(/[–—_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    canonical.includes("coleta prevista pick up") ||
    canonical.includes("coleta prevista pickup") ||
    canonical.includes("coleta prevista no drop off") ||
    canonical.includes("coleta prevista drop off") ||
    canonical.includes("coleta prevista dropoff")
  ) {
    return "Previsto a coletar";
  }
  if (
    canonical.includes("aguardando coleta pick up") ||
    canonical.includes("aguardando coleta pickup") ||
    canonical.includes("aguardando coleta no drop off") ||
    canonical.includes("aguardando coleta drop off") ||
    canonical.includes("aguardando coleta dropoff")
  ) {
    return "Aguardando coleta";
  }
  if (
    canonical.includes("status atual coletado") ||
    canonical.includes("status atual recebido na base") ||
    canonical.includes("expedida pela base") ||
    canonical.includes("status atual em transito a partir da base") ||
    canonical.includes("em transito sc") ||
    canonical.includes("em transito dc") ||
    canonical.includes("chegada ao centro de triagem") ||
    canonical.includes("expedido pelo centro de triagem") ||
    canonical.includes("集散发件在途") ||
    canonical.includes("网点发件在途") ||
    canonical.includes("网点发件流程中") ||
    canonical.includes("status atual chegou ao sc")
  ) {
    return "Coletado";
  }
  return null;
}

function monitoringStatusesForMetrics(statuses: readonly string[], metrics: ReadonlySet<MonitoringMetric>): string[] {
  return statuses.filter((status) => {
    const metric = monitoringMetricForStatus(status);
    return metric != null && metrics.has(metric);
  });
}

function monitoringMetricsForRow(row: WorkbookRow, statuses: readonly string[]): MonitoringMetrics {
  const metrics: MonitoringMetrics = { orderVolume: 0, awaiting: 0, collected: 0 };
  for (const status of statuses) {
    const metric = monitoringMetricForStatus(status);
    if (metric === "Previsto a coletar") metrics.orderVolume += parseNumeric(row[status]);
    if (metric === "Aguardando coleta") metrics.awaiting += parseNumeric(row[status]);
    if (metric === "Coletado") metrics.collected += parseNumeric(row[status]);
  }
  return metrics;
}

interface FirstScanMetrics {
  orderVolume: number;
  baseRetained: number;
  baseDispatched: number;
  hubArrived: number;
}

function firstScanValue(row: WorkbookRow, headers: readonly string[], aliases: readonly string[]): number {
  const aliasesNormalized = aliases.map(normalizeHeaderText);
  return headers
    .filter((header) => aliasesNormalized.includes(normalizeHeaderText(header)))
    .reduce((total, header) => total + parseNumeric(row[header]), 0);
}

/** The daily first-digitization report separates the operational retention
 * journey into: retained at base, dispatched by base and arrived at hub. */
function firstScanMetricsForRow(row: WorkbookRow, headers: readonly string[]): FirstScanMetrics {
  const orderVolume = firstScanValue(row, headers, ["Coleta Prevista Drop-off", "Coleta Prevista Pick-up"]);
  const baseRetained = firstScanValue(row, headers, ["Status atual – Coletado", "Status atual – Recebido na base"]);
  const baseDispatched = firstScanValue(row, headers, ["Expedida pela Base"]);
  const hubArrived = firstScanValue(row, headers, ["Chegada ao Centro de Triagem"]);
  return { orderVolume, baseRetained, baseDispatched, hubArrived };
}

function addFirstScanMetrics(target: FirstScanMetrics, value: FirstScanMetrics): void {
  target.orderVolume += value.orderVolume;
  target.baseRetained += value.baseRetained;
  target.baseDispatched += value.baseDispatched;
  target.hubArrived += value.hubArrived;
}

function firstScanTotalRetained(metrics: FirstScanMetrics): number {
  return metrics.baseRetained + metrics.baseDispatched + metrics.hubArrived;
}

/** In this report a smaller retention rate is healthier. */
function firstScanRateTone(rate: number): string {
  if (rate <= 0.01) return "is-good";
  if (rate <= 0.025) return "is-warning";
  if (rate <= 0.05) return "is-orange";
  return "is-critical";
}

function firstScanShareTone(rate: number): string {
  if (rate <= 0.05) return "is-good";
  if (rate <= 0.15) return "is-warning";
  if (rate <= 0.25) return "is-orange";
  return "is-critical";
}

function PtZhHeader({ pt, zh }: { pt: string; zh: string }) {
  return <span className="pt-zh-header"><span>{pt}</span><small>{zh}</small></span>;
}

function monitoringMetricValueFromMap(
  values: ReadonlyMap<string, number>,
  statuses: readonly string[],
  metric: MonitoringMetric,
): number {
  return statuses.reduce(
    (sum, status) => monitoringMetricForStatus(status) === metric ? sum + (values.get(status) ?? 0) : sum,
    0,
  );
}

function addMonitoringMetrics(target: MonitoringMetrics, value: MonitoringMetrics): void {
  target.orderVolume += value.orderVolume;
  target.awaiting += value.awaiting;
  target.collected += value.collected;
}

function rowOrigin(row: WorkbookRow, column?: string): string {
  if (!column) return "Sem origem";
  return String(row[column] ?? "").trim() || "Sem origem";
}

function basesForRegions(data: LoadedData, regions: Set<string>, responsibility: ResponsibilityData | null = null): string[] {
  if (!data.parsed.baseColumn) return [];
  return Array.from(
    new Set(
      data.parsed.rows
        .filter((row) => {
          const base = rowBase(row, data.parsed.baseColumn as string);
          return regions.has(registeredRegionForBase(responsibility, base, rowRegion(row, data.parsed.regionColumn)));
        })
        .map((row) => rowBase(row, data.parsed.baseColumn as string)),
    ),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function formatConsolidatedPeriod(start: string, end: string): string {
  if (!start || !end) return translateDashboardText(activeDashboardLanguage(), "Período");
  if (start === end) return formatDate(start);
  return formatPeriod(start, end);
}

function labelForSelection(
  selected: Set<string>,
  options: string[],
  singular: string,
  plural: string,
  t: DashboardTranslator,
): string {
  if (selected.size === options.length && options.length > 0) return t("Todos os {items}", { items: plural });
  if (selected.size === 0) return t("Nenhum {item}", { item: singular });
  if (selected.size === 1) return [...selected][0];
  return t("{count} {items} selecionados", { count: selected.size, items: plural });
}

function buildLoadedData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): LoadedData {
  if (!parsed.dateColumn) throw new Error("Não encontramos a coluna de data.");
  if (!parsed.baseColumn) throw new Error("Não encontramos a coluna de base.");

  const statuses = parsed.statusColumns.filter(
    (column) =>
      column !== parsed.statusColumn &&
      parsed.rows.some((row) => typeof row[column] === "number" || parseNumeric(row[column]) !== 0),
  );
  if (statuses.length === 0) {
    throw new Error("Nenhuma coluna numérica de status foi encontrada.");
  }

  const dates = Array.from(
    new Set(
      parsed.rows
        .map((row) => String(row[parsed.dateColumn as string] ?? ""))
        .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
    ),
  ).sort();
  if (dates.length === 0) throw new Error("Nenhuma data válida foi encontrada.");

  const bases = Array.from(
    new Set(parsed.rows.map((row) => rowBase(row, parsed.baseColumn as string))),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  const regions = Array.from(
    new Set(parsed.rows.map((row) => rowRegion(row, parsed.regionColumn))),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  const originColumn = parsed.originColumn ?? parsed.headers.find((header) =>
    ["origem do pedido", "origem pedido", "order origin", "order source", "订单来源", "订单渠道", "订单平台"]
      .includes(normalizeHeaderText(header)),
  );
  const origins = Array.from(
    new Set(parsed.rows.map((row) => rowOrigin(row, originColumn))),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  const latestDate = dates[dates.length - 1];
  const blankBaseRows = parsed.rows.filter(
    (row) => !String(row[parsed.baseColumn as string] ?? "").trim(),
  ).length;

  return {
    parsed,
    fileName,
    dates,
    bases,
    regions,
    origins,
    originColumn,
    statuses,
    // The first-digitization monitoring is always operated for the most
    // recent prior-day snapshot. Previous dates remain in history for the
    // daily comparison, but do not inflate the operational view by default.
    initialStart: latestDate,
    initialEnd: latestDate,
    blankBaseRows,
    updatedAt,
  };
}

function normalizeHeaderText(value: string): string {
  return normalizeSearchText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ").trim();
}

function findRequiredHeader(headers: string[], label: string, candidates: string[]): string {
  const normalizedCandidates = candidates.map(normalizeHeaderText);
  const exact = headers.find((header) => normalizedCandidates.includes(normalizeHeaderText(header)));
  if (exact) return exact;

  const partial = headers.find((header) => {
    const normalized = normalizeHeaderText(header);
    return normalizedCandidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized));
  });
  if (partial) return partial;

  throw new Error(`Não encontramos a coluna obrigatória para “${String(label)}”.`);
}

function findOptionalHeader(headers: string[], candidates: string[]): string {
  const normalizedCandidates = candidates.map(normalizeHeaderText);
  return headers.find((header) => normalizedCandidates.includes(normalizeHeaderText(header))) ??
    headers.find((header) => {
      const normalized = normalizeHeaderText(header);
      return normalizedCandidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized));
    }) ?? "";
}

/** Seller reports contain many display-only columns. Keep only the fields the
 * dashboard uses before posting them, so a normal 20 MB XLSX stays safe for
 * the Worker after JSON serialization. */
function compactSellerPerformanceWorkbook(
  parsed: ParsedWorkbook,
  officialSellerCodes: ReadonlySet<string>,
): ParsedWorkbook {
  const required = [
    parsed.dateColumn ?? findRequiredHeader(parsed.headers, "Data", ["Data"]),
    findRequiredHeader(parsed.headers, "Regional", ["Regional Origem", "Regional"]),
    findRequiredHeader(parsed.headers, "Base", ["PDD de saida", "PDD de saída", "Base"]),
    findRequiredHeader(parsed.headers, "Cliente", ["Cliente"]),
    findRequiredHeader(parsed.headers, "Loja", ["Loja", "Seller"]),
    findRequiredHeader(parsed.headers, "Id Seller/remetente", ["Id Seller/remetente", "Id Seller", "global_seller_id"]),
    findRequiredHeader(parsed.headers, "Origem do Pedido", ["Origem do Pedido"]),
    findRequiredHeader(parsed.headers, "Aguardando coleta", ["Status atual – Aguardando coleta", "Aguardando coleta"]),
    findRequiredHeader(parsed.headers, "Recebido no Drop-off", ["Status atual – Recebido no Drop-off", "Recebido no Drop-off"]),
    findRequiredHeader(parsed.headers, "Coletado", ["Status atual – Coletado", "Coletado"]),
    findRequiredHeader(parsed.headers, "Recebido", ["Status atual – Recebido"]),
    findRequiredHeader(parsed.headers, "Recebido na base", ["Status atual – Recebido na base", "Recebido na base"]),
    findRequiredHeader(parsed.headers, "Em trânsito a partir da base", ["Status atual – Em trânsito a partir da base", "Em trânsito a partir da base", "Em transito a partir da base", "当前状态-网点发件流程中", "当前状态-网点发件在途"]),
    findRequiredHeader(parsed.headers, "Chegou ao SC", ["Status atual – Chegou ao SC", "Chegou ao SC"]),
  ];
  const headers = [...new Set(required)];
  // The dashboard filters sellers by date, regional, base and seller code.
  // Client, display name and origin are descriptive fields, not dimensions;
  // keeping them in the grouping key explodes a 20 MB daily report into a
  // payload too large for the Worker.
  const dimensionHeaders = [required[0], required[1], required[2], required[5]];
  const descriptiveHeaders = [required[3], required[4], required[6]];
  const metricHeaders = required.slice(7);
  const sellerCodeHeader = required[5];
  const grouped = new Map<string, WorkbookRow>();
  for (const source of parsed.rows) {
    // The JMS export contains a large history for sellers outside the official
    // list. Those rows never appear in this dashboard, so excluding them here
    // prevents the browser from serializing and publishing unused data.
    if (!officialSellerCodes.has(normalizeSellerCode(source[sellerCodeHeader]))) continue;
    const dimensions = dimensionHeaders.map((header) => source[header] ?? "");
    const key = JSON.stringify(dimensions);
    const row = grouped.get(key) ?? Object.fromEntries([
      ...dimensionHeaders.map((header, index) => [header, dimensions[index]]),
      ...descriptiveHeaders.map((header) => [header, source[header] ?? ""]),
      ...metricHeaders.map((header) => [header, 0]),
    ]);
    for (const header of metricHeaders) row[header] = parseNumeric(row[header]) + parseNumeric(source[header]);
    grouped.set(key, row);
  }
  const rows = [...grouped.values()];
  return {
    ...parsed,
    headers,
    rows,
    metadata: { ...parsed.metadata, rowCount: rows.length, columnCount: headers.length, columns: parsed.metadata.columns.filter((column) => headers.includes(column.key)) },
    warnings: [...parsed.warnings, `Resumo de sellers consolidado: ${parsed.rows.length.toLocaleString("pt-BR")} linhas em ${rows.length.toLocaleString("pt-BR")} grupos.`],
  };
}

function movementValue(row: WorkbookRow, column: string): number {
  return parseNumeric(row[column]);
}

function formatMovementCell(value: unknown): string {
  if (typeof value === "number") {
    if (value > 20_000 && value < 80_000) return formatExcelDateTime(value);
    if (Math.abs(value) > 0 && Math.abs(value) < 1) return formatRate(value);
    return formatNumber(value);
  }
  const text = String(value ?? "").trim();
  return text || "—";
}

type ExcelExportValue = string | number | boolean | null | undefined;

interface ExcelExportColumn<Row> {
  header: string;
  value: (row: Row) => ExcelExportValue;
  width?: number;
  numberFormat?: string;
}

async function downloadRowsAsExcel<Row>(
  rows: readonly Row[],
  columns: readonly ExcelExportColumn<Row>[],
  sheetName: string,
  fileName: string,
): Promise<void> {
  const XLSX = await import("xlsx");
  const matrix = [
    columns.map((column) => column.header),
    ...rows.map((row) => columns.map((column) => column.value(row))),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(matrix);
  worksheet["!cols"] = columns.map((column) => ({ wch: column.width ?? 18 }));
  if (worksheet["!ref"]) worksheet["!autofilter"] = { ref: worksheet["!ref"] };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    columns.forEach((column, columnIndex) => {
      if (!column.numberFormat) return;
      const address = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      const cell = worksheet[address];
      if (cell) cell.z = column.numberFormat;
    });
  }

  const workbook = XLSX.utils.book_new();
  const safeSheetName = ["\\", "/", "?", "*", "[", "]", ":"]
    .reduce((name, character) => name.split(character).join(" "), sheetName)
    .trim()
    .slice(0, 31) || "Dados";
  XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
  XLSX.writeFile(workbook, fileName, { compression: true });
}

interface ManagementExcelSheet {
  name: string;
  title: string;
  headers: string[];
  rows: ExcelExportValue[][];
  widths: number[];
  percentageColumns: number[];
  performanceColumn: number;
  targetRate: number | null;
  totalMergeEndColumn?: number;
}

async function downloadTaxaManagementExcel(
  sheets: ManagementExcelSheet[],
  fileName: string,
): Promise<void> {
  const XLSXModule = await import("xlsx-js-style");
  const XLSX = XLSXModule.default;
  const workbook = XLSX.utils.book_new();
  const red = "E60000";
  const darkRed = "B80000";
  const paleRed = "FFF2F2";
  const green = "16843A";
  const border = {
    top: { style: "thin", color: { rgb: "1F1F1F" } },
    bottom: { style: "thin", color: { rgb: "1F1F1F" } },
    left: { style: "thin", color: { rgb: "1F1F1F" } },
    right: { style: "thin", color: { rgb: "1F1F1F" } },
  };

  for (const sheet of sheets) {
    const matrix: ExcelExportValue[][] = [
      [sheet.title, ...Array.from({ length: Math.max(0, sheet.headers.length - 1) }, () => "")],
      sheet.headers,
      ...sheet.rows,
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(matrix);
    const lastColumn = Math.max(0, sheet.headers.length - 1);
    const lastRow = matrix.length - 1;
    worksheet["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } },
      ...(sheet.totalMergeEndColumn != null && sheet.totalMergeEndColumn > 0
        ? [{ s: { r: lastRow, c: 0 }, e: { r: lastRow, c: Math.min(sheet.totalMergeEndColumn, lastColumn) } }]
        : []),
    ];
    worksheet["!cols"] = sheet.widths.map((width) => ({ wch: width }));
    worksheet["!rows"] = matrix.map((_, index) => ({ hpt: index === 0 ? (sheet.title.includes("\n") ? 44 : 30) : index === 1 ? 42 : 21 }));
    worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: lastRow, c: lastColumn } }) };
    worksheet["!freeze"] = { xSplit: Math.min(2, lastColumn), ySplit: 2 };
    worksheet["!views"] = [{ showGridLines: false }];

    for (let rowIndex = 0; rowIndex <= lastRow; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const cell = worksheet[address];
        if (!cell) continue;
        const isTitle = rowIndex === 0;
        const isHeader = rowIndex === 1;
        const isTotal = rowIndex === lastRow;
        cell.s = {
          border,
          fill: { fgColor: { rgb: isTitle || isHeader || isTotal ? red : rowIndex % 2 === 0 ? "FFFFFF" : paleRed } },
          font: {
            name: "Arial",
            sz: isTitle ? 15 : isHeader ? 10 : 9,
            bold: isTitle || isHeader || isTotal,
            color: { rgb: isTitle || isHeader || isTotal ? "FFFFFF" : "343A40" },
          },
          alignment: {
            horizontal: isTitle ? "center" : columnIndex < 2 ? "left" : "center",
            vertical: "center",
            wrapText: true,
          },
        };
        if (sheet.percentageColumns.includes(columnIndex) && rowIndex >= 2) cell.z = "0.0%";
        if (rowIndex >= 2 && typeof cell.v === "number" && /^valor(?: da arbitragem)?(?:\s|$|\()/i.test(sheet.headers[columnIndex] ?? "")) {
          cell.z = '"R$" #,##0.00';
        }
        if (
          !isTotal &&
          rowIndex >= 2 &&
          columnIndex === sheet.performanceColumn &&
          typeof cell.v === "number" &&
          sheet.targetRate != null
        ) {
          cell.s.font = {
            ...cell.s.font,
            bold: true,
            color: { rgb: cell.v >= sheet.targetRate ? green : darkRed },
          };
        }
      }
    }

    const safeName = ["\\", "/", "?", "*", "[", "]", ":"]
      .reduce((name, character) => name.split(character).join(" "), sheet.name)
      .trim()
      .slice(0, 31) || "Dados";
    XLSX.utils.book_append_sheet(workbook, worksheet, safeName);
  }

  XLSX.writeFile(workbook, fileName, { compression: true, cellStyles: true });
}

function formatExcelDateTime(value: number): string {
  const wholeDays = Math.floor(value);
  const fraction = value - wholeDays;
  const timestamp = Date.UTC(1899, 11, 30) + wholeDays * 86_400_000 + Math.round(fraction * 86_400_000);
  return new Intl.DateTimeFormat(dashboardLocale(activeDashboardLanguage()), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function formatSellerExcelPeriod(dateStart: string, dateEnd: string): string {
  const compact = (value: string) => {
    const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return match ? `${match[2]}-${match[1]}` : value || "data";
  };
  const start = compact(dateStart);
  const end = compact(dateEnd);
  return start === end ? start : `${start} a ${end}`;
}

function excelSerialToISODate(value: number): string {
  const utc = Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000;
  return new Date(utc).toISOString().slice(0, 10);
}

function toDashboardISODate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && Number.isFinite(value) && value > 20_000) return excelSerialToISODate(value);
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/);
  if (iso) return iso[1];
  const brazilian = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (brazilian) {
    const [, day, month, rawYear] = brazilian;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return "";
}

function taxaValue(row: WorkbookRow, column: string): number {
  return parseNumeric(row[column]);
}

function safeRate(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

function normalizeSellerCode(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(0);
  return String(value ?? "").trim();
}

function formatRate(value: number): string {
  return new Intl.NumberFormat(dashboardLocale(activeDashboardLanguage()), {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

function weightedAverage(totalWeighted: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return totalWeighted / denominator;
}

function buildTaxaLoadedData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): TaxaLoadedData {
  const headers = parsed.headers;
  const columns: TaxaColumns = {
    date: parsed.dateColumn ?? findRequiredHeader(headers, "date", ["Horário de término do prazo de coleta"]),
    region: findRequiredHeader(headers, "region", ["Nome da regional"]),
    base: findRequiredHeader(headers, "base", ["Nome da base de coleta"]),
    origin: findRequiredHeader(headers, "origin", ["Origem do Pedido"]),
    productType: findRequiredHeader(headers, "productType", ["Tipo de produto"]),
    orders: findRequiredHeader(headers, "orders", ["Quantidade de pedidos"]),
    toCollect: findRequiredHeader(headers, "toCollect", ["Qtd a coletar"]),
    canceled: findRequiredHeader(headers, "canceled", ["Qtd cancelada"]),
    collectionRate: findRequiredHeader(headers, "collectionRate", ["Taxa de coleta"]),
    collected: findRequiredHeader(headers, "collected", ["揽收量"]),
    notCollected: findRequiredHeader(headers, "notCollected", ["未揽收量"]),
    notOnTime: findRequiredHeader(headers, "notOnTime", ["Qtd não coletada no prazo"]),
    onTime: findRequiredHeader(headers, "onTime", ["Qtd coletada no prazo"]),
    onTimeRate: findRequiredHeader(headers, "onTimeRate", ["Taxa de coleta no prazo"]),
    collectedWithAttempts: findRequiredHeader(headers, "collectedWithAttempts", ["Pedidos coletados + Tentativas de coleta"]),
    collectionWithAttemptsRate: findRequiredHeader(headers, "collectionWithAttemptsRate", ["Taxa de coleta com tentativas de coleta"]),
    averageCollectionHours: findRequiredHeader(headers, "averageCollectionHours", ["Prazo médio demorado para coleta(h)"]),
    problemDone: findRequiredHeader(headers, "problemDone", ["已做问题件的量"]),
    problemNotDone: findRequiredHeader(headers, "problemNotDone", ["未做问题件的量"]),
    sellerCollectionRate: findRequiredHeader(headers, "sellerCollectionRate", ["Taxa de coleta do vendedor"]),
    expectedSellerVisits: findRequiredHeader(headers, "expectedSellerVisits", ["应上门商家量"]),
    missingSellerVisits: findRequiredHeader(headers, "missingSellerVisits", ["未上门商家量"]),
  };

  const records = parsed.rows
    .map((row) => {
      const date = toDashboardISODate(row[columns.date]);
      const rawToCollect = taxaValue(row, columns.toCollect);
      const collected = taxaValue(row, columns.collected);
      const notCollected = taxaValue(row, columns.notCollected);
      return {
        date,
        region: String(row[columns.region] ?? "").trim() || "Sem regional",
        base: String(row[columns.base] ?? "").trim() || "Sem base",
        origin: String(row[columns.origin] ?? "").trim() || "Sem origem",
        productType: String(row[columns.productType] ?? "").trim() || "Sem tipo",
        orders: taxaValue(row, columns.orders),
        // JMS uses the report's "Qtd a coletar" as the denominator. Do not
        // rebuild it from other columns because filtered periods can diverge.
        toCollect: rawToCollect,
        canceled: taxaValue(row, columns.canceled),
        collected,
        notCollected,
        notOnTime: taxaValue(row, columns.notOnTime),
        onTime: taxaValue(row, columns.onTime),
        collectedWithAttempts: taxaValue(row, columns.collectedWithAttempts),
        averageCollectionHours: taxaValue(row, columns.averageCollectionHours),
        problemDone: taxaValue(row, columns.problemDone),
        problemNotDone: taxaValue(row, columns.problemNotDone),
        expectedSellerVisits: taxaValue(row, columns.expectedSellerVisits),
        missingSellerVisits: taxaValue(row, columns.missingSellerVisits),
      } satisfies TaxaRecord;
    })
    .filter((record) => record.date);

  if (records.length === 0) throw new Error("Nenhuma linha com data válida foi encontrada para taxa de coleta.");

  const dates = Array.from(new Set(records.map((record) => record.date))).sort();
  const bases = Array.from(new Set(records.map((record) => record.base))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const regions = Array.from(new Set(records.map((record) => record.region))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const origins = Array.from(new Set(records.map((record) => record.origin))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );

  return {
    parsed,
    fileName,
    columns,
    records,
    dates,
    bases,
    regions,
    origins,
    initialStart: dates[0],
    initialEnd: dates[dates.length - 1],
    blankBaseRows: parsed.rows.filter((row) => !String(row[columns.base] ?? "").trim()).length,
    blankRegionRows: parsed.rows.filter((row) => !String(row[columns.region] ?? "").trim()).length,
    updatedAt,
  };
}

function buildEpopLoadedData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): EpopLoadedData {
  const header = (label: string, candidates: string[]) => findRequiredHeader(parsed.headers, label, candidates);
  const columns = {
    date: parsed.dateColumn ?? header("Data", ["Data"]), origin: header("Origem do Pedido", ["Origem do Pedido"]),
    sellerId: header("Id Seller/remetente", ["Id Seller/remetente", "Id Seller"]), address: header("Endereço da loja", ["Endereço da loja", "Endereco da loja"]),
    base: header("Nome da base", ["Nome da base", "Base"]), baseCode: header("Código da base", ["Código da base", "Codigo da base"]),
    region: header("Regional", ["Regional"]), planned: header("Quantidade prevista para coleta", ["Quantidade prevista para coleta"]),
    collected: header("Quantidade coletada", ["Quantidade coletada"]), notCollected: header("Qtd não coletada", ["Qtd não coletada", "Qtd nao coletada"]),
    proof: header("Transferência POC", ["Transferência POC", "Transferencia POC"]),
  };
  const records = parsed.rows.map((row) => {
    const region = String(row[columns.region] ?? "").trim();
    const base = String(row[columns.base] ?? "").trim();
    const sellerId = normalizeSellerCode(row[columns.sellerId]);
    const collected = taxaValue(row, columns.collected);
    const disabledRjBase = region.trim().toUpperCase() === "RJ" && ["CD CPG 001", "CD VTR 001"].includes(base.trim().replace(/\s+/g, " ").toUpperCase());
    const exclusionReason = !region ? "Regional em branco" : disabledRjBase ? "Base RJ temporariamente desativada" : !sellerId ? "ID do seller inválido" : collected <= 0 ? "Sem coleta / não elegível para EPOP" : "";
    return {
      date: toDashboardISODate(row[columns.date]), origin: String(row[columns.origin] ?? "").trim(), sellerId,
      address: String(row[columns.address] ?? "").trim(), base: base || "Sem base", baseCode: String(row[columns.baseCode] ?? "").trim(),
      region: region || "Sem regional", planned: taxaValue(row, columns.planned), collected,
      notCollected: taxaValue(row, columns.notCollected), epop: Boolean(String(row[columns.proof] ?? "").trim()),
      eligible: !exclusionReason, exclusionReason,
    } satisfies EpopRecord;
  }).filter((record) => record.origin.toLowerCase() === "tiktok" && record.date);
  const dates = [...new Set(records.map((record) => record.date))].sort();
  return { parsed, fileName, updatedAt, records, dates, regions: [...new Set(records.map((record) => record.region))].sort(), bases: [...new Set(records.map((record) => record.base))].sort() };
}

function buildMovementLoadedData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): MovementLoadedData {
  const headers = parsed.headers;
  const listAging = findOptionalHeader(headers, ["Aging"]);
  const listStatus = findOptionalHeader(headers, ["Tipo da última operação", "Tipo da ultima operacao", "Status"]);
  const listOrigin = findOptionalHeader(headers, ["Origem do Pedido", "Origem do pedido", "Origem"]);
  const listQuantity = findOptionalHeader(headers, ["Pedidos", "Quantidade de pedidos", "Qtd pedidos"]);
  const listDate = findOptionalHeader(headers, ["Horário da última operação", "Horario da ultima operacao"]);
  const isListFormat = Boolean(listAging && listStatus && listDate);
  const columns: MovementColumns = {
    region: findRequiredHeader(headers, "Regional responsável", ["Regional responsável", "Regional responsavel", "Regional mais recente", "Regional Remetente", "Regional"]),
    code: findRequiredHeader(headers, "Código da unidade responsável", ["Código da unidade responsável", "Codigo da unidade responsavel", "Código da base mais recente", "Código da Base Remetente", "Código da unidade", "Codigo da unidade"]),
    base: findRequiredHeader(headers, "Nome da unidade responsável", ["Unidade responsável", "Unidade responsavel", "Nome da unidade responsável", "Nome da unidade responsavel", "Nome da base mais recente", "Nome da Base Remetente", "Nome da unidade", "Base", "Unidade"]),
    totalStopped: isListFormat ? listQuantity : findRequiredHeader(headers, "Total de pedidos sem movimentação", ["Total de pedidos sem movimentação", "Total de pedidos sem movimentacao", "Pedidos sem movimentação"]),
    inTransit: isListFormat ? listQuantity : findRequiredHeader(headers, "Qtd pedidos em trânsito", ["Qtd pedidos em trânsito", "Qtd pedidos em transito", "Pedidos em trânsito"]),
    over1Day: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 1 dia", ["Sem mov. há mais de 1 dia", "Sem mov ha mais de 1 dia"]),
    over2Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 2 dias", ["Sem mov. há mais de 2 dias", "Sem mov ha mais de 2 dias"]),
    over3Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 3 dias", ["Sem mov. há mais de 3 dias", "Sem mov ha mais de 3 dias"]),
    over4Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 4 dias", ["Sem mov. há mais de 4 dias", "Sem mov ha mais de 4 dias"]),
    over5Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 5 dias", ["Sem mov. há mais de 5 dias", "Sem mov ha mais de 5 dias"]),
    over6Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 6 dias", ["Sem mov. há mais de 6 dias", "Sem mov ha mais de 6 dias"]),
    over7Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 7 dias", ["Sem mov. há mais de 7 dias", "Sem mov ha mais de 7 dias"]),
    over10Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 10 dias", ["Sem mov. há mais de 10 dias", "Sem mov ha mais de 10 dias"]),
    over14Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 14 dias", ["Sem mov. há mais de 14 dias", "Sem mov ha mais de 14 dias"]),
    over30Days: isListFormat ? "" : findRequiredHeader(headers, "Sem mov. há mais de 30 dias", ["Sem mov. há mais de 30 dias", "Sem mov ha mais de 30 dias"]),
    lastOperation: listDate || findRequiredHeader(headers, "Horário da última operação", ["Horário da última operação", "Horario da ultima operacao", "Última operação", "Ultima operacao"]),
    rate14Days: isListFormat ? "" : findRequiredHeader(headers, "Taxa de sem mov 14+dias", ["Taxa de sem mov 14+dias", "Taxa sem mov 14 dias"]),
    rate30Days: isListFormat ? "" : findRequiredHeader(headers, "Taxa de sem mov 30+dias", ["Taxa de sem mov 30+dias", "Taxa sem mov 30 dias"]),
    date: isListFormat ? listDate : "",
    aging: listAging,
    status: listStatus,
    origin: listOrigin,
    quantity: listQuantity,
  };

  const records = parsed.rows.map((row, index) => {
    const region = String(row[columns.region] ?? "").trim() || "Sem regional";
    const base = String(row[columns.base] ?? "").trim() || "Sem base";
    const code = String(row[columns.code] ?? "").trim() || "—";
    const quantity = isListFormat ? Math.max(0, movementValue(row, listQuantity) || 1) : movementValue(row, columns.totalStopped);
    const aging = String(row[columns.aging] ?? "").trim() || "Todas as faixas";
    const agingDays = Number(aging.match(/(\d+)\s*(?:day|dia)/i)?.[1] ?? 0);
    const bucket = (day: number) => isListFormat && agingDays === day ? quantity : 0;
    return {
      key: `${region}::${base}::${code}::${index}`,
      region,
      code,
      base,
      totalStopped: quantity,
      inTransit: isListFormat ? quantity : movementValue(row, columns.inTransit),
      over1Day: isListFormat ? bucket(1) : movementValue(row, columns.over1Day),
      over2Days: isListFormat ? bucket(2) : movementValue(row, columns.over2Days),
      over3Days: isListFormat ? bucket(3) : movementValue(row, columns.over3Days),
      over4Days: isListFormat ? bucket(4) : movementValue(row, columns.over4Days),
      over5Days: isListFormat ? bucket(5) : movementValue(row, columns.over5Days),
      over6Days: isListFormat ? bucket(6) : movementValue(row, columns.over6Days),
      over7Days: isListFormat ? bucket(7) : movementValue(row, columns.over7Days),
      over10Days: isListFormat ? bucket(10) : movementValue(row, columns.over10Days),
      over14Days: isListFormat ? bucket(14) : movementValue(row, columns.over14Days),
      over30Days: isListFormat ? (agingDays >= 30 ? quantity : 0) : movementValue(row, columns.over30Days),
      lastOperation: formatMovementCell(row[columns.lastOperation]),
      rate14Days: isListFormat ? 0 : movementValue(row, columns.rate14Days),
      rate30Days: isListFormat ? 0 : movementValue(row, columns.rate30Days),
      date: toDashboardISODate(row[columns.date]),
      aging,
      status: String(row[columns.status] ?? row[columns.lastOperation] ?? "").trim() || "Sem status",
      origin: String(row[columns.origin] ?? "").trim() || "Sem origem",
      quantity,
      values: Object.fromEntries(headers.map((header) => [header, row[header]])),
    } satisfies MovementRecord;
  });

  // A restricted regional account may legitimately have no rows in this snapshot.

  const bases = Array.from(new Set(records.map((record) => record.base))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const regions = Array.from(new Set(records.map((record) => record.region))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const dates = isListFormat ? Array.from(new Set(records.map((record) => record.date).filter(Boolean))).sort() : [];
  const agings = Array.from(new Set(records.map((record) => record.aging))).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  const statuses = Array.from(new Set(records.map((record) => record.status))).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const origins = Array.from(new Set(records.map((record) => record.origin))).sort((a, b) => a.localeCompare(b, "pt-BR"));

  return {
    parsed,
    fileName,
    columns,
    records,
    bases,
    regions,
    dates,
    agings,
    statuses,
    origins,
    initialStart: dates[0] ?? "",
    initialEnd: dates[dates.length - 1] ?? "",
    displayColumns: headers,
    format: isListFormat ? "list" : "summary",
    blankBaseRows: parsed.rows.filter((row) => !String(row[columns.base] ?? "").trim()).length,
    blankRegionRows: parsed.rows.filter((row) => !String(row[columns.region] ?? "").trim()).length,
    updatedAt,
  };
}

function taxaBasesForRegions(data: TaxaLoadedData, regions: Set<string>, responsibility: ResponsibilityData | null = null): string[] {
  return Array.from(
    new Set(data.records.filter((record) => regions.has(registeredRegionForBase(responsibility, record.base, record.region))).map((record) => record.base)),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function movementBasesForRegions(data: MovementLoadedData, regions: Set<string>, responsibility: ResponsibilityData | null = null): string[] {
  return Array.from(
    new Set(data.records.filter((record) => regions.has(registeredRegionForBase(responsibility, record.base, record.region))).map((record) => record.base)),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function sellerBasesForRegions(data: SellerPerformanceData, regions: Set<string>, responsibility: ResponsibilityData | null = null): string[] {
  return Array.from(
    new Set(data.records.filter((record) => regions.has(registeredRegionForBase(responsibility, record.base, record.region))).map((record) => record.base)),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function sellerOptionsForFilters(
  data: SellerPerformanceData,
  regions: Set<string>,
  bases: Set<string>,
  tiers: Set<string>,
  responsibility: ResponsibilityData | null = null,
): string[] {
  return Array.from(
    new Set(
      data.records
        .filter((record) =>
          regions.has(registeredRegionForBase(responsibility, record.base, record.region)) &&
          bases.has(record.base) &&
          tiers.has(record.tier))
        .map((record) => record.sellerCode),
    ),
  ).sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function buildSellerReferenceData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): SellerReferenceData {
  const headers = parsed.headers;
  const sellerColumn = findRequiredHeader(headers, "seller", ["global_seller_id", "Id Seller", "Seller"]);
  const tierColumn = findRequiredHeader(headers, "categoria", ["重点保障商家类型", "商家分层", "Categoria", "T4 T5", "Tier"]);
  const contactColumn = headers.find((header) => normalizeHeaderText(header).includes("进线")) ?? "";

  const bySeller = new Map<string, SellerReferenceRecord>();
  for (const row of parsed.rows) {
    const sellerCode = normalizeSellerCode(row[sellerColumn]);
    const tier = normalizeSellerCategory(row[tierColumn]);
    if (!sellerCode || !tier) continue;
    bySeller.set(sellerCode, {
      sellerCode,
      tier,
      contactStatus: contactColumn ? String(row[contactColumn] ?? "").trim() : "",
      isSpecial: false,
    });
  }

  const records = [...bySeller.values()].sort(
    (a, b) => a.tier.localeCompare(b.tier) || a.sellerCode.localeCompare(b.sellerCode, "pt-BR", { numeric: true }),
  );
  if (records.length === 0 && parsed.rows.length > 0) throw new Error("Nenhum seller J&T 重点保障 ou 单商多服 foi encontrado na lista de sellers.");

  return {
    parsed,
    fileName,
    records,
    sellers: records.map((record) => record.sellerCode),
    tiers: SELLER_CATEGORIES.filter((tier) => records.some((record) => record.tier === tier)),
    updatedAt,
  };
}

function buildSpecialSellerData(parsed: ParsedWorkbook, fileName: string, updatedAt?: string): SpecialSellerData {
  const sellerCodes = extractSpecialSellerCodes(parsed);
  if (sellerCodes.length === 0 && parsed.rows.length > 0) throw new Error("Nenhum seller especial foi encontrado na coluna B.");
  return { parsed, fileName, sellerCodes, updatedAt };
}

function mergeSellerReferenceData(reference: SellerReferenceData, special: SpecialSellerData | null): SellerReferenceData {
  if (!special || reference.records.some((record) => record.tier === "单商多服")) return reference;
  const specialCodes = new Set(special.sellerCodes);
  const bySeller = new Map(
    reference.records
      .filter((record) => record.tier !== "单商多服")
      .map((record) => [record.sellerCode, { ...record, isSpecial: specialCodes.has(record.sellerCode) }]),
  );
  for (const sellerCode of special.sellerCodes) {
    if (!bySeller.has(sellerCode)) {
      bySeller.set(sellerCode, { sellerCode, tier: "单商多服", contactStatus: "", isSpecial: true });
    }
  }
  const records = [...bySeller.values()].sort(
    (left, right) => left.tier.localeCompare(right.tier) || left.sellerCode.localeCompare(right.sellerCode),
  );
  return {
    ...reference,
    records,
    sellers: records.map((record) => record.sellerCode),
    tiers: SELLER_CATEGORIES.filter((tier) => records.some((record) => record.tier === tier)),
  };
}

function buildSellerPerformanceData(
  parsed: ParsedWorkbook,
  reference: SellerReferenceData,
  fileName: string,
  updatedAt?: string,
): SellerPerformanceData {
  const headers = parsed.headers;
  const columns: SellerPerformanceColumns = {
    date: parsed.dateColumn ?? findRequiredHeader(headers, "Data", ["Data"]),
    region: findRequiredHeader(headers, "Regional", ["Regional Origem", "Regional"]),
    base: findRequiredHeader(headers, "Base", ["PDD de saida", "PDD de saída", "Base"]),
    client: findRequiredHeader(headers, "Cliente", ["Cliente"]),
    sellerName: findRequiredHeader(headers, "Loja", ["Loja", "Seller"]),
    sellerCode: findRequiredHeader(headers, "Id Seller/remetente", ["Id Seller/remetente", "Id Seller", "global_seller_id"]),
    origin: findRequiredHeader(headers, "Origem do Pedido", ["Origem do Pedido"]),
    awaiting: findRequiredHeader(headers, "Status atual – Aguardando coleta", ["Status atual – Aguardando coleta", "Aguardando coleta"]),
    dropOff: findRequiredHeader(headers, "Status atual – Recebido no Drop-off", ["Status atual – Recebido no Drop-off", "Recebido no Drop-off"]),
    collected: findRequiredHeader(headers, "Status atual – Coletado", ["Status atual – Coletado", "Coletado"]),
    received: findRequiredHeader(headers, "Status atual – Recebido", ["Status atual – Recebido"]),
    receivedBase: findRequiredHeader(headers, "Status atual – Recebido na base", ["Status atual – Recebido na base", "Recebido na base"]),
    inTransitBase: findRequiredHeader(headers, "Status atual – Em trânsito a partir da base", [
      "Status atual – Em trânsito a partir da base",
      "Em trânsito a partir da base",
      "Em transito a partir da base",
      "当前状态-网点发件流程中",
      "当前状态-网点发件在途",
    ]),
    arrivedSc: findRequiredHeader(headers, "Status atual – Chegou ao SC", ["Status atual – Chegou ao SC", "Chegou ao SC"]),
  };

  const sellerMap = new Map(reference.records.map((record) => [record.sellerCode, record]));
  let unknownSellerRows = 0;
  const matchedRecords = parsed.rows.flatMap((row, index) => {
    const sellerCode = normalizeSellerCode(row[columns.sellerCode]);
    const referenceRecord = sellerMap.get(sellerCode);
    if (!referenceRecord) {
      unknownSellerRows += 1;
      return [];
    }
    const date = toDashboardISODate(row[columns.date]);
    if (!date) return [];
    const awaiting = taxaValue(row, columns.awaiting);
    const dropOff = taxaValue(row, columns.dropOff);
    const collected = taxaValue(row, columns.collected);
    const received = taxaValue(row, columns.received);
    const receivedBase = taxaValue(row, columns.receivedBase);
    const inTransitBase = taxaValue(row, columns.inTransitBase);
    const arrivedSc = taxaValue(row, columns.arrivedSc);
    const processed = dropOff + collected + received + receivedBase + inTransitBase + arrivedSc;
    const total = awaiting + processed;

    return [{
      key: `${date}::${sellerCode}::${index}`,
      date,
      region: String(row[columns.region] ?? "").trim() || "Sem regional",
      base: String(row[columns.base] ?? "").trim() || "Sem base",
      client: String(row[columns.client] ?? "").trim() || "Sem cliente",
      sellerName: String(row[columns.sellerName] ?? "").trim() || "Sem loja",
      sellerCode,
      origin: String(row[columns.origin] ?? "").trim() || "Sem origem",
      tier: referenceRecord.tier,
      isSpecial: referenceRecord.isSpecial,
      awaiting,
      dropOff,
      collected,
      received,
      receivedBase,
      inTransitBase,
      arrivedSc,
      processed,
      total,
    } satisfies SellerPerformanceRecord];
  });

  const sourceDates = Array.from(
    new Set(
      parsed.rows
        .map((row) => toDashboardISODate(row[columns.date]))
        .filter((date): date is string => Boolean(date)),
    ),
  ).sort();
  if (sourceDates.length === 0) {
    throw new Error("Nenhuma data válida foi encontrada no resumo JMS.");
  }

  const matchedSellerCodes = new Set(matchedRecords.map((record) => record.sellerCode));
  const fallbackDate = sourceDates[sourceDates.length - 1];
  const missingRecords = reference.records
    .filter((record) => !matchedSellerCodes.has(record.sellerCode))
    .map((record, index) => ({
      key: `${fallbackDate}::${record.sellerCode}::missing::${index}`,
      date: fallbackDate,
      region: "Sem regional",
      base: "Sem base",
      client: "Sem cliente",
      sellerName: "Sem dados no Resumo JMS",
      sellerCode: record.sellerCode,
      origin: "Sem registro no Resumo JMS",
      tier: record.tier,
      isSpecial: record.isSpecial,
      awaiting: 0,
      dropOff: 0,
      collected: 0,
      received: 0,
      receivedBase: 0,
      inTransitBase: 0,
      arrivedSc: 0,
      processed: 0,
      total: 0,
    } satisfies SellerPerformanceRecord));
  const records = [...matchedRecords, ...missingRecords];

  const dates = Array.from(new Set(records.map((record) => record.date))).sort();
  const regions = Array.from(new Set(records.map((record) => record.region))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const bases = Array.from(new Set(records.map((record) => record.base))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const sellers = Array.from(new Set(records.map((record) => record.sellerCode))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
  const origins = Array.from(new Set(records.map((record) => record.origin))).sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );

  return {
    parsed,
    fileName,
    columns,
    records,
    dates,
    regions,
    bases,
    sellers,
    origins,
    blankBaseRows: parsed.rows.filter((row) => !String(row[columns.base] ?? "").trim()).length,
    unknownSellerRows,
    missingSellerCount: missingRecords.length,
    updatedAt,
  };
}

function StatusDot({ color }: { color: string }) {
  return <span className="status-dot" style={{ backgroundColor: color }} aria-hidden="true" />;
}

function SellerReportTableHead({ mode, t }: { mode: SellerReportMode; t: DashboardTranslator }) {
  return (
    <tr>
      <th>{t("Período")}</th>
      <th>{t("Categoria")}</th>
      <th>{t("Regional")}</th>
      <th>{t(mode === "regional" ? "Bases" : "Base")}</th>
      <th>RM</th>
      <th>RGM</th>
      {mode === "seller" ? (
        <>
          <th>{t("Seller")}</th>
          <th>{t("Código seller")}</th>
          <th>{t("Origem")}</th>
        </>
      ) : (
        <th>{t("Sellers")}</th>
      )}
      <th aria-sort="descending">{t("Aguardando coleta")} <span className="sort-direction" aria-hidden="true">↓</span></th>
      <th>{t("Processados")}</th>
      <th>{t("Total")}</th>
      <th>{t("% processamento")}</th>
    </tr>
  );
}

function SellerReportTableRows({
  mode,
  rows,
}: {
  mode: SellerReportMode;
  rows: readonly SellerReportRow[];
}) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.key}>
          <td className="date-cell">{row.period}</td>
          <td><span className="regional-chip">{row.tierLabel}</span></td>
          <td><span className="regional-chip">{row.region}</span></td>
          <td className={mode === "regional" ? "number-cell" : "base-cell"}>
            {mode === "regional" ? formatNumber(row.baseCount) : row.base}
          </td>
          <td>{row.rmLabel}</td>
          <td>{row.rgmLabel}</td>
          {mode === "seller" ? (
            <>
              <td>{row.sellerName}</td>
              <td>{row.sellerCode}</td>
              <td>{row.originLabel || "—"}</td>
            </>
          ) : (
            <td className="number-cell">{formatNumber(row.sellerCount)}</td>
          )}
          <td className="number-cell total-cell">{formatNumber(row.awaiting)}</td>
          <td className="number-cell">{formatNumber(row.processed)}</td>
          <td className="number-cell">{formatNumber(row.total)}</td>
          <td className="number-cell">{formatRate(row.rate)}</td>
        </tr>
      ))}
    </>
  );
}

interface MultiSelectProps {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (value: Set<string>) => void;
  allLabel: string;
  singular: string;
  plural: string;
  searchable?: boolean;
  colorOptions?: string[];
  getOptionLabel?: (option: string) => string;
  t: DashboardTranslator;
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  allLabel,
  singular,
  plural,
  searchable = false,
  colorOptions,
  getOptionLabel = (option) => option,
  t,
}: MultiSelectProps) {
  const [query, setQuery] = useState("");
  const allSelected = selected.size === options.length && options.length > 0;
  const selectedLabel =
    selected.size === 1
      ? getOptionLabel([...selected][0])
      : labelForSelection(selected, options, singular, plural, t);
  const filteredOptions = useMemo(() => {
    const normalized = normalizeSearchText(query.trim());
    if (!normalized) return options;
    return options.filter((option) => normalizeSearchText(`${getOptionLabel(option)} ${option}`).includes(normalized));
  }, [getOptionLabel, options, query]);

  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  };

  return (
    <div className="filter-field">
      <span className="filter-label">{label}</span>
      <details className="multi-select">
        <summary>
          <span>{selectedLabel}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="multi-select-popover">
          {searchable ? (
            <label className="menu-search">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">{t("Buscar {items}", { items: plural })}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("Buscar {items}...", { items: plural })}
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label={t("Limpar busca")}>
                  <X size={14} />
                </button>
              ) : null}
            </label>
          ) : null}
          <button
            type="button"
            className={`menu-option menu-option-all${allSelected ? " selected" : ""}`}
            onClick={() => onChange(allSelected ? new Set() : new Set(options))}
          >
            <span className="fake-checkbox">{allSelected ? <Check size={14} /> : null}</span>
            <span>{allLabel}</span>
            <small>{options.length}</small>
          </button>
          <div className="menu-options" role="group" aria-label={label}>
            {filteredOptions.map((option) => {
              const isSelected = selected.has(option);
              return (
                <label className={`menu-option${isSelected ? " selected" : ""}`} key={option}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(option)}
                  />
                  <span className="fake-checkbox">{isSelected ? <Check size={14} /> : null}</span>
                  {colorOptions ? <StatusDot color={colorForStatus(option, colorOptions)} /> : null}
                  <span title={getOptionLabel(option)}>{getOptionLabel(option)}</span>
                </label>
              );
            })}
            {filteredOptions.length === 0 ? (
              <p className="menu-empty">{t("Nenhuma opção encontrada.")}</p>
            ) : null}
          </div>
          <div className="menu-footer">
            <span>{t("{count} selecionado(s)", { count: selected.size })}</span>
            <button type="button" onClick={() => onChange(new Set())}>
              {t("Limpar")}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

interface EmptyDashboardPanelProps {
  loading: boolean;
  error: string | null;
  onDrop: (file: File) => void;
  inputId?: string;
  t: DashboardTranslator;
}

function EmptyDashboardPanel({ loading, error, onDrop, t, inputId = "monitoring-upload" }: EmptyDashboardPanelProps) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onDrop(file);
  };

  return (
    <>
      <section className="dashboard-intro">
        <div>
          <div className="eyebrow"><Activity size={15} /> {t("Visão consolidada")}</div>
          <h1>{t("DASH BOARD - MONITORAMENTO DE COLETA")}</h1>
          <p>{t("O dashboard abre a última planilha publicada. Carregue um Excel para atualizar todos os acessos.")}</p>
        </div>
        <div className="dataset-meta" aria-label={t("Resumo aguardando arquivo")}>
          <span><Layers3 size={16} /> {t("Aguardando dados publicados")}</span>
          <span><MapPin size={16} /> {t("Regional")}</span>
          <span><Database size={16} /> {t("Base")}</span>
          <span><PackageCheck size={16} /> {t("Status")}</span>
        </div>
      </section>

      {error ? (
        <div className="inline-alert error" role="alert">
          <CircleAlert size={18} />
          <span>{t(error)}</span>
        </div>
      ) : null}

      <div
        className={`filters-card upload-ready-card${dragging ? " dragging" : ""}${loading ? " loading" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <div className="upload-ready-icon" aria-hidden="true">
          <FileSpreadsheet size={26} />
        </div>
        <div>
          <span className="card-eyebrow">{t("ARQUIVO DE MONITORAMENTO")}</span>
          <h2>{t(loading ? "Buscando última atualização..." : "Publique o arquivo Excel")}</h2>
          <p>{t("Arraste a planilha para cá ou selecione o arquivo baixado. Depois de publicar, todos veem a mesma atualização pelo link.")}</p>
        </div>
        <label className="primary-upload-button" htmlFor={inputId}>
          <Upload size={18} />
          {t(loading ? "Processando…" : "Carregar arquivo Excel")}
        </label>
      </div>

      <section className="kpi-grid" aria-label={t("Indicadores aguardando arquivo")}>
        <KpiCard icon={<MapPin size={20} />} label={t("Regional")} value="--" detail={t("Disponível após carregar Excel")} />
        <KpiCard icon={<Database size={20} />} label={t("Base")} value="--" detail={t("Top bases por regional")} tone="orange" />
        <KpiCard icon={<PackageCheck size={20} />} label={t("Status")} value="--" detail={t("Recebido, expedido e em trânsito")} tone="dark" />
        <KpiCard icon={<ShieldCheck size={20} />} label={t("Dados publicados")} value="--" detail={t("Aparecem para todos após atualizar")} tone="soft" />
      </section>
    </>
  );
}

function BilingualText({
  source,
  values,
  language,
}: {
  source: string;
  values?: Record<string, string | number>;
  language: DashboardLanguage;
}) {
  if (language !== "pt") return <>{translateDashboardText(language, source, values)}</>;
  const { portuguese, mandarin } = bilingualDashboardText(source, values);
  return (
    <span className="bilingual-text">
      <span className="bilingual-pt">{portuguese}</span>
      {mandarin ? <span className="bilingual-zh">{mandarin}</span> : null}
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  detail,
  secondaryLabel,
  secondaryValue,
  tone = "red",
  title,
}: {
  icon: ReactNode;
  label: ReactNode;
  value: string;
  detail: ReactNode;
  secondaryLabel?: ReactNode;
  secondaryValue?: string;
  tone?: "red" | "orange" | "dark" | "soft";
  title?: string;
}) {
  return (
    <article className={`kpi-card tone-${tone}`} title={title}>
      <div className="kpi-top">
        <span>{label}</span>
        <div className="kpi-icon">{icon}</div>
      </div>
      {secondaryLabel && secondaryValue ? (
        <div className="kpi-dual-values">
          <strong>{value}</strong>
          <div>
            <span>{secondaryLabel}</span>
            <strong>{secondaryValue}</strong>
          </div>
        </div>
      ) : (
        <strong>{value}</strong>
      )}
      <small>{detail}</small>
    </article>
  );
}

function SellerOutcomeKpi({
  items,
  selected,
  onSelect,
  t,
}: {
  items: Array<{
    outcome: SellerOutcome;
    label: string;
    count: number;
    rate: number;
  }>;
  selected: SellerOutcome | null;
  onSelect: (outcome: SellerOutcome) => void;
  t: DashboardTranslator;
}) {
  return (
    <article className="kpi-card seller-outcome-kpi tone-dark">
      <div className="kpi-top">
        <span>{t("Resultado dos sellers")}</span>
        <div className="kpi-icon"><ShieldCheck size={20} /></div>
      </div>
      <div className="seller-outcome-options">
        {items.map((item) => (
          <button
            type="button"
            className={`seller-outcome-option outcome-${item.outcome}${selected === item.outcome ? " is-active" : ""}`}
            key={item.outcome}
            aria-controls="seller-detail-section"
            aria-pressed={selected === item.outcome}
            aria-label={t("Ver {count} sellers com resultado {result}, {rate} do total", {
              count: formatNumber(item.count),
              result: item.label,
              rate: formatRate(item.rate),
            })}
            onClick={() => onSelect(item.outcome)}
          >
            <span>{item.label}</span>
            <strong>{formatRate(item.rate)}</strong>
            <small>{t("{count} sellers", { count: formatNumber(item.count) })}</small>
          </button>
        ))}
      </div>
    </article>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="empty-chart">
      <BarChart3 size={28} />
      <p>{message}</p>
    </div>
  );
}

function DashboardHome({
  onSelect,
  monitoringUpdatedAt,
  taxaUpdatedAt,
  movementUpdatedAt,
  sellersUpdatedAt,
  bipagemUpdatedAt,
  damageUpdatedAt,
  language,
  t,
}: {
  onSelect: (view: Exclude<DashboardView, "home">) => void;
  monitoringUpdatedAt?: string;
  taxaUpdatedAt?: string;
  movementUpdatedAt?: string;
  sellersUpdatedAt?: string;
  bipagemUpdatedAt?: string;
  damageUpdatedAt?: string;
  language: DashboardLanguage;
  t: DashboardTranslator;
}) {
  return (
    <section className="home-panel" aria-labelledby="home-title">
      <div className="home-copy">
        <div className="eyebrow"><Activity size={15} /> {t("Central operacional")}</div>
        <h1 id="home-title">{t("DASH BOARD - MONITORAMENTO DE COLETA")}</h1>
        <p>{t("Selecione qual painel deseja abrir. Cada painel mantém sua última planilha publicada para todos que acessarem o link.")}</p>
        <small className="home-upload-note">{t("Aguardando dados publicados · Carregar arquivo Excel dentro do painel escolhido.")}</small>
      </div>
      <div className="home-actions-grid">
        <button type="button" className="home-action-card" onClick={() => onSelect("monitoramento")}>
          <span className="home-action-icon"><PackageCheck size={28} /></span>
          <span className="card-eyebrow">{t("OPERAÇÃO")}</span>
          <strong>{t("Monitoramento de coleta")}</strong>
          <small>{t("Pedidos parados por regional, base, status e período.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(monitoringUpdatedAt) })}</em>
        </button>
        <button type="button" className="home-action-card accent" onClick={() => onSelect("taxa")}>
          <span className="home-action-icon"><Target size={28} /></span>
          <span className="card-eyebrow">{t("PERFORMANCE")}</span>
          <strong>{t("Taxa de coleta")}</strong>
          <small>{t("Taxa de coleta, tentativa, origem do pedido e performance por regional.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(taxaUpdatedAt) })}</em>
        </button>
        <button type="button" className="home-action-card accent" onClick={() => onSelect("epop")}>
          <span className="home-action-icon"><Check size={28} /></span>
          <span className="card-eyebrow">EPOP / ePOD</span>
          <strong>{t("Cobertura EPOP")}</strong>
          <small>{t("Comprovantes EPOP por regional, base e seller TikTok.")}</small>
          <em>{t("Última atualização: {date}", { date: "—" })}</em>
        </button>
        <button type="button" className="home-action-card sellers" onClick={() => onSelect("sellers")}>
          <span className="home-action-icon"><ShieldCheck size={28} /></span>
          <span className="card-eyebrow">{t("SELLERS J&T 重点保障")}</span>
          <strong>{t("Monitoramento J&T 重点保障")}</strong>
          <small>{t("Processamento por seller, categoria, regional e base com foco nos sellers importantes.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(sellersUpdatedAt) })}</em>
        </button>
        <button type="button" className="home-action-card movement" onClick={() => onSelect("movimentacao")}>
          <span className="home-action-icon"><CircleAlert size={28} /></span>
          <span className="card-eyebrow">{t("MOVIMENTAÇÃO")}</span>
          <strong>{t("Sem movimentação")}</strong>
          <small>{t("Pedidos sem movimentação por AGING, regional, RM, base, status, origem e período.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(movementUpdatedAt) })}</em>
        </button>
        <button type="button" className="home-action-card accent" onClick={() => onSelect("bipagem")}>
          <span className="home-action-icon"><CircleAlert size={28} /></span>
          <span className="card-eyebrow">PDD</span>
          <strong>{t("Falha na coleta PDD")}</strong>
          <small>{t("Volume a digitalizar, falhas na coleta e taxa por regional, RM e RGM.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(bipagemUpdatedAt) })}</em>
        </button>
        <button type="button" className="home-action-card movement" onClick={() => onSelect("damage")}>
          <span className="home-action-icon"><CircleAlert size={28} /></span>
          <span className="card-eyebrow">{t("QUALIDADE")}</span>
          <strong><BilingualText language={language} source="Extravio" /></strong>
          <small>{t("Pedidos, valor de arbitragem, RM/RGM, base, origem e motivos.")}</small>
          <em>{t("Última atualização: {date}", { date: formatDateTime(damageUpdatedAt) })}</em>
        </button>
      </div>
    </section>
  );
}

export function DashboardApp() {
  const [language, setLanguage] = useState<DashboardLanguage>("pt");
  const [viewerAuthorization, setViewerAuthorization] = useState<string | null>(null);
  const [viewerIdentity, setViewerIdentity] = useState<ViewerIdentity | null>(null);
  const [viewerChecked, setViewerChecked] = useState(false);
  const [viewerUsername, setViewerUsername] = useState("");
  const [viewerPassword, setViewerPassword] = useState("");
  const [viewerAuthError, setViewerAuthError] = useState<string | null>(null);
  const [viewerAuthLoading, setViewerAuthLoading] = useState(false);
  const [view, setView] = useState<DashboardView>("home");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisCopied, setAnalysisCopied] = useState(false);
  const [loaded, setLoaded] = useState<LoadedData | null>(null);
  const [selectedBases, setSelectedBases] = useState<Set<string>>(new Set());
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [selectedMonitoringMetrics, setSelectedMonitoringMetrics] = useState<Set<MonitoringMetric>>(new Set(MONITORING_METRIC_OPTIONS));
  const [selectedOrigins, setSelectedOrigins] = useState<Set<string>>(new Set());
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [taxaLoaded, setTaxaLoaded] = useState<TaxaLoadedData | null>(null);
  const [epopLoaded, setEpopLoaded] = useState<EpopLoadedData | null>(null);
  const [epopSelectedRegions, setEpopSelectedRegions] = useState<Set<string>>(new Set());
  const [epopSelectedBases, setEpopSelectedBases] = useState<Set<string>>(new Set());
  const [epopDateStart, setEpopDateStart] = useState("");
  const [epopDateEnd, setEpopDateEnd] = useState("");
  const [epopLoading, setEpopLoading] = useState(false);
  const [epopHistoryNotice, setEpopHistoryNotice] = useState<TaxaHistoryNotice | null>(null);
  const [taxaSelectedBases, setTaxaSelectedBases] = useState<Set<string>>(new Set());
  const [taxaSelectedRegions, setTaxaSelectedRegions] = useState<Set<string>>(new Set());
  const [taxaSelectedOrigins, setTaxaSelectedOrigins] = useState<Set<string>>(new Set());
  const [taxaSelectedRmAreas, setTaxaSelectedRmAreas] = useState<Set<string>>(new Set([UNASSIGNED_RM_AREA]));
  const [taxaDateStart, setTaxaDateStart] = useState("");
  const [taxaDateEnd, setTaxaDateEnd] = useState("");
  const [taxaLoading, setTaxaLoading] = useState(true);
  const [taxaTableQuery, setTaxaTableQuery] = useState("");
  const [taxaPage, setTaxaPage] = useState(1);
  const [taxaHistoryNotice, setTaxaHistoryNotice] = useState<TaxaHistoryNotice | null>(null);
  const [movementLoaded, setMovementLoaded] = useState<MovementLoadedData | null>(null);
  const [movementSelectedBases, setMovementSelectedBases] = useState<Set<string>>(new Set());
  const [movementSelectedRegions, setMovementSelectedRegions] = useState<Set<string>>(new Set());
  const [movementSelectedRmAreas, setMovementSelectedRmAreas] = useState<Set<string>>(new Set([UNASSIGNED_RM_AREA]));
  const [movementSelectedAgings, setMovementSelectedAgings] = useState<Set<string>>(new Set());
  const [movementSelectedStatuses, setMovementSelectedStatuses] = useState<Set<string>>(new Set());
  const [movementSelectedOrigins, setMovementSelectedOrigins] = useState<Set<string>>(new Set());
  const [movementDateStart, setMovementDateStart] = useState("");
  const [movementDateEnd, setMovementDateEnd] = useState("");
  const [movementSummaryMetric, setMovementSummaryMetric] = useState("totalStopped");
  const [movementLoading, setMovementLoading] = useState(true);
  const [movementTableQuery, setMovementTableQuery] = useState("");
  const [movementPage, setMovementPage] = useState(1);
  const [sellerReferenceLoaded, setSellerReferenceLoaded] = useState<SellerReferenceData | null>(null);
  const [specialSellerLoaded, setSpecialSellerLoaded] = useState<SpecialSellerData | null>(null);
  const [sellerPerformanceLoaded, setSellerPerformanceLoaded] = useState<SellerPerformanceData | null>(null);
  const [responsibilityLoaded, setResponsibilityLoaded] = useState<ResponsibilityData | null>(null);
  const [selectedRms, setSelectedRms] = useState<Set<string>>(new Set([UNASSIGNED_RM]));
  const [selectedRgms, setSelectedRgms] = useState<Set<string>>(new Set([UNASSIGNED_RGM]));
  const [sellerLoading, setSellerLoading] = useState(true);
  const [sellerSelectedRegions, setSellerSelectedRegions] = useState<Set<string>>(new Set());
  const [sellerSelectedBases, setSellerSelectedBases] = useState<Set<string>>(new Set());
  const [sellerSelectedTiers, setSellerSelectedTiers] = useState<Set<string>>(new Set());
  const [sellerSelectedSellers, setSellerSelectedSellers] = useState<Set<string>>(new Set());
  const [sellerCodeQuery, setSellerCodeQuery] = useState("");
  const [sellerDateStart, setSellerDateStart] = useState("");
  const [sellerDateEnd, setSellerDateEnd] = useState("");
  const [sellerReportMode, setSellerReportMode] = useState<SellerReportMode>("seller");
  const [sellerOutcomeFilter, setSellerOutcomeFilter] = useState<SellerOutcome | null>(null);
  const [sellerTableQuery, setSellerTableQuery] = useState("");
  const [sellerPage, setSellerPage] = useState(1);
  const [bipagemLoaded, setBipagemLoaded] = useState<BipagemLoadedData | null>(null);
  const [bipagemSelectedRegions, setBipagemSelectedRegions] = useState<Set<string>>(new Set());
  const [bipagemSelectedRms, setBipagemSelectedRms] = useState<Set<string>>(new Set());
  const [bipagemSelectedRgms, setBipagemSelectedRgms] = useState<Set<string>>(new Set());
  const [bipagemSelectedBases, setBipagemSelectedBases] = useState<Set<string>>(new Set());
  const [bipagemSelectedOrigins, setBipagemSelectedOrigins] = useState<Set<string>>(new Set());
  const [bipagemProblemType, setBipagemProblemType] = useState<BipagemProblemType>("collection");
  const [bipagemDateStart, setBipagemDateStart] = useState("");
  const [bipagemDateEnd, setBipagemDateEnd] = useState("");
  const [bipagemLoading, setBipagemLoading] = useState(true);
  const [bipagemTableQuery, setBipagemTableQuery] = useState("");
  const [damageLoaded, setDamageLoaded] = useState<DamageData | null>(null);
  const [damageSelectedRegions, setDamageSelectedRegions] = useState<Set<string>>(new Set());
  const [damageSelectedRms, setDamageSelectedRms] = useState<Set<string>>(new Set());
  const [damageSelectedRgms, setDamageSelectedRgms] = useState<Set<string>>(new Set());
  const [damageSelectedBases, setDamageSelectedBases] = useState<Set<string>>(new Set());
  const [damageDateStart, setDamageDateStart] = useState("");
  const [damageDateEnd, setDamageDateEnd] = useState("");
  const [damageLoading, setDamageLoading] = useState(true);
  const sellerDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const uploadUsernameRef = useRef<HTMLInputElement>(null);
  const uploadAuthorizationRef = useRef<string | null>(null);
  const [uploadAuthorization, setUploadAuthorization] = useState<string | null>(null);
  const [uploadLoginOpen, setUploadLoginOpen] = useState(false);
  const [uploadUsername, setUploadUsername] = useState("");
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploadAuthError, setUploadAuthError] = useState<string | null>(null);
  const [uploadAuthLoading, setUploadAuthLoading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tableQuery, setTableQuery] = useState("");
  const [page, setPage] = useState(1);
  const t = useCallback<DashboardTranslator>(
    (source, values) => translateDashboardText(language, source, values),
    [language],
  );
  const statusLabel = useCallback((status: string) => monitoringStatusLabel(status, t), [t]);

  useEffect(() => {
    const savedLanguage = window.localStorage.getItem(DASHBOARD_LANGUAGE_STORAGE_KEY);
    if (!isDashboardLanguage(savedLanguage)) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.documentElement.lang = dashboardHtmlLang(savedLanguage);
      setLanguage(savedLanguage);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    document.documentElement.lang = dashboardHtmlLang(language);
    window.localStorage.setItem(DASHBOARD_LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    let active = true;
    const authorization = window.sessionStorage.getItem("jt-dashboard-viewer-authorization");
    if (!authorization) {
      const frame = window.requestAnimationFrame(() => setViewerChecked(true));
      return () => window.cancelAnimationFrame(frame);
    }
    void fetch("/api/view-auth", { method: "POST", headers: { authorization } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Sessão inválida");
        const identity = await response.json() as ViewerIdentity & { authenticated: boolean };
        if (!active) return;
        setViewerAuthorization(authorization);
        setViewerIdentity(identity);
      })
      .catch(() => {
        window.sessionStorage.removeItem("jt-dashboard-viewer-authorization");
      })
      .finally(() => {
        if (active) setViewerChecked(true);
      });
    return () => { active = false; };
  }, []);

  const submitViewerLogin = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setViewerAuthLoading(true);
    setViewerAuthError(null);
    try {
      const authorization = `Basic ${window.btoa(`${viewerUsername}:${viewerPassword}`)}`;
      const response = await fetch("/api/view-auth", { method: "POST", headers: { authorization } });
      if (!response.ok) throw new Error("Usuário ou senha inválidos.");
      const identity = await response.json() as ViewerIdentity & { authenticated: boolean };
      window.sessionStorage.setItem("jt-dashboard-viewer-authorization", authorization);
      setViewerAuthorization(authorization);
      setViewerIdentity(identity);
      setViewerPassword("");
      setError(null);
    } catch (cause) {
      setViewerAuthError(cause instanceof Error ? cause.message : "Usuário ou senha inválidos.");
    } finally {
      setViewerAuthLoading(false);
    }
  }, [viewerPassword, viewerUsername]);

  const endViewerSession = useCallback(() => {
    window.sessionStorage.removeItem("jt-dashboard-viewer-authorization");
    setViewerAuthorization(null);
    setViewerIdentity(null);
    setViewerUsername("");
    setLoaded(null);
    setTaxaLoaded(null);
    setMovementLoaded(null);
    setSellerPerformanceLoaded(null);
    setSellerReferenceLoaded(null);
    setSpecialSellerLoaded(null);
    setResponsibilityLoaded(null);
    setBipagemLoaded(null);
    uploadAuthorizationRef.current = null;
    setUploadAuthorization(null);
    setPendingUpload(null);
    setUploadLoginOpen(false);
    setView("home");
  }, []);

  const changeLanguage = useCallback((nextLanguage: DashboardLanguage) => {
    document.documentElement.lang = dashboardHtmlLang(nextLanguage);
    setLanguage(nextLanguage);
  }, []);

  const resetResponsibilityFilters = useCallback((data = responsibilityLoaded) => {
    if (!data) return;
    setSelectedRms(new Set([...data.rms, UNASSIGNED_RM]));
    setSelectedRgms(new Set([...data.rgms, UNASSIGNED_RGM]));
  }, [responsibilityLoaded]);

  const resetFilters = useCallback((data = loaded) => {
    if (!data) return;
    const regions = new Set(data.parsed.rows.map((row) => {
      const base = rowBase(row, data.parsed.baseColumn as string);
      return registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, data.parsed.regionColumn));
    }));
    setSelectedBases(new Set(basesForRegions(data, regions, responsibilityLoaded)));
    setSelectedRegions(regions);
    const monitoringMetrics = new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS);
    setSelectedMonitoringMetrics(monitoringMetrics);
    setSelectedStatuses(new Set(monitoringStatusesForMetrics(data.statuses, monitoringMetrics)));
    setSelectedOrigins(new Set(data.origins));
    setDateStart(data.initialStart);
    setDateEnd(data.initialEnd);
    setTableQuery("");
    setPage(1);
    resetResponsibilityFilters();
  }, [loaded, resetResponsibilityFilters, responsibilityLoaded]);

  const applyLoadedData = useCallback((data: LoadedData, responsibility: ResponsibilityData | null = null) => {
    setLoaded(data);
    const initialRegions = new Set(data.parsed.rows.map((row) => {
      const base = rowBase(row, data.parsed.baseColumn as string);
      return registeredRegionForBase(responsibility, base, rowRegion(row, data.parsed.regionColumn));
    }));
    setSelectedBases(new Set(basesForRegions(data, initialRegions, responsibility)));
    setSelectedRegions(initialRegions);
    const monitoringMetrics = new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS);
    setSelectedMonitoringMetrics(monitoringMetrics);
    setSelectedStatuses(new Set(monitoringStatusesForMetrics(data.statuses, monitoringMetrics)));
    setSelectedOrigins(new Set(data.origins));
    setDateStart(data.initialStart);
    setDateEnd(data.initialEnd);
    setTableQuery("");
    setPage(1);
  }, []);

  const resetTaxaFilters = useCallback((data = taxaLoaded) => {
    if (!data) return;
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibilityLoaded, record.base, record.region)));
    setTaxaSelectedRegions(regions);
    setTaxaSelectedBases(new Set(taxaBasesForRegions(data, regions, responsibilityLoaded)));
    setTaxaSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, data.bases).rmAreas));
    setTaxaSelectedOrigins(new Set(data.origins));
    setTaxaDateStart(data.initialStart);
    setTaxaDateEnd(data.initialEnd);
    setTaxaTableQuery("");
    setTaxaPage(1);
    resetResponsibilityFilters();
  }, [resetResponsibilityFilters, responsibilityLoaded, taxaLoaded]);

  const applyTaxaLoadedData = useCallback((data: TaxaLoadedData, responsibility: ResponsibilityData | null = null) => {
    setTaxaLoaded(data);
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)));
    setTaxaSelectedRegions(regions);
    setTaxaSelectedBases(new Set(taxaBasesForRegions(data, regions, responsibility)));
    setTaxaSelectedRmAreas(new Set(responsibilityOptions(responsibility, data.bases).rmAreas));
    setTaxaSelectedOrigins(new Set(data.origins));
    setTaxaDateStart(data.initialStart);
    setTaxaDateEnd(data.initialEnd);
    setTaxaTableQuery("");
    setTaxaPage(1);
  }, []);

  const resetMovementFilters = useCallback((data = movementLoaded) => {
    if (!data) return;
    setMovementSummaryMetric("totalStopped");
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibilityLoaded, record.base, record.region)));
    setMovementSelectedRegions(regions);
    setMovementSelectedBases(new Set(movementBasesForRegions(data, regions, responsibilityLoaded)));
    setMovementSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, data.bases).rmAreas));
    setMovementSelectedAgings(new Set(data.agings));
    setMovementSelectedStatuses(new Set(data.statuses));
    setMovementSelectedOrigins(new Set(data.origins));
    setMovementDateStart(data.initialStart);
    setMovementDateEnd(data.initialEnd);
    setMovementTableQuery("");
    setMovementPage(1);
    resetResponsibilityFilters();
  }, [movementLoaded, resetResponsibilityFilters, responsibilityLoaded]);

  const applyMovementLoadedData = useCallback((data: MovementLoadedData, responsibility: ResponsibilityData | null = null) => {
    setMovementLoaded(data);
    setMovementSummaryMetric("totalStopped");
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)));
    setMovementSelectedRegions(regions);
    setMovementSelectedBases(new Set(movementBasesForRegions(data, regions, responsibility)));
    setMovementSelectedRmAreas(new Set(responsibilityOptions(responsibility, data.bases).rmAreas));
    setMovementSelectedAgings(new Set(data.agings));
    setMovementSelectedStatuses(new Set(data.statuses));
    setMovementSelectedOrigins(new Set(data.origins));
    setMovementDateStart(data.initialStart);
    setMovementDateEnd(data.initialEnd);
    setMovementTableQuery("");
    setMovementPage(1);
  }, []);

  const resetSellerFilters = useCallback((data = sellerPerformanceLoaded) => {
    if (!data) return;
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibilityLoaded, record.base, record.region)));
    const tiers = new Set<string>(SELLER_CATEGORIES.filter((tier) => data.records.some((record) => record.tier === tier)));
    const bases = new Set(sellerBasesForRegions(data, regions, responsibilityLoaded));
    setSellerSelectedRegions(regions);
    setSellerSelectedBases(bases);
    setSellerSelectedTiers(tiers);
    setSellerSelectedSellers(new Set(sellerOptionsForFilters(data, regions, bases, tiers, responsibilityLoaded)));
    setSellerCodeQuery("");
    setSellerDateStart(data.dates[0] ?? "");
    setSellerDateEnd(data.dates[data.dates.length - 1] ?? "");
    setSellerOutcomeFilter(null);
    setSellerTableQuery("");
    setSellerPage(1);
    resetResponsibilityFilters();
  }, [resetResponsibilityFilters, responsibilityLoaded, sellerPerformanceLoaded]);

  const applySellerPerformanceLoadedData = useCallback((data: SellerPerformanceData, responsibility: ResponsibilityData | null = null) => {
    setSellerPerformanceLoaded(data);
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)));
    const tiers = new Set<string>(SELLER_CATEGORIES.filter((tier) => data.records.some((record) => record.tier === tier)));
    const bases = new Set(sellerBasesForRegions(data, regions, responsibility));
    setSellerSelectedRegions(regions);
    setSellerSelectedBases(bases);
    setSellerSelectedTiers(tiers);
    setSellerSelectedSellers(new Set(sellerOptionsForFilters(data, regions, bases, tiers, responsibility)));
    setSellerCodeQuery("");
    setSellerDateStart(data.dates[0] ?? "");
    setSellerDateEnd(data.dates[data.dates.length - 1] ?? "");
    setSellerOutcomeFilter(null);
    setSellerTableQuery("");
    setSellerPage(1);
  }, []);

  const applyBipagemLoadedData = useCallback((data: BipagemLoadedData, responsibility: ResponsibilityData | null = null) => {
    setBipagemLoaded(data);
    const regions = new Set(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)));
    const rms = new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rm));
    const rgms = new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rgm));
    setBipagemSelectedRegions(regions);
    setBipagemSelectedRms(rms);
    setBipagemSelectedRgms(rgms);
    setBipagemSelectedBases(new Set(data.bases));
    setBipagemSelectedOrigins(new Set(data.origins));
    setBipagemProblemType("collection");
    setBipagemDateStart(data.dates[0] ?? "");
    setBipagemDateEnd(data.dates[data.dates.length - 1] ?? "");
    setBipagemTableQuery("");
  }, []);

  const applyDamageLoadedData = useCallback((data: DamageData, responsibility: ResponsibilityData | null = null) => {
    setDamageLoaded(data);
    setDamageSelectedRegions(new Set(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region))));
    setDamageSelectedBases(new Set(data.bases));
    setDamageSelectedRms(new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rm)));
    setDamageSelectedRgms(new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rgm)));
    setDamageDateStart(data.dates[0] ?? "");
    setDamageDateEnd(data.dates[data.dates.length - 1] ?? "");
  }, []);

  const resetBipagemFilters = useCallback((data = bipagemLoaded) => {
    if (!data) return;
    applyBipagemLoadedData(data, responsibilityLoaded);
  }, [applyBipagemLoadedData, bipagemLoaded, responsibilityLoaded]);

  const showSellerOutcome = useCallback((outcome: SellerOutcome) => {
    setSellerOutcomeFilter((current) => current === outcome ? null : outcome);
    setSellerReportMode("seller");
    setSellerTableQuery("");
    setSellerPage(1);
    window.requestAnimationFrame(() => {
      const heading = sellerDetailHeadingRef.current;
      heading?.scrollIntoView({ block: "start" });
      heading?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    let active = true;

    async function loadSavedWorkbook() {
      if (!viewerAuthorization) return;
      let primaryWorkbookLoaded = false;
      setLoading(true);
      setTaxaLoading(true);
      setMovementLoading(true);
      setSellerLoading(true);
      setBipagemLoading(true);
      setDamageLoading(true);
      try {
        const fetchOptionalWorkbook = async (kind: string): Promise<Response | null> => {
          try {
            return await fetch(`/api/workbook?kind=${kind}`, { cache: "no-store", headers: { authorization: viewerAuthorization } });
          } catch {
            return null;
          }
        };
        const readTaxaHistory = async (response: Response | null, kind = "taxa"): Promise<SavedWorkbook | null> => {
          if (!response?.ok) return null;
          const payload = await response.json() as SavedWorkbookResponse & { historyParts?: string[]; taxaParts?: string[]; fileName?: string; updatedAt?: string };
          if (payload.workbook) return payload.workbook;
          const parts = payload.historyParts ?? payload.taxaParts;
          if (!parts?.length || !payload.fileName || !payload.updatedAt) return null;
          const { mergeTaxaHistory } = await import("./lib/taxa-history");
          const workbooks: ParsedWorkbook[] = [];
          for (const part of parts) {
            const partResponse = await fetch(`/api/workbook?kind=${kind}&part=${encodeURIComponent(part)}`, {
              cache: "no-store", headers: { authorization: viewerAuthorization },
            });
            const partPayload = (await partResponse.json()) as SavedWorkbookResponse;
            if (!partResponse.ok || !partPayload.workbook) throw new Error("Não foi possível carregar uma parte do histórico de taxa.");
            workbooks.push(partPayload.workbook.parsed);
          }
          return { fileName: payload.fileName, updatedAt: payload.updatedAt, parsed: mergeTaxaHistory(null, workbooks).parsed };
        };
        // Large workbooks are intentionally requested one at a time. Concurrent
        // streams can exhaust a browser/edge connection and surface as “Load failed”.
        let payload: SavedWorkbookResponse | null = null;
        for (let attempt = 0; attempt < 3 && !payload; attempt += 1) {
          try {
            const monitoringResponse = await fetch("/api/workbook?kind=monitoring", { cache: "no-store", headers: { authorization: viewerAuthorization } });
            if (!monitoringResponse.ok) throw new Error("Não foi possível carregar a última atualização.");
            payload = (await monitoringResponse.json()) as SavedWorkbookResponse;
          } catch (cause) {
            if (attempt === 2 || (cause instanceof Error && cause.message === "Não foi possível carregar a última atualização.")) {
              throw new Error("Não foi possível carregar a última atualização. Tente novamente em instantes.");
            }
            await new Promise<void>((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
        if (!payload) throw new Error("Não foi possível carregar a última atualização. Tente novamente em instantes.");
        if (!active) return;
        const responsibilityResponse = await fetchOptionalWorkbook("responsibilityList");
        let responsibility: ResponsibilityData | null = null;
        {
          const responsibilityWorkbook = await readOptionalWorkbook(responsibilityResponse);
          if (responsibilityWorkbook) {
            responsibility = buildResponsibilityData(
              responsibilityWorkbook.parsed,
              responsibilityWorkbook.fileName,
              responsibilityWorkbook.updatedAt,
            );
            setResponsibilityLoaded(responsibility);
            setSelectedRms(new Set([...responsibility.rms, UNASSIGNED_RM]));
            setSelectedRgms(new Set([...responsibility.rgms, UNASSIGNED_RGM]));
          }
        }
        const monitoringWorkbook = payload.workbook ?? await readTaxaHistory(await fetchOptionalWorkbook("monitoring"), "monitoring");
        if (monitoringWorkbook) {
          applyLoadedData(
            buildLoadedData(
              monitoringWorkbook.parsed,
              monitoringWorkbook.fileName,
              monitoringWorkbook.updatedAt,
            ), responsibility,
          );
          primaryWorkbookLoaded = true;
        }
        const taxaResponse = await fetchOptionalWorkbook("taxa");
        {
          const taxaWorkbook = await readTaxaHistory(taxaResponse);
          if (!active) return;
          if (taxaWorkbook) {
            applyTaxaLoadedData(
              buildTaxaLoadedData(
                taxaWorkbook.parsed,
                taxaWorkbook.fileName,
                taxaWorkbook.updatedAt,
              ), responsibility,
            );
          }
        }
        const movementResponse = await fetchOptionalWorkbook("movement");
        const epopResponse = await fetchOptionalWorkbook("epop");
        {
          const epopWorkbook = await readTaxaHistory(epopResponse, "epop");
          if (!active) return;
          if (epopWorkbook) {
            const epop = buildEpopLoadedData(epopWorkbook.parsed, epopWorkbook.fileName, epopWorkbook.updatedAt);
            setEpopLoaded(epop); setEpopSelectedRegions(new Set(epop.regions)); setEpopSelectedBases(new Set(epop.bases));
            setEpopDateStart(epop.dates[0] ?? ""); setEpopDateEnd(epop.dates[epop.dates.length - 1] ?? "");
          }
        }
        {
          const movementWorkbook = await readOptionalWorkbook(movementResponse);
          if (!active) return;
          if (movementWorkbook) {
            applyMovementLoadedData(
              buildMovementLoadedData(
                movementWorkbook.parsed,
                movementWorkbook.fileName,
                movementWorkbook.updatedAt,
              ), responsibility,
            );
          }
        }
        const sellerSpecialListResponse = await fetchOptionalWorkbook("sellerSpecialList");
        let sellerReference: SellerReferenceData | null = null;
        let specialSeller: SpecialSellerData | null = null;
        {
          const sellerSpecialListWorkbook = await readOptionalWorkbook(sellerSpecialListResponse);
          if (!active) return;
          if (sellerSpecialListWorkbook) {
            specialSeller = buildSpecialSellerData(
              sellerSpecialListWorkbook.parsed,
              sellerSpecialListWorkbook.fileName,
              sellerSpecialListWorkbook.updatedAt,
            );
            setSpecialSellerLoaded(specialSeller);
          }
        }
        const sellerListResponse = await fetchOptionalWorkbook("sellerList");
        {
          const sellerListWorkbook = await readOptionalWorkbook(sellerListResponse);
          if (!active) return;
          if (sellerListWorkbook) {
            sellerReference = mergeSellerReferenceData(buildSellerReferenceData(
              sellerListWorkbook.parsed,
              sellerListWorkbook.fileName,
              sellerListWorkbook.updatedAt,
            ), specialSeller);
            setSellerReferenceLoaded(sellerReference);
          }
        }
        const sellerPerformanceResponse = await fetchOptionalWorkbook("sellerPerformance");
        if (sellerReference) {
          const sellerPerformanceWorkbook = await readOptionalWorkbook(sellerPerformanceResponse);
          if (!active) return;
          if (sellerPerformanceWorkbook) {
            const sellerData = buildSellerPerformanceData(
                sellerPerformanceWorkbook.parsed,
                sellerReference,
                sellerPerformanceWorkbook.fileName,
                sellerPerformanceWorkbook.updatedAt,
              );
            const scopedSellerData = viewerIdentity?.region ? {
              ...sellerData,
              records: sellerData.records.filter((record) => registeredRegionForBase(responsibility, record.base, record.region) === viewerIdentity.region),
              regions: [viewerIdentity.region],
              bases: [...new Set(sellerData.records.filter((record) => registeredRegionForBase(responsibility, record.base, record.region) === viewerIdentity.region).map((record) => record.base))].sort(),
              sellers: [...new Set(sellerData.records.filter((record) => registeredRegionForBase(responsibility, record.base, record.region) === viewerIdentity.region).map((record) => record.sellerName))].sort(),
            } : sellerData;
            applySellerPerformanceLoadedData(scopedSellerData, responsibility);
          }
        }
        const bipagemResponse = await fetchOptionalWorkbook("bipagem");
        {
          const bipagemWorkbook = await readOptionalWorkbook(bipagemResponse);
          if (!active) return;
          if (bipagemWorkbook) {
            applyBipagemLoadedData(
              buildBipagemLoadedData(
                bipagemWorkbook.parsed,
                bipagemWorkbook.fileName,
                bipagemWorkbook.updatedAt,
              ), responsibility,
            );
          }
        }
        const damageResponse = await fetchOptionalWorkbook("damage");
        {
          const damageWorkbook = await readTaxaHistory(damageResponse, "damage");
          if (!active) return;
          if (damageWorkbook) {
            applyDamageLoadedData(buildDamageData(
              damageWorkbook.parsed,
              damageWorkbook.fileName,
              damageWorkbook.updatedAt,
            ), responsibility);
          }
        }
      } catch (cause) {
        if (!active) return;
        if (recoverFromStaleModuleImport(cause)) return;
        // A supplementary workbook must never invalidate a dashboard that is
        // already usable. It will be retried on the next refresh.
        if (primaryWorkbookLoaded) {
          setError(null);
          return;
        }
        setError("Não foi possível carregar a atualização principal. Tente novamente em instantes.");
      } finally {
        if (active) {
          setLoading(false);
          setTaxaLoading(false);
          setMovementLoading(false);
          setSellerLoading(false);
        setBipagemLoading(false);
        setDamageLoading(false);
        }
      }
    }

    void loadSavedWorkbook();

    return () => {
      active = false;
    };
  }, [applyBipagemLoadedData, applyDamageLoadedData, applyLoadedData, applyMovementLoadedData, applySellerPerformanceLoadedData, applyTaxaLoadedData, viewerAuthorization, viewerIdentity?.region]);

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    setLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook, compactMonitoringWorkbook }] = await Promise.all([import("./lib/workbook")]);
      const parsed = compactMonitoringWorkbook(parseWorkbook(await file.arrayBuffer()));
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "monitoring", fileName: file.name, parsed }),
      });
      const payload = (await response.json()) as { workbook?: Omit<SavedWorkbook, "parsed">; error?: string };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar a atualização do dashboard.");
      }

      const { mergeTaxaHistory } = await import("./lib/taxa-history");
      const accumulated = mergeTaxaHistory(loaded?.parsed ?? null, [parsed]).parsed;
      applyLoadedData(
        buildLoadedData(accumulated, payload.workbook.fileName, payload.workbook.updatedAt),
        responsibilityLoaded,
      );
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setLoading(false);
    }
  }, [applyLoadedData, loaded, responsibilityLoaded]);

  const loadTaxaFiles = useCallback(async (files: File[]) => {
    setError(null);
    setTaxaHistoryNotice(null);
    if (files.length === 0) return;
    if (files.length > 2) {
      setError("Selecione no máximo duas planilhas de taxa por envio.");
      return;
    }
    for (const file of files) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (extension !== "xlsx" && extension !== "xls") {
        setError("Selecione arquivos Excel no formato .xlsx ou .xls.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`O arquivo ${file.name} ultrapassa o limite de 50 MB.`);
        return;
      }
    }

    setTaxaLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook }, { mergeTaxaHistory }] = await Promise.all([
        import("./lib/workbook"),
        import("./lib/taxa-history"),
      ]);
      const selectedWorkbooks = await Promise.all(
        files.map(async (file) => parseWorkbook(await file.arrayBuffer())),
      );
      const parsed = mergeTaxaHistory(null, selectedWorkbooks).parsed;
      const latestFile = files[files.length - 1];
      const fileName = files.length === 1
        ? `Histórico acumulado · ${latestFile.name}`
        : `Histórico acumulado · ${files.length} arquivos · ${latestFile.name}`;
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "taxa", fileName, parsed, mergeHistory: true }),
      });
      const payload = (await response.json()) as {
        workbook?: Omit<SavedWorkbook, "parsed"> & { parsed?: ParsedWorkbook };
        historyMerge?: TaxaHistoryNotice;
        error?: string;
      };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar a taxa de coleta.");
      }

      // Keep the just-published result on screen using the data already in
      // this browser. This avoids a second large network read immediately
      // after upload; the persisted parts are loaded on the next refresh.
      const savedWorkbook: SavedWorkbook = {
        fileName: payload.workbook.fileName,
        updatedAt: payload.workbook.updatedAt,
        parsed: mergeTaxaHistory(taxaLoaded?.parsed ?? null, [parsed]).parsed,
      };

      applyTaxaLoadedData(
        buildTaxaLoadedData(savedWorkbook.parsed, savedWorkbook.fileName, savedWorkbook.updatedAt),
        responsibilityLoaded,
      );
      if (payload.historyMerge) setTaxaHistoryNotice(payload.historyMerge);
      setView("taxa");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setTaxaLoading(false);
    }
  }, [applyTaxaLoadedData, responsibilityLoaded, taxaLoaded]);

  const loadEpopFile = useCallback(async (file: File) => {
    setError(null);
    setEpopHistoryNotice(null);
    if (!/\.xlsx?$/i.test(file.name)) { setError("Selecione um arquivo Excel no formato .xlsx ou .xls."); return; }
    if (file.size > 200 * 1024 * 1024) { setError("O arquivo EPOP ultrapassa o limite de 200 MB."); return; }
    setEpopLoading(true);
    try {
      const { parseWorkbook } = await import("./lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await fetch("/api/workbook", { method: "POST", headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" }, body: JSON.stringify({ kind: "epop", fileName: file.name, parsed }) });
      const payload = await response.json() as { workbook?: { updatedAt?: string }; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar o relatório EPOP.");
      // EPOP is an incremental daily history: keep prior days in the browser
      // immediately after publishing, and replace only dates present in a
      // re-sent daily file. The same merge is performed again when the saved
      // history is loaded on the next visit.
      const { mergeTaxaHistory } = await import("./lib/taxa-history");
      const historyMerge = mergeTaxaHistory(epopLoaded?.parsed ?? null, [parsed]);
      const accumulated = historyMerge.parsed;
      const data = buildEpopLoadedData(accumulated, `Histórico EPOP · ${file.name}`, payload.workbook.updatedAt);
      setEpopLoaded(data);
      setEpopSelectedRegions(new Set(data.regions)); setEpopSelectedBases(new Set(data.bases));
      setEpopDateStart(data.dates[0] ?? ""); setEpopDateEnd(data.dates[data.dates.length - 1] ?? "");
      setEpopHistoryNotice(historyMerge);
      setView("epop");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível ler a planilha EPOP."); }
    finally { setEpopLoading(false); }
  }, [epopLoaded]);

  const loadMovementFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("O arquivo ultrapassa o limite de 50 MB.");
      return;
    }

    setMovementLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook }] = await Promise.all([import("./lib/workbook")]);
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "movement", fileName: file.name, parsed }),
      });
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar a movimentação.");
      }

      applyMovementLoadedData(
        buildMovementLoadedData(payload.workbook.parsed, payload.workbook.fileName, payload.workbook.updatedAt),
        responsibilityLoaded,
      );
      setView("movimentacao");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setMovementLoading(false);
    }
  }, [applyMovementLoadedData, responsibilityLoaded]);

  const loadSellerListFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("O arquivo ultrapassa o limite de 50 MB.");
      return;
    }

    setSellerLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook }] = await Promise.all([import("./lib/workbook")]);
      const parsed = parseWorkbook(await file.arrayBuffer(), { preferredSheetName: "SELLERS" });
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "sellerList", fileName: file.name, parsed }),
      });
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar a lista oficial de sellers.");
      }
      const reference = mergeSellerReferenceData(
        buildSellerReferenceData(payload.workbook.parsed, payload.workbook.fileName, payload.workbook.updatedAt),
        specialSellerLoaded,
      );
      setSellerReferenceLoaded(reference);
      if (sellerPerformanceLoaded) {
        applySellerPerformanceLoadedData(
          buildSellerPerformanceData(sellerPerformanceLoaded.parsed, reference, sellerPerformanceLoaded.fileName, sellerPerformanceLoaded.updatedAt),
          responsibilityLoaded,
        );
      }
      setView("sellers");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setSellerLoading(false);
    }
  }, [applySellerPerformanceLoadedData, responsibilityLoaded, sellerPerformanceLoaded, specialSellerLoaded]);

  const loadSpecialSellerFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > 250 * 1024 * 1024) {
      setError("A lista de sellers especiais ultrapassa o limite de 250 MB.");
      return;
    }
    if (!sellerReferenceLoaded) {
      setError("Carregue primeiro a lista oficial de sellers.");
      return;
    }

    setSellerLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook }] = await Promise.all([import("./lib/workbook")]);
      const parsed = parseWorkbook(await file.arrayBuffer(), { preferredSheetName: "单商多服揽收日报" });
      const special = buildSpecialSellerData(parsed, file.name);
      const normalizedParsed: ParsedWorkbook = {
        ...parsed,
        sheetName: "SELLERS ESPECIAIS",
        headers: ["Seller especial"],
        rows: special.sellerCodes.map((sellerCode) => ({ "Seller especial": sellerCode })),
        statusColumns: [],
      };
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "sellerSpecialList", fileName: file.name, parsed: normalizedParsed }),
      });
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar os sellers especiais.");
      const savedSpecial = buildSpecialSellerData(payload.workbook.parsed, payload.workbook.fileName, payload.workbook.updatedAt);
      setSpecialSellerLoaded(savedSpecial);
      const reference = mergeSellerReferenceData(sellerReferenceLoaded, savedSpecial);
      setSellerReferenceLoaded(reference);
      if (sellerPerformanceLoaded) {
        applySellerPerformanceLoadedData(
          buildSellerPerformanceData(sellerPerformanceLoaded.parsed, reference, sellerPerformanceLoaded.fileName, sellerPerformanceLoaded.updatedAt),
          responsibilityLoaded,
        );
      }
      setView("sellers");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setSellerLoading(false);
    }
  }, [applySellerPerformanceLoadedData, responsibilityLoaded, sellerPerformanceLoaded, sellerReferenceLoaded]);

  const loadSellerPerformanceFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("O resumo JMS de sellers aceita arquivos de até 20 MB.");
      return;
    }
    if (!sellerReferenceLoaded) {
      setError("Carregue primeiro a lista oficial de sellers para cruzar com o resumo JMS.");
      return;
    }

    setSellerLoading(true);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      const [{ parseWorkbook }] = await Promise.all([import("./lib/workbook")]);
      const officialSellerCodes = new Set(sellerReferenceLoaded.records.map((record) => normalizeSellerCode(record.sellerCode)));
      const parsed = compactSellerPerformanceWorkbook(parseWorkbook(await file.arrayBuffer()), officialSellerCodes);
      const requestBody = JSON.stringify({ kind: "sellerPerformance", fileName: file.name, parsed });
      if (requestBody.length > 25 * 1024 * 1024) {
        throw new Error("A planilha processada ficou muito grande para publicar. Divida o arquivo em partes menores e envie novamente.");
      }
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: requestBody,
      });
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar o resumo JMS de sellers.");
      }

      applySellerPerformanceLoadedData(
        buildSellerPerformanceData(payload.workbook.parsed, sellerReferenceLoaded, payload.workbook.fileName, payload.workbook.updatedAt),
        responsibilityLoaded,
      );
      setView("sellers");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setSellerLoading(false);
    }
  }, [applySellerPerformanceLoadedData, responsibilityLoaded, sellerReferenceLoaded]);

  const loadBipagemFile = useCallback(async (file: File) => {
    setError(null);
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "xls") {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("O arquivo ultrapassa o limite de 50 MB.");
      return;
    }

    setBipagemLoading(true);
    try {
      const { parseWorkbook } = await import("./lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "bipagem", fileName: file.name, parsed }),
      });
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar o relatório de falta de bipagem.");
      applyBipagemLoadedData(
        buildBipagemLoadedData(payload.workbook.parsed, payload.workbook.fileName, payload.workbook.updatedAt),
        responsibilityLoaded,
      );
      setView("bipagem");
    } catch (cause) {
      if (recoverFromStaleModuleImport(cause)) return;
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setBipagemLoading(false);
    }
  }, [applyBipagemLoadedData, responsibilityLoaded]);

  const loadDamageFile = useCallback(async (file: File) => {
    setError(null);
    if (!/\.xlsx?$/i.test(file.name)) {
      setError("Selecione um arquivo Excel no formato .xlsx ou .xls.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("O arquivo ultrapassa o limite de 50 MB.");
      return;
    }
    setDamageLoading(true);
    try {
      const { parseWorkbook } = await import("./lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: uploadAuthorizationRef.current ?? "" },
        body: JSON.stringify({ kind: "damage", fileName: file.name, parsed }),
      });
      const payload = (await response.json()) as { workbook?: Omit<SavedWorkbook, "parsed"> & { parsed?: ParsedWorkbook }; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar o relatório de avaria e extravio.");
      const { mergeTaxaHistory } = await import("./lib/taxa-history");
      const merged = mergeTaxaHistory(damageLoaded?.parsed ?? null, [parsed]).parsed;
      applyDamageLoadedData(buildDamageData(merged, payload.workbook.fileName, payload.workbook.updatedAt), responsibilityLoaded);
      setView("damage");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível ler esta planilha.";
      setError(message.replace(/^Não foi possível ler o arquivo Excel\s*/i, "Não foi possível ler a planilha "));
    } finally {
      setDamageLoading(false);
    }
  }, [applyDamageLoadedData, damageLoaded, responsibilityLoaded]);

  const runUpload = useCallback((upload: PendingUpload) => {
    const file = upload.files[0];
    if (!file) return Promise.resolve();
    if (upload.kind === "monitoring") return loadFile(file);
    if (upload.kind === "taxa") return loadTaxaFiles(upload.files);
    if (upload.kind === "epop") return loadEpopFile(file);
    if (upload.kind === "movement") return loadMovementFile(file);
    if (upload.kind === "sellerList") return loadSellerListFile(file);
    if (upload.kind === "sellerSpecialList") return loadSpecialSellerFile(file);
    if (upload.kind === "bipagem") return loadBipagemFile(file);
    if (upload.kind === "damage") return loadDamageFile(file);
    return loadSellerPerformanceFile(file);
  }, [loadBipagemFile, loadDamageFile, loadEpopFile, loadFile, loadMovementFile, loadSellerListFile, loadSellerPerformanceFile, loadSpecialSellerFile, loadTaxaFiles]);

  const queueUpload = useCallback((upload: PendingUpload) => {
    if (viewerIdentity?.role !== "matrix") return;
    if (uploadAuthorizationRef.current) {
      void runUpload(upload);
      return;
    }
    setPendingUpload(upload);
    setUploadAuthError(null);
    setUploadLoginOpen(true);
    window.requestAnimationFrame(() => uploadUsernameRef.current?.focus());
  }, [runUpload, viewerIdentity?.role]);

  const submitUploadLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploadAuthLoading(true);
    setUploadAuthError(null);
    try {
      const authorization = `Basic ${window.btoa(`${uploadUsername}:${uploadPassword}`)}`;
      const response = await fetch("/api/upload-auth", {
        method: "POST",
        headers: { authorization },
      });
      if (!response.ok) throw new Error(t("Usuário ou senha inválidos."));
      const upload = pendingUpload;
      uploadAuthorizationRef.current = authorization;
      setUploadAuthorization(authorization);
      setUploadPassword("");
      setPendingUpload(null);
      setUploadLoginOpen(false);
      if (upload) window.setTimeout(() => void runUpload(upload), 0);
    } catch (cause) {
      setUploadAuthError(cause instanceof Error ? cause.message : t("Não foi possível autorizar o upload."));
    } finally {
      setUploadAuthLoading(false);
    }
  };

  const closeUploadLogin = () => {
    if (uploadAuthLoading) return;
    setUploadLoginOpen(false);
    setPendingUpload(null);
    setUploadPassword("");
    setUploadAuthError(null);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "monitoring", files: [file] });
    event.target.value = "";
  };

  const handleTaxaFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) queueUpload({ kind: "taxa", files });
    event.target.value = "";
  };

  const handleEpopFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "epop", files: [file] });
    event.target.value = "";
  };

  const handleMovementFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "movement", files: [file] });
    event.target.value = "";
  };

  const handleSellerListFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "sellerList", files: [file] });
    event.target.value = "";
  };

  const handleSpecialSellerFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "sellerSpecialList", files: [file] });
    event.target.value = "";
  };

  const handleSellerPerformanceFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "sellerPerformance", files: [file] });
    event.target.value = "";
  };

  const handleBipagemFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "bipagem", files: [file] });
    event.target.value = "";
  };

  const handleDamageFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) queueUpload({ kind: "damage", files: [file] });
    event.target.value = "";
  };

  const filteredRows = useMemo(() => {
    if (!loaded || !dateStart || !dateEnd || dateStart > dateEnd) return [];
    const { dateColumn, baseColumn } = loaded.parsed;
    if (!dateColumn || !baseColumn) return [];
    return loaded.parsed.rows.filter((row) => {
      const date = String(row[dateColumn] ?? "");
      const base = rowBase(row, baseColumn);
      const region = registeredRegionForBase(
        responsibilityLoaded,
        base,
        rowRegion(row, loaded.parsed.regionColumn),
      );
      const origin = rowOrigin(row, loaded.originColumn);
      return (
        date >= dateStart &&
        date <= dateEnd &&
        selectedBases.has(base) &&
        selectedRegions.has(region) &&
        selectedOrigins.has(origin) &&
        matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms)
      );
    });
  }, [loaded, dateStart, dateEnd, responsibilityLoaded, selectedBases, selectedOrigins, selectedRegions, selectedRgms, selectedRms]);

  const periodDates = useMemo(() => {
    if (!loaded) return [];
    return loaded.dates.filter((date) => date >= dateStart && date <= dateEnd);
  }, [loaded, dateStart, dateEnd]);

  const monitoringSummaryDates = periodDates;

  const monitoringSummaryRows = useMemo(() => {
    if (!loaded?.parsed.dateColumn) return [];
    const dates = new Set(monitoringSummaryDates);
    return filteredRows.filter((row) => dates.has(String(row[loaded.parsed.dateColumn as string] ?? "")));
  }, [filteredRows, loaded, monitoringSummaryDates]);

  const monitoringSummaryPeriod = useMemo(
    () => formatConsolidatedPeriod(monitoringSummaryDates[0] ?? dateStart, monitoringSummaryDates[monitoringSummaryDates.length - 1] ?? dateEnd),
    [dateEnd, dateStart, monitoringSummaryDates],
  );

  const monitoringRegionalSummary = useMemo<MonitoringRegionalSummaryRow[]>(() => {
    if (!loaded?.parsed.baseColumn) return [];
    const groups = new Map<string, MonitoringRegionalSummaryRow>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const region = registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, loaded.parsed.regionColumn));
      const current = groups.get(region) ?? {
        region,
        rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
        period: monitoringSummaryPeriod,
        orderVolume: 0,
        awaiting: 0,
        collected: 0,
      };
      addMonitoringMetrics(current, monitoringMetricsForRow(row, [...selectedStatuses]));
      groups.set(region, current);
    }
    return [...groups.values()]
      .filter((row) => row.orderVolume > 0 || row.awaiting > 0 || row.collected > 0)
      .sort((a, b) => b.orderVolume - a.orderVolume || a.region.localeCompare(b.region, dashboardLocale(language), { numeric: true }));
  }, [language, loaded, monitoringSummaryPeriod, monitoringSummaryRows, responsibilityLoaded, selectedStatuses]);

  const monitoringRmSummary = useMemo<MonitoringRmSummaryRow[]>(() => {
    if (!loaded?.parsed.baseColumn) return [];
    const groups = new Map<string, MonitoringRmSummaryRow>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const responsibility = responsibilityForBase(responsibilityLoaded, base);
      const rmArea = rmAreaForBase(responsibilityLoaded, base);
      const key = `${rmArea}::${responsibility.rm}::${responsibility.rgm}`;
      const current = groups.get(key) ?? {
        rmArea,
        rm: responsibility.rm,
        rgm: responsibility.rgm,
        period: monitoringSummaryPeriod,
        orderVolume: 0,
        awaiting: 0,
        collected: 0,
      };
      addMonitoringMetrics(current, monitoringMetricsForRow(row, [...selectedStatuses]));
      groups.set(key, current);
    }
    return [...groups.values()]
      .filter((row) => row.orderVolume > 0 || row.awaiting > 0 || row.collected > 0)
      .sort((a, b) => b.orderVolume - a.orderVolume || a.rmArea.localeCompare(b.rmArea, dashboardLocale(language), { numeric: true }) || a.rm.localeCompare(b.rm, dashboardLocale(language), { numeric: true }));
  }, [language, loaded, monitoringSummaryPeriod, monitoringSummaryRows, responsibilityLoaded, selectedStatuses]);

  const monitoringSummaryMetrics = useMemo(
    () => monitoringRegionalSummary.reduce<MonitoringMetrics>((total, row) => {
      addMonitoringMetrics(total, row);
      return total;
    }, { orderVolume: 0, awaiting: 0, collected: 0 }),
    [monitoringRegionalSummary],
  );
  const firstScanRegionalSummary = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [] as Array<{ region: string; rgm: string } & FirstScanMetrics>;
    const groups = new Map<string, { region: string; rgm: string } & FirstScanMetrics>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const region = registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, loaded.parsed.regionColumn));
      const current = groups.get(region) ?? { region, rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM, orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(region, current);
    }
    return [...groups.values()].filter((row) => row.orderVolume > 0).sort((a, b) => firstScanTotalRetained(b) - firstScanTotalRetained(a));
  }, [loaded, monitoringSummaryRows, responsibilityLoaded]);
  const firstScanRmSummary = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [] as Array<{ rmArea: string; rm: string; rgm: string } & FirstScanMetrics>;
    const groups = new Map<string, { rmArea: string; rm: string; rgm: string } & FirstScanMetrics>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const responsibility = responsibilityForBase(responsibilityLoaded, base);
      const rmArea = rmAreaForBase(responsibilityLoaded, base);
      const key = `${rmArea}\u0000${responsibility.rm}\u0000${responsibility.rgm}`;
      const current = groups.get(key) ?? { rmArea, rm: responsibility.rm, rgm: responsibility.rgm, orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(key, current);
    }
    return [...groups.values()].filter((row) => row.orderVolume > 0).sort((a, b) => firstScanTotalRetained(b) - firstScanTotalRetained(a));
  }, [loaded, monitoringSummaryRows, responsibilityLoaded]);
  const firstScanTotal = useMemo(() => firstScanRegionalSummary.reduce<FirstScanMetrics>((total, row) => { addFirstScanMetrics(total, row); return total; }, { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 }), [firstScanRegionalSummary]);
  const firstScanPreviousRegional = useMemo(() => {
    if (!loaded?.parsed.dateColumn || !loaded.parsed.baseColumn) return new Map<string, FirstScanMetrics>();
    const currentDate = monitoringSummaryDates[monitoringSummaryDates.length - 1];
    const previousDate = loaded.dates.filter((date) => date < currentDate).at(-1);
    if (!previousDate) return new Map<string, FirstScanMetrics>();
    const groups = new Map<string, FirstScanMetrics>();
    for (const row of loaded.parsed.rows) {
      if (String(row[loaded.parsed.dateColumn] ?? "") !== previousDate) continue;
      const base = rowBase(row, loaded.parsed.baseColumn);
      const region = registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, loaded.parsed.regionColumn));
      const origin = rowOrigin(row, loaded.originColumn);
      if (!selectedRegions.has(region) || !selectedBases.has(base) || !selectedOrigins.has(origin) || !matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms)) continue;
      const current = groups.get(region) ?? { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(region, current);
    }
    return groups;
  }, [loaded, monitoringSummaryDates, responsibilityLoaded, selectedBases, selectedOrigins, selectedRegions, selectedRgms, selectedRms]);
  const firstScanPreviousTotal = useMemo(() => [...firstScanPreviousRegional.values()].reduce<FirstScanMetrics>((total, row) => {
    addFirstScanMetrics(total, row);
    return total;
  }, { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 }), [firstScanPreviousRegional]);
  const regionalSummaries = useMemo<RegionalSummary[]>(() => {
    if (!loaded) return [];

    const regions = new Map<string, WorkbookRow[]>();
    for (const row of filteredRows) {
      const base = rowBase(row, loaded.parsed.baseColumn as string);
      const region = registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, loaded.parsed.regionColumn));
      const rows = regions.get(region) ?? [];
      rows.push(row);
      regions.set(region, rows);
    }

    return [...regions.entries()]
      .map(([region, rows]) => {
        const byStatus = loaded.statuses
          .filter((status) => selectedStatuses.has(status))
          .map((status) => ({
            status,
            value: rows.reduce((sum, row) => sum + parseNumeric(row[status]), 0),
            color: colorForStatus(status, loaded.statuses),
          }))
          .filter((item) => item.value > 0)
          .sort((a, b) => b.value - a.value);
        const bases = new Set(
          rows
            .filter((row) =>
              [...selectedStatuses].some((status) => parseNumeric(row[status]) > 0),
            )
            .map((row) => rowBase(row, loaded.parsed.baseColumn as string)),
        );

        return {
          region,
          byStatus,
          activeBases: bases.size,
          total: byStatus.reduce((sum, item) => sum + item.value, 0),
        };
      })
      .filter((item) => item.total > 0)
      .sort((a, b) => b.total - a.total || a.region.localeCompare(b.region, "pt-BR"));
  }, [loaded, filteredRows, responsibilityLoaded, selectedStatuses]);

  const tableRows = useMemo(() => {
    if (!loaded) return [];
    const normalizedQuery = tableQuery.trim().toLocaleLowerCase("pt-BR");
    const baseColumn = loaded.parsed.baseColumn as string;
    const regionColumn = loaded.parsed.regionColumn;
    const period = formatConsolidatedPeriod(dateStart, dateEnd);
    const grouped = new Map<string, ConsolidatedBaseRow>();

    for (const row of filteredRows) {
      const base = rowBase(row, baseColumn);
      const region = registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, regionColumn));
      const origin = rowOrigin(row, loaded.originColumn);
      const key = `${region}::${base}::${origin}`;
      const current =
        grouped.get(key) ??
        ({
          key,
          region,
          base,
          origin,
          period,
          values: new Map<string, number>(),
          total: 0,
        } satisfies ConsolidatedBaseRow);

      for (const status of loaded.statuses) {
        const value = parseNumeric(row[status]);
        current.values.set(status, (current.values.get(status) ?? 0) + value);
        if (selectedStatuses.has(status)) current.total += value;
      }
      grouped.set(key, current);
    }

    return [...grouped.values()]
      .filter((row) => {
        if (!normalizedQuery) return true;
        return `${row.base} ${row.region} ${row.origin}`.toLocaleLowerCase("pt-BR").includes(normalizedQuery);
      })
      .sort((a, b) => {
        return (
          b.total - a.total ||
          a.region.localeCompare(b.region, "pt-BR", { numeric: true }) ||
          a.base.localeCompare(b.base, "pt-BR", { numeric: true }) ||
          a.origin.localeCompare(b.origin, "pt-BR", { numeric: true })
        );
      });
  }, [loaded, dateStart, dateEnd, filteredRows, responsibilityLoaded, selectedStatuses, tableQuery]);

  const monitoringRegionOptions = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [];
    return [...new Set(loaded.parsed.rows.map((row) => {
      const base = rowBase(row, loaded.parsed.baseColumn as string);
      return registeredRegionForBase(responsibilityLoaded, base, rowRegion(row, loaded.parsed.regionColumn));
    }))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [loaded, responsibilityLoaded]);
  const taxaRegionOptions = useMemo(() => {
    if (!taxaLoaded) return [];
    return [...new Set(taxaLoaded.records.map((record) =>
      registeredRegionForBase(responsibilityLoaded, record.base, record.region)))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [responsibilityLoaded, taxaLoaded]);
  const movementRegionOptions = useMemo(() => {
    if (!movementLoaded) return [];
    return [...new Set(movementLoaded.records.map((record) =>
      registeredRegionForBase(responsibilityLoaded, record.base, record.region)))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [movementLoaded, responsibilityLoaded]);
  const sellerRegionOptions = useMemo(() => {
    if (!sellerPerformanceLoaded) return [];
    return [...new Set(sellerPerformanceLoaded.records.map((record) =>
      registeredRegionForBase(responsibilityLoaded, record.base, record.region)))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [responsibilityLoaded, sellerPerformanceLoaded]);
  const bipagemRegionOptions = useMemo(() => {
    if (!bipagemLoaded) return [];
    return [...new Set(bipagemLoaded.records.map((record) =>
      registeredRegionForBase(responsibilityLoaded, record.base, record.region)))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [bipagemLoaded, responsibilityLoaded]);
  const bipagemRmOptions = useMemo(() => {
    if (!bipagemLoaded) return [];
    return [...new Set(bipagemLoaded.records.map((record) => responsibilityForBase(responsibilityLoaded, record.base).rm))]
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [bipagemLoaded, responsibilityLoaded]);
  const bipagemRgmOptions = useMemo(() => {
    if (!bipagemLoaded) return [];
    return [...new Set(bipagemLoaded.records.map((record) => responsibilityForBase(responsibilityLoaded, record.base).rgm))]
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [bipagemLoaded, responsibilityLoaded]);
  const bipagemBaseOptions = useMemo(() => {
    if (!bipagemLoaded) return [];
    return [...new Set(bipagemLoaded.records.filter((record) => {
      const region = registeredRegionForBase(responsibilityLoaded, record.base, record.region);
      const { rm, rgm } = responsibilityForBase(responsibilityLoaded, record.base);
      return bipagemSelectedRegions.has(region) && bipagemSelectedRms.has(rm) && bipagemSelectedRgms.has(rgm);
    }).map((record) => record.base))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [bipagemLoaded, bipagemSelectedRegions, bipagemSelectedRgms, bipagemSelectedRms, responsibilityLoaded]);

  const bipagemFilteredRecords = useMemo(() => {
    if (!bipagemLoaded || !bipagemDateStart || !bipagemDateEnd || bipagemDateStart > bipagemDateEnd) return [];
    return bipagemLoaded.records.map((record) => ({
      ...record,
      region: registeredRegionForBase(responsibilityLoaded, record.base, record.region),
    })).filter((record) => {
      const { rm, rgm } = responsibilityForBase(responsibilityLoaded, record.base);
      return record.date >= bipagemDateStart &&
        record.date <= bipagemDateEnd &&
        bipagemSelectedRegions.has(record.region) &&
        bipagemSelectedRms.has(rm) &&
        bipagemSelectedRgms.has(rgm) &&
        bipagemSelectedBases.has(record.base) &&
        bipagemSelectedOrigins.has(record.origin);
    });
  }, [bipagemDateEnd, bipagemDateStart, bipagemLoaded, bipagemSelectedBases, bipagemSelectedOrigins, bipagemSelectedRegions, bipagemSelectedRgms, bipagemSelectedRms, responsibilityLoaded]);

  const bipagemSummary = useMemo(() => summarizeBipagem(bipagemFilteredRecords), [bipagemFilteredRecords]);
  const bipagemRegionalSummary = useMemo(() => summarizeBipagemByRegional(bipagemFilteredRecords).sort((left, right) =>
    bipagemMissingForProblem(right, bipagemProblemType) - bipagemMissingForProblem(left, bipagemProblemType) ||
    right.ordersToScan - left.ordersToScan ||
    left.region.localeCompare(right.region, "pt-BR")), [bipagemFilteredRecords, bipagemProblemType]);
  const bipagemOverallComparison = useMemo(
    () => compareBipagemPeriod(bipagemFilteredRecords, bipagemDateStart, bipagemDateEnd),
    [bipagemDateEnd, bipagemDateStart, bipagemFilteredRecords],
  );
  const bipagemRegionalComparisons = useMemo(() => new Map(
    bipagemRegionalSummary.map((row) => [
      row.region,
      compareBipagemPeriod(
        bipagemFilteredRecords.filter((record) => record.region === row.region),
        bipagemDateStart,
        bipagemDateEnd,
      ),
    ]),
  ), [bipagemDateEnd, bipagemDateStart, bipagemFilteredRecords, bipagemRegionalSummary]);
  const bipagemBaseSummary = useMemo(() => {
    const normalizedQuery = normalizeSearchText(bipagemTableQuery.trim());
    return summarizeBipagemByBase(
      bipagemFilteredRecords,
      (base) => responsibilityForBase(responsibilityLoaded, base).rm,
    ).filter((row) => !normalizedQuery || normalizeSearchText(`${row.region} ${row.base} ${row.baseCode} ${row.rm}`).includes(normalizedQuery))
      .sort((left, right) =>
        bipagemMissingForProblem(right, bipagemProblemType) - bipagemMissingForProblem(left, bipagemProblemType) ||
        right.ordersToScan - left.ordersToScan ||
        left.base.localeCompare(right.base, "pt-BR", { numeric: true }));
  }, [bipagemFilteredRecords, bipagemProblemType, bipagemTableQuery, responsibilityLoaded]);

  const bipagemBaseComparisons = useMemo(() => new Map(
    bipagemBaseSummary.map((row) => [
      row.key,
      compareBipagemPeriod(
        bipagemFilteredRecords.filter((record) =>
          record.region === row.region &&
          record.base === row.base &&
          responsibilityForBase(responsibilityLoaded, record.base).rm === row.rm),
        bipagemDateStart,
        bipagemDateEnd,
      ),
    ]),
  ), [bipagemBaseSummary, bipagemDateEnd, bipagemDateStart, bipagemFilteredRecords, responsibilityLoaded]);

  const damageRegionOptions = useMemo(() => !damageLoaded ? [] : [...new Set(damageLoaded.records.map((record) =>
    registeredRegionForBase(responsibilityLoaded, record.base, record.region)))].sort((a, b) => a.localeCompare(b, "pt-BR")), [damageLoaded, responsibilityLoaded]);
  const damageRmOptions = useMemo(() => !damageLoaded ? [] : [...new Set(damageLoaded.records.filter((record) => damageSelectedRegions.has(registeredRegionForBase(responsibilityLoaded, record.base, record.region))).map((record) => responsibilityForBase(responsibilityLoaded, record.base).rm))].sort((a, b) => a.localeCompare(b, "pt-BR")), [damageLoaded, damageSelectedRegions, responsibilityLoaded]);
  const damageRgmOptions = useMemo(() => !damageLoaded ? [] : [...new Set(damageLoaded.records.filter((record) => damageSelectedRegions.has(registeredRegionForBase(responsibilityLoaded, record.base, record.region))).map((record) => responsibilityForBase(responsibilityLoaded, record.base).rgm))].sort((a, b) => a.localeCompare(b, "pt-BR")), [damageLoaded, damageSelectedRegions, responsibilityLoaded]);
  const damageBaseOptions = useMemo(() => !damageLoaded ? [] : [...new Set(damageLoaded.records.filter((record) =>
    damageSelectedRegions.has(registeredRegionForBase(responsibilityLoaded, record.base, record.region)) && damageSelectedRms.has(responsibilityForBase(responsibilityLoaded, record.base).rm) && damageSelectedRgms.has(responsibilityForBase(responsibilityLoaded, record.base).rgm)).map((record) => record.base))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true })), [damageLoaded, damageSelectedRegions, damageSelectedRms, damageSelectedRgms, responsibilityLoaded]);
  const damageRecords = useMemo(() => !damageLoaded || !damageDateStart || !damageDateEnd || damageDateStart > damageDateEnd ? [] :
    damageLoaded.records.map((record) => ({ ...record, region: registeredRegionForBase(responsibilityLoaded, record.base, record.region) }))
      .filter((record) => { const owner = responsibilityForBase(responsibilityLoaded, record.base); return record.date >= damageDateStart && record.date <= damageDateEnd && damageSelectedRegions.has(record.region) && damageSelectedRms.has(owner.rm) && damageSelectedRgms.has(owner.rgm) && damageSelectedBases.has(record.base); }),
    [damageDateEnd, damageDateStart, damageLoaded, damageSelectedBases, damageSelectedRegions, damageSelectedRms, damageSelectedRgms, responsibilityLoaded]);
  const damageSummary = useMemo(() => damageRecords.reduce((total, record) => ({ orders: total.orders + record.tickets, value: total.value + record.value }), { orders: 0, value: 0 }), [damageRecords]);
  const damageByBase = useMemo(() => [...damageRecords.reduce((map, record) => {
    const key = `${record.region}|${record.base}`; const item = map.get(key) ?? { region: record.region, base: record.base, orders: 0, value: 0 };
    item.orders += record.tickets; item.value += record.value; map.set(key, item); return map;
  }, new Map<string, { region: string; base: string; orders: number; value: number }>()).values()].sort((a,b) => b.value - a.value), [damageRecords]);
  const damageByRm = useMemo(() => [...damageRecords.reduce((map, record) => {
    const owner = responsibilityForBase(responsibilityLoaded, record.base); const key = `${owner.rgm}|${owner.rm}`;
    const item = map.get(key) ?? { rgm: owner.rgm, rm: owner.rm, orders: 0, value: 0 }; item.orders += record.tickets; item.value += record.value; map.set(key, item); return map;
  }, new Map<string, { rgm: string; rm: string; orders: number; value: number }>()).values()].sort((a,b) => b.value - a.value), [damageRecords, responsibilityLoaded]);
  const damageByRgm = useMemo(() => [...damageRecords.reduce((map, record) => {
    const rgm = responsibilityForBase(responsibilityLoaded, record.base).rgm;
    const item = map.get(rgm) ?? { rgm, orders: 0, value: 0 }; item.orders += record.tickets; item.value += record.value; map.set(rgm, item); return map;
  }, new Map<string, { rgm: string; orders: number; value: number }>()).values()].sort((a,b) => b.value - a.value), [damageRecords, responsibilityLoaded]);
  const damagePareto = useMemo(() => [...damageRecords.reduce((map, record) => { const item = map.get(record.reason) ?? { reason: record.reason, orders: 0, value: 0 }; item.orders += record.tickets; item.value += record.value; map.set(record.reason, item); return map; }, new Map<string, { reason: string; orders: number; value: number }>()).values()].sort((a,b) => b.value - a.value), [damageRecords]);
  const damageOriginsAll = useMemo(() => [...damageRecords.reduce((map, record) => { const item = map.get(record.origin) ?? { origin: record.origin, orders: 0, value: 0 }; item.orders += record.tickets; item.value += record.value; map.set(record.origin, item); return map; }, new Map<string, { origin: string; orders: number; value: number }>()).values()].sort((a,b) => b.orders - a.orders || b.value - a.value), [damageRecords]);
  const damageOrigins = useMemo(() => damageOriginsAll.slice(0, 20), [damageOriginsAll]);
  const damageRegionalDates = useMemo(() => [...new Set(damageRecords.map((record) => record.date))].sort().slice(-7), [damageRecords]);
  const damageRegionalRows = useMemo(() => [...damageRecords.reduce((map, record) => {
    const rgm = responsibilityForBase(responsibilityLoaded, record.base).rgm;
    const key = `${record.region}\u0000${rgm}`;
    const row = map.get(key) ?? { region: record.region, rgm, orders: 0, value: 0, daily: new Map<string, number>() };
    row.orders += record.tickets;
    row.value += record.value;
    row.daily.set(record.date, (row.daily.get(record.date) ?? 0) + record.tickets);
    map.set(key, row);
    return map;
  }, new Map<string, { region: string; rgm: string; orders: number; value: number; daily: Map<string, number> }>()).values()].sort((a, b) => b.orders - a.orders || a.region.localeCompare(b.region, "pt-BR")), [damageRecords, responsibilityLoaded]);

  const downloadDamageWorkbook = useCallback(async () => {
    try {
      const periodLabel = `${formatDisplayDate(damageDateStart)} a ${formatDisplayDate(damageDateEnd)}`;
      const detailRows = damageRecords.map((record) => {
        const owner = responsibilityForBase(responsibilityLoaded, record.base);
        return [
          formatDisplayDate(record.date),
          record.ticket,
          record.shipment,
          record.region,
          record.base,
          owner.rm,
          owner.rgm,
          record.type,
          record.reason,
          record.origin,
          record.tickets,
          record.value,
        ];
      });

      await downloadTaxaManagementExcel(
        [
          {
            name: "Regionais",
            title: `${t("Extravio")} / 丢失 — ${t("Regional")} — ${periodLabel}`,
            headers: ["Regional\n区域", "RGM\n区域经理", ...damageRegionalDates.map((date) => `${formatDisplayDate(date)}\n订单量`), "Total de pedidos\n订单总量", "Valor\n金额"],
            rows: [
              ...damageRegionalRows.map((row) => [row.region, row.rgm, ...damageRegionalDates.map((date) => row.daily.get(date) ?? 0), row.orders, row.value]),
              ["Total geral 总计", "", ...damageRegionalDates.map((date) => damageRegionalRows.reduce((sum, row) => sum + (row.daily.get(date) ?? 0), 0)), damageSummary.orders, damageSummary.value],
            ],
            widths: [17, 42, ...damageRegionalDates.map(() => 15), 20, 20],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: 1,
          },
          {
            name: "RM",
            title: `${t("Extravio")} / 丢失 — ${t("Total por RM")} — ${periodLabel}`,
            headers: ["RGM\nRGM", "RM\nRM", "Total de pedidos\n订单总量", "Valor\n金额"],
            rows: [
              ...damageByRm.map((row) => [row.rgm, row.rm, row.orders, row.value]),
              ["Total geral 总计", "", damageSummary.orders, damageSummary.value],
            ],
            widths: [42, 42, 18, 18],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: 1,
          },
          {
            name: "RGM",
            title: `${t("Extravio")} / 丢失 — ${t("Total por RGM")} — ${periodLabel}`,
            headers: ["RGM\nRGM", "Total de pedidos\n订单总量", "Valor\n金额"],
            rows: [
              ...damageByRgm.map((row) => [row.rgm, row.orders, row.value]),
              ["Total geral 总计", damageSummary.orders, damageSummary.value],
            ],
            widths: [42, 18, 18],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
          },
          {
            name: "Motivos",
            title: `${t("Extravio")} / 丢失 — ${t("Principais motivos — tipo secundário")} — ${periodLabel}`,
            headers: ["Motivo\n原因", "Pedidos\n订单量", "Valor\n金额"],
            rows: [
              ...damagePareto.map((row) => [row.reason, row.orders, row.value]),
              ["Total geral 总计", damageSummary.orders, damageSummary.value],
            ],
            widths: [54, 18, 18],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
          },
          {
            name: "Bases",
            title: `${t("Extravio")} / 丢失 — ${t("Visão por base")} — ${periodLabel}`,
            headers: ["Regional\n区域", "Base\n网点", "Pedidos\n订单量", "Valor\n金额"],
            rows: [
              ...damageByBase.map((row) => [row.region, row.base, row.orders, row.value]),
              ["Total geral 总计", "", damageSummary.orders, damageSummary.value],
            ],
            widths: [16, 28, 18, 18],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: 1,
          },
          {
            name: "Clientes",
            title: `${t("Extravio")} / 丢失 — ${t("Clientes com mais avaria / extravio")} — ${periodLabel}`,
            headers: ["Cliente / código da origem\n客户/来源代码", "Total de pedidos\n订单总量", "Valor\n金额"],
            rows: [
              ...damageOriginsAll.map((row) => [row.origin, row.orders, row.value]),
              ["Total geral 总计", damageSummary.orders, damageSummary.value],
            ],
            widths: [44, 18, 18],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
          },
          {
            name: "Detalhamento",
            title: `${t("Extravio")} / 丢失 — ${t("Pedidos para análise regional")} — ${periodLabel}`,
            headers: [
              "Data de declaração\n申报日期",
              "Número do ticket\n工单号",
              "Número da remessa\n运单号",
              "Regional\n区域",
              "Base\n网点",
              "RM\nRM负责人",
              "RGM\nRGM负责人",
              "Tipo primário\n一级类型",
              "Tipo secundário\n二级类型",
              "Código da origem / cliente\n来源代码/客户",
              "Qtd. pedidos\n订单量",
              "Valor da arbitragem (R$)\n仲裁金额",
            ],
            rows: [
              ...detailRows,
              ["Total geral 总计", "", "", "", "", "", "", "", "", "", damageSummary.orders, damageSummary.value],
            ],
            widths: [18, 24, 24, 14, 24, 34, 34, 26, 42, 34, 15, 20],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: 9,
          },
        ],
        `extravio_gerencial_${damageDateStart || "inicio"}_${damageDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [damageByBase, damageByRm, damageByRgm, damageDateEnd, damageDateStart, damageOriginsAll, damagePareto, damageRecords, damageRegionalDates, damageRegionalRows, damageSummary, responsibilityLoaded, t]);

  const downloadDamageTableExcel = useCallback(async (section: "regional" | "rm" | "rgm" | "base" | "motivos" | "clientes") => {
    const period = `${formatDisplayDate(damageDateStart)} a ${formatDisplayDate(damageDateEnd)}`;
    const common = { percentageColumns: [], performanceColumn: -1, targetRate: null };
    const sheet: ManagementExcelSheet = section === "regional" ? {
      ...common, name: "Regionais", title: `Extravio — Regional — ${period}`,
      headers: ["Regional", "RGM", ...damageRegionalDates.map(formatDisplayDate), "Total de pedidos", "Valor (R$)"],
      rows: [...damageRegionalRows.map((row) => [row.region, row.rgm, ...damageRegionalDates.map((date) => row.daily.get(date) ?? 0), row.orders, row.value]), ["Total geral", "", ...damageRegionalDates.map((date) => damageRegionalRows.reduce((sum, row) => sum + (row.daily.get(date) ?? 0), 0)), damageSummary.orders, damageSummary.value]],
      widths: [17, 42, ...damageRegionalDates.map(() => 16), 20, 20], totalMergeEndColumn: 1,
    } : section === "rm" ? {
      ...common, name: "RM", title: `Extravio — Total por RM — ${period}`, headers: ["RGM", "RM", "Total de pedidos", "Valor (R$)"],
      rows: [...damageByRm.map((row) => [row.rgm, row.rm, row.orders, row.value]), ["Total geral", "", damageSummary.orders, damageSummary.value]], widths: [42, 42, 20, 20], totalMergeEndColumn: 1,
    } : section === "rgm" ? {
      ...common, name: "RGM", title: `Extravio — Total por RGM — ${period}`, headers: ["RGM", "Total de pedidos", "Valor (R$)"],
      rows: [...damageByRgm.map((row) => [row.rgm, row.orders, row.value]), ["Total geral", damageSummary.orders, damageSummary.value]], widths: [42, 20, 20],
    } : section === "base" ? {
      ...common, name: "Bases", title: `Extravio — Visão por base — ${period}`, headers: ["Regional", "Base", "Pedidos", "Valor (R$)"],
      rows: [...damageByBase.map((row) => [row.region, row.base, row.orders, row.value]), ["Total geral", "", damageSummary.orders, damageSummary.value]], widths: [17, 36, 20, 20], totalMergeEndColumn: 1,
    } : section === "motivos" ? {
      ...common, name: "Motivos", title: `Extravio — Tipo secundário — ${period}`, headers: ["Motivo", "Pedidos", "Valor (R$)"],
      rows: [...damagePareto.map((row) => [row.reason, row.orders, row.value]), ["Total geral", damageSummary.orders, damageSummary.value]], widths: [54, 20, 20],
    } : {
      ...common, name: "Clientes", title: `Extravio — Clientes / origem — ${period}`, headers: ["Cliente / código da origem", "Pedidos", "Valor (R$)"],
      rows: [...damageOriginsAll.map((row) => [row.origin, row.orders, row.value]), ["Total geral", damageSummary.orders, damageSummary.value]], widths: [44, 20, 20],
    };
    try {
      await downloadTaxaManagementExcel([sheet], `extravio_${section}_${damageDateStart || "inicio"}_${damageDateEnd || "fim"}.xlsx`);
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [damageByBase, damageByRm, damageByRgm, damageDateEnd, damageDateStart, damageOriginsAll, damagePareto, damageRegionalDates, damageRegionalRows, damageSummary, t]);

  const responsibilityFilterOptions = useMemo(() => {
    const bases = new Set<string>();
    for (const base of loaded?.bases ?? []) bases.add(base);
    for (const base of taxaLoaded?.bases ?? []) bases.add(base);
    for (const base of movementLoaded?.bases ?? []) bases.add(base);
    for (const base of sellerPerformanceLoaded?.bases ?? []) bases.add(base);
    const options = responsibilityOptions(responsibilityLoaded, bases);
    return {
      rms: [...new Set([...(responsibilityLoaded?.rms ?? []), ...options.rms, UNASSIGNED_RM])]
        .sort((a, b) => a.localeCompare(b, "pt-BR")),
      rgms: [...new Set([...(responsibilityLoaded?.rgms ?? []), ...options.rgms, UNASSIGNED_RGM])]
        .sort((a, b) => a.localeCompare(b, "pt-BR")),
    };
  }, [loaded, movementLoaded, responsibilityLoaded, sellerPerformanceLoaded, taxaLoaded]);

  const baseOptions = useMemo(() => {
    if (!loaded) return [];
    return basesForRegions(loaded, selectedRegions, responsibilityLoaded).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
  }, [loaded, responsibilityLoaded, selectedRegions, selectedRgms, selectedRms]);

  const taxaBaseOptions = useMemo(() => {
    if (!taxaLoaded) return [];
    return taxaBasesForRegions(taxaLoaded, taxaSelectedRegions, responsibilityLoaded).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms) &&
      taxaSelectedRmAreas.has(rmAreaForBase(responsibilityLoaded, base)));
  }, [responsibilityLoaded, selectedRgms, selectedRms, taxaLoaded, taxaSelectedRegions, taxaSelectedRmAreas]);

  const taxaRmAreaOptions = useMemo(() => {
    if (!taxaLoaded) return [];
    const bases = taxaBasesForRegions(taxaLoaded, taxaSelectedRegions, responsibilityLoaded).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
    return responsibilityOptions(responsibilityLoaded, bases).rmAreas;
  }, [responsibilityLoaded, selectedRgms, selectedRms, taxaLoaded, taxaSelectedRegions]);

  const taxaFilteredRecords = useMemo(() => {
    if (!taxaLoaded || !taxaDateStart || !taxaDateEnd || taxaDateStart > taxaDateEnd) return [];
    return taxaLoaded.records.map((record) => ({
      ...record,
      region: registeredRegionForBase(responsibilityLoaded, record.base, record.region),
    })).filter(
      (record) =>
        record.date >= taxaDateStart &&
        record.date <= taxaDateEnd &&
        taxaSelectedRegions.has(record.region) &&
        taxaSelectedBases.has(record.base) &&
        taxaSelectedOrigins.has(record.origin) &&
        taxaSelectedRmAreas.has(rmAreaForBase(responsibilityLoaded, record.base)) &&
        matchesResponsibility(responsibilityLoaded, record.base, selectedRms, selectedRgms),
    );
  }, [responsibilityLoaded, selectedRgms, selectedRms, taxaLoaded, taxaDateStart, taxaDateEnd, taxaSelectedBases, taxaSelectedOrigins, taxaSelectedRegions, taxaSelectedRmAreas]);

  const taxaAttemptTarget = useMemo(
    () => attemptRateTargetForOrigins(taxaSelectedOrigins),
    [taxaSelectedOrigins],
  );
  const taxaPerformanceThreshold = taxaAttemptTarget ?? ATTEMPT_RATE_TARGET;

  const taxaSummary = useMemo(
    () => summarizeTaxaPeriod(taxaFilteredRecords),
    [taxaFilteredRecords],
  );

  const baseAnalysisText = useMemo(() => {
    if (view === "taxa") {
      const byRegional = new Map<string, { toCollect: number; attempted: number; bases: Map<string, { base: string; rm: string; orders: number; toCollect: number; attempted: number }> }>();
      for (const record of taxaFilteredRecords) {
        const regional = byRegional.get(record.region) ?? { toCollect: 0, attempted: 0, bases: new Map() };
        regional.toCollect += record.toCollect;
        regional.attempted += record.collectedWithAttempts;
        const base = regional.bases.get(record.base) ?? { base: record.base, rm: responsibilityForBase(responsibilityLoaded, record.base).rm, orders: 0, toCollect: 0, attempted: 0 };
        base.orders += record.orders;
        base.toCollect += record.toCollect;
        base.attempted += record.collectedWithAttempts;
        regional.bases.set(record.base, base);
        byRegional.set(record.region, regional);
      }
      const regionals = [...byRegional.entries()].map(([regional, value]) => ({
        regional,
        rate: safeRate(value.attempted, value.toCollect),
        priorities: [...value.bases.values()].map((base) => {
          const rate = safeRate(base.attempted, base.toCollect);
          return { ...base, rate, impact: Math.max(0, base.toCollect * 0.98 - base.attempted) };
        })
          .filter((base) => base.orders > 500 && base.toCollect > 0 && base.rate < 0.98)
          .sort((left, right) => right.impact - left.impact || right.orders - left.orders || left.rate - right.rate)
          .slice(0, 2),
      })).filter((item) => item.priorities.length > 0)
        .sort((left, right) => right.priorities.reduce((sum, base) => sum + base.impact, 0) - left.priorities.reduce((sum, base) => sum + base.impact, 0) || left.rate - right.rate || left.regional.localeCompare(right.regional, "pt-BR"));
      const selectedDate = taxaDateEnd || taxaDateStart;
      const [, month, day] = selectedDate.split("-");
      const messageDate = day && month ? `${day}/${month}` : selectedDate;
      return [
        "Bom dia, pessoal!", "大家早上好！", "",
        `📊 **Taxa de Coleta ${messageDate} | 揽收及时率**`,
        `Geral: **${formatRate(taxaSummary.collectionWithAttemptsRate)}** | Meta: **98%**`,
        `整体：**${formatRate(taxaSummary.collectionWithAttemptsRate)}** | 目标：**98%**`,
        "", "⚠️ **Pontos críticos / 重点关注**", "",
        ...(regionals.length ? regionals.slice(0, 5).flatMap((regional) => [
          `${regional.rate < 0.95 ? "🔴" : "🟠"} **${regional.regional} ${formatRate(regional.rate)}**`,
          ...regional.priorities.map((base) => {
            const rm = base.rm.trim() || "待定";
            return `${base.base} **${formatRate(base.rate)}** | ${formatNumber(base.orders)} pacotes | ${rm.startsWith("@") ? rm : `@${rm}`}`;
          }),
          "",
        ]) : ["Nenhuma base relevante abaixo da meta no recorte selecionado.", ""]),
        "⚠️ **Prioridade hoje: recuperar as bases de maior volume abaixo da meta.**",
        "⚠️ **今日重点：优先改善订单量大且低于目标的网点。**", "",
        "Contamos com a atuação dos responsáveis.", "请各负责人重点跟进改善。",
      ].join("\n");
    }
    if (view === "bipagem") {
      const priorities = bipagemBaseSummary.filter((row) => row.ordersToScan > 0).sort((a, b) => b.collectionFailureRate - a.collectionFailureRate || b.notScannedCollection - a.notScannedCollection).slice(0, 8);
      return [`📊 *Falha na coleta PDD — ${formatDate(bipagemDateEnd || bipagemDateStart)}*`, `Total de pedidos: *${formatNumber(bipagemSummary.ordersToScan)}*.`, `Pedidos não bipados: *${formatNumber(bipagemSummary.notScannedCollection)}* (${formatRate(bipagemSummary.collectionFailureRate)}).`, "", "*Bases prioritárias:*", ...(priorities.length ? priorities.map((row) => `• ${row.base}: ${formatRate(row.collectionFailureRate)} — @${row.rm}`) : ["• Nenhuma base prioritária no recorte selecionado."]), "", "Contamos com a atuação dos responsáveis para reduzir as falhas."].join("\n");
    }
    return `📊 *Análise ${view === "movimentacao" ? "de sem movimentação" : view === "sellers" ? "de sellers" : "de monitoramento"}*\n\nUse os filtros do painel para definir o recorte antes de gerar a mensagem.`;
  }, [bipagemBaseSummary, bipagemDateEnd, bipagemDateStart, bipagemSummary, responsibilityLoaded, taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaPerformanceThreshold, taxaSummary.collectionWithAttemptsRate, view]);

  const taxaGeneralMonthlyTrend = useMemo(() => {
    const latestDate = [...taxaFilteredRecords]
      .map((record) => record.date)
      .sort()
      .at(-1) ?? "";
    const year = latestDate.slice(0, 4);
    const groups = new Map<string, { monthKey: string; toCollect: number; onTime: number; withAttempts: number }>();
    for (const record of taxaFilteredRecords) {
      if (!year || !record.date.startsWith(`${year}-`)) continue;
      const monthKey = record.date.slice(0, 7);
      const current = groups.get(monthKey) ?? { monthKey, toCollect: 0, onTime: 0, withAttempts: 0 };
      current.toCollect += record.toCollect;
      current.onTime += record.onTime;
      current.withAttempts += record.collectedWithAttempts;
      groups.set(monthKey, current);
    }
    const months = [...groups.values()]
      .filter((month) => month.toCollect > 0)
      .sort((leftMonth, rightMonth) => leftMonth.monthKey.localeCompare(rightMonth.monthKey));
    const monthFormatter = new Intl.DateTimeFormat(dashboardLocale(language), { month: "short", timeZone: "UTC" });
    const width = 620;
    const height = 250;
    const left = 48;
    const right = 20;
    const top = 24;
    const bottom = 44;
    const minRate = 0.75;
    const maxRate = 1;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const xForIndex = (index: number) =>
      left + (months.length <= 1 ? chartWidth / 2 : (index / (months.length - 1)) * chartWidth);
    const yForRate = (rate: number) => {
      const clamped = Math.max(minRate, Math.min(maxRate, rate));
      return top + (1 - (clamped - minRate) / (maxRate - minRate)) * chartHeight;
    };
    const points = months.map((month, index) => ({
      ...month,
      x: xForIndex(index),
      monthLabel: monthFormatter
        .format(new Date(`${month.monthKey}-01T12:00:00Z`))
        .replace(/\.$/, ""),
      collectionRate: safeRate(month.onTime, month.toCollect),
      attemptRate: safeRate(month.withAttempts, month.toCollect),
    })).map((point) => ({
      ...point,
      collectionY: yForRate(point.collectionRate),
      attemptY: yForRate(point.attemptRate),
    }));

    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      minRate,
      maxRate,
      year,
      points,
      collectionLine: points.map((point) => `${point.x},${point.collectionY}`).join(" "),
      attemptLine: points.map((point) => `${point.x},${point.attemptY}`).join(" "),
      targetY: taxaAttemptTarget == null ? null : yForRate(taxaAttemptTarget),
    };
  }, [language, taxaAttemptTarget, taxaFilteredRecords]);

  const taxaRegionalPoc = useMemo(() => {
    if (!taxaLoaded) return { dates: [] as string[], rows: [] as Array<{ region: string; rgm: string; values: Array<{ orders: number; toCollect: number; withAttempts: number; rate: number }>; totalOrders: number }>, total: [] as Array<{ orders: number; toCollect: number; withAttempts: number; rate: number }>, totalOrders: 0 };
    const records = taxaFilteredRecords;
    const dates = taxaLoaded.dates
      .filter((date) => date >= taxaDateStart && date <= taxaDateEnd)
      .slice(-TAXA_MAX_PERIOD_DAYS);
    const dateSet = new Set(dates);
    const regionGroups = new Map<string, Map<string, { orders: number; toCollect: number; withAttempts: number }>>();
    for (const record of records) {
      if (!dateSet.has(record.date) || !record.region || normalizeSearchText(record.region) === normalizeSearchText("Sem regional")) continue;
      const byDate = regionGroups.get(record.region) ?? new Map<string, { orders: number; toCollect: number; withAttempts: number }>();
      const current = byDate.get(record.date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
      current.orders += record.orders;
      current.toCollect += record.toCollect;
      current.withAttempts += record.collectedWithAttempts;
      byDate.set(record.date, current);
      regionGroups.set(record.region, byDate);
    }
    const rows = [...regionGroups.entries()]
      .map(([region, byDate]) => {
        const values = dates.map((date) => {
          const value = byDate.get(date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
          return { ...value, rate: safeRate(value.withAttempts, value.toCollect) };
        });
        return {
          region,
          rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
          values,
          totalOrders: values.reduce((sum, value) => sum + value.orders, 0),
        };
      })
      .sort((a, b) => {
        const aLatest = a.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: 0 };
        const bLatest = b.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: 0 };
        return (
          Number(bLatest.toCollect > 0) - Number(aLatest.toCollect > 0) ||
          bLatest.rate - aLatest.rate ||
          bLatest.toCollect - aLatest.toCollect ||
          a.region.localeCompare(b.region, "pt-BR", { numeric: true })
        );
      });
    const total = dates.map((_, index) => {
      const value = rows.reduce((sum, row) => ({
        orders: sum.orders + row.values[index].orders,
        toCollect: sum.toCollect + row.values[index].toCollect,
        withAttempts: sum.withAttempts + row.values[index].withAttempts,
      }), { orders: 0, toCollect: 0, withAttempts: 0 });
      return { ...value, rate: safeRate(value.withAttempts, value.toCollect) };
    });
    return { dates, rows, total, totalOrders: total.reduce((sum, value) => sum + value.orders, 0) };
  }, [taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaLoaded]);

  const taxaRmPoc = useMemo(() => {
    const dates = taxaRegionalPoc.dates;
    const dateSet = new Set(dates);
    const rmGroups = new Map<string, { rmArea: string; rm: string; rgm: string; byDate: Map<string, { orders: number; toCollect: number; withAttempts: number }> }>();
    for (const record of taxaFilteredRecords) {
      if (!dateSet.has(record.date) || !record.region || normalizeSearchText(record.region) === normalizeSearchText("Sem regional")) continue;
      const responsibility = responsibilityForBase(responsibilityLoaded, record.base);
      const rm = responsibility.rm;
      const rgm = officialRgmForRegion(record.region) ?? responsibility.rgm;
      const rmArea = rmAreaForBase(responsibilityLoaded, record.base);
      const groupKey = `${rmArea}\u0000${rm}\u0000${rgm}`;
      const group = rmGroups.get(groupKey) ?? { rmArea, rm, rgm, byDate: new Map<string, { orders: number; toCollect: number; withAttempts: number }>() };
      const byDate = group.byDate;
      const current = byDate.get(record.date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
      current.orders += record.orders;
      current.toCollect += record.toCollect;
      current.withAttempts += record.collectedWithAttempts;
      byDate.set(record.date, current);
      rmGroups.set(groupKey, group);
    }
    const rows = [...rmGroups.values()]
      .map(({ rmArea, rm, rgm, byDate }) => {
        const values = dates.map((date) => {
          const value = byDate.get(date) ?? { orders: 0, toCollect: 0, withAttempts: 0 };
          return { ...value, rate: safeRate(value.withAttempts, value.toCollect) };
        });
        return { rmArea, rm, rgm, values, totalOrders: values.reduce((sum, value) => sum + value.orders, 0) };
      })
      .filter((row) => row.totalOrders > 0 || row.values.some((value) => value.toCollect > 0))
      .sort((a, b) => {
        const aLatest = a.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: 0 };
        const bLatest = b.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: 0 };
        return (
          Number(bLatest.toCollect > 0) - Number(aLatest.toCollect > 0) ||
          bLatest.rate - aLatest.rate ||
          bLatest.toCollect - aLatest.toCollect ||
          a.rmArea.localeCompare(b.rmArea, dashboardLocale(language), { numeric: true }) ||
          a.rm.localeCompare(b.rm, dashboardLocale(language), { numeric: true })
        );
      });
    return { dates, rows, total: taxaRegionalPoc.total, totalOrders: taxaRegionalPoc.totalOrders };
  }, [language, responsibilityLoaded, taxaFilteredRecords, taxaRegionalPoc]);

  const taxaDailyPeriod = useMemo(() => {
    if (!taxaLoaded) return [] as Array<{ date: string; toCollect: number; withAttempts: number; rate: number }>;
    const dates = taxaLoaded.dates.filter((date) => date >= taxaDateStart && date <= taxaDateEnd);
    const totals = new Map<string, { toCollect: number; withAttempts: number }>();
    for (const record of taxaFilteredRecords) {
      const current = totals.get(record.date) ?? { toCollect: 0, withAttempts: 0 };
      current.toCollect += record.toCollect;
      current.withAttempts += record.collectedWithAttempts;
      totals.set(record.date, current);
    }
    return dates.map((date) => {
      const value = totals.get(date) ?? { toCollect: 0, withAttempts: 0 };
      return { date, ...value, rate: safeRate(value.withAttempts, value.toCollect) };
    });
  }, [taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaLoaded]);

  const taxaPocTrend = useMemo(() => {
    const width = 700;
    const height = 180;
    const left = 40;
    const right = 14;
    const top = 22;
    const bottom = 36;
    const minRate = 0.7;
    const maxRate = 1;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const yForRate = (rate: number) => {
      const clamped = Math.max(minRate, Math.min(maxRate, rate));
      return top + (1 - (clamped - minRate) / (maxRate - minRate)) * chartHeight;
    };
    const points = taxaDailyPeriod.map((value, index) => {
      return {
        ...value,
        x: left + (taxaDailyPeriod.length <= 1 ? chartWidth / 2 : (index / (taxaDailyPeriod.length - 1)) * chartWidth),
        y: yForRate(value.rate),
      };
    });
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      points,
      line: points.map((point) => `${point.x},${point.y}`).join(" "),
      targetY: taxaAttemptTarget == null ? null : yForRate(taxaAttemptTarget),
    };
  }, [taxaAttemptTarget, taxaDailyPeriod]);

  const epopDailyPeriod = useMemo(() => {
    if (!epopLoaded) return [] as Array<{ date: string; eligible: number; withEpop: number; rate: number }>;
    const groups = new Map<string, Map<string, { eligible: boolean; epop: boolean }>>();
    for (const row of epopLoaded.records) {
      if (row.date < epopDateStart || row.date > epopDateEnd || !epopSelectedRegions.has(row.region) || !epopSelectedBases.has(row.base)) continue;
      const responsibility = responsibilityForBase(responsibilityLoaded, row.base);
      if (!selectedRms.has(responsibility.rm) || !selectedRgms.has(responsibility.rgm)) continue;
      const sellers = groups.get(row.date) ?? new Map();
      const current = sellers.get(row.sellerId) ?? { eligible: false, epop: false };
      current.eligible ||= row.eligible; current.epop ||= row.eligible && row.epop;
      sellers.set(row.sellerId, current); groups.set(row.date, sellers);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, sellers]) => {
      const values = [...sellers.values()].filter((value) => value.eligible); const withEpop = values.filter((value) => value.epop).length;
      return { date, eligible: values.length, withEpop, rate: safeRate(withEpop, values.length) };
    });
  }, [epopDateEnd, epopDateStart, epopLoaded, epopSelectedBases, epopSelectedRegions, responsibilityLoaded, selectedRgms, selectedRms]);

  const taxaOriginSummary = useMemo(() => {
    const groups = new Map<string, { origin: string; toCollect: number; onTime: number; withAttempts: number }>();
    for (const record of taxaFilteredRecords) {
      const current = groups.get(record.origin) ?? { origin: record.origin, toCollect: 0, onTime: 0, withAttempts: 0 };
      current.toCollect += record.toCollect;
      current.onTime += record.onTime;
      current.withAttempts += record.collectedWithAttempts;
      groups.set(record.origin, current);
    }
    return [...groups.values()]
      .map((item) => ({
        ...item,
        onTimeRate: safeRate(item.onTime, item.toCollect),
        attemptRate: safeRate(item.withAttempts, item.toCollect),
      }))
      .sort((a, b) => b.toCollect - a.toCollect || a.origin.localeCompare(b.origin, "pt-BR"));
  }, [taxaFilteredRecords]);

  const taxaTableRows = useMemo(() => {
    const normalizedQuery = normalizeSearchText(taxaTableQuery.trim());
    const period = formatConsolidatedPeriod(taxaDateStart, taxaDateEnd);
    const latestPerformanceDate = taxaRegionalPoc.dates.at(-1) ?? "";
    const groups = new Map<
      string,
      {
        key: string;
        period: string;
        region: string;
        base: string;
        origin: string;
        productTypes: Set<string>;
        orders: number;
        toCollect: number;
        collected: number;
        notCollected: number;
        withAttempts: number;
        onTime: number;
        averageWeighted: number;
        averageWeight: number;
        latestToCollect: number;
        latestWithAttempts: number;
      }
    >();

    for (const record of taxaFilteredRecords) {
      const key = `${record.region}::${record.base}::${record.origin}`;
      const current =
        groups.get(key) ??
        {
          key,
          period,
          region: record.region,
          base: record.base,
          origin: record.origin,
          productTypes: new Set<string>(),
          orders: 0,
          toCollect: 0,
          collected: 0,
          notCollected: 0,
          withAttempts: 0,
          onTime: 0,
          averageWeighted: 0,
          averageWeight: 0,
          latestToCollect: 0,
          latestWithAttempts: 0,
        };
      current.productTypes.add(record.productType);
      current.orders += record.orders;
      current.toCollect += record.toCollect;
      current.collected += record.collected;
      current.notCollected += record.notCollected;
      current.withAttempts += record.collectedWithAttempts;
      current.onTime += record.onTime;
      const weight = Math.max(record.toCollect, record.collected, 1);
      current.averageWeighted += record.averageCollectionHours * weight;
      current.averageWeight += weight;
      if (record.date === latestPerformanceDate) {
        current.latestToCollect += record.toCollect;
        current.latestWithAttempts += record.collectedWithAttempts;
      }
      groups.set(key, current);
    }

    const rows = [...groups.values()]
      .map((row) => ({
        ...row,
        productType: [...row.productTypes].slice(0, 3).join(", "),
        attemptRate: safeRate(row.withAttempts, row.toCollect),
        onTimeRate: safeRate(row.onTime, row.toCollect),
        latestAttemptRate: safeRate(row.latestWithAttempts, row.latestToCollect),
        averageHours: weightedAverage(row.averageWeighted, row.averageWeight),
      }))
      .filter((row) => {
        if (!normalizedQuery) return true;
        return normalizeSearchText(`${row.base} ${row.region} ${row.origin}`).includes(normalizedQuery);
      });

    return rows.sort((a, b) => {
      return (
        Number(b.latestToCollect > 0) - Number(a.latestToCollect > 0) ||
        b.latestAttemptRate - a.latestAttemptRate ||
        b.latestToCollect - a.latestToCollect ||
        a.base.localeCompare(b.base, "pt-BR", { numeric: true })
      );
    });
  }, [taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaRegionalPoc.dates, taxaTableQuery]);

  const downloadTaxaManagementWorkbook = useCallback(async () => {
    if (taxaFilteredRecords.length === 0) return;

    try {
      const originLabel = taxaExcelOriginLabel(taxaSelectedOrigins);
      const selectedDates = [...new Set(taxaFilteredRecords.map((record) => record.date))].sort();
      const periodStart = selectedDates[0] ?? taxaDateStart;
      const periodEnd = selectedDates.at(-1) ?? taxaDateEnd;
      const dateLabel = formatTaxaExcelPeriod(periodStart, periodEnd);
      const targetColumns = taxaAttemptTarget == null ? [] : ["Meta\n目标"];
      const targetValues = taxaAttemptTarget == null ? [] : [taxaAttemptTarget];

      const regionalGroups = new Map<string, TaxaRecord[]>();
      const rmGroups = new Map<string, { rmArea: string; rm: string; rgm: string; records: TaxaRecord[] }>();
      for (const record of taxaFilteredRecords) {
        if (!record.region || normalizeSearchText(record.region) === normalizeSearchText("Sem regional")) continue;
        const regionalRecords = regionalGroups.get(record.region) ?? [];
        regionalRecords.push(record);
        regionalGroups.set(record.region, regionalRecords);

        const responsibility = responsibilityForBase(responsibilityLoaded, record.base);
        const rmArea = rmAreaForBase(responsibilityLoaded, record.base);
        const rm = responsibility.rm;
        const rgm = officialRgmForRegion(record.region) ?? responsibility.rgm;
        const rmKey = `${rmArea}\u0000${rm}\u0000${rgm}`;
        const rmGroup = rmGroups.get(rmKey) ?? { rmArea, rm, rgm, records: [] };
        rmGroup.records.push(record);
        rmGroups.set(rmKey, rmGroup);
      }

      const regionalCollectionRateColumn = taxaAttemptTarget == null ? 2 : 3;
      const regionalPerformanceColumn = regionalCollectionRateColumn + 1;
      const regionalRows: ExcelExportValue[][] = [...regionalGroups.entries()]
        .map(([region, records]) => ({
          region,
          rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
          summary: summarizeTaxaPeriod(records),
        }))
        .sort((a, b) =>
          b.summary.collectionWithAttemptsRate - a.summary.collectionWithAttemptsRate ||
          b.summary.toCollect - a.summary.toCollect ||
          a.region.localeCompare(b.region, "pt-BR", { numeric: true }),
        )
        .map((row) => [
          row.region,
          row.rgm,
          ...targetValues,
          row.summary.toCollect > 0 ? row.summary.onTimeRate : null,
          row.summary.toCollect > 0 ? row.summary.collectionWithAttemptsRate : null,
          row.summary.orders,
        ]);
      regionalRows.push([
        "Total geral 总计",
        "—",
        ...targetValues,
        taxaSummary.toCollect > 0 ? taxaSummary.onTimeRate : null,
        taxaSummary.toCollect > 0 ? taxaSummary.collectionWithAttemptsRate : null,
        taxaSummary.orders,
      ]);

      const rmCollectionRateColumn = taxaAttemptTarget == null ? 3 : 4;
      const rmPerformanceColumn = rmCollectionRateColumn + 1;
      const rmRows: ExcelExportValue[][] = [...rmGroups.values()]
        .map((row) => ({ ...row, summary: summarizeTaxaPeriod(row.records) }))
        .sort((a, b) =>
          b.summary.collectionWithAttemptsRate - a.summary.collectionWithAttemptsRate ||
          b.summary.toCollect - a.summary.toCollect ||
          a.rmArea.localeCompare(b.rmArea, dashboardLocale(language), { numeric: true }) ||
          a.rm.localeCompare(b.rm, dashboardLocale(language), { numeric: true }),
        )
        .map((row) => [
          row.rmArea,
          row.rm,
          row.rgm,
          ...targetValues,
          row.summary.toCollect > 0 ? row.summary.onTimeRate : null,
          row.summary.toCollect > 0 ? row.summary.collectionWithAttemptsRate : null,
          row.summary.orders,
        ]);
      rmRows.push([
        "Total geral 总计",
        "—",
        "—",
        ...targetValues,
        taxaSummary.toCollect > 0 ? taxaSummary.onTimeRate : null,
        taxaSummary.toCollect > 0 ? taxaSummary.collectionWithAttemptsRate : null,
        taxaSummary.orders,
      ]);

      const baseCollectionRateColumn = taxaAttemptTarget == null ? 6 : 7;
      const basePerformanceColumn = baseCollectionRateColumn + 1;
      const baseRows: ExcelExportValue[][] = taxaTableRows.map((row) => {
        const responsibility = responsibilityForBase(responsibilityLoaded, row.base);
        return [
          row.region,
          row.base,
          rmAreaForBase(responsibilityLoaded, row.base),
          responsibility.rm,
          officialRgmForRegion(row.region) ?? responsibility.rgm,
          row.origin,
          ...targetValues,
          row.toCollect > 0 ? row.onTimeRate : null,
          row.toCollect > 0 ? row.attemptRate : null,
          row.orders,
        ];
      });
      baseRows.push([
        "Total geral 总计",
        "—",
        "—",
        "—",
        "—",
        "—",
        ...targetValues,
        taxaSummary.toCollect > 0 ? taxaSummary.onTimeRate : null,
        taxaSummary.toCollect > 0 ? taxaSummary.collectionWithAttemptsRate : null,
        taxaSummary.orders,
      ]);

      const targetPercentageColumn = taxaAttemptTarget == null ? [] : [regionalCollectionRateColumn - 1];
      await downloadTaxaManagementExcel(
        [
          {
            name: "RGM",
            title: `${originLabel} 揽收及时率及尝试揽收率 / Taxa de coleta e tentativa — ${dateLabel.replaceAll("\n", " / ")}`,
            headers: ["Regional\n区域", "RGM\n区域负责人", ...targetColumns, "Taxa de coleta\n揽收及时率", "Taxa com tentativa\n尝试揽收率", "Total de pedidos\n总订单量"],
            rows: regionalRows,
            widths: [15, 40, ...(taxaAttemptTarget == null ? [] : [12]), 18, 20, 20],
            percentageColumns: [...targetPercentageColumn, regionalCollectionRateColumn, regionalPerformanceColumn],
            performanceColumn: regionalPerformanceColumn,
            targetRate: taxaAttemptTarget,
          },
          {
            name: "RM",
            title: `${originLabel} 揽收及时率及尝试揽收率 / Taxa de coleta e tentativa - POC% — ${dateLabel.replaceAll("\n", " / ")}`,
            headers: ["Região do RM\nRM区域", "Responsável do RM\nRM负责人", "RGM\n区域负责人", ...targetColumns, "Taxa de coleta\n揽收及时率", "Taxa com tentativa\n尝试揽收率", "Total de pedidos\n总订单量"],
            rows: rmRows,
            widths: [18, 42, 38, ...(taxaAttemptTarget == null ? [] : [12]), 18, 20, 20],
            percentageColumns: [...(taxaAttemptTarget == null ? [] : [rmCollectionRateColumn - 1]), rmCollectionRateColumn, rmPerformanceColumn],
            performanceColumn: rmPerformanceColumn,
            targetRate: taxaAttemptTarget,
          },
          {
            name: "Bases",
            title: `${originLabel} 网点揽收表现 / Detalhamento por bases — ${dateLabel.replaceAll("\n", " / ")}`,
            headers: ["Regional\n区域", "Base\n网点", "Região do RM\nRM区域", "RM\nRM负责人", "RGM\n区域负责人", "Origem\n订单来源", ...targetColumns, "Taxa de coleta\n揽收及时率", "Taxa com tentativa\n尝试揽收率", "Total de pedidos\n总订单量"],
            rows: baseRows,
            widths: [14, 24, 18, 38, 36, 16, ...(taxaAttemptTarget == null ? [] : [12]), 18, 20, 20],
            percentageColumns: [...(taxaAttemptTarget == null ? [] : [baseCollectionRateColumn - 1]), baseCollectionRateColumn, basePerformanceColumn],
            performanceColumn: basePerformanceColumn,
            targetRate: taxaAttemptTarget,
          },
        ],
        `taxa_de_coleta_gerencial_${taxaDateStart || "inicio"}_${taxaDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [language, responsibilityLoaded, taxaAttemptTarget, taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaSelectedOrigins, taxaSummary, taxaTableRows, t]);

  const downloadTaxaRegionalPocExcel = downloadTaxaManagementWorkbook;
  const downloadTaxaRmPocExcel = downloadTaxaManagementWorkbook;
  const downloadTaxaTableExcel = downloadTaxaManagementWorkbook;

  const movementBaseOptions = useMemo(() => {
    if (!movementLoaded) return [];
    return movementBasesForRegions(movementLoaded, movementSelectedRegions, responsibilityLoaded).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
  }, [movementLoaded, movementSelectedRegions, responsibilityLoaded, selectedRgms, selectedRms]);

  const movementRmAreaOptions = useMemo(
    () => responsibilityOptions(responsibilityLoaded, movementBaseOptions).rmAreas,
    [movementBaseOptions, responsibilityLoaded],
  );

  const movementFilteredRecords = useMemo(() => {
    if (!movementLoaded) return [];
    return movementLoaded.records.map((record) => movementLoaded.format === "summary" ? selectMovementSummaryMetric(record, movementSummaryMetric) : record).map((record) => ({
      ...record,
      region: registeredRegionForBase(responsibilityLoaded, record.base, record.region),
    })).filter(
      (record) =>
        movementSelectedRegions.has(record.region) &&
        movementSelectedBases.has(record.base) &&
        matchesResponsibility(responsibilityLoaded, record.base, selectedRms, selectedRgms) &&
        movementSelectedRmAreas.has(rmAreaForBase(responsibilityLoaded, record.base)) &&
        movementSelectedAgings.has(record.aging) &&
        movementSelectedStatuses.has(record.status) &&
        movementSelectedOrigins.has(record.origin) &&
        (!record.date || !movementDateStart || record.date >= movementDateStart) &&
        (!record.date || !movementDateEnd || record.date <= movementDateEnd),
    );
  }, [movementDateEnd, movementDateStart, movementLoaded, movementSummaryMetric, movementSelectedAgings, movementSelectedBases, movementSelectedOrigins, movementSelectedRegions, movementSelectedRmAreas, movementSelectedStatuses, responsibilityLoaded, selectedRgms, selectedRms]);

  const movementSummary = useMemo(() => {
    const totalStopped = movementFilteredRecords.reduce((sum, record) => sum + record.totalStopped, 0);
    const inTransit = movementFilteredRecords.reduce((sum, record) => sum + record.inTransit, 0);
    const over2Days = movementFilteredRecords.reduce((sum, record) => sum + movementFrom2DaysTotal(record), 0);
    const over14Days = movementFilteredRecords.reduce((sum, record) => sum + record.over14Days, 0);
    const over30Days = movementFilteredRecords.reduce((sum, record) => sum + record.over30Days, 0);
    const criticalBases = new Set(movementFilteredRecords.filter((record) => movementFrom2DaysTotal(record) > 0).map((record) => record.base)).size;
    const activeRegions = new Set(movementFilteredRecords.map((record) => record.region)).size;
    const topRegion = [...movementFilteredRecords.reduce((map, record) => {
      const current = map.get(record.region) ?? 0;
      map.set(record.region, current + movementFrom2DaysTotal(record));
      return map;
    }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"))[0];

    return {
      totalStopped,
      inTransit,
      over2Days,
      over14Days,
      over30Days,
      criticalBases,
      activeRegions,
      over2Rate: safeRate(over2Days, totalStopped),
      topRegion,
    };
  }, [movementFilteredRecords]);

  const movementAnalysisText = useMemo(() => {
    const regionals = new Map<string, { region: string; volume: number; bases: Map<string, { base: string; rm: string; volume: number }> }>();
    for (const record of movementFilteredRecords) {
      const volume = record.totalStopped > 0 ? record.totalStopped : record.quantity;
      const regional = regionals.get(record.region) ?? { region: record.region, volume: 0, bases: new Map() };
      regional.volume += volume;
      const base = regional.bases.get(record.base) ?? { base: record.base, rm: responsibilityForBase(responsibilityLoaded, record.base).rm, volume: 0 };
      base.volume += volume;
      regional.bases.set(record.base, base);
      regionals.set(record.region, regional);
    }
    const priorities = [...regionals.values()].map((regional) => ({ ...regional, bases: [...regional.bases.values()].filter((base) => base.volume > 100).sort((left, right) => right.volume - left.volume).slice(0, 5) }))
      .filter((regional) => regional.bases.length > 0).sort((left, right) => right.volume - left.volume || left.region.localeCompare(right.region, "pt-BR")).slice(0, 5);
    const selectedDate = movementDateEnd || movementDateStart;
    const [, month, day] = selectedDate.split("-");
    const messageDate = day && month ? `${day}/${month}` : selectedDate || "período selecionado";
    return [
      "Bom dia, pessoal!", "大家早上好！", "", `📊 **Sem movimentação ${messageDate} | 无流转**`,
      `Geral: **${formatNumber(movementSummary.totalStopped)} pacotes**`, `整体：**${formatNumber(movementSummary.totalStopped)}单**`,
      "", "⚠️ **Pontos críticos / 重点关注**", "",
      ...(priorities.length ? priorities.flatMap((regional) => [
        `🔴 **${regional.region} ${formatNumber(regional.volume)} pacotes**`,
        ...regional.bases.map((base) => { const rm = base.rm.trim() || "待定"; return `${base.base} **${formatNumber(base.volume)} pacotes** | ${rm.startsWith("@") ? rm : `@${rm}`}`; }), "",
      ]) : ["Nenhuma base acima de 100 pacotes sem movimentação no recorte selecionado.", ""]),
      "⚠️ **Prioridade hoje: tratar as bases com maior volume sem movimentação.**", "⚠️ **今日重点：优先处理无流转订单量大的网点。**", "",
      "Contamos com a atuação dos responsáveis.", "请各负责人重点跟进改善。",
    ].join("\n");
  }, [movementDateEnd, movementDateStart, movementFilteredRecords, movementSummary.totalStopped, responsibilityLoaded]);
  const movementRegionalOver2Summary = useMemo(() => {
    const groups = new Map<string, { region: string; rgm: string; over2Days: number; orders: number }>();
    for (const record of movementFilteredRecords) {
      const current =
        groups.get(record.region) ??
        { region: record.region, rgm: officialRgmForRegion(record.region) ?? UNASSIGNED_RGM, over2Days: 0, orders: 0 };
      current.over2Days += movementFrom2DaysTotal(record);
      current.orders += record.totalStopped;
      groups.set(record.region, current);
    }
    return [...groups.values()]
      .sort((a, b) => b.orders - a.orders || a.region.localeCompare(b.region, dashboardLocale(language), { numeric: true }));
  }, [language, movementFilteredRecords]);

  const movementRmOver2Summary = useMemo(() => {
    const groups = new Map<string, { rmArea: string; rm: string; rgm: string; over2Days: number; orders: number }>();
    for (const record of movementFilteredRecords) {
      const responsibility = responsibilityForBase(responsibilityLoaded, record.base);
      const rmArea = rmAreaForBase(responsibilityLoaded, record.base);
      const key = `${rmArea}::${responsibility.rm}::${responsibility.rgm}`;
      const current = groups.get(key) ?? { rmArea, rm: responsibility.rm, rgm: responsibility.rgm, over2Days: 0, orders: 0 };
      current.over2Days += movementFrom2DaysTotal(record);
      current.orders += record.totalStopped;
      groups.set(key, current);
    }
    return [...groups.values()]
      .sort((a, b) => b.orders - a.orders || a.rmArea.localeCompare(b.rmArea, dashboardLocale(language), { numeric: true }) || a.rm.localeCompare(b.rm, dashboardLocale(language), { numeric: true }));
  }, [language, movementFilteredRecords, responsibilityLoaded]);

  const movementTableRows = useMemo(() => {
    const normalizedQuery = normalizeSearchText(movementTableQuery.trim());
    return movementFilteredRecords
      .filter((record) => {
        if (!normalizedQuery) return true;
        return normalizeSearchText(`${record.base} ${record.region} ${record.code}`).includes(normalizedQuery);
      })
      .sort((a, b) => b.totalStopped - a.totalStopped || a.base.localeCompare(b.base, "pt-BR", { numeric: true }));
  }, [movementFilteredRecords, movementTableQuery]);

  const movementConsolidatedRows = useMemo(() => {
    const groups = new Map<string, { period: string; region: string; base: string; code: string; rmArea: string; rm: string; rgm: string; aging: string; status: string; origin: string; orders: number }>();
    for (const record of movementTableRows) {
      const responsibility = responsibilityForBase(responsibilityLoaded, record.base);
      const rmArea = rmAreaForBase(responsibilityLoaded, record.base);
      const key = [record.region, record.base, record.code, responsibility.rm, responsibility.rgm, record.aging, record.status, record.origin].join("::");
      const current = groups.get(key) ?? {
        period: movementDateStart && movementDateEnd ? `${formatDate(movementDateStart)} a ${formatDate(movementDateEnd)}` : "Todo o período",
        region: record.region,
        base: record.base,
        code: record.code,
        rmArea,
        rm: responsibility.rm,
        rgm: officialRgmForRegion(record.region) ?? responsibility.rgm,
        aging: record.aging,
        status: record.status,
        origin: record.origin,
        orders: 0,
      };
      current.orders += record.quantity;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => b.orders - a.orders || a.region.localeCompare(b.region, dashboardLocale(language), { numeric: true }) || a.base.localeCompare(b.base, dashboardLocale(language), { numeric: true }));
  }, [language, movementDateEnd, movementDateStart, movementTableRows, responsibilityLoaded]);

  const sellerBaseOptions = useMemo(() => {
    if (!sellerPerformanceLoaded) return [];
    return sellerBasesForRegions(sellerPerformanceLoaded, sellerSelectedRegions, responsibilityLoaded).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
  }, [responsibilityLoaded, selectedRgms, selectedRms, sellerPerformanceLoaded, sellerSelectedRegions]);

  const sellerOptionList = useMemo(() => {
    if (!sellerPerformanceLoaded) return [];
    return sellerOptionsForFilters(sellerPerformanceLoaded, sellerSelectedRegions, sellerSelectedBases, sellerSelectedTiers, responsibilityLoaded);
  }, [responsibilityLoaded, sellerPerformanceLoaded, sellerSelectedBases, sellerSelectedRegions, sellerSelectedTiers]);

  const applyResponsibilityFilter = useCallback((kind: "rm" | "rgm", value: Set<string>) => {
    const nextRms = kind === "rm" ? value : selectedRms;
    const nextRgms = kind === "rgm" ? value : selectedRgms;
    if (kind === "rm") setSelectedRms(value);
    else setSelectedRgms(value);

    if (loaded) {
      setSelectedBases(new Set(basesForRegions(loaded, selectedRegions, responsibilityLoaded).filter((base) =>
        matchesResponsibility(responsibilityLoaded, base, nextRms, nextRgms))));
      setPage(1);
    }
    if (taxaLoaded) {
      const bases = taxaBasesForRegions(taxaLoaded, taxaSelectedRegions, responsibilityLoaded).filter((base) =>
        matchesResponsibility(responsibilityLoaded, base, nextRms, nextRgms));
      setTaxaSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, bases).rmAreas));
      setTaxaSelectedBases(new Set(bases));
      setTaxaPage(1);
    }
    if (movementLoaded) {
      const bases = movementBasesForRegions(movementLoaded, movementSelectedRegions, responsibilityLoaded).filter((base) =>
        matchesResponsibility(responsibilityLoaded, base, nextRms, nextRgms));
      setMovementSelectedBases(new Set(bases));
      setMovementSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, bases).rmAreas));
      setMovementPage(1);
    }
    if (sellerPerformanceLoaded) {
      const bases = new Set(sellerBasesForRegions(sellerPerformanceLoaded, sellerSelectedRegions, responsibilityLoaded).filter((base) =>
        matchesResponsibility(responsibilityLoaded, base, nextRms, nextRgms)));
      setSellerSelectedBases(bases);
      setSellerSelectedSellers(new Set(sellerOptionsForFilters(
        sellerPerformanceLoaded,
        sellerSelectedRegions,
        bases,
        sellerSelectedTiers,
        responsibilityLoaded,
      )));
      setSellerPage(1);
    }
  }, [
    loaded,
    movementLoaded,
    movementSelectedRegions,
    responsibilityLoaded,
    selectedRegions,
    selectedRgms,
    selectedRms,
    sellerPerformanceLoaded,
    sellerSelectedRegions,
    sellerSelectedTiers,
    taxaLoaded,
    taxaSelectedRegions,
  ]);

  const sellerNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of sellerPerformanceLoaded?.records ?? []) {
      if (!map.has(record.sellerCode) || map.get(record.sellerCode) === "Sem loja") {
        map.set(record.sellerCode, record.sellerName);
      }
    }
    return map;
  }, [sellerPerformanceLoaded]);

  const sellerOptionLabel = useCallback(
    (sellerCode: string) => `${sellerNameByCode.get(sellerCode) ?? "Seller"} · ${sellerCode}`,
    [sellerNameByCode],
  );

  const sellerFilteredRecords = useMemo(() => {
    if (!sellerPerformanceLoaded || !sellerDateStart || !sellerDateEnd || sellerDateStart > sellerDateEnd) return [];
    const normalizedCode = normalizeSearchText(sellerCodeQuery.trim());
    return sellerPerformanceLoaded.records.map((record) => ({
      ...record,
      region: registeredRegionForBase(responsibilityLoaded, record.base, record.region),
      rm: responsibilityForBase(responsibilityLoaded, record.base).rm,
      rgm: responsibilityForBase(responsibilityLoaded, record.base).rgm,
    })).filter(
      (record) =>
        sellerSelectedRegions.has(record.region) &&
        sellerSelectedBases.has(record.base) &&
        sellerSelectedTiers.has(record.tier) &&
        sellerSelectedSellers.has(record.sellerCode) &&
        matchesResponsibility(responsibilityLoaded, record.base, selectedRms, selectedRgms) &&
        record.date >= sellerDateStart &&
        record.date <= sellerDateEnd &&
        (!normalizedCode || normalizeSearchText(record.sellerCode).includes(normalizedCode)),
    );
  }, [
    sellerCodeQuery,
    sellerPerformanceLoaded,
    sellerDateEnd,
    sellerDateStart,
    sellerSelectedBases,
    sellerSelectedRegions,
    sellerSelectedSellers,
    sellerSelectedTiers,
    responsibilityLoaded,
    selectedRgms,
    selectedRms,
  ]);

  const sellerSummary = useMemo(() => {
    const awaiting = sellerFilteredRecords.reduce((sum, record) => sum + record.awaiting, 0);
    const processed = sellerFilteredRecords.reduce((sum, record) => sum + record.processed, 0);
    const total = awaiting + processed;

    return {
      awaiting,
      processed,
      total,
      rate: safeRate(processed, total),
      activeRegions: new Set(sellerFilteredRecords.filter((record) => record.total > 0).map((record) => record.region)).size,
      activeBases: new Set(sellerFilteredRecords.filter((record) => record.total > 0).map((record) => record.base)).size,
    };
  }, [sellerFilteredRecords]);

  const sellerCategoryLabel = useMemo(() => {
    const categories = SELLER_CATEGORIES.filter((category) => sellerSelectedTiers.has(category)).map((category) => t(category));
    if (categories.length === 0) return t("Nenhuma categoria");
    return new Intl.ListFormat(dashboardLocale(language), {
      style: "long",
      type: "conjunction",
    }).format(categories);
  }, [language, sellerSelectedTiers, t]);

  const sellerPeriod = sellerPerformanceLoaded
    ? formatConsolidatedPeriod(sellerDateStart, sellerDateEnd)
    : "Período";
  const sellerRowsBySeller = useMemo(
    () => buildSellerReportRows(sellerFilteredRecords, "seller", sellerPeriod),
    [sellerFilteredRecords, sellerPeriod],
  );
  const sellerRowsByBase = useMemo(
    () => buildSellerReportRows(sellerFilteredRecords, "base", sellerPeriod),
    [sellerFilteredRecords, sellerPeriod],
  );
  const sellerRowsByRegional = useMemo(
    () => buildSellerReportRows(sellerFilteredRecords, "regional", sellerPeriod),
    [sellerFilteredRecords, sellerPeriod],
  );
  const sellerOutcomeSummary = useMemo(
    () => summarizeSellerOutcomes(sellerRowsBySeller),
    [sellerRowsBySeller],
  );
  const sellerReportRows = useMemo(() => {
    if (sellerReportMode === "base") return sellerRowsByBase;
    if (sellerReportMode === "regional") return sellerRowsByRegional;
    return sellerOutcomeFilter
      ? filterSellerRowsByOutcome(sellerRowsBySeller, sellerOutcomeFilter)
      : sellerRowsBySeller;
  }, [sellerOutcomeFilter, sellerReportMode, sellerRowsByBase, sellerRowsByRegional, sellerRowsBySeller]);
  const sellerTableRows = useMemo(
    () => sortSellerReportRowsByAwaiting(filterSellerReportRows(sellerReportRows, sellerTableQuery)),
    [sellerReportRows, sellerTableQuery],
  );
  const sellerAnalysisText = useMemo(() => {
    const bases = new Map<string, { base: string; rm: string; volume: number }>();
    for (const record of sellerFilteredRecords) {
      const current = bases.get(record.base) ?? {
        base: record.base,
        rm: responsibilityForBase(responsibilityLoaded, record.base).rm,
        volume: 0,
      };
      current.volume += record.total;
      bases.set(record.base, current);
    }
    const topBases = [...bases.values()]
      .sort((a, b) => b.volume - a.volume || a.base.localeCompare(b.base, "pt-BR", { numeric: true }))
      .slice(0, 5);
    const topSellers = sellerRowsBySeller.slice(0, 5);
    return [
      "Bom,",
      "",
      "Abaixo as top 5 bases com maior volume para coletar:",
      ...(topBases.length ? topBases.map((item, index) => `${index + 1}. **${item.base}** — ${formatNumber(item.volume)} pedidos | RM: ${item.rm || "Sem RM"}`) : ["Nenhuma base encontrada no recorte."]),
      "",
      "Os 5 sellers com maior volume:",
      ...(topSellers.length ? topSellers.map((item, index) => `${index + 1}. **${item.sellerName}** (${item.sellerCode}) — ${formatNumber(item.total)} pedidos | Regional: ${item.region} | Base: ${item.base} | RM: ${item.rmLabel}`) : ["Nenhum seller encontrado no recorte."]),
      "",
      "Por gentileza, seguir com prioridade na coleta para não gerar backlog para o dia seguinte.",
    ].join("\n");
  }, [responsibilityLoaded, sellerFilteredRecords, sellerPeriod, sellerRowsBySeller]);
  const analysisText = view === "sellers" ? sellerAnalysisText : view === "movimentacao" ? movementAnalysisText : baseAnalysisText;

  const downloadMonitoringTableExcel = useCallback(async () => {
    if (tableRows.length === 0) return;
    try {
      const displayedMetrics = [...selectedMonitoringMetrics];
      const headers = [
        "Período\n周期",
        "Regional\n区域",
        "Base\n网点",
        "Origem do pedido\n订单来源",
        "RM\nRM负责人",
        "RGM\n区域负责人",
        ...displayedMetrics.map((metric) => `${metric}\n${t(metric)}`),
        "Total\n总计",
      ];
      const rows: ExcelExportValue[][] = tableRows.map((row) => [
        row.period,
        row.region,
        row.base,
        row.origin,
        responsibilityForBase(responsibilityLoaded, row.base).rm,
        responsibilityForBase(responsibilityLoaded, row.base).rgm,
        ...displayedMetrics.map((metric) => monitoringMetricValueFromMap(row.values, loaded?.statuses ?? [], metric)),
        row.total,
      ]);
      rows.push([
        "Total geral\n总计",
        "",
        "",
        "",
        "",
        "",
        ...displayedMetrics.map((metric) => tableRows.reduce(
          (sum, row) => sum + monitoringMetricValueFromMap(row.values, loaded?.statuses ?? [], metric),
          0,
        )),
        tableRows.reduce((sum, row) => sum + row.total, 0),
      ]);

      const regionalRows: ExcelExportValue[][] = monitoringRegionalSummary.map((row) => [
        row.region, row.rgm, row.period, row.orderVolume, row.awaiting, row.collected,
        monitoringCollectionRate(row), monitoringAwaitingRate(row),
      ]);
      regionalRows.push([
        "Total geral 总计", "—", monitoringSummaryPeriod, monitoringSummaryMetrics.orderVolume,
        monitoringSummaryMetrics.awaiting, monitoringSummaryMetrics.collected,
        monitoringCollectionRate(monitoringSummaryMetrics), monitoringAwaitingRate(monitoringSummaryMetrics),
      ]);
      const rmRows: ExcelExportValue[][] = monitoringRmSummary.map((row) => [
        row.rmArea, row.rm, row.rgm, row.period, row.orderVolume, row.awaiting, row.collected,
        monitoringCollectionRate(row), monitoringAwaitingRate(row),
      ]);
      rmRows.push([
        "Total geral 总计", "—", "—", monitoringSummaryPeriod, monitoringSummaryMetrics.orderVolume,
        monitoringSummaryMetrics.awaiting, monitoringSummaryMetrics.collected,
        monitoringCollectionRate(monitoringSummaryMetrics), monitoringAwaitingRate(monitoringSummaryMetrics),
      ]);

      await downloadTaxaManagementExcel(
        [
          {
            name: "Regional 区域",
            title: `Monitoramento de coleta / 揽收监控 — ${monitoringSummaryPeriod}`,
            headers: ["Regional\n区域", "RGM\n区域负责人", "Período\n周期", "Previsto a coletar\n待揽收", "Aguardando coleta\n待揽收订单", "Coletado\n已揽收", "Taxa de coleta\n揽收率", "Pedidos aguardando\n待揽收占比"],
            rows: regionalRows, widths: [16, 36, 24, 20, 20, 20, 18, 24], percentageColumns: [6, 7], performanceColumn: -1, targetRate: null,
          },
          {
            name: "RM 负责人",
            title: `Monitoramento de coleta / 揽收监控 — ${monitoringSummaryPeriod}`,
            headers: ["Região do RM\nRM区域", "Responsável do RM\nRM负责人", "RGM\n区域负责人", "Período\n周期", "Previsto a coletar\n待揽收", "Aguardando coleta\n待揽收订单", "Coletado\n已揽收", "Taxa de coleta\n揽收率", "Pedidos aguardando\n待揽收占比"],
            rows: rmRows, widths: [20, 42, 36, 24, 20, 20, 20, 18, 24], percentageColumns: [7, 8], performanceColumn: -1, targetRate: null,
          },
          {
            name: "Bases 网点",
            title: `Monitoramento de coleta / 揽收监控 — ${monitoringSummaryPeriod}`,
            headers, rows, widths: [24, 14, 24, 20, 30, 30, ...displayedMetrics.map(() => 22), 15], percentageColumns: [], performanceColumn: -1, targetRate: null, totalMergeEndColumn: 5,
          },
        ],
        `monitoramento_de_coleta_${dateStart || "inicio"}_${dateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [dateEnd, dateStart, loaded, monitoringRegionalSummary, monitoringRmSummary, monitoringSummaryMetrics, monitoringSummaryPeriod, responsibilityLoaded, selectedMonitoringMetrics, t, tableRows]);

  const downloadMonitoringRegionalSummaryExcel = useCallback(async () => {
    if (monitoringRegionalSummary.length === 0) return;
    try {
      const rows: ExcelExportValue[][] = monitoringRegionalSummary.map((row) => [
        t(row.region),
        t(row.rgm),
        row.period,
        row.orderVolume,
        row.awaiting,
        row.collected,
        monitoringCollectionRate(row),
        monitoringAwaitingRate(row),
      ]);
      rows.push([
        t("Total geral"),
        "—",
        monitoringSummaryPeriod,
        monitoringSummaryMetrics.orderVolume,
        monitoringSummaryMetrics.awaiting,
        monitoringSummaryMetrics.collected,
        monitoringCollectionRate(monitoringSummaryMetrics),
        monitoringAwaitingRate(monitoringSummaryMetrics),
      ]);

      await downloadTaxaManagementExcel(
        [{
          name: t("Monitoramento por regional"),
          title: `${t("Monitoramento por regional")} — ${monitoringSummaryPeriod}`,
          headers: [
            t("Regional"),
            "RGM",
            t("Período"),
            t("Previsto a coletar"),
            t("Aguardando coleta"),
            t("Coletado"),
            t("Taxa de coleta"),
            t("Taxa de pedidos aguardando coleta"),
          ],
          rows,
          widths: [16, 36, 24, 20, 20, 20, 18, 24],
          percentageColumns: [6, 7],
          performanceColumn: -1,
          targetRate: null,
        }],
        `monitoramento_status_por_regional_${monitoringSummaryDates[0] ?? "inicio"}_${monitoringSummaryDates[monitoringSummaryDates.length - 1] ?? "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [monitoringRegionalSummary, monitoringSummaryDates, monitoringSummaryMetrics, monitoringSummaryPeriod, t]);

  const downloadMonitoringRmSummaryExcel = useCallback(async () => {
    if (monitoringRmSummary.length === 0) return;
    try {
      const rows: ExcelExportValue[][] = monitoringRmSummary.map((row) => [
        t(row.rmArea),
        t(row.rm),
        t(row.rgm),
        row.period,
        row.orderVolume,
        row.awaiting,
        row.collected,
        monitoringCollectionRate(row),
        monitoringAwaitingRate(row),
      ]);
      rows.push([
        t("Total geral"),
        "—",
        "—",
        monitoringSummaryPeriod,
        monitoringSummaryMetrics.orderVolume,
        monitoringSummaryMetrics.awaiting,
        monitoringSummaryMetrics.collected,
        monitoringCollectionRate(monitoringSummaryMetrics),
        monitoringAwaitingRate(monitoringSummaryMetrics),
      ]);

      await downloadTaxaManagementExcel(
        [{
          name: t("Monitoramento por RM"),
          title: `${t("Monitoramento por RM")} — ${monitoringSummaryPeriod}`,
          headers: [
            t("Região do RM"),
            t("Responsável do RM"),
            "RGM",
            t("Período"),
            t("Previsto a coletar"),
            t("Aguardando coleta"),
            t("Coletado"),
            t("Taxa de coleta"),
            t("Taxa de pedidos aguardando coleta"),
          ],
          rows,
          widths: [20, 42, 36, 24, 20, 20, 20, 18, 24],
          percentageColumns: [7, 8],
          performanceColumn: -1,
          targetRate: null,
        }],
        `monitoramento_status_por_rm_${monitoringSummaryDates[0] ?? "inicio"}_${monitoringSummaryDates[monitoringSummaryDates.length - 1] ?? "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [monitoringRmSummary, monitoringSummaryDates, monitoringSummaryMetrics, monitoringSummaryPeriod, t]);

  const downloadMovementTableExcel = useCallback(async () => {
    if (!movementLoaded || movementTableRows.length === 0) return;
    try {
      const period = movementLoaded.format === "summary" ? t(MOVEMENT_SUMMARY_METRICS.find(([key]) => key === movementSummaryMetric)?.[1] ?? "Total sem movimentação") : movementDateStart && movementDateEnd
        ? `${formatDate(movementDateStart)} a ${formatDate(movementDateEnd)}`
        : t("Todo o período");
      const summaryFormat = movementLoaded.format === "summary";
      const consolidatedHeaders = summaryFormat ? [t("Regional"), t("Base"), t("Código da base"), t("Região do RM"), "RM", "RGM", t("Total sem movimentação")] : [
        t("Período"), t("Regional"), t("Base"), t("Código da base"), t("Região do RM"),
        "RM", "RGM", "AGING", t("Status"), t("Origem do pedido"), t("Total de pedidos sem movimentação"),
      ];
      const consolidatedRows: ExcelExportValue[][] = movementConsolidatedRows.map((row) => summaryFormat ? [row.region, row.base, row.code, row.rmArea, row.rm, row.rgm, row.orders] : [
        row.period, row.region, row.base, row.code, row.rmArea, row.rm, row.rgm,
        row.aging, row.status, row.origin, row.orders,
      ]);
      consolidatedRows.push([t("Total geral"), ...Array.from({length: consolidatedHeaders.length - 2}, () => ""), movementTableRows.reduce((sum, row) => sum + row.quantity, 0)]);

      const detailHeaders = [
        ...movementLoaded.displayColumns.map((column) => t(column)),
        t("Regional consolidada"), t("Base responsável"), t("Região do RM"), "RM", "RGM",
        t("Total de pedidos sem movimentação"),
      ];
      const detailRows: ExcelExportValue[][] = movementTableRows.map((row) => {
        const responsibility = responsibilityForBase(responsibilityLoaded, row.base);
        return [
          ...movementLoaded.displayColumns.map((column) => row.values[column] as ExcelExportValue),
          row.region,
          row.base,
          rmAreaForBase(responsibilityLoaded, row.base),
          responsibility.rm,
          officialRgmForRegion(row.region) ?? responsibility.rgm,
          row.quantity,
        ];
      });
      detailRows.push([t("Total geral"), ...Array.from({ length: detailHeaders.length - 2 }, () => ""), movementTableRows.reduce((sum, row) => sum + row.quantity, 0)]);

      await downloadTaxaManagementExcel(
        [
          {
            name: "Regional 区域",
            title: `${t("Sem movimentação")} / 无流转 — ${period}`,
            headers: ["Regional\n区域", "RGM\n区域负责人", "Total sem movimentação\n无流转订单量"],
            rows: [
              ...movementRegionalOver2Summary.map((row) => [row.region, row.rgm, row.orders]),
              ["Total geral 总计", "", movementSummary.totalStopped],
            ],
            widths: [20, 48, 28], percentageColumns: [], performanceColumn: -1, targetRate: null, totalMergeEndColumn: 1,
          },
          {
            name: "RM 负责人",
            title: `${t("Sem movimentação")} / 无流转 — ${period}`,
            headers: ["Região do RM\nRM区域", "Responsável do RM\nRM负责人", "RGM\n区域负责人", "Total sem movimentação\n无流转订单量"],
            rows: [
              ...movementRmOver2Summary.map((row) => [row.rmArea, row.rm, row.rgm, row.orders]),
              ["Total geral 总计", "", "", movementSummary.totalStopped],
            ],
            widths: [22, 44, 44, 28], percentageColumns: [], performanceColumn: -1, targetRate: null, totalMergeEndColumn: 2,
          },
          {
            name: "Bases 网点",
            title: `${t("Sem movimentação")} / 无流转 — ${period}`,
            headers: consolidatedHeaders.map((header) => `${header}\n${header === t("Regional") ? "区域" : header === t("Base") ? "网点" : header === t("Total sem movimentação") ? "无流转订单量" : header}`),
            rows: consolidatedRows,
            widths: summaryFormat ? [18, 28, 20, 22, 40, 40, 28] : [24, 14, 28, 18, 18, 34, 34, 28, 34, 18, 26],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: consolidatedHeaders.length - 2,
          },
          {
            name: "Detalhamento 明细",
            title: `${t("Dados por base")} / 网点明细 — ${period}`,
            headers: detailHeaders.map((header) => `${header}\n${header}`),
            rows: detailRows,
            widths: [
              ...movementLoaded.displayColumns.map((column) =>
                /remessa|código|codigo|pedidos/i.test(column) ? 18 : /nome|operação|operacao|responsável|responsavel/i.test(column) ? 28 : 20),
              18, 28, 18, 34, 34, 26,
            ],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: detailHeaders.length - 2,
          },
        ],
        summaryFormat ? "sem_movimentacao_resumo_atual.xlsx" : `sem_movimentacao_consolidado_${movementDateStart || "inicio"}_${movementDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [movementConsolidatedRows, movementDateEnd, movementDateStart, movementLoaded, movementRegionalOver2Summary, movementRmOver2Summary, movementSummary.totalStopped, movementSummaryMetric, movementTableRows, responsibilityLoaded, t]);

  const downloadMovementRegionalOver2Excel = useCallback(async () => {
    if (movementRegionalOver2Summary.length === 0) return;
    try {
      const context = movementLoaded?.format === "summary"
        ? t(MOVEMENT_SUMMARY_METRICS.find(([key]) => key === movementSummaryMetric)?.[1] ?? "Total sem movimentação")
        : movementDateStart && movementDateEnd ? `${formatDate(movementDateStart)} a ${formatDate(movementDateEnd)}` : t("Todo o período");
      const filterContext = movementLoaded?.format === "summary" ? context : `${context} · AGING: ${[...movementSelectedAgings].join(", ")} · ${t("Status")}: ${[...movementSelectedStatuses].join(", ")}`;
      await downloadTaxaManagementExcel([{
        name: t("Sem movimentação por regional"),
        title: `${t("Sem movimentação por regional")} / 区域无流转 — ${filterContext}`,
        headers: [t("Regional"), "RGM", t("Total sem movimentação")],
        rows: [...movementRegionalOver2Summary.map((row) => [row.region, row.rgm, row.orders]),
          [t("Total geral"), "", movementSummary.totalStopped]],
        widths: [20, 48, 28], percentageColumns: [], performanceColumn: -1, targetRate: null, totalMergeEndColumn: 1,
      }], "sem_movimentacao_por_rgm.xlsx");
    } catch { setError(t("Não foi possível gerar o arquivo Excel.")); }
  }, [movementDateEnd, movementDateStart, movementLoaded, movementRegionalOver2Summary, movementSummaryMetric, movementSummary.totalStopped, movementSelectedAgings, movementSelectedStatuses, t]);

  const downloadMovementRmOver2Excel = useCallback(async () => {
    if (movementRmOver2Summary.length === 0) return;
    try {
      const context = movementLoaded?.format === "summary"
        ? t(MOVEMENT_SUMMARY_METRICS.find(([key]) => key === movementSummaryMetric)?.[1] ?? "Total sem movimentação")
        : movementDateStart && movementDateEnd ? `${formatDate(movementDateStart)} a ${formatDate(movementDateEnd)}` : t("Todo o período");
      const filterContext = movementLoaded?.format === "summary" ? context : `${context} · AGING: ${[...movementSelectedAgings].join(", ")} · ${t("Status")}: ${[...movementSelectedStatuses].join(", ")}`;
      await downloadTaxaManagementExcel([{
        name: t("Sem movimentação por RM"),
        title: `${t("Sem movimentação por RM")} / RM 无流转 — ${filterContext}`,
        headers: [t("Região do RM"), t("Responsável do RM"), "RGM", t("Total sem movimentação")],
        rows: [...movementRmOver2Summary.map((row) => [row.rmArea, row.rm, row.rgm, row.orders]),
          [t("Total geral"), "", "", movementSummary.totalStopped]],
        widths: [22, 44, 44, 28], percentageColumns: [], performanceColumn: -1, targetRate: null, totalMergeEndColumn: 2,
      }], "sem_movimentacao_por_rm.xlsx");
    } catch { setError(t("Não foi possível gerar o arquivo Excel.")); }
  }, [movementDateEnd, movementDateStart, movementLoaded, movementRmOver2Summary, movementSummaryMetric, movementSummary.totalStopped, movementSelectedAgings, movementSelectedStatuses, t]);

  const downloadSellerTableExcel = useCallback(async () => {
    if (sellerTableRows.length === 0) return;
    try {
      const columns: ExcelExportColumn<SellerReportRow>[] = [
        { header: t("Período"), value: (row) => row.period, width: 24 },
        { header: t("Categoria"), value: (row) => row.tierLabel, width: 12 },
        { header: t("Regional"), value: (row) => row.region, width: 16 },
        {
          header: t(sellerReportMode === "regional" ? "Bases" : "Base"),
          value: (row) => sellerReportMode === "regional" ? row.baseCount : row.base,
          width: 24,
        },
        { header: "RM", value: (row) => row.rmLabel, width: 30 },
        { header: "RGM", value: (row) => row.rgmLabel, width: 36 },
      ];
      if (sellerReportMode === "seller") {
        columns.push(
          { header: t("Seller"), value: (row) => row.sellerName, width: 28 },
          { header: t("Código seller"), value: (row) => row.sellerCode, width: 24 },
          { header: t("Origem"), value: (row) => row.originLabel, width: 22 },
        );
      } else {
        columns.push({ header: t("Sellers"), value: (row) => row.sellerCount, width: 14 });
      }
      columns.push(
        { header: t("Aguardando coleta"), value: (row) => row.awaiting, width: 20 },
        { header: t("Processados"), value: (row) => row.processed, width: 16 },
        { header: t("Total"), value: (row) => row.total, width: 15 },
        { header: t("% processamento"), value: (row) => row.rate, width: 19, numberFormat: "0.0%" },
      );
      await downloadRowsAsExcel(
        sellerTableRows,
        columns,
        t("Processamento por {mode}", {
          mode: t(sellerReportMode === "seller" ? "Seller" : sellerReportMode === "base" ? "Base" : "Regional"),
        }),
        `t4_t5_${sellerReportMode}_${sellerDateStart || "inicio"}_${sellerDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [sellerDateEnd, sellerDateStart, sellerReportMode, sellerTableRows, t]);

  const sellerRegionalPerformance = useMemo(
    () => sellerRowsByRegional
      .filter((row) => row.total > 0)
      .sort((left, right) =>
        right.rate - left.rate ||
        right.total - left.total ||
        left.region.localeCompare(right.region, dashboardLocale(language), { numeric: true }),
      ),
    [language, sellerRowsByRegional],
  );
  const downloadSellerRegionalPerformanceExcel = useCallback(async () => {
    if (sellerRegionalPerformance.length === 0) return;
    try {
      const periodLabel = formatSellerExcelPeriod(sellerDateStart, sellerDateEnd);
      const rows: ExcelExportValue[][] = sellerRegionalPerformance.map((row) => [
        row.region,
        row.rgmLabel,
        row.awaiting,
        row.processed,
        row.total,
        row.rate,
      ]);
      rows.push([
        "TOTAL 总计",
        "",
        sellerSummary.awaiting,
        sellerSummary.processed,
        sellerSummary.total,
        sellerSummary.rate,
      ]);
      await downloadTaxaManagementExcel(
        [{
          name: "Relatório regional",
          title: `Monitoramento ${sellerCategoryLabel} - ${periodLabel}\nJ&T重点保障及单商多服监控 –`,
          headers: [
            "区域（Regional）",
            "RGM\n区域负责人",
            "Aguardando coleta\n待揽收订单量",
            "Volume coletado\n已揽收量",
            "Volume Total\n总订单量",
            "揽收率\n%",
          ],
          rows,
          widths: [20, 42, 21, 18, 18, 14],
          percentageColumns: [5],
          performanceColumn: 5,
          targetRate: SELLER_REGIONAL_RATE_TARGET,
          totalMergeEndColumn: 1,
        }],
        `relatorio_diario_t4_t5_${periodLabel.replaceAll(" ", "_")}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [sellerCategoryLabel, sellerDateEnd, sellerDateStart, sellerRegionalPerformance, sellerSummary, t]);
  const sellerRmAwaitingSummary = useMemo(
    () => summarizeAwaitingByBaseAndRm(sellerFilteredRecords),
    [sellerFilteredRecords],
  );
  const downloadSellerRmAwaitingExcel = useCallback(async () => {
    if (sellerRmAwaitingSummary.length === 0) return;

    try {
      const periodLabel = formatSellerExcelPeriod(sellerDateStart, sellerDateEnd);
      const rows: ExcelExportValue[][] = sellerRmAwaitingSummary.map((row) => [
        row.base,
        row.rm,
        responsibilityForBase(responsibilityLoaded, row.base).rgm,
        row.total,
        row.awaiting,
        row.processed,
        row.rate,
      ]);
      rows.push([
        "TOTAL 总计",
        "",
        "",
        sellerSummary.total,
        sellerSummary.awaiting,
        sellerSummary.processed,
        sellerSummary.rate,
      ]);
      await downloadTaxaManagementExcel(
        [{
          name: "Aguardando por base",
          title: `Monitoramento ${sellerCategoryLabel} - ${periodLabel}\nJ&T重点保障及单商多服监控 –`,
          headers: [
            "网点（Base）",
            "RM\nRM负责人",
            "RGM\n区域负责人",
            "Volume de pedidos\n总订单量",
            "Aguardando coleta\n待揽收订单量",
            "Volume coletado\n已揽收量",
            "Taxa de coleta\n揽收率 %",
          ],
          rows,
          widths: [26, 42, 42, 18, 22, 18, 16],
          percentageColumns: [6],
          performanceColumn: 6,
          targetRate: SELLER_REGIONAL_RATE_TARGET,
          totalMergeEndColumn: 2,
        }],
        `aguardando_coleta_por_base_rm_${periodLabel.replaceAll(" ", "_")}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [responsibilityLoaded, sellerCategoryLabel, sellerDateEnd, sellerDateStart, sellerRmAwaitingSummary, sellerSummary, t]);

  const downloadSellerManagementExcel = useCallback(async () => {
    if (sellerTableRows.length === 0) return;
    try {
      const periodLabel = formatSellerExcelPeriod(sellerDateStart, sellerDateEnd);
      const regionalRows: ExcelExportValue[][] = sellerRegionalPerformance.map((row) => [row.region, row.rgmLabel, row.awaiting, row.processed, row.total, row.rate]);
      regionalRows.push(["Total geral 总计", "", sellerSummary.awaiting, sellerSummary.processed, sellerSummary.total, sellerSummary.rate]);
      const rmRows: ExcelExportValue[][] = sellerRmAwaitingSummary.map((row) => [
        row.base, row.rm, responsibilityForBase(responsibilityLoaded, row.base).rgm, row.total, row.awaiting, row.processed, row.rate,
      ]);
      rmRows.push(["Total geral 总计", "", "", sellerSummary.total, sellerSummary.awaiting, sellerSummary.processed, sellerSummary.rate]);
      const modeLabel = sellerReportMode === "regional" ? "Regionais 区域" : sellerReportMode === "base" ? "Bases 网点" : "Sellers 卖家";
      const detailRows: ExcelExportValue[][] = sellerTableRows.map((row) => [
        row.period, row.tierLabel, row.region, sellerReportMode === "regional" ? row.baseCount : row.base,
        row.rmLabel, row.sellerCount, row.sellerCode, row.awaiting, row.processed, row.total, row.rate,
      ]);
      detailRows.push(["Total geral 总计", "", "", "", "", "", "", sellerSummary.awaiting, sellerSummary.processed, sellerSummary.total, sellerSummary.rate]);

      await downloadTaxaManagementExcel([
        {
          name: "Regional 区域",
          title: `Monitoramento J&T / J&T重点保障及单商多服监控 — ${periodLabel}`,
          headers: ["Regional\n区域", "RGM\n区域负责人", "Aguardando coleta\n待揽收订单量", "Volume coletado\n已揽收量", "Volume total\n总订单量", "Taxa de coleta\n揽收率"],
          rows: regionalRows, widths: [20, 42, 21, 18, 18, 16], percentageColumns: [5], performanceColumn: 5, targetRate: SELLER_REGIONAL_RATE_TARGET, totalMergeEndColumn: 1,
        },
        {
          name: "Base e RM 网点",
          title: `Monitoramento J&T / J&T重点保障及单商多服监控 — ${periodLabel}`,
          headers: ["Base\n网点", "RM\nRM负责人", "RGM\n区域负责人", "Volume de pedidos\n总订单量", "Aguardando coleta\n待揽收订单量", "Volume coletado\n已揽收量", "Taxa de coleta\n揽收率"],
          rows: rmRows, widths: [26, 42, 42, 18, 22, 18, 16], percentageColumns: [6], performanceColumn: 6, targetRate: SELLER_REGIONAL_RATE_TARGET, totalMergeEndColumn: 2,
        },
        {
          name: modeLabel,
          title: `Monitoramento J&T / J&T重点保障及单商多服监控 — ${periodLabel}`,
          headers: ["Período\n周期", "Categoria\n分类", "Regional\n区域", sellerReportMode === "regional" ? "Bases\n网点数量" : "Base\n网点", "RM\nRM负责人", "Sellers\n卖家数量", "Código do seller\n卖家编码", "Aguardando coleta\n待揽收订单量", "Processados\n已处理", "Total\n总计", "Taxa de processamento\n处理率"],
          rows: detailRows, widths: [20, 16, 16, 24, 34, 16, 24, 22, 18, 18, 20], percentageColumns: [10], performanceColumn: 10, targetRate: SELLER_REGIONAL_RATE_TARGET, totalMergeEndColumn: 6,
        },
      ], `monitoramento_jt_${periodLabel.replaceAll(" ", "_")}.xlsx`);
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [responsibilityLoaded, sellerDateEnd, sellerDateStart, sellerRegionalPerformance, sellerReportMode, sellerRmAwaitingSummary, sellerSummary, sellerTableRows, t]);
  const downloadBipagemBaseExcel = useCallback(async () => {
    if (bipagemBaseSummary.length === 0) return;
    try {
      await downloadRowsAsExcel(
        bipagemBaseSummary,
        [
          { header: t("Regional"), value: (row) => row.region, width: 14 },
          { header: t("Base"), value: (row) => row.base, width: 24 },
          { header: t("Código da base"), value: (row) => row.baseCode, width: 16 },
          { header: "RM", value: (row) => row.rm, width: 34 },
          { header: "RGM", value: (row) => responsibilityForBase(responsibilityLoaded, row.base).rgm, width: 36 },
          { header: t("Total de pedidos"), value: (row) => row.ordersToScan, width: 20 },
          { header: t("Pedidos não bipados"), value: (row) => row.notScannedCollection, width: 22 },
          { header: t("% falha na coleta PDD"), value: (row) => row.collectionFailureRate, width: 22, numberFormat: "0.0%" },
        ],
        t("Falta de bipagem por base e RM"),
        `falta_bipagem_base_rm_${bipagemDateStart || "inicio"}_${bipagemDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [bipagemBaseSummary, bipagemDateEnd, bipagemDateStart, responsibilityLoaded, t]);

  const downloadBipagemRegionalExcel = useCallback(async () => {
    if (bipagemRegionalSummary.length === 0) return;
    try {
      await downloadRowsAsExcel(
        bipagemRegionalSummary,
        [
          { header: t("Regional"), value: (row) => row.region, width: 14 },
          { header: "RGM", value: (row) => officialRgmForRegion(row.region) ?? UNASSIGNED_RGM, width: 36 },
          { header: t("Bases"), value: (row) => row.activeBases, width: 12 },
          { header: t("Total de pedidos"), value: (row) => row.ordersToScan, width: 20 },
          { header: t("Pedidos não bipados"), value: (row) => row.notScannedCollection, width: 22 },
          { header: t("% falha na coleta PDD"), value: (row) => row.collectionFailureRate, width: 22, numberFormat: "0.0%" },
        ],
        t("Resumo regional de falta de bipagem"),
        `falta_bipagem_regional_${bipagemDateStart || "inicio"}_${bipagemDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [bipagemDateEnd, bipagemDateStart, bipagemRegionalSummary, t]);
  const topSellersWithoutCollection = useMemo(
    () => sellerRowsBySeller
      .filter((row) => row.awaiting > 0 && row.processed === 0)
      .sort((left, right) =>
        right.awaiting - left.awaiting ||
        left.sellerName.localeCompare(right.sellerName, dashboardLocale(language), { numeric: true }),
      )
      .slice(0, 10),
    [language, sellerRowsBySeller],
  );
  const maxSellerAwaitingWithoutCollection = useMemo(
    () => Math.max(0, ...topSellersWithoutCollection.map((seller) => seller.awaiting)),
    [topSellersWithoutCollection],
  );

  const pageCount = Math.max(1, Math.ceil(tableRows.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const visibleTableRows = tableRows.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);
  const taxaPageCount = Math.max(1, Math.ceil(taxaTableRows.length / PAGE_SIZE));
  const taxaActivePage = Math.min(taxaPage, taxaPageCount);
  const visibleTaxaTableRows = taxaTableRows.slice((taxaActivePage - 1) * PAGE_SIZE, taxaActivePage * PAGE_SIZE);
  const movementPageCount = Math.max(1, Math.ceil(movementTableRows.length / PAGE_SIZE));
  const movementActivePage = Math.min(movementPage, movementPageCount);
  const visibleMovementTableRows = movementTableRows.slice((movementActivePage - 1) * PAGE_SIZE, movementActivePage * PAGE_SIZE);
  const sellerPageCount = Math.max(1, Math.ceil(sellerTableRows.length / PAGE_SIZE));
  const sellerActivePage = Math.min(sellerPage, sellerPageCount);
  const visibleSellerTableRows = sellerTableRows.slice((sellerActivePage - 1) * PAGE_SIZE, sellerActivePage * PAGE_SIZE);
  const selectedStatusList = useMemo(() => [...selectedMonitoringMetrics], [selectedMonitoringMetrics]);

  const maxRegional = Math.max(0, ...regionalSummaries.map((region) => region.total));
  const dateIsInvalid = Boolean(dateStart && dateEnd && dateStart > dateEnd);
  const responsibilityFiltersAreDefault =
    selectedRms.size === responsibilityFilterOptions.rms.length &&
    selectedRgms.size === responsibilityFilterOptions.rgms.length;
  const filtersAreDefault = Boolean(
    loaded &&
      selectedBases.size === baseOptions.length &&
      selectedRegions.size === monitoringRegionOptions.length &&
      selectedOrigins.size === loaded.origins.length &&
      selectedMonitoringMetrics.size === MONITORING_METRIC_OPTIONS.length &&
      responsibilityFiltersAreDefault &&
      dateStart === loaded.initialStart &&
      dateEnd === loaded.initialEnd,
  );
  const taxaDateIsInvalid = Boolean(taxaDateStart && taxaDateEnd && taxaDateStart > taxaDateEnd);
  const taxaMaximumSelectableEnd = taxaLoaded?.dates[taxaLoaded.dates.length - 1] ?? "";
  const taxaFiltersAreDefault = Boolean(
    taxaLoaded &&
      taxaSelectedBases.size === taxaBaseOptions.length &&
      taxaSelectedRegions.size === taxaRegionOptions.length &&
      taxaSelectedOrigins.size === taxaLoaded.origins.length &&
      taxaSelectedRmAreas.size === taxaRmAreaOptions.length &&
      responsibilityFiltersAreDefault &&
      taxaDateStart === taxaLoaded.initialStart &&
      taxaDateEnd === taxaLoaded.initialEnd,
  );
  const movementFiltersAreDefault = Boolean(
    movementSummaryMetric === "totalStopped" &&
    movementLoaded &&
      movementSelectedBases.size === movementBaseOptions.length &&
      movementSelectedRegions.size === movementRegionOptions.length &&
      movementSelectedRmAreas.size === movementRmAreaOptions.length &&
      movementSelectedAgings.size === movementLoaded.agings.length &&
      movementSelectedStatuses.size === movementLoaded.statuses.length &&
      movementSelectedOrigins.size === movementLoaded.origins.length &&
      movementDateStart === movementLoaded.initialStart &&
      movementDateEnd === movementLoaded.initialEnd &&
      responsibilityFiltersAreDefault,
  );
  const sellerFiltersAreDefault = Boolean(
    sellerPerformanceLoaded &&
      sellerSelectedRegions.size === sellerRegionOptions.length &&
      sellerSelectedBases.size === sellerBaseOptions.length &&
      sellerSelectedTiers.size === SELLER_CATEGORIES.filter((tier) => sellerPerformanceLoaded.records.some((record) => record.tier === tier)).length &&
      sellerSelectedSellers.size === sellerOptionList.length &&
      sellerDateStart === sellerPerformanceLoaded.dates[0] &&
      sellerDateEnd === sellerPerformanceLoaded.dates[sellerPerformanceLoaded.dates.length - 1] &&
      sellerCodeQuery.trim() === "" &&
      sellerOutcomeFilter === null &&
      responsibilityFiltersAreDefault,
  );
  const sellerDateIsInvalid = Boolean(sellerDateStart && sellerDateEnd && sellerDateStart > sellerDateEnd);
  const bipagemDateIsInvalid = Boolean(bipagemDateStart && bipagemDateEnd && bipagemDateStart > bipagemDateEnd);
  const bipagemFiltersAreDefault = Boolean(
    bipagemLoaded &&
      bipagemSelectedRegions.size === bipagemRegionOptions.length &&
      bipagemSelectedRms.size === bipagemRmOptions.length &&
      bipagemSelectedRgms.size === bipagemRgmOptions.length &&
      bipagemSelectedBases.size === bipagemBaseOptions.length &&
      bipagemSelectedOrigins.size === bipagemLoaded.origins.length &&
      bipagemProblemType === "collection" &&
      bipagemDateStart === bipagemLoaded.dates[0] &&
      bipagemDateEnd === bipagemLoaded.dates[bipagemLoaded.dates.length - 1],
  );
  const activeLoadedFile =
    view === "damage"
      ? damageLoaded
      : view === "bipagem"
      ? bipagemLoaded
      : view === "taxa"
      ? taxaLoaded
      : view === "epop"
      ? epopLoaded
      : view === "movimentacao"
        ? movementLoaded
        : view === "sellers"
          ? sellerPerformanceLoaded ?? sellerReferenceLoaded
          : loaded;
  const activeUploadId =
    view === "damage"
      ? "damage-upload"
      : view === "bipagem"
      ? "bipagem-upload"
      : view === "taxa"
      ? "taxa-upload"
      : view === "epop"
      ? "epop-upload"
      : view === "movimentacao"
        ? "movement-upload"
        : view === "sellers"
          ? "seller-performance-upload"
          : "monitoring-upload";
  const activeLoading = view === "damage" ? damageLoading : view === "bipagem" ? bipagemLoading : view === "taxa" ? taxaLoading : view === "epop" ? epopLoading : view === "movimentacao" ? movementLoading : view === "sellers" ? sellerLoading : loading;
  const reportGeneratedAt = formatDateTime(new Date().toISOString());
  const handlePrintReport = () => {
    window.setTimeout(() => window.print(), 30);
  };
  const taxaGeneralTrendPanel = (
    <div className="general-rate-trend-block taxa-general-aligned-panel">
      <div className="critical-bases-heading">
        <div>
          <span className="card-eyebrow">{t("RESULTADO GERAL")}</span>
          <h3>{t("Taxa de coleta x taxa com tentativa")}</h3>
        </div>
        <span>{t("Ano {year}", { year: taxaGeneralMonthlyTrend.year })}</span>
      </div>
      {taxaGeneralMonthlyTrend.points.length > 0 ? (
        <>
          <div
            className="general-rate-line-chart"
            role="img"
            aria-label={t("Evolução mensal geral da taxa de coleta e da taxa com tentativa no ano")}
          >
            <svg viewBox={`0 0 ${taxaGeneralMonthlyTrend.width} ${taxaGeneralMonthlyTrend.height}`} preserveAspectRatio="none">
              {[0.75, 0.85, 0.95, 1].map((rate) => {
                const chartHeight = taxaGeneralMonthlyTrend.height - taxaGeneralMonthlyTrend.top - taxaGeneralMonthlyTrend.bottom;
                const y = taxaGeneralMonthlyTrend.top + (1 - (rate - taxaGeneralMonthlyTrend.minRate) / (taxaGeneralMonthlyTrend.maxRate - taxaGeneralMonthlyTrend.minRate)) * chartHeight;
                return (
                  <g key={rate}>
                    <line
                      className="general-rate-grid-line"
                      x1={taxaGeneralMonthlyTrend.left}
                      y1={y}
                      x2={taxaGeneralMonthlyTrend.width - taxaGeneralMonthlyTrend.right}
                      y2={y}
                    />
                    <text className="general-rate-y-label" x="3" y={y + 4}>{formatRate(rate)}</text>
                  </g>
                );
              })}
              {taxaGeneralMonthlyTrend.targetY != null ? (
                <line
                  className="target-line"
                  x1={taxaGeneralMonthlyTrend.left}
                  y1={taxaGeneralMonthlyTrend.targetY}
                  x2={taxaGeneralMonthlyTrend.width - taxaGeneralMonthlyTrend.right}
                  y2={taxaGeneralMonthlyTrend.targetY}
                />
              ) : null}
              <polyline className="general-rate-line collection" points={taxaGeneralMonthlyTrend.collectionLine} />
              <polyline className="general-rate-line attempt" points={taxaGeneralMonthlyTrend.attemptLine} />
              {taxaGeneralMonthlyTrend.points.map((point) => (
                <g key={point.monthKey}>
                  <text className="general-rate-x-label" x={point.x} y={taxaGeneralMonthlyTrend.height - 12}>
                    {point.monthLabel}
                  </text>
                  <circle className="general-rate-point collection" cx={point.x} cy={point.collectionY} r="4.5">
                    <title>{`${t("Taxa de coleta")}: ${formatRate(point.collectionRate)}`}</title>
                  </circle>
                  <circle className="general-rate-point attempt" cx={point.x} cy={point.attemptY} r="4.5">
                    <title>{`${t("Taxa com tentativa")}: ${formatRate(point.attemptRate)}`}</title>
                  </circle>
                  <text
                    className="general-rate-value-label collection"
                    x={point.x}
                    y={Math.max(12, point.collectionY - 10)}
                    textAnchor="middle"
                  >
                    {formatRate(point.collectionRate)}
                  </text>
                  <text
                    className="general-rate-value-label attempt"
                    x={point.x}
                    y={Math.min(taxaGeneralMonthlyTrend.height - taxaGeneralMonthlyTrend.bottom + 18, point.attemptY + 16)}
                    textAnchor="middle"
                  >
                    {formatRate(point.attemptRate)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="general-rate-legend" aria-hidden="true">
            <span><i className="collection" />{t("Taxa de coleta")}</span>
            <span><i className="attempt" />{t("Taxa com tentativa")}</span>
          </div>
        </>
      ) : (
        <p className="critical-empty">{t("Não há meses com movimento para o gráfico geral.")}</p>
      )}
    </div>
  );

  if (!viewerChecked || !viewerAuthorization || !viewerIdentity) {
    return (
      <main className="viewer-login-page">
        <section className="viewer-login-card" aria-labelledby="viewer-login-title">
          <Image src="/jnt-logo.png" alt="J&T Express" width={189} height={41} priority />
          <span className="viewer-login-icon"><LockKeyhole size={25} /></span>
          <h1 id="viewer-login-title">{t("Acesso ao dashboard")}</h1>
          <p>{t("Entre para visualizar os indicadores da sua regional.")}</p>
          {!viewerChecked ? <p className="viewer-login-checking">{t("Verificando...")}</p> : (
            <form onSubmit={submitViewerLogin}>
              <label htmlFor="viewer-username">{t("Usuário")}</label>
              <input id="viewer-username" autoComplete="username" value={viewerUsername} onChange={(event) => setViewerUsername(event.target.value)} required />
              <label htmlFor="viewer-password">{t("Senha")}</label>
              <input id="viewer-password" type="password" autoComplete="current-password" value={viewerPassword} onChange={(event) => setViewerPassword(event.target.value)} required />
              {viewerAuthError ? <p className="viewer-login-error" role="alert">{t(viewerAuthError)}</p> : null}
              <button type="submit" disabled={viewerAuthLoading}>{viewerAuthLoading ? t("Verificando...") : t("Entrar")}</button>
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell" data-viewer-role={viewerIdentity.role}>
      <input
        id="monitoring-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleFileInput}
        disabled={loading}
      />
      <input
        id="taxa-upload"
        className="sr-only"
        type="file"
        multiple
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleTaxaFileInput}
        disabled={taxaLoading}
      />
      <input
        id="movement-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleMovementFileInput}
        disabled={movementLoading}
      />
      <input
        id="seller-list-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleSellerListFileInput}
        disabled={sellerLoading}
      />
      <input
        id="seller-special-list-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleSpecialSellerFileInput}
        disabled={sellerLoading || !sellerReferenceLoaded}
      />
      <input id="epop-upload" className="sr-only" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={handleEpopFileInput} disabled={epopLoading} />
      <input
        id="seller-performance-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleSellerPerformanceFileInput}
        disabled={sellerLoading || !sellerReferenceLoaded}
      />
      <input
        id="bipagem-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleBipagemFileInput}
        disabled={bipagemLoading}
      />
      <input
        id="damage-upload"
        className="sr-only"
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={handleDamageFileInput}
        disabled={damageLoading}
      />

      <header className="brand-header">
        <div className="header-inner">
          <div className="brand-block">
            <Image src="/jnt-logo.png" alt="J&T Express" width={189} height={41} priority />
            <span className="brand-divider" aria-hidden="true" />
            <div>
              <strong>{t("Monitoramento de Coletas")}</strong>
              <span>{t("Inteligência operacional")}</span>
            </div>
          </div>
          <div className="header-actions">
            <button type="button" className="viewer-session-chip" onClick={endViewerSession} title={t("Sair do dashboard")}>
              <LockKeyhole size={15} /> {viewerIdentity.region ? `${t("Regional")} ${viewerIdentity.region}` : t("Matriz")} · {t("Sair")}
            </button>
            <label className="language-selector">
              <Languages size={16} aria-hidden="true" />
              <span className="sr-only">{t("Idioma")}</span>
              <select
                value={language}
                onChange={(event) => {
                  const nextLanguage = event.target.value;
                  if (isDashboardLanguage(nextLanguage)) changeLanguage(nextLanguage);
                }}
                aria-label={t("Selecionar idioma")}
              >
                {DASHBOARD_LANGUAGES.map((option) => (
                  <option value={option.code} key={option.code}>{option.label}</option>
                ))}
              </select>
            </label>
            {view !== "home" ? (
              <button type="button" className="header-back-button" onClick={() => setView("home")}>
                <ArrowLeft size={17} /> {t("Início")}
              </button>
            ) : null}
            {activeLoadedFile ? (
              <div className="loaded-file" title={activeLoadedFile.fileName}>
                <FileSpreadsheet size={17} />
                <span>{activeLoadedFile.fileName}</span>
              </div>
            ) : (
              <div className="secure-chip"><ShieldCheck size={16} /> {t("Dados protegidos")}</div>
            )}
            {view !== "home" && activeLoadedFile ? (
              <div className="report-generated-chip">
                <CalendarDays size={16} />
                <span>{t("Relatório gerado em: {date}", { date: reportGeneratedAt })}</span>
              </div>
            ) : null}
            {view !== "home" && activeLoadedFile ? (
              <button type="button" className="header-report-button" onClick={handlePrintReport}>
                <Printer size={17} /> {t("Gerar PDF")}
              </button>
            ) : null}
            {view !== "home" && activeLoadedFile ? (
              <button type="button" className="header-report-button" onClick={() => { setAnalysisCopied(false); setAnalysisOpen(true); }}>
                <Sparkles size={17} /> {t("Análise IA")}
              </button>
            ) : null}
            {uploadAuthorization ? (
              <button
                type="button"
                className="upload-session-chip"
                onClick={() => {
                  uploadAuthorizationRef.current = null;
                  setUploadAuthorization(null);
                  setUploadUsername("");
                }}
                title={t("Encerrar autorização de upload")}
              >
                <LockKeyhole size={15} /> {t("Upload autorizado")}
              </button>
            ) : null}
            {view !== "home" && viewerIdentity.role === "matrix" ? (
              <label className="header-upload-button" htmlFor={activeUploadId}>
                <Upload size={17} /> {t(activeLoading ? "Processando..." : view === "taxa" ? "Adicionar planilha(s)" : view === "epop" ? "Adicionar relatório EPOP" : "Carregar arquivo Excel")}
              </label>
            ) : null}
          </div>
        </div>
      </header>

      {uploadLoginOpen ? (
        <div
          className="upload-login-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeUploadLogin();
          }}
        >
          <div
            className="upload-login-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="upload-login-title"
          >
            <button type="button" className="upload-login-close" onClick={closeUploadLogin} aria-label={t("Fechar")}>
              <X size={18} />
            </button>
            <span className="upload-login-icon"><LockKeyhole size={24} /></span>
            <h2 id="upload-login-title">{t("Autorizar envio de Excel")}</h2>
            <p>{t("Informe o usuário e a senha para publicar arquivos no dashboard.")}</p>
            <form onSubmit={submitUploadLogin}>
              <label htmlFor="upload-username">{t("Usuário")}</label>
              <input
                ref={uploadUsernameRef}
                id="upload-username"
                autoComplete="username"
                value={uploadUsername}
                onChange={(event) => setUploadUsername(event.target.value)}
                required
              />
              <label htmlFor="upload-password">{t("Senha")}</label>
              <input
                id="upload-password"
                type="password"
                autoComplete="current-password"
                value={uploadPassword}
                onChange={(event) => setUploadPassword(event.target.value)}
                required
              />
              {uploadAuthError ? <p className="upload-login-error" role="alert">{uploadAuthError}</p> : null}
              <div className="upload-login-actions">
                <button type="button" onClick={closeUploadLogin}>{t("Cancelar")}</button>
                <button type="submit" disabled={uploadAuthLoading}>
                  {t(uploadAuthLoading ? "Verificando..." : "Entrar e carregar")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {analysisOpen ? (
        <div className="upload-login-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAnalysisOpen(false); }}>
          <div className="upload-login-dialog" role="dialog" aria-modal="true" aria-labelledby="analysis-title">
            <button type="button" className="upload-login-close" onClick={() => setAnalysisOpen(false)} aria-label={t("Fechar")}><X size={18} /></button>
            <span className="upload-login-icon"><Sparkles size={24} /></span>
            <h2 id="analysis-title">{t("Análise IA")}</h2>
            <p>{t("Mensagem criada com os filtros e o período atualmente selecionados.")}</p>
            <textarea readOnly value={analysisText} aria-label={t("Mensagem para grupo")} style={{ minHeight: 260, width: "100%", resize: "vertical" }} />
            <div className="upload-login-actions">
              <button type="button" onClick={() => setAnalysisOpen(false)}>{t("Fechar")}</button>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(analysisText); setAnalysisCopied(true); }}><Copy size={16} /> {t(analysisCopied ? "Copiado" : "Copiar mensagem")}</button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="dashboard-main">
        {view === "home" ? (
          <DashboardHome
            onSelect={(nextView) => {
              setError(null);
              setView(nextView);
            }}
            monitoringUpdatedAt={loaded?.updatedAt}
            taxaUpdatedAt={taxaLoaded?.updatedAt}
            movementUpdatedAt={movementLoaded?.updatedAt}
            sellersUpdatedAt={sellerPerformanceLoaded?.updatedAt ?? sellerReferenceLoaded?.updatedAt}
            bipagemUpdatedAt={bipagemLoaded?.updatedAt}
            damageUpdatedAt={damageLoaded?.updatedAt}
            language={language}
            t={t}
          />
        ) : view === "damage" ? (
          !damageLoaded ? (
            <EmptyDashboardPanel loading={damageLoading} error={error} onDrop={(file) => queueUpload({ kind: "damage", files: [file] })} inputId="damage-upload" t={t} />
          ) : (
            <>
              <section className="dashboard-intro">
                <div><div className="eyebrow"><CircleAlert size={15} /> {t("QUALIDADE OPERACIONAL")}</div><h1><BilingualText language={language} source="Extravio" /></h1><p>{t("Pedidos avariados e extraviados, valor de arbitragem em reais, responsáveis, bases, origem e principais motivos.")}</p></div>
                <div className="dataset-meta"><span><Layers3 size={16} /> {t("{count} linhas", { count: formatNumber(damageRecords.length) })}</span><span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(damageRegionOptions.length) })}</span><span><Database size={16} /> {t("{count} bases", { count: formatNumber(damageBaseOptions.length) })}</span><span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(damageLoaded.updatedAt) })}</span></div>
              </section>
              {error ? <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{t(error)}</span><button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button></div> : null}
              <section className="filters-card taxa-filters-card" aria-labelledby="damage-filters-heading"><div className="filters-card-top"><h2 id="damage-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2><button type="button" className="reset-button" onClick={() => applyDamageLoadedData(damageLoaded, responsibilityLoaded)}><RotateCcw size={15} /> {t("Limpar filtros")}</button></div><div className="filter-grid damage-filter-grid">
                <MultiSelect label={t("Regional")} options={damageRegionOptions} selected={damageSelectedRegions} onChange={(next) => { const matching = damageLoaded.records.filter((r) => next.has(registeredRegionForBase(responsibilityLoaded, r.base, r.region))); setDamageSelectedRegions(next); setDamageSelectedRms(new Set(matching.map((r) => responsibilityForBase(responsibilityLoaded, r.base).rm))); setDamageSelectedRgms(new Set(matching.map((r) => responsibilityForBase(responsibilityLoaded, r.base).rgm))); setDamageSelectedBases(new Set(matching.map((r) => r.base))); }} allLabel={t("Todas as regionais")} singular={t("regional")} plural={t("regionais")} searchable t={t} />
                <MultiSelect label="RM" options={damageRmOptions} selected={damageSelectedRms} onChange={(next) => { setDamageSelectedRms(next); setDamageSelectedBases(new Set(damageLoaded.records.filter((r) => damageSelectedRegions.has(registeredRegionForBase(responsibilityLoaded, r.base, r.region)) && next.has(responsibilityForBase(responsibilityLoaded, r.base).rm) && damageSelectedRgms.has(responsibilityForBase(responsibilityLoaded, r.base).rgm)).map((r) => r.base))); }} allLabel={t("Todos os RM")} singular="RM" plural="RM" searchable t={t} />
                <MultiSelect label="RGM" options={damageRgmOptions} selected={damageSelectedRgms} onChange={(next) => { setDamageSelectedRgms(next); setDamageSelectedBases(new Set(damageLoaded.records.filter((r) => damageSelectedRegions.has(registeredRegionForBase(responsibilityLoaded, r.base, r.region)) && damageSelectedRms.has(responsibilityForBase(responsibilityLoaded, r.base).rm) && next.has(responsibilityForBase(responsibilityLoaded, r.base).rgm)).map((r) => r.base))); }} allLabel={t("Todos os RGM")} singular="RGM" plural="RGM" searchable t={t} />
                <MultiSelect label={t("Base")} options={damageBaseOptions} selected={damageSelectedBases} onChange={setDamageSelectedBases} allLabel={t("Todas as bases")} singular={t("base")} plural={t("bases")} searchable t={t} />
                <div className="filter-field date-field"><label className="filter-label" htmlFor="damage-date-start">{t("Data inicial")}</label><div className="date-input-wrap"><CalendarDays size={16} /><input id="damage-date-start" type="date" value={damageDateStart} min={damageLoaded.dates[0]} max={damageLoaded.dates[damageLoaded.dates.length - 1]} onChange={(event) => setDamageDateStart(event.target.value)} /></div></div>
                <div className="filter-field date-field"><label className="filter-label" htmlFor="damage-date-end">{t("Data final")}</label><div className="date-input-wrap"><CalendarDays size={16} /><input id="damage-date-end" type="date" value={damageDateEnd} min={damageDateStart} max={damageLoaded.dates[damageLoaded.dates.length - 1]} onChange={(event) => setDamageDateEnd(event.target.value)} /></div></div>
              </div>{damageDateStart > damageDateEnd ? <div className="filter-summary invalid"><CircleAlert size={15} /> {t("A data inicial deve ser anterior à data final.")}</div> : null}</section>
              <section className="kpi-grid" aria-label={t("Indicadores de extravio")}>
                <KpiCard icon={<Layers3 size={20} />} label={t("Total de pedidos")} value={formatNumber(damageSummary.orders)} detail={t("{count} registros no período", { count: formatNumber(damageRecords.length) })} />
                <KpiCard icon={<CircleAlert size={20} />} label={t("Valor total da arbitragem")} value={formatCurrencyBRL(damageSummary.value)} detail={t("Valor em reais (R$)")} tone="orange" />
                <KpiCard icon={<Database size={20} />} label={t("Bases com ocorrência")} value={formatNumber(damageByBase.length)} detail={t("No filtro selecionado")} tone="dark" />
                <KpiCard icon={<MapPin size={20} />} label={t("Clientes / origens")} value={formatNumber(damageOriginsAll.length)} detail={t("Códigos da origem do pedido")} tone="soft" />
              </section>
              <section className="damage-report-grid" aria-label={t("Resumo regional e clientes")}>
                <article className="report-card damage-regional-card"><div className="report-card-heading"><div><span className="card-eyebrow">{t("REGIONAL")}</span><h2>{t("Pedidos e valor por regional — período selecionado")}</h2><p>{t("Últimos 7 dias do período; o total considera todo o intervalo selecionado.")}</p></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("regional")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="table-scroll"><table><thead><tr><th>{t("Regional")}</th><th>RGM</th>{damageRegionalDates.map((date) => <th key={date}>{formatDate(date, true)}</th>)}<th>{t("Total de pedidos")}</th><th>{t("Valor")}</th></tr></thead><tbody>{damageRegionalRows.map((row) => <tr key={`${row.region}-${row.rgm}`}><td>{row.region}</td><td>{row.rgm}</td>{damageRegionalDates.map((date) => <td key={date}>{formatNumber(row.daily.get(date) ?? 0)}</td>)}<td>{formatNumber(row.orders)}</td><td>{formatCurrencyBRL(row.value)}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th>{damageRegionalDates.map((date) => <td key={date}>{formatNumber(damageRegionalRows.reduce((sum, row) => sum + (row.daily.get(date) ?? 0), 0))}</td>)}<td>{formatNumber(damageSummary.orders)}</td><td>{formatCurrencyBRL(damageSummary.value)}</td></tr></tfoot></table></div></article>
                <article className="report-card damage-clients-card"><div className="report-card-heading"><div><span className="card-eyebrow">{t("CLIENTES")}</span><h2>{t("Clientes com mais avaria / extravio")}</h2><p>{t("Código da origem do pedido; ranking por quantidade.")}</p></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("clientes")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="damage-client-bars">{damageOrigins.slice(0, 8).map((row) => <div className="damage-client-row" key={row.origin}><div className="damage-client-label"><span><i aria-hidden="true" />{row.origin}</span><strong>{formatNumber(row.orders)} {t("pedidos")}</strong></div><div className="damage-client-track"><span style={{ width: `${Math.max(2, damageOrigins[0]?.orders ? row.orders / damageOrigins[0].orders * 100 : 0)}%` }} /></div><small>{formatCurrencyBRL(row.value)}</small></div>)}{damageOrigins.length === 0 ? <p>{t("Não há dados no período selecionado.")}</p> : null}</div><div className="damage-client-total"><strong>{t("Total geral")}</strong><span>{formatNumber(damageSummary.orders)} {t("pedidos")} · {formatCurrencyBRL(damageSummary.value)}</span></div></article>
              </section>
              <section className="damage-report-grid" aria-label={t("Responsáveis")}>
                <article className="report-card"><div className="report-card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Total por RM")}</h2></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("rm")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="table-scroll"><table><thead><tr><th>RGM</th><th>RM</th><th>{t("Total de pedidos")}</th><th>{t("Valor")}</th></tr></thead><tbody>{damageByRm.map((row) => <tr key={`${row.rgm}-${row.rm}`}><td>{row.rgm}</td><td>{row.rm}</td><td>{formatNumber(row.orders)}</td><td>{formatCurrencyBRL(row.value)}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th><td>{formatNumber(damageSummary.orders)}</td><td>{formatCurrencyBRL(damageSummary.value)}</td></tr></tfoot></table></div></article>
                <article className="report-card"><div className="report-card-heading"><div><span className="card-eyebrow">RGM</span><h2>{t("Total por RGM")}</h2></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("rgm")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="table-scroll"><table><thead><tr><th>RGM</th><th>{t("Total de pedidos")}</th><th>{t("Valor")}</th></tr></thead><tbody>{damageByRgm.map((row) => <tr key={row.rgm}><td>{row.rgm}</td><td>{formatNumber(row.orders)}</td><td>{formatCurrencyBRL(row.value)}</td></tr>)}</tbody><tfoot><tr><th>{t("Total geral")}</th><td>{formatNumber(damageSummary.orders)}</td><td>{formatCurrencyBRL(damageSummary.value)}</td></tr></tfoot></table></div></article>
              </section>
              <section className="damage-report-grid" aria-label={t("Motivos e bases")}>
                <article className="report-card"><div className="report-card-heading"><div><span className="card-eyebrow">PARETO</span><h2>{t("Principais motivos — tipo secundário")}</h2></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("motivos")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="table-scroll"><table><thead><tr><th>{t("Motivo")}</th><th>{t("Pedidos")}</th><th>{t("Valor")}</th></tr></thead><tbody>{damagePareto.map((row) => <tr key={row.reason}><td>{row.reason}</td><td>{formatNumber(row.orders)}</td><td>{formatCurrencyBRL(row.value)}</td></tr>)}</tbody><tfoot><tr><th>{t("Total geral")}</th><td>{formatNumber(damageSummary.orders)}</td><td>{formatCurrencyBRL(damageSummary.value)}</td></tr></tfoot></table></div></article>
                <article className="report-card"><div className="report-card-heading"><div><span className="card-eyebrow">{t("BASE")}</span><h2>{t("Visão por base")}</h2></div><button type="button" className="table-download-button" onClick={() => void downloadDamageTableExcel("base")}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button></div><div className="table-scroll"><table><thead><tr><th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("Pedidos")}</th><th>{t("Valor")}</th></tr></thead><tbody>{damageByBase.map((row) => <tr key={`${row.region}-${row.base}`}><td>{row.region}</td><td>{row.base}</td><td>{formatNumber(row.orders)}</td><td>{formatCurrencyBRL(row.value)}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th><td>{formatNumber(damageSummary.orders)}</td><td>{formatCurrencyBRL(damageSummary.value)}</td></tr></tfoot></table></div></article>
              </section>
              <section className="report-card damage-report-card"><div className="report-card-heading"><div><span className="card-eyebrow">{t("DETALHAMENTO")}</span><h2>{t("Pedidos para análise regional")}</h2><p>{t("Inclui ticket, remessa, regional, base, RM/RGM, tipo, motivo, código da origem, quantidade e valor em R$.")}</p></div><button type="button" className="export-button" onClick={() => void downloadDamageWorkbook()}><FileSpreadsheet size={17} /> {t("Baixar Excel — todas as tabelas")}</button></div></section>
            </>
          )
        ) : view === "bipagem" ? (
          !bipagemLoaded ? (
            <EmptyDashboardPanel loading={bipagemLoading} error={error} onDrop={(file) => queueUpload({ kind: "bipagem", files: [file] })} inputId="bipagem-upload" t={t} />
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><CircleAlert size={15} /> {t("QUALIDADE DA COLETA")}</div>
                  <h1>{t("Falha na coleta PDD")}</h1>
                  <p>{t("Acompanhe o volume a digitalizar, as falhas na coleta e a taxa por regional, base, RM, RGM, origem do pedido e período.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo do arquivo de falta de bipagem")}>
                  <span><Layers3 size={16} /> {t("{count} linhas", { count: formatNumber(bipagemLoaded.records.length) })}</span>
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(bipagemRegionOptions.length) })}</span>
                  <span><Database size={16} /> {t("{count} bases", { count: formatNumber(bipagemLoaded.bases.length) })}</span>
                  <span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(bipagemLoaded.updatedAt) })}</span>
                </div>
              </section>

              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              <section className="filters-card bipagem-filters-card" aria-labelledby="bipagem-filters-heading">
                <div className="filters-card-top">
                  <h2 id="bipagem-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                  <button type="button" className="reset-button" onClick={() => resetBipagemFilters()} disabled={bipagemFiltersAreDefault}>
                    <RotateCcw size={15} /> {t("Limpar filtros")}
                  </button>
                </div>
                <div className="filter-grid bipagem-filter-grid">
                  <MultiSelect
                    label={t("Regional")}
                    options={bipagemRegionOptions}
                    selected={bipagemSelectedRegions}
                    onChange={(value) => {
                      setBipagemSelectedRegions(value);
                      setBipagemSelectedBases(new Set(bipagemLoaded.records.filter((record) => {
                        const region = registeredRegionForBase(responsibilityLoaded, record.base, record.region);
                        const { rm, rgm } = responsibilityForBase(responsibilityLoaded, record.base);
                        return value.has(region) && bipagemSelectedRms.has(rm) && bipagemSelectedRgms.has(rgm);
                      }).map((record) => record.base)));
                    }}
                    allLabel={t("Todas as regionais")}
                    singular={t("Regional")}
                    plural={t("Regionais")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={bipagemRmOptions}
                    selected={bipagemSelectedRms}
                    onChange={(value) => {
                      setBipagemSelectedRms(value);
                      setBipagemSelectedBases(new Set(bipagemLoaded.records.filter((record) => {
                        const region = registeredRegionForBase(responsibilityLoaded, record.base, record.region);
                        const { rm, rgm } = responsibilityForBase(responsibilityLoaded, record.base);
                        return bipagemSelectedRegions.has(region) && value.has(rm) && bipagemSelectedRgms.has(rgm);
                      }).map((record) => record.base)));
                    }}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="RGM"
                    options={bipagemRgmOptions}
                    selected={bipagemSelectedRgms}
                    onChange={(value) => {
                      setBipagemSelectedRgms(value);
                      setBipagemSelectedBases(new Set(bipagemLoaded.records.filter((record) => {
                        const region = registeredRegionForBase(responsibilityLoaded, record.base, record.region);
                        const { rm, rgm } = responsibilityForBase(responsibilityLoaded, record.base);
                        return bipagemSelectedRegions.has(region) && bipagemSelectedRms.has(rm) && value.has(rgm);
                      }).map((record) => record.base)));
                    }}
                    allLabel={t("Todos os RGM")}
                    singular="RGM"
                    plural="RGM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={bipagemBaseOptions}
                    selected={bipagemSelectedBases}
                    onChange={setBipagemSelectedBases}
                    allLabel={t("Todas as bases")}
                    singular={t("Base")}
                    plural={t("Bases")}
                    searchable
                    t={t}
                  />
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="bipagem-date-start">{t("Data inicial")}</label>
                    <input className="date-input" id="bipagem-date-start" type="date" min={bipagemLoaded.dates[0]} max={bipagemLoaded.dates[bipagemLoaded.dates.length - 1]} value={bipagemDateStart} onChange={(event) => setBipagemDateStart(event.target.value)} />
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="bipagem-date-end">{t("Data final")}</label>
                    <input className="date-input" id="bipagem-date-end" type="date" min={bipagemLoaded.dates[0]} max={bipagemLoaded.dates[bipagemLoaded.dates.length - 1]} value={bipagemDateEnd} onChange={(event) => setBipagemDateEnd(event.target.value)} />
                  </div>
                  <MultiSelect
                    label={t("Origem do pedido")}
                    options={bipagemLoaded.origins}
                    selected={bipagemSelectedOrigins}
                    onChange={setBipagemSelectedOrigins}
                    allLabel={t("Todas as origens")}
                    singular={t("Origem")}
                    plural={t("Origens")}
                    searchable
                    t={t}
                  />
                </div>
                {bipagemDateIsInvalid ? <p className="date-error" role="alert">{t("A data inicial deve ser anterior à data final.")}</p> : null}
              </section>

              <section className="kpi-grid bipagem-kpi-grid" aria-label={t("Indicadores de falta de bipagem")}>
                <KpiCard icon={<Layers3 size={20} />} label={t("Total de pedidos")} value={formatCompact(bipagemSummary.ordersToScan)} detail={t("Volume total no período")} />
                <KpiCard icon={<CircleAlert size={20} />} label={t("Pedidos não bipados")} value={formatCompact(bipagemSummary.notScannedCollection)} detail={t("Volume de captura não realizado")} tone="orange" />
                <KpiCard icon={<Target size={20} />} label={t("% falha na coleta PDD")} value={formatRate(bipagemSummary.collectionFailureRate)} detail={t("Pedidos não bipados ÷ total de pedidos")} tone="soft" />
              </section>

              <section className="chart-card bipagem-table-card bipagem-regional-card" aria-labelledby="bipagem-regional-heading">
                <div className="card-heading table-card-heading">
                  <div>
                    <span className="card-eyebrow">{t("RESUMO REGIONAL")}</span>
                    <h2 id="bipagem-regional-heading">{t("Falha na coleta PDD por regional")}</h2>
                    <p>{t("Total de pedidos, pedidos não bipados e taxa conforme os filtros selecionados.")}</p>
                  </div>
                  <div className="table-tools bipagem-comparison-tools">
                    <span className="comparison-period-badge">{formatDate(bipagemDateStart, true)} × {formatDate(bipagemDateEnd, true)}</span>
                    <button type="button" className="table-download-button" onClick={() => void downloadBipagemRegionalExcel()} disabled={bipagemRegionalSummary.length === 0}>
                      <FileSpreadsheet size={16} /> {t("Baixar Excel")}
                    </button>
                  </div>
                </div>
                <div className="dashboard-table-wrap bipagem-table-wrap">
                  <table className="dashboard-data-table bipagem-summary-table">
                    <thead><tr>
                      <th>{t("Regional")}</th><th>RGM</th><th>{t("Bases")}</th>
                      <th>{t("Total de pedidos")}</th><th>{t("Pedidos não bipados")}</th><th>{t("% falha na coleta PDD")}</th>
                    </tr></thead>
                    <tbody>
                      {bipagemRegionalSummary.map((row) => {
                        return <tr key={row.region}>
                          <td><span className="regional-chip">{row.region}</span></td>
                          <td>{officialRgmForRegion(row.region) ?? UNASSIGNED_RGM}</td>
                          <td>{formatNumber(row.activeBases)}</td>
                          <td>{formatNumber(row.ordersToScan)}</td>
                          <td className="danger-cell">{formatNumber(row.notScannedCollection)}</td>
                          <td>{formatRate(row.collectionFailureRate)}</td>
                        </tr>;
                      })}
                    </tbody>
                    <tfoot><tr><th>{t("Total geral")}</th><th>—</th><th>{formatNumber(new Set(bipagemFilteredRecords.map((record) => record.base)).size)}</th><th>{formatNumber(bipagemSummary.ordersToScan)}</th><th>{formatNumber(bipagemSummary.notScannedCollection)}</th><th>{formatRate(bipagemSummary.collectionFailureRate)}</th></tr></tfoot>
                  </table>
                </div>
              </section>

              <section className="chart-card bipagem-table-card bipagem-detail-card" aria-labelledby="bipagem-base-heading">
                <div className="card-heading table-card-heading">
                  <div>
                    <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                    <h2 id="bipagem-base-heading">{t("Falha na coleta PDD por base, RM e RGM")}</h2>
                    <p>{t("Ordenado pelo maior volume de pedidos não bipados.")}</p>
                  </div>
                  <div className="table-tools bipagem-comparison-tools">
                    <span className="comparison-period-badge">{formatDate(bipagemDateStart, true)} × {formatDate(bipagemDateEnd, true)}</span>
                    <button type="button" className="table-download-button" onClick={() => void downloadBipagemBaseExcel()} disabled={bipagemBaseSummary.length === 0}>
                      <FileSpreadsheet size={16} /> {t("Baixar Excel")}
                    </button>
                    <label className="table-search"><Search size={16} /><input value={bipagemTableQuery} onChange={(event) => setBipagemTableQuery(event.target.value)} placeholder={t("Buscar base, regional ou RM")} /></label>
                  </div>
                </div>
                <div className="dashboard-table-wrap bipagem-table-wrap bipagem-detail-table-wrap">
                  <table className="dashboard-data-table bipagem-detail-table">
                    <thead><tr>
                      <th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("Código da base")}</th><th>RM</th><th>RGM</th>
                      <th>{t("Total de pedidos")}</th><th>{t("Pedidos não bipados")}</th><th>{t("% falha na coleta PDD")}</th>
                    </tr></thead>
                    <tbody>
                      {bipagemBaseSummary.map((row) => {
                        return <tr key={row.key}>
                          <td><span className="regional-chip">{row.region}</span></td>
                          <td><strong>{row.base}</strong></td>
                          <td>{row.baseCode}</td>
                          <td>{t(row.rm)}</td>
                          <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                          <td>{formatNumber(row.ordersToScan)}</td>
                          <td className="danger-cell">{formatNumber(row.notScannedCollection)}</td>
                          <td>{formatRate(row.collectionFailureRate)}</td>
                        </tr>;
                      })}
                    </tbody>
                    <tfoot><tr><th>{t("Total geral")}</th><th>—</th><th>—</th><th>—</th><th>—</th><th>{formatNumber(bipagemSummary.ordersToScan)}</th><th>{formatNumber(bipagemSummary.notScannedCollection)}</th><th>{formatRate(bipagemSummary.collectionFailureRate)}</th></tr></tfoot>
                  </table>
                  {bipagemBaseSummary.length === 0 ? <EmptyChart message={t("Nenhum resultado encontrado")} /> : null}
                </div>
              </section>
            </>
          )
        ) : view === "movimentacao" ? (
          !movementLoaded ? (
            <EmptyDashboardPanel loading={movementLoading} error={error} onDrop={(file) => queueUpload({ kind: "movement", files: [file] })} inputId="movement-upload" t={t} />
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><Activity size={15} /> {t("SEM MOVIMENTAÇÃO")}</div>
                  <h1>{t("Sem movimentação")}</h1>
                  <p>{t(movementLoaded.format === "summary" ? "Total sem movimentação por regional, base, RM, RGM e região do RM." : "Pedidos sem movimentação por AGING, regional, RM, base, status, origem e período.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo do arquivo de movimentação")}>
                  <span><Layers3 size={16} /> {t("{count} pedidos", { count: formatNumber(movementSummary.totalStopped) })}</span>
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(movementRegionOptions.length) })}</span>
                  <span><Database size={16} /> {t("{count} colunas", { count: formatNumber(movementLoaded.displayColumns.length) })}</span>
                  <span><CircleAlert size={16} /> {t("{count} bases críticas", { count: formatNumber(movementSummary.criticalBases) })}</span>
                  <span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(movementLoaded.updatedAt) })}</span>
                </div>
              </section>

              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              <section className="filters-card movement-filters-card" aria-labelledby="movement-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="movement-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                  </div>
                  <button
                    type="button"
                    className="reset-button"
                    onClick={() => resetMovementFilters()}
                    disabled={movementFiltersAreDefault}
                  >
                    <RotateCcw size={15} /> {t("Limpar filtros")}
                  </button>
                </div>
                <div className="filter-grid movement-filter-grid">
                  <MultiSelect
                    label={t("Regional")}
                    options={movementRegionOptions}
                    selected={movementSelectedRegions}
                    onChange={(value) => {
                      setMovementSelectedRegions(value);
                      const bases = movementBasesForRegions(movementLoaded, value, responsibilityLoaded).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
                      setMovementSelectedBases(new Set(bases));
                      setMovementSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, bases).rmAreas));
                      setMovementPage(1);
                    }}
                    allLabel={t("Todas as regionais")}
                    singular={t("regional")}
                    plural={t("regionais")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={responsibilityFilterOptions.rms}
                    selected={selectedRms}
                    onChange={(value) => applyResponsibilityFilter("rm", value)}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Região do RM")}
                    options={movementRmAreaOptions}
                    selected={movementSelectedRmAreas}
                    onChange={(value) => { setMovementSelectedRmAreas(value); setMovementPage(1); }}
                    allLabel={t("Todas as regiões do RM")}
                    singular={t("região do RM")}
                    plural={t("regiões do RM")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={movementBaseOptions}
                    selected={movementSelectedBases}
                    onChange={(value) => {
                      setMovementSelectedBases(value);
                      setMovementPage(1);
                    }}
                    allLabel={t("Todas as bases")}
                    singular={t("base")}
                    plural={t("bases")}
                    searchable
                    t={t}
                  />
                  <MultiSelect label="RGM" options={responsibilityFilterOptions.rgms} selected={selectedRgms}
                    onChange={(value) => applyResponsibilityFilter("rgm", value)} allLabel={t("Todos os RGM")}
                    singular="RGM" plural="RGM" searchable t={t} />
                  {movementLoaded.format === "summary" ? (
                    <div className="filter-field">
                      <label className="filter-label" htmlFor="movement-metric">{t("Indicador / AGING")}</label>
                      <select className="date-input" id="movement-metric" value={movementSummaryMetric}
                        onChange={(event) => { setMovementSummaryMetric(event.target.value); setMovementPage(1); }}>
                        {MOVEMENT_SUMMARY_METRICS.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
                      </select>
                    </div>
                  ) : (<>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="movement-date-start">{t("Data inicial")}</label>
                    <input className="date-input" id="movement-date-start" type="date" min={movementLoaded.dates[0]} max={movementLoaded.dates[movementLoaded.dates.length - 1]} value={movementDateStart} onChange={(event) => { setMovementDateStart(event.target.value); setMovementPage(1); }} />
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="movement-date-end">{t("Data final")}</label>
                    <input className="date-input" id="movement-date-end" type="date" min={movementLoaded.dates[0]} max={movementLoaded.dates[movementLoaded.dates.length - 1]} value={movementDateEnd} onChange={(event) => { setMovementDateEnd(event.target.value); setMovementPage(1); }} />
                  </div>
                  <MultiSelect
                    label={t("Origem do pedido")}
                    options={movementLoaded.origins}
                    selected={movementSelectedOrigins}
                    onChange={(value) => { setMovementSelectedOrigins(value); setMovementPage(1); }}
                    allLabel={t("Todas as origens")}
                    singular={t("Origem")}
                    plural={t("Origens")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="AGING"
                    options={movementLoaded.agings}
                    selected={movementSelectedAgings}
                    onChange={(value) => { setMovementSelectedAgings(value); setMovementPage(1); }}
                    allLabel={t("Todos os AGING")}
                    singular="AGING"
                    plural="AGING"
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Status")}
                    options={movementLoaded.statuses}
                    selected={movementSelectedStatuses}
                    onChange={(value) => { setMovementSelectedStatuses(value); setMovementPage(1); }}
                    allLabel={t("Todos os status")}
                    singular={t("status")}
                    plural={t("status")}
                    searchable
                    t={t}
                  />
                  </>)}
                </div>
                {movementDateStart && movementDateEnd && movementDateStart > movementDateEnd ? <p className="date-error" role="alert">{t("A data inicial deve ser anterior à data final.")}</p> : null}
              </section>

              {movementLoaded.blankBaseRows > 0 || movementLoaded.blankRegionRows > 0 ? (
                <div className="quality-note">
                  <Info size={16} />
                  <span>
                    {movementLoaded.blankBaseRows > 0
                      ? t("{count} linha(s) sem base foram mantidas como “Sem base”.", { count: movementLoaded.blankBaseRows })
                      : t("{count} linha(s) sem regional foram mantidas como “Sem regional”.", { count: movementLoaded.blankRegionRows })}
                  </span>
                </div>
              ) : null}

              <section className="kpi-grid" aria-label={t("Indicadores de movimentação")}>
                <KpiCard
                  icon={<Layers3 size={20} />}
                  label={t("Total sem movimentação")}
                  value={formatCompact(movementSummary.totalStopped)}
                  detail={t("{count} pedidos sem movimentação", { count: formatNumber(movementSummary.totalStopped) })}
                />
                <KpiCard
                  icon={<Database size={20} />}
                  label={t(movementLoaded.format === "summary" ? "Pedidos em trânsito" : "Pedidos no período")}
                  value={formatCompact(movementSummary.inTransit)}
                  detail={t("{count} pedidos no filtro", { count: formatNumber(movementSummary.inTransit) })}
                  tone="orange"
                />
                <KpiCard
                  icon={<CircleAlert size={20} />}
                  label={t("Acima de 2 dias")}
                  value={formatCompact(movementSummary.over2Days)}
                  detail={t("{rate} dos pedidos sem movimentação", { rate: formatRate(movementSummary.over2Rate) })}
                  tone="dark"
                />
                <KpiCard
                  icon={<MapPin size={20} />}
                  label={t("Bases críticas")}
                  value={formatNumber(movementSummary.criticalBases)}
                  detail={t("com volume sem movimentação acima de 2 dias")}
                  tone="soft"
                />
              </section>

              <section className="kpi-grid secondary-kpis" aria-label={t("Indicadores complementares de movimentação")}>
                <KpiCard
                  icon={<Activity size={20} />}
                  label={t("Acima de 14 dias")}
                  value={formatCompact(movementSummary.over14Days)}
                  detail={t("{count} pedidos mais antigos", { count: formatNumber(movementSummary.over14Days) })}
                />
                <KpiCard
                  icon={<ShieldCheck size={20} />}
                  label={t("Acima de 30 dias")}
                  value={formatCompact(movementSummary.over30Days)}
                  detail={t("{count} pedidos críticos", { count: formatNumber(movementSummary.over30Days) })}
                  tone="orange"
                />
                <KpiCard
                  icon={<MapPin size={20} />}
                  label={t("Regional")}
                  value={formatNumber(movementSummary.activeRegions)}
                  detail={t("{count} selecionado(s)", { count: movementSelectedRegions.size })}
                  tone="dark"
                />
                <KpiCard
                  icon={<PackageCheck size={20} />}
                  label={t("Regional mais crítica")}
                  value={movementSummary.topRegion ? formatCompact(movementSummary.topRegion[1]) : "0"}
                  detail={movementSummary.topRegion?.[0] ?? t("Sem volume crítico")}
                  tone="soft"
                />
              </section>

              <section className="charts-grid taxa-charts-grid movement-summary-grid">
                <article className="chart-card movement-summary-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("REGIONAL")}</span>
                      <h2>{t("Sem movimentação por regional")}</h2>
                      <p>{t("Total sem movimentação conforme o indicador e os filtros selecionados.")}</p>
                    </div>
                    <button className="table-download-button" type="button" onClick={downloadMovementTableExcel} disabled={movementRegionalOver2Summary.length === 0}>
                      <FileSpreadsheet size={16} />
                      {t("Baixar Excel")}
                    </button>
                  </div>
                  {movementRegionalOver2Summary.length > 0 ? (
                    <div className="dashboard-table-wrap movement-summary-table-wrap">
                      <table className="dashboard-data-table movement-summary-table">
                        <thead><tr><th>{t("Regional")}</th><th>RGM</th><th>{t("Total sem movimentação")}</th></tr></thead>
                        <tbody>
                          {movementRegionalOver2Summary.map((row) => (
                            <tr key={row.region}>
                              <td><span className="regional-chip">{row.region}</span></td>
                              <td>{t(row.rgm)}</td>
                              <td className="number-cell warning-cell">{formatNumber(row.orders)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><th>{t("Total geral")}</th><td>—</td><td className="number-cell">{formatNumber(movementSummary.totalStopped)}</td></tr></tfoot>
                      </table>
                    </div>
                  ) : (
                    <EmptyChart message={t("Não há pedidos sem movimentação para os filtros selecionados.")} />
                  )}
                </article>

                <article className="chart-card movement-summary-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">RM</span>
                      <h2>{t("Sem movimentação por RM")}</h2>
                      <p>{t("Total sem movimentação conforme o indicador e os filtros selecionados.")}</p>
                    </div>
                    <button className="table-download-button" type="button" onClick={downloadMovementTableExcel} disabled={movementRmOver2Summary.length === 0}>
                      <FileSpreadsheet size={16} />
                      {t("Baixar Excel")}
                    </button>
                  </div>
                  {movementRmOver2Summary.length > 0 ? (
                    <div className="dashboard-table-wrap movement-summary-table-wrap">
                      <table className="dashboard-data-table movement-summary-table movement-rm-summary-table">
                        <thead><tr><th>{t("Região do RM")}</th><th>{t("Responsável do RM")}</th><th>RGM</th><th>{t("Total sem movimentação")}</th></tr></thead>
                        <tbody>
                          {movementRmOver2Summary.map((row) => (
                            <tr key={`${row.rmArea}::${row.rm}::${row.rgm}`}>
                              <td>{t(row.rmArea)}</td>
                              <td>{t(row.rm)}</td>
                              <td>{t(row.rgm)}</td>
                              <td className="number-cell warning-cell">{formatNumber(row.orders)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><th>{t("Total geral")}</th><td>—</td><td>—</td><td className="number-cell">{formatNumber(movementSummary.totalStopped)}</td></tr></tfoot>
                      </table>
                    </div>
                  ) : (
                    <EmptyChart message={t("Não há pedidos sem movimentação para os filtros selecionados.")} />
                  )}
                </article>
              </section>

              <section className="table-card" aria-labelledby="movement-detail-heading">
                <div className="table-card-top">
                  <div>
                    <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                    <h2 id="movement-detail-heading">{t("Dados por base")}</h2>
                    <p>{t("Todas as colunas do arquivo, ordenadas pelo total sem movimentação.")}</p>
                  </div>
                  <div className="table-detail-actions">
                    <button className="table-download-button" type="button" onClick={downloadMovementTableExcel} disabled={movementTableRows.length === 0}>
                      <FileSpreadsheet size={17} />
                      {t("Baixar Excel")}
                    </button>
                    <label className="table-search">
                      <Search size={16} />
                      <span className="sr-only">{t("Buscar base, regional ou código")}</span>
                      <input
                        value={movementTableQuery}
                        onChange={(event) => {
                          setMovementTableQuery(event.target.value);
                          setMovementPage(1);
                        }}
                        placeholder={t("Buscar base, regional ou código")}
                      />
                    </label>
                  </div>
                </div>
                {visibleMovementTableRows.length > 0 ? (
                  <>
                    <div className="table-scroll movement-table-scroll">
                      <table className="dashboard-data-table">
                        <thead>
                          <tr>
                            {movementLoaded.displayColumns.map((column) => <th key={column}>{t(column)}</th>)}
                            <th>RM</th>
                            <th>RGM</th>
                          </tr>
                        </thead>
                        <tbody className="screen-table-body">
                          {visibleMovementTableRows.map((row) => (
                            <tr key={row.key}>
                              {movementLoaded.displayColumns.map((column) => (
                                <td
                                  className={typeof row.values[column] === "number" ? "number-cell" : column === movementLoaded.columns.base ? "base-cell" : undefined}
                                  key={column}
                                >
                                  {column === movementLoaded.columns.region ? (
                                    <span className="regional-chip">{row.region}</span>
                                  ) : (
                                    formatMovementCell(row.values[column])
                                  )}
                                </td>
                              ))}
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tbody className="print-table-body">
                          {movementTableRows.map((row) => (
                            <tr key={row.key}>
                              {movementLoaded.displayColumns.map((column) => (
                                <td
                                  className={typeof row.values[column] === "number" ? "number-cell" : column === movementLoaded.columns.base ? "base-cell" : undefined}
                                  key={column}
                                >
                                  {column === movementLoaded.columns.region ? (
                                    <span className="regional-chip">{row.region}</span>
                                  ) : (
                                    formatMovementCell(row.values[column])
                                  )}
                                </td>
                              ))}
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer">
                      <span>{t("Mostrando {from}–{to} de {total} bases", {
                        from: formatNumber((movementActivePage - 1) * PAGE_SIZE + 1),
                        to: formatNumber(Math.min(movementActivePage * PAGE_SIZE, movementTableRows.length)),
                        total: formatNumber(movementTableRows.length),
                      })}</span>
                      <div className="pagination" aria-label={t("Paginação da tabela de movimentação")}>
                        <button type="button" onClick={() => setMovementPage((value) => Math.max(1, value - 1))} disabled={movementActivePage === 1}>{t("Anterior")}</button>
                        <span>{t("Página {page} de {pages}", { page: movementActivePage, pages: movementPageCount })}</span>
                        <button type="button" onClick={() => setMovementPage((value) => Math.min(movementPageCount, value + 1))} disabled={movementActivePage === movementPageCount}>{t("Próxima")}</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="table-empty">
                    <Database size={28} />
                    <h3>{t("Nenhum dado encontrado")}</h3>
                    <p>{t("Ajuste a busca ou os filtros para visualizar os registros.")}</p>
                    <button type="button" onClick={() => resetMovementFilters()}>{t("Limpar filtros")}</button>
                  </div>
                )}
              </section>

              <footer className="dashboard-footer">
                <span><ShieldCheck size={15} /> {t("Última movimentação publicada disponível para todos pelo link")}</span>
                <span>{t("Arquivo: {file} · Atualizado em {date}", {
                  file: movementLoaded.fileName,
                  date: formatDateTime(movementLoaded.updatedAt),
                })}</span>
              </footer>
            </>
          )
        ) : view === "sellers" ? (
          !sellerReferenceLoaded || !sellerPerformanceLoaded ? (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><ShieldCheck size={15} /> {t("Sellers prioritários")}</div>
                  <h1>{t("Monitoramento J&T 重点保障")}</h1>
                  <p>{t("Carregue a lista oficial de sellers J&T 重点保障 e 单商多服 e depois o resumo JMS diário para acompanhar processamento por seller, regional e base.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo aguardando sellers")}>
                  <span><ShieldCheck size={16} /> {t("Lista oficial de sellers")}</span>
                  <span><Database size={16} /> {t("Resumo JMS")}</span>
                  <span><MapPin size={16} /> {t("Regional")}</span>
                  <span><PackageCheck size={16} /> {t("Seller")}</span>
                </div>
              </section>
              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}
              <div className={`filters-card upload-ready-card sellers-upload-card${sellerLoading ? " loading" : ""}`}>
                <div className="upload-ready-icon" aria-hidden="true">
                  <ShieldCheck size={26} />
                </div>
                <div>
                  <span className="card-eyebrow">{t("LISTA DE SELLERS IMPORTANTES")}</span>
                  <h2>{t(sellerReferenceLoaded ? "Lista oficial de sellers publicada" : "Publique a lista oficial de sellers")}</h2>
                  <p>{t("Use a planilha contendo global_seller_id e 重点保障商家类型, com as categorias J&T 重点保障 e 单商多服.")}</p>
                  {sellerReferenceLoaded ? (
                    <small>
                      {t("{count} sellers na lista", { count: formatNumber(sellerReferenceLoaded.records.length) })} · {sellerReferenceLoaded.fileName}
                    </small>
                  ) : null}
                </div>
                <label className="primary-upload-button" htmlFor="seller-list-upload">
                  <Upload size={18} />
                  {t(sellerReferenceLoaded ? "Atualizar lista oficial" : "Carregar lista oficial")}
                </label>
              </div>
              <div className={`filters-card upload-ready-card sellers-upload-card${sellerLoading ? " loading" : ""}`}>
                <div className="upload-ready-icon" aria-hidden="true">
                  <FileSpreadsheet size={26} />
                </div>
                <div>
                  <span className="card-eyebrow">{t("RESUMO JMS DIÁRIO")}</span>
                  <h2>{t(sellerPerformanceLoaded ? "Resumo JMS publicado" : "Publique o resumo JMS")}</h2>
                  <p>{t("Este é o arquivo abastecido diariamente para calcular aguardando coleta, processados e percentual de processamento.")}</p>
                </div>
                <label className={`primary-upload-button${!sellerReferenceLoaded ? " disabled" : ""}`} htmlFor={sellerReferenceLoaded ? "seller-performance-upload" : undefined}>
                  <Upload size={18} />
                  {t(sellerLoading ? "Processando…" : "Carregar resumo JMS")}
                </label>
              </div>
            </>
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><ShieldCheck size={15} /> {t("SELLERS {categories}", { categories: sellerCategoryLabel })}</div>
                  <h1>{t("Monitoramento {categories}", { categories: sellerCategoryLabel })}</h1>
                  <p>{t("Percentual de processamento por seller, categoria, regional e base. Sellers somente aguardando coleta aparecem com 0%.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo do arquivo de sellers")}>
                  <span><Layers3 size={16} /> {t("{count} linhas · {categories}", { count: formatNumber(sellerPerformanceLoaded.records.length), categories: sellerCategoryLabel })}</span>
                  <span><ShieldCheck size={16} /> {t("{count} sellers na lista", { count: formatNumber(sellerReferenceLoaded.records.length) })}</span>
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(sellerRegionOptions.length) })}</span>
                  <span><Database size={16} /> {t("{count} bases", { count: formatNumber(sellerPerformanceLoaded.bases.length) })}</span>
                  <span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(sellerPerformanceLoaded.updatedAt) })}</span>
                </div>
              </section>

              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              <section className="filters-card sellers-filters-card" aria-labelledby="seller-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="seller-filters-heading"><Filter size={18} /> {t("Filtros {categories}", { categories: sellerCategoryLabel })}</h2>
                  </div>
                  <div className="seller-file-actions">
                    <label className="secondary-upload-button" htmlFor="seller-list-upload"><Upload size={15} /> {t("Lista oficial de sellers")}</label>
                    <button
                      type="button"
                      className="reset-button"
                      onClick={() => resetSellerFilters()}
                      disabled={sellerFiltersAreDefault}
                    >
                      <RotateCcw size={15} /> {t("Limpar filtros")}
                    </button>
                  </div>
                </div>
                <div className="filter-grid sellers-filter-grid">
                  <MultiSelect
                    label={t("Seller")}
                    options={sellerOptionList}
                    selected={sellerSelectedSellers}
                    onChange={(value) => {
                      setSellerSelectedSellers(value);
                      setSellerPage(1);
                    }}
                    allLabel={t("Todos os sellers")}
                    singular={t("Seller")}
                    plural={t("Sellers")}
                    searchable
                    getOptionLabel={sellerOptionLabel}
                    t={t}
                  />
                  <MultiSelect
                    label={t("Categoria")}
                    options={SELLER_CATEGORIES.filter((tier) => sellerReferenceLoaded.tiers.includes(tier))}
                    selected={sellerSelectedTiers}
                    onChange={(value) => {
                      setSellerSelectedTiers(value);
                      setSellerSelectedSellers(new Set(sellerOptionsForFilters(sellerPerformanceLoaded, sellerSelectedRegions, sellerSelectedBases, value, responsibilityLoaded)));
                      setSellerPage(1);
                    }}
                    allLabel={t("Todas as categorias")}
                    singular={t("Categoria")}
                    plural={t("Categoria")}
                    getOptionLabel={(option) => t(option)}
                    t={t}
                  />
                  <MultiSelect
                    label={t("Regional")}
                    options={sellerRegionOptions}
                    selected={sellerSelectedRegions}
                    onChange={(value) => {
                      setSellerSelectedRegions(value);
                      const nextBases = new Set(sellerBasesForRegions(sellerPerformanceLoaded, value, responsibilityLoaded).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms)));
                      setSellerSelectedBases(nextBases);
                      setSellerSelectedSellers(new Set(sellerOptionsForFilters(sellerPerformanceLoaded, value, nextBases, sellerSelectedTiers, responsibilityLoaded)));
                      setSellerPage(1);
                    }}
                    allLabel={t("Todas as regionais")}
                    singular={t("Regional")}
                    plural={t("Regional")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={responsibilityFilterOptions.rms}
                    selected={selectedRms}
                    onChange={(value) => applyResponsibilityFilter("rm", value)}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={sellerBaseOptions}
                    selected={sellerSelectedBases}
                    onChange={(value) => {
                      setSellerSelectedBases(value);
                      setSellerSelectedSellers(new Set(sellerOptionsForFilters(sellerPerformanceLoaded, sellerSelectedRegions, value, sellerSelectedTiers, responsibilityLoaded)));
                      setSellerPage(1);
                    }}
                    allLabel={t("Todas as bases")}
                    singular={t("Base")}
                    plural={t("Bases")}
                    searchable
                    t={t}
                  />
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="seller-date-start">{t("Data inicial")}</label>
                    <input
                      className="date-input"
                      id="seller-date-start"
                      type="date"
                      min={sellerPerformanceLoaded.dates[0]}
                      max={sellerPerformanceLoaded.dates[sellerPerformanceLoaded.dates.length - 1]}
                      value={sellerDateStart}
                      onChange={(event) => {
                        setSellerDateStart(event.target.value);
                        setSellerPage(1);
                      }}
                    />
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="seller-date-end">{t("Data final")}</label>
                    <input
                      className="date-input"
                      id="seller-date-end"
                      type="date"
                      min={sellerPerformanceLoaded.dates[0]}
                      max={sellerPerformanceLoaded.dates[sellerPerformanceLoaded.dates.length - 1]}
                      value={sellerDateEnd}
                      onChange={(event) => {
                        setSellerDateEnd(event.target.value);
                        setSellerPage(1);
                      }}
                    />
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="seller-code-filter">{t("Código do seller")}</label>
                    <label className="text-filter-input">
                      <Search size={15} />
                      <input
                        id="seller-code-filter"
                        value={sellerCodeQuery}
                        onChange={(event) => {
                          setSellerCodeQuery(event.target.value);
                          setSellerPage(1);
                        }}
                        placeholder={t("Buscar código")}
                      />
                    </label>
                  </div>
                </div>
                {sellerDateIsInvalid ? (
                  <p className="date-error" role="alert">{t("A data inicial deve ser anterior ou igual à data final.")}</p>
                ) : null}
              </section>

              {sellerPerformanceLoaded.blankBaseRows > 0 ||
              sellerPerformanceLoaded.unknownSellerRows > 0 ||
              sellerPerformanceLoaded.missingSellerCount > 0 ? (
                <div className="quality-note">
                  <Info size={16} />
                  <span>
                    {[
                      sellerPerformanceLoaded.blankBaseRows > 0
                        ? t("{count} linha(s) sem base foram mantidas como “Sem base”.", {
                            count: formatNumber(sellerPerformanceLoaded.blankBaseRows),
                          })
                        : "",
                      sellerPerformanceLoaded.unknownSellerRows > 0
                        ? t("{count} linha(s) do resumo JMS não fazem parte da lista oficial de sellers.", {
                            count: formatNumber(sellerPerformanceLoaded.unknownSellerRows),
                          })
                        : "",
                      sellerPerformanceLoaded.missingSellerCount > 0
                        ? t("{count} seller(s) da lista não aparecem no resumo e foram mantidos com 0%.", {
                            count: formatNumber(sellerPerformanceLoaded.missingSellerCount),
                          })
                        : "",
                    ].filter(Boolean).join(" ")}
                  </span>
                </div>
              ) : null}

              <section className="kpi-grid" aria-label={t("Indicadores de sellers {categories}", { categories: sellerCategoryLabel })}>
                <KpiCard
                  icon={<Target size={20} />}
                  label={t("Processamento")}
                  value={formatRate(sellerSummary.rate)}
                  secondaryLabel={t("Volume coletado")}
                  secondaryValue={formatNumber(sellerSummary.processed)}
                  detail={t("{total} de volume total", {
                    total: formatNumber(sellerSummary.total),
                  })}
                />
                <KpiCard
                  icon={<CircleAlert size={20} />}
                  label={t("Aguardando coleta")}
                  value={formatCompact(sellerSummary.awaiting)}
                  detail={t("{count} pedidos pendentes", { count: formatNumber(sellerSummary.awaiting) })}
                  tone="orange"
                />
                <SellerOutcomeKpi
                  items={([
                    { outcome: "complete", ...sellerOutcomeSummary.complete },
                    { outcome: "partial", ...sellerOutcomeSummary.partial },
                    { outcome: "zero", ...sellerOutcomeSummary.zero },
                  ] as const).map((item) => ({
                    ...item,
                    label: t(SELLER_OUTCOME_LABELS[item.outcome]),
                  }))}
                  selected={sellerOutcomeFilter}
                  onSelect={showSellerOutcome}
                  t={t}
                />
                <KpiCard
                  icon={<Database size={20} />}
                  label={t("Bases")}
                  value={formatNumber(sellerSummary.activeBases)}
                  detail={t("{count} regional(is) no filtro", { count: formatNumber(sellerSummary.activeRegions) })}
                  tone="soft"
                />
              </section>

              <section className="charts-grid taxa-charts-grid">
                <article className="chart-card composition-card seller-regional-summary-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("REGIONAIS {categories}", { categories: sellerCategoryLabel })}</span>
                      <h2>{t("Relatório diário {categories}", { categories: sellerCategoryLabel })}</h2>
                    </div>
                    <div className="seller-rm-card-actions">
                      <span className="card-badge">{sellerPeriod}</span>
                      <button
                        className="table-download-button seller-rm-download-button"
                        type="button"
                        onClick={() => void downloadSellerManagementExcel()}
                        disabled={sellerRegionalPerformance.length === 0}
                      >
                        <FileSpreadsheet size={15} />
                        {t("Baixar Excel")}
                      </button>
                    </div>
                  </div>
                  {sellerRegionalPerformance.length > 0 ? (
                    <div className="seller-regional-table-wrap">
                      <table className="dashboard-data-table seller-regional-table">
                        <thead>
                          <tr>
                            <th>{t("Regional")}</th>
                            <th>RGM</th>
                            <th>{t("Aguardando coleta")}</th>
                            <th>{t("Volume coletado")}</th>
                            <th>{t("Volume total")}</th>
                            <th aria-sort="descending">{t("% Taxa de coleta")} <span aria-hidden="true">↓</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {sellerRegionalPerformance.map((regional) => (
                            <tr key={regional.key}>
                              <td><span className="regional-chip">{regional.region}</span></td>
                              <td>{regional.rgmLabel}</td>
                              <td className="number-cell awaiting-cell">{formatNumber(regional.awaiting)}</td>
                              <td className="number-cell">{formatNumber(regional.processed)}</td>
                              <td className="number-cell total-cell">{formatNumber(regional.total)}</td>
                              <td className={`number-cell rate-cell ${regional.rate >= SELLER_REGIONAL_RATE_TARGET ? "is-on-target" : "is-below-target"}`}>
                                {formatRate(regional.rate)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <th>{t("Total geral")}</th>
                            <td>—</td>
                            <td className="number-cell">{formatNumber(sellerSummary.awaiting)}</td>
                            <td className="number-cell">{formatNumber(sellerSummary.processed)}</td>
                            <td className="number-cell">{formatNumber(sellerSummary.total)}</td>
                            <td className={`number-cell rate-cell ${sellerSummary.rate >= SELLER_REGIONAL_RATE_TARGET ? "is-on-target" : "is-below-target"}`}>
                              {formatRate(sellerSummary.rate)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ) : (
                    <EmptyChart message={t("Nenhum volume regional encontrado para o período selecionado.")} />
                  )}
                </article>

                <article className="chart-card composition-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("STATUS DO PROCESSAMENTO")}</span>
                      <h2>{t("Composição {categories}", { categories: sellerCategoryLabel })}</h2>
                    </div>
                    <span className="card-badge">{t("{count} categoria(s)", { count: sellerSelectedTiers.size })}</span>
                  </div>
                  <div className="composition-list compact-origin-list">
                    {[
                      { label: t("Processados"), value: sellerSummary.processed, rate: sellerSummary.rate, color: "#e60000" },
                      { label: t("Aguardando coleta"), value: sellerSummary.awaiting, rate: safeRate(sellerSummary.awaiting, sellerSummary.total), color: "#f97316" },
                    ].map((item) => (
                      <div className="composition-row" key={item.label}>
                        <div className="composition-label">
                          <span><StatusDot color={item.color} /> {item.label}</span>
                          <strong>{formatRate(item.rate)}</strong>
                        </div>
                        <div className="horizontal-track">
                          <span style={{ width: `${Math.min(100, item.rate * 100)}%`, backgroundColor: item.color }} />
                        </div>
                        <small>{t("{count} pedidos", { count: formatNumber(item.value) })}</small>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="chart-card composition-card seller-rm-awaiting-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("BASES E RESPONSÁVEIS RM")}</span>
                      <h2>{t("Aguardando coleta por base e RM")}</h2>
                    </div>
                    <div className="seller-rm-card-actions">
                      <span className="card-badge">{sellerPeriod}</span>
                      <button
                        className="table-download-button seller-rm-download-button"
                        type="button"
                        onClick={downloadSellerManagementExcel}
                        disabled={sellerRmAwaitingSummary.length === 0}
                      >
                        <FileSpreadsheet size={15} />
                        {t("Baixar Excel")}
                      </button>
                    </div>
                  </div>
                  {sellerRmAwaitingSummary.length > 0 ? (
                    <div className="seller-regional-table-wrap seller-rm-awaiting-table-wrap">
                      <table className="dashboard-data-table seller-regional-table seller-rm-awaiting-table">
                        <thead>
                          <tr>
                            <th>{t("Base")}</th>
                            <th>{t("Responsável do RM")}</th>
                            <th>RGM</th>
                            <th aria-sort="descending">{t("Pedidos aguardando coleta")} <span aria-hidden="true">↓</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="seller-rm-total-row">
                            <th>{t("Total geral")}</th>
                            <td>—</td>
                            <td>—</td>
                            <td className="number-cell">{formatNumber(sellerSummary.awaiting)}</td>
                          </tr>
                          {sellerRmAwaitingSummary.map((item) => (
                            <tr key={`${item.base}::${item.rm}`}>
                              <td><strong>{item.base}</strong></td>
                              <td><strong>{item.rm}</strong></td>
                              <td><strong>{responsibilityForBase(responsibilityLoaded, item.base).rgm}</strong></td>
                              <td className="number-cell awaiting-cell">{formatNumber(item.awaiting)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyChart message={t("Nenhum pedido aguardando coleta por base e RM para os filtros selecionados.")} />
                  )}
                </article>

                <article className="chart-card composition-card seller-below-target-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("SEM COLETA")}</span>
                      <h2>{t("TOP 10 sellers com pedidos sem coleta")}</h2>
                    </div>
                    <span className="card-badge">{t("0% · maior aguardando")}</span>
                  </div>
                  {topSellersWithoutCollection.length > 0 ? (
                    <div className="critical-bases-list seller-top-list">
                      {topSellersWithoutCollection.map((seller, index) => (
                        <article className="critical-base-row is-critical" key={seller.key}>
                          <div className="critical-base-rank">{index + 1}</div>
                          <div className="critical-base-main">
                            <strong>{seller.sellerName}</strong>
                            <span>{seller.tierLabel} · {seller.sellerCode} · {seller.region} · {seller.base}</span>
                            <div className="horizontal-track">
                              <span
                                style={{
                                  width: `${Math.max(4, safeRate(seller.awaiting, maxSellerAwaitingWithoutCollection) * 100)}%`,
                                  backgroundColor: "#e60000",
                                }}
                              />
                            </div>
                          </div>
                          <div className="critical-base-metrics">
                            <strong>{formatRate(seller.rate)}</strong>
                            <span>{t("{count} volume", { count: formatNumber(seller.total) })}</span>
                            <small>
                              {t("{processed} processados · {awaiting} aguardando", {
                                processed: formatNumber(seller.processed),
                                awaiting: formatNumber(seller.awaiting),
                              })}
                            </small>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyChart message={t("Nenhum seller com pedidos aguardando e sem coleta para os filtros selecionados.")} />
                  )}
                </article>
              </section>

              <section className="table-card" id="seller-detail-section" aria-labelledby="seller-detail-heading">
                <div className="table-card-top">
                  <div>
                    <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                    <h2 id="seller-detail-heading" ref={sellerDetailHeadingRef} tabIndex={-1}>
                      {t("Processamento por {mode}", {
                        mode: t(sellerReportMode === "seller" ? "Seller" : sellerReportMode === "base" ? "Base" : "Regional"),
                      })}
                    </h2>
                    <p>
                      {sellerOutcomeFilter
                        ? t("Exibindo sellers com resultado {result}; resultados ordenados do maior para o menor “Aguardando coleta”.", {
                            result: t(SELLER_OUTCOME_LABELS[sellerOutcomeFilter]),
                          })
                        : t("Alterne a consolidação sem perder os filtros aplicados; resultados ordenados do maior para o menor “Aguardando coleta”.")}
                    </p>
                  </div>
                  <div className="seller-report-controls">
                    <button className="table-download-button" type="button" onClick={downloadSellerManagementExcel} disabled={sellerTableRows.length === 0}>
                      <FileSpreadsheet size={17} />
                      {t("Baixar Excel")}
                    </button>
                    {sellerOutcomeFilter ? (
                      <button
                        type="button"
                        className="seller-outcome-filter-chip"
                        onClick={() => {
                          setSellerOutcomeFilter(null);
                          setSellerPage(1);
                        }}
                        aria-label={t("Remover filtro de resultado {result}", {
                          result: t(SELLER_OUTCOME_LABELS[sellerOutcomeFilter]),
                        })}
                      >
                        {t("Resultado: {result} · {count} sellers", {
                          result: t(SELLER_OUTCOME_LABELS[sellerOutcomeFilter]),
                          count: formatNumber(sellerTableRows.length),
                        })}
                        <X size={13} aria-hidden="true" />
                      </button>
                    ) : null}
                    <div className="seller-report-mode" role="group" aria-label={t("Agrupar relatório por")}>
                      {([
                        ["seller", "Seller"],
                        ["base", "Base"],
                        ["regional", "Regional"],
                      ] as const).map(([mode, label]) => (
                        <button
                          type="button"
                          key={mode}
                          className={sellerReportMode === mode ? "is-active" : ""}
                          aria-pressed={sellerReportMode === mode}
                          onClick={() => {
                            setSellerReportMode(mode);
                            if (mode !== "seller") setSellerOutcomeFilter(null);
                            setSellerTableQuery("");
                            setSellerPage(1);
                          }}
                        >
                          {t(label)}
                        </button>
                      ))}
                    </div>
                    <label className="table-search">
                      <Search size={16} />
                      <span className="sr-only">{t("Buscar no relatório de sellers")}</span>
                      <input
                        value={sellerTableQuery}
                        onChange={(event) => {
                          setSellerTableQuery(event.target.value);
                          setSellerPage(1);
                        }}
                        placeholder={sellerReportMode === "seller"
                          ? t("Buscar seller ou código")
                          : t("Buscar {items}", {
                              items: t(sellerReportMode === "base" ? "Base" : "Regional"),
                            })}
                      />
                    </label>
                  </div>
                </div>
                {visibleSellerTableRows.length > 0 ? (
                  <>
                    <div className="table-scroll">
                      <table className="dashboard-data-table">
                        <thead>
                          <SellerReportTableHead mode={sellerReportMode} t={t} />
                        </thead>
                        <tbody className="screen-table-body">
                          <SellerReportTableRows mode={sellerReportMode} rows={visibleSellerTableRows} />
                        </tbody>
                        <tbody className="print-table-body">
                          <SellerReportTableRows mode={sellerReportMode} rows={sellerTableRows} />
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer">
                      <span>
                        {t("Mostrando {start}–{end} de {total} {items}", {
                          start: formatNumber((sellerActivePage - 1) * PAGE_SIZE + 1),
                          end: formatNumber(Math.min(sellerActivePage * PAGE_SIZE, sellerTableRows.length)),
                          total: formatNumber(sellerTableRows.length),
                          items: t(sellerReportMode === "seller" ? "Sellers" : sellerReportMode === "base" ? "Bases" : "Regional"),
                        })}
                      </span>
                      <div className="pagination" aria-label={t("Paginação do relatório {categories}", { categories: sellerCategoryLabel })}>
                        <button type="button" onClick={() => setSellerPage((value) => Math.max(1, value - 1))} disabled={sellerActivePage === 1}>{t("Anterior")}</button>
                        <span>{t("Página {page} de {pages}", { page: sellerActivePage, pages: sellerPageCount })}</span>
                        <button type="button" onClick={() => setSellerPage((value) => Math.min(sellerPageCount, value + 1))} disabled={sellerActivePage === sellerPageCount}>{t("Próxima")}</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="table-empty">
                    <Database size={28} />
                    <h3>{t("Nenhum resultado encontrado")}</h3>
                    <p>
                      {sellerOutcomeFilter
                        ? t("Nenhum seller com resultado {result} nos filtros atuais.", {
                            result: t(SELLER_OUTCOME_LABELS[sellerOutcomeFilter]),
                          })
                        : t("Ajuste categoria, regional, base ou código do seller.")}
                    </p>
                    <button
                      type="button"
                      onClick={() => sellerOutcomeFilter ? setSellerOutcomeFilter(null) : resetSellerFilters()}
                    >
                      {t(sellerOutcomeFilter ? "Remover filtro de resultado" : "Limpar filtros")}
                    </button>
                  </div>
                )}
              </section>

              <footer className="dashboard-footer">
                <span><ShieldCheck size={15} /> {t("Último resumo JMS {categories} publicado disponível para todos pelo link", { categories: sellerCategoryLabel })}</span>
                <span>{t("Resumo: {summary} · Lista: {list}", {
                  summary: sellerPerformanceLoaded.fileName,
                  list: sellerReferenceLoaded.fileName,
                })}</span>
              </footer>
            </>
          )
        ) : view === "epop" ? (
          !epopLoaded ? (
            <>
              <section className="dashboard-intro"><div><div className="eyebrow"><Check size={15} /> EPOP / ePOD</div><h1>{t("Cobertura EPOP")}</h1><p>{t("Carregue o relatório EPOP para acompanhar a cobertura de comprovantes TikTok.")}</p></div></section>
              {error ? <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{t(error)}</span><button type="button" onClick={() => setError(null)}><X size={16} /></button></div> : null}
              <div className={`filters-card upload-ready-card${epopLoading ? " loading" : ""}`}><div className="upload-ready-icon"><FileSpreadsheet size={26} /></div><div><span className="card-eyebrow">EPOP / ePOD</span><h2>{epopLoading ? t("Processando relatório EPOP...") : t("Publique o relatório EPOP")}</h2><p>{t("A taxa usa somente sellers TikTok elegíveis: regional preenchida, base ativa no RJ, ID válido e quantidade coletada maior que zero.")}</p></div><label className="primary-upload-button" htmlFor="epop-upload"><Upload size={18} />{t("Selecionar planilha")}</label></div>
            </>
          ) : (() => {
            const rows = epopLoaded.records.filter((row) => row.date >= epopDateStart && row.date <= epopDateEnd && epopSelectedRegions.has(row.region) && epopSelectedBases.has(row.base) && selectedRms.has(responsibilityForBase(responsibilityLoaded, row.base).rm) && selectedRgms.has(responsibilityForBase(responsibilityLoaded, row.base).rgm));
            const grouped = new Map<string, EpopRecord[]>(); rows.forEach((row) => { const key = `${row.date}::${row.sellerId}`; grouped.set(key, [...(grouped.get(key) ?? []), row]); });
            const sellers = [...grouped.values()].map((items) => ({ ...items[0], eligible: items.some((item) => item.eligible), epop: items.some((item) => item.eligible && item.epop), collected: items.reduce((sum, item) => sum + item.collected, 0) }));
            const eligible = sellers.filter((row) => row.eligible); const withEpop = eligible.filter((row) => row.epop); const without = eligible.filter((row) => !row.epop); const rate = eligible.length ? withEpop.length / eligible.length : 0;
const byRegional = [...new Set(eligible.map((row) => row.region))].map((region) => { const items = eligible.filter((row) => row.region === region); const yes = items.filter((row) => row.epop).length; const responsibility = responsibilityForBase(responsibilityLoaded, items[0]?.base ?? ""); return { region, rm: responsibility.rm, rgm: responsibility.rgm, eligible: items.length, yes, no: items.length - yes, collected: items.reduce((sum, row) => sum + row.collected, 0), rate: items.length ? yes / items.length : 0 }; }).sort((a,b) => b.no-a.no || a.rate-b.rate);
            const byBase = [...new Set(eligible.map((row) => `${row.region}\u0000${row.base}`))].map((key) => {
              const [region, base] = key.split("\u0000");
              const items = eligible.filter((row) => row.region === region && row.base === base);
              const yes = items.filter((row) => row.epop).length;
              const responsibility = responsibilityForBase(responsibilityLoaded, base);
              return { region, base, rmArea: rmAreaForBase(responsibilityLoaded, base), rm: responsibility.rm, rgm: responsibility.rgm, eligible: items.length, yes, no: items.length - yes, collected: items.reduce((sum, row) => sum + row.collected, 0), rate: safeRate(yes, items.length) };
            }).sort((a, b) => b.no - a.no || a.rate - b.rate || b.collected - a.collected);
            const summarizeOwner = (key: "rm" | "rgm") => [...new Set(byRegional.map((row) => row[key]))].map((owner) => { const items = byRegional.filter((row) => row[key] === owner); const eligibleCount = items.reduce((sum, row) => sum + row.eligible, 0); const yes = items.reduce((sum, row) => sum + row.yes, 0); return { owner, eligible: eligibleCount, yes, no: eligibleCount - yes, collected: items.reduce((sum, row) => sum + row.collected, 0), rate: eligibleCount ? yes / eligibleCount : 0 }; }).sort((a,b) => b.no-a.no || a.rate-b.rate);
            const byRm = summarizeOwner("rm"); const byRgm = summarizeOwner("rgm");
            const matrixDates = epopDailyPeriod.map((point) => point.date).slice(-7);
            const buildMatrix = (level: "regional" | "rm") => {
              const groups = new Map<string, { label: string; rm: string; rgm: string; values: Map<string, Map<string, { eligible: boolean; epop: boolean }>> }>();
              for (const row of rows) {
                const responsibility = responsibilityForBase(responsibilityLoaded, row.base);
                const label = level === "regional" ? row.region : `${rmAreaForBase(responsibilityLoaded, row.base)}\u0000${responsibility.rm}\u0000${responsibility.rgm}`;
                const group = groups.get(label) ?? { label, rm: responsibility.rm, rgm: responsibility.rgm, values: new Map() };
                const daily = group.values.get(row.date) ?? new Map(); const current = daily.get(row.sellerId) ?? { eligible: false, epop: false };
                current.eligible ||= row.eligible; current.epop ||= row.eligible && row.epop; daily.set(row.sellerId, current); group.values.set(row.date, daily); groups.set(label, group);
              }
              return [...groups.values()].map((group) => ({ ...group, daily: matrixDates.map((date) => { const values = [...(group.values.get(date)?.values() ?? [])].filter((value) => value.eligible); const yes = values.filter((value) => value.epop).length; return { eligible: values.length, rate: safeRate(yes, values.length) }; }) })).sort((a, b) => (a.daily.at(-1)?.rate ?? 0) - (b.daily.at(-1)?.rate ?? 0));
            };
            const regionalMatrix = buildMatrix("regional"); const rmMatrix = buildMatrix("rm");
            return <>
              <section className="filters-card taxa-filters-card epop-primary-filters" aria-label={t("Filtros operacionais EPOP")}>
                <div className="filters-card-top"><h2><Filter size={18} /> {t("Filtros operacionais")}</h2><button type="button" className="reset-button" onClick={() => { setEpopSelectedRegions(new Set(epopLoaded.regions)); setEpopSelectedBases(new Set(epopLoaded.bases)); setEpopDateStart(epopLoaded.dates[0] ?? ""); setEpopDateEnd(epopLoaded.dates.at(-1) ?? ""); }}><RotateCcw size={15} /> {t("Limpar filtros")}</button></div>
                <div className="filter-grid taxa-filter-grid">
                  <MultiSelect label={t("Regional")} options={epopLoaded.regions} selected={epopSelectedRegions} onChange={setEpopSelectedRegions} allLabel={t("Todas as regionais")} singular={t("regional")} plural={t("regionais")} searchable t={t}/>
                  <MultiSelect label="RM" options={responsibilityFilterOptions.rms} selected={selectedRms} onChange={(value) => setSelectedRms(value)} allLabel={t("Todos os RM")} singular="RM" plural="RM" searchable t={t}/>
                  <MultiSelect label={t("Região do RM")} options={responsibilityFilterOptions.rgms} selected={selectedRgms} onChange={(value) => setSelectedRgms(value)} allLabel={t("Todas as regiões do RM")} singular={t("região do RM")} plural={t("regiões do RM")} searchable t={t}/>
                  <MultiSelect label={t("Base")} options={epopLoaded.bases} selected={epopSelectedBases} onChange={setEpopSelectedBases} allLabel={t("Todas as bases")} singular={t("base")} plural={t("bases")} searchable t={t}/>
                  <div className="filter-field date-field"><label className="filter-label">{t("Data inicial")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateStart} min={epopLoaded.dates[0]} max={epopLoaded.dates.at(-1)} onChange={(event) => setEpopDateStart(event.target.value)} /></div></div>
                  <div className="filter-field date-field"><label className="filter-label">{t("Data final")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateEnd} min={epopDateStart} max={epopLoaded.dates.at(-1)} onChange={(event) => setEpopDateEnd(event.target.value)} /></div></div>
                </div>
              </section>
              <section className="dashboard-intro"><div><div className="eyebrow"><Check size={15} /> EPOP / ePOD</div><h1>{t("Cobertura EPOP")}</h1><p>{t("Brasil → Região RM → RM → Regional → Base → Seller")}</p></div><div className="dataset-meta"><span><Layers3 size={16} /> {t("{count} linhas", {count: formatNumber(epopLoaded.records.length)})}</span><span><CalendarDays size={16} /> {t("Última atualização: {date}", {date: formatDateTime(epopLoaded.updatedAt)})}</span></div></section>
              {epopHistoryNotice ? <div className="inline-alert success" role="status"><Check size={18} /><span>{t("Histórico EPOP atualizado: {added} nova(s) data(s), {replaced} data(s) atualizada(s) e {total} data(s) disponíveis nos filtros.", { added: formatNumber(epopHistoryNotice.addedDates), replaced: formatNumber(epopHistoryNotice.replacedDates), total: formatNumber(epopHistoryNotice.totalDates) })}</span><button type="button" onClick={() => setEpopHistoryNotice(null)} aria-label={t("Fechar aviso")}><X size={16} /></button></div> : null}
              <section className="filters-card taxa-filters-card"><div className="filters-card-top"><h2><Filter size={18} /> {t("Filtros operacionais")}</h2><button type="button" className="reset-button" onClick={() => { setEpopSelectedRegions(new Set(epopLoaded.regions)); setEpopSelectedBases(new Set(epopLoaded.bases)); setEpopDateStart(epopLoaded.dates[0] ?? ""); setEpopDateEnd(epopLoaded.dates.at(-1) ?? ""); }}><RotateCcw size={15} /> {t("Limpar filtros")}</button></div><div className="filter-grid taxa-filter-grid"><MultiSelect label={t("Regional")} options={epopLoaded.regions} selected={epopSelectedRegions} onChange={setEpopSelectedRegions} allLabel={t("Todas as regionais")} singular={t("regional")} plural={t("regionais")} searchable t={t}/><MultiSelect label={t("Base")} options={epopLoaded.bases.filter((base) => epopLoaded.records.some((row) => row.base === base && epopSelectedRegions.has(row.region)))} selected={epopSelectedBases} onChange={setEpopSelectedBases} allLabel={t("Todas as bases")} singular={t("base")} plural={t("bases")} searchable t={t}/><div className="filter-field date-field"><label className="filter-label">{t("Data inicial")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateStart} onChange={(e) => setEpopDateStart(e.target.value)} /></div></div><div className="filter-field date-field"><label className="filter-label">{t("Data final")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateEnd} onChange={(e) => setEpopDateEnd(e.target.value)} /></div></div></div></section>
              <section className="kpi-grid"><KpiCard icon={<Target size={20}/>} label={t("Taxa EPOP")} value={formatRate(rate)} detail={t("Meta: 100%")}/><KpiCard icon={<ShieldCheck size={20}/>} label={t("Sellers elegíveis")} value={formatNumber(eligible.length)} detail={t("有效商家数")}/><KpiCard icon={<Check size={20}/>} label={t("Sellers com EPOP")} value={formatNumber(withEpop.length)} detail={t("已有EPOP商家")} tone="orange"/><KpiCard icon={<CircleAlert size={20}/>} label={t("Sellers sem EPOP")} value={formatNumber(without.length)} detail={t("Gap para 100%: {count}", {count: formatNumber(without.length)})} tone="soft"/></section>
              <section className="charts-grid epop-standard-layout">
                <article className="chart-card taxa-poc-card epop-regional-panel">
                  <div className="card-heading">
                    <div><span className="card-eyebrow">EPOP</span><h2>{t("Taxa EPOP por regional — período selecionado")}</h2><p>{t("Visão diária de até 7 dias; o último dia define a ordenação.")}</p></div>
                    <button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(regionalMatrix, [{ header: t("Regional"), value: (item) => item.label }, { header: "RGM", value: (item) => item.rgm }, ...matrixDates.map((date, index) => ({ header: formatDate(date, true), value: (item) => item.daily[index]?.rate ?? 0, numberFormat: "0.0%" }))], t("Taxa EPOP por regional"), "epop_por_regional.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button>
                  </div>
                  <div className="taxa-poc-table-wrap"><table className="dashboard-data-table taxa-poc-table taxa-poc-regional-rgm-table"><thead><tr><th className="taxa-poc-region-column">{t("Regional")}</th><th className="taxa-poc-rgm-column">RGM</th>{matrixDates.map((date) => <th className="taxa-poc-date-header taxa-poc-day-column" key={date}><span>{formatDate(date, true)}</span></th>)}</tr></thead><tbody>{regionalMatrix.map((item) => <tr key={item.label}><th><span>{item.label}</span></th><td><span>{item.rgm}</span></td>{item.daily.map((point, index) => <td key={matrixDates[index]}><strong className={point.eligible === 0 ? "empty" : point.rate >= .98 ? "ok" : point.rate >= .9 ? "watch" : "alert"}>{point.eligible ? formatRate(point.rate) : "—"}</strong></td>)}</tr>)}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th>{matrixDates.map((date) => { const point = epopDailyPeriod.find((entry) => entry.date === date); return <td key={date}><strong>{point?.eligible ? formatRate(point.rate) : "—"}</strong></td>; })}</tr></tfoot></table></div>
                  <div className="epop-line-section"><h3>{t("Resultado geral do período selecionado")}</h3><div className="taxa-poc-line-chart"><svg viewBox="0 0 700 180" preserveAspectRatio="xMidYMid meet"><line className="chart-axis-line" x1="40" y1="20" x2="40" y2="144"/><line className="chart-axis-line" x1="40" y1="144" x2="686" y2="144"/><line className="target-line" x1="40" y1="20" x2="686" y2="20"/><polyline className="attempt-line" points={epopDailyPeriod.map((point, index) => `${40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1))},${20 + (1 - point.rate) * 124}`).join(" ")}/>{epopDailyPeriod.map((point, index) => { const x = 40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1)); const y = 20 + (1 - point.rate) * 124; return <g key={point.date}><circle className={point.rate >= .98 ? "attempt-point ok" : "attempt-point alert"} cx={x} cy={y} r="4"/><text className={point.rate >= .98 ? "attempt-value-label ok" : "attempt-value-label alert"} x={x} y={Math.max(12, y - 8)} textAnchor="middle">{formatRate(point.rate)}</text><text className="attempt-date-label" x={x} y="164" textAnchor="middle">{formatDate(point.date, true)}</text></g>; })}</svg></div></div>
                </article>
                <article className="chart-card taxa-poc-card epop-rm-panel">
                  <div className="card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Taxa EPOP por RM — período selecionado")}</h2><p>{t("Responsável do RM e RGM conforme o cadastro das bases.")}</p></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(rmMatrix, [{ header: t("Região do RM"), value: (item) => item.label.split("\u0000")[0] }, { header: "RM", value: (item) => item.label.split("\u0000")[1] }, { header: "RGM", value: (item) => item.label.split("\u0000")[2] }, ...matrixDates.map((date, index) => ({ header: formatDate(date, true), value: (item) => item.daily[index]?.rate ?? 0, numberFormat: "0.0%" }))], t("Taxa EPOP por RM"), "epop_por_rm.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button></div>
                  <div className="taxa-poc-table-wrap epop-rm-table-wrap"><table className="dashboard-data-table taxa-poc-table epop-rm-table"><thead><tr><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th>{matrixDates.map((date) => <th className="taxa-poc-date-header" key={date}><span>{formatDate(date, true)}</span></th>)}</tr></thead><tbody>{rmMatrix.map((item) => { const [area, rm, rgm] = item.label.split("\u0000"); return <tr key={item.label}><th><span>{area || t("Sem região do RM")}</span></th><td><span>{rm || t("Sem RM")}</span></td><td><span>{rgm || t("Sem RGM")}</span></td>{item.daily.map((point, index) => <td key={matrixDates[index]}><strong className={point.eligible === 0 ? "empty" : point.rate >= .98 ? "ok" : point.rate >= .9 ? "watch" : "alert"}>{point.eligible ? formatRate(point.rate) : "—"}</strong></td>)}</tr>; })}</tbody><tfoot><tr><th colSpan={3}>{t("Total geral")}</th>{matrixDates.map((date) => { const point = epopDailyPeriod.find((entry) => entry.date === date); return <td key={date}><strong>{point?.eligible ? formatRate(point.rate) : "—"}</strong></td>; })}</tr></tfoot></table></div>
                </article>
              </section>
              <section className="chart-card epop-base-panel">
                <div className="card-heading">
                  <div><span className="card-eyebrow">BASES</span><h2>{t("Resultado EPOP por base")}</h2><p>{t("Consolidado para acompanhamento do RM e RGM no período selecionado.")}</p></div>
                  <button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(byBase, [
                    { header: t("Regional"), value: (item) => item.region },
                    { header: t("Base"), value: (item) => item.base },
                    { header: t("Região do RM"), value: (item) => item.rmArea },
                    { header: "RM", value: (item) => item.rm },
                    { header: "RGM", value: (item) => item.rgm },
                    { header: t("Sellers elegíveis"), value: (item) => item.eligible },
                    { header: t("Com EPOP"), value: (item) => item.yes },
                    { header: t("Sem EPOP"), value: (item) => item.no },
                    { header: t("Taxa EPOP"), value: (item) => item.rate, numberFormat: "0.0%" },
                    { header: t("Quantidade coletada"), value: (item) => item.collected },
                  ], t("Resultado EPOP por base"), "epop_por_base.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button>
                </div>
                <div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Elegíveis")}</th><th>{t("Com EPOP")}</th><th>{t("Sem EPOP")}</th><th>{t("Taxa EPOP")}</th><th>{t("Quantidade coletada")}</th></tr></thead><tbody>{byBase.map((item) => <tr key={`${item.region}-${item.base}`}><td>{item.region}</td><th>{item.base}</th><td>{item.rmArea}</td><td>{item.rm}</td><td>{item.rgm}</td><td>{formatNumber(item.eligible)}</td><td>{formatNumber(item.yes)}</td><td>{formatNumber(item.no)}</td><td><strong className={item.rate >= .98 ? "ok" : item.rate >= .9 ? "watch" : "alert"}>{formatRate(item.rate)}</strong></td><td>{formatNumber(item.collected)}</td></tr>)}</tbody></table></div>
              </section>
              <section className="chart-card epop-seller-panel">
                <div className="card-heading"><div><span className="card-eyebrow">SELLERS</span><h2>{t("Sellers sem EPOP")}</h2><p>{t("Detalhe auditável disponível para exportação.")}</p></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(without, [{ header: t("Data"), value: (item) => formatDate(item.date) }, { header: t("Regional"), value: (item) => item.region }, { header: t("Base"), value: (item) => item.base }, { header: t("ID Seller"), value: (item) => item.sellerId }, { header: t("Quantidade coletada"), value: (item) => item.collected }], t("Sellers sem EPOP"), "epop_sellers_sem_epop.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button></div>
                <div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>{t("Data")}</th><th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("ID Seller")}</th><th>{t("Quantidade coletada")}</th></tr></thead><tbody>{without.sort((a, b) => b.collected - a.collected).slice(0, 100).map((item) => <tr key={`${item.date}-${item.sellerId}`}><td>{formatDate(item.date)}</td><td>{item.region}</td><td>{item.base}</td><td>{item.sellerId}</td><td>{formatNumber(item.collected)}</td></tr>)}</tbody></table></div>
              </section>
              <section className="charts-grid"><article className="chart-card"><div className="card-heading"><div><span className="card-eyebrow">EPOP覆盖率</span><h2>{t("Prioridades por regional")}</h2><p>{t("Sellers elegíveis sem comprovante EPOP.")}</p></div></div><div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>{t("Regional")}</th><th>{t("Sellers elegíveis")}</th><th>{t("Com EPOP")}</th><th>{t("Sem EPOP")}</th><th>{t("Taxa EPOP")}</th><th>{t("Quantidade coletada")}</th></tr></thead><tbody>{byRegional.map((row) => <tr key={row.region}><th>{row.region}</th><td>{formatNumber(row.eligible)}</td><td>{formatNumber(row.yes)}</td><td>{formatNumber(row.no)}</td><td><strong className={row.rate === 1 ? "ok" : row.rate >= .98 ? "watch" : "alert"}>{formatRate(row.rate)}</strong></td><td>{formatNumber(row.collected)}</td></tr>)}</tbody></table></div></article><article className="chart-card"><div className="card-heading"><div><span className="card-eyebrow">SELLERS</span><h2>{t("Sellers sem EPOP")}</h2><p>{t("Lista auditável, ordenada por volume coletado.")}</p></div></div><div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>{t("Data")}</th><th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("ID Seller")}</th><th>{t("Quantidade coletada")}</th></tr></thead><tbody>{without.sort((a,b) => b.collected-a.collected).slice(0, 15).map((row) => <tr key={`${row.date}-${row.sellerId}`}><td>{formatDate(row.date)}</td><td>{row.region}</td><td>{row.base}</td><td>{row.sellerId}</td><td>{formatNumber(row.collected)}</td></tr>)}</tbody></table></div></article></section>
              <section className="charts-grid"><article className="chart-card"><div className="card-heading"><div><span className="card-eyebrow">RGM</span><h2>{t("Taxa EPOP por RGM")}</h2></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(byRgm, [{ header: "RGM", value: (row) => row.owner }, { header: t("Sellers elegíveis"), value: (row) => row.eligible }, { header: t("Com EPOP"), value: (row) => row.yes }, { header: t("Sem EPOP"), value: (row) => row.no }, { header: t("Taxa EPOP"), value: (row) => row.rate, numberFormat: "0.0%" }], t("Taxa EPOP por RGM"), "epop_por_rgm.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button></div><div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>RGM</th><th>{t("Elegíveis")}</th><th>{t("Com EPOP")}</th><th>{t("Sem EPOP")}</th><th>{t("Taxa EPOP")}</th></tr></thead><tbody>{byRgm.map((row) => <tr key={row.owner}><th>{row.owner}</th><td>{formatNumber(row.eligible)}</td><td>{formatNumber(row.yes)}</td><td>{formatNumber(row.no)}</td><td>{formatRate(row.rate)}</td></tr>)}</tbody></table></div></article><article className="chart-card"><div className="card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Taxa EPOP por RM")}</h2></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(byRm, [{ header: "RM", value: (row) => row.owner }, { header: t("Sellers elegíveis"), value: (row) => row.eligible }, { header: t("Com EPOP"), value: (row) => row.yes }, { header: t("Sem EPOP"), value: (row) => row.no }, { header: t("Taxa EPOP"), value: (row) => row.rate, numberFormat: "0.0%" }], t("Taxa EPOP por RM"), "epop_por_rm.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button></div><div className="table-wrap"><table className="dashboard-data-table"><thead><tr><th>RM</th><th>{t("Elegíveis")}</th><th>{t("Com EPOP")}</th><th>{t("Sem EPOP")}</th><th>{t("Taxa EPOP")}</th></tr></thead><tbody>{byRm.map((row) => <tr key={row.owner}><th>{row.owner}</th><td>{formatNumber(row.eligible)}</td><td>{formatNumber(row.yes)}</td><td>{formatNumber(row.no)}</td><td>{formatRate(row.rate)}</td></tr>)}</tbody></table></div></article></section>
              <section className="chart-card epop-trend-card">
                <div className="card-heading"><div><span className="card-eyebrow">RESULTADO GERAL</span><h2>{t("Taxa EPOP — período selecionado")}</h2><p>{t("Evolução diária da cobertura EPOP.")}</p></div><span className="card-badge">{t("Meta 100%")}</span></div>
                <div className="taxa-poc-line-chart"><svg viewBox="0 0 700 180" preserveAspectRatio="xMidYMid meet"><line className="chart-axis-line" x1="40" y1="20" x2="40" y2="144"/><line className="chart-axis-line" x1="40" y1="144" x2="686" y2="144"/><line className="target-line" x1="40" y1="20" x2="686" y2="20"/><polyline className="attempt-line" points={epopDailyPeriod.map((point, index) => `${40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1))},${20 + (1 - point.rate) * 124}`).join(" ")}/>{epopDailyPeriod.map((point, index) => { const x = 40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1)); const y = 20 + (1 - point.rate) * 124; return <g key={point.date}><circle className={point.rate === 1 ? "attempt-point ok" : "attempt-point alert"} cx={x} cy={y} r="4"/><text className="attempt-value-label alert" x={x} y={Math.max(12, y - 8)} textAnchor="middle">{formatRate(point.rate)}</text><text className="attempt-date-label" x={x} y="164" textAnchor="middle">{formatDate(point.date, true)}</text></g>; })}</svg></div>
              </section>
            </>;
          })()
        ) : view === "taxa" ? (
          !taxaLoaded ? (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><Target size={15} /> {t("Performance")}</div>
                  <h1>{t("Taxa de coleta")}</h1>
                  <p>{t("Carregue o Excel de taxa de coleta para acompanhar performance por regional, base, origem e período.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo aguardando taxa")}>
                  <span><TrendingUp size={16} /> {t("Taxa de coleta")}</span>
                  <span><MapPin size={16} /> {t("Regional")}</span>
                  <span><Database size={16} /> {t("Base")}</span>
                  <span><PackageCheck size={16} /> {t("Origem")}</span>
                </div>
              </section>
              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}
              <div className={`filters-card upload-ready-card${taxaLoading ? " loading" : ""}`}>
                <div className="upload-ready-icon" aria-hidden="true">
                  <FileSpreadsheet size={26} />
                </div>
                <div>
                  <span className="card-eyebrow">{t("ARQUIVO DE TAXA DE COLETA")}</span>
                  <h2>{taxaLoading ? t("Buscando última atualização...") : t("Publique o Excel de taxa")}</h2>
                  <p>{t("Na primeira carga, selecione até duas planilhas. Depois, envie o arquivo diário: o histórico permanece salvo e somente datas repetidas são atualizadas.")}</p>
                </div>
                <label className="primary-upload-button" htmlFor="taxa-upload">
                  <Upload size={18} />
                  {taxaLoading ? t("Processando…") : t("Selecionar planilha(s)")}
                </label>
              </div>
            </>
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><Target size={15} /> {t("Performance de coleta")}</div>
                  <h1>{t("Taxa de coleta")}</h1>
                  <p>{t("Painel gerencial por regional, base, origem do pedido e período.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo do arquivo de taxa")}>
                  <span><Layers3 size={16} /> {t("{count} linhas", { count: formatNumber(taxaLoaded.records.length) })}</span>
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(taxaRegionOptions.length) })}</span>
                  <span><Database size={16} /> {t("{count} bases", { count: formatNumber(taxaLoaded.bases.length) })}</span>
                  <span><PackageCheck size={16} /> {t("{count} origens", { count: formatNumber(taxaLoaded.origins.length) })}</span>
                  <span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(taxaLoaded.updatedAt) })}</span>
                </div>
              </section>

              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              {taxaHistoryNotice ? (
                <div className="inline-alert success" role="status">
                  <Check size={18} />
                  <span>{t("Histórico atualizado: {added} nova(s) data(s), {replaced} data(s) substituída(s) e {total} data(s) preservadas no painel.", {
                    added: formatNumber(taxaHistoryNotice.addedDates),
                    replaced: formatNumber(taxaHistoryNotice.replacedDates),
                    total: formatNumber(taxaHistoryNotice.totalDates),
                  })}</span>
                  <button type="button" onClick={() => setTaxaHistoryNotice(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              <section className="filters-card taxa-filters-card" aria-labelledby="taxa-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="taxa-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                  </div>
                  <button
                    type="button"
                    className="reset-button"
                    onClick={() => resetTaxaFilters()}
                    disabled={taxaFiltersAreDefault}
                  >
                    <RotateCcw size={15} /> {t("Limpar filtros")}
                  </button>
                </div>
                <div className="filter-grid taxa-filter-grid">
                  <MultiSelect
                    label={t("Regional")}
                    options={taxaRegionOptions}
                    selected={taxaSelectedRegions}
                    onChange={(value) => {
                      setTaxaSelectedRegions(value);
                      const bases = taxaBasesForRegions(taxaLoaded, value, responsibilityLoaded).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms));
                      setTaxaSelectedRmAreas(new Set(responsibilityOptions(responsibilityLoaded, bases).rmAreas));
                      setTaxaSelectedBases(new Set(bases));
                      setTaxaPage(1);
                    }}
                    allLabel={t("Todas as regionais")}
                    singular={t("regional")}
                    plural={t("regionais")}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={responsibilityFilterOptions.rms}
                    selected={selectedRms}
                    onChange={(value) => applyResponsibilityFilter("rm", value)}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Região do RM")}
                    options={taxaRmAreaOptions}
                    selected={taxaSelectedRmAreas}
                    onChange={(value) => {
                      setTaxaSelectedRmAreas(value);
                      setTaxaSelectedBases(new Set(taxaBasesForRegions(taxaLoaded, taxaSelectedRegions, responsibilityLoaded).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms) &&
                        value.has(rmAreaForBase(responsibilityLoaded, base)))));
                      setTaxaPage(1);
                    }}
                    allLabel={t("Todas as regiões do RM")}
                    singular={t("região do RM")}
                    plural={t("regiões do RM")}
                    getOptionLabel={(option) => t(option)}
                    searchable
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={taxaBaseOptions}
                    selected={taxaSelectedBases}
                    onChange={(value) => {
                      setTaxaSelectedBases(value);
                      setTaxaPage(1);
                    }}
                    allLabel={t("Todas as bases")}
                    singular={t("base")}
                    plural={t("bases")}
                    searchable
                    t={t}
                  />
                  <div className="filter-field date-field">
                    <label className="filter-label" htmlFor="taxa-date-start">{t("Data inicial")}</label>
                    <div className="date-input-wrap">
                      <CalendarDays size={16} />
                      <input
                        id="taxa-date-start"
                        type="date"
                        value={taxaDateStart}
                        min={taxaLoaded.dates[0]}
                        max={taxaLoaded.dates[taxaLoaded.dates.length - 1]}
                        onChange={(event) => {
                          const nextStart = event.target.value;
                          setTaxaDateStart(nextStart);
                          if (!taxaDateEnd || taxaDateEnd < nextStart) setTaxaDateEnd(nextStart);
                          setTaxaPage(1);
                        }}
                      />
                    </div>
                  </div>
                  <div className="filter-field date-field">
                    <label className="filter-label" htmlFor="taxa-date-end">{t("Data final")}</label>
                    <div className="date-input-wrap">
                      <CalendarDays size={16} />
                      <input
                        id="taxa-date-end"
                        type="date"
                        value={taxaDateEnd}
                        min={taxaDateStart || taxaLoaded.dates[0]}
                        max={taxaMaximumSelectableEnd || taxaLoaded.dates[taxaLoaded.dates.length - 1]}
                        onChange={(event) => {
                          setTaxaDateEnd(event.target.value);
                          setTaxaPage(1);
                        }}
                      />
                    </div>
                  </div>
                  <MultiSelect
                    label={t("Origem do pedido")}
                    options={taxaLoaded.origins}
                    selected={taxaSelectedOrigins}
                    onChange={(value) => {
                      setTaxaSelectedOrigins(value);
                      setTaxaPage(1);
                    }}
                    allLabel={t("Todas as origens")}
                    singular={t("origem")}
                    plural={t("origens")}
                    searchable
                    t={t}
                  />
                </div>
                {taxaDateIsInvalid ? (
                  <div className="filter-summary invalid">
                    <><CircleAlert size={15} /> {t("A data inicial deve ser anterior à data final.")}</>
                  </div>
                ) : null}
              </section>

              {taxaLoaded.blankBaseRows > 0 || taxaLoaded.blankRegionRows > 0 ? (
                <div className="quality-note">
                  <Info size={16} />
                  <span>
                    {taxaLoaded.blankBaseRows > 0
                      ? t("{count} linha(s) sem base foram mantidas como “Sem base”.", { count: formatNumber(taxaLoaded.blankBaseRows) })
                      : t("{count} linha(s) sem regional foram mantidas como “Sem regional”.", { count: formatNumber(taxaLoaded.blankRegionRows) })}
                  </span>
                </div>
              ) : null}

              <section className="kpi-grid" aria-label={t("Indicadores de taxa de coleta")}>
                <KpiCard
                  icon={<CalendarDays size={20} />}
                  label={t("Taxa de coleta")}
                  value={formatRate(taxaSummary.onTimeRate)}
                  detail={t("{count} coletados no prazo", { count: formatNumber(taxaSummary.onTime) })}
                />
                <KpiCard
                  icon={<TrendingUp size={20} />}
                  label={t("Taxa com tentativa")}
                  value={formatRate(taxaSummary.collectionWithAttemptsRate)}
                  detail={t("{count} com coleta/tentativa", { count: formatNumber(taxaSummary.collectedWithAttempts) })}
                  tone="orange"
                />
                <KpiCard
                  icon={<Layers3 size={20} />}
                  label={t("Previsto a coletar")}
                  value={formatCompact(taxaSummary.toCollect)}
                  detail={t("Valor previsto no período selecionado")}
                  tone="dark"
                />
                <KpiCard
                  icon={<CircleAlert size={20} />}
                  label={t("Aguardando coleta")}
                  value={formatCompact(taxaSummary.notCollected)}
                  detail={t("{rate} do previsto a coletar", { rate: formatRate(monitoringAwaitingRate({ orderVolume: taxaSummary.toCollect, awaiting: taxaSummary.notCollected })) })}
                  tone="soft"
                />
              </section>

              <section className="charts-grid taxa-charts-grid">
                <article className="chart-card taxa-poc-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">POC</span>
                      <h2>{t("Taxa de coleta com tentativa por regional — período selecionado")}</h2>
                      <p>{t("Visão diária de até 7 dias; o percentual do último dia determina o ranking do maior para o menor.")}</p>
                    </div>
                    <div className="taxa-poc-rm-actions">
                      <span className="card-badge">{t("{count} dia(s)", { count: formatNumber(taxaRegionalPoc.dates.length) })}</span>
                      <button
                        className="table-download-button taxa-poc-rm-download-button"
                        type="button"
                        onClick={() => void downloadTaxaRegionalPocExcel()}
                        disabled={taxaRegionalPoc.rows.length === 0}
                      >
                        <FileSpreadsheet size={15} />
                        {t("Baixar Excel")}
                      </button>
                    </div>
                  </div>
                  {taxaRegionalPoc.dates.length > 0 && taxaRegionalPoc.rows.length > 0 ? (
                    <div className="taxa-poc-table-wrap">
                      <table className="dashboard-data-table taxa-poc-table taxa-poc-regional-rgm-table">
                        <colgroup>
                          <col className="taxa-poc-region-column" />
                          <col className="taxa-poc-rgm-column" />
                          {taxaAttemptTarget == null ? null : <col className="taxa-poc-target-column" />}
                          {taxaRegionalPoc.dates.map((date) => <col className="taxa-poc-day-column" key={`col-${date}`} />)}
                          <col className="taxa-poc-orders-column" />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>{t("Regional")}</th>
                            <th>RGM</th>
                            {taxaAttemptTarget == null ? null : <th className="taxa-poc-target-header">{t("Meta")}</th>}
                            {taxaRegionalPoc.dates.map((date) => (
                              <th className={`taxa-poc-date-header${isWeekendDate(date) ? " is-weekend" : ""}`} key={date}>
                                <span>{formatDate(date, true)}</span>
                                <small>{formatWeekday(date)}</small>
                              </th>
                            ))}
                            <th>{t("Total de pedidos")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {taxaRegionalPoc.rows.map((row) => (
                            <tr key={row.region}>
                              <th scope="row"><span>{row.region}</span></th>
                              <th scope="row"><span title={t(row.rgm)}>{t(row.rgm)}</span></th>
                              {taxaAttemptTarget == null ? null : <td className="target-cell"><strong>{formatRate(taxaAttemptTarget)}</strong></td>}
                              {row.values.map((value, index) => (
                                <td key={`${row.region}-${taxaRegionalPoc.dates[index]}`}>
                                  <strong
                                    className={value.toCollect <= 0 ? "empty" : value.rate >= taxaPerformanceThreshold ? "ok" : value.rate >= 0.95 ? "watch" : "alert"}
                                    title={value.toCollect > 0 ? t("{count} com tentativa", { count: formatNumber(value.withAttempts) }) : t("Sem movimento")}
                                  >
                                    {value.toCollect > 0 ? formatRate(value.rate) : "—"}
                                  </strong>
                                </td>
                              ))}
                              <td className="number-cell"><strong>{formatNumber(row.totalOrders)}</strong></td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <th scope="row" colSpan={2}>{t("Total geral")}</th>
                            {taxaAttemptTarget == null ? null : <td className="target-cell"><strong>{formatRate(taxaAttemptTarget)}</strong></td>}
                            {taxaRegionalPoc.total.map((value, index) => (
                              <td key={`total-${taxaRegionalPoc.dates[index]}`}>
                                <strong title={t("{count} com tentativa", { count: formatNumber(value.withAttempts) })}>{value.toCollect > 0 ? formatRate(value.rate) : "—"}</strong>
                              </td>
                            ))}
                            <td className="number-cell"><strong>{formatNumber(taxaRegionalPoc.totalOrders)}</strong></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ) : (
                    <EmptyChart message={t("Não há dados de taxa para os filtros selecionados.")} />
                  )}
                  {taxaPocTrend.points.length > 0 ? (
                    <div className="taxa-poc-trend">
                      <div className="taxa-poc-trend-heading">
                        <h3>{t("Resultado geral do período selecionado")}</h3>
                        {taxaAttemptTarget == null ? null : <span>{t("Meta {rate}", { rate: formatRate(taxaAttemptTarget) })}</span>}
                      </div>
                      <div className="taxa-poc-line-chart" role="img" aria-label={t("Gráfico em linha do resultado geral do período selecionado")}>
                        <svg viewBox={`0 0 ${taxaPocTrend.width} ${taxaPocTrend.height}`} preserveAspectRatio="xMidYMid meet">
                          <line className="chart-axis-line" x1={taxaPocTrend.left} y1={taxaPocTrend.top} x2={taxaPocTrend.left} y2={taxaPocTrend.height - taxaPocTrend.bottom} />
                          <line className="chart-axis-line" x1={taxaPocTrend.left} y1={taxaPocTrend.height - taxaPocTrend.bottom} x2={taxaPocTrend.width - taxaPocTrend.right} y2={taxaPocTrend.height - taxaPocTrend.bottom} />
                          {taxaPocTrend.targetY == null ? null : <line className="target-line" x1={taxaPocTrend.left} y1={taxaPocTrend.targetY} x2={taxaPocTrend.width - taxaPocTrend.right} y2={taxaPocTrend.targetY} />}
                          <polyline className="attempt-line" points={taxaPocTrend.line} />
                          {taxaPocTrend.points.map((point, index) => (
                            <g key={`trend-${point.date}`}>
                              <circle className={point.rate >= taxaPerformanceThreshold ? "attempt-point ok" : "attempt-point alert"} cx={point.x} cy={point.y} r="4" />
                              <text className={`attempt-value-label ${point.rate >= taxaPerformanceThreshold ? "ok" : "alert"}`} x={point.x} y={Math.max(9, point.y - (index % 2 === 0 ? 7 : 14))} textAnchor="middle">
                                {formatRate(point.rate)}
                              </text>
                              <text className="attempt-date-label" x={point.x} y={taxaPocTrend.height - 18} textAnchor="middle">{formatDate(point.date, true)}</text>
                              <text className={`attempt-weekday-label${isWeekendDate(point.date) ? " is-weekend" : ""}`} x={point.x} y={taxaPocTrend.height - 6} textAnchor="middle">{formatWeekday(point.date)}</text>
                            </g>
                          ))}
                        </svg>
                      </div>
                    </div>
                  ) : null}
                  {taxaGeneralTrendPanel}
                </article>

                <article className="chart-card composition-card">
                  <div className="card-heading">
                    <div>
                      <span className="card-eyebrow">{t("ORIGEM DO PEDIDO")}</span>
                      <h2>{t("Performance por origem")}</h2>
                    </div>
                    <span className="card-badge">{t("{count} origem(ns)", { count: formatNumber(taxaSelectedOrigins.size) })}</span>
                  </div>
                  {taxaOriginSummary.length > 0 ? (
                    <>
                      <div className="composition-list compact-origin-list">
                        {taxaOriginSummary.map((item) => (
                          <div className="composition-row" key={item.origin}>
                            <div className="composition-label">
                              <span title={item.origin}><StatusDot color="#e60000" /> {item.origin}</span>
                              <strong>{formatRate(item.attemptRate)}</strong>
                            </div>
                            <div className="horizontal-track">
                              <span style={{ width: `${Math.min(100, item.attemptRate * 100)}%`, backgroundColor: "#e60000" }} />
                            </div>
                            <small>{t("{count} com tentativa · {rate} no prazo", { count: formatNumber(item.withAttempts), rate: formatRate(item.onTimeRate) })}</small>
                          </div>
                        ))}
                      </div>

                      <div className="taxa-poc-rm-block taxa-poc-rm-replacement">
                        <div className="taxa-poc-rm-heading">
                          <div>
                            <span className="card-eyebrow">RM</span>
                            <h3>{t("Taxa com tentativa por RM — período selecionado")}</h3>
                          </div>
                          <div className="taxa-poc-rm-actions">
                            <span className="card-badge">
                              {taxaSelectedRegions.size === taxaRegionOptions.length
                                ? t("Todas as regionais")
                                : taxaSelectedRegions.size === 1
                                  ? [...taxaSelectedRegions][0]
                                  : t("{count} regional(is)", { count: formatNumber(taxaSelectedRegions.size) })}
                            </span>
                            <button
                              className="table-download-button taxa-poc-rm-download-button"
                              type="button"
                              onClick={() => void downloadTaxaRmPocExcel()}
                              disabled={taxaRmPoc.rows.length === 0}
                            >
                              <FileSpreadsheet size={15} />
                              {t("Baixar Excel")}
                            </button>
                          </div>
                        </div>
                        {taxaRmPoc.rows.length > 0 ? (
                          <div className="taxa-poc-table-wrap taxa-poc-rm-table-wrap">
                            <table className="dashboard-data-table taxa-poc-table taxa-poc-rm-table">
                              <colgroup>
                                <col className="taxa-poc-rm-area-column" />
                                <col className="taxa-poc-rm-name-column" />
                                <col className="taxa-poc-rgm-column" />
                                {taxaAttemptTarget == null ? null : <col className="taxa-poc-target-column" />}
                                {taxaRmPoc.dates.map((date) => <col className="taxa-poc-day-column" key={`rm-col-${date}`} />)}
                                <col className="taxa-poc-orders-column" />
                              </colgroup>
                              <thead>
                                <tr>
                                  <th>{t("Região do RM")}</th>
                                  <th>{t("Responsável do RM")}</th>
                                  <th>RGM</th>
                                  {taxaAttemptTarget == null ? null : <th className="taxa-poc-target-header">{t("Meta")}</th>}
                                  {taxaRmPoc.dates.map((date) => (
                                    <th className={`taxa-poc-date-header${isWeekendDate(date) ? " is-weekend" : ""}`} key={`rm-head-${date}`}>
                                      <span>{formatDate(date, true)}</span>
                                      <small>{formatWeekday(date)}</small>
                                    </th>
                                  ))}
                                  <th>{t("Total de pedidos")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {taxaRmPoc.rows.map((row) => (
                                  <tr key={`${row.rmArea}-${row.rm}`}>
                                    <th scope="row"><span title={t(row.rmArea)}>{t(row.rmArea)}</span></th>
                                    <th scope="row"><span title={t(row.rm)}>{t(row.rm)}</span></th>
                                    <th scope="row"><span title={t(row.rgm)}>{t(row.rgm)}</span></th>
                                    {taxaAttemptTarget == null ? null : <td className="target-cell"><strong>{formatRate(taxaAttemptTarget)}</strong></td>}
                                    {row.values.map((value, index) => (
                                      <td key={`${row.rmArea}-${row.rm}-${taxaRmPoc.dates[index]}`}>
                                        <strong
                                          className={value.toCollect <= 0 ? "empty" : value.rate >= taxaPerformanceThreshold ? "ok" : value.rate >= 0.95 ? "watch" : "alert"}
                                          title={value.toCollect > 0 ? t("{count} com tentativa", { count: formatNumber(value.withAttempts) }) : t("Sem movimento")}
                                        >
                                          {value.toCollect > 0 ? formatRate(value.rate) : "—"}
                                        </strong>
                                      </td>
                                    ))}
                                    <td className="number-cell"><strong>{formatNumber(row.totalOrders)}</strong></td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr>
                                  <th scope="row" colSpan={3}>{t("Total geral")}</th>
                                  {taxaAttemptTarget == null ? null : <td className="target-cell"><strong>{formatRate(taxaAttemptTarget)}</strong></td>}
                                  {taxaRmPoc.total.map((value, index) => (
                                    <td key={`rm-total-${taxaRmPoc.dates[index]}`}>
                                      <strong title={t("{count} com tentativa", { count: formatNumber(value.withAttempts) })}>
                                        {value.toCollect > 0 ? formatRate(value.rate) : "—"}
                                      </strong>
                                    </td>
                                  ))}
                                  <td className="number-cell"><strong>{formatNumber(taxaRmPoc.totalOrders)}</strong></td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        ) : (
                          <EmptyChart message={t("Não há dados de RM para os filtros selecionados.")} />
                        )}
                      </div>

                    </>
                  ) : (
                    <EmptyChart message={t("Selecione ao menos uma origem com movimento.")} />
                  )}
                </article>
              </section>

              <section className="table-card" aria-labelledby="taxa-detail-heading">
                <div className="table-card-top">
                  <div>
                    <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                    <h2 id="taxa-detail-heading">{t("Bases por performance")}</h2>
                    <p>{t("Dados consolidados no período; o percentual do último dia determina o ranking do maior para o menor.")}</p>
                  </div>
                  <div className="table-detail-actions">
                    <button
                      className="table-download-button"
                      type="button"
                      onClick={downloadTaxaTableExcel}
                      disabled={taxaTableRows.length === 0}
                    >
                      <FileSpreadsheet size={17} />
                      {t("Baixar Excel")}
                    </button>
                    <label className="table-search">
                      <Search size={16} />
                      <span className="sr-only">{t("Buscar base, regional ou origem")}</span>
                      <input
                        value={taxaTableQuery}
                        onChange={(event) => {
                          setTaxaTableQuery(event.target.value);
                          setTaxaPage(1);
                        }}
                        placeholder={t("Buscar base, regional ou origem")}
                      />
                    </label>
                  </div>
                </div>
                {visibleTaxaTableRows.length > 0 ? (
                  <>
                    <div className="table-scroll">
                      <table className="dashboard-data-table">
                        <thead>
                          <tr>
                            <th>{t("Período")}</th>
                            <th>{t("Regional")}</th>
                            <th>{t("Base")}</th>
                            <th>RM</th>
                            <th>RGM</th>
                            <th>{t("Origem")}</th>
                            <th>{t("Qtd pedidos")}</th>
	                            <th>{t("Previsto a coletar")}</th>
	                            <th>{t("Aguardando coleta")}</th>
	                            <th>{t("Taxa de coleta")}</th>
	                            <th>{t("Taxa de pedidos aguardando coleta")}</th>
	                            <th>{t("Taxa c/ tentativa")}</th>
	                            <th>{t("Prazo médio")}</th>
                          </tr>
                        </thead>
                        <tbody className="screen-table-body">
                          {visibleTaxaTableRows.map((row) => (
                            <tr key={row.key}>
                              <td className="date-cell">{row.period}</td>
                              <td><span className="regional-chip">{row.region}</span></td>
                              <td className="base-cell">{row.base}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                              <td>{row.origin}</td>
                              <td className="number-cell">{formatNumber(row.orders)}</td>
	                              <td className="number-cell">{formatNumber(row.toCollect)}</td>
	                              <td className="number-cell total-cell">{formatNumber(row.notCollected)}</td>
	                              <td className="number-cell">{formatRate(row.onTimeRate)}</td>
	                              <td className="number-cell total-cell">{formatRate(monitoringAwaitingRate({ orderVolume: row.toCollect, awaiting: row.notCollected }))}</td>
	                              <td className="number-cell">{formatRate(row.attemptRate)}</td>
	                              <td className="number-cell">{t("{hours}h", { hours: row.averageHours.toLocaleString(dashboardLocale(language), { maximumFractionDigits: 1 }) })}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tbody className="print-table-body">
                          {taxaTableRows.map((row) => (
                            <tr key={row.key}>
                              <td className="date-cell">{row.period}</td>
                              <td><span className="regional-chip">{row.region}</span></td>
                              <td className="base-cell">{row.base}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                              <td>{row.origin}</td>
                              <td className="number-cell">{formatNumber(row.orders)}</td>
	                              <td className="number-cell">{formatNumber(row.toCollect)}</td>
	                              <td className="number-cell total-cell">{formatNumber(row.notCollected)}</td>
	                              <td className="number-cell">{formatRate(row.onTimeRate)}</td>
	                              <td className="number-cell total-cell">{formatRate(monitoringAwaitingRate({ orderVolume: row.toCollect, awaiting: row.notCollected }))}</td>
	                              <td className="number-cell">{formatRate(row.attemptRate)}</td>
	                              <td className="number-cell">{t("{hours}h", { hours: row.averageHours.toLocaleString(dashboardLocale(language), { maximumFractionDigits: 1 }) })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer">
                      <span>
                        {t("Mostrando {from}–{to} de {total} bases consolidadas", {
                          from: formatNumber((taxaActivePage - 1) * PAGE_SIZE + 1),
                          to: formatNumber(Math.min(taxaActivePage * PAGE_SIZE, taxaTableRows.length)),
                          total: formatNumber(taxaTableRows.length),
                        })}
                      </span>
                      <div className="pagination" aria-label={t("Paginação da tabela de taxa")}>
                        <button type="button" onClick={() => setTaxaPage((value) => Math.max(1, value - 1))} disabled={taxaActivePage === 1}>{t("Anterior")}</button>
                        <span>{t("Página {page} de {pages}", { page: taxaActivePage, pages: taxaPageCount })}</span>
                        <button type="button" onClick={() => setTaxaPage((value) => Math.min(taxaPageCount, value + 1))} disabled={taxaActivePage === taxaPageCount}>{t("Próxima")}</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="table-empty">
                    <Database size={28} />
                    <h3>{t("Nenhum dado encontrado")}</h3>
                    <p>{t("Ajuste a busca ou os filtros para visualizar os registros.")}</p>
                    <button type="button" onClick={() => resetTaxaFilters()}>{t("Limpar filtros")}</button>
                  </div>
                )}
              </section>

              <footer className="dashboard-footer">
                <span><ShieldCheck size={15} /> {t("Última taxa publicada disponível para todos pelo link")}</span>
                <span>{t("Arquivo: {file} · Atualizado em {date}", { file: taxaLoaded.fileName, date: formatDateTime(taxaLoaded.updatedAt) })}</span>
              </footer>
            </>
          )
        ) : !loaded ? (
          <EmptyDashboardPanel loading={loading} error={error} onDrop={(file) => queueUpload({ kind: "monitoring", files: [file] })} inputId="monitoring-upload" t={t} />
        ) : (
          <>
            <section className="dashboard-intro">
              <div>
                <div className="eyebrow"><Activity size={15} /> <BilingualText language={language} source="Visão consolidada" /></div>
                <h1><BilingualText language={language} source="Monitoramento de coletas" /></h1>
                <p><BilingualText language={language} source="Acompanhe o movimento por base, período e todos os status do arquivo." /></p>
              </div>
              <div className="dataset-meta" aria-label={t("Resumo do arquivo")}>
                <span><Layers3 size={16} /> <BilingualText language={language} source="{count} linhas" values={{ count: formatNumber(loaded.parsed.rows.length) }} /></span>
                <span><MapPin size={16} /> <BilingualText language={language} source="{count} regionais" values={{ count: formatNumber(monitoringRegionOptions.length) }} /></span>
                <span><Database size={16} /> <BilingualText language={language} source="{count} bases" values={{ count: formatNumber(loaded.bases.length) }} /></span>
                <span><PackageCheck size={16} /> <BilingualText language={language} source="{count} status" values={{ count: formatNumber(loaded.statuses.length) }} /></span>
                <span><CalendarDays size={16} /> <BilingualText language={language} source="Última atualização: {date}" values={{ date: formatDateTime(loaded.updatedAt) }} /></span>
              </div>
            </section>

            {error ? (
              <div className="inline-alert error" role="alert">
                <CircleAlert size={18} />
                <span>{t(error)}</span>
                <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
              </div>
            ) : null}

            <section className="filters-card" aria-labelledby="filters-heading">
              <div className="filters-card-top">
                <div>
                  <h2 id="filters-heading"><Filter size={18} /> <BilingualText language={language} source="Filtros operacionais" /></h2>
                </div>
                <button
                  type="button"
                  className="reset-button"
                  onClick={() => resetFilters()}
                  disabled={filtersAreDefault}
                >
                  <RotateCcw size={15} /> {t("Limpar filtros")}
                </button>
              </div>
              <div className="filter-grid monitoring-filter-grid">
                <MultiSelect
                  label={t("Regional")}
                  options={monitoringRegionOptions}
                  selected={selectedRegions}
                  onChange={(value) => {
                    setSelectedRegions(value);
                    if (loaded) setSelectedBases(new Set(basesForRegions(loaded, value, responsibilityLoaded).filter((base) =>
                      matchesResponsibility(responsibilityLoaded, base, selectedRms, selectedRgms))));
                    setPage(1);
                  }}
                  allLabel={t("Todas as regionais")}
                  singular={t("regional")}
                  plural={t("regionais")}
                  searchable
                  t={t}
                />
                <MultiSelect
                  label="RM"
                  options={responsibilityFilterOptions.rms}
                  selected={selectedRms}
                  onChange={(value) => applyResponsibilityFilter("rm", value)}
                  allLabel={t("Todos os RM")}
                  singular="RM"
                  plural="RM"
                  getOptionLabel={(option) => t(option)}
                  searchable
                  t={t}
                />
                <MultiSelect
                  label={t("Base")}
                  options={baseOptions}
                  selected={selectedBases}
                  onChange={(value) => {
                    setSelectedBases(value);
                    setPage(1);
                  }}
                  allLabel={t("Todas as bases")}
                  singular={t("base")}
                  plural={t("bases")}
                  searchable
                  t={t}
                />
                <div className="filter-field date-field">
                  <label className="filter-label" htmlFor="date-start">{t("Data inicial")}</label>
                  <div className="date-input-wrap">
                    <CalendarDays size={16} />
                    <input
                      id="date-start"
                      type="date"
                      value={dateStart}
                      min={loaded.dates[0]}
                      max={loaded.dates[loaded.dates.length - 1]}
                      onChange={(event) => {
                        setDateStart(event.target.value);
                        setPage(1);
                      }}
                    />
                  </div>
                </div>
                <div className="filter-field date-field">
                  <label className="filter-label" htmlFor="date-end">{t("Data final")}</label>
                  <div className="date-input-wrap">
                    <CalendarDays size={16} />
                    <input
                      id="date-end"
                      type="date"
                      value={dateEnd}
                      min={loaded.dates[0]}
                      max={loaded.dates[loaded.dates.length - 1]}
                      onChange={(event) => {
                        setDateEnd(event.target.value);
                        setPage(1);
                      }}
                    />
                  </div>
                </div>
                <MultiSelect
                  label={t("Status")}
                  options={[...MONITORING_METRIC_OPTIONS]}
                  selected={selectedMonitoringMetrics}
                  onChange={(value) => {
                    const metrics = new Set(
                      [...value].filter((item): item is MonitoringMetric => MONITORING_METRIC_OPTIONS.includes(item as MonitoringMetric)),
                    );
                    setSelectedMonitoringMetrics(metrics);
                    setSelectedStatuses(new Set(monitoringStatusesForMetrics(loaded.statuses, metrics)));
                    setPage(1);
                  }}
                  allLabel={t("Todos os status")}
                  singular={t("status")}
                  plural={t("status")}
                  searchable
                  colorOptions={[...MONITORING_METRIC_OPTIONS]}
                  getOptionLabel={(option) => t(option)}
                  t={t}
                />
                <MultiSelect
                  label={t("Origem do pedido")}
                  options={loaded.origins}
                  selected={selectedOrigins}
                  onChange={(value) => {
                    setSelectedOrigins(value);
                    setPage(1);
                  }}
                  allLabel={t("Todas as origens")}
                  singular={t("origem")}
                  plural={t("origens")}
                  getOptionLabel={(option) => t(option)}
                  searchable
                  t={t}
                />
              </div>
              {dateIsInvalid ? (
                <div className="filter-summary invalid">
                  <><CircleAlert size={15} /> {t("A data inicial deve ser anterior à data final.")}</>
                </div>
              ) : null}
            </section>

            {loaded.blankBaseRows > 0 || loaded.parsed.warnings.length > 0 ? (
              <div className="quality-note">
                <Info size={16} />
                <span>
                  {loaded.blankBaseRows > 0
                    ? t("{count} linha(s) sem identificação de base foram mantidas como “Sem base”.", { count: formatNumber(loaded.blankBaseRows) })
                    : t(loaded.parsed.warnings[0])}
                </span>
              </div>
            ) : null}

            <section className="charts-grid taxa-charts-grid movement-summary-grid monitoring-summary-grid first-scan-summary-grid">
              <article className="chart-card movement-summary-card">
                <div className="card-heading"><div><span className="card-eyebrow">PRIMEIRA DIGITALIZAÇÃO</span><h2>{t("Retenção por regional")}</h2><p>{t("Dia anterior: retenção na base, despacho da base e chegada ao centro de triagem.")}</p></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(firstScanRegionalSummary, [{ header: t("Regional"), value: (row) => row.region }, { header: "RGM", value: (row) => row.rgm }, { header: t("Volume previsto"), value: (row) => row.orderVolume }, { header: t("Retenção total"), value: (row) => firstScanTotalRetained(row) }, { header: t("Taxa de retenção"), value: (row) => safeRate(firstScanTotalRetained(row), row.orderVolume), numberFormat: "0.00%" }, { header: t("Retido na base"), value: (row) => row.baseRetained }, { header: t("Despachado pela base"), value: (row) => row.baseDispatched }, { header: t("Chegado ao centro"), value: (row) => row.hubArrived }], t("Primeira digitalização por regional"), "primeira_digitalizacao_regional.xlsx")}><FileSpreadsheet size={16}/>{t("Baixar Excel")}</button></div>
                <div className="dashboard-table-wrap movement-summary-table-wrap"><table className="dashboard-data-table movement-summary-table monitoring-summary-table first-scan-table"><thead><tr><th rowSpan={2}><PtZhHeader pt="Regional" zh="始发区域" /></th><th rowSpan={2}>RGM</th><th rowSpan={2}><PtZhHeader pt="Volume previsto" zh="应揽量" /></th><th colSpan={3}><PtZhHeader pt="Retenção total" zh="整体滞留率" /></th><th colSpan={3}><PtZhHeader pt="Retido na base" zh="网点滞留" /></th><th colSpan={3}><PtZhHeader pt="Despachado pela base" zh="网点已发件" /></th><th colSpan={3}><PtZhHeader pt="Chegado ao centro" zh="集散已到件" /></th></tr><tr><th><PtZhHeader pt="Taxa atual" zh="当日滞留率" /></th><th><PtZhHeader pt="Dia anterior" zh="前日滞留率" /></th><th><PtZhHeader pt="Variação" zh="环比" /></th><th><PtZhHeader pt="Quantidade" zh="滞留量" /></th><th><PtZhHeader pt="Taxa" zh="滞留率" /></th><th><PtZhHeader pt="% do total" zh="滞留占比" /></th><th><PtZhHeader pt="Quantidade" zh="滞留量" /></th><th><PtZhHeader pt="Taxa" zh="滞留率" /></th><th><PtZhHeader pt="% do total" zh="滞留占比" /></th><th><PtZhHeader pt="Quantidade" zh="滞留量" /></th><th><PtZhHeader pt="Taxa" zh="滞留率" /></th><th><PtZhHeader pt="% do total" zh="滞留占比" /></th></tr></thead><tbody>{firstScanRegionalSummary.map((row) => { const previous = firstScanPreviousRegional.get(row.region); const rate = safeRate(firstScanTotalRetained(row), row.orderVolume); const previousRate = previous ? safeRate(firstScanTotalRetained(previous), previous.orderVolume) : null; const delta = previousRate === null ? null : rate - previousRate; const total = firstScanTotalRetained(row); const baseRate = safeRate(row.baseRetained, row.orderVolume); const dispatchedRate = safeRate(row.baseDispatched, row.orderVolume); const hubRate = safeRate(row.hubArrived, row.orderVolume); const baseShare = safeRate(row.baseRetained, total); const dispatchedShare = safeRate(row.baseDispatched, total); const hubShare = safeRate(row.hubArrived, total); return <tr key={row.region}><td><span className="regional-chip">{row.region}</span></td><td>{row.rgm}</td><td className="number-cell">{formatNumber(row.orderVolume)}</td><td className={`number-cell severity-cell ${firstScanRateTone(rate)}`}>{formatRate(rate)}</td><td className={`number-cell severity-cell ${previousRate === null ? "" : firstScanRateTone(previousRate)}`}>{previousRate === null ? "—" : formatRate(previousRate)}</td><td className={`number-cell severity-cell ${delta !== null && delta > 0 ? firstScanRateTone(delta) : "is-good"}`}>{delta === null ? "—" : `${delta >= 0 ? "↑" : "↓"} ${formatRate(Math.abs(delta))}`}</td><td className="number-cell">{formatNumber(row.baseRetained)}</td><td className={`number-cell severity-cell ${firstScanRateTone(baseRate)}`}>{formatRate(baseRate)}</td><td className={`number-cell severity-cell ${firstScanShareTone(baseShare)}`}>{formatRate(baseShare)}</td><td className="number-cell">{formatNumber(row.baseDispatched)}</td><td className={`number-cell severity-cell ${firstScanRateTone(dispatchedRate)}`}>{formatRate(dispatchedRate)}</td><td className={`number-cell severity-cell ${firstScanShareTone(dispatchedShare)}`}>{formatRate(dispatchedShare)}</td><td className="number-cell">{formatNumber(row.hubArrived)}</td><td className={`number-cell severity-cell ${firstScanRateTone(hubRate)}`}>{formatRate(hubRate)}</td><td className={`number-cell severity-cell ${firstScanShareTone(hubShare)}`}>{formatRate(hubShare)}</td></tr>; })}</tbody><tfoot><tr><th>{t("Total geral")}</th><td>—</td><td className="number-cell">{formatNumber(firstScanTotal.orderVolume)}</td><td className="number-cell">{formatRate(safeRate(firstScanTotalRetained(firstScanTotal), firstScanTotal.orderVolume))}</td><td className="number-cell">{firstScanPreviousTotal.orderVolume ? formatRate(safeRate(firstScanTotalRetained(firstScanPreviousTotal), firstScanPreviousTotal.orderVolume)) : "—"}</td><td className="number-cell">—</td><td className="number-cell">{formatNumber(firstScanTotal.baseRetained)}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.baseRetained, firstScanTotal.orderVolume))}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.baseRetained, firstScanTotalRetained(firstScanTotal)))}</td><td className="number-cell">{formatNumber(firstScanTotal.baseDispatched)}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.baseDispatched, firstScanTotal.orderVolume))}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.baseDispatched, firstScanTotalRetained(firstScanTotal)))}</td><td className="number-cell">{formatNumber(firstScanTotal.hubArrived)}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.hubArrived, firstScanTotal.orderVolume))}</td><td className="number-cell">{formatRate(safeRate(firstScanTotal.hubArrived, firstScanTotalRetained(firstScanTotal)))}</td></tr></tfoot></table></div>
              </article>
              <article className="chart-card movement-summary-card">
                <div className="card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Retenção por RM")}</h2><p>{t("Responsáveis do RM e RGM para cobrança operacional.")}</p></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(firstScanRmSummary, [{ header: t("Região do RM"), value: (row) => row.rmArea }, { header: "RM", value: (row) => row.rm }, { header: "RGM", value: (row) => row.rgm }, { header: t("Volume previsto"), value: (row) => row.orderVolume }, { header: t("Retenção total"), value: (row) => firstScanTotalRetained(row) }, { header: t("Taxa de retenção"), value: (row) => safeRate(firstScanTotalRetained(row), row.orderVolume), numberFormat: "0.00%" }, { header: t("Retido na base"), value: (row) => row.baseRetained }, { header: t("Despachado pela base"), value: (row) => row.baseDispatched }, { header: t("Chegado ao centro"), value: (row) => row.hubArrived }], t("Primeira digitalização por RM"), "primeira_digitalizacao_rm.xlsx")}><FileSpreadsheet size={16}/>{t("Baixar Excel")}</button></div>
                <div className="dashboard-table-wrap movement-summary-table-wrap"><table className="dashboard-data-table movement-summary-table movement-rm-summary-table monitoring-summary-table first-scan-table"><thead><tr><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Volume previsto")}</th><th>{t("Retenção total")}</th><th>{t("Taxa de retenção")}</th><th>{t("Retido na base")}</th><th>{t("Taxa")}</th><th>{t("Despachado pela base")}</th><th>{t("Taxa")}</th><th>{t("Chegado ao centro")}</th><th>{t("Taxa")}</th></tr></thead><tbody>{firstScanRmSummary.map((row) => <tr key={`${row.rmArea}-${row.rm}-${row.rgm}`}><td>{row.rmArea}</td><td>{row.rm}</td><td>{row.rgm}</td><td className="number-cell">{formatNumber(row.orderVolume)}</td><td className="number-cell warning-cell">{formatNumber(firstScanTotalRetained(row))}</td><td className="number-cell warning-cell">{formatRate(safeRate(firstScanTotalRetained(row), row.orderVolume))}</td><td className="number-cell">{formatNumber(row.baseRetained)}</td><td className="number-cell">{formatRate(safeRate(row.baseRetained, row.orderVolume))}</td><td className="number-cell">{formatNumber(row.baseDispatched)}</td><td className="number-cell">{formatRate(safeRate(row.baseDispatched, row.orderVolume))}</td><td className="number-cell">{formatNumber(row.hubArrived)}</td><td className="number-cell">{formatRate(safeRate(row.hubArrived, row.orderVolume))}</td></tr>)}</tbody></table></div>
              </article>
            </section>

            <section className="kpi-grid" aria-label={t("Indicadores do período")}>
              <KpiCard
                icon={<Layers3 size={20} />}
                label={<BilingualText language={language} source="Previsto a coletar" />}
                value={formatCompact(monitoringSummaryMetrics.orderVolume)}
                detail={<BilingualText language={language} source="{count} pedidos previstos" values={{ count: formatNumber(monitoringSummaryMetrics.orderVolume) }} />}
              />
              <KpiCard
                icon={<Activity size={20} />}
                label={<BilingualText language={language} source="Aguardando coleta" />}
                value={formatCompact(monitoringSummaryMetrics.awaiting)}
                detail={<BilingualText language={language} source="{rate} do volume de pedidos" values={{ rate: formatRate(safeRate(monitoringSummaryMetrics.awaiting, monitoringSummaryMetrics.orderVolume)) }} />}
                tone="orange"
              />
              <KpiCard
                icon={<PackageCheck size={20} />}
                label={<BilingualText language={language} source="Taxa de coleta" />}
                value={formatRate(monitoringCollectionRate(monitoringSummaryMetrics))}
                detail={<BilingualText language={language} source="{count} pedidos coletados" values={{ count: formatNumber(monitoringCollectedVolume(monitoringSummaryMetrics)) }} />}
                tone="dark"
              />
              <KpiCard
                icon={<Activity size={20} />}
                label={<BilingualText language={language} source="Taxa de pedidos aguardando coleta" />}
                value={formatRate(monitoringAwaitingRate(monitoringSummaryMetrics))}
                detail={monitoringSummaryPeriod}
                tone="soft"
              />
            </section>

            <section className="charts-grid taxa-charts-grid movement-summary-grid monitoring-summary-grid">
              <article className="chart-card movement-summary-card">
                <div className="card-heading">
                  <div>
                    <span className="card-eyebrow"><BilingualText language={language} source="REGIONAL" /></span>
                    <h2><BilingualText language={language} source="Monitoramento por regional" /></h2>
                    <p><BilingualText language={language} source="Volume previsto, aguardando coleta, coletado e taxas do período selecionado." /></p>
                  </div>
                  <div className="table-detail-actions">
                    <span className="card-badge">{monitoringSummaryPeriod}</span>
                    <button className="table-download-button" type="button" onClick={downloadMonitoringTableExcel} disabled={monitoringRegionalSummary.length === 0}>
                      <FileSpreadsheet size={16} />
                      {t("Baixar Excel")}
                    </button>
                  </div>
                </div>
                {monitoringRegionalSummary.length > 0 ? (
                  <div className="dashboard-table-wrap movement-summary-table-wrap">
                    <table className="dashboard-data-table movement-summary-table monitoring-summary-table">
                      <thead><tr><th>{t("Regional")}</th><th>RGM</th><th>{t("Previsto a coletar")}</th><th>{t("Aguardando coleta")}</th><th>{t("Coletado")}</th><th>{t("Taxa de coleta")}</th><th>{t("Taxa de pedidos aguardando coleta")}</th></tr></thead>
                      <tbody>
                        {monitoringRegionalSummary.map((row) => (
                          <tr key={row.region}>
                            <td><span className="regional-chip">{row.region}</span></td>
                            <td>{t(row.rgm)}</td>
                            <td className="number-cell">{formatNumber(row.orderVolume)}</td>
                            <td className="number-cell warning-cell">{formatNumber(row.awaiting)}</td>
                            <td className="number-cell">{formatNumber(row.collected)}</td>
                            <td className="number-cell rate-cell">{formatRate(monitoringCollectionRate(row))}</td>
                            <td className="number-cell warning-cell">{formatRate(monitoringAwaitingRate(row))}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><th>{t("Total geral")}</th><td>—</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.orderVolume)}</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.awaiting)}</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.collected)}</td><td className="number-cell">{formatRate(monitoringCollectionRate(monitoringSummaryMetrics))}</td><td className="number-cell">{formatRate(monitoringAwaitingRate(monitoringSummaryMetrics))}</td></tr></tfoot>
                    </table>
                  </div>
                ) : (
                  <EmptyChart message={t("Não há pedidos monitorados para os filtros e status selecionados.")} />
                )}
              </article>

              <article className="chart-card movement-summary-card">
                <div className="card-heading">
                  <div>
                    <span className="card-eyebrow">RM</span>
                    <h2>{t("Monitoramento por RM")}</h2>
                    <p>{t("Volume previsto, aguardando coleta, coletado e taxas do período selecionado.")}</p>
                  </div>
                  <div className="table-detail-actions">
                    <span className="card-badge">{monitoringSummaryPeriod}</span>
                    <button className="table-download-button" type="button" onClick={downloadMonitoringTableExcel} disabled={monitoringRmSummary.length === 0}>
                      <FileSpreadsheet size={16} />
                      {t("Baixar Excel")}
                    </button>
                  </div>
                </div>
                {monitoringRmSummary.length > 0 ? (
                  <div className="dashboard-table-wrap movement-summary-table-wrap">
                    <table className="dashboard-data-table movement-summary-table movement-rm-summary-table monitoring-summary-table">
                      <thead><tr><th>{t("Região do RM")}</th><th>{t("Responsável do RM")}</th><th>RGM</th><th>{t("Previsto a coletar")}</th><th>{t("Aguardando coleta")}</th><th>{t("Coletado")}</th><th>{t("Taxa de coleta")}</th><th>{t("Taxa de pedidos aguardando coleta")}</th></tr></thead>
                      <tbody>
                        {monitoringRmSummary.map((row) => (
                          <tr key={`${row.rmArea}::${row.rm}::${row.rgm}`}>
                            <td>{t(row.rmArea)}</td>
                            <td>{t(row.rm)}</td>
                            <td>{t(row.rgm)}</td>
                            <td className="number-cell">{formatNumber(row.orderVolume)}</td>
                            <td className="number-cell warning-cell">{formatNumber(row.awaiting)}</td>
                            <td className="number-cell">{formatNumber(row.collected)}</td>
                            <td className="number-cell rate-cell">{formatRate(monitoringCollectionRate(row))}</td>
                            <td className="number-cell warning-cell">{formatRate(monitoringAwaitingRate(row))}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><th>{t("Total geral")}</th><td>—</td><td>—</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.orderVolume)}</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.awaiting)}</td><td className="number-cell">{formatNumber(monitoringSummaryMetrics.collected)}</td><td className="number-cell">{formatRate(monitoringCollectionRate(monitoringSummaryMetrics))}</td><td className="number-cell">{formatRate(monitoringAwaitingRate(monitoringSummaryMetrics))}</td></tr></tfoot>
                    </table>
                  </div>
                ) : (
                  <EmptyChart message={t("Não há pedidos monitorados para os filtros e status selecionados.")} />
                )}
              </article>
            </section>

            <section className="regional-card" aria-labelledby="regional-heading">
              <div className="card-heading">
                <div>
                  <span className="card-eyebrow">{t("REGIONAL")}</span>
                  <h2 id="regional-heading">{t("Total por regional e status")}</h2>
                </div>
                <span className="card-badge">{t("{count} com movimento", { count: formatNumber(regionalSummaries.length) })}</span>
              </div>
              {maxRegional > 0 ? (
                <div className="regional-list">
                  {regionalSummaries.map((region) => {
                    const leadingStatuses = region.byStatus.slice(0, 4);
                    const remaining = region.byStatus.slice(4).reduce((sum, item) => sum + item.value, 0);
                    return (
                      <article className="regional-row" key={region.region}>
                        <div className="regional-main">
                          <strong>{region.region}</strong>
                          <span>{t("{count} base(s) com movimento", { count: formatNumber(region.activeBases) })}</span>
                        </div>
                        <div className="regional-metric">
                          <strong>{formatCompact(region.total)}</strong>
                          <span>{formatNumber(region.total)}</span>
                        </div>
                        <div className="regional-stack" aria-label={`${region.region}: ${formatNumber(region.total)}`}>
                          <div style={{ width: `${maxRegional ? (region.total / maxRegional) * 100 : 0}%` }}>
                            {leadingStatuses.map((status) => (
                              <span
                                key={status.status}
                                style={{
                                  width: `${region.total ? (status.value / region.total) * 100 : 0}%`,
                                  backgroundColor: status.color,
                                }}
                                title={`${statusLabel(status.status)}: ${formatNumber(status.value)}`}
                              />
                            ))}
                            {remaining > 0 ? (
                              <span
                                style={{
                                  width: `${region.total ? (remaining / region.total) * 100 : 0}%`,
                                  backgroundColor: "#9ca3af",
                                }}
                                title={t("Outros status: {count}", { count: formatNumber(remaining) })}
                              />
                            ) : null}
                          </div>
                        </div>
                        <div className="regional-statuses">
                          {leadingStatuses.map((status) => (
                            <span key={status.status} title={statusLabel(status.status)}>
                              <StatusDot color={status.color} /> {statusLabel(status.status)} · {formatCompact(status.value)}
                            </span>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyChart message={t("Não há regionais com movimento para os filtros selecionados.")} />
              )}
            </section>

            <section className="table-card" aria-labelledby="detail-heading">
              <div className="table-card-top">
                <div>
                  <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                  <h2 id="detail-heading">{t("Dados por base")}</h2>
                  <p>{t("Datas consolidadas no período, ordenadas pelo maior total.")}</p>
                </div>
                <div className="table-detail-actions">
                  <button className="table-download-button" type="button" onClick={downloadMonitoringTableExcel} disabled={tableRows.length === 0}>
                    <FileSpreadsheet size={17} />
                    {t("Baixar Excel")}
                  </button>
                  <label className="table-search">
                    <Search size={16} />
                    <span className="sr-only">{t("Buscar base ou regional")}</span>
                    <input
                      value={tableQuery}
                      onChange={(event) => {
                        setTableQuery(event.target.value);
                        setPage(1);
                      }}
                      placeholder={t("Buscar base ou regional")}
                    />
                  </label>
                </div>
              </div>
              {visibleTableRows.length > 0 ? (
                <>
                  <div className="table-scroll">
                    <table className="dashboard-data-table">
                      <thead>
                        <tr>
                          <th>{t("Período")}</th>
                          <th>{t("Regional")}</th>
                          <th>{t("Base")}</th>
                          <th>{t("Origem do pedido")}</th>
                          <th>RM</th>
                          <th>RGM</th>
                          {selectedStatusList.map((metric) => <th key={metric}>{t(metric)}</th>)}
                          <th>{t("Total")}</th>
                        </tr>
                      </thead>
                      <tbody className="screen-table-body">
                        {visibleTableRows.map((row) => {
                          return (
                            <tr key={row.key}>
                              <td className="date-cell">{row.period}</td>
                              <td><span className="regional-chip">{row.region}</span></td>
                              <td className="base-cell">{row.base}</td>
                              <td>{t(row.origin)}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                              <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                              {selectedStatusList.map((metric) => (
                                <td className="number-cell" key={metric}>{formatNumber(monitoringMetricValueFromMap(row.values, loaded.statuses, metric))}</td>
                              ))}
                              <td className="number-cell total-cell">{formatNumber(row.total)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tbody className="print-table-body">
                        {tableRows.map((row) => (
                          <tr key={row.key}>
                            <td className="date-cell">{row.period}</td>
                            <td><span className="regional-chip">{row.region}</span></td>
                            <td className="base-cell">{row.base}</td>
                            <td>{t(row.origin)}</td>
                            <td>{responsibilityForBase(responsibilityLoaded, row.base).rm}</td>
                            <td>{responsibilityForBase(responsibilityLoaded, row.base).rgm}</td>
                            {selectedStatusList.map((metric) => (
                              <td className="number-cell" key={metric}>{formatNumber(monitoringMetricValueFromMap(row.values, loaded.statuses, metric))}</td>
                            ))}
                            <td className="number-cell total-cell">{formatNumber(row.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-footer">
                    <span>
                      {t("Mostrando {from}–{to} de {total} bases consolidadas", {
                        from: formatNumber((activePage - 1) * PAGE_SIZE + 1),
                        to: formatNumber(Math.min(activePage * PAGE_SIZE, tableRows.length)),
                        total: formatNumber(tableRows.length),
                      })}
                    </span>
                    <div className="pagination" aria-label={t("Paginação da tabela")}>
                      <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={activePage === 1}>{t("Anterior")}</button>
                      <span>{t("Página {page} de {pages}", { page: activePage, pages: pageCount })}</span>
                      <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={activePage === pageCount}>{t("Próxima")}</button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="table-empty">
                  <Database size={28} />
                  <h3>{t("Nenhum dado encontrado")}</h3>
                  <p>{t("Ajuste a busca ou os filtros para visualizar os registros.")}</p>
                  <button type="button" onClick={() => resetFilters()}>{t("Limpar filtros")}</button>
                </div>
              )}
            </section>

            <footer className="dashboard-footer">
              <span><ShieldCheck size={15} /> {t("Última base publicada disponível para todos pelo link")}</span>
              <span>{t("Arquivo: {file} · Atualizado em {date}", { file: loaded.fileName, date: formatDateTime(loaded.updatedAt) })}</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
