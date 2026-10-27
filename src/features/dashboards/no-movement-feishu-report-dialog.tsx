"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-url.ts";
import type { DashboardTranslator } from "../../lib/i18n";

type Options = {
  publicationId: string;
  publicationVersion: number;
  operationalDate: string;
  regions: string[];
  recipients: Array<{ key: string; label: string }>;
  sendEnabled: boolean;
};
type Prepared = {
  reportId: string;
  publicationId: string;
  publicationVersion: number;
  mapVersionId: string;
  operationalDate: string;
  regionCode: string | null;
  regionLabel: string;
  recipientLabel: string;
  analysis: string;
  recordCount: number;
  totalStoppedOrders: number;
  baseCount: number;
  excelFileName: string;
  excelBytes: number;
  pngBytes: number;
  state: "PREPARED" | "CONFIRMED" | "PARTIAL" | "PENDING" | "SENT";
};

async function requestJson<T>(path: string, authorization: string, method = "GET", body?: object): Promise<T> {
  const headers = new Headers();
  if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
  if (body) headers.set("content-type", "application/json");
  const response = await apiFetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(payload.detail ?? "no_movement_feishu_request_failed");
  }
  return response.json() as Promise<T>;
}

export function NoMovementFeishuReportDialog({
  publicationId, authorization, t, onClose,
}: { publicationId: string; authorization: string; t: DashboardTranslator; onClose: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [region, setRegion] = useState("");
  const [recipient, setRecipient] = useState("PHELIPPE_PRIVATE");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [interpretation, setInterpretation] = useState("");
  const [comments, setComments] = useState("");
  const [recommendations, setRecommendations] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const attemptedScopeRef = useRef("");
  const dirty = Boolean(interpretation || comments || recommendations);
  const finalMessage = prepared?.analysis ? [
    prepared.analysis,
    interpretation.trim() ? `📝 Interpretação | 解读\n${interpretation.trim()}` : "",
    comments.trim() ? `💬 Comentários | 评论\n${comments.trim()}` : "",
    recommendations.trim() ? `🎯 Recomendações | 建议\n${recommendations.trim()}` : "",
  ].filter(Boolean).join("\n\n") : "";

  useEffect(() => {
    const controller = new AbortController();
    const headers = new Headers();
    if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
    void apiFetch(`/api/v2/no-movement/feishu-report/options?publicationId=${encodeURIComponent(publicationId)}`, {
      headers, cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("no_movement_feishu_options_unavailable");
      const value = await response.json() as Options;
      if (!controller.signal.aborted) setOptions(value);
    }).catch(() => { if (!controller.signal.aborted) setError("no_movement_feishu_options_unavailable"); });
    return () => controller.abort();
  }, [authorization, publicationId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const changeScope = (nextRegion: string, nextRecipient: string) => {
    if (prepared || dirty) {
      if (!window.confirm(t("Alterar regional ou destinatário descarta a preparação e as edições. Continuar?"))) return;
    }
    setPrepared(null); setInterpretation(""); setComments(""); setRecommendations(""); setStatus(null); setError(null);
    setRegion(nextRegion); setRecipient(nextRecipient);
  };
  const prepare = useCallback(async () => {
    setBusy(true); setError(null); setStatus(null);
    try {
      const value = await requestJson<Prepared>("/api/v2/no-movement/feishu-report/prepare", authorization, "POST", {
        publicationId, regionCode: region || null, recipientKey: recipient,
      });
      setPrepared(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "no_movement_feishu_request_failed"); }
    finally { setBusy(false); }
  }, [authorization, publicationId, region, recipient]);
  useEffect(() => {
    if (!options) return;
    const scopeKey = `${publicationId}|${region}|${recipient}`;
    if (attemptedScopeRef.current === scopeKey) return;
    attemptedScopeRef.current = scopeKey;
    void prepare();
  }, [options, prepare, publicationId, recipient, region]);
  const confirm = async () => {
    if (!prepared) return;
    setBusy(true); setError(null);
    try {
      await requestJson(`/api/v2/no-movement/feishu-report/${prepared.reportId}/confirm`, authorization, "POST", { interpretation, comments, recommendations });
      setPrepared({ ...prepared, state: "CONFIRMED" });
      setStatus("Relatório confirmado e registrado. Nenhuma mensagem foi enviada.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "no_movement_feishu_request_failed"); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!prepared || prepared.state !== "CONFIRMED" || !options?.sendEnabled) return;
    if (!window.confirm(t("Enviar agora a análise e os dois anexos ao destinatário privado de teste?"))) return;
    setBusy(true); setError(null);
    try {
      await requestJson(`/api/v2/no-movement/feishu-report/${prepared.reportId}/send`, authorization, "POST");
      setPrepared({ ...prepared, state: "SENT" });
      setStatus("Envio concluído ao Feishu.");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "no_movement_feishu_request_failed";
      setError(code);
      if (code === "no_movement_feishu_delivery_pending" || code === "no_movement_report_not_confirmed") {
        setPrepared({ ...prepared, state: "PENDING" });
      } else if (code === "no_movement_report_already_sent") {
        setPrepared({ ...prepared, state: "SENT" });
      }
    }
    finally { setBusy(false); }
  };

  return <div className="feishu-share-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="feishu-share-dialog no-movement-feishu-dialog" role="dialog" aria-modal="true" aria-labelledby="nm-feishu-title">
      <button className="feishu-share-close" type="button" disabled={busy} onClick={onClose} aria-label={t("Fechar")}>×</button>
      <span className="feishu-share-eyebrow">{t("Preparação auditada · envio separado")}</span>
      <h2 id="nm-feishu-title">{t("Enviar relatório para Feishu")}</h2>
      <p><strong>{t("Sem Movimentação")}</strong></p>
      <p>{t("Publicação")}: {options?.publicationVersion ?? "—"} · {options?.operationalDate ?? "—"} · {publicationId}</p>
      <label htmlFor="nm-feishu-region">{t("Regional do relatório")}</label>
      <select id="nm-feishu-region" value={region} disabled={!options || busy} onChange={event => changeScope(event.target.value, recipient)}>
        <option value="">{t("Todas as regionais")}</option>
        {options?.regions.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <label htmlFor="nm-feishu-recipient">{t("Destinatário")}</label>
      <select id="nm-feishu-recipient" value={recipient} disabled={!options || busy} onChange={event => changeScope(region, event.target.value)}>
        {options?.recipients.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
      <div className="no-movement-feishu-metrics" aria-label={t("Indicadores oficiais da publicação")}>
        <span>{t("Linhas")}: <strong>{prepared?.recordCount ?? "—"}</strong></span>
        <span>{t("Pedidos sem movimentação")}: <strong>{prepared?.totalStoppedOrders.toLocaleString("pt-BR") ?? "—"}</strong></span>
        <span>{t("Bases DoomsDay")}: <strong>{prepared?.baseCount ?? "—"}</strong></span>
      </div>
      <label htmlFor="nm-feishu-analysis">{t("Análise atual do painel")}</label>
      <textarea id="nm-feishu-analysis" readOnly value={prepared?.analysis ?? t(busy ? "Preparando relatório…" : "Prepare o relatório para visualizar a análise oficial deste recorte.")} />
      <label htmlFor="nm-feishu-interpretation">{t("Interpretação editável")}</label>
      <textarea id="nm-feishu-interpretation" value={interpretation} maxLength={4000} disabled={busy || prepared?.state === "CONFIRMED" || prepared?.state === "SENT"} onChange={event => setInterpretation(event.target.value)} />
      <label htmlFor="nm-feishu-comments">{t("Comentários")}</label>
      <textarea id="nm-feishu-comments" value={comments} maxLength={4000} disabled={busy || prepared?.state === "CONFIRMED" || prepared?.state === "SENT"} onChange={event => setComments(event.target.value)} />
      <label htmlFor="nm-feishu-recommendations">{t("Recomendações")}</label>
      <textarea id="nm-feishu-recommendations" value={recommendations} maxLength={4000} disabled={busy || prepared?.state === "CONFIRMED" || prepared?.state === "SENT"} onChange={event => setRecommendations(event.target.value)} />
      <label htmlFor="nm-feishu-final-message">{t("Prévia final da mensagem")}</label>
      <textarea id="nm-feishu-final-message" readOnly value={finalMessage} />
      <p className="feishu-share-demo-note">{t("Serão anexados o Excel completo das 18 colunas oficiais e uma prévia PNG gerados da mesma publicação e do mesmo recorte.")}</p>
      {prepared ? <p className="feishu-share-demo-note">{prepared.excelFileName} · {prepared.excelBytes} bytes · PNG {prepared.pngBytes} bytes · {prepared.state}</p> : null}
      {error ? <p className="feishu-share-unavailable" role="alert">{t(error)}</p> : null}
      {status ? <p className="feishu-share-success" role="status">{t(status)}</p> : null}
      <div className="feishu-share-actions">
        <button className="feishu-share-cancel" type="button" disabled={busy} onClick={onClose}>{t("Cancelar")}</button>
        {!prepared && error && options ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => void prepare()}>{t(busy ? "Preparando…" : "Tentar novamente")}</button> : null}
        {prepared?.state === "PREPARED" ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => void confirm()}>{t("Confirmar preparação")}</button> : null}
        {prepared?.state === "CONFIRMED" ? <button className="feishu-share-confirm" type="button" disabled={busy || !options?.sendEnabled} onClick={() => void send()}>{t(options?.sendEnabled ? "Enviar agora" : "Envio desativado")}</button> : null}
      </div>
    </section>
  </div>;
}
