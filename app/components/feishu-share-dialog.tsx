"use client";

import { Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardTranslator } from "../lib/i18n";

export type FeishuSharePreview = {
  title: string;
  filters: string[];
  content: string;
  contentAvailable: boolean;
};

const DEMO_GROUPS = [
  "Demonstração — Grupo Regional SP",
  "Demonstração — Operações Brasil",
  "Demonstração — Apresentação executiva",
] as const;

export function FeishuShareDialog({
  preview,
  onClose,
  t,
}: {
  preview: FeishuSharePreview | null;
  onClose: () => void;
  t: DashboardTranslator;
}) {
  const [group, setGroup] = useState("");
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    setGroup("");
    setCompleted(false);
  }, [preview]);

  useEffect(() => {
    if (!preview) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, preview]);

  if (!preview) return null;

  return (
    <div
      className="feishu-share-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="feishu-share-dialog" role="dialog" aria-modal="true" aria-labelledby="feishu-share-title">
        <button className="feishu-share-close" type="button" onClick={onClose} aria-label={t("Fechar")}>
          <X size={18} />
        </button>
        <span className="feishu-share-eyebrow">{t("Simulação local — nenhum envio real")}</span>
        <h2 id="feishu-share-title">{t("Enviar para Feishu")}</h2>
        <div className="feishu-share-context">
          <strong>{preview.title}</strong>
          {preview.filters.length ? (
            <ul aria-label={t("Filtros e período atuais")}>
              {preview.filters.map((filter) => <li key={filter}>{filter}</li>)}
            </ul>
          ) : null}
        </div>
        <label htmlFor="feishu-demo-group">{t("Grupo de destino")}</label>
        <select id="feishu-demo-group" value={group} onChange={(event) => { setGroup(event.target.value); setCompleted(false); }}>
          <option value="">{t("Selecione um grupo de demonstração")}</option>
          {DEMO_GROUPS.map((demoGroup) => <option key={demoGroup} value={demoGroup}>{t(demoGroup)}</option>)}
        </select>
        <label htmlFor="feishu-share-preview">{t("Prévia do resumo")}</label>
        {preview.contentAvailable ? (
          <textarea id="feishu-share-preview" readOnly value={preview.content} />
        ) : (
          <p className="feishu-share-unavailable" role="status">{t("Não há resumo ou análise disponível para este painel.")}</p>
        )}
        <p className="feishu-share-demo-note">{t("Os grupos e esta confirmação são apenas demonstração. Nenhuma API do Feishu será chamada.")}</p>
        {completed ? (
          <p className="feishu-share-success" role="status">{t("Simulação concluída. Nenhuma mensagem foi enviada ao Feishu.")}</p>
        ) : null}
        <div className="feishu-share-actions">
          <button className="feishu-share-cancel" type="button" onClick={onClose}>{t("Cancelar")}</button>
          <button
            className="feishu-share-confirm"
            type="button"
            disabled={!preview.contentAvailable || !group || completed}
            onClick={() => setCompleted(true)}
          >
            <Send size={15} /> {t("Simular envio")}
          </button>
        </div>
      </section>
    </div>
  );
}
