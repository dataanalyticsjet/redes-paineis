"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clipboard, RefreshCw } from "lucide-react";
import { apiFetch } from "../../lib/api-url.ts";
import type { DashboardTranslator } from "../../lib/i18n";

type Analysis = {
  analysisId: string;
  publicationId: string;
  publicationVersion: number;
  contractVersion: number;
  mapVersionId: string;
  operationalDate: string | null;
  state: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  totalOrders: number;
  ordersUnscannedAtCollection: number;
  failureRate: number | null;
  message: string | null;
  errorCode: string | null;
  generatedAt: string | null;
};

export function PddCollectionFailureOperationalAnalysis({
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
      const response = await apiFetch("/api/v2/pdd-collection-failure/operational-analysis?limit=20", {
        cache: "no-store", headers, signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 503 ? "data_store_unavailable" : "pdd_collection_failure_analysis_unavailable");
      const payload = await response.json() as { analyses?: Analysis[] };
      if (!controller.signal.aborted) setAnalyses(Array.isArray(payload.analyses) ? payload.analyses : []);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "pdd_collection_failure_analysis_unavailable");
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
      setError("pdd_collection_failure_analysis_copy_failed");
    }
  };
  const formattedMessage = selected?.message?.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );

  return (
    <div className="no-movement-operational-analysis" data-testid="pdd-collection-failure-operational-analysis" aria-busy={loading}>
      <div className="no-movement-analysis-heading">
        <span className="eyebrow">{t("CONSOLIDADO NACIONAL")}</span>
        <div className="no-movement-analysis-actions">
          {analyses.length > 1 ? <label>{t("Histórico")}<select aria-label={t("Histórico de análises")} value={selected?.analysisId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
            {analyses.map((item) => <option key={item.analysisId} value={item.analysisId}>{item.operationalDate ?? "—"} · v{item.publicationVersion}</option>)}
          </select></label> : null}
          <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} />{t("Atualizar análise")}</button>
          {selected?.state === "READY" && selected.message ? <button type="button" onClick={() => void copy()}>{copied ? <><Check size={15} />{t("Copiado")}</> : <><Clipboard size={15} />{t("Copiar mensagem")}</>}</button> : null}
        </div>
      </div>
      {loading ? <p className="no-movement-analysis-loading" role="status"><RefreshCw size={14} />{t("Carregando análise operacional…")}</p> : null}
      {error ? <div className="inline-alert error" role="alert"><span>{t(error)}</span><button type="button" onClick={() => void load()}>{t("Tentar novamente")}</button></div> : null}
      {!loading && !error && !latest ? <p role="status">{t("Ainda não há análise para uma publicação de Falha de Coleta PDD.")}</p> : null}
      {selected ? <>
        <div className="no-movement-analysis-meta">
          <span>{t("Data operacional")}: <strong>{selected.operationalDate ?? "—"}</strong></span>
          <span>{t("Versão publicada")}: <strong>v{selected.publicationVersion}</strong></span>
          <span>{t("Identificador da publicação")}: <strong>{selected.publicationId}</strong></span>
          <span>{t("Mapa DoomsDay")}: <strong>{selected.mapVersionId.slice(0, 8)}</strong></span>
          <span>{t("Total de pedidos")}: <strong>{new Intl.NumberFormat().format(selected.totalOrders)}</strong></span>
          <span>{t("Pedidos não bipados")}: <strong>{new Intl.NumberFormat().format(selected.ordersUnscannedAtCollection)}</strong></span>
          {selected.failureRate !== null ? <span>{t("Falha na Coleta PDD")}: <strong>{new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(selected.failureRate)}</strong></span> : null}
          {selected.generatedAt ? <span>{t("Gerada em")}: <strong>{selected.generatedAt}</strong></span> : null}
        </div>
        {selected.state === "PENDING" || selected.state === "PROCESSING" ? <p role="status">{t("A análise desta publicação está sendo processada.")}</p> : null}
        {selected.state === "FAILED" ? <p className="no-movement-analysis-error" role="alert">{t("Não foi possível gerar a análise desta publicação. Os indicadores do painel continuam disponíveis.")}</p> : null}
        {selected.state === "READY" && selected.message ? <div className="no-movement-analysis-message">{formattedMessage}</div> : null}
      </> : null}
    </div>
  );
}
