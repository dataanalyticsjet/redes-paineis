"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Search, Settings2, ShieldCheck, UsersRound, X } from "lucide-react";
import type { DashboardTranslator } from "../../lib/i18n";
import {
  getAdminRegions,
  getManagedUsers,
  getUserAccessAudit,
  updateManagedUser,
  type AdminRegion,
  type ManagedUser,
  type UserAccessAuditEntry,
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
  const [draftOverrideEnabled, setDraftOverrideEnabled] = useState(false);
  const [accessAudit, setAccessAudit] = useState<UserAccessAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [pendingUserIds, setPendingUserIds] = useState<Set<number>>(new Set());
  const closeRef = useRef<HTMLButtonElement>(null);
  const editingUserId = editingUser?.id;

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

  useEffect(() => {
    if (editingUserId === undefined) return;
    let active = true;
    void getUserAccessAudit(editingUserId)
      .then((response) => { if (active) setAccessAudit(response.entries); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "user_admin_request_failed");
      })
      .finally(() => { if (active) setAuditLoading(false); });
    return () => { active = false; };
  }, [editingUserId]);

  async function changeActive(user: ManagedUser) {
    if (user.canChangeStatus !== true) return;
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
    if (user.canManageAccess !== true) return;
    setEditingUser(user);
    setDraftRole(user.platformRole);
    setDraftOverrideEnabled(user.adminOverrideEnabled);
    setDraftRegions(user.adminOverrideEnabled ? [...user.adminAllowedRegions] : []);
    setAccessAudit([]);
    setAuditLoading(true);
    setError("");
  }

  async function saveEditor() {
    if (!editingUser || editingUser.canManageAccess !== true) return;
    setSaving(true);
    setError("");
    try {
      const result = await updateManagedUser(editingUser.id, {
        platformRole: draftRole,
        adminOverrideEnabled: draftOverrideEnabled,
        adminAllowedRegions: draftOverrideEnabled ? draftRegions : [],
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
    return t(regions.find((region) => region.code === code)?.name ?? code);
  };
  const effectiveScopePreview = (user: ManagedUser) => {
    if (draftOverrideEnabled) {
      if (user.organizationalScopePolicy === "V2" && user.feishuRegionStatus !== "RESOLVED") {
        return t("Vínculo organizacional pendente de validação");
      }
      return draftRegions.length ? draftRegions.map(regionName).join(", ") : t("Selecione ao menos uma regional");
    }
    if (user.feishuRegionStatus !== "RESOLVED" || !user.feishuRegionCode) {
      return t("Vínculo organizacional pendente de validação");
    }
    return user.feishuRegionCode === "MATRIZ"
      ? t("Matriz — acesso nacional")
      : regionName(user.feishuRegionCode);
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
                <th scope="col">{t("Regional do Feishu")}</th>
                <th scope="col">{t("Regionais autorizadas")}</th>
                <th scope="col">{t("Status")}</th>
                <th scope="col">{t("Ações")}</th>
              </tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr className={user.isActive ? "" : "demo-users-row-inactive"} key={user.id}>
                    <td data-label={t("Nome")}><strong>{user.name}</strong><small className="user-admin-email">{user.email}</small></td>
                    <td data-label={t("Perfil")}><span className={`user-admin-role${user.platformRole === "ADMIN" ? " is-admin" : ""}`}>{t(user.platformRole === "ADMIN" ? "Administrador" : "Usuário")}</span></td>
                    <td data-label={t("Escopo organizacional")}>{t(user.organizationalScope === "matrix" ? "Matriz" : user.organizationalScope === "base" ? "Base" : user.organizationalScope === "regional" ? "Regional" : "Não identificado")}</td>
                    <td data-label={t("Região/base de origem")}>{user.homeBase ? `${regionName(user.homeRegion)} · ${user.homeBase}` : regionName(user.homeRegion)}</td>
                    <td data-label={t("Regional do Feishu")}>
                      {user.feishuRegionCode ? regionName(user.feishuRegionCode) : t("Regional não identificada")}
                      <small className="user-admin-email">{t(user.feishuRegionStatus)}</small>
                    </td>
                    <td data-label={t("Regionais autorizadas")}>
                      {user.adminOverrideEnabled
                        ? user.effectiveRegions.length ? user.effectiveRegions.map(regionName).join(", ") : t("Nenhum")
                        : user.organizationalScope === "matrix" ? t("Nacional") : user.effectiveRegions.length ? user.effectiveRegions.map(regionName).join(", ") : t("Nenhum")}
                    </td>
                    <td data-label={t("Status")}>
                      <div className="demo-users-status-control">
                        <button
                          type="button"
                          className={`demo-users-switch${user.isActive ? " is-active" : ""}`}
                          role="switch"
                          aria-checked={user.isActive}
                          aria-label={t(user.isActive ? "Desativar {name}" : "Ativar {name}", { name: user.name })}
                          disabled={user.canChangeStatus !== true || pendingUserIds.has(user.id)}
                          onClick={() => void changeActive(user)}
                        ><span /></button>
                        <span className={`demo-users-status${user.isActive ? " is-active" : ""}`}>{t(user.isActive ? "Ativo" : "Desativado")}</span>
                      </div>
                    </td>
                    <td data-label={t("Ações")}><button className="demo-users-manage" type="button" disabled={user.canManageAccess !== true} onClick={() => openEditor(user)}><Settings2 size={16} /> {t("Gerenciar acessos")}</button></td>
                  </tr>
                ))}
                {!users.length ? <tr><td colSpan={8} className="user-admin-empty">{t("Nenhum usuário encontrado.")}</td></tr> : null}
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

            <div className="user-admin-home-scope">
              <strong>{t("Regional recebida do Feishu")}</strong>
              <span>{editingUser.feishuRegionCode ? `${regionName(editingUser.feishuRegionCode)} · ${t(editingUser.feishuRegionStatus)}` : t(editingUser.feishuRegionStatus === "AMBIGUOUS" ? "Regional ambígua" : editingUser.feishuRegionStatus === "SYNC_FAILED" ? "Falha na sincronização Feishu" : "Regional não identificada")}</span>
            </div>

            <label className="user-admin-form-label" htmlFor="user-platform-role">{t("Perfil da plataforma")}</label>
            <select id="user-platform-role" value={draftRole} onChange={(event) => setDraftRole(event.currentTarget.value as "USER" | "ADMIN")}>
              <option value="USER">{t("Usuário — acesso operacional")}</option>
              <option value="ADMIN">{t("Administrador — gerencia usuários e fontes")}</option>
            </select>

            <div className="user-admin-home-scope">
              <strong>{t("Escopo efetivo de dados")}</strong>
              <span>{editingUser.adminOverrideEnabled
                ? editingUser.effectiveRegions.length ? editingUser.effectiveRegions.map(regionName).join(", ") : t("Nenhum")
                : editingUser.organizationalScope === "matrix" ? t("Matriz — acesso nacional") : editingUser.effectiveRegions.length ? editingUser.effectiveRegions.map(regionName).join(", ") : editingUser.homeBase ? `${t("Base")}: ${editingUser.homeBase}` : t("Regional não identificada")}</span>
            </div>

            <fieldset className="user-admin-override-mode">
              <legend>{t("Origem das permissões")}</legend>
              <label>
                <input type="radio" name="user-region-mode" checked={!draftOverrideEnabled} onChange={() => setDraftOverrideEnabled(false)} />
                <span>{t("Usar regional automática do Feishu")}</span>
              </label>
              <label>
                <input type="radio" name="user-region-mode" checked={draftOverrideEnabled} onChange={() => setDraftOverrideEnabled(true)} />
                <span>{t("Permissões personalizadas pelo administrador")}</span>
              </label>
            </fieldset>

            {draftOverrideEnabled ? <fieldset className="demo-users-access-list user-admin-region-list">
              <legend>{t("Regionais autorizadas")}</legend>
              <p className="user-admin-hint">{t("A configuração personalizada substitui a regional do Feishu e não concede perfil ADMIN nem acesso nacional.")}</p>
              {regions.map((region) => (
                <label key={region.code} className="demo-users-access-option">
                  <input type="checkbox" checked={draftRegions.includes(region.code)} onChange={(event) => { const isChecked = event.currentTarget.checked; setDraftRegions((current) => isChecked ? [...current, region.code] : current.filter((code) => code !== region.code)); }} />
                  <span className="demo-users-access-check"><Check size={13} /></span>
                  <span>{t(region.name)} <small>{region.code}</small></span>
                </label>
              ))}
            </fieldset> : null}

            <div className="user-admin-home-scope user-admin-effective-preview" aria-live="polite">
              <strong>{t("Acesso efetivo após salvar")}</strong>
              <span>{effectiveScopePreview(editingUser)}</span>
              <small>{t(draftOverrideEnabled ? "Acesso personalizado pelo administrador" : "Acesso definido pelo Feishu")}</small>
              {draftOverrideEnabled && editingUser.organizationalScopePolicy === "V2" && editingUser.feishuRegionStatus !== "RESOLVED"
                ? <small role="status">{t("V2 exige uma classificação Feishu válida antes de salvar a substituição regional.")}</small>
                : null}
            </div>

            <section className="user-admin-audit" aria-labelledby="user-admin-audit-heading">
              <h3 id="user-admin-audit-heading">{t("Histórico de alterações de acesso")}</h3>
              {auditLoading ? <p role="status">{t("Carregando histórico…")}</p> : accessAudit.length ? (
                <ol>
                  {accessAudit.map((entry) => (
                    <li key={entry.id}>
                      <strong>{t(entry.action)}</strong>
                      <span>{entry.actor} · {new Date(entry.createdAt).toLocaleString()}</span>
                      {entry.regionsAdded.length || entry.regionsRemoved.length ? <small>
                        {entry.regionsAdded.length ? `${t("Liberadas")}: ${entry.regionsAdded.map(regionName).join(", ")}` : ""}
                        {entry.regionsAdded.length && entry.regionsRemoved.length ? " · " : ""}
                        {entry.regionsRemoved.length ? `${t("Revogadas")}: ${entry.regionsRemoved.map(regionName).join(", ")}` : ""}
                      </small> : null}
                      {entry.scopeSourceBefore || entry.scopeSourceAfter ? <small>
                        {t("Origem")}: {t(entry.scopeSourceBefore ?? "NONE")} → {t(entry.scopeSourceAfter ?? "NONE")}
                      </small> : null}
                    </li>
                  ))}
                </ol>
              ) : <p>{t("Nenhuma alteração de acesso registrada.")}</p>}
            </section>

            {error ? <p className="user-admin-error" role="alert"><AlertCircle size={16} /> {t(error)}</p> : null}
            <div className="demo-users-modal-actions">
              <button type="button" onClick={() => setEditingUser(null)} disabled={saving}>{t("Cancelar")}</button>
              <button type="button" onClick={() => void saveEditor()} disabled={saving || (draftOverrideEnabled && draftRegions.length === 0) || (draftOverrideEnabled && editingUser.organizationalScopePolicy === "V2" && editingUser.feishuRegionStatus !== "RESOLVED")}>
                {saving ? <LoaderCircle size={15} className="monitoring-source-spinner" /> : null}{t(saving ? "Salvando…" : "Salvar alterações")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
