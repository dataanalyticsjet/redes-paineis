"use client";

import { useEffect, useState } from "react";
import type { DashboardTranslator } from "../../lib/i18n";

export interface DashboardLoadingProgress {
  loaded: number;
  total: number;
  stage?: "records" | "validation";
}

interface DashboardLoadingSkeletonProps {
  t: DashboardTranslator;
  message: string;
  progress?: DashboardLoadingProgress | null;
  compact?: boolean;
  previousDataLabel?: string | null;
  error?: string | null;
  onRetry?: () => void;
}

export function DashboardLoadingSkeleton({
  t,
  message,
  progress = null,
  compact = false,
  previousDataLabel = null,
  error = null,
  onRetry,
}: DashboardLoadingSkeletonProps) {
  const [visible, setVisible] = useState(compact);
  useEffect(() => {
    if (compact) return undefined;
    const timer = window.setTimeout(() => setVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, [compact, message]);

  const hasMeasuredTotal = Boolean(progress && progress.stage !== "validation" && Number.isFinite(progress.total) && progress.total > 0);
  const measuredPercent = hasMeasuredTotal
    ? Math.max(0, Math.min(100, Math.floor((Math.max(0, progress!.loaded) / progress!.total) * 100)))
    : null;

  if (compact) {
    return (
      <div className={`dashboard-loading-update${error ? " is-error" : ""}`} role={error ? "alert" : "status"} aria-live="polite" aria-busy={!error}>
        <span className="dashboard-loading-update-indicator" aria-hidden="true" />
        <span className="dashboard-loading-update-copy">
          <strong>{t(error ? "A atualização falhou" : message)}</strong>
          {previousDataLabel ? <small>{t("Exibindo dados anteriores: {period}", { period: previousDataLabel })}</small> : null}
          {progress?.stage === "validation" ? <small>{t("Validando a consistência da publicação…")}</small> : null}
          {progress && progress.stage !== "validation" && progress.total > 0 ? <small>{t("Carregando {loaded} de {total} registros…", { loaded: progress.loaded, total: progress.total })}</small> : null}
          {error ? <small>{t(error)}</small> : null}
        </span>
        {measuredPercent !== null ? <strong className="dashboard-loading-percent dashboard-loading-compact-percent">{measuredPercent}%</strong> : null}
        {onRetry ? <button type="button" onClick={onRetry}>{t("Tentar novamente")}</button> : null}
      </div>
    );
  }

  if (!visible) return <div className="dashboard-loading-placeholder" aria-hidden="true" />;

  if (error) {
    return <section className="dashboard-loading-error" role="alert" aria-live="assertive">
      <strong>{t("Não foi possível carregar os dados publicados.")}</strong><p>{t(error)}</p>
      {onRetry ? <button type="button" onClick={onRetry}>{t("Tentar novamente")}</button> : null}
    </section>;
  }

  return (
    <section className="dashboard-loading-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label={t(message)}>
      <div className="dashboard-loading-heading">
        <div><span className="dashboard-loading-eyebrow">{t("CARREGAMENTO")}</span><p>{t(message)}</p></div>
        {measuredPercent !== null ? <strong className="dashboard-loading-percent">{measuredPercent}%</strong> : null}
      </div>
      <div className={`dashboard-loading-progress${measuredPercent === null ? " is-indeterminate" : ""}`} role="progressbar"
        aria-label={t(message)} aria-valuemin={measuredPercent === null ? undefined : 0} aria-valuemax={measuredPercent === null ? undefined : 100}
        aria-valuenow={measuredPercent ?? undefined}>
        <span style={measuredPercent === null ? undefined : { width: `${measuredPercent}%` }} />
      </div>
      <div className="dashboard-loading-kpis" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div className="dashboard-loading-card" key={index}><i /><b /><i /></div>)}</div>
      <div className="dashboard-loading-table" aria-hidden="true">
        <div className="dashboard-loading-table-head"><i /><i /><i /><i /></div>
        {Array.from({ length: 5 }, (_, index) => <div className="dashboard-loading-table-row" key={index}><i /><i /><i /><i /></div>)}
      </div>
    </section>
  );
}
