"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, CalendarDays, Download, Filter, RefreshCw, ShieldCheck } from "lucide-react";
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
  filterCollectionMonitoringV2Rows,
  formatCollectionMonitoringV2Value,
  groupCollectionMonitoringV2Rows,
  mapCollectionMonitoringV2Record,
  summarizeCollectionMonitoringV2,
  collectionMonitoringV2ExcelMatrix,
  type CollectionMonitoringV2Filters,
  type CollectionMonitoringV2Row,
} from "../../lib/data-foundation/collection-monitoring-v2-dashboard.ts";

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

async function downloadExcel(rows: readonly CollectionMonitoringV2Row[], period: CollectionMonitoringV2Filters): Promise<void> {
  const XLSXModule = await import("xlsx-js-style");
  const XLSX = XLSXModule.default ?? XLSXModule;
  const workbook = XLSX.utils.book_new();
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
  XLSX.writeFile(workbook, `monitoramento-coleta-v2_${period.dateFrom || "inicio"}_${period.dateTo || "fim"}.xlsx`, { compression: true });
}

export function CollectionMonitoringV2Dashboard({ t, language, scopeKey }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [rows, setRows] = useState<CollectionMonitoringV2Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publicationCount, setPublicationCount] = useState(0);
  const [filters, setFilters] = useState<CollectionMonitoringV2Filters>({});
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void loadPublishedCollectionMonitoringV2(undefined, undefined, controller.signal).then((result) => {
      if (!active) return;
      const mapped = result.records.map(mapCollectionMonitoringV2Record);
      setRows(mapped);
      setPublishedAt(result.publishedAt);
      setPublicationCount(result.publicationIds.length);
      setFilters({ dateFrom: result.period.dateFrom, dateTo: result.period.dateTo });
      setStatus(mapped.length ? "ready" : "empty");
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setRows([]);
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
    };
  }, [scopeKey, reload]);

  useEffect(() => subscribeToProtectedApiAuthorizationFailure(() => {
    setRows([]);
    setStatus("error");
    setError(t("O acesso aos dados mudou. Atualize a autorização para continuar."));
  }), [t]);

  const options = useMemo(() => collectionMonitoringV2FilterOptions(rows), [rows]);
  const filteredRows = useMemo(() => filterCollectionMonitoringV2Rows(rows, filters), [rows, filters]);
  const metrics = useMemo(() => summarizeCollectionMonitoringV2(filteredRows), [filteredRows]);
  const byRegion = useMemo(() => groupCollectionMonitoringV2Rows(filteredRows, "region"), [filteredRows]);
  const byRm = useMemo(() => groupCollectionMonitoringV2Rows(filteredRows, "rm"), [filteredRows]);
  const byBase = useMemo(() => groupCollectionMonitoringV2Rows(filteredRows, "base"), [filteredRows]);
  const daily = useMemo(() => {
    const grouped = new Map<string, CollectionMonitoringV2Row[]>();
    for (const row of filteredRows) {
      const date = String(row.data_date).slice(0, 10);
      grouped.set(date, [...(grouped.get(date) ?? []), row]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dayRows]) => ({ date, ...summarizeCollectionMonitoringV2(dayRows) }));
  }, [filteredRows]);
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(dashboardLocale(language));
    const matched = needle ? filteredRows.filter((row) => COLLECTION_MONITORING_V2_COLUMNS.some((key) => String(row[key] ?? "").toLocaleLowerCase(dashboardLocale(language)).includes(needle))) : filteredRows;
    const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
    const activePage = Math.min(page, pageCount);
    return { matched, pageCount, activePage, rows: matched.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE) };
  }, [filteredRows, language, page, query]);

  function updateFilter<K extends keyof CollectionMonitoringV2Filters>(key: K, value: CollectionMonitoringV2Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

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

  const summaryTable = (title: string, groups: ReturnType<typeof groupCollectionMonitoringV2Rows>, includeRm: boolean, dimension: "region" | "rm" | "base") => (
    <section className="collection-monitoring-v2-card" key={title}>
      <div className="collection-monitoring-v2-section-heading"><h2>{t(title)}</h2><span>{number(groups.length)} {t("grupos")}</span></div>
      <div className="collection-monitoring-v2-table-scroll">
        <table className="collection-monitoring-v2-table">
          <thead><tr>
            <th>{t("Regional")}</th>{includeRm ? <><th>{t("Região do RM")}</th><th>RM</th></> : null}<th>RGM</th>{!includeRm ? <th>{t("Bases vinculadas")}</th> : null}<th>{t("Previsto")}</th><th>{t("Aguardando")}</th><th>{t("Taxa de coleta")}</th><th>{t("Taxa aguardando")}</th>
          </tr></thead>
          <tbody>{groups.map((group) => <tr key={`${group.label}:${group.region}:${group.rmArea}:${group.rm}`}>
            <td>{dimension === "base" ? group.label : group.region}</td>{includeRm ? <><td>{group.rmArea}</td><td>{group.rm}</td></> : null}<td>{group.rgm}</td>{!includeRm ? <td>{number(group.baseCount)}</td> : null}<td className="number-cell">{number(group.planned)}</td><td className="number-cell">{number(group.awaiting)}</td><td className="number-cell">{percent(group.collectionRate)}</td><td className="number-cell">{percent(group.awaitingRate)}</td>
          </tr>)}</tbody>
        </table>
        {groups.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Aguardando primeira importação.")}</p> : null}
      </div>
    </section>
  );

  if (status === "loading") return <section className="collection-monitoring-v2-state" role="status"><RefreshCw size={18} className="collection-monitoring-v2-spinner" />{t("Carregando publicação do Monitoramento de Coleta…")}</section>;
  if (status === "empty") return <section className="collection-monitoring-v2-state"><Activity size={20} /><h1>{t("Monitoramento de Coleta")}</h1><p>{error ?? t("Aguardando primeira importação.")}</p></section>;
  if (status === "error") return <section className="collection-monitoring-v2-state error" role="alert"><AlertCircle size={20} /><h1>{t("Monitoramento de Coleta")}</h1><p>{error}</p><button type="button" onClick={() => { setRows([]); setStatus("loading"); setError(null); setReload((value) => value + 1); }}>{t("Tentar novamente")}</button></section>;

  return <div className="collection-monitoring-v2" data-testid="collection-monitoring-v2-dashboard">
    <section className="dashboard-intro collection-monitoring-v2-intro">
      <div><div className="eyebrow"><Activity size={15} /> {t("Data Foundation V2")}</div><h1>{t("Monitoramento de Coleta")}</h1><p>{t("Resumo operacional por período, regional oficial, base e origem do pedido.")}</p></div>
      <div className="collection-monitoring-v2-meta"><span>{t("Contrato V2 · 23 colunas")}</span><span>{number(rows.length)} {t("registros visíveis")}</span><span>{number(rows.filter((row) => !row.mappingConfirmed).length)} {t("linhas sem vínculo único")}</span><span>{number(publicationCount)} {t("publicações no período")}</span><span>{publishedAt ? `${t("Publicada em")} ${new Intl.DateTimeFormat(dashboardLocale(language), { dateStyle: "short", timeStyle: "short" }).format(new Date(publishedAt))}` : t("Publicação vigente")}</span></div>
    </section>
    <section className="collection-monitoring-v2-filters collection-monitoring-v2-card" aria-label={t("Filtros operacionais")}>
      <div className="collection-monitoring-v2-section-heading"><h2><Filter size={17} /> {t("Filtros operacionais")}</h2><button type="button" className="reset-button" onClick={() => { setFilters({}); setQuery(""); setPage(1); }}>{t("Limpar filtros")}</button></div>
      <div className="collection-monitoring-v2-filter-grid">
        <label className="collection-monitoring-v2-filter"><span>{t("Data inicial")}</span><input type="date" value={filters.dateFrom ?? ""} onChange={(event) => updateFilter("dateFrom", event.target.value || undefined)} /></label>
        <label className="collection-monitoring-v2-filter"><span>{t("Data final")}</span><input type="date" value={filters.dateTo ?? ""} onChange={(event) => updateFilter("dateTo", event.target.value || undefined)} /></label>
        {select("region", "Regional", options.regions)}
        {select("rm", "RM", [...new Set(rmFiltered.map((row) => row.rm))].sort())}
        {select("rmArea", "Região do RM", [...new Set(rmFiltered.map((row) => row.rmArea))].sort())}
        {select("rgm", "RGM", [...new Set(areaFiltered.map((row) => row.rgm))].sort())}
        {select("base", "Base / PDD", [...new Set(rgmFiltered.map((row) => row.base))].sort())}
        {select("origin", "Origem do pedido", options.origins)}
      </div>
      <p className="collection-monitoring-v2-mapping-note"><ShieldCheck size={15} /> {t("Regional e responsáveis vêm somente do DoomsDay publicado; linhas sem vínculo permanecem nos totais nacionais autorizados como Sem regional.")}</p>
    </section>
    <p className="collection-monitoring-v2-formula-note" role="note">{t("Os quatro indicadores usam fórmulas candidatas para conferência e aguardam aprovação final de negócio.")}</p>
    <section className="collection-monitoring-v2-kpis" aria-label={t("Indicadores principais")}>
      {[
        ["Previsto a coletar", number(metrics.planned), "预估揽收"],
        ["Aguardando coleta", number(metrics.awaiting), "待揽收"],
        ["Taxa de coleta", percent(metrics.collectionRate), "揽收率"],
        ["Taxa de pedidos aguardando coleta", percent(metrics.awaitingRate), "待揽收率"],
      ].map(([title, value, chinese]) => <article className="collection-monitoring-v2-kpi" key={title}><span>{t(title)}</span><strong>{value}</strong><small>{chinese}</small></article>)}
    </section>
    <section className="collection-monitoring-v2-charts">
      <article className="collection-monitoring-v2-card"><h2>{t("Evolução diária das taxas")}</h2><div className="collection-monitoring-v2-bars">{daily.map((item) => <div className="collection-monitoring-v2-bar-row collection-monitoring-v2-rate-row" key={item.date}><time>{item.date}</time><div className="collection-monitoring-v2-dual-track"><span style={{ width: `${item.collectionRate === null ? 0 : Math.min(100, item.collectionRate * 100)}%` }} /><i style={{ width: `${item.awaitingRate === null ? 0 : Math.min(100, item.awaitingRate * 100)}%` }} /></div><small>{t("Taxa de coleta")}: {percent(item.collectionRate)} · {t("Aguardando")}: {percent(item.awaitingRate)}</small></div>)}</div></article>
      <article className="collection-monitoring-v2-card"><h2>{t("Previsto versus aguardando por dia")}</h2><div className="collection-monitoring-v2-bars">{daily.map((item) => { const plannedWidth = metrics.planned ? Math.min(100, item.planned / metrics.planned * 100) : 0; const awaitingWidth = item.planned ? Math.min(100, item.awaiting / item.planned * 100) : 0; return <div className="collection-monitoring-v2-bar-row collection-monitoring-v2-volume-row" key={item.date}><time>{item.date}</time><div><span style={{ width: `${plannedWidth}%` }} /><i style={{ width: `${awaitingWidth}%` }} /></div><small>{number(item.planned)} {t("previstos")} · {number(item.awaiting)} {t("aguardando")}</small></div>; })}</div></article>
      <article className="collection-monitoring-v2-card"><h2>{t("Comparativo por regional")}</h2><div className="collection-monitoring-v2-bars">{byRegion.map((group) => { const width = metrics.planned ? Math.min(100, (group.planned / metrics.planned) * 100) : 0; return <div className="collection-monitoring-v2-bar-row" key={group.label}><b>{group.label}</b><div><span style={{ width: `${width}%` }} /></div><small>{number(group.planned)} · {percent(group.collectionRate)}</small></div>; })}</div></article>
      <article className="collection-monitoring-v2-card"><h2>{t("Desempenho por origem do pedido")}</h2><div className="collection-monitoring-v2-bars">{[...new Set(filteredRows.map((row) => row.origin))].sort().map((origin) => { const group = summarizeCollectionMonitoringV2(filteredRows.filter((row) => row.origin === origin)); const width = metrics.planned ? Math.min(100, (group.planned / metrics.planned) * 100) : 0; return <div className="collection-monitoring-v2-bar-row" key={origin}><b>{origin}</b><div><span style={{ width: `${width}%` }} /></div><small>{number(group.awaiting)} / {number(group.planned)} · {percent(group.collectionRate)}</small></div>; })}</div></article>
    </section>
    <section className="collection-monitoring-v2-summaries">
      {summaryTable("Resumo por regional", byRegion, false, "region")}
      {summaryTable("Resumo por RM e RGM", byRm, true, "rm")}
      {summaryTable("Resumo por base / PDD", byBase, true, "base")}
    </section>
    <section className="collection-monitoring-v2-card collection-monitoring-v2-detail">
      <div className="collection-monitoring-v2-section-heading"><div><h2>{t("Detalhamento da fonte")}</h2><p>{t("Os status adicionais são informativos e não alimentam os quatro indicadores principais.")}</p></div><button type="button" className="collection-monitoring-v2-export" onClick={() => void downloadExcel(filteredRows, filters)} disabled={filteredRows.length === 0}><Download size={16} /> {t("Baixar Excel")}</button></div>
      <div className="collection-monitoring-v2-toolbar"><label><span>{t("Pesquisar")}</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t("Pesquisar registros")} /></label><span>{number(filteredRows.length)} {t("registros filtrados")}</span></div>
      <div className="collection-monitoring-v2-table-scroll"><table className="collection-monitoring-v2-table collection-monitoring-v2-source-table"><thead><tr>{COLLECTION_MONITORING_V2_COLUMNS.map((key) => <th key={key}>{t(COLLECTION_MONITORING_V2_HEADERS[key])}</th>)}</tr></thead><tbody>{visibleRows.rows.map((row) => <tr key={`${row.publication_id}:${row.source_row_no}`}>{COLLECTION_MONITORING_V2_COLUMNS.map((key) => <td key={key} className={key === "data_date" ? "date-cell" : typeof row[key] === "number" || /^[\d.]+$/.test(String(row[key] ?? "")) ? "number-cell" : ""}>{formatCollectionMonitoringV2Value(row[key], key, dashboardLocale(language))}</td>)}</tr>)}</tbody></table>{visibleRows.rows.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum registro encontrado para os filtros selecionados.")}</p> : null}</div>
      <div className="collection-monitoring-v2-pagination"><span>{t("Página {page} de {pages}", { page: visibleRows.activePage, pages: visibleRows.pageCount })} · {number(visibleRows.matched.length)} {t("registros")}</span><div><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={visibleRows.activePage <= 1}>{t("Anterior")}</button><button type="button" onClick={() => setPage((current) => Math.min(visibleRows.pageCount, current + 1))} disabled={visibleRows.activePage >= visibleRows.pageCount}>{t("Próxima")}</button></div></div>
    </section>
    <footer className="dashboard-footer"><span><ShieldCheck size={15} /> {t("Dados filtrados no backend conforme autorização Feishu.")}</span><span><CalendarDays size={15} /> {t("Publicação vigente · Contrato V2")}</span></footer>
  </div>;
}
