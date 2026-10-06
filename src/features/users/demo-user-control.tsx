"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Settings2, ShieldCheck, UsersRound, X } from "lucide-react";
import { dashboardCards, type DashboardPanel } from "../dashboards/dashboard-catalog";
import type { DashboardTranslator } from "../../lib/i18n";

type DemoUser = {
  id: string;
  name: string;
  email: string;
  region: string;
  active: boolean;
  dashboards: DashboardPanel[];
};

const STORAGE_KEY = "jt-demo-user-control-v1";
const firstMileDashboardCards = dashboardCards.filter((card) => card.category === "first-mile");
const dashboardIds = firstMileDashboardCards.map((card) => card.id);
const exampleUsers: DemoUser[] = [
  { id: "ana", name: "Ana Exemplo", email: "ana.exemplo@example.test", region: "São Paulo", active: true, dashboards: ["monitoramento", "taxa", "epop", "movimentacao"] },
  { id: "bruno", name: "Bruno Demonstração", email: "bruno.demo@example.test", region: "Rio de Janeiro", active: true, dashboards: ["monitoramento", "taxa", "sellers"] },
  { id: "carla", name: "Carla Modelo", email: "carla.modelo@example.test", region: "Minas Gerais", active: true, dashboards: dashboardIds },
  { id: "daniel", name: "Daniel Teste", email: "daniel.teste@example.test", region: "Paraná", active: false, dashboards: ["monitoramento", "bipagem"] },
  { id: "elisa", name: "Elisa Exemplo", email: "elisa.exemplo@example.test", region: "Bahia", active: true, dashboards: ["epop", "movimentacao", "damage"] },
  { id: "felipe", name: "Felipe Modelo", email: "felipe.modelo@example.test", region: "Pernambuco", active: true, dashboards: ["monitoramento", "taxa"] },
  { id: "gabriela", name: "Gabriela Teste", email: "gabriela.teste@example.test", region: "Ceará", active: false, dashboards: ["sellers"] },
  { id: "henrique", name: "Henrique Demonstração", email: "henrique.demo@example.test", region: "Santa Catarina", active: true, dashboards: ["monitoramento", "taxa", "epop", "sellers", "movimentacao"] },
];

function readDemoUsers(): DemoUser[] {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(saved)) return exampleUsers;
    return exampleUsers.map((user) => {
      const entry = saved.find((item) => item && typeof item === "object" && item.id === user.id);
      if (!entry) return user;
      const access = entry.dashboards;
      return {
        ...user,
        active: typeof entry.active === "boolean" ? entry.active : user.active,
        dashboards: Array.isArray(access) ? dashboardIds.filter((id) => access.includes(id)) : user.dashboards,
      };
    });
  } catch {
    return exampleUsers;
  }
}

export function DemoUserControl({ t }: { t: DashboardTranslator }) {
  const [users, setUsers] = useState<DemoUser[]>(exampleUsers);
  const [restored, setRestored] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftAccess, setDraftAccess] = useState<DashboardPanel[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const editingUser = users.find((user) => user.id === editingId);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setUsers(readDemoUsers());
      setRestored(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(users.map(({ id, active, dashboards }) => ({ id, active, dashboards }))));
    } catch {
      // The controls still work in memory when browser storage is unavailable.
    }
  }, [restored, users]);

  useEffect(() => {
    if (!editingId) return;
    closeButtonRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditingId(null);
        openerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [editingId]);

  function closeModal() {
    setEditingId(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  }

  function openAccess(user: DemoUser, button: HTMLButtonElement) {
    openerRef.current = button;
    setDraftAccess([...user.dashboards]);
    setEditingId(user.id);
  }

  function saveAccess() {
    if (!editingId) return;
    setUsers((current) => current.map((user) => user.id === editingId
      ? { ...user, dashboards: dashboardIds.filter((id) => draftAccess.includes(id)) }
      : user));
    closeModal();
  }

  return (
    <section className="demo-users-page" aria-labelledby="demo-users-title">
      <div className="demo-users-content">
        <div className="demo-users-heading">
          <span className="demo-users-eyebrow"><UsersRound size={16} /> {t("Área administrativa — demonstração")}</span>
          <h1 id="demo-users-title">{t("Controle de usuários")}</h1>
          <p>{t("Gerencie acessos e permissões aos dashboards.")}</p>
          <span className="demo-users-notice"><ShieldCheck size={15} /> {t("Demonstração — configurações não persistidas no servidor")}</span>
        </div>

        <div className="demo-users-table-wrap">
          <table className="demo-users-table">
            <thead><tr>
              <th scope="col">{t("Nome")}</th>
              <th scope="col">{t("E-mail")}</th>
              <th scope="col">{t("Regional")}</th>
              <th scope="col">{t("Status")}</th>
              <th scope="col">{t("Dashboards liberados")}</th>
              <th scope="col">{t("Ações")}</th>
            </tr></thead>
            <tbody>
              {users.map((user) => (
                <tr className={user.active ? "" : "demo-users-row-inactive"} key={user.id}>
                  <td data-label={t("Nome")}><strong>{user.name}</strong></td>
                  <td data-label={t("E-mail")}>{user.email}</td>
                  <td data-label={t("Regional")}>{user.region}</td>
                  <td data-label={t("Status")}>
                    <div className="demo-users-status-control">
                      <button
                        type="button"
                        className={`demo-users-switch${user.active ? " is-active" : ""}`}
                        role="switch"
                        aria-checked={user.active}
                        aria-label={t(user.active ? "Desativar {name}" : "Ativar {name}", { name: user.name })}
                        onClick={() => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, active: !item.active } : item))}
                      ><span /></button>
                      <span className={`demo-users-status${user.active ? " is-active" : ""}`}>{t(user.active ? "Ativo" : "Desativado")}</span>
                    </div>
                  </td>
                  <td data-label={t("Dashboards liberados")}><span className="demo-users-count">{t("{count} de {total}", { count: user.dashboards.length, total: firstMileDashboardCards.length })}</span></td>
                  <td data-label={t("Ações")}><button className="demo-users-manage" type="button" onClick={(event) => openAccess(user, event.currentTarget)}><Settings2 size={16} /> {t("Gerenciar acessos")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editingUser ? (
        <div className="demo-users-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <div className="demo-users-modal" role="dialog" aria-modal="true" aria-labelledby="demo-users-modal-title" aria-describedby="demo-users-modal-description">
            <button ref={closeButtonRef} className="demo-users-modal-close" type="button" onClick={closeModal} aria-label={t("Fechar")}><X size={18} /></button>
            <span className="demo-users-modal-eyebrow">{t("Acessos de demonstração")}</span>
            <h2 id="demo-users-modal-title">{t("Gerenciar acessos")}</h2>
            <p id="demo-users-modal-description">{editingUser.name} · {editingUser.email}</p>
            <div className="demo-users-bulk-actions">
              <button type="button" onClick={() => setDraftAccess([...dashboardIds])}>{t("Liberar todos")}</button>
              <button type="button" onClick={() => setDraftAccess([])}>{t("Remover todos")}</button>
            </div>
            <fieldset className="demo-users-access-list">
              <legend>{t("Dashboards disponíveis")}</legend>
              {firstMileDashboardCards.map(({ id, title, icon: Icon }) => (
                <label key={id} className="demo-users-access-option">
                  <input type="checkbox" checked={draftAccess.includes(id)} onChange={(event) => setDraftAccess((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />
                  <span className="demo-users-access-check"><Check size={13} /></span>
                  <Icon size={18} />
                  <span>{t(title)}</span>
                </label>
              ))}
            </fieldset>
            <div className="demo-users-modal-actions">
              <button type="button" onClick={closeModal}>{t("Cancelar")}</button>
              <button type="button" onClick={saveAccess}>{t("Salvar alterações")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
