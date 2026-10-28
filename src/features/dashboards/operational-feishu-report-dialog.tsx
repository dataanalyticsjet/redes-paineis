"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bold } from "lucide-react";
import { apiFetch } from "../../lib/api-url.ts";
import { parseAnalysisMarkdown, serializeAnalysisRuns } from "../../lib/no-movement-analysis-editor.mjs";
import type { DashboardTranslator } from "../../lib/i18n";

type OperationalSource = "collection_rate" | "pdd_collection_failure";
type RecipientOption = { key: string; label: string; type: "email" | "chat_id"; available: boolean; unavailableReason: string | null; regionCode: string | null };
type Options = { sourceId: OperationalSource; publicationId: string; publicationVersion: number; contractVersion: number; mapVersionId: string; publishedAt: string | null; regions: string[]; scopeRegionCode: string | null; recipients: RecipientOption[]; sendEnabled: boolean };
type Prepared = { reportId: string; sourceId: OperationalSource; publicationId: string; publicationVersion: number; contractVersion: number; mapVersionId: string; publishedAt: string | null; operationalDate: string; regionCode: string | null; regionLabel: string; recipientKey: string; recipientLabel: string; recipientType: "email" | "chat_id"; analysis: string; recordCount: number; excelFileName: string; excelBytes: number; pngBytes: number; state: "PREPARED" | "CONFIRMED" | "PARTIAL" | "PENDING" | "SENT"; sendEnabled: boolean; previouslySent?: boolean };

async function requestJson<T>(path: string, authorization: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const headers = new Headers();
  if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
  if (body) headers.set("content-type", "application/json");
  const response = await apiFetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(payload.detail ?? "operational_feishu_request_failed");
  }
  return response.json() as Promise<T>;
}

function renderMarkdown(editor: HTMLElement, value: string) {
  editor.replaceChildren();
  for (const run of parseAnalysisMarkdown(value)) {
    if (run.text === "\n") editor.append(document.createElement("br"));
    else if (run.bold) { const strong = document.createElement("strong"); strong.textContent = run.text; editor.append(strong); }
    else editor.append(document.createTextNode(run.text));
  }
}

function readRuns(node: Node, bold = false): Array<{ text: string; bold: boolean }> {
  const result: Array<{ text: string; bold: boolean }> = [];
  const append = (text: string, weight: boolean) => {
    if (!text) return;
    const prior = result.at(-1);
    if (prior && prior.bold === weight && prior.text !== "\n") prior.text += text;
    else result.push({ text, bold: weight });
  };
  Array.from(node.childNodes).forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) { append(child.textContent ?? "", bold); return; }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const element = child as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") { append("\n", false); return; }
    const block = tag === "div" || tag === "p";
    if (block && result.length && result.at(-1)?.text !== "\n") append("\n", false);
    result.push(...readRuns(element, bold || tag === "strong" || tag === "b"));
    if (block && index < node.childNodes.length - 1 && result.at(-1)?.text !== "\n") append("\n", false);
  });
  return result;
}

function pastePlainText(editor: HTMLElement, value: string) {
  const selection = window.getSelection();
  if (!selection) return;
  let range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
  if (!editor.contains(range.commonAncestorContainer)) {
    editor.focus(); range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  }
  range.deleteContents();
  value.replace(/\r\n?/g, "\n").split("\n").forEach((line, index) => {
    if (index) { const br = document.createElement("br"); range.insertNode(br); range.setStartAfter(br); }
    if (line) { const text = document.createTextNode(line); range.insertNode(text); range.setStartAfter(text); }
  });
  range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
}

export function OperationalFeishuReportDialog({ sourceId, publicationId, authorization, t, onClose }: {
  sourceId: OperationalSource; publicationId: string; authorization: string; t: DashboardTranslator; onClose: () => void;
}) {
  const [options, setOptions] = useState<Options | null>(null);
  const [region, setRegion] = useState("");
  const [recipient, setRecipient] = useState("PHELIPPE_PRIVATE");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const analysisRef = useRef(analysis);
  const attempted = useRef("");
  const scopedOptions = options?.scopeRegionCode === (region || null) ? options : null;
  const selectedOption = scopedOptions?.recipients.find(item => item.key === recipient && item.available);
  const activeRecipient = selectedOption?.key
    ?? scopedOptions?.recipients.find(item => item.key === "PHELIPPE_PRIVATE" && item.available)?.key
    ?? scopedOptions?.recipients.find(item => item.available)?.key
    ?? "";
  const sourceLabel = sourceId === "collection_rate" ? "Taxa de Coleta V3" : "Falha de Coleta PDD";
  const route = `/api/v2/operational-feishu/${sourceId}`;

  useEffect(() => {
    const controller = new AbortController();
    const regionQuery = region ? `&regionCode=${encodeURIComponent(region)}` : "";
    void requestJson<Options>(`${route}/options?publicationId=${encodeURIComponent(publicationId)}${regionQuery}`, authorization, "GET", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setOptions(value); })
      .catch(() => { if (!controller.signal.aborted) setError("operational_feishu_options_unavailable"); });
    return () => controller.abort();
  }, [authorization, publicationId, region, route]);

  useEffect(() => { analysisRef.current = analysis; }, [analysis]);
  useEffect(() => { if (editorRef.current) renderMarkdown(editorRef.current, prepared?.analysis ?? ""); }, [prepared?.reportId, prepared?.analysis]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);

  const prepare = useCallback(async () => {
    setBusy(true); setError(null); setStatus(null); setPrepared(null); setAnalysis("");
    try {
      const value = await requestJson<Prepared>(`${route}/prepare`, authorization, "POST", { publicationId, regionCode: region || null, recipientKey: activeRecipient });
      setPrepared(value); setAnalysis(value.analysis);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "operational_feishu_request_failed"); }
    finally { setBusy(false); }
  }, [activeRecipient, authorization, publicationId, region, route]);

  useEffect(() => {
    if (!scopedOptions || !activeRecipient) return;
    const key = `${publicationId}|${region}|${activeRecipient}`;
    if (attempted.current === key) return;
    attempted.current = key;
    void prepare();
  }, [activeRecipient, prepare, publicationId, region, scopedOptions]);

  const changeScope = (nextRegion: string, nextRecipient: string) => {
    if (prepared || analysisRef.current) {
      if (!window.confirm(t("Alterar regional ou destinatário descarta a preparação e as edições. Continuar?"))) return;
    }
    attempted.current = ""; setPrepared(null); setAnalysis(""); analysisRef.current = ""; setStatus(null); setError(null);
    setRegion(nextRegion); setRecipient(nextRecipient);
  };

  const updateEditor = (editor: HTMLDivElement) => {
    const next = serializeAnalysisRuns(readRuns(editor));
    if (next.length > 20000) {
      renderMarkdown(editor, analysisRef.current); setError("A análise não pode ultrapassar 20.000 caracteres."); return;
    }
    analysisRef.current = next; setAnalysis(next); setError(null);
    if (prepared?.state === "CONFIRMED") { setPrepared({ ...prepared, state: "PREPARED" }); setStatus(null); }
  };
  const toggleBold = () => { if (!editorRef.current) return; editorRef.current.focus(); document.execCommand("bold"); updateEditor(editorRef.current); };

  const confirm = async () => {
    if (!prepared) return;
    setBusy(true); setError(null);
    try {
      await requestJson(`${route}/${prepared.reportId}/confirm`, authorization, "POST", { analysisText: analysis });
      setPrepared({ ...prepared, analysis, state: "CONFIRMED" }); setStatus("Relatório confirmado. Nenhuma mensagem foi enviada ainda.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "operational_feishu_request_failed"); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!prepared || prepared.state !== "CONFIRMED" || !scopedOptions?.sendEnabled) return;
    const recipientLabel = prepared.recipientLabel;
    if (!window.confirm(`${t("Confirmar envio para")} ${recipientLabel}?`)) return;
    setBusy(true); setError(null);
    try {
      await requestJson(`${route}/${prepared.reportId}/send`, authorization, "POST");
      setPrepared({ ...prepared, state: "SENT" }); setStatus("Envio concluído ao Feishu.");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "operational_feishu_request_failed";
      setError(code);
      if (code === "operational_feishu_delivery_pending") setPrepared({ ...prepared, state: "PENDING" });
      if (code === "operational_feishu_partial_delivery") setPrepared({ ...prepared, state: "PARTIAL" });
    } finally { setBusy(false); }
  };

  const publishedDate = scopedOptions?.publishedAt ? new Date(scopedOptions.publishedAt.replace(" ", "T")).toLocaleString() : "—";
  return <div className="feishu-share-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="feishu-share-dialog no-movement-feishu-dialog operational-feishu-dialog" role="dialog" aria-modal="true" aria-labelledby="operational-feishu-title">
      <button className="feishu-share-close" type="button" disabled={busy} onClick={onClose} aria-label={t("Fechar")}>×</button>
      <span className="feishu-share-eyebrow">{t("Preparação auditada · envio separado")}</span>
      <h2 id="operational-feishu-title">{t("Enviar relatório para Feishu")}</h2>
      <p><strong>{t(sourceLabel)}</strong></p>
      <div className="no-movement-feishu-source">
        <p><strong>{t("Publicação:")}</strong> {publicationId}</p>
        <p><strong>{t("Contrato:")}</strong> V{scopedOptions?.contractVersion ?? "—"} · {t("Data da fonte:")} {publishedDate}</p>
        {prepared ? <p><strong>{t("Data operacional:")}</strong> {prepared.operationalDate} · {t("Registros:")} {prepared.recordCount.toLocaleString()}</p> : null}
        {prepared ? <p><strong>{t("Destino confirmado:")}</strong> {prepared.recipientLabel} · {prepared.recipientType === "email" ? t("Pessoa · e-mail") : t("Grupo · chat Feishu")}</p> : null}
      </div>
      <label htmlFor="operational-feishu-region">{t("Regional do relatório")}</label>
      <select className="operational-filter-select" id="operational-feishu-region" value={region} disabled={!scopedOptions || busy} onChange={event => changeScope(event.target.value, activeRecipient)}>
        <option value="">{t("Todas as regionais")}</option>
        {scopedOptions?.regions.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <label htmlFor="operational-feishu-recipient">{t("Destinatário")}</label>
      <select className="operational-filter-select" id="operational-feishu-recipient" value={activeRecipient} disabled={!scopedOptions || busy} onChange={event => changeScope(region, event.target.value)}>
        <optgroup label={t("Pessoas")}>
          {scopedOptions?.recipients.filter(item => item.type === "email").map(item => <option key={item.key} value={item.key} disabled={!item.available}>{item.label}{!item.available && item.unavailableReason ? ` — ${t(item.unavailableReason)}` : ""}</option>)}
        </optgroup>
        <optgroup label={t("Grupos nacionais")}>
          {scopedOptions?.recipients.filter(item => item.type === "chat_id" && item.regionCode === null).map(item => <option key={item.key} value={item.key} disabled={!item.available}>{item.label}{!item.available && item.unavailableReason ? ` — ${t(item.unavailableReason)}` : ""}</option>)}
        </optgroup>
        <optgroup label={t("Grupos regionais")}>
          {scopedOptions?.recipients.filter(item => item.type === "chat_id" && item.regionCode !== null).map(item => <option key={item.key} value={item.key} disabled={!item.available}>{item.label}{!item.available && item.unavailableReason ? ` — ${t(item.unavailableReason)}` : ""}</option>)}
        </optgroup>
      </select>
      <div className="no-movement-feishu-attachments" aria-live="polite">
        <span className={prepared?.excelBytes ? "is-ready" : "is-pending"}>{prepared?.excelBytes ? "✓" : "○"} {t(prepared?.excelBytes ? "Excel pronto" : busy ? "Preparando Excel…" : "Excel pendente")}</span>
        <span className={prepared?.pngBytes ? "is-ready" : "is-pending"}>{prepared?.pngBytes ? "✓" : "○"} {t(prepared?.pngBytes ? "Prévia PNG pronta" : busy ? "Preparando prévia PNG…" : "Prévia PNG pendente")}</span>
      </div>
      <label htmlFor="operational-feishu-analysis">{t("Análise atual do painel")}</label>
      <div className="no-movement-feishu-editor-toolbar" role="toolbar" aria-label={t("Formatação da análise")}>
        <button type="button" className="no-movement-feishu-editor-bold" aria-label={t("Negrito")} title={t("Negrito")} disabled={busy || !prepared || prepared.state === "SENT"} onMouseDown={event => event.preventDefault()} onClick={toggleBold}><Bold size={16} aria-hidden="true" /></button>
        <span>{t("Selecione o texto para aplicar ou remover negrito.")}</span>
      </div>
      <div id="operational-feishu-analysis" ref={editorRef} className="no-movement-feishu-analysis-editor" role="textbox" aria-multiline="true" aria-label={t("Análise atual do painel")} aria-disabled={busy || !prepared || prepared.state === "SENT"} tabIndex={prepared ? 0 : -1} contentEditable={!busy && Boolean(prepared) && prepared?.state !== "SENT"} suppressContentEditableWarning data-placeholder={t(busy ? "Preparando relatório…" : "Prepare o relatório para visualizar a análise oficial deste recorte.")} onInput={event => updateEditor(event.currentTarget)} onPaste={event => { event.preventDefault(); pastePlainText(event.currentTarget, event.clipboardData.getData("text/plain")); updateEditor(event.currentTarget); }} onDrop={event => event.preventDefault()} />
      {prepared ? <p className="feishu-share-demo-note">{prepared.excelFileName} · {prepared.state}</p> : null}
      {prepared?.previouslySent ? <p className="feishu-share-demo-note" role="status">{t("Este relatório já foi enviado anteriormente. Você pode preparar um novo envio.")}</p> : null}
      {scopedOptions && !scopedOptions.sendEnabled ? <p className="feishu-share-demo-note">{t("Envio desativado por configuração; a preparação e a confirmação não enviam mensagens.")}</p> : null}
      {error ? <p className="feishu-share-unavailable" role="alert">{t(error)}</p> : null}
      {status ? <p className="feishu-share-success" role="status">{t(status)}</p> : null}
      <div className="feishu-share-actions">
        <button className="feishu-share-cancel" type="button" disabled={busy} onClick={onClose}>{t("Cancelar")}</button>
        {!prepared && error && scopedOptions ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => { attempted.current = ""; void prepare(); }}>{t("Tentar novamente")}</button> : null}
        {prepared?.state === "PREPARED" ? <button className="feishu-share-confirm" type="button" disabled={busy || !analysis.trim()} onClick={() => void confirm()}>{t("Confirmar preparação")}</button> : null}
        {prepared?.state === "CONFIRMED" ? <button className="feishu-share-confirm" type="button" disabled={busy || !scopedOptions?.sendEnabled} onClick={() => void send()}>{t(scopedOptions?.sendEnabled ? "Enviar agora" : "Envio desativado")}</button> : null}
        {prepared?.state === "SENT" ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => { setPrepared(null); setAnalysis(""); analysisRef.current = ""; setStatus(null); setError(null); void prepare(); }}>{t("Preparar novo envio")}</button> : null}
      </div>
    </section>
  </div>;
}
