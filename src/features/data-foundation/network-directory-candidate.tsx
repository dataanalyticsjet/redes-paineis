"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-url.ts";
import { acceptMappingRevision } from "../../lib/data-foundation/mapping-revision.ts";

interface Preview {
  fileSha256: string; reviewSha256?: string; previousMapVersionId?: string | null;
  counts: { units: number; operationalBases: number; types: Record<string, number> };
  errors: unknown[];
  audit?: {
    previousCount?: number; newUnits: unknown[]; missingUnits: unknown[];
    changes?: Record<string, Array<{ base_code?: string }>>; manualDecisionReview: unknown[];
  };
}
interface ActivationStatus {
  officialVersion: number;
  officialMapVersionId: string;
  candidate: null | {
    mapVersionId: string; version: number; state: string; contractVersion: number;
    rowCount: number; unitMetadataCount: number; contractState: string;
    reviewSha256: string | null; ambiguousNameGroups: number;
    manualDecisionCount: number; pendingManualDecisionCount: number;
    manualDecisionsToCarry: number;
    changeSummary: { previousCount: number | null; newCount: number; addedCount: number; removedCount: number; changedCount: number };
  };
  canPublish: boolean;
  canRollback: boolean;
  rollbackMapVersionId?: string | null;
  rollbackTargetVersion?: number | null;
  alreadyPublished: boolean;
  blockers: string[];
}
export function NetworkDirectoryCandidate({ enabled, t, onClose, onPublished }: {
  enabled: boolean; t: (text: string) => string; onClose: () => void; onPublished: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [prepared, setPrepared] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activation, setActivation] = useState<ActivationStatus | null>(null);
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const activationRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const key = useRef("");
  const refreshActivationStatus = useCallback(async () => {
    activationRequest.current?.abort();
    const controller = new AbortController();
    activationRequest.current = controller;
    try {
      const response = await apiFetch("/api/v2/base-mapping/network-directory/candidates/prepared", {
        method: "GET", cache: "no-store", signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 403
        ? "Esta ação exige autorização administrativa global."
        : "Não foi possível consultar a candidata DoomsDay.");
      if (!controller.signal.aborted) { setActivation(result as ActivationStatus); setActivationError(null); }
    } catch (cause) {
      if (!controller.signal.aborted) setActivationError(cause instanceof Error ? cause.message : "Não foi possível consultar a candidata DoomsDay.");
    }
  }, []);
  useEffect(() => {
    let active = true;
    if (enabled) void Promise.resolve().then(() => active ? refreshActivationStatus() : undefined);
    return () => { active = false; request.current?.abort(); activationRequest.current?.abort(); actionRequest.current?.abort(); };
  }, [enabled, refreshActivationStatus]);
  async function run(prepare: boolean, uploadFile: File | null = file) {
    if (!enabled || !uploadFile) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    const form = new FormData();
    form.append("file", uploadFile);
    const headers = new Headers();
    if (prepare && preview?.reviewSha256 && preview.previousMapVersionId) {
      form.append("expected_map_version_id", preview.previousMapVersionId);
      form.append("review_sha256", preview.reviewSha256);
      headers.set("Idempotency-Key", key.current ||= crypto.randomUUID());
    }
    try {
      const response = await apiFetch(prepare ? "/api/v2/base-mapping/network-directory/candidates" : "/api/v2/base-mapping/network-directory/preview",
        { method: "POST", headers, body: form, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 403) throw new Error("Esta ação exige autorização administrativa global.");
        if (result.detail === "mapping_candidate_schema_not_ready" || result.detail === "source_contract_not_registered") throw new Error("A preparação depende da estrutura e do contrato aprovados pelo administrador.");
        if (result.detail === "mapping_candidate_review_stale") throw new Error("O cadastro mudou. Gere uma nova prévia antes de preparar.");
        throw new Error("Não foi possível preparar a candidata DoomsDay.");
      }
      if (controller.signal.aborted) return;
      if (prepare) { setPrepared(result.mapVersionId); void refreshActivationStatus(); }
      else { setPreview(result as Preview); key.current = ""; }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Não foi possível preparar a candidata DoomsDay.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function changeOfficialMap(action: "publish" | "rollback") {
    const candidate = activation?.candidate;
    const mapVersionId = action === "publish" ? candidate?.mapVersionId : activation?.rollbackMapVersionId;
    if (!enabled || !mapVersionId || activationBusy || (action === "publish" && !candidate)) return;
    const confirmation = action === "publish"
      ? "Confirma publicar a revisão preparada como Depara oficial? O contrato atual será mantido e o mapa vigente ficará preservado para rollback."
      : "Confirma retornar o Depara oficial à revisão anterior? As revisões e os dados históricos serão preservados.";
    const changes = candidate?.changeSummary;
    const changeDetails = action === "publish" && changes
      ? "\n\n" + t("Mapa atual") + ": " + (changes.previousCount ?? "—") + " · " + t("Novo arquivo") + ": " + changes.newCount
        + "\n" + t("Adicionados") + ": " + changes.addedCount + " · " + t("Removidos") + ": " + changes.removedCount
        + " · " + t("Registros alterados") + ": " + changes.changedCount
      : "";
    const changeWarning = action === "publish" && changes
      && (changes.addedCount + changes.removedCount + changes.changedCount > 0)
      ? "\n\n" + t("Atenção: esta revisão altera o conteúdo do mapa. Confira a auditoria antes de publicar.")
      : "";
    if (!window.confirm(t(confirmation) + changeDetails + changeWarning)) return;
    setActivationBusy(true); setActivationError(null);
    const controller = new AbortController();
    actionRequest.current?.abort(); actionRequest.current = controller;
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await apiFetch(`/api/v2/base-mapping/network-directory/candidates/${mapVersionId}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: action === "publish" ? JSON.stringify({
          expectedOfficialMapVersionId: activation?.officialMapVersionId,
          reviewSha256: candidate?.reviewSha256,
        }) : undefined,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail === "manual_decisions_pending"
        ? "Existem decisões manuais pendentes. Resolva-as antes de ativar o mapa."
        : result.detail === "mapping_candidate_review_stale"
          ? "O ponteiro ou a revisão mudou. Atualize o estado antes de tentar novamente."
          : "Não foi possível alterar o DoomsDay oficial.");
      if (typeof result.revision === "string") acceptMappingRevision(result.revision);
      else {
        const revisionResponse = await apiFetch("/api/v2/base-mapping/revision", { cache: "no-store", signal: controller.signal });
        if (revisionResponse.ok) {
          const current = await revisionResponse.json();
          if (typeof current.revision === "string") acceptMappingRevision(current.revision);
        }
      }
      await refreshActivationStatus();
      if (action === "publish") onPublished();
    } catch (cause) {
      if (!controller.signal.aborted) setActivationError(cause instanceof Error ? cause.message : "Não foi possível alterar o DoomsDay oficial.");
    } finally { if (!controller.signal.aborted) setActivationBusy(false); }
  }
  return <div className="data-foundation-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy && !activationBusy) onClose();
  }}>
  <section className="data-foundation-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="network-directory-title">
    <header><div><span className="card-eyebrow">DOOMSDAY</span><h2 id="network-directory-title">{t("Atualizar Depara")}</h2>
      <p>{t("A prévia compara o arquivo com o mapa vigente; publicar exige confirmação explícita de ADMIN MATRIZ.")}</p></div>
      <button type="button" aria-label={t("Fechar")} onClick={onClose} disabled={busy || activationBusy}>×</button>
    </header>
    <label>{t("Lista de contatos da Gestão de Rede (.xlsx)")}
      <input type="file" accept=".xlsx" disabled={!enabled || busy} onChange={event => {
        const selected = event.target.files?.[0] ?? null;
        event.currentTarget.value = "";
        request.current?.abort(); setFile(selected); setPreview(null); setPrepared(null); setError(null); key.current = "";
        if (selected) void run(false, selected);
      }} />
    </label>
    <button type="button" disabled={!enabled || !file || busy} onClick={() => void run(false)}>{t("Gerar prévia da candidata")}</button>
    {busy ? <p role="status">{t("Validando candidata DoomsDay…")}</p> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
    {preview ? <div>
      <p>{t("Unidades")}: {preview.counts.units} · {t("Bases operacionais")}: {preview.counts.operationalBases}</p>
      <p>{t("Mapa atual")}: {preview.audit?.previousCount ?? "—"} · {t("Novo arquivo")}: {preview.counts.units}</p>
      <p>{Object.entries(preview.counts.types).map(([type, count]) => type + ": " + count).join(" · ")}</p>
      <p>{t("Adicionados")}: {preview.audit?.newUnits.length ?? "—"} · {t("Removidos")}: {preview.audit?.missingUnits.length ?? "—"} · {t("Registros alterados")}: {preview.audit?.changes ? new Set(Object.values(preview.audit.changes).flat().map((item) => item.base_code).filter(Boolean)).size : "—"}</p>
      {preview.errors.length ? <p role="alert">{t("Erros bloqueantes")}: {preview.errors.length}</p> : null}
      {preview.audit && (preview.audit.newUnits.length + preview.audit.missingUnits.length + Object.values(preview.audit.changes ?? {}).flat().length > 0)
        ? <p role="alert">{t("Atenção: esta revisão altera o conteúdo do mapa. Confira a auditoria antes de publicar.")}</p>
        : null}
      <details><summary>{t("Auditoria completa da candidata")}</summary><pre style={{ maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(preview, null, 2)}</pre></details>
      <button type="button" disabled={!enabled || busy || preview.errors.length > 0 || !preview.reviewSha256 || !preview.previousMapVersionId || Boolean(prepared)} onClick={() => void run(true)}>{t("Preparar candidata para revisão")}</button>
    </div> : null}
    {prepared ? <p role="status">{t("Candidata preparada. A versão vigente continua ativa.")} <code>{prepared}</code></p> : null}
    <div className="data-foundation-activation" aria-live="polite">
      <h3>{t("Do-para oficial")}</h3>
      {activationError ? <p role="alert">{t(activationError)}</p> : null}
      {!activation ? <p>{t("Verificando candidata preparada…")}</p> : activation.candidate ? <>
        <p>{t("Versão vigente")}: V{activation.officialVersion} · {t("Candidata")}: V{activation.candidate.version} ({activation.candidate.state})</p>
        <p>{t("Unidades verificadas")}: {activation.candidate.rowCount} · {t("Com metadados organizacionais")}: {activation.candidate.unitMetadataCount}</p>
        <p>{t("Contrato")}: V{activation.candidate.contractVersion} ({activation.candidate.contractState}) · {t("Grupos de nomes ambíguos permanecem sem associação automática")}: {activation.candidate.ambiguousNameGroups}</p>
        {activation.candidate.pendingManualDecisionCount ? <p role="alert">{t("Decisões manuais pendentes")}: {activation.candidate.pendingManualDecisionCount}</p> : null}
        {activation.blockers.length ? <p>{t("A publicação está bloqueada pelas verificações de segurança.")} {activation.blockers.map((blocker) => t(blocker)).join(" · ")}</p> : null}
        {activation.canPublish ? <button type="button" disabled={!enabled || busy || activationBusy} onClick={() => void changeOfficialMap("publish")}>{t("Publicar como DoomsDay oficial")}</button> : null}
        {activation.canRollback ? <button type="button" disabled={!enabled || busy || activationBusy} onClick={() => void changeOfficialMap("rollback")}>{t("Reverter para a revisão anterior")}</button> : null}
        {activation.alreadyPublished ? <p role="status">{t("Esta revisão está ativa como Depara oficial.")}</p> : null}
        <button type="button" disabled={!enabled || activationBusy} onClick={() => void refreshActivationStatus()}>{t("Atualizar estado do DoomsDay")}</button>
      </> : <p>{t("Nenhuma revisão preparada foi encontrada.")}</p>}
    </div>
    <footer><button type="button" className="data-foundation-retry-validation" onClick={onClose} disabled={busy || activationBusy}>{t("Cancelar")}</button></footer>
  </section>
  </div>;
}
