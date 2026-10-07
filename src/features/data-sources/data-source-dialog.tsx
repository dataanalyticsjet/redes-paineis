"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Database, FileSpreadsheet, LoaderCircle, Trash2, Upload, X } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import type { DashboardDataSourceConfig } from "../../lib/data-sources/catalog";
import type { DataSourcePreview, ManualDataSource } from "../../lib/data-sources/api";

export type DataSourceUiState = "NO_SOURCE" | "LOADING" | "PREVIEW" | "VALID" | "INVALID" | "IMPORTING" | "ACTIVE" | "ERROR";

export interface DataSourceSummary {
  sourceType: "DEMONSTRATION" | "MANUAL_UPLOAD" | "AUTOMATIC_SOURCE";
  fileName: string;
  fileSizeBytes?: number;
  contentType?: string;
  updatedAt?: string;
  rowCount: number;
  period?: { start: string; end: string };
}

export function DataSourceDialog({
  config,
  currentSource,
  canManage,
  onClose,
  onImported,
  onRemoved,
  formatDateTime,
  t,
}: {
  config: DashboardDataSourceConfig;
  currentSource: DataSourceSummary | null;
  canManage: boolean;
  onClose: () => void;
  onImported: (source: ManualDataSource) => void;
  onRemoved: () => void;
  formatDateTime: (value: string) => string;
  t: DashboardTranslator;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<DataSourcePreview | null>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<DataSourceUiState>(currentSource ? "ACTIVE" : "NO_SOURCE");
  const busy = state === "LOADING" || state === "PREVIEW" || state === "IMPORTING";

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const chooseFile = async (file?: File) => {
    if (!file || !config.configured || !config.parse || !config.normalize || !config.preview) return;
    setState("LOADING");
    setPreview(null);
    setError("");
    try {
      const parsed = await config.parse(file);
      const normalizedDataset = await config.normalize(parsed);
      setState("PREVIEW");
      const nextPreview = await config.preview(file, normalizedDataset);
      setPreview(nextPreview);
      setState(nextPreview.canImport ? "VALID" : "INVALID");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "data_source_parse_failed");
      setState("ERROR");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const confirmImport = async () => {
    if (!preview?.canImport || !preview.previewId || !config.import) return;
    setState("IMPORTING");
    setError("");
    try {
      const source = await config.import(preview.previewId);
      onImported(source);
      setState("ACTIVE");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "data_source_import_failed");
      setState("ERROR");
    }
  };

  const removeSource = async () => {
    if (currentSource?.sourceType !== "MANUAL_UPLOAD" || !config.remove) return;
    setState("IMPORTING");
    setError("");
    try {
      await config.remove();
      onRemoved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "data_source_remove_failed");
      setState("ERROR");
    }
  };

  const sourceTypeLabel = currentSource?.sourceType === "MANUAL_UPLOAD"
    ? "Fonte manual"
    : currentSource?.sourceType === "AUTOMATIC_SOURCE"
        ? "Fonte automática"
        : "Dados simulados";

  const summarizeDates = (dates: string[]) => {
    if (dates.length === 0) return t("Nenhuma");
    const visibleDates = dates.slice(0, 5).join(", ");
    const remaining = dates.length - 5;
    return `${dates.length.toLocaleString("pt-BR")} · ${visibleDates}${remaining > 0 ? ` ${t("+{count} data(s)", { count: remaining.toLocaleString("pt-BR") })}` : ""}`;
  };

  return (
    <div
      className="monitoring-source-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="monitoring-source-dialog" role="dialog" aria-modal="true" aria-labelledby="data-source-title">
        <button className="monitoring-source-close" type="button" onClick={onClose} disabled={busy} aria-label={t("Fechar")}>
          <X size={19} />
        </button>
        <div className="monitoring-source-heading">
          <span className="monitoring-source-icon"><Database size={19} /></span>
          <div>
            <span className="monitoring-source-eyebrow">{t("Fonte de dados")}</span>
            <h2 id="data-source-title">{t("Fonte de dados — {dashboard}", { dashboard: t(config.title) })}</h2>
          </div>
        </div>

        <section className="monitoring-source-current" aria-label={t("Fonte atual")}>
          <h3>{t("Fonte atual")}</h3>
          {currentSource ? (
            <dl>
              <div><dt>{t("Nome do arquivo")}</dt><dd title={currentSource.fileName}>{currentSource.fileName}</dd></div>
              <div><dt>{t("Tipo")}</dt><dd>{t(sourceTypeLabel)}</dd></div>
              {currentSource.fileSizeBytes !== undefined ? <div><dt>{t("Tamanho")}</dt><dd>{(currentSource.fileSizeBytes / 1024 / 1024).toFixed(2)} MB</dd></div> : null}
              <div><dt>{t("Quantidade de registros")}</dt><dd>{currentSource.rowCount.toLocaleString("pt-BR")}</dd></div>
              <div><dt>{t("Período")}</dt><dd>{currentSource.period ? `${currentSource.period.start} → ${currentSource.period.end}` : t("Indisponível")}</dd></div>
              <div><dt>{t("Última atualização")}</dt><dd>{currentSource.updatedAt ? formatDateTime(currentSource.updatedAt) : t("Indisponível")}</dd></div>
              <div><dt>{t("Status")}</dt><dd className={currentSource.sourceType === "DEMONSTRATION" ? "is-demo" : "is-loaded"}>{t(currentSource.sourceType === "DEMONSTRATION" ? "Dados simulados" : "Dados carregados")}</dd></div>
            </dl>
          ) : (
            <p className="monitoring-source-empty">{t("Nenhuma fonte de dados carregada.")}</p>
          )}
          <p className="monitoring-source-automation"><span aria-hidden="true">●</span> {t("Atualização automática: em preparação")}</p>
        </section>

        {config.configured && canManage ? (
          <>
            <div className="monitoring-source-picker">
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept={config.acceptedFormats.join(",")}
                onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
                disabled={busy}
                aria-label={t("Selecionar arquivo")}
              />
              <button type="button" className="monitoring-source-select" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                {busy ? <LoaderCircle className="monitoring-source-spinner" size={16} /> : <Upload size={16} />}
                {t(currentSource?.sourceType === "MANUAL_UPLOAD" ? "Substituir arquivo" : "Selecionar arquivo")}
              </button>
              {currentSource?.sourceType === "MANUAL_UPLOAD" ? (
                <button type="button" className="monitoring-source-remove" onClick={() => void removeSource()} disabled={busy}>
                  <Trash2 size={15} /> {t("Remover fonte")}
                </button>
              ) : null}
            </div>

            {busy ? <p className="monitoring-source-processing" role="status"><LoaderCircle className="monitoring-source-spinner" size={15} /> {t(state === "IMPORTING" ? "Importando fonte…" : "Processando arquivo…")}</p> : null}
            {error ? <p className="monitoring-source-error" role="alert"><AlertCircle size={16} /> {t(error)}</p> : null}

            {preview ? (
              <section className={`monitoring-source-preview${preview.canImport ? "" : " has-errors"}`} aria-label={t("Prévia do arquivo")}>
                <div className="monitoring-source-preview-title">
                  {preview.canImport ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
                  <div><h3>{t("Prévia do arquivo")}</h3><p>{preview.fileName} · {(preview.fileSizeBytes / 1024 / 1024).toFixed(2)} MB</p></div>
                </div>
                <dl className="monitoring-source-preview-meta">
                  <div><dt>{t("Planilha detectada")}</dt><dd>{preview.sheetName}</dd></div>
                  <div><dt>{t(preview.history ? "Linhas no seu escopo" : "Linhas")}</dt><dd>{preview.rowCount.toLocaleString("pt-BR")}</dd></div>
                  <div><dt>{t("Período")}</dt><dd>{preview.period ? `${preview.period.start} → ${preview.period.end}` : t("Indisponível")}</dd></div>
                </dl>
                {preview.history ? (
                  <section className="monitoring-source-history-preview" aria-label={t("Prévia do histórico") }>
                    <h4>{t("Prévia do histórico")}</h4>
                    <dl className="monitoring-source-preview-meta">
                      <div><dt>{t("Linhas no arquivo")}</dt><dd>{preview.history.fileRowCount.toLocaleString("pt-BR")}</dd></div>
                      <div><dt>{t("Datas novas")}</dt><dd title={preview.history.newDates.join(", ")}>{summarizeDates(preview.history.newDates)}</dd></div>
                      <div><dt>{t("Datas que serão substituídas")}</dt><dd title={preview.history.replacedDates.join(", ")}>{summarizeDates(preview.history.replacedDates)}</dd></div>
                      <div><dt>{t("Linhas Sem base")}</dt><dd>{preview.history.blankBaseRows.toLocaleString("pt-BR")}</dd></div>
                      <div><dt>{t("Linhas após publicar histórico")}</dt><dd>{preview.history.resultingRows.toLocaleString("pt-BR")}</dd></div>
                    </dl>
                  </section>
                ) : null}
                <div className="monitoring-source-headers"><strong>{t("Colunas encontradas")}</strong><p>{preview.headers.map((header) => <span key={header}>{header}</span>)}</p></div>
                <ul className="monitoring-source-fields">
                  {preview.fields.map((field) => (
                    <li key={`${field.classification}-${field.name}`} className={`field-${field.classification}${!field.present && field.classification === "required" ? " field-missing" : ""}`}>
                      <span>{field.name}</span>
                      <small>{t(field.classification === "required" ? "Obrigatória" : field.classification === "optional" ? "Opcional" : "Não reconhecida")}</small>
                      {field.present && field.classification !== "unrecognized" ? <CheckCircle2 size={14} /> : null}
                    </li>
                  ))}
                </ul>
                {!preview.canImport ? <p className="monitoring-source-error" role="alert"><AlertCircle size={16} /> {t("Não foi possível utilizar este arquivo.")} {preview.missingFields.map((field) => t(field)).join(", ")}</p> : null}
              </section>
            ) : null}
          </>
        ) : config.configured ? (
          <section className="monitoring-source-preview" role="status">
            <p>{t("Somente leitura — apenas administradores podem atualizar ou remover esta fonte.")}</p>
          </section>
        ) : (
          <section className="monitoring-source-preview has-errors" role="status">
            <p>{t("Fonte de dados ainda não configurada para este painel.")}</p>
            <p>{t("Status: fonte pendente de configuração")}</p>
          </section>
        )}

        <div className="monitoring-source-actions">
          <button type="button" className="monitoring-source-cancel" onClick={onClose} disabled={busy}>{t("Cancelar")}</button>
          {config.configured && canManage ? <button type="button" className="monitoring-source-confirm" onClick={() => void confirmImport()} disabled={busy || state !== "VALID" || !preview?.previewId}>
            <FileSpreadsheet size={16} /> {t("Usar como fonte")}
          </button> : null}
        </div>
      </section>
    </div>
  );
}
