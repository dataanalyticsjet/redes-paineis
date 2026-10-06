"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { FeishuShareDialog, type FeishuSharePreview } from "../../components/feishu-share-dialog";
import { dashboardCards, dashboardCategories, type DashboardCategory, type DashboardPanel } from "../dashboards/dashboard-catalog";
export { dashboardCards, dashboardCategories } from "../dashboards/dashboard-catalog";
export type { DashboardCategory, DashboardPanel } from "../dashboards/dashboard-catalog";
import {
  ArrowUpRight,
  ArrowRight,
  ChartNoAxesCombined,
  ClipboardList,
  ExternalLink,
  PackageCheck,
  Plus,
  Send,
  X,
} from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
type ChatContext = { id: string; kind: "dashboard" | "information"; label: string };
type ChatMessage = { id: number; role: "user" | "assistant"; content: string; context: ChatContext[] };
type CustomDashboard = { id: string; title: string; url: string; category: DashboardCategory };

const suggestions = [
  { text: "Quais indicadores posso acompanhar nesta central?", icon: PackageCheck, tone: "red" },
  { text: "Como encontro o painel de taxa de coleta?", icon: ChartNoAxesCombined, tone: "red" },
  { text: "Onde vejo os dados de movimentação?", icon: ClipboardList, tone: "red" },
];

function validHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function AssistantHome({ onSelect, t }: { onSelect: (view: DashboardPanel) => void; t: DashboardTranslator }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contexts, setContexts] = useState<ChatContext[]>([]);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [dashboardPickerOpen, setDashboardPickerOpen] = useState(false);
  const [informationDialogOpen, setInformationDialogOpen] = useState(false);
  const [informationDraft, setInformationDraft] = useState("");
  const [addDashboardDialogOpen, setAddDashboardDialogOpen] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState("");
  const [newDashboardUrl, setNewDashboardUrl] = useState("");
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [customDashboards, setCustomDashboards] = useState<CustomDashboard[]>([]);
  const [activeCategory, setActiveCategory] = useState<DashboardCategory>("first-mile");
  const [sharePreview, setSharePreview] = useState<FeishuSharePreview | null>(null);
  const visibleDashboardCards = dashboardCards.filter((card) => card.category === activeCategory);
  const visibleCustomDashboards = customDashboards.filter((dashboard) => dashboard.category === activeCategory);

  function sendMessage(event?: FormEvent<HTMLFormElement>, suggestion?: string) {
    event?.preventDefault();
    const content = (suggestion ?? draft).trim();
    if (!content) return;
    setMessages((current) => {
      const id = current.length + 1;
      return [
        ...current,
        { id, role: "user", content, context: contexts },
        { id: id + 1, role: "assistant", content: "Assistente em preparação", context: [] },
      ];
    });
    setDraft("");
    setContexts([]);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function addDashboardContext(id: DashboardPanel, title: string) {
    setContexts((current) => current.some((item) => item.id === `dashboard-${id}`)
      ? current
      : [...current, { id: `dashboard-${id}`, kind: "dashboard", label: title }]);
    setDashboardPickerOpen(false);
    setComposerMenuOpen(false);
  }

  function addInformationContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = informationDraft.trim();
    if (!value) return;
    setContexts((current) => [...current, { id: `information-${Date.now()}`, kind: "information", label: value }]);
    setInformationDraft("");
    setInformationDialogOpen(false);
  }

  function closeInformationDialog() {
    setInformationDialogOpen(false);
    setInformationDraft("");
  }

  function addCustomDashboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newDashboardName.trim();
    const url = validHttpUrl(newDashboardUrl);
    if (!title || !url) {
      setDashboardError("Informe um nome e um link válido iniciado por http:// ou https://.");
      return;
    }
    setCustomDashboards((current) => [...current, { id: `custom-${Date.now()}`, title, url, category: "first-mile" }]);
    setNewDashboardName("");
    setNewDashboardUrl("");
    setDashboardError(null);
    setAddDashboardDialogOpen(false);
  }

  function closeAddDashboardDialog() {
    setAddDashboardDialogOpen(false);
    setDashboardError(null);
    setNewDashboardName("");
    setNewDashboardUrl("");
  }

  return (
    <main className="presentation-home" aria-label={t("Central de painéis")}>
      <section className="presentation-chat" aria-labelledby="presentation-chat-title">
        <div className="presentation-chat-heading">
          <span className="presentation-chat-eyebrow"><ChartNoAxesCombined size={17} /><i aria-hidden="true" /> {t("Central operacional")}</span>
          <h1 id="presentation-chat-title">{t("Como posso ajudar?")}</h1>
          <p>{t("Explore os painéis e encontre os indicadores da operação. Ou pergunte o que deseja acompanhar.")}</p>
        </div>
        <div className="presentation-chat-history" aria-live="polite" aria-label={t("Mensagens")}>
          {messages.length ? (
            <div className="presentation-message-list">
              {messages.map((message) => (
                <div className={`presentation-message presentation-message-${message.role}`} key={message.id}>
                  {message.role === "assistant" ? <span className="presentation-message-mark"><ChartNoAxesCombined size={15} /></span> : null}
                  <div className="presentation-message-content">
                    {message.context.length ? <div className="presentation-message-context">{message.context.map((item) => <span key={item.id}>{t(item.kind === "dashboard" ? "Painel: {name}" : "Informação: {name}", { name: item.kind === "dashboard" ? t(item.label) : item.label })}</span>)}</div> : null}
                    <p>{message.role === "assistant" ? t(message.content) : message.content}</p>
                    {message.role === "assistant" ? (() => {
                      const canShareResponse = Boolean(message.content.trim()) && message.content !== "Assistente em preparação";
                      return (
                        <div className="presentation-message-actions">
                          <button
                            type="button"
                            className="presentation-message-share"
                            disabled={!canShareResponse}
                            title={t(canShareResponse ? "Enviar para Feishu" : "Esta resposta ainda não contém uma análise para compartilhar.")}
                            onClick={() => setSharePreview({
                              title: t("Resposta do assistente"),
                              filters: [],
                              content: message.content,
                              contentAvailable: canShareResponse,
                            })}
                          >
                            <Send size={14} /> {t("Enviar para Feishu")}
                          </button>
                        </div>
                      );
                    })() : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="presentation-suggestions">
              <span>{t("Sugestões para começar")}</span>
              {suggestions.map(({ text, icon: Icon, tone }) => (
                <button type="button" key={text} onClick={() => sendMessage(undefined, t(text))}>
                  <span className={`presentation-suggestion-icon ${tone}`}><Icon size={23} /></span>
                  <span className="presentation-suggestion-text">{t(text)}</span>
                  <ArrowRight className="presentation-suggestion-arrow" size={18} />
                </button>
              ))}
            </div>
          )}
        </div>
        <form className="presentation-composer-shell" onSubmit={(event) => sendMessage(event)}>
          {contexts.length ? (
            <div className="presentation-context-list" aria-label={t("Contexto da pergunta")}>
              {contexts.map((item) => (
                <span className="presentation-context-chip" key={item.id} title={item.kind === "dashboard" ? t(item.label) : item.label}>
                  <span>{t(item.kind === "dashboard" ? "Painel: {name}" : "Informação: {name}", { name: item.kind === "dashboard" ? t(item.label) : item.label })}</span>
                  <button type="button" aria-label={t("Remover contexto {name}", { name: item.kind === "dashboard" ? t(item.label) : item.label })} onClick={() => setContexts((current) => current.filter((context) => context.id !== item.id))}><X size={13} /></button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="presentation-composer">
            <div className="presentation-composer-menu-wrap">
              <button className="presentation-add-context" type="button" aria-label={t("Adicionar contexto à pergunta")} aria-expanded={composerMenuOpen} onClick={() => { setComposerMenuOpen((open) => !open); setDashboardPickerOpen(false); }}>
                <Plus size={20} />
              </button>
              {composerMenuOpen ? (
                <div className="presentation-context-menu">
                  {dashboardPickerOpen ? (
                    <>
                      <strong>{t("Adicionar painel como contexto")}</strong>
                      <div className="presentation-context-category-list">
                        {dashboardCategories.map(({ id: category, label }) => {
                          const categoryCards = dashboardCards.filter((card) => card.category === category);
                          return (
                            <section className="presentation-context-category" key={category} aria-label={label}>
                              <span>{label}</span>
                              {categoryCards.length ? categoryCards.map(({ id, title, icon: Icon }) => (
                                <button type="button" key={id} onClick={() => addDashboardContext(id, title)}><Icon size={16} /><span>{t(title)}</span><Plus size={14} /></button>
                              )) : <p>{t("Nenhum dashboard de Last Mile configurado.")}</p>}
                            </section>
                          );
                        })}
                      </div>
                      <button className="presentation-context-menu-back" type="button" onClick={() => setDashboardPickerOpen(false)}>{t("Voltar")}</button>
                    </>
                  ) : (
                    <>
                      <strong>{t("Adicionar contexto")}</strong>
                      <button type="button" onClick={() => setDashboardPickerOpen(true)}><ChartNoAxesCombined size={16} /><span>{t("Adicionar dashboard")}</span><ArrowUpRight size={14} /></button>
                      <button type="button" onClick={() => { setComposerMenuOpen(false); setInformationDialogOpen(true); }}><Plus size={16} /><span>{t("Adicionar informação")}</span><ArrowUpRight size={14} /></button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <label className="sr-only" htmlFor="presentation-chat-message">{t("Escreva uma mensagem")}</label>
            <textarea
              id="presentation-chat-message"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={t("Pergunte sobre os indicadores…")}
            />
            <button className="presentation-send-button" type="submit" aria-label={t("Enviar mensagem")} disabled={!draft.trim()}><Send size={17} /></button>
          </div>
          <small>{t("O botão + adiciona contexto à pergunta. Nada é enviado a um assistente nesta etapa.")}</small>
        </form>
      </section>

      <aside className="presentation-dashboard-sidebar" aria-labelledby="presentation-dashboards-title">
        <div className="presentation-sidebar-heading">
          <div>
            <span className="presentation-sidebar-eyebrow">{t("Painéis disponíveis")}</span>
            <h2 id="presentation-dashboards-title">{t("Meus dashboards")}</h2>
          </div>
          <span className="presentation-dashboard-count">{visibleDashboardCards.length}</span>
        </div>
        <div className="presentation-dashboard-categories" role="group" aria-label={t("Categoria dos dashboards")}>
          {dashboardCategories.map(({ id, label }) => (
            <button
              className={activeCategory === id ? "active" : ""}
              type="button"
              key={id}
              aria-pressed={activeCategory === id}
              onClick={() => setActiveCategory(id)}
            >{label}</button>
          ))}
        </div>
        <div className="presentation-dashboard-list">
          {visibleDashboardCards.map(({ id, title, description, icon: Icon, tone }) => (
            <button className="presentation-dashboard-card" type="button" key={id} onClick={() => onSelect(id)}>
              <span className={`presentation-dashboard-icon ${tone}`}><Icon size={21} /></span>
              <strong>{t(title)}</strong>
              <small>{t(description)}</small>
              <span className="presentation-dashboard-open"><span className="presentation-dashboard-action-label"><ArrowUpRight size={16} />{t("Abrir painel")}</span><span className="presentation-dashboard-arrow"><ArrowRight size={17} /></span></span>
            </button>
          ))}
          {visibleCustomDashboards.map(({ id, title, url }) => (
            <button className="presentation-dashboard-card presentation-custom-dashboard-card" type="button" key={id} onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
              <span className="presentation-dashboard-icon gray"><ExternalLink size={21} /></span>
              <strong>{title}</strong>
              <small>{t("Painel adicionado nesta sessão.")}</small>
              <span className="presentation-dashboard-open"><span className="presentation-dashboard-action-label"><ArrowUpRight size={16} />{t("Abrir painel")}</span><span className="presentation-dashboard-arrow"><ArrowRight size={17} /></span></span>
            </button>
          ))}
          {activeCategory === "first-mile" ? (
            <button className="presentation-dashboard-card presentation-add-dashboard-card" type="button" onClick={() => setAddDashboardDialogOpen(true)}>
              <span className="presentation-add-dashboard-mark"><Plus size={26} /></span>
              <strong>{t("Adicionar dashboard")}</strong>
              <small>{t("Incluir um link nesta sessão.")}</small>
              <span className="presentation-dashboard-open"><span className="presentation-dashboard-action-label">{t("Ação local")}</span><span className="presentation-dashboard-arrow"><ArrowRight size={17} /></span></span>
            </button>
          ) : null}
        </div>
        {activeCategory === "last-mile" && visibleDashboardCards.length === 0 ? (
          <div className="presentation-dashboard-empty" role="status">{t("Nenhum dashboard de Last Mile configurado.")}</div>
        ) : null}
        {visibleCustomDashboards.length ? <p className="presentation-local-only-note">{t("Dashboards adicionados aqui ficam apenas nesta sessão e não são salvos permanentemente.")}</p> : null}
      </aside>

      {informationDialogOpen ? (
        <div className="presentation-dialog-backdrop">
          <section className="presentation-dialog" role="dialog" aria-modal="true" aria-labelledby="presentation-information-title">
            <button className="presentation-dialog-close" type="button" aria-label={t("Cancelar")} onClick={closeInformationDialog}><X size={19} /></button>
            <span className="presentation-dialog-eyebrow">{t("Contexto da pergunta")}</span>
            <h2 id="presentation-information-title">{t("Adicionar informação")}</h2>
            <p>{t("Inclua um detalhe para acompanhar sua pergunta. Ele ficará visível apenas nesta sessão local.")}</p>
            <form onSubmit={addInformationContext}>
              <label htmlFor="presentation-information-input">{t("Informação")}</label>
              <textarea id="presentation-information-input" rows={4} value={informationDraft} onChange={(event) => setInformationDraft(event.target.value)} placeholder={t("Escreva o contexto adicional…")} />
              <div className="presentation-dialog-actions">
                <button className="presentation-dialog-cancel" type="button" onClick={closeInformationDialog}>{t("Cancelar")}</button>
                <button className="presentation-dialog-primary" type="submit" disabled={!informationDraft.trim()}>{t("Adicionar contexto")}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {addDashboardDialogOpen ? (
        <div className="presentation-dialog-backdrop">
          <section className="presentation-dialog" role="dialog" aria-modal="true" aria-labelledby="presentation-add-dashboard-title">
            <button className="presentation-dialog-close" type="button" aria-label={t("Cancelar")} onClick={closeAddDashboardDialog}><X size={19} /></button>
            <span className="presentation-dialog-eyebrow">{t("Personalizar esta sessão")}</span>
            <h2 id="presentation-add-dashboard-title">{t("Adicionar dashboard")}</h2>
            <p>{t("O card ficará disponível somente nesta sessão e não será salvo permanentemente.")}</p>
            {dashboardError ? <p className="presentation-dialog-error" role="alert">{t(dashboardError)}</p> : null}
            <form onSubmit={addCustomDashboard}>
              <label htmlFor="presentation-dashboard-name">{t("Nome do dashboard")}</label>
              <input id="presentation-dashboard-name" value={newDashboardName} onChange={(event) => setNewDashboardName(event.target.value)} maxLength={80} required placeholder={t("Ex.: Indicadores de qualidade")} />
              <label htmlFor="presentation-dashboard-url">{t("Link HTTP ou HTTPS")}</label>
              <input id="presentation-dashboard-url" type="url" inputMode="url" value={newDashboardUrl} onChange={(event) => setNewDashboardUrl(event.target.value)} required placeholder="https://…" />
              <div className="presentation-dialog-actions">
                <button className="presentation-dialog-cancel" type="button" onClick={closeAddDashboardDialog}>{t("Cancelar")}</button>
                <button className="presentation-dialog-primary" type="submit">{t("Adicionar")}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      <FeishuShareDialog preview={sharePreview} onClose={() => setSharePreview(null)} t={t} />
    </main>
  );
}
