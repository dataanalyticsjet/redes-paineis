"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import { getResponsibilitySource, parseResponsibilitySource, previewResponsibilitySource, publishResponsibilitySource, type ResponsibilitySourceMetadata, type ResponsibilitySourcePreview } from "../../lib/data-sources/responsibility.ts";

export function ResponsibilitySourceDialog({
  onClose,
  onPublished,
  formatDateTime,
  formatNumber,
  t,
}: {
  onClose: () => void;
  onPublished: () => void;
  formatDateTime: (value?: string) => string;
  formatNumber: (value: number) => string;
  t: DashboardTranslator;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasPublishedRef = useRef(false);
  const [preview, setPreview] = useState<ResponsibilitySourcePreview | null>(null);
  const [currentSource, setCurrentSource] = useState<ResponsibilitySourceMetadata | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceLoadFailed, setSourceLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    void getResponsibilitySource()
      .then((source) => { if (active && !hasPublishedRef.current) setCurrentSource(source); })
      .catch((cause) => {
        if (active && !hasPublishedRef.current) {
          setSourceLoadFailed(true);
          setError(cause instanceof Error ? cause.message : "responsibility_list_request_failed");
        }
      })
      .finally(() => { if (active) setSourceLoading(false); });
    return () => { active = false; };
  }, []);

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setPreview(null);
    setError("");
    setSuccess("");
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
    setSuccess("");
    try {
      const source = await publishResponsibilitySource(preview.previewId);
      hasPublishedRef.current = true;
      setCurrentSource(source);
      setPreview(null);
      setSuccess("De-para publicado com sucesso.");
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
        <section className="monitoring-source-current" aria-label={t("Fonte oficial atual")}>
          <h3>{t("Fonte oficial atual")}</h3>
          {sourceLoading ? (
            <p className="monitoring-source-processing" role="status"><LoaderCircle className="monitoring-source-spinner" size={15} /> {t("Carregando fonte oficial...")}</p>
          ) : currentSource ? (
            <>
              <p><strong>{currentSource.fileName}</strong></p>
              <dl>
                <div><dt>{t("Publicado em")}</dt><dd>{formatDateTime(currentSource.publishedAt ?? currentSource.updatedAt)}</dd></div>
                {currentSource.sheetName ? <div><dt>{t("Aba")}</dt><dd>{currentSource.sheetName}</dd></div> : null}
                <div><dt>{t("Registros")}</dt><dd>{formatNumber(currentSource.rowCount)}</dd></div>
                <div><dt>{t("Bases")}</dt><dd>{formatNumber(currentSource.baseCount)}</dd></div>
                <div><dt>{t("Duplicidades")}</dt><dd>{formatNumber(currentSource.duplicateBaseCount)}</dd></div>
                <div><dt>{t("Status")}</dt><dd className="is-loaded">{t("Ativa")}</dd></div>
              </dl>
            </>
          ) : sourceLoadFailed ? null : (
            <p className="monitoring-source-empty">{t("Sem fonte oficial publicada.")}</p>
          )}
        </section>
        {success ? <div className="inline-alert success" role="status"><CheckCircle2 size={16} /> {t(success)}</div> : null}
        <div className="monitoring-source-picker">
          <input ref={inputRef} className="sr-only" type="file" accept=".xlsx,.xls" onChange={(event) => void chooseFile(event.currentTarget.files?.[0])} disabled={busy} aria-label={t("Selecionar arquivo")} />
          <button type="button" className="monitoring-source-select" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <LoaderCircle className="monitoring-source-spinner" size={16} /> : <Upload size={16} />}{t(currentSource ? "Selecionar novo arquivo" : "Selecionar arquivo")}
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
