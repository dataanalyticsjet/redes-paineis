"use client";

import { useState } from "react";
import { Check, Clipboard } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import type { CollectionRateV3OperationalAnalysis } from "../../lib/data-foundation/collection-rate-v3-operational-analysis.ts";

type AnalysisStatus = "loading" | "error" | "empty" | "ready";

export function CollectionRateOperationalAnalysis({
  analysis,
  status,
  onRetry,
  t,
}: {
  analysis: CollectionRateV3OperationalAnalysis | null;
  status: AnalysisStatus;
  onRetry?: () => void;
  t: DashboardTranslator;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    if (!analysis?.message) return;
    try {
      await navigator.clipboard.writeText(analysis.message);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const formattedMessage = analysis?.message.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
  const period = analysis
    ? analysis.period.dateFrom === analysis.period.dateTo
      ? dateLabel(analysis.period.dateFrom)
      : `${dateLabel(analysis.period.dateFrom)} — ${dateLabel(analysis.period.dateTo)}`
    : "—";

  return (
    <div className="no-movement-operational-analysis" data-testid="collection-rate-operational-analysis" aria-busy={status === "loading"}>
      <div className="no-movement-analysis-heading">
        <span className="eyebrow">{t("ANÁLISE DO RECORTE ATUAL")}</span>
        <div className="no-movement-analysis-actions">
          {analysis ? <button type="button" onClick={() => void copy()}><Clipboard size={15} />{copied ? <><Check size={15} />{t("Copiado")}</> : t("Copiar mensagem")}</button> : null}
        </div>
      </div>
      {copyFailed ? <p className="no-movement-analysis-error" role="alert">{t("Não foi possível copiar a análise.")}</p> : null}
      {status === "loading" ? <p className="no-movement-analysis-loading" role="status">{t("Carregando dados do período selecionado…")}</p> : null}
      {status === "error" ? <div className="inline-alert error" role="alert"><span>{t("Não foi possível analisar os dados atuais do painel.")}</span>{onRetry ? <button type="button" onClick={onRetry}>{t("Tentar novamente")}</button> : null}</div> : null}
      {status === "empty" ? <p role="status">{t("Não há dados publicados no período e filtros selecionados.")}</p> : null}
      {status === "ready" && analysis ? <>
        <div className="no-movement-analysis-meta">
          <span>{t("Período analisado")}: <strong>{period}</strong></span>
          <span>{t("Publicações no recorte")}: <strong>{analysis.publicationCount}</strong></span>
          <span>{t("Linhas analisadas")}: <strong>{new Intl.NumberFormat().format(analysis.rowCount)}</strong></span>
          <span>{t("Taxa de Tentativa")}: <strong>{analysis.rate === null ? "—" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(analysis.rate)}</strong></span>
        </div>
        <p className="no-movement-analysis-loading" role="note">{t("Esta síntese é calculada somente com os dados autorizados já carregados e filtrados no dashboard.")}</p>
        <div className="no-movement-analysis-message" data-testid="collection-rate-analysis-message">{formattedMessage}</div>
      </> : null}
    </div>
  );
}

function dateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "—";
}
