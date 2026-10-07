"use client";

import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import { parseResponsibilitySource, previewResponsibilitySource, publishResponsibilitySource, type ResponsibilitySourcePreview } from "../../lib/data-sources/responsibility.ts";

export function ResponsibilitySourceDialog({
  onClose,
  onPublished,
  t,
}: {
  onClose: () => void;
  onPublished: () => void;
  t: DashboardTranslator;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ResponsibilitySourcePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setPreview(null);
    setError("");
    try {
      const parsed = await parseResponsibilitySource(file);
      setPreview(await previewResponsibilitySource(file, parsed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "responsibility_list_parse_failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const publish = async () => {
    if (!preview?.previewId || !preview.canPublish) return;
    setBusy(true);
    setError("");
    try {
      await publishResponsibilitySource(preview.previewId);
      onPublished();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "responsibility_list_publish_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="monitoring-source-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="monitoring-source-dialog" role="dialog" aria-modal="true" aria-labelledby="responsibility-source-title">
        <button className="monitoring-source-close" type="button" onClick={onClose} disabled={busy} aria-label={t("Fechar")}><X size={19} /></button>
        <div className="monitoring-source-heading">
          <span className="monitoring-source-icon"><FileSpreadsheet size={19} /></span>
          <div><span className="monitoring-source-eyebrow">{t("De-para oficial")}</span><h2 id="responsibility-source-title">{t("Atualizar de-para de bases")}</h2></div>
        </div>
        <p className="monitoring-source-empty">{t("Selecione a aba Ativas do De_para DoomsDay.xlsx. A publicação substitui a versão oficial usada por todos os painéis.")}</p>
        <div className="monitoring-source-picker">
          <input ref={inputRef} className="sr-only" type="file" accept=".xlsx,.xls" onChange={(event) => void chooseFile(event.currentTarget.files?.[0])} disabled={busy} aria-label={t("Selecionar arquivo")} />
          <button type="button" className="monitoring-source-select" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <LoaderCircle className="monitoring-source-spinner" size={16} /> : <Upload size={16} />}{t("Selecionar arquivo")}
          </button>
        </div>
        {busy ? <p className="monitoring-source-processing" role="status"><LoaderCircle className="monitoring-source-spinner" size={15} /> {t("Validando arquivo…")}</p> : null}
        {error ? <p className="monitoring-source-error" role="alert"><AlertCircle size={16} /> {t(error)}</p> : null}
        {preview ? (
          <section className={`monitoring-source-preview${preview.canPublish ? "" : " has-errors"}`} aria-label={t("Prévia do arquivo")}>
            <div className="monitoring-source-preview-title">
              {preview.canPublish ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
              <div><h3>{t("Prévia do arquivo")}</h3><p>{preview.fileName} · {preview.sheetName}</p></div>
            </div>
            <dl className="monitoring-source-preview-meta">
              <div><dt>{t("Registros")}</dt><dd>{preview.rowCount.toLocaleString("pt-BR")}</dd></div>
              <div><dt>{t("Bases únicas")}</dt><dd>{preview.baseCount.toLocaleString("pt-BR")}</dd></div>
              <div><dt>{t("Bases duplicadas")}</dt><dd>{preview.duplicateBaseCount.toLocaleString("pt-BR")}</dd></div>
            </dl>
            {!preview.canPublish ? <p className="monitoring-source-error" role="alert"><AlertCircle size={16} /> {t("Há bases duplicadas; corrija a planilha antes de publicar.")}</p> : null}
          </section>
        ) : null}
        <div className="monitoring-source-actions">
          <button type="button" className="monitoring-source-cancel" onClick={onClose} disabled={busy}>{t("Cancelar")}</button>
          <button type="button" className="monitoring-source-confirm" onClick={() => void publish()} disabled={busy || !preview?.canPublish || !preview.previewId}>
            <FileSpreadsheet size={16} /> {t("Publicar de-para")}
          </button>
        </div>
      </section>
    </div>
  );
}
