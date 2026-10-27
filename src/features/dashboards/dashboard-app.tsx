"use client";

import { monitorMappingRevision } from "../../lib/data-foundation/mapping-revision.ts";

import { CollectionRateV3MonthlyChart } from "./collection-rate-v3-monthly-chart.tsx";
import { NoMovementOperationalAnalysis } from "./no-movement-operational-analysis.tsx";
import { NoMovementFeishuReportDialog } from "./no-movement-feishu-report-dialog.tsx";
import { OperationalFeishuReportDialog } from "./operational-feishu-report-dialog.tsx";
import { CollectionRateOperationalAnalysis } from "./collection-rate-operational-analysis.tsx";
import { PddCollectionFailureOperationalAnalysis } from "./pdd-collection-failure-operational-analysis.tsx";

import { AssistantHome } from "../home/assistant-home";
import { DataFoundationAdmin } from "../data-foundation/data-foundation-admin";
import { dashboardCards, type DashboardPanel } from "./dashboard-catalog";
import { DASHBOARD_V2_SOURCE_BY_PANEL, loadDashboardSourceAvailability } from "./dashboard-availability.ts";
import { DashboardActionBand } from "./dashboard-action-band";
import { UserControl } from "../users/user-control";
import { FeishuShareDialog, type FeishuSharePreview } from "../../components/feishu-share-dialog";
import { DataSourceDialog, type DataSourceSummary } from "../data-sources/data-source-dialog";
import { ResponsibilitySourceDialog } from "../data-sources/responsibility-source-dialog";
import { PresentationAuthTransition, PresentationLogin } from "../auth/presentation-login";
import { viewerAuthStateFromResponse, type ViewerAuthState } from "../../lib/viewer-auth-state";
import { apiFetch, apiUrl, subscribeToProtectedApiAuthorizationFailure } from "../../lib/api-url.ts";
import { invalidateDashboardDataCache, loadCachedDashboardData, readDashboardDataManifest } from "../../lib/data-foundation/dashboard-data-cache.ts";
import { formatCollaboratorName } from "../../lib/profile-name.ts";
import { organizationalRegionLabel, type OrganizationalRegionStatus } from "../../lib/organizational-region.ts";
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
  Layers3,
  LogOut,
  MapPin,
  Moon,
  PackageCheck,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  TrendingUp,
  Upload,
  UserRound,
  UsersRound,
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
  type ReactNode,
} from "react";
import {
  buildBipagemLoadedData,
  summarizeBipagem,
  summarizeBipagemByBase,
  summarizeBipagemByRegional,
  type BipagemLoadedData,
  type BipagemMetrics,
} from "../../lib/bipagem";
import {
  buildSellerReportRows,
  filterSellerReportRows,
  filterSellerRowsByOutcome,
  normalizeSellerCategory,
  resolveSellerOrganization,
  sellerCategoryMatches,
  sortSellerReportRowsByAwaiting,
  summarizeAwaitingByBaseAndRm,
  summarizeSellerOutcomes,
  type SellerOutcome,
  type SellerCategory,
  type SellerReportMode,
  type SellerReportRow,
} from "../../lib/seller-monitoring";
import {
  DASHBOARD_LANGUAGES,
  dashboardHtmlLang,
  dashboardLocale,
  isDashboardLanguage,
  translateDashboardText,
  type DashboardLanguage,
  type DashboardTranslator,
} from "../../lib/i18n";
import type { ParsedWorkbook, WorkbookRow } from "../../lib/workbook";
import {
  filterRowsByReferenceBaseNames,
  normalizeReferenceBaseName,
  REFERENCE_BASE_TEST_NAMES,
} from "../../lib/data-foundation/reference-base-test";
import { getMonitoringSource } from "../../lib/data-sources/monitoring";
import { getTaxaSource } from "../../lib/data-sources/taxa";
import { initialRegionSelection } from "../../lib/initial-region-selection";
import { DASHBOARD_DATA_SOURCES } from "../../lib/data-sources/catalog";
import type { DashboardSourceId, ManualDataSource } from "../../lib/data-sources/api";
import { buildDamageData, type DamageData } from "../../lib/damage";
import {
  aggregateMovementByRegion,
  aggregateMovementByRm,
  deriveMovementFilterOptions,
  initialMovementFilterSelections,
  MOVEMENT_SUMMARY_METRICS,
  movementSelectionsAfterChange,
  summarizeMovementSnapshot,
  selectMovementSummaryMetric,
} from "../../lib/movement-summary";
import {
  formatTaxaRate as formatNullableTaxaRate,
  legacyTaxaAverageCollectionHours,
  summarizeTaxaByMonth,
  summarizeTaxaPeriod,
  taxaRate,
} from "../../lib/taxa-summary";
import {
  collectionRateV3FilterOptions,
  filterCollectionRateV3Rows,
  groupCollectionRateV3Rows,
  mapCollectionRateV3Record,
  summarizeCollectionRateV3Cards,
  summarizeCollectionRateV3Daily,
  collectionRateV3MonthlyChartPoints,
  collectionRateV3ProgressWidth,
  summarizeCollectionRateV3Origins,
  summarizeCollectionRateV3RegionalAttempts,
  collectionRateV3ExcelNumberFormat,
  collectionRateV3ExcelValue,
  formatCollectionRateV3RegionalAttemptRate,
  formatCollectionRateV3Cell,
  type CollectionRateV3DashboardRow,
  type CollectionRateV3Filters,
} from "../../lib/data-foundation/collection-rate-v3-dashboard.ts";
import {
  monitoringAwaitingRate,
  monitoringCollectedVolume,
  monitoringCollectionRate,
  summarizeMonitoringStatusValues,
} from "../../lib/monitoring-formulas";
import { extractSpecialSellerCodes } from "../../lib/special-sellers";
import {
  DASHBOARD_DEMO_FIXTURES,
  DEMO_WORKBOOK_NAME,
  scopeDemoSellerReference,
  scopeDemoWorkbook,
} from "../../lib/demo-fixtures";
import { aggregateTaxaRmPoc } from "../../lib/taxa-rm-poc";
import { readResponsibilityWorkbookResponse } from "../../lib/responsibility-loader";
import { getSellerMonitoringSource } from "../../lib/data-sources/seller-monitoring";
import { CollectionMonitoringV2Dashboard } from "./collection-monitoring-v2";
import { CollectionMonitoringT4T5Dashboard } from "./collection-monitoring-t4-t5";
import { DashboardLoadingSkeleton } from "./dashboard-loading-skeleton";
import {
  canReadDashboardV2Data,
  canReadMonitoringV2,
  loadPublishedMonitoringWorkbook,
  MonitoringV2LoadError,
  yesterdayInSaoPaulo,
} from "../../lib/data-foundation/monitoring";
import type { DashboardAvailabilityState } from "../../lib/data-foundation/dashboard-availability.ts";
import {
  COLLECTION_RATE_V3_COLUMNS,
  COLLECTION_RATE_V3_HEADERS,
  CollectionRateV3LoadError,
  loadPublishedCollectionRateV3,
  type CollectionRateV3Record,
} from "../../lib/data-foundation/collection-rate-v3.ts";
import {
  loadCurrentNoMovementSnapshot,
  NoMovementV2LoadError,
  NO_MOVEMENT_V2_COLUMNS,
  type NoMovementV2Record,
} from "../../lib/data-foundation/no-movement";
import {
  formatNoMovementSourceCell,
  mapNoMovementV2Record,
  noMovementSourceColumnKind,
  noMovementSourceExcelNumberFormat,
  noMovementSourceExcelValue,
  NO_MOVEMENT_SOURCE_HEADERS,
  noMovementAvailabilityMessage,
} from "../../lib/data-foundation/no-movement-dashboard";
import {
  loadPublishedPddCollectionFailure,
  PDD_COLLECTION_FAILURE_V2_COLUMNS,
  PddCollectionFailureV2LoadError,
  type PddCollectionFailureV2Period,
  type PddCollectionFailureV2Record,
} from "../../lib/data-foundation/pdd-collection-failure";
import {
  analyzePddCollectionFailureV2,
  isPddCollectionFailureV2SingleOperationalDate,
  pddCollectionFailureV2Dimensions,
  PDD_COLLECTION_FAILURE_V2_FIELDS,
} from "../../lib/data-foundation/pdd-collection-failure-dashboard";
import {
  JT_MONITORING_V2_COLUMNS,
  JT_MONITORING_V2_MAX_PREVIEW_ROWS,

  JtMonitoringV2LoadError,
  jtMonitoringV2RowIdentity,
  loadJtMonitoringPage,
  type JtMonitoringV2Record,
} from "../../lib/data-foundation/jt-monitoring";
import {
  buildResponsibilityData,
  matchesResponsibility,
  monitoringResponsibilityForBase,
  officialRgmForRegion,
  registeredRegionForBase,
  rmAreaForBase,
  responsibilityForBase,
  responsibilityOptions,

  UNASSIGNED_RGM,
  UNASSIGNED_RM,
  UNASSIGNED_RM_AREA,
  type ResponsibilityData,
} from "../../lib/responsibility";
import {
  allOptionsAreSelected,
  distinctFilterOptions,
  filterRowsByOption,
  optionSelectionFromValues,
  rmGroupReactKey,
  rmSelectionFromValues,
  selectedOptions,
  selectedRmOptions,
  type OptionSelection,
  type RmSelection,
} from "../../lib/rm-selection";

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
const DASHBOARD_THEME_STORAGE_KEY = "jt-dashboard-theme";
type DashboardTheme = "light" | "dark";
const LOCAL_DASHBOARD_DEMO_MODE = (import.meta as ImportMeta & {
  env: { DEV: boolean; VITE_DASHBOARD_DEMO_MODE?: string };
}).env.DEV && (import.meta as ImportMeta & {
  env: { DEV: boolean; VITE_DASHBOARD_DEMO_MODE?: string };
}).env.VITE_DASHBOARD_DEMO_MODE === "true";
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

type DashboardView = "home" | "data-foundation" | DashboardPanel;

const SOURCE_ID_BY_VIEW: Partial<Record<DashboardView, DashboardSourceId>> = {
  monitoramento: "monitoring",
  taxa: "taxa",
  epop: "epop",
  sellers: "sellerPerformance",
  bipagem: "bipagem",
  damage: "damage",
  tt5cd: "tt5cd",
  loss: "loss",
  "last-mile-damage": "last-mile-damage",
  volumetry: "volumetry",
  "no-movement-10-days": "no-movement-10-days",
  "no-movement-3-14-days": "no-movement-3-14-days",
  "retained-10-days": "retained-10-days",
  return: "return",
  "last-mile-sla": "last-mile-sla",
  t0: "t0",
  rollover: "rollover",
  "pod-approval-rate": "pod-approval-rate",
  "pnr-rate": "pnr-rate",
  "pnr-packages-target": "pnr-packages-target",
  "dispatch-delivery-window": "dispatch-delivery-window",
  "shipping-time": "shipping-time",
  "driver-attendance": "driver-attendance",
  "bagging-consolidated-report": "bagging-consolidated-report",
};

function selectedShareFilter(
  selected: ReadonlySet<string>,
  options: readonly string[],
  allLabel: string,
  t: DashboardTranslator,
) {
  if (options.length > 0 && selected.size >= options.length) return t(allLabel);
  if (selected.size === 0) return t("Nenhum selecionado");
  const values = [...selected];
  return values.length <= 4 ? values.join(", ") : t("{count} selecionados", { count: values.length });
}
const FEISHU_COOKIE_SESSION = "feishu-cookie-session";
const FEISHU_AUTH_ERROR_MESSAGES: Record<string, string> = {
  feishu_not_configured: "Configure App ID, App Secret, callback, chave de sessão e tenant corporativo autorizado no ambiente do backend.",
  feishu_access_denied: "Não foi possível vincular esta identidade Feishu a uma conta local.",
  feishu_consent_denied: "O acesso foi recusado no Feishu. Autorize o aplicativo e tente novamente.",
  feishu_email_missing: "O Feishu não forneceu um e-mail para esta conta. Peça ao administrador a permissão de e-mail necessária.",
  feishu_domain_denied: "Esta conta não pertence a um domínio corporativo autorizado.",
  feishu_tenant_denied: "Esta conta não pertence à organização Feishu autorizada para a NEW BI.",
  feishu_identity_incomplete: "O Feishu não retornou a organização e a identidade necessárias para o login.",
  feishu_token_exchange_failed: "O Feishu não aceitou a troca do código. Confira o App ID, App Secret e callback cadastrados.",
  feishu_token_credentials_invalid: "O Feishu não reconheceu as credenciais. Confirme se App ID e App Secret são do mesmo aplicativo.",
  feishu_token_grant_invalid: "O Feishu recusou o código de autorização. Inicie um novo login e conclua a autorização sem reutilizar o código.",
  feishu_token_redirect_invalid: "O callback enviado ao Feishu não corresponde ao autorizado no aplicativo. Confira a URL cadastrada.",
  feishu_token_code_expired_or_used: "O código de autorização expirou ou já foi usado. Inicie o login novamente e conclua sem reutilizar a página anterior.",
  feishu_token_app_unauthorized: "O aplicativo Feishu não está autorizado a usar este fluxo OAuth. Confira as configurações do aplicativo.",
  feishu_token_request_invalid: "O Feishu rejeitou os parâmetros OAuth. Confira o callback e a configuração do aplicativo.",
  feishu_token_response_invalid: "O Feishu respondeu sem um token utilizável. Confira a versão e as configurações OAuth do aplicativo.",
  feishu_user_info_failed: "O token foi recebido, mas o Feishu não retornou o perfil. Confira as permissões básicas e de e-mail do aplicativo.",
  feishu_user_provision_failed: "Não foi possível salvar a conta no banco local de autenticação.",
  feishu_session_failed: "A conta foi validada, mas não foi possível criar a sessão local.",
  feishu_state_invalid: "O estado do login Feishu expirou ou não corresponde a este navegador. Inicie novamente.",
  feishu_storage_not_ready: "O banco local de autenticação não está pronto. Aplique o SQL local aprovado e tente novamente.",
  feishu_callback_mismatch: "O endereço usado para iniciar o login não corresponde ao callback cadastrado. Abra a plataforma em http://127.0.0.1:3001 e mantenha o callback local em http://127.0.0.1:8001/api/auth/feishu/callback.",
  feishu_local_only: "O login Feishu deste ambiente está disponível somente no desenvolvimento local.",
  feishu_auth_failed: "Não foi possível concluir o login Feishu. Tente novamente.",
};
type BipagemProblemType = "collection" | "receipt";
type SellerTier = SellerCategory;
type UploadKind = "monitoring" | "taxa" | "epop" | "sellerList" | "sellerSpecialList" | "bipagem" | "damage";

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
  fileSizeBytes?: number;
  contentType?: string;
  sourceType: "DEMONSTRATION" | "MANUAL_UPLOAD" | "AUTOMATIC_SOURCE" | "DATA_FOUNDATION_V2";
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

async function postWorkbook(
  payload: Record<string, unknown>,
  files: File[],
): Promise<Response> {
  const body = new FormData();
  body.append("payload", JSON.stringify(payload));
  for (const file of files) body.append("files", file, file.name);
  return apiFetch("/api/workbook", {
    method: "POST",
    body,
  });
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
  sourceType: "DEMONSTRATION" | "MANUAL_UPLOAD" | "AUTOMATIC_SOURCE";
  parsed: ParsedWorkbook;
  fileName: string;
  fileSizeBytes?: number;
  contentType?: string;
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
  sourceRegion?: string;
  mappingResolution?: string;
}

interface MovementLoadedData {
  format: "summary" | "list";
  parsed: ParsedWorkbook;
  fileName: string;
  sourceType: "DATA_FOUNDATION_V2";
  fileSizeBytes?: number;
  contentType?: string;
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
  collectionDate?: string | null;
  publishedAt?: string | null;
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
  tier: SellerTier | null;
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
  avatar_url?: string | null;
  role: "matrix" | "regional" | "unknown";
  region: string | null;
  base: string | null;
  platform_role?: "USER" | "ADMIN";
  administrative_scope?: "matrix" | "regional" | "base" | "unknown";
  can_manage_users?: boolean;
  organizational_scope?: "matrix" | "regional" | "base" | "unknown";
  data_scope_source?: "feishu" | "admin_grant" | "none";
  home_region?: string | null;
  organizational_region_code?: string | null;
  region_resolution_status?: OrganizationalRegionStatus;
  home_base?: string | null;
  additional_regions?: string[];
  effective_regions?: string[] | null;
  is_active?: boolean;
}

function sameViewerIdentity(left: ViewerIdentity | null, right: ViewerIdentity): boolean {
  if (!left) return false;
  const sameArray = (a: string[] | null | undefined, b: string[] | null | undefined) =>
    (a ?? []).length === (b ?? []).length && (a ?? []).every((value, index) => value === (b ?? [])[index]);
  return left.username === right.username &&
    left.avatar_url === right.avatar_url &&
    left.role === right.role &&
    left.region === right.region &&
    left.base === right.base &&
    left.platform_role === right.platform_role &&
    left.administrative_scope === right.administrative_scope &&
    left.can_manage_users === right.can_manage_users &&
    left.organizational_scope === right.organizational_scope &&
    left.data_scope_source === right.data_scope_source &&
    left.home_region === right.home_region &&
    left.organizational_region_code === right.organizational_region_code &&
    left.region_resolution_status === right.region_resolution_status &&
    left.home_base === right.home_base &&
    left.is_active === right.is_active &&
    sameArray(left.effective_regions, right.effective_regions) &&
    sameArray(left.additional_regions, right.additional_regions);
}

function dashboardIdentityCacheKey(sessionId: string, identity: ViewerIdentity | null): string {
  if (!identity) return "";
  return JSON.stringify([
    sessionId,
    identity.username,
    identity.platform_role,
    identity.administrative_scope,
    identity.can_manage_users,
    identity.organizational_scope,
    identity.data_scope_source,
    identity.role,
    identity.home_region,
    identity.home_base,
    identity.effective_regions,
    identity.additional_regions,
    identity.organizational_region_code,
    identity.region_resolution_status,
  ]);
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

function bipagemMissingForProblem(metrics: BipagemMetrics, problem: BipagemProblemType): number {
  return problem === "collection" ? metrics.notScannedCollection : metrics.notScannedReceipt;
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
  const values = new Map(statuses.map((status) => [status, parseNumeric(row[status])]));
  return summarizeMonitoringStatusValues(statuses, values, monitoringMeasureForStatus);
}

function monitoringMeasureForStatus(status: string): "planned" | "awaiting" | "collected" | null {
  const metric = monitoringMetricForStatus(status);
  if (metric === "Previsto a coletar") return "planned";
  if (metric === "Aguardando coleta") return "awaiting";
  return metric === "Coletado" ? "collected" : null;
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

function firstScanDisplayMeasures(metrics: FirstScanMetrics): number[] {
  return [firstScanTotalRetained(metrics), metrics.baseRetained, metrics.baseDispatched, metrics.hubArrived];
}

function PtZhHeader({ pt, zh }: { pt: string; zh: string }) {
  return <span className="pt-zh-header"><span>{pt}</span><small>{zh}</small></span>;
}

function monitoringMetricValueFromMap(
  values: ReadonlyMap<string, number>,
  statuses: readonly string[],
  metric: MonitoringMetric,
): number {
  const summary = summarizeMonitoringStatusValues(statuses, values, monitoringMeasureForStatus);
  if (metric === "Previsto a coletar") return summary.orderVolume;
  if (metric === "Aguardando coleta") return summary.awaiting;
  return summary.collected;
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
  selected: ReadonlySet<string>,
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

function buildLoadedData(
  parsed: ParsedWorkbook,
  fileName: string,
  updatedAt?: string,
  sourceType: LoadedData["sourceType"] = "MANUAL_UPLOAD",
  fileSizeBytes?: number,
  contentType?: string,
): LoadedData {
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
    fileSizeBytes,
    contentType,
    sourceType,
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
  columnNumberFormats?: readonly (string | undefined)[];
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
        const numberFormat = sheet.columnNumberFormats?.[columnIndex];
        if (rowIndex >= 2 && numberFormat && typeof cell.v === "number") cell.z = numberFormat;
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

function formatTaxaRate(value: number | null): string {
  return formatNullableTaxaRate(value, dashboardLocale(activeDashboardLanguage()));
}

function buildTaxaLoadedData(
  parsed: ParsedWorkbook,
  fileName: string,
  updatedAt?: string,
  sourceType: TaxaLoadedData["sourceType"] = "MANUAL_UPLOAD",
  fileSizeBytes?: number,
  contentType?: string,
): TaxaLoadedData {
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
    sourceType,
    parsed,
    fileName,
    fileSizeBytes,
    contentType,
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

function buildNoMovementV2LoadedData(snapshot: {
  records: NoMovementV2Record[];
  updatedAt: string | null;
  collectionDate: string | null;
  publishedAt: string | null;
}): MovementLoadedData {
  const sourceHeaders = Object.values(NO_MOVEMENT_SOURCE_HEADERS);
  const records = snapshot.records.map(mapNoMovementV2Record);
  const rawRows = records.map((record) => record.values);
  const headersByKey = NO_MOVEMENT_SOURCE_HEADERS;
  const columns: MovementColumns = {
    region: headersByKey.reported_region,
    code: headersByKey.source_base_code,
    base: headersByKey.source_base_name,
    totalStopped: headersByKey.stopped_orders,
    inTransit: headersByKey.orders_in_transit,
    over1Day: headersByKey.stopped_over_1_day,
    over2Days: headersByKey.stopped_over_2_days,
    over3Days: headersByKey.stopped_over_3_days,
    over4Days: headersByKey.stopped_over_4_days,
    over5Days: headersByKey.stopped_over_5_days,
    over6Days: headersByKey.stopped_over_6_days,
    over7Days: headersByKey.stopped_over_7_days,
    over10Days: headersByKey.stopped_over_10_days,
    over14Days: headersByKey.stopped_over_14_days,
    over30Days: headersByKey.stopped_over_30_days,
    lastOperation: headersByKey.last_operation_at,
    rate14Days: headersByKey.stopped_14_plus_days_rate,
    rate30Days: headersByKey.stopped_30_plus_days_rate,
    date: "",
    aging: "",
    status: "",
    origin: "",
    quantity: headersByKey.stopped_orders,
  };
  const parsed: ParsedWorkbook = {
    sheetName: "Dados",
    headers: sourceHeaders,
    rows: rawRows,
    regionColumn: columns.region,
    baseColumn: columns.base,
    statusColumns: sourceHeaders.slice(3).filter((header) => header !== columns.lastOperation),
    metadata: {
      sheetNames: ["Dados", "Execucoes", "Dicionario"],
      headerRow: 1,
      rowCount: records.length,
      columnCount: sourceHeaders.length,
      columns: sourceHeaders.map((header, index) => ({
        key: header,
        originalHeader: header,
        normalizedHeader: normalizeHeaderText(header),
        index,
        role: "data",
      })),
      date1904: false,
    },
    warnings: [],
  };
  const bases = [...new Set(records.map((record) => record.base))].sort((left, right) => left.localeCompare(right, "pt-BR", { numeric: true }));
  const regions = [...new Set(records.map((record) => record.region))].sort((left, right) => left.localeCompare(right, "pt-BR", { numeric: true }));
  return {
    format: "summary",
    parsed,
    fileName: "Snapshot JMS · Data Foundation V2",
    sourceType: "DATA_FOUNDATION_V2",
    columns,
    records,
    bases,
    regions,
    dates: [],
    agings: ["Todas as faixas"],
    statuses: ["Resumo JMS"],
    origins: ["Sem origem"],
    initialStart: "",
    initialEnd: "",
    displayColumns: sourceHeaders,
    blankBaseRows: records.filter((record) => record.base === "Sem base").length,
    blankRegionRows: records.filter((record) => record.region === "Sem regional").length,
    updatedAt: snapshot.updatedAt ?? undefined,
    collectionDate: snapshot.collectionDate,
    publishedAt: snapshot.publishedAt,
  };
}

function buildEmptyNoMovementV2LoadedData(): MovementLoadedData {
  return buildNoMovementV2LoadedData({ records: [], updatedAt: null, collectionDate: null, publishedAt: null });
}

function taxaBasesForRegions(data: TaxaLoadedData, regions: Set<string>): string[] {
  return Array.from(
    new Set(data.records.filter((record) => regions.has(record.region)).map((record) => record.base)),
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
  const availableCategories = SELLER_CATEGORIES.filter((category) =>
    data.records.some((record) => record.tier === category),
  );
  return Array.from(
    new Set(
      data.records
        .filter((record) =>
          regions.has(registeredRegionForBase(responsibility, record.base, record.region)) &&
          bases.has(record.base) &&
          sellerCategoryMatches(record.tier, tiers, availableCategories))
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
  reference: SellerReferenceData | null,
  fileName: string,
  updatedAt?: string,
  responsibility: ResponsibilityData | null = null,
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

  const sellerMap = new Map((reference?.records ?? []).map((record) => [record.sellerCode, record]));
  let unknownSellerRows = 0;
  const matchedRecords = parsed.rows.flatMap((row, index) => {
    const date = toDashboardISODate(row[columns.date]);
    if (!date) return [];
    const sellerCode = normalizeSellerCode(row[columns.sellerCode]) || "Sem código";
    const referenceRecord = sellerMap.get(sellerCode);
    if (reference && !referenceRecord) {
      unknownSellerRows += 1;
    }
    const awaiting = taxaValue(row, columns.awaiting);
    const dropOff = taxaValue(row, columns.dropOff);
    const collected = taxaValue(row, columns.collected);
    const received = taxaValue(row, columns.received);
    const receivedBase = taxaValue(row, columns.receivedBase);
    const inTransitBase = taxaValue(row, columns.inTransitBase);
    const arrivedSc = taxaValue(row, columns.arrivedSc);
    const processed = dropOff + collected + received + receivedBase + inTransitBase + arrivedSc;
    const total = awaiting + processed;

    const base = String(row[columns.base] ?? "").trim() || "Sem base";
    const rawRegion = String(row[columns.region] ?? "").trim() || "Sem regional";
    const organization = resolveSellerOrganization({ base, region: rawRegion }, responsibility);
    return [{
      key: `${date}::${sellerCode}::${index}`,
      date,
      region: organization.region,
      base,
      client: String(row[columns.client] ?? "").trim() || "Sem cliente",
      sellerName: String(row[columns.sellerName] ?? "").trim() || "Sem loja",
      sellerCode,
      origin: String(row[columns.origin] ?? "").trim() || "Sem origem",
      tier: referenceRecord?.tier ?? null,
      isSpecial: referenceRecord?.isSpecial ?? false,
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
  const missingRecords = (reference?.records ?? [])
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
  selected: ReadonlySet<string>;
  onChange: (value: Set<string>) => void;
  allLabel: string;
  singular: string;
  plural: string;
  searchable?: boolean;
  resetSearchOnOpen?: boolean;
  colorOptions?: string[];
  getOptionLabel?: (option: string) => string;
  disabled?: boolean;
  disabledLabel?: string;
  disabledReason?: string;
  exclusiveGroup?: string;
  t: DashboardTranslator;
}

function positionMultiSelectPopover(element: HTMLDetailsElement): void {
  if (typeof window === "undefined") return;
  const bounds = element.getBoundingClientRect();
  const popoverWidth = Math.min(Math.max(bounds.width, 320), Math.max(0, window.innerWidth - 32));
  const fitsLeft = bounds.left + popoverWidth <= window.innerWidth - 16;
  const fitsRight = bounds.right - popoverWidth >= 16;
  element.dataset.popoverAlign = fitsLeft || !fitsRight ? "left" : "right";
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
  resetSearchOnOpen = false,
  colorOptions,
  getOptionLabel = (option) => option,
  disabled = false,
  disabledLabel,
  disabledReason,
  exclusiveGroup,
  t,
}: MultiSelectProps) {
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const allSelected = allOptionsAreSelected(options, selected);
  const selectedLabel = disabled && disabledLabel ? disabledLabel : allSelected
    ? allLabel
    : selected.size === 1
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

  useEffect(() => {
    if (!exclusiveGroup) return undefined;
    const closeOtherMenus = (event: Event) => {
      const detail = (event as CustomEvent<{ group: string; element: HTMLDetailsElement }>).detail;
      if (detail?.group === exclusiveGroup && detail.element !== detailsRef.current && detailsRef.current) {
        detailsRef.current.open = false;
      }
    };
    const closeOutside = (event: PointerEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailsRef.current?.open) {
        detailsRef.current.open = false;
        detailsRef.current.querySelector("summary")?.focus();
      }
    };
    const repositionOpenMenu = () => {
      if (detailsRef.current?.open) positionMultiSelectPopover(detailsRef.current);
    };
    document.addEventListener("dashboard-multiselect-open", closeOtherMenus);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", repositionOpenMenu);
    return () => {
      document.removeEventListener("dashboard-multiselect-open", closeOtherMenus);
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", repositionOpenMenu);
    };
  }, [exclusiveGroup]);

  return (
    <div className="filter-field">
      <span className="filter-label">{label}</span>
      <details
        ref={detailsRef}
        className="multi-select"
        aria-disabled={disabled || undefined}
        title={disabled ? disabledReason : undefined}
        style={disabled ? { opacity: 0.65, cursor: "not-allowed" } : undefined}
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          if (resetSearchOnOpen) setQuery("");
          if (exclusiveGroup) {
            positionMultiSelectPopover(event.currentTarget);
            document.dispatchEvent(new CustomEvent("dashboard-multiselect-open", {
              detail: { group: exclusiveGroup, element: event.currentTarget },
            }));
          }
        }}
      >
        <summary
          aria-disabled={disabled || undefined}
          onClick={disabled ? (event) => event.preventDefault() : undefined}
        >
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
  canManageUpload: boolean;
  onDrop?: (file: File) => void;
  onAddSource?: () => void;
  inputId?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
  sourceLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  loadingDescription?: string;
  periodStart?: string;
  periodEnd?: string;
  onPeriodStartChange?: (value: string) => void;
  onPeriodEndChange?: (value: string) => void;
  onRetry?: () => void;
  t: DashboardTranslator;
}

function EmptyDashboardPanel({ loading, error, canManageUpload, onDrop, onAddSource, t, inputId = "monitoring-upload", eyebrow, title, description, sourceLabel, emptyTitle, emptyDescription, loadingDescription, periodStart, periodEnd, onPeriodStartChange, onPeriodEndChange, onRetry }: EmptyDashboardPanelProps) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && canManageUpload) {
      if (onAddSource) onAddSource();
      else onDrop?.(file);
    }
  };

  return (
    <>
      <section className="dashboard-intro">
        <div>
          <div className="eyebrow"><Activity size={15} /> {t(eyebrow ?? "Visão consolidada")}</div>
          <h1>{t(title ?? "DASH BOARD - MONITORAMENTO DE COLETA")}</h1>
          <p>{t(description ?? "O dashboard abre a última planilha publicada. Carregue um Excel para atualizar todos os acessos.")}</p>
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
          {onRetry ? <button type="button" onClick={onRetry}>{t("Tentar novamente")}</button> : null}
        </div>
      ) : null}

      {periodStart !== undefined && periodEnd !== undefined && onPeriodStartChange && onPeriodEndChange ? (
        <section className="filters-card monitoring-empty-period" aria-label={t("Selecionar período dos dados")}>
          <div className="filter-grid monitoring-filter-grid">
            <div className="filter-field date-field">
              <label className="filter-label" htmlFor="empty-date-start">{t("Data inicial")}</label>
              <div className="date-input-wrap">
                <CalendarDays size={16} />
                <input id="empty-date-start" type="date" value={periodStart} onChange={(event) => onPeriodStartChange(event.target.value)} />
              </div>
            </div>
            <div className="filter-field date-field">
              <label className="filter-label" htmlFor="empty-date-end">{t("Data final")}</label>
              <div className="date-input-wrap">
                <CalendarDays size={16} />
                <input id="empty-date-end" type="date" value={periodEnd} onChange={(event) => onPeriodEndChange(event.target.value)} />
              </div>
            </div>
          </div>
        </section>
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
          <span className="card-eyebrow">{t(sourceLabel ?? "ARQUIVO DE MONITORAMENTO")}</span>
        <h2>{t(loading ? "Buscando última atualização..." : emptyTitle ?? (onAddSource ? "Nenhuma fonte de dados carregada." : "Publique o arquivo Excel"))}</h2>
        <p>{t(loading && loadingDescription ? loadingDescription : emptyDescription ?? (onAddSource ? "Adicione uma planilha para alimentar este painel. Os dados serão pré-visualizados antes da confirmação." : "Arraste a planilha para cá ou selecione o arquivo baixado. Depois de publicar, todos veem a mesma atualização pelo link."))}</p>
      </div>
      {canManageUpload ? onAddSource ? (
        <button className="primary-upload-button" type="button" onClick={onAddSource} disabled={loading}>
          <Database size={18} /> {t("Adicionar fonte de dados")}
        </button>
      ) : (
        <label className="primary-upload-button" htmlFor={inputId}>
          <Upload size={18} />
          {t(loading ? "Processando…" : "Carregar arquivo Excel")}
        </label>
      ) : null}
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
  return <>{translateDashboardText(language, source, values)}</>;
}

function PendingLastMileDashboard({ title, onOpenSource, canManageSource, t }: {
  title: string;
  onOpenSource: () => void;
  canManageSource: boolean;
  t: DashboardTranslator;
}) {
  return (
    <>
      <section className="dashboard-intro">
        <div>
          <div className="eyebrow"><Database size={15} /> {t("LAST MILE")}</div>
          <h1>{t(title)}</h1>
        </div>
      </section>
      <section className="last-mile-pending-panel" aria-labelledby="last-mile-pending-title">
        <p id="last-mile-pending-title">{t("Este painel está aguardando configuração da fonte de dados.")}</p>
        {canManageSource ? <button type="button" onClick={onOpenSource}><Database size={16} /> {t("Fonte de dados")}</button> : null}
      </section>
    </>
  );
}

function monitoringResponsibilityForRow(
  data: ResponsibilityData | null,
  row: WorkbookRow,
  base: string,
  regionalOrigin: string,
) {
  if (row.__publicationId !== undefined || row.__mappingResolution !== undefined) {
    return {
      rm: String(row.__effectiveRm ?? UNASSIGNED_RM),
      rgm: String(row.__effectiveRgm ?? UNASSIGNED_RGM),
      rmArea: String(row.__effectiveRmArea ?? UNASSIGNED_RM_AREA),
      source: row.__mappingApproved === true ? "de-para" as const : "não encontrado" as const,
    };
  }
  return monitoringResponsibilityForBase(data, base, regionalOrigin);
}

function matchesMonitoringResponsibility(
  data: ResponsibilityData | null,
  base: string,
  regionalOrigin: string,
  selectedRms: ReadonlySet<string>,
  selectedRgms: ReadonlySet<string>,
  row?: WorkbookRow,
): boolean {
  const { rm, rgm } = row
    ? monitoringResponsibilityForRow(data, row, base, regionalOrigin)
    : monitoringResponsibilityForBase(data, base, regionalOrigin);
  return selectedRms.has(rm) && selectedRgms.has(rgm);
}

function monitoringResponsibilityOptionsForData(data: LoadedData, responsibility: ResponsibilityData | null) {
  const rms = new Set<string>();
  const rgms = new Set<string>();
  if (data.parsed.baseColumn) {
    for (const row of data.parsed.rows) {
      const base = rowBase(row, data.parsed.baseColumn);
      const assignment = monitoringResponsibilityForRow(responsibility, row, base, rowRegion(row, data.parsed.regionColumn));
      rms.add(assignment.rm);
      rgms.add(assignment.rgm);
    }
  }
  return {
    rms: [...rms].sort((a, b) => a.localeCompare(b, "pt-BR")),
    rgms: [...rgms].sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}

function monitoringBasesForSelection(
  data: LoadedData,
  regions: Set<string>,
  responsibility: ResponsibilityData | null,
  selectedRms: ReadonlySet<string>,
  selectedRgms: ReadonlySet<string>,
): string[] {
  if (!data.parsed.baseColumn) return [];
  const basesInSourceRegions = new Set(basesForRegions(data, regions));
  return Array.from(new Set(data.parsed.rows.filter((row) => {
    const base = rowBase(row, data.parsed.baseColumn as string);
    const region = rowRegion(row, data.parsed.regionColumn);
    return basesInSourceRegions.has(base) && matchesMonitoringResponsibility(responsibility, base, region, selectedRms, selectedRgms, row);
  }).map((row) => rowBase(row, data.parsed.baseColumn as string))))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function LanguageSwitcher({ language, onChange, t }: {
  language: DashboardLanguage;
  onChange: (nextLanguage: DashboardLanguage) => void;
  t: DashboardTranslator;
}) {
  return (
    <div className="presentation-language-switcher" role="group" aria-label={t("Selecionar idioma")}>
      {DASHBOARD_LANGUAGES.map((option) => (
        <button
          type="button"
          key={option.code}
          className={language === option.code ? "active" : ""}
          aria-pressed={language === option.code}
          aria-label={t(option.code === "pt" ? "Português" : option.code === "zh" ? "Chinês simplificado" : "Inglês")}
          onClick={() => onChange(option.code)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function UserProfileMenu({ identity, canManageDataSources, canManageUsers, theme, onToggleTheme, onOpenDataSources, onOpenUserControl, onSignOut, t }: {
  identity: ViewerIdentity;
  canManageDataSources: boolean;
  canManageUsers: boolean;
  theme: DashboardTheme;
  onToggleTheme: () => void;
  onOpenDataSources: () => void;
  onOpenUserControl: () => void;
  onSignOut: () => void;
  t: DashboardTranslator;
}) {
  const [open, setOpen] = useState(false);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rawName = identity.username.trim() || t("Colaborador");
  const fullName = formatCollaboratorName(rawName);
  const avatarUrl = identity.avatar_url?.trim() || null;
  const avatarLoadFailed = Boolean(avatarUrl && failedAvatarUrl === avatarUrl);
  const displayName = fullName.split(/\s+/)[0] || t("Colaborador");
  const adminActionCount = Number(canManageDataSources) + Number(canManageUsers);
  const region = organizationalRegionLabel(
    identity.organizational_region_code,
    identity.region_resolution_status,
    t("Regional não identificada"),
    identity.data_scope_source,
  );
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const initials = nameParts.length > 1
    ? `${Array.from(nameParts[0])[0] ?? ""}${Array.from(nameParts.at(-1) ?? "")[0] ?? ""}`
    : Array.from(nameParts[0] ?? "").slice(0, 2).join("");

  const renderAvatar = (size: 18 | 22) => avatarUrl && !avatarLoadFailed
    ? <img src={avatarUrl} alt="" aria-hidden="true" referrerPolicy="no-referrer" onError={() => setFailedAvatarUrl(avatarUrl)} />
    : initials || <UserRound size={size} />;

  useEffect(() => {
    if (!open) return undefined;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleMenuKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const availableItems = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
      if (!availableItems.length) return;
      event.preventDefault();
      const currentIndex = availableItems.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? availableItems.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + availableItems.length) % availableItems.length;
      availableItems[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", closeWhenOutside, true);
    document.addEventListener("keydown", handleMenuKeys);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside, true);
      document.removeEventListener("keydown", handleMenuKeys);
    };
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const closeAndRun = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div
      className="profile-menu"
      ref={rootRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !rootRef.current?.contains(nextTarget)) setOpen(false);
      }}
    >
      <button
        className="profile-menu-trigger"
        type="button"
        ref={triggerRef}
        aria-label={`${t("Menu do usuário")}: ${fullName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="profile-menu-options"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="profile-avatar" aria-hidden="true">{renderAvatar(18)}</span>
        <span className="profile-trigger-copy">
          <strong>{displayName}</strong>
          <small>{region}</small>
        </span>
        <ChevronDown className={`profile-menu-chevron${open ? " is-open" : ""}`} size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="profile-menu-popover" id="profile-menu-options" role="menu" aria-label={t("Perfil do colaborador")}>
          <div className="profile-menu-identity">
            <span className="profile-avatar profile-avatar-large" aria-hidden="true">{renderAvatar(22)}</span>
            <span><strong>{fullName}</strong><small>{region}</small></span>
          </div>
          <div className="profile-menu-separator" role="separator" />
          {adminActionCount > 0 ? <>
            {canManageDataSources ? <button ref={(element) => { itemRefs.current[0] = element; }} type="button" role="menuitem" onClick={() => closeAndRun(onOpenDataSources)}>
              <Database size={16} aria-hidden="true" /> {t("Fontes de dados")}
            </button> : null}
            {canManageUsers ? <button ref={(element) => { itemRefs.current[canManageDataSources ? 1 : 0] = element; }} type="button" role="menuitem" onClick={() => closeAndRun(onOpenUserControl)}>
              <UsersRound size={16} aria-hidden="true" /> {t("Controle de usuários")}
            </button> : null}
            <div className="profile-menu-separator" role="separator" />
          </> : null}
          <button ref={(element) => { itemRefs.current[adminActionCount] = element; }} type="button" role="menuitem" onClick={() => closeAndRun(onToggleTheme)}>
            {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            {t(theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro")}
          </button>
          <button className="profile-menu-signout" ref={(element) => { itemRefs.current[adminActionCount + 1] = element; }} type="button" role="menuitem" onClick={() => closeAndRun(onSignOut)}>
            <LogOut size={16} aria-hidden="true" /> {t("Sair")}
          </button>
        </div>
      ) : null}
    </div>
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

interface PddCollectionFailureV2DashboardProps {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  records: PddCollectionFailureV2Record[];
  period: PddCollectionFailureV2Period;
  receivedCount: number;
  error: string | null;
  publicationId: string | null;
  publicationIds: string[];
  updatedAt: string | null;
  publishedAt: string | null;
  dataPeriod: PddCollectionFailureV2Period | null;
  progress: { loaded: number; total: number; stage?: "records" | "validation" };
  reportDate: string;
  onPrint: () => void;
  onAnalysis: () => void;
  onShare: (filters: string[]) => void;
  showShare: boolean;
  onPeriodChange: (period: PddCollectionFailureV2Period) => void;
  onRetry: () => void;
  t: DashboardTranslator;
}

const PDD_FAILURE_DETAIL_PAGE_SIZE = 25;
const PDD_FAILURE_QUANTITY_FIELDS = new Set([
  "total_orders",
  "orders_unscanned_at_receipt",
  "orders_unscanned_at_collection",
  "packages_missing_dispatch_scan",
]);
const PDD_FAILURE_RATE_FIELDS = new Set([
  "rate_unscanned_at_receipt",
  "collection_failure_rate",
  "rate_unscanned_at_dispatch",
  "overall_unscanned_rate",
]);

function PddCollectionFailureV2Dashboard({
  status,
  records,
  period,
  receivedCount,
  error,
  publicationId,
  publicationIds,
  updatedAt,
  publishedAt,
  dataPeriod,
  progress,
  reportDate,
  onPrint,
  onAnalysis,
  onShare,
  showShare,
  onPeriodChange,
  onRetry,
  t,
}: PddCollectionFailureV2DashboardProps) {
  const [selectedRegions, setSelectedRegions] = useState<Set<string> | null>(null);
  const [selectedRms, setSelectedRms] = useState<Set<string> | null>(null);
  const [selectedRgms, setSelectedRgms] = useState<Set<string> | null>(null);
  const [selectedBases, setSelectedBases] = useState<Set<string> | null>(null);
  const [selectedOrigins, setSelectedOrigins] = useState<Set<string> | null>(null);
  const [tableQuery, setTableQuery] = useState("");
  const [page, setPage] = useState(1);

  const analysis = useMemo(() => analyzePddCollectionFailureV2(records, {
    regions: selectedRegions,
    rms: selectedRms,
    rgms: selectedRgms,
    bases: selectedBases,
    origins: selectedOrigins,
  }), [records, selectedRegions, selectedRms, selectedRgms, selectedBases, selectedOrigins]);
  const { options, filteredRecords, summary, regionalSummary, rmSummary, baseSummary } = analysis;
  const searchedRecords = useMemo(() => {
    const query = normalizeSearchText(tableQuery.trim());
    if (!query) return filteredRecords;
    return filteredRecords.filter((record) => {
      const dimensions = pddCollectionFailureV2Dimensions(record);
      return normalizeSearchText([
        ...PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => String(record[field] ?? "")),
        dimensions.region, dimensions.base, dimensions.baseCode, dimensions.rmArea,
        dimensions.rm, dimensions.rgm, dimensions.origin,
      ].join(" ")).includes(query);
    });
  }, [filteredRecords, tableQuery]);
  const detailPageCount = Math.max(1, Math.ceil(searchedRecords.length / PDD_FAILURE_DETAIL_PAGE_SIZE));
  const activeDetailPage = Math.min(page, detailPageCount);
  const visibleDetailRecords = searchedRecords.slice(
    (activeDetailPage - 1) * PDD_FAILURE_DETAIL_PAGE_SIZE,
    activeDetailPage * PDD_FAILURE_DETAIL_PAGE_SIZE,
  );
  const hasData = records.length > 0;
  const canExport = status === "ready" && hasData;
  const hasPreviousData = hasData && (status === "loading" || status === "error");
  const emptyMessage = status === "loading" || status === "idle"
    ? t("Carregando…")
    : status === "error"
      ? t("Não foi possível consultar os dados publicados.")
      : status === "empty"
        ? error ? t("Aguardando primeira importação") : t("Sem dados publicados para o período selecionado.")
        : t("Nenhum resultado encontrado");
  const selectionIsDefault = (selected: Set<string> | null, values: string[]) =>
    selected === null || (selected.size === values.length && values.every((value) => selected.has(value)));
  const filtersAreDefault = selectionIsDefault(selectedRegions, options.regions) &&
    selectionIsDefault(selectedRms, options.rms) && selectionIsDefault(selectedRgms, options.rgms) &&
    selectionIsDefault(selectedBases, options.bases) && selectionIsDefault(selectedOrigins, options.origins);
  const selectedValues = (selected: Set<string> | null, values: string[]) =>
    selected === null ? new Set(values) : new Set([...selected].filter((value) => values.includes(value)));
  const formatCell = (record: PddCollectionFailureV2Record, field: (typeof PDD_COLLECTION_FAILURE_V2_FIELDS)[number]) => {
    const value = record[field];
    if (value == null || value === "") return "—";
    if (field === "data_date") return formatDate(String(value).slice(0, 10));
    if (PDD_FAILURE_QUANTITY_FIELDS.has(field)) return formatNumber(Number(value));
    if (PDD_FAILURE_RATE_FIELDS.has(field)) return formatRate(Number(value));
    return String(value);
  };
  const formatExportCell = (record: PddCollectionFailureV2Record, field: (typeof PDD_COLLECTION_FAILURE_V2_FIELDS)[number]): ExcelExportValue => {
    const value = record[field];
    if (value == null || value === "") return "";
    if (PDD_FAILURE_QUANTITY_FIELDS.has(field) || PDD_FAILURE_RATE_FIELDS.has(field)) return parseNumeric(value);
    return String(value);
  };

  const clearFilters = () => {
    setSelectedRegions(null);
    setSelectedRms(null);
    setSelectedRgms(null);
    setSelectedBases(null);
    setSelectedOrigins(null);
  };

  const downloadWorkbook = async () => {
    if (!canExport) return;
    const XLSXModule = await import("xlsx");
    const workbook = XLSXModule.utils.book_new();
    const addSheet = (
      name: string,
      headers: string[],
      rows: ExcelExportValue[][],
      widths: number[],
      percentageColumns: number[] = [],
    ) => {
      const worksheet = XLSXModule.utils.aoa_to_sheet([headers, ...rows]);
      worksheet["!cols"] = widths.map((wch) => ({ wch }));
      if (worksheet["!ref"]) worksheet["!autofilter"] = { ref: worksheet["!ref"] };
      rows.forEach((_, rowIndex) => percentageColumns.forEach((columnIndex) => {
        const cell = worksheet[XLSXModule.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })];
        if (cell) cell.z = "0.0%";
      }));
      XLSXModule.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
    };
    const totals = [summary.totalOrders, summary.ordersUnscannedAtReceipt, summary.ordersUnscannedAtCollection, summary.collectionFailureRate];
    addSheet("Regional", [t("Regional"), "RGM", t("Bases"), t("Total de pedidos"), t("Não bipados no recebimento"), t("Pedidos não bipados"), t("Falha na coleta PDD")], [
      ...regionalSummary.map((row) => [row.region, row.rgm, row.baseCount, row.totalOrders, row.ordersUnscannedAtReceipt, row.ordersUnscannedAtCollection, row.collectionFailureRate]),
      [t("Total geral"), "", new Set(filteredRecords.map((record) => {
        const dimension = pddCollectionFailureV2Dimensions(record);
        return `${dimension.region}\u0000${dimension.baseCode}\u0000${dimension.base}`;
      })).size, ...totals],
    ], [18, 38, 12, 20, 24, 24, 20], [6]);
    addSheet("RM", [t("Região do RM"), "RM", "RGM", t("Bases"), t("Total de pedidos"), t("Não bipados no recebimento"), t("Pedidos não bipados"), t("Falha na coleta PDD")], [
      ...rmSummary.map((row) => [row.rmArea, row.rm, row.rgm, row.baseCount, row.totalOrders, row.ordersUnscannedAtReceipt, row.ordersUnscannedAtCollection, row.collectionFailureRate]),
      [t("Total geral"), "", "", baseSummary.length, ...totals],
    ], [22, 38, 38, 12, 20, 24, 24, 20], [7]);
    addSheet("Base", [t("Regional"), t("Base"), t("Código da base"), t("Região do RM"), "RM", "RGM", t("Total de pedidos"), t("Não bipados no recebimento"), t("Pedidos não bipados"), t("Falha na coleta PDD")], [
      ...baseSummary.map((row) => [row.region, row.base, row.baseCode, row.rmArea, row.rm, row.rgm, row.totalOrders, row.ordersUnscannedAtReceipt, row.ordersUnscannedAtCollection, row.collectionFailureRate]),
      [t("Total geral"), "", "", "", "", "", ...totals],
    ], [18, 26, 18, 22, 38, 38, 20, 24, 24, 20], [9]);
    addSheet("Dados", PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => t(PDD_COLLECTION_FAILURE_V2_HEADERS_BY_FIELD[field])),
      searchedRecords.map((record) => PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => formatExportCell(record, field))),
      PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => field.includes("name") || field.includes("origin") ? 32 : 23),
      PDD_COLLECTION_FAILURE_V2_FIELDS.flatMap((field, index) => PDD_FAILURE_RATE_FIELDS.has(field) ? [index] : []),
    );
    XLSXModule.writeFile(workbook, `falha_coleta_pdd_${period.dateFrom}_${period.dateTo}.xlsx`, { compression: true });
  };

  const statusMessage = status === "error"
    ? error ?? t("Não foi possível consultar os dados publicados.")
    : status === "empty"
      ? error ? t("Aguardando primeira importação") : t("Sem dados publicados para o período selecionado.")
      : status === "loading" || status === "idle" ? t("Consultando publicação vigente…") : "";

  return (
    <div data-testid="pdd-collection-failure-v2-dashboard" data-v2-source="pdd_collection_failure" data-v2-status={status} data-v2-period-start={period.dateFrom} data-v2-period-end={period.dateTo} data-v2-record-count={receivedCount} data-v2-column-count={PDD_COLLECTION_FAILURE_V2_COLUMNS.length}>
      {hasPreviousData ? <DashboardLoadingSkeleton compact t={t} message={status === "error" ? "A atualização falhou" : "Atualizando os dados do dashboard…"}
        previousDataLabel={dataPeriod ? `${dataPeriod.dateFrom} a ${dataPeriod.dateTo}` : null} error={status === "error" ? error : null}
        onRetry={status === "error" ? onRetry : undefined} progress={progress.total > 0 ? progress : null} /> : null}
      <section className="dashboard-intro">
        <div>
          <div className="eyebrow"><CircleAlert size={15} /> {t("QUALIDADE DA COLETA")}</div>
          <h1>{t("Falha na coleta PDD")}</h1>
          <p>{t("Acompanhe pedidos a bipar, falhas de bipagem e taxas por regional, base, RM, RGM, origem e período.")}</p>
        </div>
        {hasData || status === "empty" ? <div className="dataset-meta" aria-label={t("Resumo da fonte oficial Bot 02")}>
          <span><Layers3 size={16} /> {t("{count} linhas", { count: formatNumber(receivedCount) })}</span>
          <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(options.regions.length) })}</span>
          <span><Database size={16} /> {t("{count} bases", { count: formatNumber(options.bases.length) })}</span>
          <span><CalendarDays size={16} /> {t("Coleta executada em: {date}", { date: updatedAt ? formatDateTime(updatedAt) : "—" })}</span>
          <span><CalendarDays size={16} /> {t("Publicada em: {date}", { date: publishedAt ? formatDateTime(publishedAt) : "—" })}</span>
        </div> : <div className="dataset-meta" role="status">{t("Consultando publicação vigente…")}</div>}
      </section>
      <DashboardActionBand
        reportDate={reportDate}
        demoMode={false}
        onPrint={onPrint}
        onAnalysis={onAnalysis}
        onShare={() => onShare([
          t("Período") + ": " + formatPeriod(period.dateFrom, period.dateTo),
          t("Regional") + ": " + selectedShareFilter(selectedValues(selectedRegions, options.regions), options.regions, "Todas as regionais", t),
          "RM: " + selectedShareFilter(selectedValues(selectedRms, options.rms), options.rms, "Todos os RM", t),
          "RGM: " + selectedShareFilter(selectedValues(selectedRgms, options.rgms), options.rgms, "Todos os RGM", t),
          t("Base") + ": " + selectedShareFilter(selectedValues(selectedBases, options.bases), options.bases, "Todas as bases", t),
          t("Origem do pedido") + ": " + selectedShareFilter(selectedValues(selectedOrigins, options.origins), options.origins, "Todas as origens", t),
        ])}
        showShare={showShare}
        t={t}
      />

      {statusMessage && !hasPreviousData ? <div className={`inline-alert${status === "error" ? " error" : ""}`} role={status === "error" ? "alert" : "status"} aria-live="polite"><CircleAlert size={18} /><span>{statusMessage}</span>{status === "error" ? <button type="button" onClick={onRetry}>{t("Tentar novamente")}</button> : null}</div> : null}

      <section className="filters-card bipagem-filters-card pdd-v2-filters-card" aria-labelledby="pdd-v2-filters-heading">
        <div className="filters-card-top">
          <div><h2 id="pdd-v2-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2><p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p></div>
          <button type="button" className="reset-button" onClick={clearFilters} disabled={filtersAreDefault}><RotateCcw size={15} /> {t("Limpar filtros")}</button>
        </div>
        <div className="filter-grid bipagem-filter-grid">
          <MultiSelect label={t("Regional")} options={options.regions} selected={selectedValues(selectedRegions, options.regions)} onChange={setSelectedRegions} allLabel={t("Todas as regionais")} singular={t("Regional")} plural={t("Regionais")} searchable t={t} />
          <MultiSelect label="RM" options={options.rms} selected={selectedValues(selectedRms, options.rms)} onChange={setSelectedRms} allLabel={t("Todos os RM")} singular="RM" plural="RM" searchable t={t} />
          <MultiSelect label="RGM" options={options.rgms} selected={selectedValues(selectedRgms, options.rgms)} onChange={setSelectedRgms} allLabel={t("Todos os RGM")} singular="RGM" plural="RGM" searchable t={t} />
          <MultiSelect label={t("Base")} options={options.bases} selected={selectedValues(selectedBases, options.bases)} onChange={setSelectedBases} allLabel={t("Todas as bases")} singular={t("Base")} plural={t("Bases")} searchable t={t} />
          <div className="filter-field"><label className="filter-label" htmlFor="pdd-v2-date-start">{t("Data inicial")}</label><input className="date-input" id="pdd-v2-date-start" type="date" value={period.dateFrom} onChange={(event) => onPeriodChange({ ...period, dateFrom: event.target.value })} /></div>
          <div className="filter-field"><label className="filter-label" htmlFor="pdd-v2-date-end">{t("Data final")}</label><input className="date-input" id="pdd-v2-date-end" type="date" min={period.dateFrom || undefined} value={period.dateTo} onChange={(event) => onPeriodChange({ ...period, dateTo: event.target.value })} /></div>
          <MultiSelect label={t("Origem do pedido")} options={options.origins} selected={selectedValues(selectedOrigins, options.origins)} onChange={setSelectedOrigins} allLabel={t("Todas as origens")} singular={t("Origem")} plural={t("Origens")} searchable t={t} />
        </div>
        {period.dateFrom && period.dateTo && period.dateFrom > period.dateTo ? <p className="date-error" role="alert">{t("A data inicial deve ser anterior à data final.")}</p> : null}
      </section>

      {(status === "loading" || status === "idle") && !hasData ? (
        <DashboardLoadingSkeleton t={t} message={progress.stage === "validation" ? "Validando a consistência da publicação…" : progress.total > 0 ? "Carregando registros publicados…" : "Consultando publicação vigente…"} progress={progress} />
      ) : <>
      <section className="kpi-grid bipagem-kpi-grid" aria-label={t("Indicadores de falta de bipagem")}>
        <KpiCard icon={<Layers3 size={20} />} label={t("Total de pedidos")} value={hasData ? formatCompact(summary.totalOrders) : "—"} detail={t("Soma de totalNum no período")}/>
        <KpiCard icon={<CircleAlert size={20} />} label={t("Pedidos não bipados")} value={hasData ? formatCompact(summary.ordersUnscannedAtCollection) : "—"} detail={t("Soma da coluna oficial de pedidos não bipados na coleta no período")} tone="orange" />
        <KpiCard icon={<Target size={20} />} label={t("Falha na Coleta PDD")} value={hasData ? formatRate(summary.collectionFailureRate) : "—"} detail={t("Soma de takingNum ÷ soma de totalNum")} tone="soft" />
      </section>

      <section className="chart-card bipagem-table-card bipagem-regional-card" aria-labelledby="pdd-v2-regional-heading">
        <div className="card-heading table-card-heading"><div><span className="card-eyebrow">{t("RESUMO REGIONAL")}</span><h2 id="pdd-v2-regional-heading">{t("Falha na coleta PDD por regional")}</h2><p>{t("Total, pedidos sem bipagem e taxa calculada pelas quantidades filtradas.")}</p></div><span className="comparison-period-badge">{formatDate(period.dateFrom, true)} a {formatDate(period.dateTo, true)}</span></div>
        <div className="dashboard-table-wrap bipagem-table-wrap"><table className="dashboard-data-table bipagem-summary-table"><thead><tr><th>{t("Regional")}</th><th>RGM</th><th>{t("Bases")}</th><th>{t("Total de pedidos")}</th><th>{t("Não bipados no recebimento")}</th><th>{t("Pedidos não bipados")}</th><th>{t("Falha na Coleta PDD")}</th></tr></thead><tbody>{regionalSummary.map((row) => <tr key={row.region}><td><span className="regional-chip">{t(row.region)}</span></td><td>{t(row.rgm)}</td><td>{formatNumber(row.baseCount)}</td><td>{formatNumber(row.totalOrders)}</td><td>{formatNumber(row.ordersUnscannedAtReceipt)}</td><td className="danger-cell">{formatNumber(row.ordersUnscannedAtCollection)}</td><td>{formatRate(row.collectionFailureRate)}</td></tr>)}</tbody><tfoot><tr><th>{t("Total geral")}</th><th>—</th><th>{formatNumber(baseSummary.length)}</th><td>{formatNumber(summary.totalOrders)}</td><td>{formatNumber(summary.ordersUnscannedAtReceipt)}</td><td>{formatNumber(summary.ordersUnscannedAtCollection)}</td><td>{formatRate(summary.collectionFailureRate)}</td></tr></tfoot></table>{!hasData || regionalSummary.length === 0 ? <EmptyChart message={emptyMessage} /> : null}</div>
      </section>

      <section className="chart-card bipagem-table-card bipagem-detail-card" aria-labelledby="pdd-v2-rm-heading"><div className="card-heading table-card-heading"><div><span className="card-eyebrow">RM</span><h2 id="pdd-v2-rm-heading">{t("Falha na coleta PDD por RM")}</h2></div></div><div className="dashboard-table-wrap bipagem-table-wrap"><table className="dashboard-data-table bipagem-summary-table"><thead><tr><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Bases")}</th><th>{t("Total de pedidos")}</th><th>{t("Não bipados no recebimento")}</th><th>{t("Pedidos não bipados")}</th><th>{t("Falha na Coleta PDD")}</th></tr></thead><tbody>{rmSummary.map((row) => <tr key={`${row.region}-${row.rmArea}-${row.rm}-${row.rgm}`}><td>{t(row.rmArea)}</td><td>{t(row.rm)}</td><td>{t(row.rgm)}</td><td>{formatNumber(row.baseCount)}</td><td>{formatNumber(row.totalOrders)}</td><td>{formatNumber(row.ordersUnscannedAtReceipt)}</td><td>{formatNumber(row.ordersUnscannedAtCollection)}</td><td>{formatRate(row.collectionFailureRate)}</td></tr>)}</tbody><tfoot><tr><th>{t("Total geral")}</th><th>—</th><th>—</th><th>{formatNumber(baseSummary.length)}</th><td>{formatNumber(summary.totalOrders)}</td><td>{formatNumber(summary.ordersUnscannedAtReceipt)}</td><td>{formatNumber(summary.ordersUnscannedAtCollection)}</td><td>{formatRate(summary.collectionFailureRate)}</td></tr></tfoot></table>{!hasData || rmSummary.length === 0 ? <EmptyChart message={emptyMessage} /> : null}</div></section>

      <section className="chart-card bipagem-table-card bipagem-detail-card" aria-labelledby="pdd-v2-base-heading"><div className="card-heading table-card-heading"><div><span className="card-eyebrow">{t("BASE")}</span><h2 id="pdd-v2-base-heading">{t("Falha na coleta PDD por base, RM e RGM")}</h2></div></div><div className="dashboard-table-wrap bipagem-table-wrap"><table className="dashboard-data-table bipagem-summary-table"><thead><tr><th>{t("Regional")}</th><th>{t("Base")}</th><th>{t("Código da base")}</th><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Total de pedidos")}</th><th>{t("Não bipados no recebimento")}</th><th>{t("Pedidos não bipados")}</th><th>{t("Falha na Coleta PDD")}</th></tr></thead><tbody>{baseSummary.map((row) => <tr key={row.key}><td><span className="regional-chip">{t(row.region)}</span></td><td>{row.base}</td><td>{row.baseCode}</td><td>{t(row.rmArea)}</td><td>{t(row.rm)}</td><td>{t(row.rgm)}</td><td>{formatNumber(row.totalOrders)}</td><td>{formatNumber(row.ordersUnscannedAtReceipt)}</td><td>{formatNumber(row.ordersUnscannedAtCollection)}</td><td>{formatRate(row.collectionFailureRate)}</td></tr>)}</tbody></table>{!hasData || baseSummary.length === 0 ? <EmptyChart message={emptyMessage} /> : null}</div></section>

      <section className="chart-card bipagem-table-card bipagem-detail-card pdd-v2-detail-card" aria-labelledby="pdd-v2-data-heading"><div className="card-heading table-card-heading pdd-v2-detail-heading"><div><span className="card-eyebrow">{t("DETALHAMENTO")}</span><h2 id="pdd-v2-data-heading">{t("Dados por base — 15 colunas oficiais")}</h2><p>{t("Código original, regional informada e valores do Bot 02 são preservados para conferência.")}</p></div><div className="table-tools bipagem-comparison-tools pdd-v2-detail-tools"><button type="button" className="table-download-button pdd-v2-export-button" onClick={() => void downloadWorkbook()} disabled={!canExport}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button><label className="table-search"><Search size={16} /><input value={tableQuery} onChange={(event) => { setTableQuery(event.target.value); setPage(1); }} placeholder={t("Buscar base, regional ou RM")} /></label></div></div>
        <div className="dashboard-table-wrap bipagem-table-wrap bipagem-detail-table-wrap pdd-v2-detail-table-wrap"><table className="dashboard-data-table bipagem-detail-table pdd-v2-detail-table"><thead><tr>{PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => <th key={field}>{t(PDD_COLLECTION_FAILURE_V2_HEADERS_BY_FIELD[field])}</th>)}</tr></thead><tbody>{visibleDetailRecords.map((record) => <tr key={`${record.publication_id}-${record.source_row_no}`}>{PDD_COLLECTION_FAILURE_V2_FIELDS.map((field) => <td key={field}>{formatCell(record, field)}</td>)}</tr>)}</tbody></table>{!hasData || searchedRecords.length === 0 ? <EmptyChart message={emptyMessage} /> : null}</div>
        <div className="table-pagination"><span>{t("{count} linhas", { count: formatNumber(searchedRecords.length) })}</span><button type="button" className="reset-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={activeDetailPage <= 1}>{t("Anterior")}</button><span>{t("Página {current} de {total}", { current: formatNumber(activeDetailPage), total: formatNumber(detailPageCount) })}</span><button type="button" className="reset-button" onClick={() => setPage((current) => Math.min(detailPageCount, current + 1))} disabled={activeDetailPage >= detailPageCount}>{t("Próxima")}</button></div>
      </section>

      <div className="filter-summary" role="status" aria-live="polite"><span><strong>{t("Fonte oficial:")}</strong> {t("Data Foundation V2 · Bot 02")}</span><span><strong>{t("Registros recebidos:")}</strong> {formatNumber(receivedCount)}</span><span><strong>{t("Colunas do contrato:")}</strong> {formatNumber(PDD_COLLECTION_FAILURE_V2_COLUMNS.length)}</span><span><strong>{t("Período:")}</strong> {period.dateFrom} a {period.dateTo}</span>{publicationId ? <span><strong>{t("Publicação mais recente:")}</strong> {publicationId}</span> : null}{publicationIds.length > 1 ? <span><strong>{t("Publicações nas linhas:")}</strong> {publicationIds.join(", ")}</span> : null}</div>
      </>}
    </div>
  );
}

const PDD_COLLECTION_FAILURE_V2_HEADERS_BY_FIELD: Record<(typeof PDD_COLLECTION_FAILURE_V2_FIELDS)[number], string> = {
  data_date: "Data considerada",
  source_region_code: "Código da Regional do PDD Responsável",
  reported_region: "Nome da Regional do PDD Responsável",
  source_base_code: "Código da base",
  source_base_name: "Nome do PDD Responsável",
  order_origin_code: "Código da origem do pedido",
  order_origin: "Origem do Pedido",
  total_orders: "Qtd pedidos a bipar",
  orders_unscanned_at_receipt: "Qtd pedidos não bipados no recebimento da coleta",
  rate_unscanned_at_receipt: "Taxa de pedidos não bipados no recebimento da coleta",
  orders_unscanned_at_collection: "Qtd pedidos não bipados na coleta",
  collection_failure_rate: "Taxa de falta de bipagem na coleta",
  packages_missing_dispatch_scan: "Qtd de Pacotes com Falta de Bipe de Envio",
  rate_unscanned_at_dispatch: "Taxa de pedidos não bipados na expedição",
  overall_unscanned_rate: "Taxa geral de falta de bipagem",
};

function DashboardUnderDevelopment({
  title,
  description,
  sourceId,
  availability,
  t,
}: {
  title: string;
  description: string;
  sourceId: string;
  availability: DashboardAvailabilityState;
  t: DashboardTranslator;
}) {
  const data = availability.status === "ready" || availability.status === "unpublished"
    ? availability.data
    : null;
  const statusText = availability.status === "loading"
    ? t("Verificando publicação vigente…")
    : availability.status === "restricted"
      ? t("Aguardando liberação do acesso operacional pela administração.")
      : availability.status === "unavailable"
        ? t("Fonte indisponível no momento.")
        : availability.status === "unpublished" || data?.status === "unpublished"
          ? t("Nenhuma publicação vigente")
          : availability.status === "ready" && data?.status === "available"
            ? data.rowCount === 0 ? t("Publicação vigente sem registros") : t("Dados disponíveis")
            : t("Aguardando consulta da fonte");
  const statusIsError = availability.status === "unavailable";

  return (
    <div className="dashboard-under-development" data-testid="dashboard-under-development">
      <section className="dashboard-intro">
        <div>
          <div className="eyebrow"><Activity size={15} /> {t("First Mile")}</div>
          <h1>{t(title)}</h1>
          <p>{t(description)}</p>
        </div>
      </section>
      <section className="dashboard-development-message" aria-labelledby="dashboard-development-title">
        <span className="dashboard-development-icon" aria-hidden="true"><Layers3 size={23} /></span>
        <h2 id="dashboard-development-title">{t("Painel em desenvolvimento")}</h2>
        <p>{t("Os indicadores e as fórmulas deste painel estão em revisão. A conexão com a fonte de dados permanece ativa.")}</p>
      </section>
      <section
        className={`dashboard-source-availability${statusIsError ? " unavailable" : ""}`}
        aria-label={t("Status da fonte de dados")}
        role={statusIsError ? "alert" : "status"}
        aria-live="polite"
        data-source-id={sourceId}
        data-source-status={availability.status}
      >
        <div className="dashboard-source-availability-heading">
          <Database size={17} aria-hidden="true" />
          <strong>{t("Fonte de dados")}</strong>
          <code>{sourceId}</code>
        </div>
        <div className="dashboard-source-availability-details">
          <span><strong>{t("Status:")}</strong> {statusText}</span>
          {data?.status === "available" ? (
            <>
              <span><strong>{t("Última publicação:")}</strong> {data.publishedAt ? formatDateTime(data.publishedAt) : "—"}</span>
              <span><strong>{t("Linhas na publicação mais recente:")}</strong> {data.rowCount === null ? "—" : formatNumber(data.rowCount)}</span>
              {data.periodStart || data.periodEnd ? (
                <span><strong>{t("Período publicado:")}</strong> {data.periodStart ?? "—"} a {data.periodEnd ?? "—"}</span>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function DashboardApp() {
  const [language, setLanguage] = useState<DashboardLanguage>("pt");
  const [theme, setTheme] = useState<DashboardTheme>("light");
  const [dashboardCacheSessionId] = useState(() => `${Date.now()}-${Math.random()}`);
  const previousDashboardCacheIdentity = useRef("");
  const viewerIdentityRef = useRef<ViewerIdentity | null>(null);
  const themeRef = useRef<DashboardTheme>("light");
  const themeInitializedRef = useRef(false);
  const [viewerAuthorization, setViewerAuthorization] = useState<string | null>(null);
  const [viewerIdentity, setViewerIdentity] = useState<ViewerIdentity | null>(null);
  const [viewerDataAccessBlocked, setViewerDataAccessBlocked] = useState(false);
  const [viewerAuthState, setViewerAuthState] = useState<ViewerAuthState>("CHECKING");
  const [viewerSessionCheckAttempt, setViewerSessionCheckAttempt] = useState(0);
  const [viewerAuthError, setViewerAuthError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const authError = new URLSearchParams(window.location.search).get("authError");
    return authError
      ? FEISHU_AUTH_ERROR_MESSAGES[authError] ?? FEISHU_AUTH_ERROR_MESSAGES.feishu_auth_failed
      : null;
  });
  const [viewerAuthLoading, setViewerAuthLoading] = useState(false);
  const [view, setView] = useState<DashboardView>("home");
  const [dashboardAvailability, setDashboardAvailability] = useState<DashboardAvailabilityState>({ status: "idle" });
  const loadedDashboardDataViewerRef = useRef<string | null>(null);
  const [showUserControl, setShowUserControl] = useState(false);
  const [responsibilitySourceDialogOpen, setResponsibilitySourceDialogOpen] = useState(false);
  const [responsibilityRefreshPending, setResponsibilityRefreshPending] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisCopied, setAnalysisCopied] = useState(false);
  const [feishuSharePreview, setFeishuSharePreview] = useState<FeishuSharePreview | null>(null);
  const [noMovementFeishuDialogOpen, setNoMovementFeishuDialogOpen] = useState(false);
  const [operationalFeishuSource, setOperationalFeishuSource] = useState<"collection_rate" | "pdd_collection_failure" | null>(null);
  const [operationalFeishuAvailability, setOperationalFeishuAvailability] = useState<{
    sourceId: "collection_rate" | "pdd_collection_failure";
    publicationId: string;
    enabled: boolean;
    publicationValid: boolean;
  } | null>(null);
  const [dataSourceDialogId, setDataSourceDialogId] = useState<DashboardSourceId | null>(null);
  const [loaded, setLoaded] = useState<LoadedData | null>(null);
  const [monitoringV2Status, setMonitoringV2Status] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [monitoringV2Message, setMonitoringV2Message] = useState<string | null>(null);
  const [monitoringV2PeriodStart, setMonitoringV2PeriodStart] = useState(yesterdayInSaoPaulo);
  const [monitoringV2PeriodEnd, setMonitoringV2PeriodEnd] = useState(monitoringV2PeriodStart);
  const [monitoringV2RetryKey, setMonitoringV2RetryKey] = useState(0);
  const [collectionRateV2State, setCollectionRateV2State] = useState(() => {
    const yesterday = yesterdayInSaoPaulo();
    return {
      status: "idle" as "idle" | "loading" | "ready" | "empty" | "error",
      period: { dateFrom: yesterday, dateTo: yesterday },
      loadedPeriod: null as { dateFrom: string; dateTo: string } | null,
      records: [] as CollectionRateV3Record[],
      progress: { loaded: 0, total: 0, stage: "records" as "records" | "validation" },
      retryKey: 0,
      receivedCount: 0,
      columnCount: COLLECTION_RATE_V3_COLUMNS.length,
      publicationId: null as string | null,
      publicationIds: [] as string[],
      publishedAt: null as string | null,
      snapshotAsOf: null as string | null,
      latestDayMayBeIncomplete: false,
      error: null as string | null,
    };
  });
  const [dashboardSourcesReady, setDashboardSourcesReady] = useState(false);
  const [selectedBases, setSelectedBases] = useState<Set<string>>(new Set());
  const [referenceBaseTestRequested, setReferenceBaseTestRequested] = useState(() => Boolean(
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("monitoringReferenceBaseTest") === "1"
  ));
  const [referenceBaseTestSelected, setReferenceBaseTestSelected] = useState<Set<string>>(() => new Set(REFERENCE_BASE_TEST_NAMES));
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
  const [taxaV2Filters, setTaxaV2Filters] = useState<CollectionRateV3Filters>({});
  const [taxaV2TableQuery, setTaxaV2TableQuery] = useState("");
  const [taxaV2Page, setTaxaV2Page] = useState(1);
  const [taxaRmAreaSelection, setTaxaRmAreaSelection] = useState<OptionSelection>({ mode: "all" });
  const [taxaRmSelection, setTaxaRmSelection] = useState<RmSelection>({ mode: "all" });
  const [taxaDateStart, setTaxaDateStart] = useState("");
  const [taxaDateEnd, setTaxaDateEnd] = useState("");
  const [taxaLoading, setTaxaLoading] = useState(true);
  const [taxaTableQuery, setTaxaTableQuery] = useState("");
  const [taxaPage, setTaxaPage] = useState(1);
  const [taxaHistoryNotice, setTaxaHistoryNotice] = useState<TaxaHistoryNotice | null>(null);
  const [movementLoaded, setMovementLoaded] = useState<MovementLoadedData | null>(() => buildEmptyNoMovementV2LoadedData());
  const [movementSelectedBases, setMovementSelectedBases] = useState<Set<string>>(new Set());
  const [movementSelectedRegions, setMovementSelectedRegions] = useState<Set<string>>(new Set());
  const [movementSelectedRms, setMovementSelectedRms] = useState<Set<string>>(new Set());
  const [movementSelectedRmAreas, setMovementSelectedRmAreas] = useState<Set<string>>(new Set());
  const [movementSelectedRgms, setMovementSelectedRgms] = useState<Set<string>>(new Set());
  const [movementSelectedAgings, setMovementSelectedAgings] = useState<Set<string>>(new Set());
  const [movementSelectedStatuses, setMovementSelectedStatuses] = useState<Set<string>>(new Set());
  const [movementSelectedOrigins, setMovementSelectedOrigins] = useState<Set<string>>(new Set());
  const [movementDateStart, setMovementDateStart] = useState("");
  const [movementDateEnd, setMovementDateEnd] = useState("");
  const [movementSummaryMetric, setMovementSummaryMetric] = useState("totalStopped");
  const [noMovementV2State, setNoMovementV2State] = useState(() => ({
    status: "idle" as "idle" | "loading" | "ready" | "empty" | "error",
    records: [] as NoMovementV2Record[],
    progress: { loaded: 0, total: 0, stage: "records" as "records" | "validation" },
    receivedCount: 0,
    columnCount: NO_MOVEMENT_V2_COLUMNS.length,
    publicationId: null as string | null,
    updatedAt: null as string | null,
    collectionDate: null as string | null,
    publishedAt: null as string | null,
    identityKey: null as string | null,
    error: null as string | null,
  }));
  const noMovementV2StateRef = useRef(noMovementV2State);
  useEffect(() => { noMovementV2StateRef.current = noMovementV2State; }, [noMovementV2State]);
  const [noMovementRetryCount, setNoMovementRetryCount] = useState(0);
  const [movementTableQuery, setMovementTableQuery] = useState("");
  const [movementPage, setMovementPage] = useState(1);
  const [sellerReferenceLoaded, setSellerReferenceLoaded] = useState<SellerReferenceData | null>(null);
  const [specialSellerLoaded, setSpecialSellerLoaded] = useState<SpecialSellerData | null>(null);
  const [sellerPerformanceLoaded, setSellerPerformanceLoaded] = useState<SellerPerformanceData | null>(null);
  const [jtMonitoringV2State, setJtMonitoringV2State] = useState(() => {
    const yesterday = yesterdayInSaoPaulo();
    return {
      status: "idle" as "idle" | "loading" | "ready" | "empty" | "error",
      loading: false,
      period: { dateFrom: yesterday, dateTo: yesterday },
      records: [] as JtMonitoringV2Record[],
      totalAvailable: 0,
      loadedCount: 0,
      columnCount: JT_MONITORING_V2_COLUMNS.length,
      publicationId: null as string | null,
      publicationIds: [] as string[],
      publishedAt: null as string | null,
      dateCountsSignature: null as string | null,
      error: null as string | null,
    };
  });
  const jtMonitoringV2RequestRef = useRef<AbortController | null>(null);
  const [sellerManualSource, setSellerManualSource] = useState<ManualDataSource | null>(null);
  const [sellerDependencyMessage, setSellerDependencyMessage] = useState<string | null>(null);
  const [responsibilityLoaded, setResponsibilityLoaded] = useState<ResponsibilityData | null>(null);
  const [selectedRms, setSelectedRms] = useState<Set<string>>(new Set([UNASSIGNED_RM]));
  const [selectedRgms, setSelectedRgms] = useState<Set<string>>(new Set([UNASSIGNED_RGM]));
  const monitoringFilterSnapshot = useRef({
    loaded: null as LoadedData | null,
    bases: new Set<string>(),
    regions: new Set<string>(),
    rms: new Set<string>(),
    rgms: new Set<string>(),
    metrics: new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS),
  });
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
  const [pddCollectionFailureV2State, setPddCollectionFailureV2State] = useState(() => {
    const yesterday = yesterdayInSaoPaulo();
    return {
      status: "idle" as "idle" | "loading" | "ready" | "empty" | "error",
      period: { dateFrom: yesterday, dateTo: yesterday },
      dataPeriod: null as PddCollectionFailureV2Period | null,
      records: [] as PddCollectionFailureV2Record[],
      progress: { loaded: 0, total: 0, stage: "records" as "records" | "validation" },
      receivedCount: 0,
      columnCount: PDD_COLLECTION_FAILURE_V2_COLUMNS.length,
      publicationId: null as string | null,
      publicationIds: [] as string[],
      updatedAt: null as string | null,
      publishedAt: null as string | null,
      identityKey: null as string | null,
      error: null as string | null,
    };
  });
  const pddCollectionFailureV2StateRef = useRef(pddCollectionFailureV2State);
  useEffect(() => { pddCollectionFailureV2StateRef.current = pddCollectionFailureV2State; }, [pddCollectionFailureV2State]);
  const [pddCollectionFailureRetryCount, setPddCollectionFailureRetryCount] = useState(0);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tableQuery, setTableQuery] = useState("");
  const [page, setPage] = useState(1);
  const t = useCallback<DashboardTranslator>(
    (source, values) => translateDashboardText(language, source, values),
    [language],
  );
  const isMatrixAdminViewer = canReadMonitoringV2(viewerIdentity);
  const isEffectiveMatrixAdminViewer = isMatrixAdminViewer &&
    viewerIdentity?.organizational_scope === "matrix" &&
    viewerIdentity?.role === "matrix" &&
    viewerIdentity?.is_active !== false;
  const isAuthorizedDashboardViewer = canReadDashboardV2Data(viewerIdentity);
  const [mappingEpoch, setMappingEpoch] = useState(0);
  const dashboardCacheIdentity = `${dashboardIdentityCacheKey(dashboardCacheSessionId, viewerIdentity)}:map:${mappingEpoch}`;
  const pddDataAuthorized = pddCollectionFailureV2State.identityKey === dashboardCacheIdentity;
  const operationalFeishuTarget = view === "taxa" && isEffectiveMatrixAdminViewer && viewerAuthorization &&
      collectionRateV2State.status === "ready" && collectionRateV2State.publicationId
    ? { sourceId: "collection_rate" as const, publicationId: collectionRateV2State.publicationId }
    : view === "bipagem" && isEffectiveMatrixAdminViewer && viewerAuthorization && pddDataAuthorized &&
        pddCollectionFailureV2State.status === "ready" && pddCollectionFailureV2State.publicationId
      ? { sourceId: "pdd_collection_failure" as const, publicationId: pddCollectionFailureV2State.publicationId }
      : null;
  const operationalFeishuTargetSource = operationalFeishuTarget?.sourceId ?? null;
  const operationalFeishuTargetPublication = operationalFeishuTarget?.publicationId ?? null;
  const canShowCollectionRateFeishuButton = Boolean(
    view === "taxa" && isEffectiveMatrixAdminViewer && viewerAuthorization &&
    operationalFeishuAvailability?.sourceId === "collection_rate" &&
    operationalFeishuAvailability.publicationId === collectionRateV2State.publicationId &&
    operationalFeishuAvailability.enabled && operationalFeishuAvailability.publicationValid,
  );
  const canShowPddFeishuButton = Boolean(
    view === "bipagem" && isEffectiveMatrixAdminViewer && viewerAuthorization &&
    operationalFeishuAvailability?.sourceId === "pdd_collection_failure" &&
    operationalFeishuAvailability.publicationId === pddCollectionFailureV2State.publicationId &&
    operationalFeishuAvailability.enabled && operationalFeishuAvailability.publicationValid &&
    pddDataAuthorized,
  );
  useEffect(() => {
    if (!isEffectiveMatrixAdminViewer || !viewerAuthorization || !operationalFeishuTargetSource || !operationalFeishuTargetPublication) {
      return undefined;
    }

    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      controller = new AbortController();
      const headers = new Headers();
      if (viewerAuthorization !== FEISHU_COOKIE_SESSION) headers.set("authorization", viewerAuthorization);
      try {
        const query = new URLSearchParams({ publicationId: operationalFeishuTargetPublication });
        const response = await apiFetch(
          `/api/v2/operational-feishu/${operationalFeishuTargetSource}/availability?${query.toString()}`,
          { method: "GET", cache: "no-store", headers, signal: controller.signal },
        );
        if (!response.ok) throw new Error("availability_unavailable");
        const value: unknown = await response.json();
        const availability = value && typeof value === "object" ? value as Record<string, unknown> : {};
        if (typeof availability.enabled !== "boolean" || typeof availability.publicationValid !== "boolean") {
          throw new Error("availability_invalid");
        }
        if (!active) return;
        setOperationalFeishuAvailability({
          sourceId: operationalFeishuTargetSource,
          publicationId: operationalFeishuTargetPublication,
          enabled: availability.enabled,
          publicationValid: availability.publicationValid,
        });
        if (!availability.enabled || !availability.publicationValid) {
          setOperationalFeishuSource(current => current === operationalFeishuTargetSource ? null : current);
        }
      } catch {
        if (!active || controller?.signal.aborted) return;
        setOperationalFeishuAvailability({
          sourceId: operationalFeishuTargetSource,
          publicationId: operationalFeishuTargetPublication,
          enabled: false,
          publicationValid: false,
        });
        setOperationalFeishuSource(current => current === operationalFeishuTargetSource ? null : current);
      } finally {
        inFlight = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      controller?.abort();
    };
  }, [isEffectiveMatrixAdminViewer, operationalFeishuTargetPublication, operationalFeishuTargetSource, viewerAuthorization]);
  const regionalAccessPendingMessage = viewerIdentity?.region_resolution_status === "SYNC_FAILED"
    ? t("Não foi possível confirmar sua regional no Feishu. Seus dados estão temporariamente indisponíveis. Aguarde uma nova sincronização ou solicite liberação ao administrador.")
    : t("Sua regional ainda não foi identificada. Solicite a liberação ao administrador da plataforma.");
  const clearProtectedDashboardData = useCallback(() => {
    invalidateDashboardDataCache();
    setLoaded(null);
    setTaxaLoaded(null);
    setEpopLoaded(null);
    setMovementLoaded(buildEmptyNoMovementV2LoadedData());
    setSellerPerformanceLoaded(null);
    setSellerReferenceLoaded(null);
    setSpecialSellerLoaded(null);
    setSellerManualSource(null);
    setSellerDependencyMessage(null);
    setResponsibilityLoaded(null);
    setBipagemLoaded(null);
    setDamageLoaded(null);
    loadedDashboardDataViewerRef.current = null;
    setMonitoringV2Status("idle");
    setMonitoringV2Message(null);
    setCollectionRateV2State((current) => ({ ...current, status: "idle", loadedPeriod: null, records: [], progress: { loaded: 0, total: 0, stage: "records" }, receivedCount: 0, publicationId: null, publicationIds: [], publishedAt: null, snapshotAsOf: null, latestDayMayBeIncomplete: false, error: null }));
    setNoMovementV2State((current) => ({ ...current, status: "idle", records: [], receivedCount: 0, publicationId: null, updatedAt: null, collectionDate: null, publishedAt: null, error: null }));
    setPddCollectionFailureV2State((current) => ({ ...current, status: "idle", records: [], receivedCount: 0, publicationId: null, publicationIds: [], updatedAt: null, publishedAt: null, error: null }));
    jtMonitoringV2RequestRef.current?.abort();
    jtMonitoringV2RequestRef.current = null;
    setJtMonitoringV2State((current) => ({ ...current, status: "idle", loading: false, records: [], totalAvailable: 0, loadedCount: 0, publicationId: null, publicationIds: [], publishedAt: null, dateCountsSignature: null, error: null }));
  }, []);
  useEffect(() => {
    if (!viewerAuthorization || !isAuthorizedDashboardViewer || !Object.hasOwn(DASHBOARD_V2_SOURCE_BY_PANEL, view)) return undefined;
    return monitorMappingRevision(apiFetch, () => {
      clearProtectedDashboardData();
      setDashboardAvailability({ status: "idle" });
      setMappingEpoch(value => value + 1);
    }, {
      setInterval: (callback, ms) => window.setInterval(callback, ms),
      clearInterval: id => window.clearInterval(id as number),
      addFocus: callback => window.addEventListener("focus", callback),
      removeFocus: callback => window.removeEventListener("focus", callback),
    });
  }, [clearProtectedDashboardData, isAuthorizedDashboardViewer, view, viewerAuthorization]);
  const applyViewerIdentity = useCallback((identity: ViewerIdentity) => {
    const previous = viewerIdentityRef.current;
    if (previous && !sameViewerIdentity(previous, identity)) {
      clearProtectedDashboardData();
      setViewerDataAccessBlocked(false);
      setDashboardSourcesReady(false);
      setDashboardAvailability({ status: "idle" });
    }
    viewerIdentityRef.current = identity;
    setViewerIdentity((current) => sameViewerIdentity(current, identity) ? current : identity);
  }, [clearProtectedDashboardData]);
  useEffect(() => {
    if (previousDashboardCacheIdentity.current && previousDashboardCacheIdentity.current !== dashboardCacheIdentity) {
      invalidateDashboardDataCache();
    }
    previousDashboardCacheIdentity.current = dashboardCacheIdentity;
  }, [dashboardCacheIdentity]);
  const isFirstMileUnderReview = Object.hasOwn(DASHBOARD_V2_SOURCE_BY_PANEL, view);
  const currentDashboardSourceId = isFirstMileUnderReview
    ? DASHBOARD_V2_SOURCE_BY_PANEL[view as DashboardPanel] ?? null
    : null;
  const currentDashboardAvailability: DashboardAvailabilityState = !isFirstMileUnderReview || !viewerAuthorization
    ? { status: "idle" }
    : !isAuthorizedDashboardViewer
      ? { status: "restricted", sourceId: currentDashboardSourceId ?? "" }
      : !currentDashboardSourceId
        ? { status: "unavailable", sourceId: "" }
        : dashboardAvailability.status === "ready" || dashboardAvailability.status === "unpublished"
          ? dashboardAvailability.data.sourceId === currentDashboardSourceId
            ? dashboardAvailability
            : { status: "loading", sourceId: currentDashboardSourceId }
          : dashboardAvailability.status !== "idle" && dashboardAvailability.sourceId === currentDashboardSourceId
            ? dashboardAvailability
            : { status: "loading", sourceId: currentDashboardSourceId };
  const currentDashboardManifestReady = currentDashboardAvailability.status === "ready" || currentDashboardAvailability.status === "unpublished";
  const currentDashboardPublicationToken = currentDashboardManifestReady
    ? currentDashboardAvailability.data.publicationId
    : null;
  const isReferenceBaseTestActive = Boolean(
    import.meta.env.DEV &&
    referenceBaseTestRequested &&
    isMatrixAdminViewer &&
    view === "monitoramento" &&
    loaded?.sourceType === "DATA_FOUNDATION_V2" &&
    loaded.initialStart === "2026-10-05" &&
    loaded.initialEnd === "2026-10-05" &&
    monitoringV2Status === "ready"
  );
  const statusLabel = useCallback((status: string) => monitoringStatusLabel(status, t), [t]);

  useEffect(() => {
    if (!isFirstMileUnderReview || !viewerAuthorization || !isAuthorizedDashboardViewer) return undefined;

    const sourceId = DASHBOARD_V2_SOURCE_BY_PANEL[view as DashboardPanel];
    if (!sourceId) return undefined;

    let active = true;
    const controller = new AbortController();
    const loadingTimer = window.setTimeout(() => {
      if (active) setDashboardAvailability({ status: "loading", sourceId });
    }, 0);
    const authorizationHeaders = new Headers();
    if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
      authorizationHeaders.set("authorization", viewerAuthorization);
    }
    void loadDashboardSourceAvailability(
      view as DashboardPanel,
      (path, init) => apiFetch(path, { ...init, headers: authorizationHeaders }),
      controller.signal,
    ).then((result) => {
      window.clearTimeout(loadingTimer);
      if (!active || !result) return;
      setDashboardAvailability(result.status === "available"
        ? { status: "ready", data: result }
        : { status: "unpublished", data: result });
    }).catch((cause: unknown) => {
      window.clearTimeout(loadingTimer);
      if (!active || controller.signal.aborted) return;
      setDashboardAvailability({ status: cause instanceof Error && cause.message === "restricted" ? "restricted" : "unavailable", sourceId });
    });

    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [isFirstMileUnderReview, isAuthorizedDashboardViewer, mappingEpoch, view, viewerAuthorization]);

  useEffect(() => {
    monitoringFilterSnapshot.current = {
      loaded,
      bases: selectedBases,
      regions: selectedRegions,
      rms: selectedRms,
      rgms: selectedRgms,
      metrics: selectedMonitoringMetrics,
    };
  }, [loaded, selectedBases, selectedMonitoringMetrics, selectedRegions, selectedRgms, selectedRms]);

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
    const frame = window.requestAnimationFrame(() => {
      let savedTheme: string | null = null;
      try {
        savedTheme = window.localStorage.getItem(DASHBOARD_THEME_STORAGE_KEY);
      } catch {
        // The in-memory theme toggle remains available when storage is blocked.
      }
      const nextTheme: DashboardTheme = savedTheme === "dark" ? "dark" : "light";
      themeInitializedRef.current = true;
      themeRef.current = nextTheme;
      document.documentElement.dataset.theme = nextTheme;
      setTheme(nextTheme);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    document.documentElement.dataset.theme = theme;
    if (themeInitializedRef.current) {
      try {
        window.localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, theme);
      } catch {
        // Keep the selected theme for this page even if persistence is unavailable.
      }
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const nextTheme: DashboardTheme = themeRef.current === "dark" ? "light" : "dark";
    themeRef.current = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The theme still changes for the current page.
    }
    setTheme(nextTheme);
  }, []);

  useEffect(() => {
    let active = true;
    void apiFetch("/api/auth/me", { method: "GET", cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          if (!active) return;
          setViewerAuthorization(null);
          viewerIdentityRef.current = null;
          setViewerIdentity(null);
          setViewerAuthState("UNAUTHENTICATED");
          return;
        }
        if (!response.ok) {
          throw new Error("O serviço de autenticação retornou uma resposta inesperada.");
        }
        const identity = await response.json() as ViewerIdentity & { authenticated: boolean };
        if (!active) return;
        const nextAuthState = viewerAuthStateFromResponse(response.status, identity);
        if (nextAuthState !== "AUTHENTICATED") {
          setViewerAuthorization(null);
          viewerIdentityRef.current = null;
          setViewerIdentity(null);
          setViewerAuthState(nextAuthState);
          return;
        }
        setViewerAuthError(null);
        setViewerAuthorization(FEISHU_COOKIE_SESSION);
        applyViewerIdentity(identity);
        setViewerAuthState("AUTHENTICATED");
      })
      .catch(() => {
        if (!active) return;
        setViewerAuthError("Não foi possível verificar a sessão por um problema de comunicação. Tente novamente.");
        setViewerAuthState("ERROR");
      });
    return () => {
      active = false;
    };
  }, [applyViewerIdentity, viewerSessionCheckAttempt]);

  const endViewerSession = useCallback(() => {
    void apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    clearProtectedDashboardData();
    setDashboardSourcesReady(false);
    setDashboardAvailability({ status: "idle" });
    setViewerDataAccessBlocked(false);
    setViewerAuthorization(null);
    viewerIdentityRef.current = null;
    setViewerIdentity(null);
    setViewerAuthError(null);
    setViewerAuthState("UNAUTHENTICATED");
    setView("home");
    setShowUserControl(false);
  }, [clearProtectedDashboardData]);

  const accessCheckInFlightRef = useRef(false);
  const verifyCurrentAccess = useCallback(async () => {
    if (!viewerAuthorization || accessCheckInFlightRef.current || document.visibilityState === "hidden") return;
    accessCheckInFlightRef.current = true;
    try {
      const response = await apiFetch("/api/auth/me", { method: "GET", cache: "no-store" });
      if (response.status === 401) {
        endViewerSession();
        return;
      }
      if (response.status === 403) {
        clearProtectedDashboardData();
        setViewerDataAccessBlocked(true);
        return;
      }
      if (response.ok) {
        const identity = await response.json() as ViewerIdentity & { authenticated: boolean };
        if (identity.authenticated && identity.is_active !== false) {
          applyViewerIdentity(identity);
        } else {
          endViewerSession();
        }
      }
    } catch {
      // A temporary network issue does not invalidate a valid session or widen its scope.
    } finally {
      accessCheckInFlightRef.current = false;
    }
  }, [applyViewerIdentity, clearProtectedDashboardData, endViewerSession, viewerAuthorization]);

  useEffect(() => {
    if (!viewerAuthorization) return undefined;
    const interval = window.setInterval(() => void verifyCurrentAccess(), 30_000);
    window.addEventListener("focus", verifyCurrentAccess);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", verifyCurrentAccess);
    };
  }, [verifyCurrentAccess, viewerAuthorization]);

  useEffect(() => subscribeToProtectedApiAuthorizationFailure(() => {
    clearProtectedDashboardData();
    setViewerDataAccessBlocked(true);
    void verifyCurrentAccess();
  }), [clearProtectedDashboardData, verifyCurrentAccess]);

  const startFeishuLogin = useCallback(() => {
    setViewerAuthError(null);
    setViewerAuthLoading(true);
    window.location.assign(apiUrl("/api/auth/feishu/login"));
  }, []);

  const retryViewerSessionCheck = useCallback(() => {
    setViewerAuthError(null);
    setViewerAuthState("CHECKING");
    setViewerSessionCheckAttempt((attempt) => attempt + 1);
  }, []);

  const changeLanguage = useCallback((nextLanguage: DashboardLanguage) => {
    document.documentElement.lang = dashboardHtmlLang(nextLanguage);
    setLanguage(nextLanguage);
  }, []);

  const resetResponsibilityFilters = useCallback((data = responsibilityLoaded) => {
    if (!data) return;
    setTaxaRmSelection({ mode: "all" });
    setSelectedRms(new Set([...data.rms, UNASSIGNED_RM]));
    setSelectedRgms(new Set([...data.rgms, UNASSIGNED_RGM]));
  }, [responsibilityLoaded]);

  const resetFilters = useCallback((data = loaded) => {
    if (!data) return;
    setTaxaRmSelection({ mode: "all" });
    const regions = initialRegionSelection(data.parsed.rows.map((row) => rowRegion(row, data.parsed.regionColumn)), viewerIdentity);
    setSelectedRegions(regions);
    const availableResponsibility = monitoringResponsibilityOptionsForData(data, responsibilityLoaded);
    const rms = new Set([...availableResponsibility.rms, UNASSIGNED_RM]);
    const rgms = new Set([...availableResponsibility.rgms, UNASSIGNED_RGM]);
    setSelectedBases(new Set(monitoringBasesForSelection(data, regions, responsibilityLoaded, rms, rgms)));
    setSelectedRms(rms);
    setSelectedRgms(rgms);
    const monitoringMetrics = new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS);
    setSelectedMonitoringMetrics(monitoringMetrics);
    setSelectedStatuses(new Set(monitoringStatusesForMetrics(data.statuses, monitoringMetrics)));
    setSelectedOrigins(new Set(data.origins));
    setDateStart(data.initialStart);
    setDateEnd(data.initialEnd);
    if (data.sourceType === "DATA_FOUNDATION_V2") {
      setMonitoringV2PeriodStart(data.initialStart);
      setMonitoringV2PeriodEnd(data.initialEnd);
    }
    setTableQuery("");
    setPage(1);
  }, [loaded, responsibilityLoaded, viewerIdentity]);

  const applyLoadedData = useCallback((data: LoadedData, responsibility: ResponsibilityData | null = null) => {
    setLoaded(data);
    const initialRegions = initialRegionSelection(data.parsed.rows.map((row) => rowRegion(row, data.parsed.regionColumn)), viewerIdentity);
    setSelectedRegions(initialRegions);
    const availableResponsibility = monitoringResponsibilityOptionsForData(data, responsibility);
    const rms = new Set([...availableResponsibility.rms, UNASSIGNED_RM]);
    const rgms = new Set([...availableResponsibility.rgms, UNASSIGNED_RGM]);
    setSelectedBases(new Set(monitoringBasesForSelection(data, initialRegions, responsibility, rms, rgms)));
    setSelectedRms(rms);
    setSelectedRgms(rgms);
    const monitoringMetrics = new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS);
    setSelectedMonitoringMetrics(monitoringMetrics);
    setSelectedStatuses(new Set(monitoringStatusesForMetrics(data.statuses, monitoringMetrics)));
    setSelectedOrigins(new Set(data.origins));
    setDateStart(data.initialStart);
    setDateEnd(data.initialEnd);
    setTableQuery("");
    setPage(1);
  }, [viewerIdentity]);

  const resetTaxaFilters = useCallback((data = taxaLoaded) => {
    if (!data) return;
    setTaxaRmSelection({ mode: "all" });
    const regions = initialRegionSelection(data.records.map((record) => record.region), viewerIdentity);
    setTaxaSelectedRegions(regions);
    setTaxaSelectedBases(new Set(taxaBasesForRegions(data, regions)));
    setTaxaRmAreaSelection({ mode: "all" });
    setTaxaSelectedOrigins(new Set(data.origins));
    setTaxaDateStart(data.initialStart);
    setTaxaDateEnd(data.initialEnd);
    setTaxaTableQuery("");
    setTaxaPage(1);
    resetResponsibilityFilters();
  }, [resetResponsibilityFilters, taxaLoaded, viewerIdentity]);

  const applyTaxaLoadedData = useCallback((data: TaxaLoadedData) => {
    setTaxaLoaded(data);
    const regions = initialRegionSelection(data.records.map((record) => record.region), viewerIdentity);
    setTaxaSelectedRegions(regions);
    setTaxaSelectedBases(new Set(taxaBasesForRegions(data, regions)));
    setTaxaRmAreaSelection({ mode: "all" });
    setTaxaSelectedOrigins(new Set(data.origins));
    setTaxaDateStart(data.initialStart);
    setTaxaDateEnd(data.initialEnd);
    setTaxaTableQuery("");
    setTaxaPage(1);
  }, [viewerIdentity]);

  const resetMovementFilters = useCallback((data = movementLoaded) => {
    if (!data) return;
    setMovementSummaryMetric("totalStopped");
    const regions = initialRegionSelection(data.records.map((record) => record.region), viewerIdentity);
    const selections = initialMovementFilterSelections(data.records, regions);
    setMovementSelectedRegions(selections.regions);
    setMovementSelectedRms(selections.rms);
    setMovementSelectedRmAreas(selections.rmAreas);
    setMovementSelectedBases(selections.bases);
    setMovementSelectedRgms(selections.rgms);
    setMovementSelectedAgings(new Set(data.agings));
    setMovementSelectedStatuses(new Set(data.statuses));
    setMovementSelectedOrigins(new Set(data.origins));
    setMovementDateStart(data.initialStart);
    setMovementDateEnd(data.initialEnd);
    setMovementTableQuery("");
    setMovementPage(1);
  }, [movementLoaded, viewerIdentity]);

  const applyMovementLoadedData = useCallback((data: MovementLoadedData) => {
    setMovementLoaded(data);
    setMovementSummaryMetric("totalStopped");
    const regions = initialRegionSelection(data.records.map((record) => record.region), viewerIdentity);
    const selections = initialMovementFilterSelections(data.records, regions);
    setMovementSelectedRegions(selections.regions);
    setMovementSelectedRms(selections.rms);
    setMovementSelectedRmAreas(selections.rmAreas);
    setMovementSelectedBases(selections.bases);
    setMovementSelectedRgms(selections.rgms);
    setMovementSelectedAgings(new Set(data.agings));
    setMovementSelectedStatuses(new Set(data.statuses));
    setMovementSelectedOrigins(new Set(data.origins));
    setMovementDateStart(data.initialStart);
    setMovementDateEnd(data.initialEnd);
    setMovementTableQuery("");
    setMovementPage(1);
  }, [viewerIdentity]);

  const resetSellerFilters = useCallback((data = sellerPerformanceLoaded) => {
    if (!data) return;
    const regions = initialRegionSelection(data.records.map((record) => registeredRegionForBase(responsibilityLoaded, record.base, record.region)), viewerIdentity);
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
  }, [resetResponsibilityFilters, responsibilityLoaded, sellerPerformanceLoaded, viewerIdentity]);

  const applySellerPerformanceLoadedData = useCallback((data: SellerPerformanceData, responsibility: ResponsibilityData | null = null) => {
    setSellerPerformanceLoaded(data);
    const regions = initialRegionSelection(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)), viewerIdentity);
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
  }, [viewerIdentity]);

  const applyBipagemLoadedData = useCallback((data: BipagemLoadedData, responsibility: ResponsibilityData | null = null) => {
    setBipagemLoaded(data);
    const regions = initialRegionSelection(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)), viewerIdentity);
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
  }, [viewerIdentity]);

  const applyDamageLoadedData = useCallback((data: DamageData, responsibility: ResponsibilityData | null = null) => {
    setDamageLoaded(data);
    setDamageSelectedRegions(initialRegionSelection(data.records.map((record) => registeredRegionForBase(responsibility, record.base, record.region)), viewerIdentity));
    setDamageSelectedBases(new Set(data.bases));
    setDamageSelectedRms(new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rm)));
    setDamageSelectedRgms(new Set(data.records.map((record) => responsibilityForBase(responsibility, record.base).rgm)));
    setDamageDateStart(data.dates[0] ?? "");
    setDamageDateEnd(data.dates[data.dates.length - 1] ?? "");
  }, [viewerIdentity]);

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
      if (!viewerAuthorization || !viewerIdentity) return;
      if (view === "home" || view === "data-foundation" || isFirstMileUnderReview) {
        setDashboardSourcesReady(true);
        setLoading(false);
        setTaxaLoading(false);
        setSellerLoading(false);
        setBipagemLoading(false);
        setDamageLoading(false);
        return;
      }
      if (loadedDashboardDataViewerRef.current === viewerIdentity.username) {
        setDashboardSourcesReady(true);
        return;
      }
      const authorizationHeaders = new Headers();
      if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
        authorizationHeaders.set("authorization", viewerAuthorization);
      }
      let primaryWorkbookLoaded = false;
      setLoading(true);
      setTaxaLoading(true);
      setMovementLoaded(buildEmptyNoMovementV2LoadedData());
      setSellerLoading(true);
      setBipagemLoading(true);
      setDamageLoading(true);
      setError(null);
      if (!isMatrixAdminViewer) {
        setMonitoringV2Status("idle");
        setMonitoringV2Message(null);
      }
      try {
        if (LOCAL_DASHBOARD_DEMO_MODE) {
          if (!viewerIdentity) throw new Error("Não foi possível confirmar o escopo de acesso para a demonstração.");
          const demoUpdatedAt = "2026-09-23T12:00:00.000Z";
          const fixtures = DASHBOARD_DEMO_FIXTURES;
          const responsibilityParsed = scopeDemoWorkbook(fixtures.responsibilityList, viewerIdentity);
          if (!isMatrixAdminViewer && responsibilityParsed.rows.length === 0) {
            throw new Error("Não há dados simulados compatíveis com o escopo desta conta.");
          }
          let responsibility: ResponsibilityData | null = buildResponsibilityData(responsibilityParsed, DEMO_WORKBOOK_NAME, demoUpdatedAt);
          if (isMatrixAdminViewer) {
            try {
              const responsibilityResponse = await apiFetch("/api/workbook?kind=responsibilityList", {
                cache: "no-store",
                headers: authorizationHeaders,
              });
              const responsibilityLoad = await readResponsibilityWorkbookResponse(responsibilityResponse);
              responsibility = responsibilityLoad.status === "loaded" ? responsibilityLoad.data : null;
            } catch {
              responsibility = null;
            }
          }
          let monitoring: LoadedData | null = null;
          if (!isMatrixAdminViewer) {
            monitoring = buildLoadedData(
              scopeDemoWorkbook(fixtures.monitoring, viewerIdentity),
              DEMO_WORKBOOK_NAME,
              demoUpdatedAt,
              "DEMONSTRATION",
            );
            try {
              const localSource = (await getMonitoringSource()).source;
              if (active && localSource) {
                monitoring = buildLoadedData(
                  localSource.parsed,
                  localSource.fileName,
                  localSource.importedAt,
                  "MANUAL_UPLOAD",
                  localSource.fileSizeBytes,
                  localSource.contentType,
                );
              }
            } catch {
              // Keep the existing scoped demo behavior for profiles outside ADMIN/matrix.
            }
          }
          let taxa = buildTaxaLoadedData(
            scopeDemoWorkbook(fixtures.taxa, viewerIdentity),
            DEMO_WORKBOOK_NAME,
            demoUpdatedAt,
            "DEMONSTRATION",
          );
          try {
            const localSource = (await getTaxaSource()).source;
            if (active && localSource) {
              taxa = buildTaxaLoadedData(
                localSource.parsed,
                localSource.fileName,
                localSource.importedAt,
                "MANUAL_UPLOAD",
                localSource.fileSizeBytes,
                localSource.contentType,
              );
            }
          } catch {
            // Keep the existing scoped demo fixture when no local taxa source is stored.
          }
          const epop = buildEpopLoadedData(scopeDemoWorkbook(fixtures.epop, viewerIdentity), DEMO_WORKBOOK_NAME, demoUpdatedAt);
          setMovementLoaded(buildEmptyNoMovementV2LoadedData());
          const sellerPerformanceParsed = scopeDemoWorkbook(fixtures.sellerPerformance, viewerIdentity);
          const sellerListParsed = scopeDemoSellerReference(fixtures.sellerList, sellerPerformanceParsed, viewerIdentity, false);
          const specialSellerParsed = scopeDemoSellerReference(fixtures.sellerSpecialList, sellerPerformanceParsed, viewerIdentity, true);
          const specialSeller = buildSpecialSellerData(specialSellerParsed, DEMO_WORKBOOK_NAME, demoUpdatedAt);
          const sellerReference = mergeSellerReferenceData(
            buildSellerReferenceData(sellerListParsed, DEMO_WORKBOOK_NAME, demoUpdatedAt),
            specialSeller,
          );
          const sellerPerformance = buildSellerPerformanceData(
            sellerPerformanceParsed,
            sellerReference,
            DEMO_WORKBOOK_NAME,
            demoUpdatedAt,
            responsibility,
          );
          const bipagem = buildBipagemLoadedData(scopeDemoWorkbook(fixtures.bipagem, viewerIdentity), DEMO_WORKBOOK_NAME, demoUpdatedAt);
          const damage = buildDamageData(scopeDemoWorkbook(fixtures.damage, viewerIdentity), DEMO_WORKBOOK_NAME, demoUpdatedAt);

          setResponsibilityLoaded(responsibility);
          setDashboardSourcesReady(true);
          setSelectedRms(new Set([...(responsibility?.rms ?? []), UNASSIGNED_RM]));
          setSelectedRgms(new Set([...(responsibility?.rgms ?? []), UNASSIGNED_RGM]));
          setSpecialSellerLoaded(specialSeller);
          setSellerReferenceLoaded(sellerReference);
          if (monitoring) applyLoadedData(monitoring, responsibility);
          applyTaxaLoadedData(taxa);
          setEpopLoaded(epop);
          setEpopSelectedRegions(initialRegionSelection(epop.regions, viewerIdentity));
          setEpopSelectedBases(new Set(epop.bases));
          setEpopDateStart(epop.dates[0] ?? "");
          setEpopDateEnd(epop.dates.at(-1) ?? "");
          applySellerPerformanceLoadedData(sellerPerformance, responsibility);
          applyBipagemLoadedData(bipagem, responsibility);
          applyDamageLoadedData(damage, responsibility);
          setError(null);
          loadedDashboardDataViewerRef.current = viewerIdentity.username;
          primaryWorkbookLoaded = true;
          return;
        }

        const fetchOptionalWorkbook = async (kind: string): Promise<Response | null> => {
          try {
            return await apiFetch(`/api/workbook?kind=${kind}`, { cache: "no-store", headers: authorizationHeaders });
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
          const { mergeTaxaHistory } = await import("../../lib/taxa-history");
          const workbooks: ParsedWorkbook[] = [];
          for (const part of parts) {
            const partResponse = await apiFetch(`/api/workbook?kind=${kind}&part=${encodeURIComponent(part)}`, {
              cache: "no-store", headers: authorizationHeaders,
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
        if (!isMatrixAdminViewer) {
          try {
            const manualSource = (await getMonitoringSource()).source;
            if (manualSource) {
              payload = {
                workbook: {
                  fileName: manualSource.fileName,
                  updatedAt: manualSource.importedAt,
                  parsed: manualSource.parsed,
                },
              };
            }
          } catch {
            // Existing dashboard behavior for profiles that do not read V2.
          }
          for (let attempt = 0; attempt < 3 && !payload; attempt += 1) {
            try {
              const monitoringResponse = await apiFetch("/api/workbook?kind=monitoring", { cache: "no-store", headers: authorizationHeaders });
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
        }
        if (!active) return;
        let responsibilityResponse: Response | null = null;
        try {
          responsibilityResponse = await apiFetch("/api/workbook?kind=responsibilityList", {
            cache: "no-store",
            headers: authorizationHeaders,
          });
        } catch (cause) {
          const failureType = cause instanceof Error ? cause.name : "unknown";
          console.error(`[Redes Painéis] Requisição de responsibilityList falhou (${failureType}); Monitoramento e Taxa seguirão sem associações oficiais até a fonte estar disponível.`);
        }
        const responsibilityLoad = await readResponsibilityWorkbookResponse(responsibilityResponse);
        const responsibility: ResponsibilityData | null = responsibilityLoad.status === "loaded" ? responsibilityLoad.data : null;
        if (responsibility) {
          setResponsibilityLoaded(responsibility);
          setSelectedRms(new Set([...responsibility.rms, UNASSIGNED_RM]));
          setSelectedRgms(new Set([...responsibility.rgms, UNASSIGNED_RGM]));
        } else {
          setResponsibilityLoaded(null);
          setSelectedRms(new Set([UNASSIGNED_RM]));
          setSelectedRgms(new Set([UNASSIGNED_RGM]));
          if (responsibilityLoad.status === "missing") {
            console.warn("[Redes Painéis] De-para oficial responsibilityList não publicado; regiões sem associação oficial permanecerão como Sem região do RM.");
          } else {
            const status = responsibilityLoad.status === "http-error" ? `HTTP ${responsibilityLoad.httpStatus}` : responsibilityLoad.status;
            console.error(`[Redes Painéis] Falha ao carregar ou validar responsibilityList (${status}); KPIs continuam disponíveis e regiões sem associação não serão inferidas.`);
          }
        }
        setDashboardSourcesReady(true);
        const monitoringWorkbook = isMatrixAdminViewer
          ? null
          : payload?.workbook ?? await readTaxaHistory(await fetchOptionalWorkbook("monitoring"), "monitoring");
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
        if (isMatrixAdminViewer) primaryWorkbookLoaded = true;
        const taxaResponse = await fetchOptionalWorkbook("taxa");
        {
          const taxaWorkbook = await readTaxaHistory(taxaResponse);
          if (!active) return;
          if (taxaWorkbook) {
            applyTaxaLoadedData(buildTaxaLoadedData(
              taxaWorkbook.parsed,
              taxaWorkbook.fileName,
              taxaWorkbook.updatedAt,
            ));
          }
        }
        const epopResponse = await fetchOptionalWorkbook("epop");
        {
          const epopWorkbook = await readTaxaHistory(epopResponse, "epop");
          if (!active) return;
          if (epopWorkbook) {
            const epop = buildEpopLoadedData(epopWorkbook.parsed, epopWorkbook.fileName, epopWorkbook.updatedAt);
            setEpopLoaded(epop); setEpopSelectedRegions(initialRegionSelection(epop.regions, viewerIdentity)); setEpopSelectedBases(new Set(epop.bases));
            setEpopDateStart(epop.dates[0] ?? ""); setEpopDateEnd(epop.dates[epop.dates.length - 1] ?? "");
          }
        }
        setMovementLoaded(buildEmptyNoMovementV2LoadedData());
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
        let sellerManualSourceResponse: ManualDataSource | null = null;
        try {
          sellerManualSourceResponse = (await getSellerMonitoringSource()).source;
          if (active) setSellerManualSource(sellerManualSourceResponse);
        } catch (cause) {
          console.error("[Redes Painéis] Falha ao carregar a fonte compartilhada do Monitoramento J&T.", cause);
        }
        if (sellerManualSourceResponse) {
          if (!active) return;
          const sellerData = buildSellerPerformanceData(
            sellerManualSourceResponse.parsed,
            sellerReference,
            sellerManualSourceResponse.fileName,
            sellerManualSourceResponse.importedAt,
            responsibility,
          );
          const isMatrixViewer = viewerIdentity?.organizational_scope === "matrix" || viewerIdentity?.role === "matrix";
          const assignedRegions = viewerIdentity?.effective_regions?.length
            ? viewerIdentity.effective_regions
            : [viewerIdentity?.home_region ?? viewerIdentity?.region].filter((region): region is string => Boolean(region));
          const effectiveRegions = isMatrixViewer ? null : new Set(assignedRegions.map((region) => region.trim().toUpperCase()));
          const visibleSellerRecords = effectiveRegions
            ? sellerData.records.filter((record) => effectiveRegions.has(registeredRegionForBase(responsibility, record.base, record.region).trim().toUpperCase()))
            : sellerData.records;
          const scopedSellerData = effectiveRegions ? {
            ...sellerData,
            records: visibleSellerRecords,
            regions: [...new Set(visibleSellerRecords.map((record) => registeredRegionForBase(responsibility, record.base, record.region)))].sort(),
            bases: [...new Set(visibleSellerRecords.map((record) => record.base))].sort(),
            sellers: [...new Set(visibleSellerRecords.map((record) => record.sellerName))].sort(),
          } : sellerData;
          applySellerPerformanceLoadedData(scopedSellerData, responsibility);
          if (!sellerReference) {
            setSellerDependencyMessage("A lista oficial de sellers não está publicada neste ambiente. As categorias não serão inferidas do XLSX J&T.");
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
          if (primaryWorkbookLoaded) loadedDashboardDataViewerRef.current = viewerIdentity.username;
          setLoading(false);
          setTaxaLoading(false);
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
  }, [applyBipagemLoadedData, applyDamageLoadedData, applyLoadedData, applyMovementLoadedData, applySellerPerformanceLoadedData, applyTaxaLoadedData, isFirstMileUnderReview, isMatrixAdminViewer, mappingEpoch, view, viewerAuthorization, viewerIdentity, viewerIdentity?.region]);

  useEffect(() => {
    if (view !== "monitoramento" || !isFirstMileUnderReview || !viewerAuthorization || !isAuthorizedDashboardViewer || !dashboardSourcesReady || !import.meta.env.DEV || !referenceBaseTestRequested) return undefined;

    let active = true;
    const controller = new AbortController();
    const dateFrom = monitoringV2PeriodStart;
    const dateTo = monitoringV2PeriodEnd;
    const timer = window.setTimeout(() => {
      void (async () => {
        setMonitoringV2Status("loading");
        setMonitoringV2Message(null);
        if (!dateFrom || !dateTo || dateFrom > dateTo) {
          setMonitoringV2Status("error");
          setMonitoringV2Message("Informe um intervalo de datas válido para consultar os dados.");
          return;
        }
        const authorizationHeaders = new Headers();
        if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
          authorizationHeaders.set("authorization", viewerAuthorization);
        }
        const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
        try {
          const published = await loadCachedDashboardData({
            identityKey: dashboardCacheIdentity,
            sourceId: "collection_monitoring",
            contractVersion: 1,
            periodKey: `${dateFrom}:${dateTo}:unfiltered-rows`,
            manifest: (signal) => readDashboardDataManifest({
              sourceId: "collection_monitoring",
              contractVersion: 1,
              dateFrom,
              dateTo,
              publicationToken: currentDashboardPublicationToken,
              fetcher: cacheFetcher,
            }, signal),
            load: (signal) => loadPublishedMonitoringWorkbook({ dateFrom, dateTo }, cacheFetcher, signal),
          }, controller.signal);
          if (!active) return;
          if (published.rowCount === 0) {
            setLoaded(null);
            setDateStart(dateFrom);
            setDateEnd(dateTo);
            setMonitoringV2Status("empty");
            setMonitoringV2Message("Sem dados publicados para a data selecionada");
            return;
          }

          const nextData = {
            ...buildLoadedData(published.parsed, published.fileName, published.updatedAt, "DATA_FOUNDATION_V2"),
            initialStart: dateFrom,
            initialEnd: dateTo,
          };
          const previous = monitoringFilterSnapshot.current;
          const previousData = previous.loaded?.sourceType === "DATA_FOUNDATION_V2" ? previous.loaded : null;
          const nextRegionsAvailable = nextData.regions;
          const previousRegionsWereAll = Boolean(previousData && previous.regions.size === previousData.regions.length);
          const nextRegions = !previousData
            ? initialRegionSelection(nextData.parsed.rows.map((row) => rowRegion(row, nextData.parsed.regionColumn)), viewerIdentity)
            : previousRegionsWereAll
              ? new Set(nextRegionsAvailable)
              : new Set([...previous.regions].filter((region) => nextRegionsAvailable.includes(region)));

          const nextResponsibility = monitoringResponsibilityOptionsForData(nextData, responsibilityLoaded);
          const nextRmsAvailable = [...new Set([...nextResponsibility.rms, UNASSIGNED_RM])];
          const nextRgmsAvailable = [...new Set([...nextResponsibility.rgms, UNASSIGNED_RGM])];
          const previousResponsibility = previousData
            ? monitoringResponsibilityOptionsForData(previousData, responsibilityLoaded)
            : null;
          const previousRmsWereAll = Boolean(previousResponsibility && previous.rms.size === new Set([...previousResponsibility.rms, UNASSIGNED_RM]).size);
          const previousRgmsWereAll = Boolean(previousResponsibility && previous.rgms.size === new Set([...previousResponsibility.rgms, UNASSIGNED_RGM]).size);
          const nextRms = !previousData || previousRmsWereAll
            ? new Set(nextRmsAvailable)
            : new Set([...previous.rms].filter((item) => nextRmsAvailable.includes(item)));
          const nextRgms = !previousData || previousRgmsWereAll
            ? new Set(nextRgmsAvailable)
            : new Set([...previous.rgms].filter((item) => nextRgmsAvailable.includes(item)));

          const nextBasesAvailable = monitoringBasesForSelection(nextData, nextRegions, responsibilityLoaded, nextRms, nextRgms);
          const previousBasesAvailable = previousData
            ? monitoringBasesForSelection(previousData, previous.regions, responsibilityLoaded, previous.rms, previous.rgms)
            : [];
          const previousBasesWereAll = Boolean(previousData && previous.bases.size === previousBasesAvailable.length);
          const nextBases = !previousData || previousBasesWereAll
            ? new Set(nextBasesAvailable)
            : new Set([...previous.bases].filter((base) => nextBasesAvailable.includes(base)));
          const nextMetrics = previous.metrics.size === MONITORING_METRIC_OPTIONS.length
            ? new Set<MonitoringMetric>(MONITORING_METRIC_OPTIONS)
            : new Set(previous.metrics);

          setLoaded(nextData);
          setSelectedRegions(nextRegions);
          setSelectedRms(nextRms);
          setSelectedRgms(nextRgms);
          setSelectedBases(nextBases);
          setSelectedMonitoringMetrics(nextMetrics);
          setSelectedStatuses(new Set(monitoringStatusesForMetrics(nextData.statuses, nextMetrics)));
          setSelectedOrigins(new Set(nextData.origins));
          setDateStart(dateFrom);
          setDateEnd(dateTo);
          setPage(1);
          setMonitoringV2Status("ready");
          setMonitoringV2Message(null);
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          const loadError = cause instanceof MonitoringV2LoadError
            ? cause
            : new MonitoringV2LoadError("invalid_data", "Não foi possível preparar os dados publicados da Data Foundation V2.");
          const authorizationFailed = loadError.message.startsWith("Sua sessão expirou") ||
            loadError.message.includes("autorização ADMIN/matrix") ||
            loadError.message.includes("Sua regional ainda não foi identificada");
          if (authorizationFailed) setLoaded(null);
          setMonitoringV2Status(loadError.kind === "empty" ? "empty" : "error");
          setMonitoringV2Message(loadError.kind === "empty"
            ? "Sem dados publicados para a data selecionada"
            : loadError.message);
          if (loadError.kind === "empty") {
            setLoaded(null);
            setDateStart(dateFrom);
            setDateEnd(dateTo);
          }
        }
      })();
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentDashboardPublicationToken, dashboardCacheIdentity, dashboardSourcesReady, isFirstMileUnderReview, isAuthorizedDashboardViewer, monitoringV2PeriodEnd, monitoringV2PeriodStart, monitoringV2RetryKey, referenceBaseTestRequested, viewerAuthorization, viewerIdentity, responsibilityLoaded, view]);

  useEffect(() => {
    if (view !== "taxa") return undefined;
    if (!viewerAuthorization || !isAuthorizedDashboardViewer || !dashboardSourcesReady || !currentDashboardManifestReady) {
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const dateFrom = collectionRateV2State.period.dateFrom;
    const dateTo = collectionRateV2State.period.dateTo;
    const timer = window.setTimeout(() => {
      void (async () => {
        setCollectionRateV2State((current) => ({
          ...current,
          status: "loading",
          progress: { loaded: 0, total: 0, stage: "records" },
          error: null,
        }));
        if (!dateFrom || !dateTo || dateFrom > dateTo) {
          setCollectionRateV2State((current) => ({
            ...current,
            status: "error",
            error: "Informe um intervalo de datas válido para consultar os dados.",
          }));
          return;
        }

        const authorizationHeaders = new Headers();
        if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
          authorizationHeaders.set("authorization", viewerAuthorization);
        }
        const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
        try {
          const published = await loadCachedDashboardData({
            identityKey: dashboardCacheIdentity,
            sourceId: "collection_rate",
            contractVersion: 3,
            periodKey: `${dateFrom}:${dateTo}:unfiltered-rows`,
            manifest: (signal) => readDashboardDataManifest({
              sourceId: "collection_rate",
              contractVersion: 3,
              dateFrom,
              dateTo,
              publicationToken: currentDashboardPublicationToken,
              fetcher: cacheFetcher,
            }, signal),
            load: (signal) => loadPublishedCollectionRateV3({ dateFrom, dateTo }, cacheFetcher, signal, (progress) => {
              if (active) setCollectionRateV2State((current) => ({ ...current, progress }));
            }),
          }, controller.signal);
          if (!active) return;
          setCollectionRateV2State((current) => ({
            ...current,
            status: published.rowCount === 0 ? "empty" : "ready",
            period: published.period,
            loadedPeriod: published.period,
            records: published.records,
            progress: { loaded: published.rowCount, total: published.rowCount, stage: "records" },
            receivedCount: published.rowCount,
            columnCount: published.columnCount,
            publicationId: published.publicationId,
            publicationIds: published.publicationIds,
            publishedAt: published.publishedAt,
            snapshotAsOf: published.snapshotAsOf,
            latestDayMayBeIncomplete: published.latestDayMayBeIncomplete,
            error: published.rowCount === 0 ? "Sem dados publicados para a data selecionada" : null,
          }));
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          const loadError = cause instanceof CollectionRateV3LoadError
            ? cause
            : new CollectionRateV3LoadError("invalid_data", "Não foi possível preparar os dados publicados da Data Foundation V2.");
          setCollectionRateV2State((current) => ({
            ...current,
            status: loadError.kind === "empty" ? "empty" : "error",
            ...(loadError.kind === "empty" ? {
              loadedPeriod: { dateFrom, dateTo },
              records: [],
              receivedCount: 0,
              publicationId: null,
              publicationIds: [],
              publishedAt: null,
              snapshotAsOf: null,
              latestDayMayBeIncomplete: false,
            } : {}),
            error: loadError.message,
          }));
        }
      })();
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [collectionRateV2State.period.dateFrom, collectionRateV2State.period.dateTo, collectionRateV2State.retryKey, currentDashboardManifestReady, currentDashboardPublicationToken, dashboardAvailability, dashboardCacheIdentity, dashboardSourcesReady, isAuthorizedDashboardViewer, view, viewerAuthorization]);

  useEffect(() => {
    if (view !== "movimentacao") return undefined;
    if (!viewerAuthorization || !isAuthorizedDashboardViewer || !dashboardSourcesReady || !currentDashboardManifestReady) {
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setNoMovementV2State((current) => ({
          ...current,
          status: "loading",
          records: current.identityKey === dashboardCacheIdentity ? current.records : [],
          progress: { loaded: 0, total: 0, stage: "records" },
          receivedCount: current.identityKey === dashboardCacheIdentity ? current.receivedCount : 0,
          publicationId: current.identityKey === dashboardCacheIdentity ? current.publicationId : null,
          updatedAt: current.identityKey === dashboardCacheIdentity ? current.updatedAt : null,
          collectionDate: current.identityKey === dashboardCacheIdentity ? current.collectionDate : null,
          publishedAt: current.identityKey === dashboardCacheIdentity ? current.publishedAt : null,
          identityKey: dashboardCacheIdentity,
          error: null,
        }));
        if (noMovementV2StateRef.current.identityKey !== dashboardCacheIdentity) applyMovementLoadedData(buildEmptyNoMovementV2LoadedData());

        const authorizationHeaders = new Headers();
        if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
          authorizationHeaders.set("authorization", viewerAuthorization);
        }
        const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
        try {
          const snapshot = await loadCachedDashboardData({
            identityKey: dashboardCacheIdentity,
            sourceId: "no_movement",
            contractVersion: 2,
            periodKey: "current-snapshot:unfiltered-rows",
            manifest: (signal) => readDashboardDataManifest({
              sourceId: "no_movement",
              contractVersion: 2,
              fetcher: cacheFetcher,
            }, signal),
            load: (signal) => loadCurrentNoMovementSnapshot(cacheFetcher, signal, (loaded, total, stage) => {
              if (active) setNoMovementV2State((current) => ({ ...current, progress: { loaded, total, stage } }));
            }),
          }, controller.signal);
          if (!active || controller.signal.aborted) return;
          applyMovementLoadedData(buildNoMovementV2LoadedData(snapshot));
          setNoMovementV2State((current) => ({
            ...current,
            status: snapshot.rowCount === 0 ? "empty" : "ready",
            records: snapshot.records,
            progress: { loaded: snapshot.rowCount, total: snapshot.rowCount, stage: "records" },
            receivedCount: snapshot.rowCount,
            columnCount: snapshot.columnCount,
            publicationId: snapshot.publicationId,
            updatedAt: snapshot.updatedAt,
            collectionDate: snapshot.collectionDate,
            publishedAt: snapshot.publishedAt,
            identityKey: dashboardCacheIdentity,
            error: null,
          }));
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          const loadError = cause instanceof NoMovementV2LoadError
            ? cause
            : new NoMovementV2LoadError("invalid_data", "Não foi possível validar a publicação da Data Foundation V2.");
          const awaitingV2Publication = loadError.kind === "empty" || loadError.kind === "incompatible";
          const sameIdentity = noMovementV2StateRef.current.identityKey === dashboardCacheIdentity;
          if (!sameIdentity || awaitingV2Publication) applyMovementLoadedData(buildEmptyNoMovementV2LoadedData());
          setNoMovementV2State((current) => ({
            ...current,
            status: awaitingV2Publication ? "empty" : "error",
            records: !awaitingV2Publication && sameIdentity ? current.records : [],
            receivedCount: !awaitingV2Publication && sameIdentity ? current.receivedCount : 0,
            publicationId: !awaitingV2Publication && sameIdentity ? current.publicationId : null,
            updatedAt: !awaitingV2Publication && sameIdentity ? current.updatedAt : null,
            collectionDate: !awaitingV2Publication && sameIdentity ? current.collectionDate : null,
            publishedAt: !awaitingV2Publication && sameIdentity ? current.publishedAt : null,
            progress: current.progress,
            identityKey: dashboardCacheIdentity,
            error: awaitingV2Publication ? null : loadError.message,
          }));
        }
      })();
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [applyMovementLoadedData, currentDashboardManifestReady, dashboardAvailability, dashboardCacheIdentity, dashboardSourcesReady, isAuthorizedDashboardViewer, noMovementRetryCount, view, viewerAuthorization]);

  useEffect(() => {
    if (view !== "bipagem") return undefined;
    if (!viewerAuthorization || !isAuthorizedDashboardViewer || !dashboardSourcesReady || !currentDashboardManifestReady) {
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const dateFrom = pddCollectionFailureV2State.period.dateFrom;
    const dateTo = pddCollectionFailureV2State.period.dateTo;
    const timer = window.setTimeout(() => {
      void (async () => {
        setPddCollectionFailureV2State((current) => ({
          ...current,
          status: "loading",
          records: current.identityKey === dashboardCacheIdentity ? current.records : [],
          receivedCount: current.identityKey === dashboardCacheIdentity ? current.receivedCount : 0,
          publicationId: current.identityKey === dashboardCacheIdentity ? current.publicationId : null,
          publicationIds: current.identityKey === dashboardCacheIdentity ? current.publicationIds : [],
          updatedAt: current.identityKey === dashboardCacheIdentity ? current.updatedAt : null,
          publishedAt: current.identityKey === dashboardCacheIdentity ? current.publishedAt : null,
          dataPeriod: current.identityKey === dashboardCacheIdentity ? current.dataPeriod : null,
          identityKey: dashboardCacheIdentity,
          progress: { loaded: 0, total: 0, stage: "records" },
          error: null,
        }));
        const validDateRange = Boolean(dateFrom && dateTo && dateFrom <= dateTo);
        if (!validDateRange || !isPddCollectionFailureV2SingleOperationalDate({ dateFrom, dateTo })) {
          setPddCollectionFailureV2State((current) => ({
            ...current,
            status: "error",
            error: validDateRange
              ? t("Selecione um único dia operacional. Os indicadores e tabelas não somam dias diferentes.")
              : t("Informe um intervalo de datas válido para consultar os dados."),
          }));
          return;
        }

        const authorizationHeaders = new Headers();
        if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
          authorizationHeaders.set("authorization", viewerAuthorization);
        }
        const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
        try {
          const published = await loadCachedDashboardData({
            identityKey: dashboardCacheIdentity,
            sourceId: "pdd_collection_failure",
            contractVersion: 2,
            periodKey: `${dateFrom}:${dateTo}:unfiltered-rows`,
            manifest: (signal) => readDashboardDataManifest({
              sourceId: "pdd_collection_failure",
              contractVersion: 2,
              dateFrom,
              dateTo,
              publicationToken: currentDashboardPublicationToken,
              fetcher: cacheFetcher,
            }, signal),
            load: (signal) => loadPublishedPddCollectionFailure({ dateFrom, dateTo }, cacheFetcher, signal, (loaded, total, stage) => {
              if (active) setPddCollectionFailureV2State((current) => ({ ...current, progress: { loaded, total, stage } }));
            }),
          }, controller.signal);
          if (!active) return;
          setPddCollectionFailureV2State((current) => ({
            ...current,
            status: published.rowCount === 0 ? "empty" : "ready",
            period: published.period,
            dataPeriod: published.period,
            records: published.records,
            progress: { loaded: published.rowCount, total: published.rowCount, stage: "records" },
            receivedCount: published.rowCount,
            columnCount: published.columnCount,
            publicationId: published.publicationId,
            publicationIds: published.publicationIds,
            updatedAt: published.updatedAt,
            publishedAt: published.publishedAt,
            identityKey: dashboardCacheIdentity,
            error: null,
          }));
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          const loadError = cause instanceof PddCollectionFailureV2LoadError
            ? cause
            : new PddCollectionFailureV2LoadError("invalid_data", "Não foi possível preparar os dados publicados da Data Foundation V2.");
          const sameIdentity = pddCollectionFailureV2StateRef.current.identityKey === dashboardCacheIdentity;
          setPddCollectionFailureV2State((current) => ({
            ...current,
            status: loadError.kind === "empty" ? "empty" : "error",
            records: loadError.kind !== "empty" && sameIdentity ? current.records : [],
            receivedCount: loadError.kind !== "empty" && sameIdentity ? current.receivedCount : 0,
            publicationId: loadError.kind !== "empty" && sameIdentity ? current.publicationId : null,
            publicationIds: loadError.kind !== "empty" && sameIdentity ? current.publicationIds : [],
            updatedAt: loadError.kind !== "empty" && sameIdentity ? current.updatedAt : null,
            publishedAt: loadError.kind !== "empty" && sameIdentity ? current.publishedAt : null,
            dataPeriod: loadError.kind !== "empty" && sameIdentity ? current.dataPeriod : null,
            identityKey: dashboardCacheIdentity,
            error: loadError.message,
          }));
        }
      })();
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentDashboardManifestReady, currentDashboardPublicationToken, dashboardAvailability, dashboardCacheIdentity, dashboardSourcesReady, isAuthorizedDashboardViewer, pddCollectionFailureV2State.period.dateFrom, pddCollectionFailureV2State.period.dateTo, pddCollectionFailureRetryCount, t, view, viewerAuthorization]);

  useEffect(() => {
    if (view !== "sellers" || !isFirstMileUnderReview) return undefined;
    if (!viewerAuthorization || !isAuthorizedDashboardViewer || !dashboardSourcesReady) {
      if (!viewerAuthorization || !isAuthorizedDashboardViewer) {
        jtMonitoringV2RequestRef.current?.abort();
        jtMonitoringV2RequestRef.current = null;
      }
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    jtMonitoringV2RequestRef.current?.abort();
    jtMonitoringV2RequestRef.current = controller;
    const period = jtMonitoringV2State.period;
    const timer = window.setTimeout(() => {
      void (async () => {
        setJtMonitoringV2State((current) => ({
          ...current,
          status: "loading",
          loading: true,
          records: [],
          totalAvailable: 0,
          loadedCount: 0,
          publicationId: null,
          publicationIds: [],
          publishedAt: null,
          dateCountsSignature: null,
          error: null,
        }));
        if (!period.dateFrom || !period.dateTo || period.dateFrom > period.dateTo) {
          setJtMonitoringV2State((current) => ({
            ...current,
            status: "error",
            loading: false,
            error: "Informe um intervalo de datas válido para consultar os dados.",
          }));
          return;
        }

        const authorizationHeaders = new Headers();
        if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
          authorizationHeaders.set("authorization", viewerAuthorization);
        }
        const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
        try {
          const page = await loadCachedDashboardData({
            identityKey: dashboardCacheIdentity,
            sourceId: "jt_monitoring",
            contractVersion: 1,
            periodKey: `${period.dateFrom}:${period.dateTo}:page-0`,
            manifest: (signal) => readDashboardDataManifest({
              sourceId: "jt_monitoring",
              contractVersion: 1,
              dateFrom: period.dateFrom,
              dateTo: period.dateTo,
              publicationToken: currentDashboardPublicationToken,
              fetcher: cacheFetcher,
            }, signal),
            load: (signal) => loadJtMonitoringPage(period, 0, cacheFetcher, signal),
          }, controller.signal);
          if (!active) return;
          setJtMonitoringV2State((current) => ({
            ...current,
            status: page.totalAvailable === 0 ? "empty" : "ready",
            loading: false,
            period: page.period,
            records: page.records,
            totalAvailable: page.totalAvailable,
            loadedCount: page.records.length,
            columnCount: page.columnCount,
            publicationId: page.publicationId,
            publicationIds: page.publicationIds,
            publishedAt: page.publishedAt,
            dateCountsSignature: page.dateCountsSignature,
            error: null,
          }));
        } catch (cause) {
          if (!active || controller.signal.aborted) return;
          const loadError = cause instanceof JtMonitoringV2LoadError
            ? cause
            : new JtMonitoringV2LoadError("invalid_data", "Não foi possível preparar os dados publicados da Data Foundation V2.");
          setJtMonitoringV2State((current) => ({
            ...current,
            status: loadError.kind === "empty" ? "empty" : "error",
            loading: false,
            records: [],
            totalAvailable: 0,
            loadedCount: 0,
            publicationId: null,
            publicationIds: [],
            publishedAt: null,
            dateCountsSignature: null,
            error: loadError.message,
          }));
        } finally {
          if (jtMonitoringV2RequestRef.current === controller) jtMonitoringV2RequestRef.current = null;
        }
      })();
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
      jtMonitoringV2RequestRef.current?.abort();
      if (jtMonitoringV2RequestRef.current) jtMonitoringV2RequestRef.current = null;
    };
  }, [currentDashboardPublicationToken, dashboardCacheIdentity, dashboardSourcesReady, isFirstMileUnderReview, isAuthorizedDashboardViewer, jtMonitoringV2State.period, view, viewerAuthorization]);

  const loadMoreJtMonitoringV2 = useCallback(async () => {
    const currentState = jtMonitoringV2State;
    if (
      !viewerAuthorization ||
      !isAuthorizedDashboardViewer ||
      (currentState.status !== "ready" && !(currentState.status === "error" && currentState.loadedCount > 0)) ||
      currentState.loading ||
      currentState.loadedCount >= currentState.totalAvailable ||
      currentState.loadedCount >= JT_MONITORING_V2_MAX_PREVIEW_ROWS ||
      jtMonitoringV2RequestRef.current
    ) return;

    const offset = currentState.records.length;
    const controller = new AbortController();
    jtMonitoringV2RequestRef.current = controller;
    setJtMonitoringV2State((state) => ({ ...state, status: "ready", loading: true, error: null }));

    const authorizationHeaders = new Headers();
    if (viewerAuthorization !== FEISHU_COOKIE_SESSION) {
      authorizationHeaders.set("authorization", viewerAuthorization);
    }
    const cacheFetcher = (path: string, init?: RequestInit) => apiFetch(path, { ...init, headers: authorizationHeaders });
    try {
      const page = await loadCachedDashboardData({
        identityKey: dashboardCacheIdentity,
        sourceId: "jt_monitoring",
        contractVersion: 1,
        periodKey: `${currentState.period.dateFrom}:${currentState.period.dateTo}:page-${offset}`,
        manifest: (signal) => readDashboardDataManifest({
          sourceId: "jt_monitoring",
          contractVersion: 1,
          dateFrom: currentState.period.dateFrom,
          dateTo: currentState.period.dateTo,
          publicationToken: currentDashboardPublicationToken,
          fetcher: cacheFetcher,
        }, signal),
        load: (signal) => loadJtMonitoringPage(currentState.period, offset, cacheFetcher, signal),
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (
        page.offset !== currentState.loadedCount ||
        page.totalAvailable !== currentState.totalAvailable ||
        page.publicationId !== currentState.publicationId ||
        page.dateCountsSignature !== currentState.dateCountsSignature
      ) {
        throw new JtMonitoringV2LoadError("inconsistent", "A publicação ou a contagem mudou; atualize o período antes de carregar outra página.");
      }
      const existingIdentities = new Set(currentState.records.map(jtMonitoringV2RowIdentity));
      for (const record of page.records) {
        const identity = jtMonitoringV2RowIdentity(record);
        if (existingIdentities.has(identity)) {
          throw new JtMonitoringV2LoadError("invalid_data", "A API V2 repetiu uma linha física entre páginas.");
        }
        existingIdentities.add(identity);
      }
      setJtMonitoringV2State((state) => {
        if (state.period.dateFrom !== currentState.period.dateFrom || state.period.dateTo !== currentState.period.dateTo || state.records.length !== offset) return state;
        return {
          ...state,
          status: "ready",
          loading: false,
          records: [...state.records, ...page.records],
          loadedCount: state.records.length + page.records.length,
          publicationIds: [...new Set([...state.publicationIds, ...page.publicationIds])].sort(),
          error: null,
        };
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const loadError = cause instanceof JtMonitoringV2LoadError
        ? cause
        : new JtMonitoringV2LoadError("invalid_data", "Não foi possível carregar a próxima página V2.");
      setJtMonitoringV2State((state) => ({
        ...state,
        status: "error",
        loading: false,
        error: loadError.message,
      }));
    } finally {
      if (jtMonitoringV2RequestRef.current === controller) jtMonitoringV2RequestRef.current = null;
    }
  }, [currentDashboardPublicationToken, dashboardCacheIdentity, isAuthorizedDashboardViewer, jtMonitoringV2State, viewerAuthorization]);

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
      const [{ parseWorkbook, compactMonitoringWorkbook }] = await Promise.all([import("../../lib/workbook")]);
      const parsed = compactMonitoringWorkbook(parseWorkbook(await file.arrayBuffer()));
      const response = await postWorkbook(
        { kind: "monitoring", fileName: file.name, parsed },
        [file],
      );
      const payload = (await response.json()) as { workbook?: Omit<SavedWorkbook, "parsed">; error?: string };
      if (!response.ok || !payload.workbook) {
        throw new Error(payload.error ?? "Não foi possível publicar a atualização do dashboard.");
      }

      const { mergeTaxaHistory } = await import("../../lib/taxa-history");
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
        import("../../lib/workbook"),
        import("../../lib/taxa-history"),
      ]);
      const selectedWorkbooks = await Promise.all(
        files.map(async (file) => parseWorkbook(await file.arrayBuffer())),
      );
      const parsed = mergeTaxaHistory(null, selectedWorkbooks).parsed;
      const latestFile = files[files.length - 1];
      const fileName = files.length === 1
        ? `Histórico acumulado · ${latestFile.name}`
        : `Histórico acumulado · ${files.length} arquivos · ${latestFile.name}`;
      const response = await postWorkbook(
        { kind: "taxa", fileName, parsed, mergeHistory: true },
        files,
      );
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
  }, [applyTaxaLoadedData, taxaLoaded]);

  const loadEpopFile = useCallback(async (file: File) => {
    setError(null);
    setEpopHistoryNotice(null);
    if (!/\.xlsx?$/i.test(file.name)) { setError("Selecione um arquivo Excel no formato .xlsx ou .xls."); return; }
    if (file.size > 200 * 1024 * 1024) { setError("O arquivo EPOP ultrapassa o limite de 200 MB."); return; }
    setEpopLoading(true);
    try {
      const { parseWorkbook } = await import("../../lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await postWorkbook({ kind: "epop", fileName: file.name, parsed }, [file]);
      const payload = await response.json() as { workbook?: { updatedAt?: string }; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar o relatório EPOP.");
      // EPOP is an incremental daily history: keep prior days in the browser
      // immediately after publishing, and replace only dates present in a
      // re-sent daily file. The same merge is performed again when the saved
      // history is loaded on the next visit.
      const { mergeTaxaHistory } = await import("../../lib/taxa-history");
      const historyMerge = mergeTaxaHistory(epopLoaded?.parsed ?? null, [parsed]);
      const accumulated = historyMerge.parsed;
      const data = buildEpopLoadedData(accumulated, `Histórico EPOP · ${file.name}`, payload.workbook.updatedAt);
      setEpopLoaded(data);
      setEpopSelectedRegions(initialRegionSelection(data.regions, viewerIdentity)); setEpopSelectedBases(new Set(data.bases));
      setEpopDateStart(data.dates[0] ?? ""); setEpopDateEnd(data.dates[data.dates.length - 1] ?? "");
      setEpopHistoryNotice(historyMerge);
      setView("epop");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível ler a planilha EPOP."); }
    finally { setEpopLoading(false); }
  }, [epopLoaded, viewerIdentity]);

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
      const [{ parseWorkbook }] = await Promise.all([import("../../lib/workbook")]);
      const parsed = parseWorkbook(await file.arrayBuffer(), { preferredSheetName: "SELLERS" });
      const response = await postWorkbook(
        { kind: "sellerList", fileName: file.name, parsed },
        [file],
      );
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
          buildSellerPerformanceData(sellerPerformanceLoaded.parsed, reference, sellerPerformanceLoaded.fileName, sellerPerformanceLoaded.updatedAt, responsibilityLoaded),
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
      const [{ parseWorkbook }] = await Promise.all([import("../../lib/workbook")]);
      const parsed = parseWorkbook(await file.arrayBuffer(), { preferredSheetName: "单商多服揽收日报" });
      const special = buildSpecialSellerData(parsed, file.name);
      const normalizedParsed: ParsedWorkbook = {
        ...parsed,
        sheetName: "SELLERS ESPECIAIS",
        headers: ["Seller especial"],
        rows: special.sellerCodes.map((sellerCode) => ({ "Seller especial": sellerCode })),
        statusColumns: [],
      };
      const response = await postWorkbook(
        { kind: "sellerSpecialList", fileName: file.name, parsed: normalizedParsed },
        [file],
      );
      const payload = (await response.json()) as { workbook?: SavedWorkbook; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar os sellers especiais.");
      const savedSpecial = buildSpecialSellerData(payload.workbook.parsed, payload.workbook.fileName, payload.workbook.updatedAt);
      setSpecialSellerLoaded(savedSpecial);
      const reference = mergeSellerReferenceData(sellerReferenceLoaded, savedSpecial);
      setSellerReferenceLoaded(reference);
      if (sellerPerformanceLoaded) {
        applySellerPerformanceLoadedData(
          buildSellerPerformanceData(sellerPerformanceLoaded.parsed, reference, sellerPerformanceLoaded.fileName, sellerPerformanceLoaded.updatedAt, responsibilityLoaded),
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
      const { parseWorkbook } = await import("../../lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await postWorkbook(
        { kind: "bipagem", fileName: file.name, parsed },
        [file],
      );
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
      const { parseWorkbook } = await import("../../lib/workbook");
      const parsed = parseWorkbook(await file.arrayBuffer());
      const response = await postWorkbook(
        { kind: "damage", fileName: file.name, parsed },
        [file],
      );
      const payload = (await response.json()) as { workbook?: Omit<SavedWorkbook, "parsed"> & { parsed?: ParsedWorkbook }; error?: string };
      if (!response.ok || !payload.workbook) throw new Error(payload.error ?? "Não foi possível publicar o relatório de avaria e extravio.");
      const { mergeTaxaHistory } = await import("../../lib/taxa-history");
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
    if (upload.kind === "sellerList") return loadSellerListFile(file);
    if (upload.kind === "sellerSpecialList") return loadSpecialSellerFile(file);
    if (upload.kind === "bipagem") return loadBipagemFile(file);
    if (upload.kind === "damage") return loadDamageFile(file);
    return Promise.resolve();
  }, [loadBipagemFile, loadDamageFile, loadEpopFile, loadFile, loadSellerListFile, loadSpecialSellerFile, loadTaxaFiles]);

  const queueUpload = useCallback((upload: PendingUpload) => {
    if (viewerIdentity?.platform_role !== "ADMIN") return;
    if (LOCAL_DASHBOARD_DEMO_MODE) {
      setError("O envio de planilhas está desativado no modo de demonstração.");
      return;
    }
    void runUpload(upload);
  }, [runUpload, viewerIdentity?.platform_role]);

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
      const region = rowRegion(row, loaded.parsed.regionColumn);
      const origin = rowOrigin(row, loaded.originColumn);
      return (
        date >= dateStart &&
        date <= dateEnd &&
        selectedBases.has(base) &&
        selectedRegions.has(region) &&
        (loaded.sourceType === "DATA_FOUNDATION_V2" || selectedOrigins.has(origin)) &&
        matchesMonitoringResponsibility(responsibilityLoaded, base, region, selectedRms, selectedRgms, row)
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
      const region = rowRegion(row, loaded.parsed.regionColumn);
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
  }, [language, loaded, monitoringSummaryPeriod, monitoringSummaryRows, selectedStatuses]);

  const monitoringRmSummary = useMemo<MonitoringRmSummaryRow[]>(() => {
    if (!loaded?.parsed.baseColumn) return [];
    const groups = new Map<string, MonitoringRmSummaryRow>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const responsibility = monitoringResponsibilityForRow(responsibilityLoaded, row, base, rowRegion(row, loaded.parsed.regionColumn));
      const rmArea = responsibility.rmArea;
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
  const firstScanTableRows = useMemo(() => {
    if (!isReferenceBaseTestActive) return monitoringSummaryRows;
    if (!loaded?.parsed.baseColumn || !loaded.parsed.dateColumn) return [];
    const selectedDayRows = loaded.parsed.rows.filter(
      (row) => String(row[loaded.parsed.dateColumn as string] ?? "") === "2026-10-05",
    );
    return filterRowsByReferenceBaseNames(
      selectedDayRows,
      referenceBaseTestSelected,
      (row) => row.__sourceBaseName ?? row[loaded.parsed.baseColumn as string],
    );
  }, [isReferenceBaseTestActive, loaded, monitoringSummaryRows, referenceBaseTestSelected]);
  const firstScanReferenceTestInfo = useMemo(() => {
    if (!isReferenceBaseTestActive || !loaded?.parsed.baseColumn || !loaded.parsed.dateColumn) return null;
    const dayRows = loaded.parsed.rows.filter(
      (row) => String(row[loaded.parsed.dateColumn as string] ?? "") === "2026-10-05",
    );
    const rowsWithoutBaseName = dayRows.filter((row) =>
      !normalizeReferenceBaseName(row.__sourceBaseName ?? row[loaded.parsed.baseColumn as string]),
    ).length;
    return { dayRows: dayRows.length, includedRows: firstScanTableRows.length, rowsWithoutBaseName };
  }, [firstScanTableRows, isReferenceBaseTestActive, loaded]);

  const firstScanRegionalSummary = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [] as Array<{ region: string; rgm: string } & FirstScanMetrics>;
    const groups = new Map<string, { region: string; rgm: string } & FirstScanMetrics>();
    for (const row of firstScanTableRows) {
      const region = rowRegion(row, loaded.parsed.regionColumn);
      const current = groups.get(region) ?? { region, rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM, orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(region, current);
    }
    return [...groups.values()].filter((row) => row.orderVolume > 0).sort((a, b) => firstScanTotalRetained(b) - firstScanTotalRetained(a));
  }, [firstScanTableRows, loaded]);
  const firstScanRmSummary = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [] as Array<{ rmArea: string; rm: string; rgm: string } & FirstScanMetrics>;
    const groups = new Map<string, { rmArea: string; rm: string; rgm: string } & FirstScanMetrics>();
    for (const row of monitoringSummaryRows) {
      const base = rowBase(row, loaded.parsed.baseColumn);
      const responsibility = monitoringResponsibilityForRow(responsibilityLoaded, row, base, rowRegion(row, loaded.parsed.regionColumn));
      const rmArea = responsibility.rmArea;
      const key = `${rmArea}\u0000${responsibility.rm}\u0000${responsibility.rgm}`;
      const current = groups.get(key) ?? { rmArea, rm: responsibility.rm, rgm: responsibility.rgm, orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(key, current);
    }
    return [...groups.values()].filter((row) => row.orderVolume > 0).sort((a, b) => firstScanTotalRetained(b) - firstScanTotalRetained(a));
  }, [loaded, monitoringSummaryRows, responsibilityLoaded]);
  const firstScanTotal = useMemo(() => firstScanRegionalSummary.reduce<FirstScanMetrics>((total, row) => { addFirstScanMetrics(total, row); return total; }, { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 }), [firstScanRegionalSummary]);
  const firstScanPreviousRegional = useMemo(() => {
    if (isReferenceBaseTestActive) return new Map<string, FirstScanMetrics>();
    if (!loaded?.parsed.dateColumn || !loaded.parsed.baseColumn) return new Map<string, FirstScanMetrics>();
    const currentDate = monitoringSummaryDates[monitoringSummaryDates.length - 1];
    const previousDate = loaded.dates.filter((date) => date < currentDate).at(-1);
    if (!previousDate) return new Map<string, FirstScanMetrics>();
    const groups = new Map<string, FirstScanMetrics>();
    for (const row of loaded.parsed.rows) {
      if (String(row[loaded.parsed.dateColumn] ?? "") !== previousDate) continue;
      const base = rowBase(row, loaded.parsed.baseColumn);
      const region = rowRegion(row, loaded.parsed.regionColumn);
      const origin = rowOrigin(row, loaded.originColumn);
      if (!selectedRegions.has(region) || !selectedBases.has(base) || (loaded.sourceType !== "DATA_FOUNDATION_V2" && !selectedOrigins.has(origin)) || !matchesMonitoringResponsibility(responsibilityLoaded, base, region, selectedRms, selectedRgms, row)) continue;
      const current = groups.get(region) ?? { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 };
      addFirstScanMetrics(current, firstScanMetricsForRow(row, loaded.statuses));
      groups.set(region, current);
    }
    return groups;
  }, [isReferenceBaseTestActive, loaded, monitoringSummaryDates, responsibilityLoaded, selectedBases, selectedOrigins, selectedRegions, selectedRgms, selectedRms]);
  const firstScanPreviousTotal = useMemo(() => [...firstScanPreviousRegional.values()].reduce<FirstScanMetrics>((total, row) => {
    addFirstScanMetrics(total, row);
    return total;
  }, { orderVolume: 0, baseRetained: 0, baseDispatched: 0, hubArrived: 0 }), [firstScanPreviousRegional]);
  const regionalSummaries = useMemo<RegionalSummary[]>(() => {
    if (!loaded) return [];

    const regions = new Map<string, WorkbookRow[]>();
    for (const row of filteredRows) {
      const region = rowRegion(row, loaded.parsed.regionColumn);
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
  }, [loaded, filteredRows, selectedStatuses]);

  const tableRows = useMemo(() => {
    if (!loaded) return [];
    const normalizedQuery = tableQuery.trim().toLocaleLowerCase("pt-BR");
    const baseColumn = loaded.parsed.baseColumn as string;
    const regionColumn = loaded.parsed.regionColumn;
    const period = formatConsolidatedPeriod(dateStart, dateEnd);
    const grouped = new Map<string, ConsolidatedBaseRow>();

    for (const row of filteredRows) {
      const base = rowBase(row, baseColumn);
      const region = rowRegion(row, regionColumn);
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
  }, [loaded, dateStart, dateEnd, filteredRows, selectedStatuses, tableQuery]);

  const monitoringRegionOptions = useMemo(() => {
    if (!loaded?.parsed.baseColumn) return [];
    return [...new Set(loaded.parsed.rows.map((row) => rowRegion(row, loaded.parsed.regionColumn)))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [loaded]);
  const taxaRegionOptions = useMemo(() => {
    if (!taxaLoaded) return [];
    return [...new Set(taxaLoaded.records.map((record) => record.region))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  }, [taxaLoaded]);
  const movementFilterOptions = useMemo(() => deriveMovementFilterOptions(
    movementLoaded?.records ?? [],
    {
      regions: movementSelectedRegions,
      rms: movementSelectedRms,
      rmAreas: movementSelectedRmAreas,
      bases: movementSelectedBases,
      rgms: movementSelectedRgms,
    },
  ), [movementLoaded, movementSelectedBases, movementSelectedRegions, movementSelectedRmAreas, movementSelectedRgms, movementSelectedRms]);
  const movementRegionOptions = movementFilterOptions.regions;
  const movementRmOptions = movementFilterOptions.rms;
  const movementRmAreaOptions = movementFilterOptions.rmAreas;
  const movementBaseOptions = movementFilterOptions.bases;
  const movementRgmOptions = movementFilterOptions.rgms;
  const applyMovementFilterSelection = useCallback((kind: "regions" | "rms" | "rmAreas" | "bases" | "rgms", value: Set<string>) => {
    if (!movementLoaded) return;
    const next = movementSelectionsAfterChange(movementLoaded.records, {
      regions: movementSelectedRegions,
      rms: movementSelectedRms,
      rmAreas: movementSelectedRmAreas,
      bases: movementSelectedBases,
      rgms: movementSelectedRgms,
    }, kind, value);
    setMovementSelectedRegions(next.regions);
    setMovementSelectedRms(next.rms);
    setMovementSelectedRmAreas(next.rmAreas);
    setMovementSelectedBases(next.bases);
    setMovementSelectedRgms(next.rgms);
    setMovementPage(1);
  }, [movementLoaded, movementSelectedBases, movementSelectedRegions, movementSelectedRmAreas, movementSelectedRgms, movementSelectedRms]);
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

  // Taxa RM options come only from the already-scoped Taxa dataset after applying
  // the official/legacy resolver. The ALL state follows source updates naturally.
  const taxaResponsibilityFilterOptions = useMemo(
    () => responsibilityOptions(responsibilityLoaded, taxaLoaded?.bases ?? []),
    [responsibilityLoaded, taxaLoaded],
  );
  const taxaSelectedRms = useMemo(
    () => selectedRmOptions(taxaResponsibilityFilterOptions.rms, taxaRmSelection),
    [taxaResponsibilityFilterOptions.rms, taxaRmSelection],
  );

  const monitoringResponsibilityFilterOptions = useMemo(() => {
    if (!loaded) return { rms: [UNASSIGNED_RM], rgms: [UNASSIGNED_RGM] };
    const options = monitoringResponsibilityOptionsForData(loaded, responsibilityLoaded);
    return {
      rms: [...new Set([...options.rms, UNASSIGNED_RM])].sort((a, b) => a.localeCompare(b, "pt-BR")),
      rgms: [...new Set([...options.rgms, UNASSIGNED_RGM])].sort((a, b) => a.localeCompare(b, "pt-BR")),
    };
  }, [loaded, responsibilityLoaded]);

  const baseOptions = useMemo(() => {
    if (!loaded) return [];
    return monitoringBasesForSelection(loaded, selectedRegions, responsibilityLoaded, selectedRms, selectedRgms);
  }, [loaded, responsibilityLoaded, selectedRegions, selectedRgms, selectedRms]);

  // Build this stage before applying the RM-area selection. Selected bases are
  // intentionally excluded because changing an RM area also updates that state.
  const taxaRowsBeforeRmAreaFilter = useMemo(() => {
    if (!taxaLoaded || !taxaDateStart || !taxaDateEnd || taxaDateStart > taxaDateEnd) return [];
    return taxaLoaded.records.filter((record) =>
      record.date >= taxaDateStart &&
      record.date <= taxaDateEnd &&
      taxaSelectedRegions.has(record.region) &&
      taxaSelectedOrigins.has(record.origin) &&
      matchesResponsibility(responsibilityLoaded, record.base, taxaSelectedRms, selectedRgms));
  }, [responsibilityLoaded, selectedRgms, taxaDateEnd, taxaDateStart, taxaLoaded, taxaSelectedOrigins, taxaSelectedRegions, taxaSelectedRms]);

  const taxaRmAreaOptions = useMemo(
    () => distinctFilterOptions(taxaRowsBeforeRmAreaFilter, (record) => rmAreaForBase(responsibilityLoaded, record.base)),
    [responsibilityLoaded, taxaRowsBeforeRmAreaFilter],
  );

  const taxaSelectedRmAreas = useMemo(
    () => selectedOptions(taxaRmAreaOptions, taxaRmAreaSelection),
    [taxaRmAreaOptions, taxaRmAreaSelection],
  );

  const taxaBaseOptions = useMemo(() => {
    if (!taxaLoaded) return [];
    return taxaBasesForRegions(taxaLoaded, taxaSelectedRegions).filter((base) =>
      matchesResponsibility(responsibilityLoaded, base, taxaSelectedRms, selectedRgms) &&
      taxaSelectedRmAreas.has(rmAreaForBase(responsibilityLoaded, base)));
  }, [responsibilityLoaded, selectedRgms, taxaLoaded, taxaSelectedRegions, taxaSelectedRms, taxaSelectedRmAreas]);

  const taxaFilteredRecords = useMemo(
    () => filterRowsByOption(
      taxaRowsBeforeRmAreaFilter.filter((record) => taxaSelectedBases.has(record.base)),
      taxaSelectedRmAreas,
      (record) => rmAreaForBase(responsibilityLoaded, record.base),
    ),
    [responsibilityLoaded, taxaRowsBeforeRmAreaFilter, taxaSelectedBases, taxaSelectedRmAreas],
  );

  const taxaAttemptTarget = useMemo(
    () => attemptRateTargetForOrigins(taxaSelectedOrigins),
    [taxaSelectedOrigins],
  );
  const taxaPerformanceThreshold = taxaAttemptTarget ?? ATTEMPT_RATE_TARGET;

  const taxaSummary = useMemo(
    () => summarizeTaxaPeriod(taxaFilteredRecords),
    [taxaFilteredRecords],
  );

  const taxaV2Rows = useMemo(
    () => collectionRateV2State.records.map(mapCollectionRateV3Record),
    [collectionRateV2State.records],
  );
  const taxaV2HasPreviousData = (collectionRateV2State.status === "loading" || collectionRateV2State.status === "error") &&
    collectionRateV2State.records.length > 0 && collectionRateV2State.loadedPeriod !== null;
  const taxaV2Options = useMemo(() => collectionRateV3FilterOptions(taxaV2Rows), [taxaV2Rows]);
  const taxaV2FilteredRows = useMemo(
    () => filterCollectionRateV3Rows(taxaV2Rows, taxaV2Filters),
    [taxaV2Rows, taxaV2Filters],
  );
  const taxaV2RegionalDates = useMemo(() => {
    const publishedDates = [...new Set(taxaV2Rows.map((row) => String(row.data_date)))].sort();
    if (publishedDates.length > 0) return publishedDates;
    const { dateFrom, dateTo } = collectionRateV2State.period;
    return dateFrom && dateFrom === dateTo ? [dateFrom] : [];
  }, [collectionRateV2State.period, taxaV2Rows]);
  const taxaV2CardSummaries = useMemo(
    () => summarizeCollectionRateV3Cards(taxaV2FilteredRows),
    [taxaV2FilteredRows],
  );
  const taxaV2Summary = taxaV2CardSummaries.totals;
  const taxaV2AttemptRate = taxaV2CardSummaries.attempts;
  const taxaV2RegionalAttempts = useMemo(
    () => summarizeCollectionRateV3RegionalAttempts(taxaV2FilteredRows, taxaV2RegionalDates),
    [taxaV2FilteredRows, taxaV2RegionalDates],
  );
  const taxaV2ByRmArea = useMemo(() => groupCollectionRateV3Rows(taxaV2FilteredRows, "rmArea"), [taxaV2FilteredRows]);
  const taxaV2Daily = useMemo(() => summarizeCollectionRateV3Daily(taxaV2FilteredRows), [taxaV2FilteredRows]);
  const taxaV2MonthlyChart = useMemo(() => collectionRateV3MonthlyChartPoints(taxaV2FilteredRows), [taxaV2FilteredRows]);
  const taxaV2ByOrigin = useMemo(() => summarizeCollectionRateV3Origins(taxaV2FilteredRows), [taxaV2FilteredRows]);
  const taxaV2Dates = useMemo(() => [...new Set(taxaV2FilteredRows.map((row) => String(row.data_date)))].sort(), [taxaV2FilteredRows]);
  const taxaV2SearchedRows = useMemo(() => {
    const query = normalizeSearchText(taxaV2TableQuery.trim());
    if (!query) return taxaV2FilteredRows;
    return taxaV2FilteredRows.filter((row) => normalizeSearchText(
      [...COLLECTION_RATE_V3_COLUMNS.map((field) => String(row[field] ?? "")), row.region, row.rm, row.rmArea, row.rgm, row.base]
        .join(" "),
    ).includes(query));
  }, [taxaV2FilteredRows, taxaV2TableQuery]);
  const taxaV2PageCount = Math.max(1, Math.ceil(taxaV2SearchedRows.length / PDD_FAILURE_DETAIL_PAGE_SIZE));
  const taxaV2ActivePage = Math.min(taxaV2Page, taxaV2PageCount);
  const taxaV2VisibleRows = useMemo(
    () => taxaV2SearchedRows.slice((taxaV2ActivePage - 1) * PDD_FAILURE_DETAIL_PAGE_SIZE, taxaV2ActivePage * PDD_FAILURE_DETAIL_PAGE_SIZE),
    [taxaV2ActivePage, taxaV2SearchedRows],
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
        rate: taxaRate(value.attempted, value.toCollect),
        priorities: [...value.bases.values()].map((base) => {
          const rate = taxaRate(base.attempted, base.toCollect);
          return { ...base, rate, impact: Math.max(0, base.toCollect * 0.98 - base.attempted) };
        })
          .filter((base) => base.orders > 500 && base.toCollect > 0 && base.rate !== null && base.rate < 0.98)
          .sort((left, right) => right.impact - left.impact || right.orders - left.orders || (left.rate ?? 0) - (right.rate ?? 0))
          .slice(0, 2),
      })).filter((item) => item.priorities.length > 0)
        .sort((left, right) => right.priorities.reduce((sum, base) => sum + base.impact, 0) - left.priorities.reduce((sum, base) => sum + base.impact, 0) || (left.rate ?? -1) - (right.rate ?? -1) || left.regional.localeCompare(right.regional, "pt-BR"));
      const selectedDate = taxaDateEnd || taxaDateStart;
      const [, month, day] = selectedDate.split("-");
      const messageDate = day && month ? `${day}/${month}` : selectedDate;
      return [
        "Bom dia, pessoal!", "大家早上好！", "",
        `📊 **Taxa de Coleta ${messageDate} | 揽收及时率**`,
        `Geral: **${formatTaxaRate(taxaSummary.collectionWithAttemptsRate)}** | Meta: **98%**`,
        `整体：**${formatTaxaRate(taxaSummary.collectionWithAttemptsRate)}** | 目标：**98%**`,
        "", "⚠️ **Pontos críticos / 重点关注**", "",
        ...(regionals.length ? regionals.slice(0, 5).flatMap((regional) => [
          `${regional.rate !== null && regional.rate < 0.95 ? "🔴" : "🟠"} **${regional.regional} ${formatTaxaRate(regional.rate)}**`,
          ...regional.priorities.map((base) => {
            const rm = base.rm.trim() || "待定";
            return `${base.base} **${formatTaxaRate(base.rate)}** | ${formatNumber(base.orders)} pacotes | ${rm.startsWith("@") ? rm : `@${rm}`}`;
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
  }, [bipagemBaseSummary, bipagemDateEnd, bipagemDateStart, bipagemSummary, responsibilityLoaded, taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaSummary.collectionWithAttemptsRate, view]);

  const taxaGeneralMonthlyTrend = useMemo(() => {
    const months = summarizeTaxaByMonth(taxaFilteredRecords);
    const years = [...new Set(months.map((month) => month.monthKey.slice(0, 4)))];
    const periodLabel = years.length === 1
      ? years[0]
      : years.length > 1
        ? `${years[0]}–${years.at(-1)}`
        : "";
    const monthFormatter = new Intl.DateTimeFormat(dashboardLocale(language), {
      month: "short",
      ...(years.length > 1 ? { year: "2-digit" as const } : {}),
      timeZone: "UTC",
    });
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
    const yForRate = (rate: number | null) => {
      if (rate === null) return null;
      const clamped = Math.max(minRate, Math.min(maxRate, rate));
      return top + (1 - (clamped - minRate) / (maxRate - minRate)) * chartHeight;
    };
    const points = months.map((month, index) => ({
      ...month,
      x: xForIndex(index),
      monthLabel: monthFormatter
        .format(new Date(`${month.monthKey}-01T12:00:00Z`))
        .replace(/\.$/, ""),
    })).map((point) => ({
      ...point,
      collectionY: yForRate(point.onTimeRate),
      attemptY: yForRate(point.attemptRate),
    }));
    const lineSegments = (key: "collectionY" | "attemptY") => {
      const segments: string[][] = [];
      let current: string[] = [];
      for (const point of points) {
        const y = point[key];
        if (y === null) {
          if (current.length) segments.push(current);
          current = [];
          continue;
        }
        current.push(`${point.x},${y}`);
      }
      if (current.length) segments.push(current);
      return segments.map((segment) => segment.join(" "));
    };

    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      minRate,
      maxRate,
      periodLabel,
      points,
      collectionLines: lineSegments("collectionY"),
      attemptLines: lineSegments("attemptY"),
      targetY: taxaAttemptTarget == null ? null : yForRate(taxaAttemptTarget),
    };
  }, [language, taxaAttemptTarget, taxaFilteredRecords]);

  const taxaRegionalPoc = useMemo(() => {
    if (!taxaLoaded) return { dates: [] as string[], rows: [] as Array<{ region: string; rgm: string; values: Array<{ orders: number; toCollect: number; withAttempts: number; rate: number | null }>; totalOrders: number }>, total: [] as Array<{ orders: number; toCollect: number; withAttempts: number; rate: number | null }>, totalOrders: 0 };
    const records = taxaFilteredRecords;
    const dates = taxaLoaded.dates
      .filter((date) => date >= taxaDateStart && date <= taxaDateEnd)
      .slice(-TAXA_MAX_PERIOD_DAYS);
    const dateSet = new Set(dates);
    const regionGroups = new Map<string, Map<string, { orders: number; toCollect: number; withAttempts: number }>>();
    for (const record of records) {
      if (!dateSet.has(record.date)) continue;
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
          return { ...value, rate: taxaRate(value.withAttempts, value.toCollect) };
        });
        return {
          region,
          rgm: officialRgmForRegion(region) ?? UNASSIGNED_RGM,
          values,
          totalOrders: values.reduce((sum, value) => sum + value.orders, 0),
        };
      })
      .sort((a, b) => {
        const aLatest = a.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: null };
        const bLatest = b.values.at(-1) ?? { toCollect: 0, withAttempts: 0, rate: null };
        return (
          Number(bLatest.toCollect > 0) - Number(aLatest.toCollect > 0) ||
          (bLatest.rate ?? -1) - (aLatest.rate ?? -1) ||
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
      return { ...value, rate: taxaRate(value.withAttempts, value.toCollect) };
    });
    return { dates, rows, total, totalOrders: total.reduce((sum, value) => sum + value.orders, 0) };
  }, [taxaDateEnd, taxaDateStart, taxaFilteredRecords, taxaLoaded]);

  const taxaRmPoc = useMemo(() => {
    const dates = taxaRegionalPoc.dates;
    const rows = aggregateTaxaRmPoc(taxaFilteredRecords, dates, responsibilityLoaded, dashboardLocale(language));
    return { dates, rows, total: taxaRegionalPoc.total, totalOrders: taxaRegionalPoc.totalOrders };
  }, [language, responsibilityLoaded, taxaFilteredRecords, taxaRegionalPoc]);

  const taxaDailyPeriod = useMemo(() => {
    if (!taxaLoaded) return [] as Array<{ date: string; toCollect: number; withAttempts: number; rate: number | null }>;
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
      return { date, ...value, rate: taxaRate(value.withAttempts, value.toCollect) };
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
    const yForRate = (rate: number | null) => {
      if (rate === null) return null;
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
    const segments: string[][] = [];
    let currentSegment: string[] = [];
    for (const point of points) {
      if (point.y === null) {
        if (currentSegment.length) segments.push(currentSegment);
        currentSegment = [];
      } else {
        currentSegment.push(`${point.x},${point.y}`);
      }
    }
    if (currentSegment.length) segments.push(currentSegment);
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      points,
      lines: segments.map((segment) => segment.join(" ")),
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
        onTimeRate: taxaRate(item.onTime, item.toCollect),
        attemptRate: taxaRate(item.withAttempts, item.toCollect),
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
        averageMeasures: Array<{ toCollect: number; collected: number; averageCollectionHours: number }>;
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
          averageMeasures: [],
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
      current.averageMeasures.push({
        toCollect: record.toCollect,
        collected: record.collected,
        averageCollectionHours: record.averageCollectionHours,
      });
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
        attemptRate: taxaRate(row.withAttempts, row.toCollect),
        onTimeRate: taxaRate(row.onTime, row.toCollect),
        awaitingRate: taxaRate(row.notCollected, row.toCollect),
        latestAttemptRate: taxaRate(row.latestWithAttempts, row.latestToCollect),
        averageHours: legacyTaxaAverageCollectionHours(row.averageMeasures),
      }))
      .filter((row) => {
        if (!normalizedQuery) return true;
        return normalizeSearchText(`${row.base} ${row.region} ${row.origin}`).includes(normalizedQuery);
      });

    return rows.sort((a, b) => {
      return (
        Number(b.latestToCollect > 0) - Number(a.latestToCollect > 0) ||
        (b.latestAttemptRate ?? -1) - (a.latestAttemptRate ?? -1) ||
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
          (b.summary.collectionWithAttemptsRate ?? -1) - (a.summary.collectionWithAttemptsRate ?? -1) ||
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
          (b.summary.collectionWithAttemptsRate ?? -1) - (a.summary.collectionWithAttemptsRate ?? -1) ||
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

  const movementDimensionFilteredRecords = useMemo(() => {
    if (!movementLoaded) return [];
    return movementFilterOptions.filteredRows.filter(
      (record) =>
        movementSelectedAgings.has(record.aging) &&
        movementSelectedStatuses.has(record.status) &&
        movementSelectedOrigins.has(record.origin) &&
        (!record.date || !movementDateStart || record.date >= movementDateStart) &&
        (!record.date || !movementDateEnd || record.date <= movementDateEnd),
    );
  }, [movementDateEnd, movementDateStart, movementFilterOptions.filteredRows, movementLoaded, movementSelectedAgings, movementSelectedOrigins, movementSelectedStatuses]);

  const movementFilteredRecords = useMemo(() => movementLoaded?.format === "summary"
    ? movementDimensionFilteredRecords.map((record) => selectMovementSummaryMetric(record, movementSummaryMetric))
    : movementDimensionFilteredRecords,
  [movementDimensionFilteredRecords, movementLoaded?.format, movementSummaryMetric]);

  const movementSummary = useMemo(() => {
    const summary = summarizeMovementSnapshot(movementDimensionFilteredRecords);
    return {
      ...summary,
      over2Rate: safeRate(summary.over2Days, summary.totalStopped),
    };
  }, [movementDimensionFilteredRecords]);

  const movementAnalysisText = useMemo(() => {
    const regionals = new Map<string, { region: string; volume: number; bases: Map<string, { base: string; rm: string; volume: number }> }>();
    for (const record of movementFilteredRecords) {
      const volume = record.totalStopped > 0 ? record.totalStopped : record.quantity;
      const regional = regionals.get(record.region) ?? { region: record.region, volume: 0, bases: new Map() };
      regional.volume += volume;
      const base = regional.bases.get(record.base) ?? { base: record.base, rm: record.rm, volume: 0 };
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
  }, [movementDateEnd, movementDateStart, movementFilteredRecords, movementSummary.totalStopped]);
  const movementRegionalOver2Summary = useMemo(() => {
    return aggregateMovementByRegion(movementFilteredRecords)
      .sort((a, b) => b.orders - a.orders || a.region.localeCompare(b.region, dashboardLocale(language), { numeric: true }));
  }, [language, movementFilteredRecords]);

  const movementRmOver2Summary = useMemo(() => {
    return aggregateMovementByRm(movementFilteredRecords)
      .sort((a, b) => b.orders - a.orders || a.rmArea.localeCompare(b.rmArea, dashboardLocale(language), { numeric: true }) || a.rm.localeCompare(b.rm, dashboardLocale(language), { numeric: true }));
  }, [language, movementFilteredRecords]);

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
      const key = [record.region, record.base, record.code, record.rmArea, record.rm, record.rgm, record.aging, record.status, record.origin].join("::");
      const current = groups.get(key) ?? {
        period: movementDateStart && movementDateEnd ? `${formatDate(movementDateStart)} a ${formatDate(movementDateEnd)}` : "Todo o período",
        region: record.region,
        base: record.base,
        code: record.code,
        rmArea: record.rmArea,
        rm: record.rm,
        rgm: record.rgm,
        aging: record.aging,
        status: record.status,
        origin: record.origin,
        orders: 0,
      };
      current.orders += record.quantity;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => b.orders - a.orders || a.region.localeCompare(b.region, dashboardLocale(language), { numeric: true }) || a.base.localeCompare(b.base, dashboardLocale(language), { numeric: true }));
  }, [language, movementDateEnd, movementDateStart, movementTableRows]);

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
    if (kind === "rm") {
      setSelectedRms(value);
      setTaxaRmSelection(rmSelectionFromValues(taxaResponsibilityFilterOptions.rms, value));
    }
    else setSelectedRgms(value);

    if (loaded) {
      setSelectedBases(new Set(monitoringBasesForSelection(loaded, selectedRegions, responsibilityLoaded, nextRms, nextRgms)));
      setPage(1);
    }
    if (taxaLoaded) {
      const bases = taxaBasesForRegions(taxaLoaded, taxaSelectedRegions).filter((base) =>
        matchesResponsibility(responsibilityLoaded, base, nextRms, nextRgms));
      setTaxaRmAreaSelection({ mode: "all" });
      setTaxaSelectedBases(new Set(bases));
      setTaxaPage(1);
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
    responsibilityLoaded,
    selectedRegions,
    selectedRgms,
    selectedRms,
    sellerPerformanceLoaded,
    sellerSelectedRegions,
    sellerSelectedTiers,
    taxaLoaded,
    taxaResponsibilityFilterOptions.rms,
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
    const availableCategories = SELLER_CATEGORIES.filter((category) =>
      sellerPerformanceLoaded.records.some((record) => record.tier === category),
    );
    return sellerPerformanceLoaded.records.map((record) =>
      resolveSellerOrganization(record, responsibilityLoaded),
    ).filter(
      (record) =>
        sellerSelectedRegions.has(record.region) &&
        sellerSelectedBases.has(record.base) &&
        sellerCategoryMatches(record.tier, sellerSelectedTiers, availableCategories) &&
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
    if (!sellerReferenceLoaded) return t("J&T");
    const categories = SELLER_CATEGORIES.filter((category) => sellerSelectedTiers.has(category)).map((category) => t(category));
    if (categories.length === 0) return t("Nenhuma categoria");
    return new Intl.ListFormat(dashboardLocale(language), {
      style: "long",
      type: "conjunction",
    }).format(categories);
  }, [language, sellerReferenceLoaded, sellerSelectedTiers, t]);

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
  }, [responsibilityLoaded, sellerFilteredRecords, sellerRowsBySeller]);
  const analysisText = view === "sellers" ? sellerAnalysisText : view === "movimentacao" ? movementAnalysisText : baseAnalysisText;

  const currentPanelShareFilters = () => {
    const line = (label: string, selected: ReadonlySet<string>, options: readonly string[], allLabel: string) =>
      `${t(label)}: ${selectedShareFilter(selected, options, allLabel, t)}`;
    const period = (start: string, end: string) => `${t("Período")}: ${formatPeriod(start, end)}`;
    if (view === "damage") return [
      period(damageDateStart, damageDateEnd),
      line("Regional", damageSelectedRegions, damageRegionOptions, "Todas as regionais"),
      line("RM", damageSelectedRms, damageRmOptions, "Todos os RM"),
      line("RGM", damageSelectedRgms, damageRgmOptions, "Todos os RGM"),
      line("Base", damageSelectedBases, damageBaseOptions, "Todas as bases"),
    ];
    if (view === "bipagem") return [
      period(bipagemDateStart, bipagemDateEnd),
      line("Regional", bipagemSelectedRegions, bipagemRegionOptions, "Todas as regionais"),
      line("RM", bipagemSelectedRms, bipagemRmOptions, "Todos os RM"),
      line("RGM", bipagemSelectedRgms, bipagemRgmOptions, "Todos os RGM"),
      line("Base", bipagemSelectedBases, bipagemBaseOptions, "Todas as bases"),
      ...(bipagemLoaded ? [line("Origem do pedido", bipagemSelectedOrigins, bipagemLoaded.origins, "Todas as origens")] : []),
    ];
    if (view === "movimentacao") return [
      period(movementDateStart, movementDateEnd),
      line("Regional", movementSelectedRegions, movementRegionOptions, "Todas as regionais"),
      line("RM", movementSelectedRms, movementRmOptions, "Todos os RM"),
      line("Região do RM", movementSelectedRmAreas, movementRmAreaOptions, "Todas as regiões do RM"),
      line("Base", movementSelectedBases, movementBaseOptions, "Todas as bases"),
      line("RGM", movementSelectedRgms, movementRgmOptions, "Todos os RGM"),
      ...(movementLoaded ? [
        line("Origem do pedido", movementSelectedOrigins, movementLoaded.origins, "Todas as origens"),
        line("Status", movementSelectedStatuses, movementLoaded.statuses, "Todos os status"),
        line("AGING", movementSelectedAgings, movementLoaded.agings, "Todos os AGING"),
      ] : []),
    ];
    if (view === "sellers") return [
      period(sellerDateStart, sellerDateEnd),
      line("Regional", sellerSelectedRegions, sellerRegionOptions, "Todas as regionais"),
      line("RM", selectedRms, responsibilityFilterOptions.rms, "Todos os RM"),
      line("Região do RM", selectedRgms, responsibilityFilterOptions.rgms, "Todas as regiões do RM"),
      line("Base", sellerSelectedBases, sellerBaseOptions, "Todas as bases"),
      line("Categoria", sellerSelectedTiers, SELLER_CATEGORIES, "Todas as categorias"),
      line("Seller", sellerSelectedSellers, sellerOptionList, "Todos os sellers"),
    ];
    if (view === "epop" && epopLoaded) return [
      period(epopDateStart, epopDateEnd),
      line("Regional", epopSelectedRegions, epopLoaded.regions, "Todas as regionais"),
      line("RM", selectedRms, responsibilityFilterOptions.rms, "Todos os RM"),
      line("Região do RM", selectedRgms, responsibilityFilterOptions.rgms, "Todas as regiões do RM"),
      line("Base", epopSelectedBases, epopLoaded.bases, "Todas as bases"),
    ];
    if (view === "taxa") return [
      period(taxaDateStart, taxaDateEnd),
      line("Regional", taxaSelectedRegions, taxaRegionOptions, "Todas as regionais"),
      line("RM", taxaSelectedRms, taxaResponsibilityFilterOptions.rms, "Todos os RM"),
      line("Região do RM", selectedRgms, responsibilityFilterOptions.rgms, "Todas as regiões do RM"),
      line("Base", taxaSelectedBases, taxaBaseOptions, "Todas as bases"),
      ...(taxaLoaded ? [line("Origem do pedido", taxaSelectedOrigins, taxaLoaded.origins, "Todas as origens")] : []),
      line("Região do RM", taxaSelectedRmAreas, taxaRmAreaOptions, "Todas as regiões do RM"),
    ];
    return [
      period(dateStart, dateEnd),
      line("Regional", selectedRegions, monitoringRegionOptions, "Todas as regionais"),
      line("RM", selectedRms, monitoringResponsibilityFilterOptions.rms, "Todos os RM"),
      line("Região do RM", selectedRgms, monitoringResponsibilityFilterOptions.rgms, "Todas as regiões do RM"),
      line("Base", selectedBases, baseOptions, "Todas as bases"),
      ...(loaded ? [
        line("Origem do pedido", selectedOrigins, loaded.origins, "Todas as origens"),
        line("Status", selectedStatuses, loaded.statuses, "Todos os status"),
      ] : []),
    ];
  };
  const openPanelFeishuShare = async (filterOverride?: string[]) => {
    if (view === "movimentacao") {
      if (!isMatrixAdminViewer || !viewerAuthorization || noMovementV2State.status !== "ready" || noMovementV2State.identityKey !== dashboardCacheIdentity || !noMovementV2State.publicationId) return;
      setNoMovementFeishuDialogOpen(true);
      return;
    }
    if (view === "taxa") {
      if (!canShowCollectionRateFeishuButton || !viewerAuthorization || collectionRateV2State.status !== "ready" || !collectionRateV2State.publicationId) return;
      setOperationalFeishuSource("collection_rate");
      return;
    }
    if (view === "bipagem") {
      if (!canShowPddFeishuButton || !viewerAuthorization || !pddDataAuthorized || pddCollectionFailureV2State.status !== "ready" || !pddCollectionFailureV2State.publicationId) return;
      setOperationalFeishuSource("pdd_collection_failure");
      return;
    }
    const panelTitle = dashboardCards.find((card) => card.id === view)?.title ?? "Monitoramento de coleta";
    const panelContent = analysisText;
    const contentAvailable = ["taxa", "movimentacao", "sellers", "bipagem"].includes(view) && Boolean(panelContent.trim());
    setFeishuSharePreview({
      title: t(panelTitle),
      filters: filterOverride ?? currentPanelShareFilters(),
      content: contentAvailable ? panelContent : "",
      contentAvailable,
    });
  };
  const reportGeneratedAt = formatDateTime(new Date().toISOString());
  const handlePrintReport = () => {
    window.setTimeout(() => window.print(), 30);
  };
  const activeDataSourceId = SOURCE_ID_BY_VIEW[view];
  const activeDataSourceConfig = activeDataSourceId ? DASHBOARD_DATA_SOURCES[activeDataSourceId] : null;
  const canManageActiveDataSource = isMatrixAdminViewer && activeDataSourceConfig?.configured === true && !(view === "monitoramento" && isMatrixAdminViewer) && view !== "movimentacao" && view !== "bipagem";
  const noMovementDataAuthorized = noMovementV2State.identityKey === dashboardCacheIdentity;
  const noMovementHasPublishedRecords = noMovementDataAuthorized && noMovementV2State.records.length > 0;
  const noMovementHasPreviousRecords = noMovementHasPublishedRecords && (noMovementV2State.status === "loading" || noMovementV2State.status === "error");
  const noMovementAvailabilityText = noMovementAvailabilityMessage(noMovementV2State.status, noMovementV2State.publicationId);
  const noMovementV2Diagnostic = isMatrixAdminViewer ? (
    <section className="filters-card taxa-filters-card" aria-label={t("Status da fonte oficial Sem Movimentação")} data-testid="no-movement-v2-diagnostic">
      <div className="filters-card-top">
        <div>
          <span className="card-eyebrow">{t("FONTE OFICIAL · DATA FOUNDATION V2")}</span>
          <p>{t("Indicadores, filtros e tabelas utilizam exclusivamente o snapshot JMS vigente.")}</p>
        </div>
      </div>
      <div
        className={`filter-summary${noMovementV2State.status === "error" ? " invalid" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span><strong>{t("Status V2:")}</strong> {t(noMovementAvailabilityText)}</span>
        <span><strong>{t("Registros recebidos:")}</strong> {noMovementV2State.status === "ready" || (noMovementV2State.status === "empty" && noMovementV2State.publicationId) || noMovementHasPreviousRecords ? formatNumber(noMovementV2State.receivedCount) : "—"}</span>
        <span><strong>{t("Colunas:")}</strong> {noMovementV2State.columnCount > 0 ? formatNumber(noMovementV2State.columnCount) : "—"}</span>
        <span><strong>{t("Publicação:")}</strong> {noMovementV2State.publicationId ?? "—"}</span>
        <span><strong>{t("Data da coleta:")}</strong> {noMovementV2State.collectionDate ? formatDate(noMovementV2State.collectionDate) : "—"}</span>
        <span><strong>{t("Executada em:")}</strong> {noMovementV2State.updatedAt ? formatDateTime(noMovementV2State.updatedAt) : "—"}</span>
        <span><strong>{t("Publicada em:")}</strong> {noMovementV2State.publishedAt ? formatDateTime(noMovementV2State.publishedAt) : "—"}</span>
        {noMovementV2State.error ? <span>{t(noMovementV2State.error)}</span> : null}
      </div>
    </section>
  ) : null;
  const pddCollectionFailureV2Diagnostic: ReactNode = null;
  const jtMonitoringV2Diagnostic = isMatrixAdminViewer ? (
    <section className="filters-card taxa-filters-card" aria-label={t("Diagnóstico temporário da Data Foundation V2")} data-testid="jt-monitoring-v2-diagnostic">
      <div className="filters-card-top">
        <div>
          <span className="card-eyebrow">{t("DIAGNÓSTICO TEMPORÁRIO · DATA FOUNDATION V2")}</span>
          <p>{t("Fonte oficial jt_monitoring. A conexão valida a publicação e conta o período; os registros ainda não alimentam indicadores, gráficos ou tabelas.")}</p>
        </div>
      </div>
      <div className="filter-grid taxa-filter-grid">
        <div className="filter-field date-field">
          <label className="filter-label" htmlFor="jt-v2-date-start">{t("Data inicial")}</label>
          <div className="date-input-wrap">
            <CalendarDays size={16} />
            <input
              id="jt-v2-date-start"
              type="date"
              value={jtMonitoringV2State.period.dateFrom}
              onChange={(event) => {
                const dateFrom = event.target.value;
                jtMonitoringV2RequestRef.current?.abort();
                jtMonitoringV2RequestRef.current = null;
                setJtMonitoringV2State((current) => ({
                  ...current,
                  status: "idle",
                  loading: false,
                  period: {
                    dateFrom,
                    dateTo: !current.period.dateTo || current.period.dateTo < dateFrom ? dateFrom : current.period.dateTo,
                  },
                  records: [],
                  totalAvailable: 0,
                  loadedCount: 0,
                  publicationId: null,
                  publicationIds: [],
                  publishedAt: null,
                  dateCountsSignature: null,
                  error: null,
                }));
              }}
            />
          </div>
        </div>
        <div className="filter-field date-field">
          <label className="filter-label" htmlFor="jt-v2-date-end">{t("Data final")}</label>
          <div className="date-input-wrap">
            <CalendarDays size={16} />
            <input
              id="jt-v2-date-end"
              type="date"
              value={jtMonitoringV2State.period.dateTo}
              min={jtMonitoringV2State.period.dateFrom || undefined}
              onChange={(event) => {
                const dateTo = event.target.value;
                jtMonitoringV2RequestRef.current?.abort();
                jtMonitoringV2RequestRef.current = null;
                setJtMonitoringV2State((current) => ({
                  ...current,
                  status: "idle",
                  loading: false,
                  period: {
                    dateFrom: current.period.dateFrom || dateTo,
                    dateTo,
                  },
                  records: [],
                  totalAvailable: 0,
                  loadedCount: 0,
                  publicationId: null,
                  publicationIds: [],
                  publishedAt: null,
                  dateCountsSignature: null,
                  error: null,
                }));
              }}
            />
          </div>
        </div>
      </div>
      <div
        className={`filter-summary${jtMonitoringV2State.status === "error" ? " invalid" : ""}`}
        role={jtMonitoringV2State.status === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        <span><strong>{t("Status V2:")}</strong> {jtMonitoringV2State.status === "idle"
          ? t("Aguardando consulta")
          : jtMonitoringV2State.status === "loading"
            ? t("Consultando publicação vigente…")
            : jtMonitoringV2State.status === "ready"
              ? t("Conexão ativa")
              : jtMonitoringV2State.status === "empty"
                ? jtMonitoringV2State.error
                  ? t("Sem publicação vigente")
                  : t("Publicado, sem registros no período")
                : t("Consulta V2 indisponível")}</span>
        <span><strong>{t("Período:")}</strong> {jtMonitoringV2State.period.dateFrom || "—"} a {jtMonitoringV2State.period.dateTo || "—"}</span>
        <span><strong>{t("Total disponível:")}</strong> {jtMonitoringV2State.status === "ready" || jtMonitoringV2State.status === "empty" ? formatNumber(jtMonitoringV2State.totalAvailable) : "—"}</span>
        <span><strong>{t("Carregados:")}</strong> {formatNumber(jtMonitoringV2State.loadedCount)}</span>
        <span><strong>{t("Colunas:")}</strong> {formatNumber(jtMonitoringV2State.columnCount)}</span>
        {jtMonitoringV2State.publicationId ? <span><strong>{t("Publicação mais recente:")}</strong> {jtMonitoringV2State.publicationId}</span> : null}
        {jtMonitoringV2State.publicationIds.length ? <span><strong>{t("Publicações nas linhas carregadas:")}</strong> {jtMonitoringV2State.publicationIds.join(", ")}</span> : null}
        {jtMonitoringV2State.publishedAt ? <span><strong>{t("Publicada em:")}</strong> {formatDateTime(jtMonitoringV2State.publishedAt)}</span> : null}
        {jtMonitoringV2State.loading && jtMonitoringV2State.loadedCount > 0 ? <span>{t("Carregando próxima página; os dados já carregados permanecem visíveis.")}</span> : null}
        {jtMonitoringV2State.error ? <span>{t(jtMonitoringV2State.error)}</span> : null}
        {jtMonitoringV2State.totalAvailable > JT_MONITORING_V2_MAX_PREVIEW_ROWS && jtMonitoringV2State.loadedCount >= JT_MONITORING_V2_MAX_PREVIEW_ROWS
          ? <span>{t("Limite temporário de {count} registros atingido.", { count: formatNumber(JT_MONITORING_V2_MAX_PREVIEW_ROWS) })}</span>
          : null}
      </div>
      <div className="table-detail-actions">
        <small>{t("A consulta inicial carrega no máximo 250 linhas. Páginas adicionais são manuais e limitadas a 1.000 linhas nesta homologação.")}</small>
        {jtMonitoringV2State.loadedCount < jtMonitoringV2State.totalAvailable && jtMonitoringV2State.loadedCount < JT_MONITORING_V2_MAX_PREVIEW_ROWS ? (
          <button
            className="reset-button"
            type="button"
            onClick={() => void loadMoreJtMonitoringV2()}
            disabled={jtMonitoringV2State.loading || (jtMonitoringV2State.status !== "ready" && !(jtMonitoringV2State.status === "error" && jtMonitoringV2State.loadedCount > 0))}
          >
            {jtMonitoringV2State.loading ? t("Carregando…") : jtMonitoringV2State.status === "error" ? t("Tentar próxima página (250)") : t("Carregar próxima página (250)")}
          </button>
        ) : null}
      </div>
    </section>
  ) : null;
  const dashboardActionBand = (
    <DashboardActionBand
      reportDate={reportGeneratedAt}
        demoMode={view !== "movimentacao" && LOCAL_DASHBOARD_DEMO_MODE && !(
        (view === "monitoramento" && loaded?.sourceType === "MANUAL_UPLOAD") ||
        (view === "taxa" && taxaLoaded?.sourceType === "MANUAL_UPLOAD")
      )}
      onPrint={handlePrintReport}
      onAnalysis={() => { setAnalysisCopied(false); setAnalysisOpen(true); }}
      onShare={openPanelFeishuShare}
      showShare={view !== "taxa" || canShowCollectionRateFeishuButton}
      onDataSource={view !== "taxa" && canManageActiveDataSource && activeDataSourceId ? () => setDataSourceDialogId(activeDataSourceId) : undefined}
      sourceLabel={view === "taxa" && taxaLoaded?.sourceType === "MANUAL_UPLOAD" ? taxaLoaded.fileName : undefined}
      t={t}
    />
  );

  const dataSourceDataset = view === "monitoramento" ? loaded
    : view === "taxa" ? taxaLoaded
      : view === "epop" ? epopLoaded
        : view === "movimentacao" ? movementLoaded
          : view === "sellers" ? sellerPerformanceLoaded
            : view === "bipagem" ? null
              : view === "damage" ? damageLoaded
                : null;
  const dataSourceSummary: DataSourceSummary | null = view === "bipagem" ? {
    sourceType: "DATA_FOUNDATION_V2",
    fileName: "falha_coleta.xlsx",
    updatedAt: pddCollectionFailureV2State.updatedAt ?? undefined,
    rowCount: pddCollectionFailureV2State.receivedCount,
    period: { start: pddCollectionFailureV2State.period.dateFrom, end: pddCollectionFailureV2State.period.dateTo },
  } : view === "sellers" && sellerManualSource ? {
    sourceType: "MANUAL_UPLOAD",
    fileName: sellerManualSource.fileName,
    fileSizeBytes: sellerManualSource.fileSizeBytes,
    contentType: sellerManualSource.contentType,
    updatedAt: sellerManualSource.importedAt,
    rowCount: sellerManualSource.rowCount,
    period: sellerManualSource.period ?? undefined,
  } : dataSourceDataset ? {
    sourceType: "sourceType" in dataSourceDataset && dataSourceDataset.sourceType
      ? dataSourceDataset.sourceType
      : dataSourceDataset.fileName === DEMO_WORKBOOK_NAME ? "DEMONSTRATION" : "MANUAL_UPLOAD",
    fileName: dataSourceDataset.fileName,
    fileSizeBytes: "fileSizeBytes" in dataSourceDataset ? dataSourceDataset.fileSizeBytes : undefined,
    contentType: "contentType" in dataSourceDataset ? dataSourceDataset.contentType : undefined,
    updatedAt: dataSourceDataset.updatedAt,
    rowCount: dataSourceDataset.parsed.rows.length,
    period: dataSourceDataset.parsed.metadata.dateRange
      ? { start: dataSourceDataset.parsed.metadata.dateRange.min, end: dataSourceDataset.parsed.metadata.dateRange.max }
      : undefined,
  } : null;

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
        monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rm,
        monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rgm,
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
        t("Região do RM"), "RM", "RGM",
        t("Total de pedidos sem movimentação"),
      ];
      const detailRows: ExcelExportValue[][] = movementTableRows.map((row) => [
        ...movementLoaded.displayColumns.map((column) => noMovementSourceExcelValue(row.values[column], column)),
        row.rmArea,
        row.rm,
        row.rgm,
        row.quantity,
      ]);
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
              18, 34, 34, 26,
            ],
            percentageColumns: [],
            performanceColumn: -1,
            targetRate: null,
            totalMergeEndColumn: detailHeaders.length - 2,
            columnNumberFormats: [
              ...movementLoaded.displayColumns.map(noMovementSourceExcelNumberFormat),
              undefined, undefined, undefined, undefined,
            ],
          },
        ],
        summaryFormat ? "sem_movimentacao_resumo_atual.xlsx" : `sem_movimentacao_consolidado_${movementDateStart || "inicio"}_${movementDateEnd || "fim"}.xlsx`,
      );
    } catch {
      setError(t("Não foi possível gerar o arquivo Excel."));
    }
  }, [movementConsolidatedRows, movementDateEnd, movementDateStart, movementLoaded, movementRegionalOver2Summary, movementRmOver2Summary, movementSummary.totalStopped, movementSummaryMetric, movementTableRows, t]);

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
  const sellerRmAwaitingSummary = useMemo(
    () => summarizeAwaitingByBaseAndRm(sellerFilteredRecords),
    [sellerFilteredRecords],
  );
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
  const monitoringResponsibilityFiltersAreDefault =
    selectedRms.size === monitoringResponsibilityFilterOptions.rms.length &&
    selectedRgms.size === monitoringResponsibilityFilterOptions.rgms.length;
  const filtersAreDefault = Boolean(
    loaded &&
      selectedBases.size === baseOptions.length &&
      selectedRegions.size === monitoringRegionOptions.length &&
      selectedOrigins.size === loaded.origins.length &&
      selectedMonitoringMetrics.size === MONITORING_METRIC_OPTIONS.length &&
      monitoringResponsibilityFiltersAreDefault &&
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
      taxaRmAreaSelection.mode === "all" &&
      taxaRmSelection.mode === "all" &&
      selectedRgms.size === responsibilityFilterOptions.rgms.length &&
      taxaDateStart === taxaLoaded.initialStart &&
      taxaDateEnd === taxaLoaded.initialEnd,
  );
  const movementFiltersAreDefault = Boolean(
    movementSummaryMetric === "totalStopped" &&
    movementLoaded &&
      movementSelectedBases.size === movementBaseOptions.length &&
      movementSelectedRegions.size === movementRegionOptions.length &&
      movementSelectedRms.size === movementRmOptions.length &&
      movementSelectedRmAreas.size === movementRmAreaOptions.length &&
      movementSelectedRgms.size === movementRgmOptions.length &&
      movementSelectedAgings.size === movementLoaded.agings.length &&
      movementSelectedStatuses.size === movementLoaded.statuses.length &&
      movementSelectedOrigins.size === movementLoaded.origins.length &&
      movementDateStart === movementLoaded.initialStart &&
      movementDateEnd === movementLoaded.initialEnd,
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
  const taxaGeneralTrendPanel = (
    <div className="general-rate-trend-block taxa-general-aligned-panel">
      <div className="critical-bases-heading">
        <div>
          <span className="card-eyebrow">{t("RESULTADO GERAL")}</span>
          <h3>{t("Taxa de coleta x taxa com tentativa")}</h3>
        </div>
        <span>{t("Período {period}", { period: taxaGeneralMonthlyTrend.periodLabel })}</span>
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
              {taxaGeneralMonthlyTrend.collectionLines.map((points, index) => <polyline key={`collection-${index}`} className="general-rate-line collection" points={points} />)}
              {taxaGeneralMonthlyTrend.attemptLines.map((points, index) => <polyline key={`attempt-${index}`} className="general-rate-line attempt" points={points} />)}
              {taxaGeneralMonthlyTrend.points.map((point) => (
                <g key={point.monthKey}>
                  <text className="general-rate-x-label" x={point.x} y={taxaGeneralMonthlyTrend.height - 12}>
                    {point.monthLabel}
                  </text>
                  {point.collectionY === null ? <text className="general-rate-value-label collection" x={point.x} y={taxaGeneralMonthlyTrend.height - taxaGeneralMonthlyTrend.bottom - 4} textAnchor="middle">—</text> : (
                    <>
                      <circle className="general-rate-point collection" cx={point.x} cy={point.collectionY} r="4.5"><title>{`${t("Taxa de coleta")}: ${formatTaxaRate(point.onTimeRate)}`}</title></circle>
                      <text className="general-rate-value-label collection" x={point.x} y={Math.max(12, point.collectionY - 10)} textAnchor="middle">{formatTaxaRate(point.onTimeRate)}</text>
                    </>
                  )}
                  {point.attemptY === null ? <text className="general-rate-value-label attempt" x={point.x} y={taxaGeneralMonthlyTrend.height - taxaGeneralMonthlyTrend.bottom + 12} textAnchor="middle">—</text> : (
                    <>
                      <circle className="general-rate-point attempt" cx={point.x} cy={point.attemptY} r="4.5"><title>{`${t("Taxa com tentativa")}: ${formatTaxaRate(point.attemptRate)}`}</title></circle>
                      <text className="general-rate-value-label attempt" x={point.x} y={Math.min(taxaGeneralMonthlyTrend.height - taxaGeneralMonthlyTrend.bottom + 18, point.attemptY + 16)} textAnchor="middle">{formatTaxaRate(point.attemptRate)}</text>
                    </>
                  )}
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

  if (viewerAuthState === "CHECKING") {
    return <PresentationAuthTransition error={null} loading={viewerAuthLoading} onRetry={retryViewerSessionCheck} onFeishuLogin={startFeishuLogin} />;
  }

  if (viewerAuthState === "ERROR") {
    return <PresentationAuthTransition error={viewerAuthError} loading={viewerAuthLoading} onRetry={retryViewerSessionCheck} onFeishuLogin={startFeishuLogin} />;
  }

  if (viewerAuthState === "UNAUTHENTICATED") {
    return (
      <PresentationLogin
        error={viewerAuthError ? t(viewerAuthError) : null}
        loading={viewerAuthLoading}
        onFeishuLogin={startFeishuLogin}
      />
    );
  }

  if (!viewerAuthorization || !viewerIdentity) {
    return <PresentationAuthTransition
      error="A sessão não foi confirmada corretamente. Tente verificar novamente."
      loading={viewerAuthLoading}
      onRetry={retryViewerSessionCheck}
      onFeishuLogin={startFeishuLogin}
    />;
  }

  const pendingLastMilePanel = view === "home"
    ? undefined
    : dashboardCards.find((card) => card.id === view && card.category === "last-mile");

  return (
    <div className="app-shell" data-viewer-role={viewerIdentity.role} data-theme={theme}>
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

      <header className="presentation-home-header">
        <div className="presentation-home-header-inner">
          <div className="presentation-brand-lockup">
            <img src="/jnt-logo.png" alt="J&T Express" width={375} height={50} fetchPriority="high" />
            <span className="presentation-brand-separator" aria-hidden="true" />
            <strong className="presentation-brand-name">NEW BI</strong>
          </div>
          <div className="presentation-header-actions">
            <LanguageSwitcher language={language} onChange={changeLanguage} t={t} />
            <UserProfileMenu
              identity={viewerIdentity}
              canManageDataSources={isMatrixAdminViewer}
              canManageUsers={viewerIdentity.can_manage_users === true}
              theme={theme}
              onToggleTheme={toggleTheme}
              onOpenDataSources={() => { setView("data-foundation"); setShowUserControl(false); }}
              onOpenUserControl={() => { setView("home"); setShowUserControl(true); }}
              onSignOut={endViewerSession}
              t={t}
            />
          </div>
        </div>
      </header>

      {viewerAuthorization && viewerDataAccessBlocked && viewerIdentity?.organizational_scope !== "unknown" ? (
        <section className="dashboard-source-availability unavailable" role="alert" data-testid="operational-data-access-revoked">
          <p>{t("A autorização dos dados operacionais foi negada. Sua sessão continua ativa; solicite a verificação das permissões.")}</p>
        </section>
      ) : null}

      {viewerAuthorization &&
      viewerIdentity.organizational_scope === "unknown" &&
      !viewerIdentity.effective_regions?.length &&
      (view === "home" || !isFirstMileUnderReview) ? (
        <section className="dashboard-source-availability unavailable" role="status" data-testid="regional-access-pending">
          <p>{regionalAccessPendingMessage}</p>
        </section>
      ) : null}

      {view !== "home" || showUserControl ? (
        <div className="dashboard-back-row">
          <button className="dashboard-back-link" type="button" onClick={() => { setView("home"); setShowUserControl(false); }}>
            <ArrowLeft size={17} /> {t("Voltar para o início")}
          </button>
        </div>
      ) : null}

      {analysisOpen ? (
        <div className="upload-login-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAnalysisOpen(false); }}>
          <div className={`upload-login-dialog${view === "movimentacao" || view === "taxa" ? " no-movement-analysis-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="analysis-title">
            <button type="button" className="upload-login-close" onClick={() => setAnalysisOpen(false)} aria-label={t("Fechar")}><X size={18} /></button>
            <span className="upload-login-icon"><Sparkles size={24} /></span>
            <h2 id="analysis-title">{t("Análise IA")}</h2>
            <p>{t(view === "movimentacao" ? "Análise operacional da última publicação" : view === "taxa" ? "Análise operacional da última publicação" : view === "bipagem" ? "Análise operacional da última publicação" : "Mensagem criada com os filtros e o período atualmente selecionados.")}</p>
            {view === "movimentacao" ? (
              viewerIdentity?.organizational_scope === "matrix" && viewerIdentity?.role === "matrix" && viewerAuthorization
                ? <NoMovementOperationalAnalysis authorization={viewerAuthorization} t={t} />
                : <p className="no-movement-analysis-access" role="status">{t("A análise operacional nacional está disponível somente para o escopo MATRIZ.")}</p>
            ) : view === "taxa" ? (
              viewerIdentity?.organizational_scope === "matrix" && viewerIdentity?.role === "matrix" && viewerAuthorization
                ? <CollectionRateOperationalAnalysis authorization={viewerAuthorization} t={t} />
                : <p className="no-movement-analysis-access" role="status">{t("A análise operacional nacional está disponível somente para o escopo MATRIZ.")}</p>
            ) : view === "bipagem" ? (
              viewerIdentity?.organizational_scope === "matrix" && viewerIdentity?.role === "matrix" && viewerAuthorization
                ? <PddCollectionFailureOperationalAnalysis authorization={viewerAuthorization} t={t} />
                : <p className="no-movement-analysis-access" role="status">{t("A análise operacional nacional está disponível somente para o escopo MATRIZ.")}</p>
            ) : <textarea readOnly value={analysisText} aria-label={t("Mensagem para grupo")} style={{ minHeight: 260, width: "100%", resize: "vertical" }} />}
            <div className="upload-login-actions">
              <button type="button" onClick={() => setAnalysisOpen(false)}>{t("Fechar")}</button>
              {view !== "movimentacao" && view !== "taxa" && view !== "bipagem" ? <button type="button" onClick={() => { void navigator.clipboard.writeText(analysisText); setAnalysisCopied(true); }}><Copy size={16} /> {t(analysisCopied ? "Copiado" : "Copiar mensagem")}</button> : null}
            </div>
          </div>
        </div>
      ) : null}

      <FeishuShareDialog preview={feishuSharePreview} onClose={() => setFeishuSharePreview(null)} t={t} />
      {noMovementFeishuDialogOpen && noMovementV2State.status === "ready" && noMovementV2State.identityKey === dashboardCacheIdentity && noMovementV2State.publicationId && viewerAuthorization && isMatrixAdminViewer ? (
        <NoMovementFeishuReportDialog
          key={noMovementV2State.publicationId}
          publicationId={noMovementV2State.publicationId}
          authorization={viewerAuthorization}
          t={t}
          onClose={() => setNoMovementFeishuDialogOpen(false)}
        />
      ) : null}
      {operationalFeishuSource && viewerAuthorization && isEffectiveMatrixAdminViewer &&
        (operationalFeishuSource === "collection_rate" ? canShowCollectionRateFeishuButton : canShowPddFeishuButton) ? (
        <OperationalFeishuReportDialog
          key={`${operationalFeishuSource}:${operationalFeishuSource === "collection_rate" ? collectionRateV2State.publicationId : pddCollectionFailureV2State.publicationId}`}
          sourceId={operationalFeishuSource}
          publicationId={operationalFeishuSource === "collection_rate" ? collectionRateV2State.publicationId ?? "" : pddCollectionFailureV2State.publicationId ?? ""}
          authorization={viewerAuthorization}
          t={t}
          onClose={() => setOperationalFeishuSource(null)}
        />
      ) : null}
      {responsibilitySourceDialogOpen ? <ResponsibilitySourceDialog
        onClose={() => {
          setResponsibilitySourceDialogOpen(false);
          if (responsibilityRefreshPending) window.location.reload();
        }}
        onPublished={() => setResponsibilityRefreshPending(true)}
        formatDateTime={formatDateTime}
        formatNumber={formatNumber}
        t={t}
      /> : null}
      {dataSourceDialogId ? <DataSourceDialog
        config={DASHBOARD_DATA_SOURCES[dataSourceDialogId]}
        currentSource={dataSourceSummary}
        canManage={isMatrixAdminViewer}
        onClose={() => setDataSourceDialogId(null)}
        onImported={(source: ManualDataSource) => {
          try {
            if (dataSourceDialogId === "monitoring") {
              applyLoadedData(
                buildLoadedData(source.parsed, source.fileName, source.importedAt, "MANUAL_UPLOAD", source.fileSizeBytes, source.contentType),
                responsibilityLoaded,
              );
            } else if (dataSourceDialogId === "taxa") {
              applyTaxaLoadedData(
                buildTaxaLoadedData(source.parsed, source.fileName, source.importedAt, "MANUAL_UPLOAD", source.fileSizeBytes, source.contentType),
              );
              setView("taxa");
            } else if (dataSourceDialogId === "sellerPerformance") {
              setSellerManualSource(source);
              applySellerPerformanceLoadedData(
                buildSellerPerformanceData(source.parsed, sellerReferenceLoaded, source.fileName, source.importedAt, responsibilityLoaded),
                responsibilityLoaded,
              );
              setSellerDependencyMessage(sellerReferenceLoaded
                ? null
                : "A lista oficial de sellers não está publicada neste ambiente. As categorias não serão inferidas do XLSX J&T.");
              setView("sellers");
            }
            setError(null);
          } catch {
            setError("data_source_import_invalid");
          }
        }}
        onRemoved={() => {
          if (dataSourceDialogId === "monitoring") {
            if (LOCAL_DASHBOARD_DEMO_MODE && viewerIdentity) {
              const fixture = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES.monitoring, viewerIdentity);
              applyLoadedData(buildLoadedData(fixture, DEMO_WORKBOOK_NAME, "2026-09-23T12:00:00.000Z", "DEMONSTRATION"), responsibilityLoaded);
            } else setLoaded(null);
          } else if (dataSourceDialogId === "taxa") {
            if (LOCAL_DASHBOARD_DEMO_MODE && viewerIdentity) {
              const fixture = scopeDemoWorkbook(DASHBOARD_DEMO_FIXTURES.taxa, viewerIdentity);
              applyTaxaLoadedData(
                buildTaxaLoadedData(fixture, DEMO_WORKBOOK_NAME, "2026-09-23T12:00:00.000Z", "DEMONSTRATION"),
              );
            } else setTaxaLoaded(null);
          } else if (dataSourceDialogId === "sellerPerformance") {
            setSellerManualSource(null);
            setSellerPerformanceLoaded(null);
          }
        }}
        formatDateTime={formatDateTime}
        t={t}
      /> : null}

      <main
        className={view === "home" ? "dashboard-main dashboard-main-presentation-home" : isFirstMileUnderReview && view !== "monitoramento" && view !== "movimentacao" && view !== "bipagem" && view !== "taxa" ? "dashboard-main dashboard-main-under-development" : view === "sellers" ? "dashboard-main dashboard-main-sellers" : view === "movimentacao" ? "dashboard-main dashboard-main-movement" : view === "taxa" && isAuthorizedDashboardViewer ? "dashboard-main dashboard-main-taxa-v2" : view === "monitoramento-t4-t5" && isAuthorizedDashboardViewer ? "dashboard-main dashboard-main-t4-t5" : "dashboard-main"}
        data-testid={view === "movimentacao" ? "no-movement-v2-dashboard" : view === "bipagem" ? "pdd-collection-failure-v2-dashboard-shell" : view === "monitoramento-t4-t5" ? "collection-monitoring-t4-t5-dashboard" : undefined}
        data-v2-source={view === "movimentacao" && isAuthorizedDashboardViewer ? "no_movement" : view === "taxa" && isAuthorizedDashboardViewer ? "collection_rate" : view === "bipagem" && isAuthorizedDashboardViewer ? "pdd_collection_failure" : view === "monitoramento-t4-t5" && isAuthorizedDashboardViewer ? "collection_monitoring_t4_t5" : undefined}
        data-v2-status={view === "movimentacao" && isAuthorizedDashboardViewer ? noMovementV2State.status : view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.status : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.status : undefined}
        data-v2-period-start={view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.period.dateFrom : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.period.dateFrom : undefined}
        data-v2-period-end={view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.period.dateTo : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.period.dateTo : undefined}
        data-v2-record-count={view === "movimentacao" && isAuthorizedDashboardViewer ? noMovementV2State.receivedCount : view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.receivedCount : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.receivedCount : undefined}
        data-v2-column-count={view === "movimentacao" && isAuthorizedDashboardViewer ? noMovementV2State.columnCount : view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.columnCount : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.columnCount : undefined}
        data-v2-updated-at={view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.snapshotAsOf ?? undefined : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.updatedAt ?? undefined : undefined}
        data-v2-error={view === "movimentacao" && isAuthorizedDashboardViewer ? noMovementV2State.error ?? undefined : view === "taxa" && isAuthorizedDashboardViewer ? collectionRateV2State.error ?? undefined : view === "bipagem" && isAuthorizedDashboardViewer ? pddCollectionFailureV2State.error ?? undefined : undefined}
      >
        {isFirstMileUnderReview && !isAuthorizedDashboardViewer ? (
          <section className="dashboard-source-availability unavailable" role="alert" data-testid="regional-data-access-pending">
            <div className="dashboard-intro">
              <div><div className="eyebrow"><ShieldCheck size={15} /> {t("Acesso aos dados operacionais")}</div><h1>{dashboardCards.find((card) => card.id === view)?.title ?? t("Painel")}</h1></div>
            </div>
            <p>{regionalAccessPendingMessage}</p>
          </section>
        ) : view === "home" ? (
          showUserControl && viewerIdentity.can_manage_users === true ? <UserControl t={t} /> : <AssistantHome t={t} onSelect={(nextView) => {
            setError(null);
            setView(nextView);
            setShowUserControl(false);
          }} />
        ) : view === "data-foundation" ? (
          isMatrixAdminViewer ? <DataFoundationAdmin
            t={t}
            canImport={isMatrixAdminViewer}
          /> : <section className="dashboard-source-availability unavailable" role="alert" data-testid="matrix-administration-restricted">
            <p>{t("A administração das fontes compartilhadas exige autorização administrativa de matriz.")}</p>
          </section>
        ) : view === "monitoramento-t4-t5" ? (
          <CollectionMonitoringT4T5Dashboard key={dashboardCacheIdentity} t={t} language={language} scopeKey={dashboardCacheIdentity} />
        ) : isFirstMileUnderReview && view !== "monitoramento" && view !== "movimentacao" && view !== "bipagem" && view !== "taxa" ? (
          <DashboardUnderDevelopment
            title={dashboardCards.find((card) => card.id === view)?.title ?? t("Painel em desenvolvimento")}
            description={dashboardCards.find((card) => card.id === view)?.description ?? ""}
            sourceId={DASHBOARD_V2_SOURCE_BY_PANEL[view as DashboardPanel] ?? ""}
            availability={currentDashboardAvailability}
            t={t}
          />
        ) : pendingLastMilePanel ? (
          <PendingLastMileDashboard
            title={pendingLastMilePanel.title}
            onOpenSource={() => setDataSourceDialogId(SOURCE_ID_BY_VIEW[view] ?? null)}
            canManageSource={isMatrixAdminViewer}
            t={t}
          />
        ) : view === "damage" ? (
          !damageLoaded ? (
            <EmptyDashboardPanel loading={damageLoading} error={error} canManageUpload={isMatrixAdminViewer} onDrop={(file) => queueUpload({ kind: "damage", files: [file] })} inputId="damage-upload" t={t} />
          ) : (
            <>
              <section className="dashboard-intro">
                <div><div className="eyebrow"><CircleAlert size={15} /> {t("QUALIDADE OPERACIONAL")}</div><h1><BilingualText language={language} source="Extravio" /></h1><p>{t("Pedidos avariados e extraviados, valor de arbitragem em reais, responsáveis, bases, origem e principais motivos.")}</p></div>
                <div className="dataset-meta"><span><Layers3 size={16} /> {t("{count} linhas", { count: formatNumber(damageRecords.length) })}</span><span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(damageRegionOptions.length) })}</span><span><Database size={16} /> {t("{count} bases", { count: formatNumber(damageBaseOptions.length) })}</span><span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(damageLoaded.updatedAt) })}</span></div>
              </section>
              {dashboardActionBand}
              {error ? <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{t(error)}</span><button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button></div> : null}
              <section className="filters-card taxa-filters-card" aria-labelledby="damage-filters-heading"><div className="filters-card-top"><div><h2 id="damage-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2><p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p></div><button type="button" className="reset-button" onClick={() => applyDamageLoadedData(damageLoaded, responsibilityLoaded)}><RotateCcw size={15} /> {t("Limpar filtros")}</button></div><div className="filter-grid damage-filter-grid">
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
          !isAuthorizedDashboardViewer ? (
            <section className="dashboard-source-availability unavailable" role="alert" data-testid="pdd-v2-restricted">
              <div className="dashboard-intro"><div><div className="eyebrow"><CircleAlert size={15} /> {t("QUALIDADE DA COLETA")}</div><h1>{t("Falha na coleta PDD")}</h1></div></div>
              <p>{t("Aguardando liberação do acesso operacional pela administração.")}</p>
            </section>
          ) : (
            <PddCollectionFailureV2Dashboard
              status={pddDataAuthorized ? pddCollectionFailureV2State.status : "loading"}
              records={pddDataAuthorized ? pddCollectionFailureV2State.records : []}
              period={pddCollectionFailureV2State.period}
              receivedCount={pddDataAuthorized ? pddCollectionFailureV2State.receivedCount : 0}
              error={pddDataAuthorized ? pddCollectionFailureV2State.error : null}
              publicationId={pddDataAuthorized ? pddCollectionFailureV2State.publicationId : null}
              publicationIds={pddDataAuthorized ? pddCollectionFailureV2State.publicationIds : []}
              updatedAt={pddDataAuthorized ? pddCollectionFailureV2State.updatedAt : null}
              publishedAt={pddDataAuthorized ? pddCollectionFailureV2State.publishedAt : null}
              dataPeriod={pddDataAuthorized ? pddCollectionFailureV2State.dataPeriod : null}
              progress={pddDataAuthorized ? pddCollectionFailureV2State.progress : { loaded: 0, total: 0 }}
              reportDate={reportGeneratedAt}
              onPrint={handlePrintReport}
              onAnalysis={() => { setAnalysisCopied(false); setAnalysisOpen(true); }}
              onShare={(filters) => { void openPanelFeishuShare(filters); }}
              showShare={canShowPddFeishuButton}
              onPeriodChange={(period) => setPddCollectionFailureV2State((current) => ({ ...current, period, status: "loading", progress: { loaded: 0, total: 0, stage: "records" }, error: null }))}
              onRetry={() => {
                setPddCollectionFailureV2State((current) => ({ ...current, status: "loading", error: null, progress: { loaded: 0, total: 0, stage: "records" } }));
                setPddCollectionFailureRetryCount((value) => value + 1);
              }}
              t={t}
            />
          )
        ) : String(view) === "bipagem-legacy-disabled" ? (
          !bipagemLoaded ? (
            <>
              {pddCollectionFailureV2Diagnostic}
              <EmptyDashboardPanel loading={bipagemLoading} error={error} canManageUpload={isMatrixAdminViewer} onDrop={(file) => queueUpload({ kind: "bipagem", files: [file] })} inputId="bipagem-upload" t={t} />
            </>
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
              {pddCollectionFailureV2Diagnostic}
              {dashboardActionBand}

              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}

              <section className="filters-card bipagem-filters-card" aria-labelledby="bipagem-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="bipagem-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                    <p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p>
                  </div>
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
          !isAuthorizedDashboardViewer ? (
            <section className="dashboard-source-availability unavailable" role="alert" data-testid="no-movement-v2-restricted">
              <div className="dashboard-intro">
                <div><div className="eyebrow"><Activity size={15} /> {t("SEM MOVIMENTAÇÃO")}</div><h1>{t("Sem movimentação")}</h1></div>
              </div>
              <p>{t("Aguardando liberação do acesso operacional pela administração.")}</p>
            </section>
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><Activity size={15} /> {t("SEM MOVIMENTAÇÃO")}</div>
                  <h1>{t("Sem movimentação")}</h1>
                  <p>{t(movementLoaded?.format === "summary" ? "Total sem movimentação por regional, base, RM, RGM e região do RM." : "Pedidos sem movimentação por AGING, regional, RM, base, status, origem e período.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo da fonte oficial de movimentação")}>
                  <span><Layers3 size={16} /> {noMovementHasPublishedRecords ? t("{count} pedidos", { count: formatNumber(movementSummary.totalStopped) }) : "—"}</span>
                  <span><MapPin size={16} /> {noMovementHasPublishedRecords ? t("{count} regionais", { count: formatNumber(movementRegionOptions.length) }) : "—"}</span>
                  <span><Database size={16} /> {noMovementHasPublishedRecords && movementLoaded ? t("{count} colunas", { count: formatNumber(movementLoaded.displayColumns.length) }) : "—"}</span>
                  <span><CircleAlert size={16} /> {noMovementHasPublishedRecords ? t("{count} bases críticas", { count: formatNumber(movementSummary.criticalBases) }) : "—"}</span>
                  <span><CalendarDays size={16} /> {noMovementHasPublishedRecords && movementLoaded?.sourceType === "DATA_FOUNDATION_V2"
                    ? t("Data da coleta: {date}", { date: movementLoaded.collectionDate ? formatDate(movementLoaded.collectionDate) : "—" })
                    : noMovementHasPublishedRecords && movementLoaded ? t("Última atualização: {date}", { date: formatDateTime(movementLoaded.updatedAt) }) : "—"}</span>
                </div>
              </section>
              {noMovementHasPreviousRecords ? <DashboardLoadingSkeleton compact t={t}
                message={noMovementV2State.status === "error" ? "A atualização falhou" : "Atualizando os dados do dashboard…"}
                previousDataLabel={noMovementV2State.collectionDate ? formatDate(noMovementV2State.collectionDate) : noMovementV2State.publicationId}
                error={noMovementV2State.status === "error" ? noMovementV2State.error : null}
                progress={noMovementV2State.progress}
                onRetry={noMovementV2State.status === "error" ? () => {
                  setNoMovementV2State((current) => ({ ...current, status: "loading", error: null, progress: { loaded: 0, total: 0, stage: "records" } }));
                  setNoMovementRetryCount((value) => value + 1);
                } : undefined} /> : null}
              {noMovementV2Diagnostic}
              {dashboardActionBand}

              {noMovementV2State.status === "error" && noMovementV2State.error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span><strong>{t("Erro ao consultar a Data Foundation V2.")}</strong> {noMovementV2State.error}</span>
                </div>
              ) : null}

              <section className="filters-card movement-filters-card" aria-labelledby="movement-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="movement-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                    <p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p>
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
                    onChange={(value) => applyMovementFilterSelection("regions", value)}
                    allLabel={t("Todas as regionais")}
                    singular={t("regional")}
                    plural={t("regionais")}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={movementRmOptions}
                    selected={movementSelectedRms}
                    onChange={(value) => applyMovementFilterSelection("rms", value)}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    getOptionLabel={(option) => t(option)}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect
                    label={t("Região do RM")}
                    options={movementRmAreaOptions}
                    selected={movementSelectedRmAreas}
                    onChange={(value) => applyMovementFilterSelection("rmAreas", value)}
                    allLabel={t("Todas as regiões do RM")}
                    singular={t("região do RM")}
                    plural={t("regiões do RM")}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={movementBaseOptions}
                    selected={movementSelectedBases}
                    onChange={(value) => applyMovementFilterSelection("bases", value)}
                    allLabel={t("Todas as bases")}
                    singular={t("base")}
                    plural={t("bases")}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect label="RGM" options={movementRgmOptions} selected={movementSelectedRgms}
                    onChange={(value) => applyMovementFilterSelection("rgms", value)} allLabel={t("Todos os RGM")}
                    singular="RGM" plural="RGM" searchable disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)} t={t} />
                  {movementLoaded?.format === "summary" ? (
                    <div className="filter-field">
                      <label className="filter-label" htmlFor="movement-metric">{t("Indicador / AGING")}</label>
                      <select className="date-input" id="movement-metric" value={movementSummaryMetric}
                        disabled={!noMovementHasPublishedRecords}
                        onChange={(event) => { setMovementSummaryMetric(event.target.value); setMovementPage(1); }}>
                        {MOVEMENT_SUMMARY_METRICS.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
                      </select>
                    </div>
                  ) : (<>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="movement-date-start">{t("Data inicial")}</label>
                    <input className="date-input" id="movement-date-start" type="date" min={movementLoaded?.dates[0]} max={movementLoaded?.dates[movementLoaded.dates.length - 1]} value={movementDateStart} disabled={!noMovementHasPublishedRecords} onChange={(event) => { setMovementDateStart(event.target.value); setMovementPage(1); }} />
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="movement-date-end">{t("Data final")}</label>
                    <input className="date-input" id="movement-date-end" type="date" min={movementLoaded?.dates[0]} max={movementLoaded?.dates[movementLoaded.dates.length - 1]} value={movementDateEnd} disabled={!noMovementHasPublishedRecords} onChange={(event) => { setMovementDateEnd(event.target.value); setMovementPage(1); }} />
                  </div>
                  <MultiSelect
                    label={t("Origem do pedido")}
                    options={movementLoaded?.origins ?? []}
                    selected={movementSelectedOrigins}
                    onChange={(value) => { setMovementSelectedOrigins(value); setMovementPage(1); }}
                    allLabel={t("Todas as origens")}
                    singular={t("Origem")}
                    plural={t("Origens")}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect
                    label="AGING"
                    options={movementLoaded?.agings ?? []}
                    selected={movementSelectedAgings}
                    onChange={(value) => { setMovementSelectedAgings(value); setMovementPage(1); }}
                    allLabel={t("Todos os AGING")}
                    singular="AGING"
                    plural="AGING"
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  <MultiSelect
                    label={t("Status")}
                    options={movementLoaded?.statuses ?? []}
                    selected={movementSelectedStatuses}
                    onChange={(value) => { setMovementSelectedStatuses(value); setMovementPage(1); }}
                    allLabel={t("Todos os status")}
                    singular={t("status")}
                    plural={t("status")}
                    searchable
                    disabled={!noMovementHasPublishedRecords}
                    disabledLabel={t(noMovementAvailabilityText)}
                    t={t}
                  />
                  </>)}
                </div>
                {movementDateStart && movementDateEnd && movementDateStart > movementDateEnd ? <p className="date-error" role="alert">{t("A data inicial deve ser anterior à data final.")}</p> : null}
              </section>

              {noMovementHasPublishedRecords && movementLoaded ? <>
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
                  value={noMovementHasPublishedRecords ? formatCompact(movementSummary.totalStopped) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{count} pedidos sem movimentação", { count: formatNumber(movementSummary.totalStopped) }) : t(noMovementAvailabilityText)}
                />
                <KpiCard
                  icon={<Database size={20} />}
                  label={t(movementLoaded?.format === "summary" ? "Pedidos em trânsito" : "Pedidos no período")}
                  value={noMovementHasPublishedRecords ? formatCompact(movementSummary.inTransit) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{count} pedidos no filtro", { count: formatNumber(movementSummary.inTransit) }) : t(noMovementAvailabilityText)}
                  tone="orange"
                />
                <KpiCard
                  icon={<CircleAlert size={20} />}
                  label={t("Acima de 2 dias")}
                  value={noMovementHasPublishedRecords ? formatCompact(movementSummary.over2Days) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{rate} dos pedidos sem movimentação", { rate: formatRate(movementSummary.over2Rate) }) : t(noMovementAvailabilityText)}
                  tone="dark"
                />
                <KpiCard
                  icon={<MapPin size={20} />}
                  label={t("Bases críticas")}
                  value={noMovementHasPublishedRecords ? formatNumber(movementSummary.criticalBases) : "—"}
                  detail={noMovementHasPublishedRecords ? t("com volume sem movimentação acima de 2 dias") : t(noMovementAvailabilityText)}
                  tone="soft"
                />
              </section>

              <section className="kpi-grid secondary-kpis" aria-label={t("Indicadores complementares de movimentação")}>
                <KpiCard
                  icon={<Activity size={20} />}
                  label={t("Acima de 14 dias")}
                  value={noMovementHasPublishedRecords ? formatCompact(movementSummary.over14Days) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{count} pedidos mais antigos", { count: formatNumber(movementSummary.over14Days) }) : t(noMovementAvailabilityText)}
                />
                <KpiCard
                  icon={<ShieldCheck size={20} />}
                  label={t("Acima de 30 dias")}
                  value={noMovementHasPublishedRecords ? formatCompact(movementSummary.over30Days) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{count} pedidos críticos", { count: formatNumber(movementSummary.over30Days) }) : t(noMovementAvailabilityText)}
                  tone="orange"
                />
                <KpiCard
                  icon={<MapPin size={20} />}
                  label={t("Total de regionais")}
                  value={noMovementHasPublishedRecords ? formatNumber(movementSummary.activeRegions) : "—"}
                  detail={noMovementHasPublishedRecords ? t("{count} selecionado(s)", { count: movementSelectedRegions.size }) : t(noMovementAvailabilityText)}
                  tone="dark"
                />
                <KpiCard
                  icon={<PackageCheck size={20} />}
                  label={t("Regional mais crítica")}
                  value={noMovementHasPublishedRecords ? movementSummary.topRegion ? formatCompact(movementSummary.topRegion[1]) : "0" : "—"}
                  detail={noMovementHasPublishedRecords ? movementSummary.topRegion?.[0] ?? t("Sem volume crítico") : t(noMovementAvailabilityText)}
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
                    <EmptyChart message={t(noMovementHasPublishedRecords ? "Não há pedidos sem movimentação para os filtros selecionados." : noMovementAvailabilityText)} />
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
                    <EmptyChart message={t(noMovementHasPublishedRecords ? "Não há pedidos sem movimentação para os filtros selecionados." : noMovementAvailabilityText)} />
                  )}
                </article>
              </section>

              <section className="table-card" aria-labelledby="movement-detail-heading">
                <div className="table-card-top">
                  <div>
                    <span className="card-eyebrow">{t("DETALHAMENTO")}</span>
                    <h2 id="movement-detail-heading">{t("Dados por base")}</h2>
                    <p>{t("Todas as 18 colunas do contrato oficial, ordenadas pelo total sem movimentação.")}</p>
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
                            <th>{t("Região do RM")}</th>
                            <th>RM</th>
                            <th>RGM</th>
                          </tr>
                        </thead>
                        <tbody className="screen-table-body">
                          {visibleMovementTableRows.map((row) => (
                            <tr key={row.key}>
                              {movementLoaded.displayColumns.map((column) => (
                                <td
                                  className={noMovementSourceColumnKind(column) === "quantity" || noMovementSourceColumnKind(column) === "percentage" ? "number-cell" : column === movementLoaded.columns.base ? "base-cell" : undefined}
                                  key={column}
                                >
                                  {column === movementLoaded.columns.region && movementLoaded.sourceType !== "DATA_FOUNDATION_V2" ? (
                                    <span className="regional-chip">{row.region}</span>
                                  ) : (
                                    formatNoMovementSourceCell(row.values[column], column, dashboardLocale(activeDashboardLanguage()))
                                  )}
                                </td>
                              ))}
                              <td>{t(row.rmArea)}</td>
                              <td>{t(row.rm)}</td>
                              <td>{t(row.rgm)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tbody className="print-table-body">
                          {movementTableRows.map((row) => (
                            <tr key={row.key}>
                              {movementLoaded.displayColumns.map((column) => (
                                <td
                                  className={noMovementSourceColumnKind(column) === "quantity" || noMovementSourceColumnKind(column) === "percentage" ? "number-cell" : column === movementLoaded.columns.base ? "base-cell" : undefined}
                                  key={column}
                                >
                                  {column === movementLoaded.columns.region && movementLoaded.sourceType !== "DATA_FOUNDATION_V2" ? (
                                    <span className="regional-chip">{row.region}</span>
                                  ) : (
                                    formatNoMovementSourceCell(row.values[column], column, dashboardLocale(activeDashboardLanguage()))
                                  )}
                                </td>
                              ))}
                              <td>{t(row.rmArea)}</td>
                              <td>{t(row.rm)}</td>
                              <td>{t(row.rgm)}</td>
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
                ) : noMovementHasPublishedRecords ? (
                  <div className="table-empty">
                    <Database size={28} />
                    <h3>{t("Nenhum dado encontrado")}</h3>
                    <p>{t("Ajuste a busca ou os filtros para visualizar os registros.")}</p>
                    <button type="button" onClick={() => resetMovementFilters()}>{t("Limpar filtros")}</button>
                  </div>
                ) : (
                  <div className="table-scroll movement-table-scroll" data-testid="no-movement-v2-empty-contract-table">
                    <table className="dashboard-data-table">
                      <thead>
                        <tr>
                          {movementLoaded.displayColumns.map((column) => <th key={column}>{t(column)}</th>)}
                          <th>{t("Região do RM")}</th>
                          <th>RM</th>
                          <th>RGM</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td colSpan={movementLoaded.displayColumns.length + 3}>
                            <div className="table-empty" role={noMovementV2State.status === "error" ? "alert" : "status"}>
                              <Database size={28} />
                              <h3>{t(noMovementAvailabilityText)}</h3>
                              {noMovementV2State.error ? <p>{noMovementV2State.error}</p> : null}
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <footer className="dashboard-footer">
                <span><ShieldCheck size={15} /> {t("Fonte exclusiva Data Foundation V2 · dados limitados ao escopo autorizado")}</span>
                <span>{noMovementHasPublishedRecords && movementLoaded.collectionDate
                  ? t("Data da coleta: {date} · Publicada em: {publishedAt}", { date: formatDate(movementLoaded.collectionDate), publishedAt: movementLoaded.publishedAt ? formatDateTime(movementLoaded.publishedAt) : "—" })
                  : t(noMovementAvailabilityText)}</span>
              </footer>
            </> : noMovementV2State.status === "error" ? (
              <DashboardLoadingSkeleton t={t} message="Carregando o snapshot publicado de Sem Movimentação…" error={noMovementV2State.error} onRetry={() => {
                setNoMovementV2State((current) => ({ ...current, status: "loading", error: null, progress: { loaded: 0, total: 0, stage: "records" } }));
                setNoMovementRetryCount((value) => value + 1);
              }} />
            ) : noMovementV2State.status === "loading" || noMovementV2State.status === "idle" || !noMovementDataAuthorized ? (
              <DashboardLoadingSkeleton t={t} message={noMovementV2State.progress.stage === "validation" ? "Validando a consistência da publicação…" : noMovementV2State.progress.total > 0 ? "Carregando registros publicados…" : "Carregando o snapshot publicado de Sem Movimentação…"} progress={noMovementV2State.progress} />
            ) : (
              <section className="dashboard-source-availability" role="status" aria-live="polite">
                <p>{t(noMovementAvailabilityText)}</p>
              </section>
            )}
            </>
          )
        ) : view === "sellers" ? (
          !sellerPerformanceLoaded ? (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><ShieldCheck size={15} /> {t("Monitoramento J&T")}</div>
                  <h1>{t("Monitoramento J&T")}</h1>
                  <p>{t("Acompanhe o processamento de coleta por seller, regional e base usando o resumo JMS publicado.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo aguardando sellers")}>
                  <span><ShieldCheck size={16} /> {t("Lista oficial de sellers")}</span>
                  <span><Database size={16} /> {t("Resumo JMS")}</span>
                  <span><MapPin size={16} /> {t("Regional")}</span>
                  <span><PackageCheck size={16} /> {t("Seller")}</span>
                </div>
              </section>
              {jtMonitoringV2Diagnostic}
              {dashboardActionBand}
              {error ? (
                <div className="inline-alert error" role="alert">
                  <CircleAlert size={18} />
                  <span>{t(error)}</span>
                  <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
                </div>
              ) : null}
              {sellerDependencyMessage ? <div className="inline-alert" role="status"><CircleAlert size={18} /><span>{t(sellerDependencyMessage)}</span></div> : null}
              <div className={`filters-card upload-ready-card sellers-upload-card${sellerLoading ? " loading" : ""}`}>
                <div className="upload-ready-icon" aria-hidden="true">
                  <ShieldCheck size={26} />
                </div>
                <div>
                  <span className="card-eyebrow">{t("LISTA DE SELLERS IMPORTANTES")}</span>
                  <h2>{t(sellerReferenceLoaded ? "Lista oficial de sellers publicada" : "Lista oficial de sellers indisponível")}</h2>
                  <p>{t(sellerReferenceLoaded ? "As categorias exibidas vêm da lista oficial publicada." : "A lista oficial de sellers não está publicada neste ambiente. As categorias não serão inferidas do XLSX J&T.")}</p>
                  {sellerReferenceLoaded ? (
                    <small>
                      {t("{count} sellers na lista", { count: formatNumber(sellerReferenceLoaded.records.length) })} · {sellerReferenceLoaded.fileName}
                    </small>
                  ) : null}
                </div>
              </div>
              <div className={`filters-card upload-ready-card sellers-upload-card${sellerLoading ? " loading" : ""}`}>
                <div className="upload-ready-icon" aria-hidden="true">
                  <FileSpreadsheet size={26} />
                </div>
                <div>
                  <span className="card-eyebrow">{t("RESUMO JMS DIÁRIO")}</span>
                  <h2>{t(sellerManualSource ? "Fonte J&T publicada" : "Fonte J&T não publicada")}</h2>
                  <p>{t("Este é o arquivo abastecido diariamente para calcular aguardando coleta, processados e percentual de processamento.")}</p>
                </div>
                {isMatrixAdminViewer ? <button className="primary-upload-button" type="button" onClick={() => setDataSourceDialogId("sellerPerformance")} disabled={sellerLoading}>
                  <Database size={18} /> {t(sellerManualSource ? "Gerenciar fonte J&T" : "Adicionar fonte J&T")}
                </button> : null}
              </div>
            </>
          ) : (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><ShieldCheck size={15} /> {t("SELLERS {categories}", { categories: sellerCategoryLabel })}</div>
                  <h1>{t("Monitoramento {categories}", { categories: sellerCategoryLabel })}</h1>
                  <p>{t(sellerReferenceLoaded
                    ? "Percentual de processamento por seller, categoria, regional e base. Sellers somente aguardando coleta aparecem com 0%."
                    : "Acompanhe o processamento de coleta por seller, regional e base usando o resumo JMS publicado.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Resumo do arquivo de sellers")}>
                  <span><Layers3 size={16} /> {t("{count} linhas · {categories}", { count: formatNumber(sellerPerformanceLoaded.records.length), categories: sellerCategoryLabel })}</span>
                  {sellerReferenceLoaded ? (
                    <span><ShieldCheck size={16} /> {t("{count} sellers na lista", { count: formatNumber(sellerReferenceLoaded.records.length) })}</span>
                  ) : (
                    <span><ShieldCheck size={16} /> {t("Lista oficial de sellers indisponível")}</span>
                  )}
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(sellerRegionOptions.length) })}</span>
                  <span><Database size={16} /> {t("{count} bases", { count: formatNumber(sellerPerformanceLoaded.bases.length) })}</span>
                  <span><CalendarDays size={16} /> {t("Última atualização: {date}", { date: formatDateTime(sellerPerformanceLoaded.updatedAt) })}</span>
                </div>
              </section>
              {jtMonitoringV2Diagnostic}
              {dashboardActionBand}

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
                    <p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p>
                  </div>
                  <div className="seller-file-actions">
                    {isMatrixAdminViewer ? <label className="secondary-upload-button" htmlFor="seller-list-upload"><Upload size={15} /> {t("Lista oficial de sellers")}</label> : null}
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
                  {sellerReferenceLoaded ? (
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
                  ) : null}
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
                    {sellerReferenceLoaded ? (
                      <span className="card-badge">{t("{count} categoria(s)", { count: sellerSelectedTiers.size })}</span>
                    ) : null}
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
                          : t(sellerReferenceLoaded
                            ? "Ajuste categoria, regional, base ou código do seller."
                            : "Ajuste regional, base ou código do seller.")}
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
                  list: sellerReferenceLoaded?.fileName ?? t("Lista oficial de sellers indisponível"),
                })}</span>
              </footer>
            </>
          )
        ) : view === "epop" ? (
          !epopLoaded ? (
            <>
              <section className="dashboard-intro"><div><div className="eyebrow"><Check size={15} /> EPOP / ePOD</div><h1>{t("Cobertura EPOP")}</h1><p>{t("Carregue o relatório EPOP para acompanhar a cobertura de comprovantes TikTok.")}</p></div></section>
              {error ? <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{t(error)}</span><button type="button" onClick={() => setError(null)}><X size={16} /></button></div> : null}
              <div className={`filters-card upload-ready-card${epopLoading ? " loading" : ""}`}><div className="upload-ready-icon"><FileSpreadsheet size={26} /></div><div><span className="card-eyebrow">EPOP / ePOD</span><h2>{epopLoading ? t("Processando relatório EPOP...") : t("Publique o relatório EPOP")}</h2><p>{t("A taxa usa somente sellers TikTok elegíveis: regional preenchida, base ativa no RJ, ID válido e quantidade coletada maior que zero.")}</p></div>{isMatrixAdminViewer ? <label className="primary-upload-button" htmlFor="epop-upload"><Upload size={18} />{t("Selecionar planilha")}</label> : null}</div>
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
            type EpopMatrixGroup = { label: string; rm: string; rgm: string; values: Map<string, Map<string, { eligible: boolean; epop: boolean }>> };
            type EpopMatrixRow = EpopMatrixGroup & { daily: { eligible: number; rate: number }[] };
            const buildMatrix = (level: "regional" | "rm"): EpopMatrixRow[] => {
              const groups = new Map<string, EpopMatrixGroup>();
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
            const regionalMatrixColumns: ExcelExportColumn<EpopMatrixRow>[] = [
              { header: t("Regional"), value: (item) => item.label },
              { header: "RGM", value: (item) => item.rgm },
              ...matrixDates.map((date, index) => ({
                header: formatDate(date, true),
                value: (item: EpopMatrixRow) => item.daily[index]?.rate ?? 0,
                numberFormat: "0.0%",
              })),
            ];
            const rmMatrixColumns: ExcelExportColumn<EpopMatrixRow>[] = [
              { header: t("Região do RM"), value: (item) => item.label.split("\u0000")[0] },
              { header: "RM", value: (item) => item.label.split("\u0000")[1] },
              { header: "RGM", value: (item) => item.label.split("\u0000")[2] },
              ...matrixDates.map((date, index) => ({
                header: formatDate(date, true),
                value: (item: EpopMatrixRow) => item.daily[index]?.rate ?? 0,
                numberFormat: "0.0%",
              })),
            ];
            return <>
              <section className="dashboard-intro"><div><div className="eyebrow"><Check size={15} /> EPOP / ePOD</div><h1>{t("Cobertura EPOP")}</h1><p>{t("Brasil → Região RM → RM → Regional → Base → Seller")}</p></div><div className="dataset-meta"><span><Layers3 size={16} /> {t("{count} linhas", {count: formatNumber(epopLoaded.records.length)})}</span><span><CalendarDays size={16} /> {t("Última atualização: {date}", {date: formatDateTime(epopLoaded.updatedAt)})}</span></div></section>
              {dashboardActionBand}
              {epopHistoryNotice ? <div className="inline-alert success" role="status"><Check size={18} /><span>{t("Histórico EPOP atualizado: {added} nova(s) data(s), {replaced} data(s) atualizada(s) e {total} data(s) disponíveis nos filtros.", { added: formatNumber(epopHistoryNotice.addedDates), replaced: formatNumber(epopHistoryNotice.replacedDates), total: formatNumber(epopHistoryNotice.totalDates) })}</span><button type="button" onClick={() => setEpopHistoryNotice(null)} aria-label={t("Fechar aviso")}><X size={16} /></button></div> : null}
              <section className="filters-card taxa-filters-card epop-primary-filters" aria-label={t("Filtros operacionais EPOP")}>
                <div className="filters-card-top"><div><h2><Filter size={18} /> {t("Filtros operacionais")}</h2><p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p></div><button type="button" className="reset-button" onClick={() => { setEpopSelectedRegions(initialRegionSelection(epopLoaded.regions, viewerIdentity)); setEpopSelectedBases(new Set(epopLoaded.bases)); setEpopDateStart(epopLoaded.dates[0] ?? ""); setEpopDateEnd(epopLoaded.dates.at(-1) ?? ""); }}><RotateCcw size={15} /> {t("Limpar filtros")}</button></div>
                <div className="filter-grid taxa-filter-grid">
                  <MultiSelect label={t("Regional")} options={epopLoaded.regions} selected={epopSelectedRegions} onChange={setEpopSelectedRegions} allLabel={t("Todas as regionais")} singular={t("regional")} plural={t("regionais")} searchable t={t}/>
                  <MultiSelect label="RM" options={responsibilityFilterOptions.rms} selected={selectedRms} onChange={(value) => { setSelectedRms(value); setTaxaRmSelection(rmSelectionFromValues(taxaResponsibilityFilterOptions.rms, value)); }} allLabel={t("Todos os RM")} singular="RM" plural="RM" searchable t={t}/>
                  <MultiSelect label={t("Região do RM")} options={responsibilityFilterOptions.rgms} selected={selectedRgms} onChange={(value) => setSelectedRgms(value)} allLabel={t("Todas as regiões do RM")} singular={t("região do RM")} plural={t("regiões do RM")} searchable t={t}/>
                  <MultiSelect label={t("Base")} options={epopLoaded.bases} selected={epopSelectedBases} onChange={setEpopSelectedBases} allLabel={t("Todas as bases")} singular={t("base")} plural={t("bases")} searchable t={t}/>
                  <div className="filter-field date-field"><label className="filter-label">{t("Data inicial")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateStart} min={epopLoaded.dates[0]} max={epopLoaded.dates.at(-1)} onChange={(event) => setEpopDateStart(event.target.value)} /></div></div>
                  <div className="filter-field date-field"><label className="filter-label">{t("Data final")}</label><div className="date-input-wrap"><CalendarDays size={16}/><input type="date" value={epopDateEnd} min={epopDateStart} max={epopLoaded.dates.at(-1)} onChange={(event) => setEpopDateEnd(event.target.value)} /></div></div>
                </div>
              </section>
              <section className="kpi-grid"><KpiCard icon={<Target size={20}/>} label={t("Taxa EPOP")} value={formatRate(rate)} detail={t("Meta: 100%")}/><KpiCard icon={<ShieldCheck size={20}/>} label={t("Sellers elegíveis")} value={formatNumber(eligible.length)} detail={t("有效商家数")}/><KpiCard icon={<Check size={20}/>} label={t("Sellers com EPOP")} value={formatNumber(withEpop.length)} detail={t("已有EPOP商家")} tone="orange"/><KpiCard icon={<CircleAlert size={20}/>} label={t("Sellers sem EPOP")} value={formatNumber(without.length)} detail={t("Gap para 100%: {count}", {count: formatNumber(without.length)})} tone="soft"/></section>
              <section className="charts-grid epop-standard-layout">
                <article className="chart-card taxa-poc-card epop-regional-panel">
                  <div className="card-heading">
                    <div><span className="card-eyebrow">EPOP</span><h2>{t("Taxa EPOP por regional — período selecionado")}</h2><p>{t("Visão diária de até 7 dias; o último dia define a ordenação.")}</p></div>
                    <button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(regionalMatrix, regionalMatrixColumns, t("Taxa EPOP por regional"), "epop_por_regional.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button>
                  </div>
                  <div className="taxa-poc-table-wrap"><table className="dashboard-data-table taxa-poc-table taxa-poc-regional-rgm-table"><thead><tr><th className="taxa-poc-region-column">{t("Regional")}</th><th className="taxa-poc-rgm-column">RGM</th>{matrixDates.map((date) => <th className="taxa-poc-date-header taxa-poc-day-column" key={date}><span>{formatDate(date, true)}</span></th>)}</tr></thead><tbody>{regionalMatrix.map((item) => <tr key={item.label}><th><span>{item.label}</span></th><td><span>{item.rgm}</span></td>{item.daily.map((point, index) => <td key={matrixDates[index]}><strong className={point.eligible === 0 ? "empty" : point.rate >= .98 ? "ok" : point.rate >= .9 ? "watch" : "alert"}>{point.eligible ? formatRate(point.rate) : "—"}</strong></td>)}</tr>)}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th>{matrixDates.map((date) => { const point = epopDailyPeriod.find((entry) => entry.date === date); return <td key={date}><strong>{point?.eligible ? formatRate(point.rate) : "—"}</strong></td>; })}</tr></tfoot></table></div>
                  <div className="epop-line-section"><h3>{t("Resultado geral do período selecionado")}</h3><div className="taxa-poc-line-chart"><svg viewBox="0 0 700 180" preserveAspectRatio="xMidYMid meet"><line className="chart-axis-line" x1="40" y1="20" x2="40" y2="144"/><line className="chart-axis-line" x1="40" y1="144" x2="686" y2="144"/><line className="target-line" x1="40" y1="20" x2="686" y2="20"/><polyline className="attempt-line" points={epopDailyPeriod.map((point, index) => `${40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1))},${20 + (1 - point.rate) * 124}`).join(" ")}/>{epopDailyPeriod.map((point, index) => { const x = 40 + (epopDailyPeriod.length <= 1 ? 323 : index * 646 / (epopDailyPeriod.length - 1)); const y = 20 + (1 - point.rate) * 124; return <g key={point.date}><circle className={point.rate >= .98 ? "attempt-point ok" : "attempt-point alert"} cx={x} cy={y} r="4"/><text className={point.rate >= .98 ? "attempt-value-label ok" : "attempt-value-label alert"} x={x} y={Math.max(12, y - 8)} textAnchor="middle">{formatRate(point.rate)}</text><text className="attempt-date-label" x={x} y="164" textAnchor="middle">{formatDate(point.date, true)}</text></g>; })}</svg></div></div>
                </article>
                <article className="chart-card taxa-poc-card epop-rm-panel">
                  <div className="card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Taxa EPOP por RM — período selecionado")}</h2><p>{t("Responsável do RM e RGM conforme o cadastro das bases.")}</p></div><button className="table-download-button" type="button" onClick={() => void downloadRowsAsExcel(rmMatrix, rmMatrixColumns, t("Taxa EPOP por RM"), "epop_por_rm.xlsx")}><FileSpreadsheet size={15}/>{t("Baixar Excel")}</button></div>
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
          isAuthorizedDashboardViewer ? (
            <>
              <section className="dashboard-intro">
                <div>
                  <div className="eyebrow"><Target size={15} /> {t("Data Foundation V3")}</div>
                  <h1>{t("Taxa de coleta")}</h1>
                  <p>{t("Fonte operacional: exportação mensal oficial do JMS. A classificação organizacional usa apenas correspondência única exata ou normalizada de forma conservadora no DoomsDay publicado.")}</p>
                </div>
                <div className="dataset-meta" aria-label={t("Fonte oficial V3")}>
                  <span><Database size={16} /> collection_rate</span>
                  <span><Layers3 size={16} /> {t("Contrato: {count} colunas", { count: formatNumber(collectionRateV2State.columnCount) })}</span>
                  <span><Activity size={16} /> {t("{count} linhas no período", { count: formatNumber(collectionRateV2State.receivedCount) })}</span>
                  <span><MapPin size={16} /> {t("{count} regionais", { count: formatNumber(taxaV2Options.regions.length) })}</span>
                  <span><Database size={16} /> {t("{count} bases", { count: formatNumber(taxaV2Options.bases.length) })}</span>
                  <span><PackageCheck size={16} /> {t("{count} origens", { count: formatNumber(taxaV2Options.origins.length) })}</span>
                  {collectionRateV2State.snapshotAsOf ? <span><CalendarDays size={16} /> {t("Coleta do bot mais recente usada: {date}", { date: formatDateTime(collectionRateV2State.snapshotAsOf) })}</span> : null}
                  {collectionRateV2State.publishedAt ? <span><Layers3 size={16} /> {t("Publicação mais recente usada: {date}", { date: formatDateTime(collectionRateV2State.publishedAt) })}</span> : null}
                </div>
              </section>
              <div className="taxa-v3-print-heading">
                <h1>{t("Taxa de coleta V3")}</h1>
                <p>{t("Período:")} {collectionRateV2State.period.dateFrom || "—"} a {collectionRateV2State.period.dateTo || "—"}</p>
              </div>
              {dashboardActionBand}
              <section className="filters-card taxa-filters-card" aria-labelledby="taxa-v2-filters-heading">
                <div className="filters-card-top">
                  <div>
                    <h2 id="taxa-v2-filters-heading"><Filter size={18} /> {t("Filtros operacionais")}</h2>
                    <p>{t("A consulta busca somente as datas selecionadas na publicação vigente; os demais filtros refinam o mesmo conjunto recebido.")}</p>
                  </div>
                  <div className="filter-card-actions">
                    <button
                      type="button"
                      className="reset-button"
                      onClick={() => {
                      const yesterday = yesterdayInSaoPaulo();
                      setTaxaV2Filters({});
                      setTaxaV2TableQuery("");
                      setTaxaV2Page(1);
                      setCollectionRateV2State((current) => ({
                        ...current,
                        status: current.period.dateFrom !== yesterday || current.period.dateTo !== yesterday ? "loading" : current.status,
                        progress: current.period.dateFrom !== yesterday || current.period.dateTo !== yesterday ? { loaded: 0, total: 0, stage: "records" } : current.progress,
                        error: current.period.dateFrom !== yesterday || current.period.dateTo !== yesterday ? null : current.error,
                        period: { dateFrom: yesterday, dateTo: yesterday },
                      }));
                      }}
                    >
                      <RotateCcw size={15} /> {t("Limpar filtros")}
                    </button>
                  </div>
                </div>
                <div id="taxa-v2-filter-content" className="taxa-v2-filter-content">
                <div className="filter-grid taxa-filter-grid">
                  <MultiSelect
                    label={t("Regional")}
                    options={taxaV2Options.regions}
                    selected={taxaV2Filters.regions ?? new Set(taxaV2Options.regions)}
                    onChange={(regions) => { setTaxaV2Filters((current) => ({ ...current, regions })); setTaxaV2Page(1); }}
                    allLabel={t("Todas as regionais")}
                    singular={t("regional")}
                    plural={t("regionais")}
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <MultiSelect
                    label="RM"
                    options={taxaV2Options.rms}
                    selected={taxaV2Filters.rms ?? new Set(taxaV2Options.rms)}
                    onChange={(rms) => { setTaxaV2Filters((current) => ({ ...current, rms })); setTaxaV2Page(1); }}
                    allLabel={t("Todos os RM")}
                    singular="RM"
                    plural="RM"
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <MultiSelect
                    label="RGM"
                    options={taxaV2Options.rgms}
                    selected={taxaV2Filters.rgms ?? new Set(taxaV2Options.rgms)}
                    onChange={(rgms) => { setTaxaV2Filters((current) => ({ ...current, rgms })); setTaxaV2Page(1); }}
                    allLabel={t("Todos os RGM")}
                    singular="RGM"
                    plural="RGM"
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <MultiSelect
                    label={t("Região do RM")}
                    options={taxaV2Options.rmAreas}
                    selected={taxaV2Filters.rmAreas ?? new Set(taxaV2Options.rmAreas)}
                    onChange={(rmAreas) => { setTaxaV2Filters((current) => ({ ...current, rmAreas })); setTaxaV2Page(1); }}
                    allLabel={t("Todas as regiões do RM")}
                    singular={t("região do RM")}
                    plural={t("regiões do RM")}
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <MultiSelect
                    label={t("Base")}
                    options={taxaV2Options.bases}
                    selected={taxaV2Filters.bases ?? new Set(taxaV2Options.bases)}
                    onChange={(bases) => { setTaxaV2Filters((current) => ({ ...current, bases })); setTaxaV2Page(1); }}
                    allLabel={t("Todas as bases")}
                    singular={t("base")}
                    plural={t("bases")}
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <div className="filter-field date-field">
                    <label className="filter-label" htmlFor="taxa-v2-date-start">{t("Data inicial")}</label>
                    <div className="date-input-wrap">
                      <CalendarDays size={16} />
                      <input
                        id="taxa-v2-date-start"
                        type="date"
                        value={collectionRateV2State.period.dateFrom}
                        onChange={(event) => {
                          const dateFrom = event.target.value;
                          setTaxaV2Page(1);
                          setCollectionRateV2State((current) => ({
                            ...current,
                            status: current.period.dateFrom !== dateFrom || current.period.dateTo < dateFrom ? "loading" : current.status,
                            progress: current.period.dateFrom !== dateFrom || current.period.dateTo < dateFrom ? { loaded: 0, total: 0, stage: "records" } : current.progress,
                            error: current.period.dateFrom !== dateFrom || current.period.dateTo < dateFrom ? null : current.error,
                            period: {
                              dateFrom,
                              dateTo: !current.period.dateTo || current.period.dateTo < dateFrom ? dateFrom : current.period.dateTo,
                            },
                          }));
                        }}
                      />
                    </div>
                  </div>
                  <div className="filter-field date-field">
                    <label className="filter-label" htmlFor="taxa-v2-date-end">{t("Data final")}</label>
                    <div className="date-input-wrap">
                      <CalendarDays size={16} />
                      <input
                        id="taxa-v2-date-end"
                        type="date"
                        value={collectionRateV2State.period.dateTo}
                        min={collectionRateV2State.period.dateFrom || undefined}
                        onChange={(event) => {
                          const dateTo = event.target.value;
                          setTaxaV2Page(1);
                          setCollectionRateV2State((current) => ({
                            ...current,
                            status: current.period.dateFrom !== (current.period.dateFrom || dateTo) || current.period.dateTo !== dateTo ? "loading" : current.status,
                            progress: current.period.dateFrom !== (current.period.dateFrom || dateTo) || current.period.dateTo !== dateTo ? { loaded: 0, total: 0, stage: "records" } : current.progress,
                            error: current.period.dateFrom !== (current.period.dateFrom || dateTo) || current.period.dateTo !== dateTo ? null : current.error,
                            period: {
                              dateFrom: current.period.dateFrom || dateTo,
                              dateTo,
                            },
                          }));
                        }}
                      />
                    </div>
                  </div>
                  <MultiSelect
                    label={t("Origem do pedido")}
                    options={taxaV2Options.origins}
                    selected={taxaV2Filters.origins ?? new Set(taxaV2Options.origins)}
                    onChange={(origins) => { setTaxaV2Filters((current) => ({ ...current, origins })); setTaxaV2Page(1); }}
                    allLabel={t("Todas as origens")}
                    singular={t("origem")}
                    plural={t("origens")}
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                  <MultiSelect
                    label={t("Tipo de encomenda")}
                    options={taxaV2Options.productTypes}
                    selected={taxaV2Filters.productTypes ?? new Set(taxaV2Options.productTypes)}
                    onChange={(productTypes) => { setTaxaV2Filters((current) => ({ ...current, productTypes })); setTaxaV2Page(1); }}
                    allLabel={t("Todos os tipos")}
                    singular={t("tipo")}
                    plural={t("tipos")}
                    searchable
                    exclusiveGroup="collection-rate-v3"
                    t={t}
                  />
                </div>
                <div
                  className={`filter-summary${collectionRateV2State.status === "error" ? " invalid" : ""}`}
                  role={collectionRateV2State.status === "error" ? "alert" : "status"}
                  data-testid="collection-rate-v2-diagnostic"
                  aria-live="polite"
                >
                  <span><strong>{t("Status da fonte JMS:")}</strong> {collectionRateV2State.status === "idle"
                    ? t("Aguardando consulta")
                    : collectionRateV2State.status === "loading"
                      ? t("Consultando publicação vigente…")
                      : collectionRateV2State.status === "ready"
                        ? t("Conexão ativa")
                        : collectionRateV2State.status === "empty"
                          ? t("Conectado, sem registros para o período")
                          : t("Erro de conexão")}</span>
                  <span><strong>{t("Período:")}</strong> {collectionRateV2State.period.dateFrom || "—"} a {collectionRateV2State.period.dateTo || "—"}</span>
                  <span><strong>{t("Registros recebidos:")}</strong> {formatNumber(collectionRateV2State.receivedCount)}</span>
                  <span><strong>{t("Colunas:")}</strong> {formatNumber(collectionRateV2State.columnCount)}</span>
                  <span><strong>{t("Linhas após filtros:")}</strong> {formatNumber(taxaV2FilteredRows.length)}</span>
                  {collectionRateV2State.publicationId ? <span><strong>{t("Publicação utilizada:")}</strong> {collectionRateV2State.publicationId}</span> : collectionRateV2State.publicationIds.length > 1 ? <span><strong>{t("Publicações diárias utilizadas:")}</strong> {formatNumber(collectionRateV2State.publicationIds.length)}</span> : null}
                  {collectionRateV2State.status === "empty" ? <span>{t(collectionRateV2State.error ?? "Sem dados publicados para a data selecionada")}</span> : null}
                  {collectionRateV2State.status === "error" && collectionRateV2State.error ? <span>{t(collectionRateV2State.error)}</span> : null}
                  {collectionRateV2State.latestDayMayBeIncomplete ? <span className="quality-warning">{t("O último dia publicado pode estar incompleto; os valores exibidos não foram ajustados.")}</span> : null}
                </div>
                </div>
              </section>
              {taxaV2HasPreviousData ? <DashboardLoadingSkeleton compact t={t}
                message={collectionRateV2State.status === "error" ? "A atualização falhou" : "Atualizando os dados do dashboard…"}
                previousDataLabel={`${collectionRateV2State.loadedPeriod?.dateFrom ?? ""}${collectionRateV2State.loadedPeriod?.dateTo && collectionRateV2State.loadedPeriod.dateTo !== collectionRateV2State.loadedPeriod.dateFrom ? ` a ${collectionRateV2State.loadedPeriod.dateTo}` : ""}`}
                error={collectionRateV2State.status === "error" ? collectionRateV2State.error : null}
                progress={collectionRateV2State.progress}
                onRetry={collectionRateV2State.status === "error" ? () => setCollectionRateV2State((current) => ({ ...current, status: "loading", progress: { loaded: 0, total: 0, stage: "records" }, error: null, retryKey: current.retryKey + 1 })) : undefined} /> : null}
              {collectionRateV2State.status === "loading" && !taxaV2HasPreviousData ? <DashboardLoadingSkeleton t={t}
                message={collectionRateV2State.progress.stage === "validation" ? "Validando a consistência da publicação…" : collectionRateV2State.progress.total > 0 ? "Carregando registros publicados…" : "Consultando publicação vigente…"}
                progress={collectionRateV2State.progress} /> : null}
              {collectionRateV2State.status === "ready" || taxaV2HasPreviousData ? (
                <>
                  <section className="kpi-grid" aria-label={t("Indicadores de taxa de coleta")} data-testid="taxa-v2-kpi-grid">
                    <KpiCard icon={<Target size={20} />} label={t("Taxa de coleta")} value={formatTaxaRate(taxaV2Summary.collectionRate)} detail={t("{count} coletados de {planned} previstos", { count: formatNumber(taxaV2Summary.collected), planned: formatNumber(taxaV2Summary.planned) })} />
                    <KpiCard icon={<TrendingUp size={20} />} label={t("Taxa com tentativa")} value={formatTaxaRate(taxaV2AttemptRate.rate)} detail={t("{count} com coleta/tentativa", { count: formatNumber(taxaV2AttemptRate.collectedPlusAttempts) })} tone="orange" />
                    <KpiCard icon={<Layers3 size={20} />} label={t("Previsto a coletar")} value={formatCompact(taxaV2Summary.planned)} detail={t("SUM(Quantidade prevista para coleta)")} tone="dark" />
                    <KpiCard icon={<CircleAlert size={20} />} label={t("Aguardando coleta")} value={formatCompact(taxaV2Summary.notCollected)} detail={t("Não coletados")} tone="soft" />
                  </section>

                  <section className="charts-grid taxa-v2-summary-grid taxa-v3-full-width">
                    <article className="chart-card">
                      <div className="card-heading"><div><span className="card-eyebrow">{t("POR REGIONAL")}</span><h2>{t("Taxa de coleta com tentativa por regional — período selecionado")}</h2><p>{t("Pedidos = SUM(totalCount). Taxa diária = SUM(Pedidos coletados + Tentativas de coleta) / SUM(Qtd a coletar). Em vários dias, cada data é exibida separadamente; não há taxa do período.")}</p></div></div>
                      <div className="taxa-poc-table-wrap taxa-v2-summary-table-wrap"><table className={`dashboard-data-table taxa-poc-table taxa-v2-summary-table taxa-v2-regional-attempts-table${taxaV2RegionalAttempts.dates.length <= 1 ? " taxa-v2-regional-attempts-table-single" : ""}`} data-testid="taxa-v2-regional-summary"><thead><tr><th>{t("Regional")}</th><th>RGM</th>{taxaV2RegionalAttempts.dates.map((date) => <th className="taxa-poc-date-header" key={date}><span>{formatDate(date, true).toLocaleUpperCase(dashboardLocale(activeDashboardLanguage()))}</span><small>{formatWeekday(date)}</small><small>{t("Taxa de coleta com tentativa")}</small></th>)}<th>{t("Total de pedidos")}</th></tr></thead><tbody>{taxaV2RegionalAttempts.rows.map((row) => <tr key={row.region}><th scope="row"><span>{row.region}</span></th><td>{t(row.rgm)}</td>{row.days.map((day, index) => <td key={taxaV2RegionalAttempts.dates[index]}><strong className={day.rate === null ? "empty" : ""}>{formatCollectionRateV3RegionalAttemptRate(day.rate, dashboardLocale(activeDashboardLanguage()))}</strong></td>)}<td>{formatNumber(row.totalOrders)}</td></tr>)}{taxaV2RegionalAttempts.rows.length === 0 ? <tr><td colSpan={taxaV2RegionalAttempts.dates.length + 3}><EmptyChart message={t("Não há regionais com movimento para os filtros selecionados.")} /></td></tr> : null}</tbody><tfoot><tr><th colSpan={2}>{t("Total geral")}</th>{taxaV2RegionalAttempts.totals.map((day, index) => <td key={taxaV2RegionalAttempts.dates[index]}><strong className={day.rate === null ? "empty" : ""}>{formatCollectionRateV3RegionalAttemptRate(day.rate, dashboardLocale(activeDashboardLanguage()))}</strong></td>)}<td>{formatNumber(taxaV2RegionalAttempts.totalOrders)}</td></tr></tfoot></table></div>
                      {taxaV2RegionalAttempts.unassigned.records > 0 ? <p className="filter-note taxa-v2-regional-attempts-note" data-testid="taxa-v2-regional-attempts-note">{t("{orders} pedidos sem Regional ({planned} previstos) ficam fora do subtotal desta tabela; permanecem preservados na fonte e auditáveis nos escopos autorizados.", { orders: formatNumber(taxaV2RegionalAttempts.unassigned.orders), planned: formatNumber(taxaV2RegionalAttempts.unassigned.quantityToCollect) })}</p> : null}
                    </article>
                  </section>

                  <section className="charts-grid taxa-v2-summary-grid taxa-v3-full-width">
                    <article className="chart-card">
                      <div className="card-heading"><div><span className="card-eyebrow">{t("TENDÊNCIA")}</span><h2>{t("Evolução diária — taxas confirmadas")}</h2><p>{t("Cada ponto é recalculado pelas quantidades do dia publicado. Datas sem publicação não são exibidas.")}</p></div></div>
                      {taxaV2Daily.length > 0 ? (
                        <div className="taxa-poc-line-chart" data-testid="taxa-v2-daily-chart">
                          <svg viewBox="0 0 700 190" preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("Evolução diária da Taxa de Coleta e da Taxa no Prazo")}>
                            <line className="chart-axis-line" x1="40" y1="20" x2="40" y2="150" />
                            <line className="chart-axis-line" x1="40" y1="150" x2="686" y2="150" />
                            <polyline className="attempt-line" points={taxaV2Daily.map((point, index) => `${40 + (taxaV2Daily.length <= 1 ? 323 : index * 646 / (taxaV2Daily.length - 1))},${150 - (point.collectionRate ?? 0) * 120}`).join(" ")} />
                            <polyline className="target-line" points={taxaV2Daily.map((point, index) => `${40 + (taxaV2Daily.length <= 1 ? 323 : index * 646 / (taxaV2Daily.length - 1))},${150 - (point.onTimeRate ?? 0) * 120}`).join(" ")} />
                            {taxaV2Daily.map((point, index) => {
                              const x = 40 + (taxaV2Daily.length <= 1 ? 323 : index * 646 / (taxaV2Daily.length - 1));
                              const collectionY = 150 - (point.collectionRate ?? 0) * 120;
                              const onTimeY = 150 - (point.onTimeRate ?? 0) * 120;
                              return <g key={point.date}><circle className="attempt-point alert" cx={x} cy={collectionY} r="4" /><circle className="attempt-point ok" cx={x} cy={onTimeY} r="4" /><text className="attempt-value-label" x={x} y="174" textAnchor="middle">{formatDate(point.date, true)}</text></g>;
                            })}
                          </svg>
                          <div className="dataset-meta"><span><i className="chart-legend-dot collection" />{t("Taxa de coleta")}</span><span><i className="chart-legend-dot on-time" />{t("Taxa de coleta no prazo")}</span></div>
                        </div>
                      ) : <EmptyChart message={t("Sem datas publicadas no período.")} />}
                    </article>
                  </section>

                  <CollectionRateV3MonthlyChart points={taxaV2MonthlyChart} locale={dashboardLocale(activeDashboardLanguage())} formatRate={formatTaxaRate} t={t} />

                  <section className="charts-grid taxa-v2-summary-grid taxa-v3-full-width">
                    <article className="chart-card">
                      <div className="card-heading"><div><span className="card-eyebrow">{t("ORIGEM DO PEDIDO")}</span><h2>{t("Performance por login")}</h2><p>{t("Taxa de coleta ponderada pelas quantidades.")}</p></div></div>
                      <div className="damage-client-bars" data-testid="taxa-v2-origin-summary">
                        {taxaV2ByOrigin.map((item) => <div className="damage-client-row" key={item.origin}>
                          <div className="damage-client-label"><span>{item.origin}</span><strong>{formatNumber(item.planned)} {t("previstos")}</strong></div>
                          <div className="damage-client-track"><span style={{ width: collectionRateV3ProgressWidth(item.collectionRate) }} /></div>
                          <small>{t("Taxa de coleta")}: {formatTaxaRate(item.collectionRate)}</small>
                        </div>)}
                        {taxaV2ByOrigin.length === 0 ? <EmptyChart message={t("Não há origens no período filtrado.")} /> : null}
                      </div>
                    </article>
                  </section>

                  <section className="charts-grid taxa-v2-summary-grid taxa-v3-full-width">
                    <article className="chart-card">
                      <div className="card-heading"><div><span className="card-eyebrow">RM</span><h2>{t("Taxa com tentativa por RM")}</h2><p>{t("Agrupamento organizacional pelo DoomsDay; a taxa com tentativa permanece pendente.")}</p></div></div>
                      <div className="taxa-poc-table-wrap taxa-v2-summary-table-wrap"><table className="dashboard-data-table taxa-poc-table taxa-v2-summary-table taxa-v2-rm-summary-table epop-rm-table" data-testid="taxa-v2-rm-summary"><thead><tr><th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Bases")}</th>{taxaV2Dates.map((date) => <th className="taxa-poc-date-header" key={date}><span>{formatDate(date, true)}</span><small>{t("Taxa tentativa / pedidos")}</small></th>)}<th>{t("Total de pedidos")}</th><th>{t("Taxa de coleta")}</th></tr></thead><tbody>{taxaV2ByRmArea.map((row) => <tr key={row.key}><th><span>{t(row.label)}</span></th><td>{t(row.rm)}</td><td>{t(row.rgm)}</td><td>{formatNumber(row.baseCount)}</td>{taxaV2Dates.map((date) => <td key={date}><strong className="empty">{t("Pendente")}</strong><small>{formatNumber(row.daily.get(date)?.totalOrders ?? 0)}</small></td>)}<td>{formatNumber(row.totalOrders)}</td><td>{formatTaxaRate(row.collectionRate)}</td></tr>)}</tbody><tfoot><tr><th colSpan={4}>{t("Total geral")}</th>{taxaV2Dates.map((date) => <td key={date}><strong className="empty">{t("Pendente")}</strong><small>{formatNumber(taxaV2Daily.find((point) => point.date === date)?.totalOrders ?? 0)}</small></td>)}<td>{formatNumber(taxaV2Summary.totalOrders)}</td><td>{formatTaxaRate(taxaV2Summary.collectionRate)}</td></tr></tfoot></table></div>
                    </article>
                  </section>

                  {taxaV2FilteredRows.some((row) => row.effective_region === "Sem regional") ? <div className="quality-note" role="status">{t("Registros sem correspondência única no DoomsDay permanecem nos totais gerais e sem atribuição organizacional.")}</div> : null}
                  <div className="quality-note" role="status">{t("As tabelas analíticas de taxa com tentativa permanecem pendentes de validação.")}</div>

                  <section className="chart-card bipagem-table-card taxa-v2-detail-card">
                    <div className="card-heading table-card-heading taxa-v2-detail-heading">
                      <div><span className="card-eyebrow">{t("DETALHAMENTO")}</span><h2>{t("Dados detalhados — 22 colunas oficiais")}</h2><p>{t("Campos e valores originais da aba Dados, sem deduplicação. A classificação organizacional usa apenas correspondência única com o DoomsDay publicado; o nome JMS permanece informativo.")}</p></div>
                      <div className="table-tools taxa-v2-detail-tools"><button type="button" className="table-download-button taxa-v2-export-button" onClick={() => void downloadRowsAsExcel(taxaV2SearchedRows, COLLECTION_RATE_V3_COLUMNS.map((field) => ({ header: t(COLLECTION_RATE_V3_HEADERS[field]), value: (row: CollectionRateV3DashboardRow) => collectionRateV3ExcelValue(row[field], field), width: 20, numberFormat: collectionRateV3ExcelNumberFormat(field) })), t("Taxa de Coleta — dados detalhados"), "taxa_coleta_v3_detalhado.xlsx")} disabled={taxaV2SearchedRows.length === 0}><FileSpreadsheet size={16} /> {t("Baixar Excel")}</button><label className="table-search"><Search size={16} /><input value={taxaV2TableQuery} onChange={(event) => { setTaxaV2TableQuery(event.target.value); setTaxaV2Page(1); }} placeholder={t("Buscar nos dados detalhados")} /></label></div>
                    </div>
                    <div className="dashboard-table-wrap bipagem-table-wrap bipagem-detail-table-wrap pdd-v2-detail-table-wrap taxa-v2-detail-table-wrap"><table className="dashboard-data-table bipagem-detail-table pdd-v2-detail-table taxa-v2-detail-table taxa-v3-detail-table"><thead><tr>{COLLECTION_RATE_V3_COLUMNS.map((field) => <th key={field}>{t(COLLECTION_RATE_V3_HEADERS[field])}</th>)}</tr></thead><tbody>{taxaV2VisibleRows.map((row) => <tr key={`${row.publication_id}-${row.source_row_no}`}>{COLLECTION_RATE_V3_COLUMNS.map((field) => <td key={field}>{formatCollectionRateV3Cell(row[field], field, dashboardLocale(activeDashboardLanguage()))}</td>)}</tr>)}</tbody></table>{taxaV2SearchedRows.length === 0 ? <EmptyChart message={t("Não há registros correspondentes aos filtros.")} /> : null}</div>
                    <div className="table-pagination"><span>{t("{count} linhas", { count: formatNumber(taxaV2SearchedRows.length) })}</span><button type="button" className="reset-button" onClick={() => setTaxaV2Page((current) => Math.max(1, current - 1))} disabled={taxaV2ActivePage <= 1}>{t("Anterior")}</button><span>{t("Página {current} de {total}", { current: formatNumber(taxaV2ActivePage), total: formatNumber(taxaV2PageCount) })}</span><button type="button" className="reset-button" onClick={() => setTaxaV2Page((current) => Math.min(taxaV2PageCount, current + 1))} disabled={taxaV2ActivePage >= taxaV2PageCount}>{t("Próxima")}</button></div>
                  </section>
                </>
              ) : collectionRateV2State.status === "empty" ? (
                <div className="quality-note" role="status">{t(collectionRateV2State.error ?? "Sem dados publicados para a data selecionada")}</div>
              ) : collectionRateV2State.status === "error" ? (
                <DashboardLoadingSkeleton t={t} message="Consultando publicação vigente…" error={collectionRateV2State.error} onRetry={() => setCollectionRateV2State((current) => ({ ...current, status: "loading", progress: { loaded: 0, total: 0, stage: "records" }, error: null, retryKey: current.retryKey + 1 }))} />
              ) : (
                collectionRateV2State.status === "loading" ? null : <div className="filter-summary" role="status">{currentDashboardAvailability.status === "unavailable" ? t("Fonte Taxa V3 indisponível. Verifique o registro do contrato e a conexão com a Data Foundation.") : t("Aguardando consulta à Data Foundation V3")}</div>
              )}
            </>
          ) : !taxaLoaded ? (
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
                {isMatrixAdminViewer ? <button className="primary-upload-button" type="button" onClick={() => setDataSourceDialogId("taxa")} disabled={taxaLoading}>
                  <Upload size={18} />
                  {taxaLoading ? t("Processando…") : t("Selecionar planilha(s)")}
                </button> : null}
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
              {dashboardActionBand}

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
                    <p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p>
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
                      const bases = taxaBasesForRegions(taxaLoaded, value).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, taxaSelectedRms, selectedRgms));
                      setTaxaRmAreaSelection({ mode: "all" });
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
                    options={taxaResponsibilityFilterOptions.rms}
                    selected={taxaSelectedRms}
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
                      setTaxaRmAreaSelection(optionSelectionFromValues(taxaRmAreaOptions, value));
                      setTaxaSelectedBases(new Set(taxaBasesForRegions(taxaLoaded, taxaSelectedRegions).filter((base) =>
                        matchesResponsibility(responsibilityLoaded, base, taxaSelectedRms, selectedRgms) &&
                        value.has(rmAreaForBase(responsibilityLoaded, base)))));
                      setTaxaPage(1);
                    }}
                    allLabel={t("Todas as regiões do RM")}
                    singular={t("região do RM")}
                    plural={t("regiões do RM")}
                    getOptionLabel={(option) => t(option)}
                    searchable
                    resetSearchOnOpen
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
                          const nextEnd = !taxaDateEnd || taxaDateEnd < nextStart ? nextStart : taxaDateEnd;
                          setTaxaDateStart(nextStart);
                          if (!taxaDateEnd || taxaDateEnd < nextStart) setTaxaDateEnd(nextEnd);
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
                          const nextEnd = event.target.value;
                          setTaxaDateEnd(nextEnd);
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
                  value={formatTaxaRate(taxaSummary.onTimeRate)}
                  detail={t("{count} coletados no prazo", { count: formatNumber(taxaSummary.onTime) })}
                />
                <KpiCard
                  icon={<TrendingUp size={20} />}
                  label={t("Taxa com tentativa")}
                  value={formatTaxaRate(taxaSummary.collectionWithAttemptsRate)}
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
                  detail={t("{rate} do previsto a coletar", { rate: formatTaxaRate(taxaSummary.awaitingRate) })}
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
                                    className={value.rate === null ? "empty" : value.rate >= taxaPerformanceThreshold ? "ok" : value.rate >= 0.95 ? "watch" : "alert"}
                                    title={value.toCollect > 0 ? t("{count} com tentativa", { count: formatNumber(value.withAttempts) }) : t("Sem movimento")}
                                  >
                                    {formatTaxaRate(value.rate)}
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
                                <strong title={t("{count} com tentativa", { count: formatNumber(value.withAttempts) })}>{formatTaxaRate(value.rate)}</strong>
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
                          {taxaPocTrend.lines.map((points, lineIndex) => <polyline key={`poc-line-${lineIndex}`} className="attempt-line" points={points} />)}
                          {taxaPocTrend.points.map((point, index) => (
                            <g key={`trend-${point.date}`}>
                              {point.y === null ? <text className="attempt-value-label" x={point.x} y={taxaPocTrend.height - taxaPocTrend.bottom - 4} textAnchor="middle">—</text> : (
                                <>
                                  <circle className={point.rate !== null && point.rate >= taxaPerformanceThreshold ? "attempt-point ok" : "attempt-point alert"} cx={point.x} cy={point.y} r="4" />
                                  <text className={`attempt-value-label ${point.rate !== null && point.rate >= taxaPerformanceThreshold ? "ok" : "alert"}`} x={point.x} y={Math.max(9, point.y - (index % 2 === 0 ? 7 : 14))} textAnchor="middle">{formatTaxaRate(point.rate)}</text>
                                </>
                              )}
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
                              <strong>{formatTaxaRate(item.attemptRate)}</strong>
                            </div>
                            <div className="horizontal-track">
                              <span style={{ width: `${Math.min(100, (item.attemptRate ?? 0) * 100)}%`, backgroundColor: "#e60000" }} />
                            </div>
                            <small>{t("{count} com tentativa · {rate} no prazo", { count: formatNumber(item.withAttempts), rate: formatTaxaRate(item.onTimeRate) })}</small>
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
                                  <tr key={rmGroupReactKey(row.rmArea, row.rm, row.rgm)}>
                                    <th scope="row"><span title={t(row.rmArea)}>{t(row.rmArea)}</span></th>
                                    <th scope="row"><span title={t(row.rm)}>{t(row.rm)}</span></th>
                                    <th scope="row"><span title={t(row.rgm)}>{t(row.rgm)}</span></th>
                                    {taxaAttemptTarget == null ? null : <td className="target-cell"><strong>{formatRate(taxaAttemptTarget)}</strong></td>}
                                    {row.values.map((value, index) => (
                                      <td key={`${rmGroupReactKey(row.rmArea, row.rm, row.rgm)}::${taxaRmPoc.dates[index]}`}>
                                        <strong
                                          className={value.rate === null ? "empty" : value.rate >= taxaPerformanceThreshold ? "ok" : value.rate >= 0.95 ? "watch" : "alert"}
                                          title={value.toCollect > 0 ? t("{count} com tentativa", { count: formatNumber(value.withAttempts) }) : t("Sem movimento")}
                                        >
                                          {formatTaxaRate(value.rate)}
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
                                        {formatTaxaRate(value.rate)}
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
	                              <td className="number-cell">{formatTaxaRate(row.onTimeRate)}</td>
	                              <td className="number-cell total-cell">{formatTaxaRate(row.awaitingRate)}</td>
	                              <td className="number-cell">{formatTaxaRate(row.attemptRate)}</td>
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
	                              <td className="number-cell">{formatTaxaRate(row.onTimeRate)}</td>
	                              <td className="number-cell total-cell">{formatTaxaRate(row.awaitingRate)}</td>
	                              <td className="number-cell">{formatTaxaRate(row.attemptRate)}</td>
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
        ) : isAuthorizedDashboardViewer && !referenceBaseTestRequested ? (
          <CollectionMonitoringV2Dashboard key={dashboardCacheIdentity} t={t} language={language} scopeKey={dashboardCacheIdentity} />
        ) : !loaded ||
          (isAuthorizedDashboardViewer && loaded.sourceType !== "DATA_FOUNDATION_V2") ||
          (loaded.sourceType === "DATA_FOUNDATION_V2" && !isAuthorizedDashboardViewer) ? (
          <EmptyDashboardPanel
            loading={isAuthorizedDashboardViewer ? monitoringV2Status === "loading" || monitoringV2Status === "idle" : loading}
            error={isAuthorizedDashboardViewer ? (monitoringV2Status === "error" ? monitoringV2Message : null) : error}
            canManageUpload={false}
            onDrop={(file) => queueUpload({ kind: "monitoring", files: [file] })}
            onAddSource={() => setDataSourceDialogId("monitoring")}
            inputId="monitoring-upload"
            description={isAuthorizedDashboardViewer ? "Este painel consulta a publicação vigente de Monitoramento de Coleta na Data Foundation V2." : undefined}
            sourceLabel={isAuthorizedDashboardViewer ? "DATA FOUNDATION V2" : undefined}
            emptyTitle={isAuthorizedDashboardViewer && monitoringV2Status === "empty" ? "Sem dados publicados para a data selecionada" : undefined}
            emptyDescription={isAuthorizedDashboardViewer && monitoringV2Status === "empty" ? monitoringV2Message ?? "Sem dados publicados para a data selecionada" : undefined}
            loadingDescription={isAuthorizedDashboardViewer ? "Consultando a publicação vigente da Data Foundation V2…" : undefined}
            periodStart={isAuthorizedDashboardViewer ? monitoringV2PeriodStart : undefined}
            periodEnd={isAuthorizedDashboardViewer ? monitoringV2PeriodEnd : undefined}
            onPeriodStartChange={isAuthorizedDashboardViewer ? setMonitoringV2PeriodStart : undefined}
            onPeriodEndChange={isAuthorizedDashboardViewer ? setMonitoringV2PeriodEnd : undefined}
            onRetry={isAuthorizedDashboardViewer ? () => setMonitoringV2RetryKey((key) => key + 1) : undefined}
            t={t}
          />
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
                {loaded.sourceType === "MANUAL_UPLOAD" ? <span><FileSpreadsheet size={16} /> {t("Fonte: {fileName}", { fileName: loaded.fileName })}</span> : null}
                <span><CalendarDays size={16} /> <BilingualText language={language} source="Última atualização: {date}" values={{ date: formatDateTime(loaded.updatedAt) }} /></span>
              </div>
            </section>
            {dashboardActionBand}

            {error ? (
              <div className="inline-alert error" role="alert">
                <CircleAlert size={18} />
                <span>{t(error)}</span>
                <button type="button" onClick={() => setError(null)} aria-label={t("Fechar aviso")}><X size={16} /></button>
              </div>
            ) : null}

            {isMatrixAdminViewer && monitoringV2Status === "loading" ? (
              <div className="inline-alert" role="status">
                <CalendarDays size={18} />
                <span>{t("Carregando o período solicitado; os indicadores exibidos continuam referentes ao período {from}–{to}.", {
                  from: dateStart,
                  to: dateEnd,
                })}</span>
              </div>
            ) : null}
            {isMatrixAdminViewer && monitoringV2Status === "error" && monitoringV2Message ? (
              <div className="inline-alert error" role="alert">
                <CircleAlert size={18} />
                <span>{t(monitoringV2Message)}</span>
                <button type="button" onClick={() => setMonitoringV2RetryKey((key) => key + 1)}>{t("Tentar novamente")}</button>
              </div>
            ) : null}

            <section className="filters-card" aria-labelledby="filters-heading">
              <div className="filters-card-top">
                <div>
                  <h2 id="filters-heading"><Filter size={18} /> <BilingualText language={language} source="Filtros operacionais" /></h2>
                  <p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p>
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
                    if (loaded) setSelectedBases(new Set(monitoringBasesForSelection(loaded, value, responsibilityLoaded, selectedRms, selectedRgms)));
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
                  options={monitoringResponsibilityFilterOptions.rms}
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
                      value={loaded.sourceType === "DATA_FOUNDATION_V2" ? monitoringV2PeriodStart : dateStart}
                      min={loaded.sourceType === "DATA_FOUNDATION_V2" ? undefined : loaded.dates[0]}
                      max={loaded.sourceType === "DATA_FOUNDATION_V2" ? undefined : loaded.dates[loaded.dates.length - 1]}
                      onChange={(event) => {
                        if (loaded.sourceType === "DATA_FOUNDATION_V2") setMonitoringV2PeriodStart(event.target.value);
                        else setDateStart(event.target.value);
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
                      value={loaded.sourceType === "DATA_FOUNDATION_V2" ? monitoringV2PeriodEnd : dateEnd}
                      min={loaded.sourceType === "DATA_FOUNDATION_V2" ? undefined : loaded.dates[0]}
                      max={loaded.sourceType === "DATA_FOUNDATION_V2" ? undefined : loaded.dates[loaded.dates.length - 1]}
                      onChange={(event) => {
                        if (loaded.sourceType === "DATA_FOUNDATION_V2") setMonitoringV2PeriodEnd(event.target.value);
                        else setDateEnd(event.target.value);
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
                  disabled={loaded.sourceType === "DATA_FOUNDATION_V2"}
                  disabledLabel={t("Não disponível na fonte V2")}
                  disabledReason={t("A publicação oficial do Monitoramento de Coleta não contém Origem do Pedido.")}
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
                <div className="card-heading">
                  <div>
                    <span className="card-eyebrow">PRIMEIRA DIGITALIZAÇÃO</span>
                    <h2>{t("Retenção por regional")}</h2>
                    <p>{t("Última data do filtro; D-1 e variação aparecem quando há histórico anterior disponível.")}</p>
                  </div>
                  <button className="table-download-button" type="button" onClick={() => {
                    const measureHeaders = ["Retenção total", "Retido na base", "Despachado pela base", "Chegado ao centro"];
                    const columns: ExcelExportColumn<(typeof firstScanRegionalSummary)[number]>[] = [
                      { header: t("Regional"), value: (row) => row.region },
                      { header: "RGM", value: (row) => row.rgm },
                      { header: t("Volume previsto"), value: (row) => row.orderVolume },
                      ...measureHeaders.flatMap((label, index) => [
                        { header: `${t(label)} — D-1`, value: (row: (typeof firstScanRegionalSummary)[number]) => {
                          const previous = firstScanPreviousRegional.get(row.region);
                          return previous ? firstScanDisplayMeasures(previous)[index] : "—";
                        } },
                        { header: `${t(label)} — ${t("Atual")}`, value: (row: (typeof firstScanRegionalSummary)[number]) => firstScanDisplayMeasures(row)[index] },
                        { header: `${t(label)} — ${t("Variação")}`, value: (row: (typeof firstScanRegionalSummary)[number]) => {
                          const previous = firstScanPreviousRegional.get(row.region);
                          return previous ? firstScanDisplayMeasures(row)[index] - firstScanDisplayMeasures(previous)[index] : "—";
                        } },
                      ]),
                    ];
                    void downloadRowsAsExcel(firstScanRegionalSummary, columns, t("Primeira digitalização por regional"), "primeira_digitalizacao_regional.xlsx");
                  }}><FileSpreadsheet size={16}/>{t("Baixar Excel")}</button>
                </div>
                {isReferenceBaseTestActive && firstScanReferenceTestInfo ? (
                  <div className="reference-base-test-controls">
                    <div className="quality-note" role="status">
                      <Info size={16} />
                      <span>
                        <strong>Teste — Bases da referência.</strong>{" "}
                        {t("Modo local isolado: somente esta tabela usa a lista fornecida e o período 05/10/2026; os demais filtros e componentes permanecem independentes.")}{" "}
                        {t("{included} de {total} linhas incluídas; {missing} linha(s) sem nome de base.", {
                          included: formatNumber(firstScanReferenceTestInfo.includedRows),
                          total: formatNumber(firstScanReferenceTestInfo.dayRows),
                          missing: formatNumber(firstScanReferenceTestInfo.rowsWithoutBaseName),
                        })}
                      </span>
                      <button
                        type="button"
                        className="reset-button"
                        onClick={() => {
                          setReferenceBaseTestRequested(false);
                          const url = new URL(window.location.href);
                          url.searchParams.delete("monitoringReferenceBaseTest");
                          window.history.replaceState(window.history.state, "", url);
                        }}
                      >
                        {t("Encerrar teste")}
                      </button>
                    </div>
                    <div className="filter-grid monitoring-filter-grid">
                      <MultiSelect
                        label={t("Base")}
                        options={[...REFERENCE_BASE_TEST_NAMES]}
                        selected={referenceBaseTestSelected}
                        onChange={setReferenceBaseTestSelected}
                        allLabel={t("Todas as bases da referência")}
                        singular={t("base")}
                        plural={t("bases")}
                        searchable
                        t={t}
                      />
                      <span className="filter-summary">
                        {t("{count} nomes na lista de referência.", { count: formatNumber(REFERENCE_BASE_TEST_NAMES.length) })}
                      </span>
                    </div>
                  </div>
                ) : null}
                <div className="dashboard-table-wrap movement-summary-table-wrap">
                  <table className="dashboard-data-table movement-summary-table monitoring-summary-table first-scan-table">
                    <thead>
                      <tr>
                        <th rowSpan={2}><PtZhHeader pt="Regional" zh="始发区域" /></th>
                        <th rowSpan={2}>RGM</th>
                        <th rowSpan={2}><PtZhHeader pt="Volume previsto" zh="应揽量" /></th>
                        <th colSpan={3}><PtZhHeader pt="Retenção total" zh="整体滞留量" /></th>
                        <th colSpan={3}><PtZhHeader pt="Retido na base" zh="网点滞留量" /></th>
                        <th colSpan={3}><PtZhHeader pt="Despachado pela base" zh="网点已发件" /></th>
                        <th colSpan={3}><PtZhHeader pt="Chegado ao centro" zh="集散已到件" /></th>
                      </tr>
                      <tr>
                        {[0, 1, 2, 3].flatMap((group) => [
                          <th key={`${group}-previous`}><PtZhHeader pt="D-1" zh="前一日" /></th>,
                          <th key={`${group}-current`}><PtZhHeader pt="Atual" zh="当前" /></th>,
                          <th key={`${group}-change`}><PtZhHeader pt="Variação" zh="变化" /></th>,
                        ])}
                      </tr>
                    </thead>
                    <tbody>
                      {firstScanRegionalSummary.map((row) => {
                        const previous = firstScanPreviousRegional.get(row.region);
                        const values = firstScanDisplayMeasures(row);
                        const previousValues = previous ? firstScanDisplayMeasures(previous) : null;
                        return (
                          <tr key={row.region}>
                            <td><span className="regional-chip">{row.region}</span></td>
                            <td>{t(row.rgm)}</td>
                            <td className="number-cell">{formatNumber(row.orderVolume)}</td>
                            {values.flatMap((value, index) => [
                              <td className="number-cell" key={`${index}-previous`}>{previousValues ? formatNumber(previousValues[index] ?? 0) : "—"}</td>,
                              <td className="number-cell" key={`${index}-current`}>{formatNumber(value)}</td>,
                              <td className="number-cell" key={`${index}-change`}>{previousValues ? formatNumber(value - (previousValues[index] ?? 0)) : "—"}</td>,
                            ])}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>{t("Total geral")}</th>
                        <td>—</td>
                        <td className="number-cell">{formatNumber(firstScanTotal.orderVolume)}</td>
                        {firstScanDisplayMeasures(firstScanTotal).flatMap((value, index) => {
                          const previousValues = firstScanPreviousTotal.orderVolume > 0 ? firstScanDisplayMeasures(firstScanPreviousTotal) : null;
                          return [
                            <td className="number-cell" key={`${index}-previous`}>{previousValues ? formatNumber(previousValues[index] ?? 0) : "—"}</td>,
                            <td className="number-cell" key={`${index}-current`}>{formatNumber(value)}</td>,
                            <td className="number-cell" key={`${index}-change`}>{previousValues ? formatNumber(value - (previousValues[index] ?? 0)) : "—"}</td>,
                          ];
                        })}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </article>              <article className="chart-card movement-summary-card">
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
                              <td>{monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rm}</td>
                              <td>{monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rgm}</td>
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
                            <td>{monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rm}</td>
                            <td>{monitoringResponsibilityForBase(responsibilityLoaded, row.base, row.region).rgm}</td>
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
