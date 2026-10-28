"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bold } from "lucide-react";
import { apiFetch } from "../../lib/api-url.ts";
import { parseAnalysisMarkdown, serializeAnalysisRuns } from "../../lib/no-movement-analysis-editor.mjs";
import type { DashboardTranslator } from "../../lib/i18n";

type RecipientOption = { key: string; label: string; type: "email" | "chat_id"; available: boolean; unavailableReason: string | null; regionCode: string | null };
type Options = {
  publicationId: string;
  publicationVersion: number;
  operationalDate: string;
  publishedAt: string | null;
  regions: string[];
  scopeRegionCode: string | null;
  recipients: RecipientOption[];
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
  recipientKey: string;
  recipientLabel: string;
  recipientType: "email" | "chat_id";
  analysis: string;
  recordCount: number;
  totalStoppedOrders: number;
  baseCount: number;
  excelFileName: string;
  excelBytes: number;
  pngBytes: number;
  state: "PREPARED" | "CONFIRMED" | "PARTIAL" | "PENDING" | "SENT";
  previouslySent?: boolean;
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

function renderAnalysisMarkdown(editor: HTMLElement, markdown: string): void {
  editor.replaceChildren();
  for (const run of parseAnalysisMarkdown(markdown)) {
    if (run.text === "\n") {
      editor.append(document.createElement("br"));
    } else if (run.bold) {
      const strong = document.createElement("strong");
      strong.textContent = run.text;
      editor.append(strong);
    } else {
      editor.append(document.createTextNode(run.text));
    }
  }
}

function collectEditorRuns(parent: Node, inheritedBold = false): Array<{ text: string; bold: boolean }> {
  const children = Array.from(parent.childNodes);
  const runs: Array<{ text: string; bold: boolean }> = [];
  const append = (text: string, bold: boolean) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && previous.bold === bold && previous.text !== "\n") previous.text += text;
    else runs.push({ text, bold });
  };

  children.forEach((node, index) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? "", inheritedBold);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      append("\n", false);
      return;
    }
    const isBlock = tag === "div" || tag === "p";
    if (isBlock && runs.length && runs.at(-1)?.text !== "\n") append("\n", false);
    runs.push(...collectEditorRuns(element, inheritedBold || tag === "strong" || tag === "b"));
    if (isBlock && index < children.length - 1 && runs.at(-1)?.text !== "\n") append("\n", false);
  });
  return runs;
}

function serializeEditorChildren(parent: Node): string {
  return serializeAnalysisRuns(collectEditorRuns(parent));
}

function insertPlainTextAtSelection(editor: HTMLElement, value: string): void {
  const selection = window.getSelection();
  if (!selection) return;
  let range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
  if (!editor.contains(range.commonAncestorContainer)) {
    editor.focus();
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      const br = document.createElement("br");
      range.insertNode(br);
      range.setStartAfter(br);
    }
    if (line) {
      const text = document.createTextNode(line);
      range.insertNode(text);
      range.setStartAfter(text);
    }
  });
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function NoMovementFeishuReportDialog({
  publicationId, authorization, t, onClose,
}: { publicationId: string; authorization: string; t: DashboardTranslator; onClose: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [region, setRegion] = useState("");
  const [recipient, setRecipient] = useState("PHELIPPE_PRIVATE");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [analysisDraft, setAnalysisDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const analysisEditorRef = useRef<HTMLDivElement>(null);
  const analysisDraftRef = useRef(analysisDraft);
  const attemptedScopeRef = useRef("");
  const dirty = Boolean(prepared && analysisDraft !== prepared.analysis);
  const scopedOptions = options?.scopeRegionCode === (region || null) ? options : null;
  const selectedOption = scopedOptions?.recipients.find(item => item.key === recipient && item.available);
  const activeRecipient = selectedOption?.key
    ?? scopedOptions?.recipients.find(item => item.key === "PHELIPPE_PRIVATE" && item.available)?.key
    ?? scopedOptions?.recipients.find(item => item.available)?.key
    ?? "";

  const publicationDate = (value: string | null | undefined) => {
    const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
  };

  useEffect(() => {
    const controller = new AbortController();
    const headers = new Headers();
    if (authorization !== "feishu-cookie-session") headers.set("authorization", authorization);
    const regionQuery = region ? `&regionCode=${encodeURIComponent(region)}` : "";
    void apiFetch(`/api/v2/no-movement/feishu-report/options?publicationId=${encodeURIComponent(publicationId)}${regionQuery}`, {
      headers, cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("no_movement_feishu_options_unavailable");
      const value = await response.json() as Options;
      if (!controller.signal.aborted) setOptions(value);
    }).catch(() => { if (!controller.signal.aborted) setError("no_movement_feishu_options_unavailable"); });
    return () => controller.abort();
  }, [authorization, publicationId, region]);

  useEffect(() => {
    analysisDraftRef.current = analysisDraft;
  }, [analysisDraft]);

  useEffect(() => {
    const editor = analysisEditorRef.current;
    if (editor) renderAnalysisMarkdown(editor, prepared?.analysis ?? "");
  }, [prepared?.reportId, prepared?.analysis]);

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
    setPrepared(null); setAnalysisDraft(""); setStatus(null); setError(null);
    setRegion(nextRegion); setRecipient(nextRecipient);
  };
  const prepare = useCallback(async () => {
    setBusy(true); setError(null); setStatus(null);
    try {
      const value = await requestJson<Prepared>("/api/v2/no-movement/feishu-report/prepare", authorization, "POST", {
        publicationId, regionCode: region || null, recipientKey: activeRecipient,
      });
      setPrepared(value);
      setAnalysisDraft(value.analysis);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "no_movement_feishu_request_failed"); }
    finally { setBusy(false); }
  }, [activeRecipient, authorization, publicationId, region]);

  useEffect(() => {
    if (!scopedOptions || !activeRecipient) return;
    const scopeKey = `${publicationId}|${region}|${activeRecipient}`;
    if (attemptedScopeRef.current === scopeKey) return;
    attemptedScopeRef.current = scopeKey;
    void prepare();
  }, [activeRecipient, prepare, publicationId, region, scopedOptions]);
  const confirm = async () => {
    if (!prepared) return;
    setBusy(true); setError(null);
    try {
      await requestJson(`/api/v2/no-movement/feishu-report/${prepared.reportId}/confirm`, authorization, "POST", { analysisText: analysisDraft });
      setPrepared({ ...prepared, analysis: analysisDraft, state: "CONFIRMED" });
      setStatus("Relatório confirmado e registrado. Nenhuma mensagem foi enviada.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "no_movement_feishu_request_failed"); }
    finally { setBusy(false); }
  };
  const updateAnalysisFromEditor = (editor: HTMLDivElement) => {
    const next = serializeEditorChildren(editor);
    if (next.length > 20000) {
      renderAnalysisMarkdown(editor, analysisDraftRef.current);
      setError("A análise não pode ultrapassar 20.000 caracteres.");
      return;
    }
    analysisDraftRef.current = next;
    setAnalysisDraft(next);
    setError(null);
    if (prepared?.state === "CONFIRMED") { setPrepared({ ...prepared, state: "PREPARED" }); setStatus(null); }
  };
  const toggleBold = () => {
    const editor = analysisEditorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand("bold");
    updateAnalysisFromEditor(editor);
  };
  const send = async () => {
    if (!prepared || prepared.state !== "CONFIRMED" || !scopedOptions?.sendEnabled) return;
    const recipientLabel = prepared.recipientLabel;
    if (!window.confirm(`${t("Confirmar envio para")} ${recipientLabel}?`)) return;
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
      <div className="no-movement-feishu-source">
        <p><strong>{t("Fonte:")}</strong> {t("Sem Movimentação")}</p>
        <p><strong>{t("Data da fonte:")}</strong> {publicationDate(scopedOptions?.publishedAt)}</p>
        {prepared ? <p><strong>{t("Destino confirmado:")}</strong> {prepared.recipientLabel} · {prepared.recipientType === "email" ? t("Pessoa · e-mail") : t("Grupo · chat Feishu")}</p> : null}
      </div>
      <label htmlFor="nm-feishu-region">{t("Regional do relatório")}</label>
      <select className="operational-filter-select" id="nm-feishu-region" value={region} disabled={!scopedOptions || busy} onChange={event => changeScope(event.target.value, activeRecipient)}>
        <option value="">{t("Todas as regionais")}</option>
        {scopedOptions?.regions.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <label htmlFor="nm-feishu-recipient">{t("Destinatário")}</label>
      <select className="operational-filter-select" id="nm-feishu-recipient" value={activeRecipient} disabled={!scopedOptions || busy} onChange={event => changeScope(region, event.target.value)}>
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
        <span className={prepared?.excelBytes && prepared.excelBytes > 0 ? "is-ready" : "is-pending"}>
          <span aria-hidden="true">{prepared?.excelBytes && prepared.excelBytes > 0 ? "✓" : "○"}</span>
          {t(prepared?.excelBytes && prepared.excelBytes > 0 ? "Excel pronto" : busy ? "Preparando Excel…" : "Excel pendente")}
        </span>
        <span className={prepared?.pngBytes && prepared.pngBytes > 0 ? "is-ready" : "is-pending"}>
          <span aria-hidden="true">{prepared?.pngBytes && prepared.pngBytes > 0 ? "✓" : "○"}</span>
          {t(prepared?.pngBytes && prepared.pngBytes > 0 ? "Prévia PNG pronta" : busy ? "Preparando prévia PNG…" : "Prévia PNG pendente")}
        </span>
      </div>
      <label htmlFor="nm-feishu-analysis">{t("Análise atual do painel")}</label>
      <div className="no-movement-feishu-editor-toolbar" role="toolbar" aria-label={t("Formatação da análise")}>
        <button type="button" className="no-movement-feishu-editor-bold" aria-label={t("Negrito")} title={t("Negrito")} disabled={busy || !prepared || prepared.state === "SENT"} onMouseDown={event => event.preventDefault()} onClick={toggleBold}>
          <Bold size={16} aria-hidden="true" />
        </button>
        <span>{t("Selecione o texto para aplicar ou remover negrito.")}</span>
      </div>
      <div
        id="nm-feishu-analysis"
        ref={analysisEditorRef}
        className="no-movement-feishu-analysis-editor"
        role="textbox"
        aria-multiline="true"
        aria-label={t("Análise atual do painel")}
        aria-disabled={busy || !prepared || prepared.state === "SENT"}
        tabIndex={prepared ? 0 : -1}
        contentEditable={!busy && Boolean(prepared) && prepared?.state !== "SENT"}
        suppressContentEditableWarning
        data-placeholder={t(busy ? "Preparando relatório…" : "Prepare o relatório para visualizar a análise oficial deste recorte.")}
        onInput={event => updateAnalysisFromEditor(event.currentTarget)}
        onPaste={event => {
          event.preventDefault();
          insertPlainTextAtSelection(event.currentTarget, event.clipboardData.getData("text/plain"));
          updateAnalysisFromEditor(event.currentTarget);
        }}
        onDrop={event => event.preventDefault()}
      />
      <p className="feishu-share-demo-note">{t("Serão anexados o Excel completo das 18 colunas oficiais e uma prévia PNG gerados da mesma publicação e do mesmo recorte.")}</p>
      {prepared ? <p className="feishu-share-demo-note">{prepared.excelFileName} · {prepared.state}</p> : null}
      {prepared?.previouslySent ? <p className="feishu-share-demo-note" role="status">{t("Este relatório já foi enviado anteriormente. Você pode preparar um novo envio.")}</p> : null}
      {error ? <p className="feishu-share-unavailable" role="alert">{t(error)}</p> : null}
      {status ? <p className="feishu-share-success" role="status">{t(status)}</p> : null}
      <div className="feishu-share-actions">
        <button className="feishu-share-cancel" type="button" disabled={busy} onClick={onClose}>{t("Cancelar")}</button>
        {!prepared && error && scopedOptions ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => void prepare()}>{t(busy ? "Preparando…" : "Tentar novamente")}</button> : null}
        {prepared?.state === "PREPARED" ? <button className="feishu-share-confirm" type="button" disabled={busy || !analysisDraft.trim()} onClick={() => void confirm()}>{t("Confirmar preparação")}</button> : null}
        {prepared?.state === "CONFIRMED" ? <button className="feishu-share-confirm" type="button" disabled={busy || !scopedOptions?.sendEnabled} onClick={() => void send()}>{t(scopedOptions?.sendEnabled ? "Enviar agora" : "Envio desativado")}</button> : null}
        {prepared?.state === "SENT" ? <button className="feishu-share-confirm" type="button" disabled={busy} onClick={() => { setPrepared(null); setAnalysisDraft(""); setStatus(null); setError(null); void prepare(); }}>{t("Preparar novo envio")}</button> : null}
      </div>
    </section>
  </div>;
}
