"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const requestRef = useRef<AbortController | null>(null);

  const latest = analyses[0] ?? null;
  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (silent && requestRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const abortFromParent = () => controller.abort();
    signal?.addEventListener("abort", abortFromParent, { once: true });
    if (!silent) setLoading(true);
    setError(null);
    try {
      const headers = new Headers();
      if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
      const response = await apiFetch("/api/v2/no-movement/operational-analysis?limit=20", {
        cache: "no-store", headers, signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 503 ? "data_store_unavailable" : "no_movement_analysis_unavailable");
      const payload = await response.json() as { analyses?: Analysis[] };
      if (controller.signal.aborted) return;
      setAnalyses(Array.isArray(payload.analyses) ? payload.analyses : []);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "no_movement_analysis_unavailable");
    } finally {
      signal?.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted && requestRef.current === controller && !silent) setLoading(false);
      if (requestRef.current === controller) requestRef.current = null;
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

  const formattedMessage = selected?.message?.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );

  return (
    <div className="no-movement-operational-analysis" data-testid="no-movement-operational-analysis" aria-busy={loading}>
      <div className="no-movement-analysis-heading">
        <span className="eyebrow">{t("CONSOLIDADO NACIONAL")}</span>
        <div className="no-movement-analysis-actions">
          {analyses.length > 1 ? <label>{t("Histórico")}<select aria-label={t("Histórico de análises")} value={selected?.analysisId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
            {analyses.map((item) => <option key={item.analysisId} value={item.analysisId}>{item.operationalDate} · v{item.publicationVersion}</option>)}
          </select></label> : null}
          <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} />{t("Atualizar análise")}</button>
          {selected?.state === "READY" && selected.message ? <button type="button" onClick={() => void copy()}><Clipboard size={15} />{copied ? <><Check size={15} />{t("Copiado")}</> : t("Copiar mensagem")}</button> : null}
        </div>
      </div>
      {loading ? <p className="no-movement-analysis-loading" role="status"><RefreshCw size={14} />{t("Carregando análise operacional…")}</p> : null}
      {error ? <div className="inline-alert error" role="alert"><span>{t(error)}</span><button type="button" onClick={() => void load()}>{t("Tentar novamente")}</button></div> : null}
      {!loading && !error && !latest ? <p role="status">{t("Ainda não há análise para uma publicação de Sem Movimentação.")}</p> : null}
      {selected ? <>
        <div className="no-movement-analysis-meta">
          <span>{t("Data operacional")}: <strong>{selected.operationalDate}</strong></span>
          <span>{t("Exportação")}: <strong>{selected.exportTimeLocal ? `${selected.exportTimeLocal} (${selected.exportTimeZone})` : t("Horário não confirmado")}</strong></span>
          {selected.exportTimeSource === "ADMIN_CONFIRMATION" ? <span>{t("Horário confirmado manualmente pelo administrador")}</span> : null}
          <span>{t("Versão publicada")}: <strong>v{selected.publicationVersion}</strong></span>
          <span>{t("Mapa DoomsDay")}: <strong>{selected.mapVersionId.slice(0, 8)}</strong></span>
          <span>{t("Total nacional")}: <strong>{new Intl.NumberFormat().format(selected.total)}</strong></span>
        </div>
        {selected.state === "PENDING" || selected.state === "PROCESSING" ? <p role="status">{t("A análise desta publicação está sendo processada.")}</p> : null}
        {selected.state === "FAILED" ? <p className="no-movement-analysis-error" role="alert">{t("Não foi possível gerar a análise desta publicação. Os indicadores do painel continuam disponíveis.")}</p> : null}
        {selected.state === "READY" && selected.message ? <div className="no-movement-analysis-message">{formattedMessage}</div> : null}
      </> : null}
    </div>
  );
}
