"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Clock3, Filter, Layers3, Percent, ShieldCheck } from "lucide-react";
import { subscribeToProtectedApiAuthorizationFailure } from "../../lib/api-url.ts";
import { dashboardLocale, type DashboardLanguage, type DashboardTranslator } from "../../lib/i18n";
import {
  CollectionMonitoringV2LoadError,
  loadPublishedCollectionMonitoringV2,
} from "../../lib/data-foundation/collection-monitoring-v2.ts";
import {
  collectionMonitoringV2FilterOptions,
  filterCollectionMonitoringV2Rows,
  collectionMonitoringV2RowsForDate,
  latestCollectionMonitoringV2Snapshot,
  mapCollectionMonitoringV2Record,
  summarizeCollectionMonitoringV2,
  type CollectionMonitoringV2Filters,
  type CollectionMonitoringV2Row,
} from "../../lib/data-foundation/collection-monitoring-v2-dashboard.ts";

import { CollectionMonitoringV2RetentionTables } from "./collection-monitoring-v2-regional-retention.tsx";
import { DashboardLoadingSkeleton } from "./dashboard-loading-skeleton.tsx";

interface Props {
  t: DashboardTranslator;
  language: DashboardLanguage;
  scopeKey: string;
}

function errorText(error: unknown): string {
  return error instanceof CollectionMonitoringV2LoadError
    ? error.message
    : "Não foi possível carregar a publicação do Monitoramento de Coleta.";
}

type CollectionMonitoringV2Period = { dateFrom?: string; dateTo?: string };

type ExportCell = string | number | Date | null;

async function downloadRetentionWorkbook(
  regional: readonly (readonly ExportCell[])[],
  rm: readonly (readonly ExportCell[])[],
  period: CollectionMonitoringV2Filters,
): Promise<void> {
  const XLSXModule = await import("xlsx-js-style");
  const XLSX = XLSXModule.default ?? XLSXModule;
  const workbook = XLSX.utils.book_new();
  const append = (matrix: readonly (readonly ExportCell[])[], name: string, percentageColumns: readonly number[]) => {
    const worksheet = XLSX.utils.aoa_to_sheet(matrix.map((row) => [...row]));
    const headers = matrix[0] ?? [];
    worksheet["!cols"] = headers.map((header) => ({ wch: Math.min(32, Math.max(12, String(header ?? "").length + 3)) }));
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) headers.forEach((_, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === "number") cell.z = percentageColumns.includes(columnIndex) ? "0.0%" : "#,##0";
    });
    if (headers.length) worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: matrix.length - 1, c: headers.length - 1 } }) };
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  };
  const dateCount = Math.max(0, ((regional[0]?.length ?? 3) - 3) / 4 - 1);
  const datesInHeader = Math.max(0, Math.round(dateCount));
  append(regional, "Retenção por regional", retentionMeasurePercentColumns(datesInHeader));
  append(rm, "Retenção por RM", [5, 7, 9, 11]);
  XLSX.writeFile(workbook, `monitoramento-coleta-v2_${period.dateFrom || "inicio"}_${period.dateTo || "fim"}.xlsx`, { compression: true });
}

function retentionMeasurePercentColumns(dateCount: number): number[] {
  return Array.from({ length: 4 }, (_, measure) => 3 + measure * (dateCount + 1) + dateCount);
}

export function CollectionMonitoringV2Dashboard({ t, language, scopeKey }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [rows, setRows] = useState<CollectionMonitoringV2Row[]>([]);
  const [requestedPeriod, setRequestedPeriod] = useState<CollectionMonitoringV2Period | undefined>();
  const [loadedPeriod, setLoadedPeriod] = useState<CollectionMonitoringV2Period | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0, stage: "records" as "records" | "validation" });
  const [progressScope, setProgressScope] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CollectionMonitoringV2Filters>({});
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    activeRequest.current = controller;
    void loadPublishedCollectionMonitoringV2(requestedPeriod, undefined, controller.signal, {
      onProgress: (loaded, total, stage) => {
        if (active) {
          setProgressScope(scopeKey);
          setProgress({ loaded, total, stage });
        }
      },
    }).then((result) => {
      if (!active) return;
      const mapped = result.records.map(mapCollectionMonitoringV2Record);
      setRows(mapped);
      setLoadedPeriod(result.period);
      setFilters((current) => ({ ...current, dateFrom: result.period.dateFrom, dateTo: result.period.dateTo }));
      setLoadedScope(scopeKey);
      setStatus(mapped.length ? "ready" : "empty");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setLoadedScope((current) => current === scopeKey ? current : scopeKey);
      if (cause instanceof CollectionMonitoringV2LoadError && cause.kind === "empty") {
        setStatus("empty");
        setError(cause.message);
      } else {
        setStatus("error");
        setError(errorText(cause));
      }
    });
    return () => {
      active = false;
      controller.abort();
      if (activeRequest.current === controller) activeRequest.current = null;
    };
  }, [scopeKey, reload, requestedPeriod]);

  useEffect(() => subscribeToProtectedApiAuthorizationFailure(() => {
    activeRequest.current?.abort();
    setRows([]);
    setLoadedPeriod(null);
    setLoadedScope(scopeKey);
    setStatus("error");
    setError(t("O acesso aos dados mudou. Atualize a autorização para continuar."));
  }), [scopeKey, t]);

  const hasPreviousRows = loadedScope === scopeKey && rows.length > 0;
  const showingPreviousRows = hasPreviousRows && (status === "loading" || status === "error");
  const appliedFilters = useMemo(() => showingPreviousRows
    ? { ...filters, dateFrom: loadedPeriod?.dateFrom, dateTo: loadedPeriod?.dateTo }
    : filters, [filters, loadedPeriod, showingPreviousRows]);
  const periodRows = useMemo(() => filterCollectionMonitoringV2Rows(rows, {
    dateFrom: appliedFilters.dateFrom,
    dateTo: appliedFilters.dateTo,
  }), [rows, appliedFilters.dateFrom, appliedFilters.dateTo]);
  const options = useMemo(() => collectionMonitoringV2FilterOptions(periodRows), [periodRows]);
  const filteredRows = useMemo(() => filterCollectionMonitoringV2Rows(rows, appliedFilters), [rows, appliedFilters]);
  const retentionPublicationSignature = useMemo(() => {
    const dates = new Set([...new Set(filteredRows.map((row) => String(row.data_date).slice(0, 10)))].sort().slice(-3));
    const counts = new Map<string, number>();
    for (const row of filteredRows) if (dates.has(String(row.data_date).slice(0, 10))) {
      const key = `${String(row.data_date).slice(0, 10)}:${row.publication_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return JSON.stringify([...counts].map(([key, count]) => `${key}:${count}`).sort());
  }, [filteredRows]);
  const currentSnapshot = useMemo(() => latestCollectionMonitoringV2Snapshot(periodRows), [periodRows]);
  const currentRows = useMemo(() => collectionMonitoringV2RowsForDate(filteredRows, currentSnapshot.date ?? undefined), [filteredRows, currentSnapshot.date]);
  const metrics = useMemo(() => summarizeCollectionMonitoringV2(currentRows), [currentRows]);
  function updateFilter<K extends keyof CollectionMonitoringV2Filters>(key: K, value: CollectionMonitoringV2Filters[K]) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    if (key === "dateFrom" || key === "dateTo") {
      activeRequest.current?.abort();
      setStatus("loading");
      setError(null);
      setProgress({ loaded: 0, total: 0, stage: "records" });
      setProgressScope(null);
      setRequestedPeriod({ dateFrom: next.dateFrom, dateTo: next.dateTo });
    }
  }

  function clearFilters() {
    if (requestedPeriod) {
      activeRequest.current?.abort();
      setStatus("loading");
      setError(null);
      setProgress({ loaded: 0, total: 0, stage: "records" });
      setProgressScope(null);
      setRequestedPeriod(undefined);
      setFilters({});
      return;
    }
    setFilters({ dateFrom: filters.dateFrom, dateTo: filters.dateTo });
  }

  const dateFilters = <>
    <label className="collection-monitoring-v2-filter"><span>{t("Data inicial")}</span><input type="date" value={filters.dateFrom ?? ""} onChange={(event) => updateFilter("dateFrom", event.target.value || undefined)} /></label>
    <label className="collection-monitoring-v2-filter"><span>{t("Data final")}</span><input type="date" value={filters.dateTo ?? ""} onChange={(event) => updateFilter("dateTo", event.target.value || undefined)} /></label>
  </>;

  const percent = (value: number | null) => value === null
    ? "—"
    : new Intl.NumberFormat(dashboardLocale(language), { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const number = (value: number) => new Intl.NumberFormat(dashboardLocale(language), { maximumFractionDigits: 0 }).format(value);

  const regionFiltered = rows.filter((row) => !filters.region || row.region === filters.region);
  const rmFiltered = regionFiltered.filter((row) => !filters.rm || row.rm === filters.rm);
  const areaFiltered = rmFiltered.filter((row) => !filters.rmArea || row.rmArea === filters.rmArea);
  const rgmFiltered = areaFiltered.filter((row) => !filters.rgm || row.rgm === filters.rgm);
  const select = (key: keyof CollectionMonitoringV2Filters, label: string, values: readonly string[]) => (
    <label className="collection-monitoring-v2-filter" key={key}>
      <span>{t(label)}</span>
      <select value={String(filters[key] ?? "")} onChange={(event) => updateFilter(key, event.target.value || undefined)}>
        <option value="">{t("Todos")}</option>
        {values.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
  );

  const periodSelector = <div className="collection-monitoring-v2-filter-grid">{dateFilters}</div>;
  if (status === "error" && !hasPreviousRows) return <div><DashboardLoadingSkeleton t={t} message="Carregando publicação do Monitoramento de Coleta…" error={error} onRetry={() => { activeRequest.current?.abort(); setStatus("loading"); setError(null); setProgress({ loaded: 0, total: 0, stage: "records" }); setProgressScope(null); setReload((value) => value + 1); }} />{periodSelector}</div>;
  if (status === "loading" && !hasPreviousRows || loadedScope !== scopeKey) return <DashboardLoadingSkeleton t={t} message={progressScope === scopeKey && progress.stage === "validation" ? "Validando a consistência da publicação…" : progressScope === scopeKey && progress.total > 0 ? "Carregando registros publicados…" : "Carregando publicação do Monitoramento de Coleta…"} progress={progressScope === scopeKey ? progress : null} />;
  if (status === "empty") return <section className="collection-monitoring-v2-state"><Activity size={20} /><h1>{t("Monitoramento de Coleta")}</h1><p>{error ? t(error) : t("Aguardando primeira importação.")}</p>{periodSelector}</section>;

  const kpis = [
    { title: "Previsto a coletar", value: number(metrics.planned), Icon: Layers3 },
    { title: "Aguardando coleta", value: number(metrics.awaiting), Icon: Activity },
    { title: "Taxa de coleta", value: percent(metrics.collectionRate), Icon: Percent },
    { title: "Taxa de pedidos aguardando coleta", value: percent(metrics.awaitingRate), Icon: Clock3 },
  ];

  return <div className="collection-monitoring-v2" data-testid="collection-monitoring-v2-dashboard">
    {showingPreviousRows ? <DashboardLoadingSkeleton compact t={t} message={status === "error" ? "A atualização falhou" : "Atualizando os dados do dashboard…"} previousDataLabel={`${loadedPeriod?.dateFrom ?? ""}${loadedPeriod?.dateTo && loadedPeriod.dateTo !== loadedPeriod.dateFrom ? ` a ${loadedPeriod.dateTo}` : ""}`} error={status === "error" ? error : null} onRetry={status === "error" ? () => { setStatus("loading"); setError(null); setProgress({ loaded: 0, total: 0, stage: "records" }); setProgressScope(null); setReload((value) => value + 1); } : undefined} progress={progressScope === scopeKey ? progress : null} /> : null}
    <section className="collection-monitoring-v2-filters collection-monitoring-v2-card" aria-label={t("Filtros operacionais")}>
      <div className="collection-monitoring-v2-section-heading"><h2><Filter size={17} /> {t("Filtros operacionais")}</h2><button type="button" className="reset-button" onClick={clearFilters}>{t("Limpar filtros")}</button></div>
      <div className="collection-monitoring-v2-filter-grid collection-monitoring-v2-main-filter-grid">
        {select("region", "Regional", options.regions)}
        {select("rm", "RM", [...new Set(rmFiltered.map((row) => row.rm))].sort())}
        {select("base", "Base / PDD", [...new Set(rgmFiltered.map((row) => row.base))].sort())}
        {dateFilters}
        <label className="collection-monitoring-v2-filter collection-monitoring-v2-status-filter">
          <span>{t("Status")}</span>
          <select aria-label={`${t("Status")} — ${t("Pendente de mapeamento")}`} disabled value="pending"><option value="pending">{t("Pendente de mapeamento")}</option></select>
          <small>{t("Filtro indisponível até a aprovação do mapeamento categórico do JMS.")}</small>
        </label>
        {select("origin", "Origem do pedido", options.origins)}
      </div>
      <details className="collection-monitoring-v2-advanced-filters">
        <summary>{t("Filtros adicionais")}</summary>
        <div className="collection-monitoring-v2-filter-grid collection-monitoring-v2-advanced-filter-grid">
          {select("rmArea", "Região do RM", [...new Set(rmFiltered.map((row) => row.rmArea))].sort())}
          {select("rgm", "RGM", [...new Set(areaFiltered.map((row) => row.rgm))].sort())}
        </div>
      </details>
      <p className="collection-monitoring-v2-mapping-note"><ShieldCheck size={15} /> {t("Regional e responsáveis vêm somente do DoomsDay publicado; linhas sem vínculo permanecem nos totais nacionais autorizados como Sem regional.")}</p>
    </section>
    <CollectionMonitoringV2RetentionTables t={t} language={language} filters={filters} scopeKey={scopeKey} expectedPublicationSignature={retentionPublicationSignature} rgmRegions={filters.rgm ? [...new Set(periodRows.filter((row) => row.rgm === filters.rgm).map((row) => row.region))] : undefined}
      onExport={(regional, rm) => { if (status === "ready") void downloadRetentionWorkbook(regional, rm, filters); }} exportDisabled={status !== "ready"} />
    <section className="collection-monitoring-v2-kpis" aria-label={t("Indicadores principais")}>
      {kpis.map(({ title, value, Icon }) => <article className="collection-monitoring-v2-kpi" key={title} data-testid="collection-monitoring-v2-kpi"><div className="collection-monitoring-v2-kpi-heading"><span>{t(title)}</span><Icon size={19} aria-hidden="true" /></div><strong>{value}</strong><small>{t("Regra baseada nas colunas oficiais da fonte")}</small></article>)}
    </section>
  </div>;
}
