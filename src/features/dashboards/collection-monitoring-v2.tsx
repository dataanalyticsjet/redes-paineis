"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, BarChart3, CalendarDays, Clock3, Database, Download, Filter, Layers3, MapPin, Percent, RefreshCw, ShieldCheck } from "lucide-react";
import { subscribeToProtectedApiAuthorizationFailure } from "../../lib/api-url.ts";
import { dashboardLocale, type DashboardLanguage, type DashboardTranslator } from "../../lib/i18n";
import {
  COLLECTION_MONITORING_V2_COLUMNS,
  COLLECTION_MONITORING_V2_HEADERS,
  CollectionMonitoringV2LoadError,
  loadPublishedCollectionMonitoringV2,
} from "../../lib/data-foundation/collection-monitoring-v2.ts";
import {
  collectionMonitoringV2FilterOptions,
  collectionMonitoringV2BaseDetailMatrix,
  collectionMonitoringV2RegionalSummaryMatrix,
  collectionMonitoringV2RmSummaryMatrix,
  COLLECTION_MONITORING_V2_STATUS_FIELDS,
  collectionMonitoringV2RegionalStatusGroups,
  filterCollectionMonitoringV2Rows,
  formatCollectionMonitoringV2Value,
  groupCollectionMonitoringV2BaseDetails,
  groupCollectionMonitoringV2Rows,
  collectionMonitoringV2RowsForDate,
  latestCollectionMonitoringV2Snapshot,
  mapCollectionMonitoringV2Record,
  summarizeCollectionMonitoringV2,
  collectionMonitoringV2ExcelMatrix,
  type CollectionMonitoringV2BaseDetail,
  type CollectionMonitoringV2Filters,
  type CollectionMonitoringV2Group,
  type CollectionMonitoringV2Row,
  type CollectionMonitoringV2StatusField,
} from "../../lib/data-foundation/collection-monitoring-v2-dashboard.ts";

import { CollectionMonitoringV2RegionalRetention } from "./collection-monitoring-v2-regional-retention.tsx";

interface Props {
  t: DashboardTranslator;
  language: DashboardLanguage;
  scopeKey: string;
}

const PAGE_SIZE = 25;

function errorText(error: unknown): string {
  return error instanceof CollectionMonitoringV2LoadError
    ? error.message
    : "Não foi possível carregar a publicação do Monitoramento de Coleta.";
}

type CollectionMonitoringV2Period = { dateFrom?: string; dateTo?: string };

type ExportCell = string | number | Date | null;

async function downloadMatrixExcel(
  matrix: readonly (readonly ExportCell[])[],
  filename: string,
  sheetName: string,
  percentageColumns: readonly number[] = [],
): Promise<void> {
  const XLSXModule = await import("xlsx-js-style");
  const XLSX = XLSXModule.default ?? XLSXModule;
  const worksheet = XLSX.utils.aoa_to_sheet(matrix.map((row) => [...row]));
  const headers = matrix[0] ?? [];
  worksheet["!cols"] = headers.map((header) => ({ wch: Math.min(32, Math.max(12, String(header ?? "").length + 3)) }));
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    headers.forEach((_, columnIndex) => {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[address];
      if (cell && typeof cell.v === "number") cell.z = percentageColumns.includes(columnIndex) ? "0.00%" : "#,##0";
    });
  }
  if (matrix.length > 0 && headers.length > 0) {
    worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: matrix.length - 1, c: headers.length - 1 } }) };
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename, { compression: true });
}

function groupIdentity(group: ReturnType<typeof groupCollectionMonitoringV2Rows>[number], dimension: "region" | "rm"): string {
  return dimension === "region" ? group.region : `${group.rmArea}\u0000${group.rm}\u0000${group.region}`;
}

async function downloadExcel(
  rows: readonly CollectionMonitoringV2Row[],
  period: CollectionMonitoringV2Filters,
  baseDetails: readonly CollectionMonitoringV2BaseDetail[],
  t: DashboardTranslator,
  additionalTables: readonly { name: string; matrix: readonly (readonly ExportCell[])[]; percentageColumns?: readonly number[] }[] = [],
): Promise<void> {
  const XLSXModule = await import("xlsx-js-style");
  const XLSX = XLSXModule.default ?? XLSXModule;
  const workbook = XLSX.utils.book_new();
  const summaryWorksheet = XLSX.utils.aoa_to_sheet(collectionMonitoringV2BaseDetailMatrix(baseDetails, t));
  summaryWorksheet["!cols"] = [13, 16, 28, 20, 24, 22, 20, 20, 16, 16].map((wch) => ({ wch }));
  if (baseDetails.length > 0) {
    summaryWorksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: baseDetails.length, c: 9 } }) };
  }
  for (let rowIndex = 1; rowIndex <= baseDetails.length; rowIndex += 1) {
    for (const columnIndex of [6, 7, 8, 9]) {
      const cell = summaryWorksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell) cell.z = "#,##0";
    }
  }
  XLSX.utils.book_append_sheet(workbook, summaryWorksheet, "Resumo por base");
  const worksheet = XLSX.utils.aoa_to_sheet(collectionMonitoringV2ExcelMatrix(rows));
  worksheet["!cols"] = COLLECTION_MONITORING_V2_COLUMNS.map((key) => ({ wch: key === "data_date" ? 13 : 22 }));
  for (let rowIndex = 1; rowIndex <= rows.length; rowIndex += 1) {
    COLLECTION_MONITORING_V2_COLUMNS.forEach((key, columnIndex) => {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[address];
      if (!cell) return;
      if (key === "data_date") cell.z = "dd/mm/yyyy";
      else if (["seller_collection_rate", "collection_visit_rate"].includes(key)) cell.z = "0.00%";
      else if (typeof cell.v === "number") cell.z = "#,##0";
    });
  }
  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: COLLECTION_MONITORING_V2_COLUMNS.length - 1 } }) };
  XLSX.utils.book_append_sheet(workbook, worksheet, "Dados");
  for (const table of additionalTables) {
    const sheet = XLSX.utils.aoa_to_sheet(table.matrix.map((row) => [...row]));
    sheet["!cols"] = (table.matrix[0] ?? []).map(() => ({ wch: 22 }));
    for (let index = 1; index < table.matrix.length; index += 1) {
      for (const column of table.percentageColumns ?? []) {
        const cell = sheet[XLSX.utils.encode_cell({ r: index, c: column })];
        if (cell && typeof cell.v === "number") cell.z = "0.0%";
      }
    }
    XLSX.utils.book_append_sheet(workbook, sheet, table.name);
  }
  XLSX.writeFile(workbook, `monitoramento-coleta-v2_${period.dateFrom || "inicio"}_${period.dateTo || "fim"}.xlsx`, { compression: true });
}

export function CollectionMonitoringV2Dashboard({ t, language, scopeKey }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [rows, setRows] = useState<CollectionMonitoringV2Row[]>([]);
  const [requestedPeriod, setRequestedPeriod] = useState<CollectionMonitoringV2Period | undefined>();
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [progressScope, setProgressScope] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publicationCount, setPublicationCount] = useState(0);
  const [filters, setFilters] = useState<CollectionMonitoringV2Filters>({});
  const [query, setQuery] = useState("");
  const [detailQuery, setDetailQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailPage, setDetailPage] = useState(1);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    activeRequest.current = controller;
    void loadPublishedCollectionMonitoringV2(requestedPeriod, undefined, controller.signal, {
      onProgress: (loaded, total) => {
        if (active) {
          setProgressScope(scopeKey);
          setProgress({ loaded, total });
        }
      },
    }).then((result) => {
      if (!active) return;
      const mapped = result.records.map(mapCollectionMonitoringV2Record);
      setRows(mapped);
      setPublishedAt(result.publishedAt);
      setPublicationCount(result.publicationIds.length);
      setFilters((current) => ({ ...current, dateFrom: result.period.dateFrom, dateTo: result.period.dateTo }));
      setLoadedScope(scopeKey);
      setStatus(mapped.length ? "ready" : "empty");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setRows([]);
      setLoadedScope(scopeKey);
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
    setLoadedScope(scopeKey);
    setStatus("error");
    setError(t("O acesso aos dados mudou. Atualize a autorização para continuar."));
  }), [scopeKey, t]);

  const periodRows = useMemo(() => filterCollectionMonitoringV2Rows(rows, {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  }), [rows, filters.dateFrom, filters.dateTo]);
  const options = useMemo(() => collectionMonitoringV2FilterOptions(periodRows), [periodRows]);
  const filteredRows = useMemo(() => filterCollectionMonitoringV2Rows(rows, filters), [rows, filters]);
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
  const byRegion = useMemo(() => groupCollectionMonitoringV2Rows(currentRows, "region"), [currentRows]);
  const byRm = useMemo(() => groupCollectionMonitoringV2Rows(currentRows, "rm"), [currentRows]);
  const regionalStatusGroups = useMemo(() => collectionMonitoringV2RegionalStatusGroups(currentRows), [currentRows]);
  const baseDetails = useMemo(() => groupCollectionMonitoringV2BaseDetails(filteredRows), [filteredRows]);
  const visibleBaseDetails = useMemo(() => {
    const needle = detailQuery.trim().toLocaleLowerCase(dashboardLocale(language));
    const matched = needle ? baseDetails.filter((row) => [
      row.period, row.region, row.base, row.origin, row.rmArea, row.rm, row.rgm,
    ].some((value) => value.toLocaleLowerCase(dashboardLocale(language)).includes(needle))) : baseDetails;
    const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
    const activePage = Math.min(detailPage, pageCount);
    return { matched, pageCount, activePage, rows: matched.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE) };
  }, [baseDetails, detailPage, detailQuery, language]);
  const currentMappedBaseCount = useMemo(() => new Set(currentRows
    .filter((row) => row.mappingConfirmed && row.baseCode !== "—")
    .map((row) => row.baseCode)).size, [currentRows]);
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(dashboardLocale(language));
    const matched = needle ? filteredRows.filter((row) => COLLECTION_MONITORING_V2_COLUMNS.some((key) => String(row[key] ?? "").toLocaleLowerCase(dashboardLocale(language)).includes(needle))) : filteredRows;
    const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
    const activePage = Math.min(page, pageCount);
    return { matched, pageCount, activePage, rows: matched.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE) };
  }, [filteredRows, language, page, query]);
  const maxRegionalStatusTotal = Math.max(0, ...regionalStatusGroups.map((group) => group.componentTotal));

  function updateFilter<K extends keyof CollectionMonitoringV2Filters>(key: K, value: CollectionMonitoringV2Filters[K]) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    setPage(1);
    setDetailPage(1);
    if (key === "dateFrom" || key === "dateTo") {
      activeRequest.current?.abort();
      setRows([]);
      setLoadedScope(null);
      setStatus("loading");
      setError(null);
      setProgress({ loaded: 0, total: 0 });
      setProgressScope(null);
      setRequestedPeriod({ dateFrom: next.dateFrom, dateTo: next.dateTo });
    }
  }

  function clearFilters() {
    setQuery("");
    setDetailQuery("");
    setPage(1);
    setDetailPage(1);
    if (requestedPeriod) {
      activeRequest.current?.abort();
      setRows([]);
      setLoadedScope(null);
      setStatus("loading");
      setError(null);
      setProgress({ loaded: 0, total: 0 });
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

  const comparisonTable = (title: string, groups: CollectionMonitoringV2Group[], dimension: "rm") => {
    const orderedGroups = [...groups].sort((left, right) => left.rmArea.localeCompare(right.rmArea, dashboardLocale(language)) || left.rm.localeCompare(right.rm, dashboardLocale(language)) || left.region.localeCompare(right.region, dashboardLocale(language)));
    return <section className="collection-monitoring-v2-card collection-monitoring-v2-retention-card" key={title}>
      <div className="collection-monitoring-v2-section-heading">
        <div><h2>{t(title)}</h2><p>{t("Taxas usam volume previsto como denominador provisório. Retenção total soma etapas e não representa necessariamente encomendas únicas.")}</p></div>
        <span>{number(orderedGroups.length)} {t("grupos")}</span>
      </div>
      <div className="collection-monitoring-v2-table-scroll collection-monitoring-v2-retention-scroll">
        <table className="collection-monitoring-v2-table collection-monitoring-v2-retention-table">
          <thead><tr>
            <th>{t("Região do RM")}</th><th>RM</th><th>RGM</th><th>{t("Volume previsto")}</th>
            <th>{t("Retenção total")}</th><th>{t("Taxa de retenção")}</th>
            <th>{t("Retido na base")}</th><th>{t("Taxa")}</th>
            <th>{t("Despachado pela base")}</th><th>{t("Taxa")}</th>
            <th>{t("Chegado ao centro")}</th><th>{t("Taxa")}</th>
          </tr></thead>
          <tbody>{orderedGroups.map((group) => <tr key={`${groupIdentity(group, dimension)}:${group.label}`}>
            <td>{group.rmArea}</td><td>{group.rm}</td><td>{group.rgm}</td><td className="number-cell">{number(group.planned)}</td>
            <td className="number-cell">{number(group.retentionTotal)}</td><td className="number-cell">{percent(group.retentionRate)}</td>
            <td className="number-cell">{number(group.retainedAtBase)}</td><td className="number-cell">{percent(group.retainedAtBaseRate)}</td>
            <td className="number-cell">{number(group.dispatchedFromBase)}</td><td className="number-cell">{percent(group.dispatchedFromBaseRate)}</td>
            <td className="number-cell">{number(group.arrivedAtCenter)}</td><td className="number-cell">{percent(group.arrivedAtCenterRate)}</td>
          </tr>)}</tbody>
        </table>
        {orderedGroups.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum grupo encontrado para os filtros selecionados.")}</p> : null}
      </div>
    </section>;
  };

  const regionalSummaryMatrix = collectionMonitoringV2RegionalSummaryMatrix(byRegion, metrics, currentMappedBaseCount, t);
  const rmSummaryMatrix = collectionMonitoringV2RmSummaryMatrix(byRm, metrics, currentMappedBaseCount, t);
  const downloadRegionalSummary = () => void downloadMatrixExcel(
    regionalSummaryMatrix,
    "monitoramento-coleta-v2_por-regional.xlsx",
    "Por regional",
    [6, 7],
  );
  const downloadRmSummary = () => void downloadMatrixExcel(
    rmSummaryMatrix,
    "monitoramento-coleta-v2_por-rm.xlsx",
    "Por RM",
    [7, 8],
  );
  const statusColors: Record<CollectionMonitoringV2StatusField, string> = {
    status_received_at_base: "#d71920",
    status_dispatched_from_base: "#f28e2b",
    arrived_sorting_center: "#61758a",
  };
  const statusBaseCount = regionalStatusGroups.reduce((sum, group) => sum + group.basesWithMovement, 0);

  const monitoringTable = (
    title: string,
    dimension: "region" | "rm",
    groups: readonly CollectionMonitoringV2Group[],
    matrix: readonly (readonly ExportCell[])[],
    onDownload: () => void,
  ) => <section className="collection-monitoring-v2-card collection-monitoring-v2-summary-card" aria-label={t(title)}>
    <div className="collection-monitoring-v2-section-heading">
      <div><h2>{t(title)}</h2><p>{t("Valores do último snapshot publicado dentro do intervalo selecionado.")}</p></div>
      <div className="collection-monitoring-v2-summary-actions"><span>{formatShortDate(currentSnapshot.date ?? undefined)}</span><button type="button" className="collection-monitoring-v2-export" onClick={onDownload} disabled={groups.length === 0}><Download size={15} /> {t("Baixar Excel")}</button></div>
    </div>
    <div className="collection-monitoring-v2-table-scroll collection-monitoring-v2-summary-scroll">
      <table className="collection-monitoring-v2-table collection-monitoring-v2-summary-table">
        <thead><tr>{matrix[0]?.map((header, index) => <th key={`${String(header)}-${index}`}>{String(header ?? "")}</th>)}</tr></thead>
        <tbody>{groups.map((group) => <tr key={dimension === "region" ? group.region : groupIdentity(group, "rm")}>
          {dimension === "region" ? <>
            <td>{group.region}</td><td>{group.rgm}</td><td className="number-cell">{number(group.baseCount)}</td>
            <td className="number-cell">{number(group.planned)}</td><td className="number-cell">{number(group.awaiting)}</td><td className="number-cell">{number(group.collected)}</td>
            <td className="number-cell">{percent(group.collectionRate)}</td><td className="number-cell">{percent(group.awaitingRate)}</td>
          </> : <>
            <td>{group.rmArea}</td><td>{group.rm}</td><td>{group.rgm}</td><td className="number-cell">{number(group.baseCount)}</td>
            <td className="number-cell">{number(group.planned)}</td><td className="number-cell">{number(group.awaiting)}</td><td className="number-cell">{number(group.collected)}</td>
            <td className="number-cell">{percent(group.collectionRate)}</td><td className="number-cell">{percent(group.awaitingRate)}</td>
          </>}
        </tr>)}</tbody>
        <tfoot><tr>
          <th>{t("Total geral")}</th>{dimension === "region" ? <td>—</td> : <><td>—</td><td>—</td></>}
          <td className="number-cell">{number(currentMappedBaseCount)}</td><td className="number-cell">{number(metrics.planned)}</td><td className="number-cell">{number(metrics.awaiting)}</td><td className="number-cell">{number(metrics.collected)}</td><td className="number-cell">{percent(metrics.collectionRate)}</td><td className="number-cell">{percent(metrics.awaitingRate)}</td>
        </tr></tfoot>
      </table>
      {groups.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum grupo encontrado para os filtros selecionados.")}</p> : null}
    </div>
  </section>;

  const periodSelector = <div className="collection-monitoring-v2-filter-grid">{dateFilters}</div>;
  if (status === "loading" || loadedScope !== scopeKey) return <section className="collection-monitoring-v2-state" role="status"><RefreshCw size={18} className="collection-monitoring-v2-spinner" /><div><p>{t("Carregando publicação do Monitoramento de Coleta…")}</p>{progressScope === scopeKey && progress.total > 0 ? <p>{t("Carregando {loaded} de {total} registros do período…", { loaded: number(progress.loaded), total: number(progress.total) })}</p> : null}{periodSelector}</div></section>;
  if (status === "empty") return <section className="collection-monitoring-v2-state"><Activity size={20} /><h1>{t("Monitoramento de Coleta")}</h1><p>{error ? t(error) : t("Aguardando primeira importação.")}</p>{periodSelector}</section>;

  if (status === "error") return <section className="collection-monitoring-v2-state error" role="alert"><AlertCircle size={20} /><h1>{t("Monitoramento de Coleta")}</h1><p>{error ? t(error) : null}</p>{periodSelector}<button type="button" onClick={() => { activeRequest.current?.abort(); setRows([]); setLoadedScope(null); setStatus("loading"); setError(null); setProgress({ loaded: 0, total: 0 }); setProgressScope(null); setReload((value) => value + 1); }}>{t("Tentar novamente")}</button></section>;

  const mappedRows = rows.filter((row) => row.mappingConfirmed);
  const mappedRegionCount = new Set(mappedRows.map((row) => row.region).filter((region) => region !== "Sem regional")).size;
  const mappedBaseCount = new Set(mappedRows.map((row) => row.baseCode).filter((code) => code !== "—")).size;
  const latestSourceDate = rows.map((row) => String(row.data_date ?? "").slice(0, 10)).sort().at(-1);
  const formatShortDate = (date: string | undefined) => date
    ? new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00.000Z`))
    : t("Sem dados");
  const kpis = [
    { title: "Previsto a coletar", value: number(metrics.planned), Icon: Layers3 },
    { title: "Aguardando coleta", value: number(metrics.awaiting), Icon: Activity },
    { title: "Taxa de coleta", value: percent(metrics.collectionRate), Icon: Percent },
    { title: "Taxa de pedidos aguardando coleta", value: percent(metrics.awaitingRate), Icon: Clock3 },
  ];

  return <div className="collection-monitoring-v2" data-testid="collection-monitoring-v2-dashboard">
    <section className="dashboard-intro collection-monitoring-v2-intro">
      <div><div className="eyebrow"><Activity size={15} /> {t("Data Foundation V2")}</div><h1>{t("Monitoramento de Coleta")}</h1><p>{t("Resumo operacional por período, regional oficial, base e origem do pedido.")}</p></div>
      <div className="collection-monitoring-v2-meta" aria-label={t("Resumo da publicação")}>
        <span><Layers3 size={16} /><strong>{number(rows.length)}</strong>{t("Linhas")}</span>
        <span><MapPin size={16} /><strong>{number(mappedRegionCount)}</strong>{t("Regionais vinculadas")}</span>
        <span><Database size={16} /><strong>{number(mappedBaseCount)}</strong>{t("Bases vinculadas")}</span>
        <span><CalendarDays size={16} /><strong>{formatShortDate(latestSourceDate)}</strong>{t("Última data com dados")}</span>
        <span><Clock3 size={16} /><strong>{publishedAt ? new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: "short", timeStyle: "short" }).format(new Date(publishedAt)) : t("Publicação vigente")}</strong>{t("Publicada em")}</span>
        <span><Layers3 size={16} /><strong>{number(publicationCount)}</strong>{t("publicações no período")}</span>
      </div>
    </section>
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
    <CollectionMonitoringV2RegionalRetention t={t} language={language} filters={filters} scopeKey={scopeKey} expectedPublicationSignature={retentionPublicationSignature} rgmRegions={filters.rgm ? [...new Set(periodRows.filter((row) => row.rgm === filters.rgm).map((row) => row.region))] : undefined}
      onExport={(matrix) => void downloadExcel(filteredRows, filters, baseDetails, t, [
        { name: "Retenção por regional", matrix, percentageColumns: [0, 1, 2, 3].map((index) => 3 + (index + 1) * ((matrix[0].length - 3) / 4) - 1) },
        { name: "Monitoramento por regional", matrix: regionalSummaryMatrix, percentageColumns: [6, 7] },
        { name: "Monitoramento por RM", matrix: rmSummaryMatrix, percentageColumns: [7, 8] },
        { name: "Retenção por RM", matrix: [
          ["Região do RM", "RM", "RGM", "Volume previsto", "Retenção total", "Taxa de retenção", "Retido na base", "Taxa", "Despachado pela base", "Taxa", "Chegado ao centro", "Taxa"].map((label) => t(label)),
          ...byRm.map((group) => [group.rmArea, group.rm, group.rgm, group.planned, group.retentionTotal, group.retentionRate, group.retainedAtBase, group.retainedAtBaseRate, group.dispatchedFromBase, group.dispatchedFromBaseRate, group.arrivedAtCenter, group.arrivedAtCenterRate]),
        ], percentageColumns: [5, 7, 9, 11] },
        { name: "Total por regional e status", matrix: [
          ["Regional", "Retido na base", "Despachado pela base", "Chegado ao centro", "Retenção total"].map((label) => t(label)),
          ...regionalStatusGroups.map((group) => [group.region, group.retainedAtBase, group.dispatchedFromBase, group.arrivedAtCenter, group.retentionTotal]),
        ] },
      ])} />
    <p className="collection-monitoring-v2-formula-note" role="note">{t("As regras dos indicadores são operacionais provisórias e ainda não estão homologadas pelo JMS. A retenção total soma etapas e não representa necessariamente encomendas únicas.")}</p>
    <section className="collection-monitoring-v2-kpis" aria-label={t("Indicadores principais")}>
      {kpis.map(({ title, value, Icon }) => <article className="collection-monitoring-v2-kpi" key={title} data-testid="collection-monitoring-v2-kpi"><div className="collection-monitoring-v2-kpi-heading"><span>{t(title)}</span><Icon size={19} aria-hidden="true" /></div><strong>{value}</strong><small>{t("Regra operacional provisória")}</small></article>)}
    </section>
    <p className="collection-monitoring-v2-snapshot-note" role="status">{t("Snapshot de referência dos indicadores: {date}.", { date: formatShortDate(currentSnapshot.date ?? undefined) })}</p>
    <section className="collection-monitoring-v2-retention-grid" aria-label={t("Comparação de retenção")}>
      {comparisonTable("Retenção por RM", byRm, "rm")}
    </section>
    {monitoringTable("Monitoramento por regional", "region", byRegion, regionalSummaryMatrix, downloadRegionalSummary)}
    {monitoringTable("Monitoramento por RM", "rm", byRm, rmSummaryMatrix, downloadRmSummary)}
    <section className="collection-monitoring-v2-card collection-monitoring-v2-status-summary" aria-label={t("Total por regional e status")}>
      <div className="collection-monitoring-v2-section-heading">
        <div><h2><BarChart3 size={17} /> {t("Total por regional e status")}</h2><p>{t("A retenção total soma etapas e não representa necessariamente encomendas únicas.")}</p></div>
        <div className="collection-monitoring-v2-status-total"><span>{t("Bases com movimento")}</span><strong>{number(statusBaseCount)}</strong><small>{t("Retenção total")}: {number(metrics.retentionTotal)}</small></div>
      </div>
      <div className="collection-monitoring-v2-status-legend" aria-label={t("Componentes de retenção")}>
        {COLLECTION_MONITORING_V2_STATUS_FIELDS.map((field) => <span key={field}><i style={{ backgroundColor: statusColors[field] }} />{t(COLLECTION_MONITORING_V2_HEADERS[field])}</span>)}
      </div>
      <div className="collection-monitoring-v2-status-list">
        {regionalStatusGroups.map((group) => <article className="collection-monitoring-v2-status-row" key={group.region}>
          <div className="collection-monitoring-v2-status-region"><strong>{group.region}</strong><span>{t("{count} base(s) com movimento", { count: number(group.basesWithMovement) })}</span></div>
          <div className="collection-monitoring-v2-status-value"><strong>{number(group.retentionTotal)}</strong><small>{t("Retenção total")}</small></div>
          <div className="collection-monitoring-v2-status-track" aria-label={`${group.region}: ${number(group.retentionTotal)}`}>
            <div style={{ width: `${maxRegionalStatusTotal ? (group.componentTotal / maxRegionalStatusTotal) * 100 : 0}%` }}>
              {group.components.map((component) => <span key={component.field} style={{ width: `${group.componentTotal ? (component.value / group.componentTotal) * 100 : 0}%`, backgroundColor: statusColors[component.field] }} title={`${t(COLLECTION_MONITORING_V2_HEADERS[component.field])}: ${number(component.value)}`} />)}
            </div>
          </div>
          <div className="collection-monitoring-v2-status-values">
            {group.components.map((component) => <span key={component.field}><i style={{ backgroundColor: statusColors[component.field] }} />{t(COLLECTION_MONITORING_V2_HEADERS[component.field])}: {number(component.value)}</span>)}
          </div>
        </article>)}
        {regionalStatusGroups.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Não há regionais com movimento para os filtros selecionados.")}</p> : null}
      </div>
    </section>
    <section className="collection-monitoring-v2-card collection-monitoring-v2-detail" aria-label={t("Dados por base")}>
      <div className="collection-monitoring-v2-section-heading"><div><h2>{t("Dados por base")}</h2><p>{t("Detalhamento e Excel respeitam o intervalo selecionado; cards e valores atuais usam o último snapshot do intervalo.")}</p></div><button type="button" className="collection-monitoring-v2-export" onClick={() => void downloadExcel(filteredRows, filters, baseDetails, t)} disabled={filteredRows.length === 0}><Download size={16} /> {t("Baixar Excel")}</button></div>
      <div className="collection-monitoring-v2-toolbar"><label><span>{t("Pesquisar")}</span><input type="search" value={detailQuery} onChange={(event) => { setDetailQuery(event.target.value); setDetailPage(1); }} placeholder={t("Buscar base, regional, RM, RGM, origem ou período")} /></label><span>{number(visibleBaseDetails.matched.length)} {t("registros filtrados")}</span></div>
      <div className="collection-monitoring-v2-table-scroll collection-monitoring-v2-base-summary-scroll">
        <table className="collection-monitoring-v2-table collection-monitoring-v2-base-summary-table">
          <thead><tr>{["Período", "Regional", "Base", "Origem do pedido", "RM", "RGM", "Previsto a coletar", "Aguardando coleta", "Coletado", "Total"].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{visibleBaseDetails.rows.map((row, index) => <tr key={`${index}:${row.period}:${row.region}:${row.base}:${row.origin}:${row.rmArea}:${row.rm}:${row.rgm}`}>
            <td className="date-cell">{formatShortDate(row.period)}</td><td>{row.region}</td><td>{row.base}</td><td>{row.origin}</td>
            <td><span>{row.rm}</span>{row.rmArea !== "Sem região do RM" ? <small className="collection-monitoring-v2-rm-area">{row.rmArea}</small> : null}</td><td>{row.rgm}</td>
            <td className="number-cell">{number(row.planned)}</td><td className="number-cell">{number(row.awaiting)}</td><td className="number-cell">{number(row.collected)}</td><td className="number-cell">{number(row.total)}</td>
          </tr>)}</tbody>
        </table>
        {visibleBaseDetails.rows.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum registro encontrado para os filtros selecionados.")}</p> : null}
      </div>
      <div className="collection-monitoring-v2-pagination"><span>{t("Página {page} de {pages}", { page: visibleBaseDetails.activePage, pages: visibleBaseDetails.pageCount })} · {number(visibleBaseDetails.matched.length)} {t("registros")}</span><div><button type="button" onClick={() => setDetailPage((current) => Math.max(1, current - 1))} disabled={visibleBaseDetails.activePage <= 1}>{t("Anterior")}</button><button type="button" onClick={() => setDetailPage((current) => Math.min(visibleBaseDetails.pageCount, current + 1))} disabled={visibleBaseDetails.activePage >= visibleBaseDetails.pageCount}>{t("Próxima")}</button></div></div>
      <details className="collection-monitoring-v2-raw-source">
        <summary>{t("Dados originais da fonte (23 colunas)")} · {number(filteredRows.length)} {t("registros")}</summary>
        <div className="collection-monitoring-v2-toolbar"><label><span>{t("Pesquisar")}</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t("Pesquisar registros")} /></label><span>{number(filteredRows.length)} {t("registros filtrados")}</span></div>
        <div className="collection-monitoring-v2-table-scroll"><table className="collection-monitoring-v2-table collection-monitoring-v2-source-table"><thead><tr>{COLLECTION_MONITORING_V2_COLUMNS.map((key) => <th key={key}>{t(COLLECTION_MONITORING_V2_HEADERS[key])}</th>)}</tr></thead><tbody>{visibleRows.rows.map((row) => <tr key={`${row.publication_id}:${row.source_row_no}`}>{COLLECTION_MONITORING_V2_COLUMNS.map((key) => <td key={key} className={key === "data_date" ? "date-cell" : typeof row[key] === "number" || /^[\d.]+$/.test(String(row[key] ?? "")) ? "number-cell" : ""}>{formatCollectionMonitoringV2Value(row[key], key, dashboardLocale(language))}</td>)}</tr>)}</tbody></table>{visibleRows.rows.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum registro encontrado para os filtros selecionados.")}</p> : null}</div>
        <div className="collection-monitoring-v2-pagination"><span>{t("Página {page} de {pages}", { page: visibleRows.activePage, pages: visibleRows.pageCount })} · {number(visibleRows.matched.length)} {t("registros")}</span><div><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={visibleRows.activePage <= 1}>{t("Anterior")}</button><button type="button" onClick={() => setPage((current) => Math.min(visibleRows.pageCount, current + 1))} disabled={visibleRows.activePage >= visibleRows.pageCount}>{t("Próxima")}</button></div></div>
      </details>
    </section>
    <footer className="dashboard-footer"><span><ShieldCheck size={15} /> {t("Dados filtrados no backend conforme autorização Feishu.")}</span><span><CalendarDays size={15} /> {t("Publicação vigente · Contrato V2")}</span></footer>
  </div>;
}
