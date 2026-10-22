"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-url.ts";
import { acceptMappingRevision } from "../../lib/data-foundation/mapping-revision.ts";

interface Preview {
  fileSha256: string; reviewSha256?: string; previousMapVersionId?: string | null;
  counts: { units: number; operationalBases: number; types: Record<string, number> };
  errors: unknown[];
  audit?: { newUnits: unknown[]; missingUnits: unknown[]; manualDecisionReview: unknown[] };
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
  };
  canPublish: boolean;
  canRollback: boolean;
  alreadyPublished: boolean;
  blockers: string[];
}
export function NetworkDirectoryCandidate({ enabled, t }: { enabled: boolean; t: (text: string) => string }) {
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
  async function run(prepare: boolean) {
    if (!enabled || !file) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null);
    const form = new FormData();
    form.append("file", file);
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
    if (!enabled || !candidate || activationBusy) return;
    const message = action === "publish"
      ? "Confirma publicar a versão DoomsDay V2 como oficial? A ação aprovará o contrato V2 se necessário, atualizará o ponteiro oficial e invalidará os caches organizacionais."
      : "Confirma retornar o ponteiro DoomsDay oficial para a versão V1? A versão V2 será preservada no histórico. Os caches organizacionais serão invalidados.";
    if (!window.confirm(message)) return;
    setActivationBusy(true); setActivationError(null);
    const controller = new AbortController();
    actionRequest.current?.abort(); actionRequest.current = controller;
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await apiFetch(`/api/v2/base-mapping/network-directory/candidates/${candidate.mapVersionId}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: action === "publish" ? JSON.stringify({
          expectedOfficialMapVersionId: activation?.officialMapVersionId,
          reviewSha256: candidate.reviewSha256,
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
    } catch (cause) {
      if (!controller.signal.aborted) setActivationError(cause instanceof Error ? cause.message : "Não foi possível alterar o DoomsDay oficial.");
    } finally { if (!controller.signal.aborted) setActivationBusy(false); }
  }
  return <section className="data-foundation-card">
    <div className="data-foundation-card-heading"><div><span className="card-eyebrow">DOOMSDAY</span><h2>{t("Nova fonte oficial — Gestão de Rede")}</h2>
      <p>{t("A preparação não publica o mapa. A ativação oficial exige confirmação explícita de um administrador MATRIZ.")}</p></div></div>
    <label>{t("Lista de contatos da Gestão de Rede (.xlsx)")}
      <input type="file" accept=".xlsx" disabled={!enabled || busy} onChange={event => {
        request.current?.abort(); setFile(event.target.files?.[0] ?? null); setPreview(null); setPrepared(null); setError(null); key.current = "";
      }} />
    </label>
    <button type="button" disabled={!enabled || !file || busy} onClick={() => void run(false)}>{t("Gerar prévia da candidata")}</button>
    {busy ? <p role="status">{t("Validando candidata DoomsDay…")}</p> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
    {preview ? <div>
      <p>{t("Unidades")}: {preview.counts.units} · {t("Bases operacionais")}: {preview.counts.operationalBases}</p>
      <p>{Object.entries(preview.counts.types).map(([type, count]) => type + ": " + count).join(" · ")}</p>
      <p>{t("Novas unidades")}: {preview.audit?.newUnits.length ?? "—"} · {t("Unidades ausentes")}: {preview.audit?.missingUnits.length ?? "—"}</p>
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
        {activation.canRollback ? <button type="button" disabled={!enabled || busy || activationBusy} onClick={() => void changeOfficialMap("rollback")}>{t("Reverter DoomsDay oficial para V1")}</button> : null}
        {activation.alreadyPublished ? <p role="status">{t("A versão V2 está ativa como DoomsDay oficial.")}</p> : null}
        <button type="button" disabled={!enabled || activationBusy} onClick={() => void refreshActivationStatus()}>{t("Atualizar estado do DoomsDay")}</button>
      </> : <p>{t("Nenhuma candidata V2 preparada foi encontrada.")}</p>}
    </div>
  </section>;
}
