"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Search, Settings2, ShieldCheck, UsersRound, X } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import {
  getAdminRegions,
  getManagedUsers,
  updateManagedUser,
  type AdminRegion,
  type ManagedUser,
} from "../../lib/admin-users";

export function UserControl({ t }: { t: DashboardTranslator }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [regions, setRegions] = useState<AdminRegion[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [draftRole, setDraftRole] = useState<"USER" | "ADMIN">("USER");
  const [draftRegions, setDraftRegions] = useState<string[]>([]);
  const [pendingUserIds, setPendingUserIds] = useState<Set<number>>(new Set());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([getManagedUsers(query), getAdminRegions()])
      .then(([usersResponse, regionsResponse]) => {
        if (!active) return;
        setUsers(usersResponse.users);
        setRegions(regionsResponse.regions);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "user_admin_request_failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [query]);

  useEffect(() => {
    if (!editingUser) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setEditingUser(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingUser, saving]);

  async function changeActive(user: ManagedUser) {
    setPendingUserIds((current) => new Set(current).add(user.id));
    setError("");
    try {
      const result = await updateManagedUser(user.id, { isActive: !user.isActive });
      setUsers((current) => current.map((item) => item.id === user.id ? result.user : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "user_admin_request_failed");
    } finally {
      setPendingUserIds((current) => {
        const next = new Set(current);
        next.delete(user.id);
        return next;
      });
    }
  }

  function openEditor(user: ManagedUser) {
    setEditingUser(user);
    setDraftRole(user.platformRole);
    setDraftRegions([...user.additionalRegions]);
    setError("");
  }

  async function saveEditor() {
    if (!editingUser) return;
    setSaving(true);
    setError("");
    try {
      const result = await updateManagedUser(editingUser.id, {
        platformRole: draftRole,
        additionalRegions: draftRegions,
      });
      setUsers((current) => current.map((user) => user.id === result.user.id ? result.user : user));
      setEditingUser(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "user_admin_request_failed");
    } finally {
      setSaving(false);
    }
  }

  const regionName = (code: string | null) => {
    if (!code) return t("Não definido");
    return regions.find((region) => region.code === code)?.name ?? code;
  };

  return (
    <section className="demo-users-page" aria-labelledby="user-admin-title">
      <div className="demo-users-content">
        <div className="demo-users-heading">
          <span className="demo-users-eyebrow"><UsersRound size={16} /> {t("Administração da plataforma")}</span>
          <h1 id="user-admin-title">{t("Controle de usuários")}</h1>
          <p>{t("Gerencie acessos e permissões aos dashboards.")}</p>
          <span className="demo-users-notice"><ShieldCheck size={15} /> {t("A organização define o escopo; o perfil controla a administração.")}</span>
        </div>

        <div className="user-admin-toolbar">
          <label className="user-admin-search">
            <Search size={17} />
            <span className="sr-only">{t("Buscar usuários")}</span>
            <input value={query} onChange={(event) => { setLoading(true); setError(""); setQuery(event.currentTarget.value); }} placeholder={t("Buscar por nome, e-mail ou regional")} />
          </label>
          <span className="user-admin-total">{t("{count} usuários", { count: users.length })}</span>
        </div>

        {error ? <p className="user-admin-error" role="alert"><AlertCircle size={16} /> {t(error)}</p> : null}
        {loading ? <p className="user-admin-loading" role="status"><LoaderCircle size={17} className="monitoring-source-spinner" /> {t("Carregando usuários…")}</p> : (
          <div className="demo-users-table-wrap">
            <table className="demo-users-table user-admin-table">
              <thead><tr>
                <th scope="col">{t("Nome")}</th>
                <th scope="col">{t("Perfil")}</th>
                <th scope="col">{t("Escopo organizacional")}</th>
                <th scope="col">{t("Região/base de origem")}</th>
                <th scope="col">{t("Acessos adicionais")}</th>
                <th scope="col">{t("Status")}</th>
                <th scope="col">{t("Ações")}</th>
              </tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr className={user.isActive ? "" : "demo-users-row-inactive"} key={user.id}>
                    <td data-label={t("Nome")}><strong>{user.name}</strong><small className="user-admin-email">{user.email}</small></td>
                    <td data-label={t("Perfil")}><span className={`user-admin-role${user.platformRole === "ADMIN" ? " is-admin" : ""}`}>{t(user.platformRole === "ADMIN" ? "Administrador" : "Usuário")}</span></td>
                    <td data-label={t("Escopo organizacional")}>{t(user.organizationalScope === "matrix" ? "Matriz" : user.organizationalScope === "base" ? "Base" : "Regional")}</td>
                    <td data-label={t("Região/base de origem")}>{user.homeBase ? `${regionName(user.homeRegion)} · ${user.homeBase}` : regionName(user.homeRegion)}</td>
                    <td data-label={t("Acessos adicionais")}>
                      {user.organizationalScope === "matrix" ? t("Nacional") : user.additionalRegions.length ? user.additionalRegions.map(regionName).join(", ") : t("Nenhum")}
                    </td>
                    <td data-label={t("Status")}>
                      <div className="demo-users-status-control">
                        <button
                          type="button"
                          className={`demo-users-switch${user.isActive ? " is-active" : ""}`}
                          role="switch"
                          aria-checked={user.isActive}
                          aria-label={t(user.isActive ? "Desativar {name}" : "Ativar {name}", { name: user.name })}
                          disabled={pendingUserIds.has(user.id)}
                          onClick={() => void changeActive(user)}
                        ><span /></button>
                        <span className={`demo-users-status${user.isActive ? " is-active" : ""}`}>{t(user.isActive ? "Ativo" : "Desativado")}</span>
                      </div>
                    </td>
                    <td data-label={t("Ações")}><button className="demo-users-manage" type="button" onClick={() => openEditor(user)}><Settings2 size={16} /> {t("Gerenciar acessos")}</button></td>
                  </tr>
                ))}
                {!users.length ? <tr><td colSpan={7} className="user-admin-empty">{t("Nenhum usuário encontrado.")}</td></tr> : null}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingUser ? (
        <div className="demo-users-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditingUser(null); }}>
          <div className="demo-users-modal" role="dialog" aria-modal="true" aria-labelledby="user-admin-modal-title">
            <button ref={closeRef} className="demo-users-modal-close" type="button" onClick={() => setEditingUser(null)} disabled={saving} aria-label={t("Fechar")}><X size={18} /></button>
            <span className="demo-users-modal-eyebrow">{t("Permissões administrativas")}</span>
            <h2 id="user-admin-modal-title">{t("Gerenciar acessos")}</h2>
            <p>{editingUser.name} · {editingUser.email}</p>

            <label className="user-admin-form-label" htmlFor="user-platform-role">{t("Perfil da plataforma")}</label>
            <select id="user-platform-role" value={draftRole} onChange={(event) => setDraftRole(event.currentTarget.value as "USER" | "ADMIN")}>
              <option value="USER">{t("Usuário — acesso operacional")}</option>
              <option value="ADMIN">{t("Administrador — gerencia usuários e fontes")}</option>
            </select>

            <div className="user-admin-home-scope">
              <strong>{t("Escopo original — somente leitura")}</strong>
              <span>{t(editingUser.organizationalScope === "matrix" ? "Matriz" : editingUser.organizationalScope === "base" ? "Base" : "Regional")}: {editingUser.homeBase ? `${regionName(editingUser.homeRegion)} · ${editingUser.homeBase}` : regionName(editingUser.homeRegion)}</span>
            </div>

            <fieldset className="demo-users-access-list user-admin-region-list">
              <legend>{t("Regionais adicionais")}</legend>
              <p className="user-admin-hint">{t("A região de origem permanece como acesso inicial; permissões extras não ampliam o perfil ADMIN.")}</p>
              {editingUser.organizationalScope === "matrix" ? <p className="user-admin-hint">{t("Usuários de Matriz já possuem escopo nacional.")}</p> : regions.map((region) => {
                const locked = region.code === editingUser.homeRegion || editingUser.organizationalScope === "matrix";
                const checked = editingUser.organizationalScope === "matrix" || draftRegions.includes(region.code);
                return (
                  <label key={region.code} className={`demo-users-access-option${locked ? " is-locked" : ""}`}>
                    <input type="checkbox" checked={checked} disabled={locked} onChange={(event) => { const isChecked = event.currentTarget.checked; setDraftRegions((current) => isChecked ? [...current, region.code] : current.filter((code) => code !== region.code)); }} />
                    <span className="demo-users-access-check"><Check size={13} /></span>
                    <span>{region.name} <small>{region.code}{region.code === editingUser.homeRegion ? ` · ${t("Região de origem")}` : ""}</small></span>
                  </label>
                );
              })}
            </fieldset>

            {error ? <p className="user-admin-error" role="alert"><AlertCircle size={16} /> {t(error)}</p> : null}
            <div className="demo-users-modal-actions">
              <button type="button" onClick={() => setEditingUser(null)} disabled={saving}>{t("Cancelar")}</button>
              <button type="button" onClick={() => void saveEditor()} disabled={saving}>
                {saving ? <LoaderCircle size={15} className="monitoring-source-spinner" /> : null}{t(saving ? "Salvando…" : "Salvar alterações")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
