"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clipboard, RefreshCw } from "lucide-react";
import { apiFetch } from "../../lib/api-url.ts";
import type { DashboardTranslator } from "../../lib/i18n";

type Analysis = {
  analysisId: string;
  publicationId: string;
  publicationVersion: number;
  mapVersionId: string;
  operationalDate: string;
  exportTimeLocal: string | null;
  exportTimeZone: string;
  exportTimeSource: "BOT_METADATA" | "ADMIN_CONFIRMATION" | "UNKNOWN";
  state: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  total: number;
  message: string | null;
  errorCode: string | null;
  generatedAt: string | null;
};

export function NoMovementOperationalAnalysis({
  authorization,
  t,
}: {
  authorization: string;
  t: DashboardTranslator;
}) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const latest = analyses[0] ?? null;
  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const headers = new Headers();
      if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
      const response = await apiFetch("/api/v2/no-movement/operational-analysis?limit=20", {
        cache: "no-store", headers, signal,
      });
      if (!response.ok) throw new Error(response.status === 503 ? "data_store_unavailable" : "no_movement_analysis_unavailable");
      const payload = await response.json() as { analyses?: Analysis[] };
      setAnalyses(Array.isArray(payload.analyses) ? payload.analyses : []);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "no_movement_analysis_unavailable");
    } finally {
      if (!signal?.aborted && !silent) setLoading(false);
    }
  }, [authorization]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (latest?.state !== "PENDING" && latest?.state !== "PROCESSING") return undefined;
    const timer = window.setInterval(() => void load(undefined, true), 4000);
    return () => window.clearInterval(timer);
  }, [latest?.state, load]);

  const selected = analyses.find((item) => item.analysisId === selectedId) ?? latest;
  const copy = async () => {
    if (!selected?.message) return;
    try {
      await navigator.clipboard.writeText(selected.message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("no_movement_analysis_copy_failed");
    }
  };

  return (
    <section className="no-movement-operational-analysis" aria-labelledby="no-movement-analysis-heading" data-testid="no-movement-operational-analysis">
      <div className="no-movement-analysis-heading">
        <div><span className="eyebrow">{t("CONSOLIDADO NACIONAL")}</span><h2 id="no-movement-analysis-heading">{t("Análise operacional")}</h2></div>
        <div className="no-movement-analysis-actions">
          {analyses.length > 1 ? <label>{t("Histórico")}<select aria-label={t("Histórico de análises")} value={selected?.analysisId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
            {analyses.map((item) => <option key={item.analysisId} value={item.analysisId}>{item.operationalDate} · v{item.publicationVersion}</option>)}
          </select></label> : null}
          <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} />{t("Atualizar análise")}</button>
          {selected?.state === "READY" && selected.message ? <button type="button" onClick={() => void copy()}><Clipboard size={15} />{copied ? <><Check size={15} />{t("Copiado")}</> : t("Copiar mensagem")}</button> : null}
        </div>
      </div>
      {loading ? <p role="status">{t("Carregando análise operacional…")}</p> : null}
      {error ? <div className="inline-alert error" role="alert"><span>{t(error)}</span><button type="button" onClick={() => void load()}>{t("Tentar novamente")}</button></div> : null}
      {!loading && !error && !latest ? <p role="status">{t("Ainda não há análise para uma publicação de Sem Movimentação.")}</p> : null}
      {selected ? <>
        <div className="no-movement-analysis-meta">
          <span>{t("Data operacional")}: <strong>{selected.operationalDate}</strong></span>
          <span>{t("Exportação")}: <strong>{selected.exportTimeLocal ? `${selected.exportTimeLocal} (${selected.exportTimeZone})` : t("Horário não confirmado")}</strong></span>
          {selected.exportTimeSource === "ADMIN_CONFIRMATION" ? <span>{t("Horário confirmado manualmente pelo administrador")}</span> : null}
          <span>{t("Versão publicada")}: <strong>v{selected.publicationVersion}</strong></span>
          <span>{t("Mapa DoomsDay")}: <strong>{selected.mapVersionId.slice(0, 8)}</strong></span>
        </div>
        {selected.state === "PENDING" || selected.state === "PROCESSING" ? <p role="status">{t("A análise desta publicação está sendo processada.")}</p> : null}
        {selected.state === "FAILED" ? <p className="no-movement-analysis-error" role="alert">{t("Não foi possível gerar a análise desta publicação. Os indicadores do painel continuam disponíveis.")}</p> : null}
        {selected.state === "READY" && selected.message ? <pre className="no-movement-analysis-message">{selected.message}</pre> : null}
      </> : null}
    </section>
  );
}
