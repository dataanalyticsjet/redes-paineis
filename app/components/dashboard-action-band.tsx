"use client";

import { CalendarDays, Printer, Send, Sparkles } from "lucide-react";
import type { DashboardTranslator } from "../lib/i18n";

export function DashboardActionBand({
  reportDate,
  demoMode,
  onPrint,
  onAnalysis,
  onShare,
  t,
}: {
  reportDate: string;
  demoMode: boolean;
  onPrint: () => void;
  onAnalysis: () => void;
  onShare: () => void;
  t: DashboardTranslator;
}) {
  return (
    <section className="dashboard-action-band" aria-label={t("Informações e ações do painel")}>
      <div className="dashboard-action-info">
        <span className="dashboard-report-generated"><CalendarDays size={15} /> {t("Relatório gerado em: {date}", { date: reportDate })}</span>
        {demoMode ? <span className="dashboard-demo-indicator" role="status">{t("Demonstração — dados simulados")}</span> : null}
      </div>
      <div className="dashboard-action-buttons">
        <button type="button" onClick={onPrint}><Printer size={16} /> {t("Gerar PDF")}</button>
        <button type="button" onClick={onAnalysis}><Sparkles size={16} /> {t("Análise IA")}</button>
        <button type="button" onClick={onShare}><Send size={15} /> {t("Enviar para Feishu")}</button>
      </div>
    </section>
  );
}
