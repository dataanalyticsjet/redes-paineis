"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, CalendarDays, Database, Download, Filter, Layers3, MapPin, RefreshCw } from "lucide-react";
import { apiFetch, subscribeToProtectedApiAuthorizationFailure } from "../../lib/api-url.ts";
import { dashboardLocale, type DashboardLanguage, type DashboardTranslator } from "../../lib/i18n";
import { officialRgmForRegion, UNASSIGNED_RGM } from "../../lib/responsibility.ts";

const SOURCE_ID = "collection_monitoring_t4_t5";
const CONTRACT_VERSION = 1;
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

const COLUMNS = [
  ["data_date", "Data"],
  ["reported_origin_region", "Regional Origem"],
  ["source_base_name", "PDD de saida"],
  ["customer_name", "Cliente"],
  ["store_name", "Loja"],
  ["seller_id", "Id Seller/remetente"],
  ["assigned_driver", "Motorista Designado"],
  ["order_origin", "Origem do Pedido"],
  ["awaiting_collection", "Status atual – Aguardando coleta"],
  ["received_at_dropoff", "Status atual – Recebido no Drop-off"],
  ["collected", "Status atual – Coletado"],
  ["received", "Status atual – Recebido"],
  ["received_at_base", "Status atual – Recebido na base"],
  ["in_base_dispatch_flow", "当前状态-网点发件流程中"],
  ["arrived_at_sc", "Status atual – Chegou ao SC"],
] as const;

const STATUS_FIELDS = [
  "awaiting_collection", "received_at_dropoff", "collected", "received",
  "received_at_base", "in_base_dispatch_flow", "arrived_at_sc",
] as const;

const STATUS_LABELS: Record<(typeof STATUS_FIELDS)[number], string> = {
  awaiting_collection: "Aguardando coleta",
  received_at_dropoff: "Recebido no Drop-off",
  collected: "Coletado",
  received: "Recebido",
  received_at_base: "Recebido na base",
  in_base_dispatch_flow: "Em processo de expedição na base",
  arrived_at_sc: "Chegou ao SC",
};

type T4T5Period = { dateFrom: string; dateTo: string };
type T4T5Filters = T4T5Period & {
  region: string;
  rm: string;
  pdd: string;
  customer: string;
  store: string;
  driver: string;
  origin: string;
  search: string;
};
type T4T5Totals = {
  records: number;
  regions: number;
  pdds: number;
  stores: number;
  unmappedRecords: number;
  statuses: Record<(typeof STATUS_FIELDS)[number], number>;
};
type T4T5Summary = {
  hasData: boolean;
  snapshotDate: string | null;
  metadata: { publicationId: string; publishedAt: string | null; snapshotAsOf: string | null; publishedRowCount: number } | null;
  totals: T4T5Totals | null;
};
type T4T5Group = Record<string, string | number | null>;
type T4T5GroupPage = { rows: T4T5Group[]; total: number; limit: number; offset: number };
type T4T5RecordPage = { records: Record<string, unknown>[]; total: number; limit: number; offset: number };
type T4T5Options = {
  regions: string[];
  rms: { regional: string; region: string; responsible: string }[];
  pdds: string[];
  origins: string[];
};
type GroupDimension = "region" | "rm" | "pdd" | "customer" | "store" | "driver";

interface Props {
  t: DashboardTranslator;
  language: DashboardLanguage;
  scopeKey: string;
}

function formatInteger(value: unknown, language: DashboardLanguage): string {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat(dashboardLocale(language), { maximumFractionDigits: 0 }).format(Number.isFinite(number) ? number : 0);
}

function formatDate(value: unknown, language: DashboardLanguage): string {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || "—";
  const [year, month, day] = text.split("-").map(Number);
  return new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function paramsFor(filters: T4T5Filters, includeSearch = true): URLSearchParams {
  const params = new URLSearchParams({ contract_version: String(CONTRACT_VERSION) });
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.region) params.set("region", filters.region);
  if (filters.rm) {
    try {
      const parsed = JSON.parse(filters.rm) as { regional?: string; region?: string; responsible?: string };
      if (parsed.regional) params.set("rm_regional", parsed.regional);
      if (parsed.region) params.set("rm_region", parsed.region);
      if (parsed.responsible) params.set("rm_responsible", parsed.responsible);
    } catch { /* invalid transient option is ignored */ }
  }
  if (filters.pdd) params.set("source_base_name", filters.pdd);
  if (filters.customer) params.set("customer_name", filters.customer);
  if (filters.store) params.set("store_name", filters.store);
  if (filters.driver) params.set("assigned_driver", filters.driver);
  if (filters.origin) params.set("order_origin", filters.origin);
  if (includeSearch && filters.search) params.set("search", filters.search);
  return params;
}

async function requestJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
  try {
    const response = await apiFetch(path, { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string };
      const error = new Error(body.detail || `HTTP ${response.status}`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return await response.json() as T;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function apiPath(route: string, params: URLSearchParams): string {
  return `/api/v2/collection-monitoring-t4-t5/${route}?${params.toString()}`;
}

function withParams(params: URLSearchParams, additions: [string, string][]): URLSearchParams {
  const result = new URLSearchParams(params);
  for (const [key, value] of additions) result.set(key, value);
  return result;
}

function errorMessage(error: unknown, t: DashboardTranslator): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return t("Sua sessão expirou. Entre novamente para consultar os dados.");
  if (status === 403) return t("O acesso aos dados operacionais não está autorizado para o escopo da sua conta.");
  if (error instanceof Error && error.message === "timeout") return t("A consulta demorou mais que o esperado. Tente novamente ou selecione um período menor.");
  return t("Não foi possível carregar o Monitoramento T4 e T5. Tente novamente.");
}

function buildFilters(filters: T4T5Filters): URLSearchParams {
  return paramsFor(filters);
}

function statusSum(group: T4T5Group): number {
  return STATUS_FIELDS.reduce((sum, field) => sum + Number(group[field] ?? 0), 0);
}

function GroupTable({ dimension, rows, total, page, setPage, loading, language, t }: {
  dimension: GroupDimension;
  rows: T4T5Group[];
  total: number;
  page: number;
  setPage: (value: number) => void;
  loading: boolean;
  language: DashboardLanguage;
  t: DashboardTranslator;
}) {
  const headers: Record<GroupDimension, string[]> = {
    region: ["Regional", "RGM", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
    rm: ["Regional", "Região do RM", "Responsável RM", "RGM", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
    pdd: ["Regional", "PDD de saída", "Região do RM", "Responsável RM", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
    customer: ["Cliente", "Lojas distintas", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
    store: ["Loja", "ID Seller/remetente", "Clientes", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
    driver: ["Motorista Designado", "Lojas distintas", "Registros", ...STATUS_FIELDS.map((field) => STATUS_LABELS[field])],
  };
  const cells = (row: T4T5Group): unknown[] => {
    const region = String(row.regional_name ?? "Sem regional");
    const rgm = officialRgmForRegion(region) ?? UNASSIGNED_RGM;
    const common = STATUS_FIELDS.map((field) => row[field] ?? 0);
    if (dimension === "region") return [region, rgm, row.record_count, ...common];
    if (dimension === "rm") return [region, row.rm_region, row.rm_responsible, rgm, row.record_count, ...common];
    if (dimension === "pdd") return [region, row.source_base_name, row.rm_region, row.rm_responsible, row.record_count, ...common];
    if (dimension === "customer") return [row.customer_name, row.distinct_stores, row.record_count, ...common];
    if (dimension === "store") return [row.store_name, row.seller_id, row.distinct_customers, row.record_count, ...common];
    return [row.assigned_driver, row.distinct_stores, row.record_count, ...common];
  };
  const pageCount = Math.max(1, Math.ceil(total / 100));
  return <>
    <div className="collection-monitoring-t4-t5-table-scroll">
      <table className="collection-monitoring-t4-t5-table">
        <thead><tr>{headers[dimension].map((header) => <th key={header}>{t(header)}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, rowIndex) => <tr key={`${dimension}-${page}-${rowIndex}`}>
              {cells(row).map((value, index) => <td className={index > 0 ? "number-cell" : ""} key={`${rowIndex}-${index}`}>
              {typeof value === "number" ? formatInteger(value, language) : String(value ?? "—")}
            </td>)}
          </tr>)}
          {!loading && rows.length === 0 ? <tr><td colSpan={headers[dimension].length} className="collection-monitoring-t4-t5-empty">{t("Sem dados para os filtros selecionados.")}</td></tr> : null}
          {loading ? <tr><td colSpan={headers[dimension].length} className="collection-monitoring-t4-t5-empty">{t("Carregando agrupamento…")}</td></tr> : null}
        </tbody>
      </table>
    </div>
    {total > 100 ? <div className="collection-monitoring-t4-t5-pagination">
      <span>{t("Página {page} de {pages}", { page, pages: pageCount })} · {formatInteger(total, language)} {t("grupos")}</span>
      <div><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>{t("Anterior")}</button><button type="button" disabled={page >= pageCount || loading} onClick={() => setPage(page + 1)}>{t("Próxima")}</button></div>
    </div> : null}
  </>;
}

export function CollectionMonitoringT4T5Dashboard({ t, language, scopeKey }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<T4T5Summary | null>(null);
  const [options, setOptions] = useState<T4T5Options>({ regions: [], rms: [], pdds: [], origins: [] });
  const [dates, setDates] = useState<string[]>([]);
  const [filters, setFilters] = useState<T4T5Filters>({ dateFrom: "", dateTo: "", region: "", rm: "", pdd: "", customer: "", store: "", driver: "", origin: "", search: "" });
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [recordTotal, setRecordTotal] = useState(0);
  const [recordPage, setRecordPage] = useState(1);
  const [activeGroup, setActiveGroup] = useState<GroupDimension>("region");
  const [groupData, setGroupData] = useState<Partial<Record<GroupDimension, T4T5GroupPage>>>({});
  const [groupPage, setGroupPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [reload, setReload] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const latestRequestRef = useRef(0);
  const number = useCallback((value: unknown) => formatInteger(value, language), [language]);

  useEffect(() => subscribeToProtectedApiAuthorizationFailure((failure) => {
    if (!failure.path.includes(SOURCE_ID)) return;
    requestRef.current?.abort();
    setSummary(null);
    setRecords([]);
    setGroupData({});
    setOptions({ regions: [], rms: [], pdds: [], origins: [] });
    setStatus("error");
    setError(failure.status === 401
      ? t("Sua sessão expirou. Entre novamente para consultar os dados.")
      : t("O acesso aos dados operacionais não está autorizado para o escopo da sua conta."));
  }), [t]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void requestJson<{ dates?: { date: string }[] }>(
      `/api/v2/data-sources/${SOURCE_ID}/dates?contract_version=${CONTRACT_VERSION}&latest_only=true`,
      controller.signal,
    ).then((payload) => {
      if (!active) return;
      const availableDates = (payload.dates ?? []).map((item) => String(item.date).slice(0, 10)).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)).sort();
      setDates(availableDates);
      if (availableDates.length === 0) {
        setSummary({ hasData: false, snapshotDate: null, metadata: null, totals: null });
        setStatus("empty");
        return;
      }
      const latest = availableDates.at(-1) as string;
      setFilters((current) => ({ ...current, dateFrom: current.dateFrom || latest, dateTo: current.dateTo || latest }));
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setError(errorMessage(cause, t));
      setStatus("error");
    });
    return () => { active = false; controller.abort(); };
  }, [scopeKey, reload, t]);

  useEffect(() => {
    if (dates.length === 0 || (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo)) return undefined;
    const controller = new AbortController();
    const requestId = ++latestRequestRef.current;
    requestRef.current?.abort();
    requestRef.current = controller;
    const baseParams = buildFilters(filters);
    const summaryPath = apiPath("summary", baseParams);
    const optionsPath = apiPath("filters", new URLSearchParams({ date_from: filters.dateFrom, date_to: filters.dateTo }));
    void Promise.all([
      requestJson<T4T5Summary>(summaryPath, controller.signal),
      requestJson<T4T5Options>(optionsPath, controller.signal),
      requestJson<T4T5RecordPage>(apiPath("records", withParams(baseParams, [["limit", String(PAGE_SIZE)], ["offset", String((recordPage - 1) * PAGE_SIZE)]])), controller.signal),
    ]).then(async ([nextSummary, nextOptions, detail]) => {
      if (requestId !== latestRequestRef.current || controller.signal.aborted) return;
      if (!nextSummary.hasData || !nextSummary.snapshotDate) {
        setSummary(nextSummary);
        setOptions(nextOptions);
        setRecords([]);
        setRecordTotal(0);
        setGroupData({});
        setStatus("empty");
        return;
      }
      const groupPromises = (["region", "rm", "pdd"] as const).map((dimension) => {
        const params = withParams(baseParams, [["dimension", dimension], ["snapshot_date", nextSummary.snapshotDate as string], ["limit", "100"], ["offset", "0"]]);
        return requestJson<T4T5GroupPage>(apiPath("groups", params), controller.signal);
      });
      const initialGroups = await Promise.all(groupPromises);
      if (requestId !== latestRequestRef.current || controller.signal.aborted) return;
      setSummary(nextSummary);
      setOptions(nextOptions);
      setRecords(detail.records);
      setRecordTotal(detail.total);
      setGroupData({ region: initialGroups[0], rm: initialGroups[1], pdd: initialGroups[2] });
      setStatus("ready");
    }).catch((cause: unknown) => {
      if (requestId !== latestRequestRef.current || controller.signal.aborted) return;
      setSummary(null);
      setRecords([]);
      setGroupData({});
      setError(errorMessage(cause, t));
      setStatus("error");
    });
    return () => controller.abort();
  }, [dates.length, filters, recordPage, reload, scopeKey, t]);

  useEffect(() => {
    if (!summary?.snapshotDate || (groupData[activeGroup] && groupPage === 1)) return undefined;
    const controller = new AbortController();
    const params = withParams(buildFilters(filters), [["dimension", activeGroup], ["snapshot_date", summary.snapshotDate], ["limit", "100"], ["offset", String((groupPage - 1) * 100)]]);
    void requestJson<T4T5GroupPage>(apiPath("groups", params), controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setGroupData((current) => ({ ...current, [activeGroup]: result }));
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setGroupData((current) => ({ ...current, [activeGroup]: { rows: [], total: 0, limit: 100, offset: (groupPage - 1) * 100 } }));
      setError(errorMessage(cause, t));
    });
    return () => controller.abort();
  }, [activeGroup, groupPage, summary?.snapshotDate, filters, scopeKey, t, groupData]);

  function applyFilters(next: T4T5Filters) {
    setRecordPage(1);
    setGroupPage(1);
    setSummary(null);
    setRecords([]);
    setRecordTotal(0);
    setGroupData({});
    const hasInvalidDateRange = Boolean(next.dateFrom && next.dateTo && next.dateFrom > next.dateTo);
    setError(hasInvalidDateRange ? t("A data inicial deve ser anterior à data final.") : null);
    setStatus(hasInvalidDateRange ? "error" : "loading");
    setFilters(next);
  }

  function update<K extends keyof T4T5Filters>(key: K, value: T4T5Filters[K]) {
    applyFilters({ ...filters, [key]: value });
  }

  function clearFilters() {
    const latest = dates.at(-1) ?? "";
    setRecordPage(1);
    setGroupPage(1);
    setSummary(null);
    setRecords([]);
    setRecordTotal(0);
    setGroupData({});
    setError(null);
    setStatus("loading");
    setFilters({ dateFrom: latest, dateTo: latest, region: "", rm: "", pdd: "", customer: "", store: "", driver: "", origin: "", search: "" });
  }

  function changeRecordPage(page: number) {
    setSummary(null);
    setRecords([]);
    setRecordTotal(0);
    setGroupData({});
    setError(null);
    setStatus("loading");
    setRecordPage(page);
  }

  async function downloadExcel() {
    setExporting(true);
    const controller = new AbortController();
    const params = buildFilters(filters);
    try {
      const response = await apiFetch(apiPath("export.xlsx", params), { method: "GET", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "monitoramento-coleta-t4-t5.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setExporting(false);
    }
  }

  const totals = summary?.totals;
  const groups: { id: GroupDimension; label: string }[] = [
    { id: "region", label: "Monitoramento por Regional" },
    { id: "rm", label: "Monitoramento por RM" },
    { id: "pdd", label: "Monitoramento por PDD" },
    { id: "customer", label: "Por Cliente" },
    { id: "store", label: "Por Loja" },
    { id: "driver", label: "Por Motorista" },
  ];
  const recordPages = Math.max(1, Math.ceil(recordTotal / PAGE_SIZE));
  const groupRows = groupData[activeGroup]?.rows ?? [];
  const groupTotal = groupData[activeGroup]?.total ?? 0;
  const groupLoading = Boolean(
    summary?.snapshotDate
    && groupData[activeGroup]?.offset !== (groupPage - 1) * 100,
  );
  const regionalRows = groupData.region?.rows ?? [];
  const statusColors = ["#dc2626", "#f97316", "#eab308", "#84cc16", "#10b981", "#06b6d4", "#6366f1"];
  const filteredRms = options.rms.filter((rm) => !filters.region || rm.regional === filters.region);
  const filteredPdds = options.pdds;

  return <div className="collection-monitoring-t4-t5">
    <section className="collection-monitoring-t4-t5-intro">
      <div>
        <div className="collection-monitoring-t4-t5-eyebrow"><Activity size={15} /> {t("VISÃO CONSOLIDADA")}</div>
        <h1>{t("Monitoramento de Coleta T4 e T5")}</h1>
        <p>{t("Acompanhe os volumes e status das coletas por regional, PDD, cliente, loja e motorista.")}</p>
      </div>
      <div className="collection-monitoring-t4-t5-meta">
        <span><Layers3 size={15} /> {t("Registros")}: <b>{totals ? number(totals.records) : "—"}</b></span>
        <span><MapPin size={15} /> {t("Regionais")}: <b>{totals ? number(totals.regions) : "—"}</b></span>
        <span><Database size={15} /> {t("PDDs")}: <b>{totals ? number(totals.pdds) : "—"}</b></span>
        <span><Database size={15} /> {t("Lojas")}: <b>{totals ? number(totals.stores) : "—"}</b></span>
        <span><CalendarDays size={15} /> {t("Última atualização")}: <b>{summary?.metadata?.snapshotAsOf ? new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: "short", timeStyle: "short" }).format(new Date(summary.metadata.snapshotAsOf)) : "—"}</b></span>
      </div>
    </section>

    {error ? <div className="collection-monitoring-t4-t5-alert" role="alert"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => { setError(null); setStatus("loading"); setReload((value) => value + 1); }}>{t("Tentar novamente")}</button></div> : null}

    <section className="collection-monitoring-t4-t5-card">
      <div className="collection-monitoring-t4-t5-section-heading">
        <div><h2><Filter size={17} /> {t("Filtros operacionais")}</h2><p>{t("Refine os dados do monitoramento para uma análise mais precisa.")}</p></div>
        <button type="button" className="collection-monitoring-t4-t5-button" onClick={clearFilters}>{t("Limpar filtros")}</button>
      </div>
      <div className="collection-monitoring-t4-t5-filter-grid">
        <label><span>{t("Regional")}</span><select value={filters.region} onChange={(event) => applyFilters({ ...filters, region: event.target.value, rm: "" })}><option value="">{t("Todas as regionais")}</option>{options.regions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t("RM")}</span><select value={filters.rm} onChange={(event) => update("rm", event.target.value)}><option value="">{t("Todos os RM")}</option>{filteredRms.map((item) => { const value = JSON.stringify(item); return <option value={value} key={value}>{item.regional} · {item.region} — {item.responsible}</option>; })}</select></label>
        <label><span>{t("PDD / Base")}</span><select value={filters.pdd} onChange={(event) => update("pdd", event.target.value)}><option value="">{t("Todos os PDDs")}</option>{filteredPdds.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t("Data inicial")}</span><input type="date" value={filters.dateFrom} max={filters.dateTo || dates.at(-1)} onChange={(event) => update("dateFrom", event.target.value)} /></label>
        <label><span>{t("Data final")}</span><input type="date" value={filters.dateTo} min={filters.dateFrom || undefined} max={dates.at(-1)} onChange={(event) => update("dateTo", event.target.value)} /></label>
        <label><span>{t("Cliente")}</span><input value={filters.customer} onChange={(event) => update("customer", event.target.value)} placeholder={t("Filtrar cliente")} /></label>
        <label><span>{t("Loja / ID Seller")}</span><input value={filters.store} onChange={(event) => update("store", event.target.value)} placeholder={t("Nome da loja ou identificador")} /></label>
        <label><span>{t("Motorista designado")}</span><input value={filters.driver} onChange={(event) => update("driver", event.target.value)} placeholder={t("Filtrar motorista")} /></label>
        <label><span>{t("Origem do pedido")}</span><select value={filters.origin} onChange={(event) => update("origin", event.target.value)}><option value="">{t("Todas as origens")}</option>{options.origins.map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      {filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo ? <p className="collection-monitoring-t4-t5-error-text">{t("A data inicial deve ser anterior à data final.")}</p> : null}
    </section>

    {status === "loading" ? <div className="collection-monitoring-t4-t5-state" role="status"><RefreshCw className="collection-monitoring-t4-t5-spin" size={20} /> {t("Carregando publicação e indicadores…")}</div> : null}
    {status === "empty" ? <div className="collection-monitoring-t4-t5-state"><AlertCircle size={20} /><div><h2>{t("Aguardando primeira importação")}</h2><p>{t("A fonte T4 e T5 ainda não possui publicação disponível para o seu escopo.")}</p></div></div> : null}

    {status === "ready" && totals ? <>
      {totals.unmappedRecords > 0 ? <div className="collection-monitoring-t4-t5-note">{t("{count} registros permanecem Sem regional por falta de vínculo DoomsDay; eles só entram em escopos autorizados para dados nacionais.", { count: number(totals.unmappedRecords) })}</div> : null}
      <section className="collection-monitoring-t4-t5-kpis">
        {STATUS_FIELDS.map((field, index) => <article className="collection-monitoring-t4-t5-kpi" key={field}>
          <span>{t(STATUS_LABELS[field])}</span><strong>{number(totals.statuses[field])}</strong>
          <small>{t("Soma independente do campo JMS")}</small><i style={{ color: statusColors[index] }}><Activity size={18} /></i>
        </article>)}
        <article className="collection-monitoring-t4-t5-kpi"><span>{t("Registros consultados")}</span><strong>{number(totals.records)}</strong><small>{t("Linhas físicas no snapshot")}</small><i><Layers3 size={18} /></i></article>
      </section>
      <p className="collection-monitoring-t4-t5-snapshot-note">{t("Snapshot de posição")}: {formatDate(summary.snapshotDate, language)} · {t("As contagens por status são independentes e não representam pedidos únicos.")}</p>

      <section className="collection-monitoring-t4-t5-card">
        <div className="collection-monitoring-t4-t5-section-heading"><div><h2>{t("Total por Regional e Status")}</h2><p>{t("A barra mostra a composição das contagens registradas; as etapas podem se sobrepor.")}</p></div><span>{t("Sem regional")}: {number(totals.unmappedRecords)} {t("registros")}</span></div>
        <div className="collection-monitoring-t4-t5-status-list">
          {regionalRows.map((row, index) => {
            const composition = statusSum(row);
            return <div className="collection-monitoring-t4-t5-status-row" key={`${row.regional_name}-${index}`}>
              <div><strong>{String(row.regional_name ?? "Sem regional")}</strong><small>{t("{count} PDDs", { count: number(row.distinct_pdds) })} · {t("{count} lojas", { count: number(row.distinct_stores) })}</small></div>
              <strong>{number(row.record_count)} {t("registros")}</strong>
              <div className="collection-monitoring-t4-t5-track" aria-label={t("Composição das contagens por status")}><div>{STATUS_FIELDS.map((field, colorIndex) => <span key={field} style={{ width: `${composition ? Number(row[field] ?? 0) / composition * 100 : 0}%`, background: statusColors[colorIndex] }} />)}</div></div>
              <div className="collection-monitoring-t4-t5-legend">{STATUS_FIELDS.map((field, colorIndex) => <span key={field}><i style={{ background: statusColors[colorIndex] }} />{t(STATUS_LABELS[field])}: {number(row[field])}</span>)}</div>
            </div>;
          })}
        </div>
      </section>

      <section className="collection-monitoring-t4-t5-card">
        <div className="collection-monitoring-t4-t5-tabs" role="tablist" aria-label={t("Agrupamentos do monitoramento")}>
          {groups.map((group) => <button type="button" role="tab" aria-selected={activeGroup === group.id} className={activeGroup === group.id ? "active" : ""} onClick={() => { setActiveGroup(group.id); setGroupPage(1); }} key={group.id}>{t(group.label)}</button>)}
        </div>
        <GroupTable dimension={activeGroup} rows={groupRows} total={groupTotal} page={groupPage} setPage={setGroupPage} loading={groupLoading} language={language} t={t} />
      </section>

      <section className="collection-monitoring-t4-t5-card collection-monitoring-t4-t5-detail">
        <div className="collection-monitoring-t4-t5-section-heading"><div><h2>{t("Dados detalhados T4 e T5")}</h2><p>{t("Todas as 15 colunas originais, com paginação no servidor.")}</p></div><button type="button" className="collection-monitoring-t4-t5-button export" disabled={exporting || recordTotal === 0} onClick={() => void downloadExcel()}><Download size={15} />{exporting ? t("Gerando Excel…") : t("Baixar Excel")}</button></div>
        <div className="collection-monitoring-t4-t5-toolbar"><label><span>{t("Pesquisar")}</span><input type="search" value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder={t("Buscar cliente, loja, PDD ou motorista")} /></label><span>{number(recordTotal)} {t("registros filtrados")}</span></div>
        <div className="collection-monitoring-t4-t5-table-scroll"><table className="collection-monitoring-t4-t5-table collection-monitoring-t4-t5-raw-table"><thead><tr>{COLUMNS.map(([key, label]) => <th key={key}>{t(label)}</th>)}</tr></thead><tbody>
          {records.map((record, index) => <tr key={`${record.publication_id}-${record.source_row_no ?? index}`}>{COLUMNS.map(([key]) => <td key={key} className={STATUS_FIELDS.includes(key as (typeof STATUS_FIELDS)[number]) ? "number-cell" : key === "data_date" ? "date-cell" : ""}>{STATUS_FIELDS.includes(key as (typeof STATUS_FIELDS)[number]) ? number(record[key]) : key === "data_date" ? formatDate(record[key], language) : String(record[key] ?? "—")}</td>)}</tr>)}
          {records.length === 0 ? <tr><td colSpan={COLUMNS.length} className="collection-monitoring-t4-t5-empty">{t("Sem dados para os filtros selecionados.")}</td></tr> : null}
        </tbody></table></div>
        <div className="collection-monitoring-t4-t5-pagination"><span>{t("Página {page} de {pages}", { page: recordPage, pages: recordPages })} · {number(recordTotal)} {t("registros")}</span><div><button type="button" disabled={recordPage <= 1} onClick={() => changeRecordPage(recordPage - 1)}>{t("Anterior")}</button><button type="button" disabled={recordPage >= recordPages} onClick={() => changeRecordPage(recordPage + 1)}>{t("Próxima")}</button></div></div>
      </section>
    </> : null}
  </div>;
}
