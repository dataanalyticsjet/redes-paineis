"use client";

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { subscribeToProtectedApiAuthorizationFailure } from "../../lib/api-url.ts";
import { dashboardLocale, type DashboardLanguage, type DashboardTranslator } from "../../lib/i18n";
import { loadCollectionMonitoringV2Retention } from "../../lib/data-foundation/collection-monitoring-v2.ts";
import { type CollectionMonitoringV2Filters } from "../../lib/data-foundation/collection-monitoring-v2-dashboard.ts";
import { RETENTION_MEASURES, regionalRetentionMatrix, regionalRetentionModel, rmRetentionMatrix, rmRetentionModel, type RegionalRetentionModel, type RegionalRetentionRow, type RmRetentionModel } from "../../lib/data-foundation/collection-monitoring-v2-retention.ts";
import type { CollectionMonitoringV2RetentionRecord, CollectionMonitoringV2RmRetentionRecord } from "../../lib/data-foundation/collection-monitoring-v2.ts";

type Matrix = ReturnType<typeof regionalRetentionMatrix>;
interface TableProps {
  t: DashboardTranslator;
  language: DashboardLanguage;
  model: RegionalRetentionModel;
  rmModel: RmRetentionModel;
  onExport: (regional: Matrix, rm: Matrix) => void;
}

export function CollectionMonitoringV2RegionalRetentionTable({ t, language, model, rmModel, onExport }: TableProps) {
  const number = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(dashboardLocale(language)).format(value);
  const variation = (value: number | null) => value === null ? "—" : `${value > 0 ? "↑ " : value < 0 ? "↓ " : ""}${new Intl.NumberFormat(dashboardLocale(language), { style: "percent", maximumFractionDigits: 1 }).format(Math.abs(value))}`;
  const dateLabel = (date: string) => new Intl.DateTimeFormat(dashboardLocale(language), { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)).replace(/\s+de\s+/gi, " ").toLocaleUpperCase(dashboardLocale(language));
  const cells = (row: RegionalRetentionRow) => <>
    <td><span className="cm-v2-region-chip">{t(row.region)}</span></td><td><span className="cm-v2-rgm" title={t(row.rgm)}>{t(row.rgm)}</span></td>
    <td>{number(row.planned)}</td>
    {RETENTION_MEASURES.flatMap(({ key }) => [
      ...row.values[key].map((value, index) => <td key={`${key}-${model.dates[index]}`}>{number(value)}</td>),
      <td key={`${key}-variation`} className="cm-v2-variation" data-direction={row.variations[key] === null ? "missing" : row.variations[key]! > 0 ? "up" : row.variations[key]! < 0 ? "down" : "equal"}>{variation(row.variations[key])}</td>,
    ])}
  </>;
  return <section className="collection-monitoring-v2-card collection-monitoring-v2-regional-retention" aria-label={t("Retenção por regional")}>
    <div className="cm-v2-retention-heading"><div><span className="card-eyebrow">{t("PRIMEIRA DIGITALIZAÇÃO")}</span><h2>{t("Retenção por regional")}</h2><p>{t("Últimos 3 dias do filtro; a variação compara somente o último dia com o dia anterior.")}</p></div>
      <button type="button" className="collection-monitoring-v2-export" onClick={() => onExport(regionalRetentionMatrix(model, t), rmRetentionMatrix(rmModel, t))} disabled={model.rows.length === 0 && rmModel.rows.length === 0}><Download size={15} />{t("Baixar Excel — todas as tabelas")}</button>
    </div>
    <div className="collection-monitoring-v2-table-scroll cm-v2-regional-retention-scroll">
      <table className="collection-monitoring-v2-table cm-v2-regional-retention-table" style={{ minWidth: 360 + RETENTION_MEASURES.length * (model.dates.length + 1) * 80 }}>
        <colgroup><col className="cm-v2-region-column" /><col className="cm-v2-rgm-column" /><col className="cm-v2-planned-column" />{Array.from({ length: RETENTION_MEASURES.length * (model.dates.length + 1) }, (_, index) => <col key={index} className="cm-v2-measure-column" />)}</colgroup>
        <thead><tr><th rowSpan={2} scope="col">{t("Regional")}</th><th rowSpan={2} scope="col">RGM</th><th rowSpan={2} scope="col">{t("Volume previsto")}</th>
          {RETENTION_MEASURES.map(({ key, label }) => <th key={key} colSpan={model.dates.length + 1} scope="colgroup">{t(label)}</th>)}</tr>
          <tr>{RETENTION_MEASURES.flatMap(({ key }) => [...model.dates.map((date) => <th key={`${key}-${date}`} scope="col">{dateLabel(date)}</th>), <th key={`${key}-variation`} scope="col">{t("Variação")}</th>])}</tr></thead>
        <tbody>{model.rows.map((row) => <tr key={row.region}>{cells(row)}</tr>)}</tbody>
        <tfoot><tr>{cells(model.total)}</tr></tfoot>
      </table>
    </div>
    {model.rows.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum grupo encontrado para os filtros selecionados.")}</p> : null}
    <p className="cm-v2-retention-method">{t("Os indicadores seguem as fórmulas definidas para as colunas oficiais; sua soma não representa necessariamente encomendas únicas.")}</p>
    <p className="cm-v2-retention-method">{t("Volume previsto: último dia exibido. Variação diária convencional: (atual − anterior) / anterior; sem base de comparação ou denominador zero, —. A fórmula de variação do JMS ainda não foi confirmada.")}</p>
  </section>;
}

export function CollectionMonitoringV2RetentionTables({ t, language, filters, scopeKey, expectedPublicationSignature, rgmRegions, onExport }: Omit<TableProps, "model" | "rmModel"> & { filters: CollectionMonitoringV2Filters; scopeKey: string; expectedPublicationSignature: string; rgmRegions?: readonly string[] }) {
  const [state, setState] = useState<{ key: string; dates: string[]; aggregates: CollectionMonitoringV2RetentionRecord[]; rmAggregates: CollectionMonitoringV2RmRetentionRecord[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify({ scopeKey, filters, rgmRegions, expectedSignature: expectedPublicationSignature, retry });
  useEffect(() => {
    const request = JSON.parse(key) as { filters: CollectionMonitoringV2Filters; rgmRegions?: string[]; expectedSignature: string };
    const controller = new AbortController();
    let active = true;
    const unsubscribe = subscribeToProtectedApiAuthorizationFailure(() => { active = false; controller.abort(); setState(null); });
    void loadCollectionMonitoringV2Retention({ dateFrom: request.filters.dateFrom, dateTo: request.filters.dateTo }, undefined, controller.signal, { ...request.filters, rgmRegions: request.rgmRegions }).then((result) => {
      const counts = new Map<string, number>();
      for (const row of result.aggregates) {
        const identity = `${String(row.data_date).slice(0, 10)}:${row.publication_id}`;
        counts.set(identity, (counts.get(identity) ?? 0) + row.row_count);
      }
      if (JSON.stringify([...counts].map(([identity, count]) => `${identity}:${count}`).sort()) !== request.expectedSignature) throw new Error("A publicação da comparação mudou durante o carregamento.");
      if (active) setState({ key, dates: result.dates, aggregates: result.aggregates, rmAggregates: result.rmAggregates });
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted) setState({ key, dates: [], aggregates: [], rmAggregates: [], error: error instanceof Error ? error.message : "Não foi possível carregar a retenção por regional." });
    });
    return () => { active = false; controller.abort(); unsubscribe(); };
  }, [key]);
  const model = useMemo(() => regionalRetentionModel(state?.key === key ? state.aggregates : [], state?.key === key ? state.dates : []), [state, key]);
  const rmModel = useMemo(() => rmRetentionModel(state?.key === key ? state.rmAggregates : []), [state, key]);
  if (state?.key !== key) return <section className="collection-monitoring-v2-card collection-monitoring-v2-regional-retention" role="status">{t("Carregando retenção por regional…")}</section>;
  if (state.error) return <section className="collection-monitoring-v2-card collection-monitoring-v2-regional-retention" role="alert"><p>{t(state.error)}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{t("Tentar novamente")}</button></section>;
  return <div className="collection-monitoring-v2-retention-sections"><CollectionMonitoringV2RegionalRetentionTable t={t} language={language} model={model} rmModel={rmModel} onExport={onExport} />
    <CollectionMonitoringV2RmRetentionTable t={t} language={language} model={rmModel} />
  </div>;
}

export function CollectionMonitoringV2RmRetentionTable({ t, language, model }: { t: DashboardTranslator; language: DashboardLanguage; model: RmRetentionModel }) {
  const number = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat(dashboardLocale(language)).format(value);
  const percent = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(dashboardLocale(language), { style: "percent", maximumFractionDigits: 1 }).format(value);
  const cells = (row: RmRetentionModel["total"], total = false) => <>
    <td>{t(total ? "Total geral" : row.rmArea)}</td><td>{t(total ? "—" : row.rm)}</td><td>{t(total ? "—" : row.rgm)}</td>
    <td>{number(row.planned)}</td><td>{number(row.retentionTotal)}</td><td>{percent(row.retentionRate)}</td>
    <td>{number(row.retainedAtBase)}</td><td>{percent(row.retainedAtBaseRate)}</td><td>{number(row.dispatchedFromBase)}</td><td>{percent(row.dispatchedFromBaseRate)}</td>
    <td>{number(row.arrivedCenter)}</td><td>{percent(row.arrivedCenterRate)}</td>
  </>;
  return <section className="collection-monitoring-v2-card collection-monitoring-v2-rm-retention" aria-label={t("Retenção por RM")}>
    <header className="cm-v2-rm-retention-heading"><span className="card-eyebrow">RM</span><h2>{t("Retenção por RM")}</h2><p>{t("Responsáveis do RM e RGM para cobrança operacional.")}</p></header>
    <div className="collection-monitoring-v2-table-scroll cm-v2-rm-retention-scroll"><table className="collection-monitoring-v2-table cm-v2-rm-retention-table">
      <thead><tr>{["Região do RM", "RM", "RGM", "Volume previsto", "Retenção total", "Taxa de retenção", "Retido na base", "Taxa", "Despachado pela base", "Taxa", "Chegado ao centro", "Taxa"].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{model.rows.map((row) => <tr key={`${row.rmArea}:${row.rm}:${row.region}`}>{cells(row)}</tr>)}</tbody>
      <tfoot><tr>{cells(model.total, true)}</tr></tfoot>
    </table>{model.rows.length === 0 ? <p className="collection-monitoring-v2-empty">{t("Nenhum grupo encontrado para os filtros selecionados.")}</p> : null}</div>
  </section>;
}
