"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-url.ts";

interface Preview {
  fileSha256: string; reviewSha256?: string; previousMapVersionId?: string | null;
  counts: { units: number; operationalBases: number; types: Record<string, number> };
  errors: unknown[];
  audit?: { newUnits: unknown[]; missingUnits: unknown[]; manualDecisionReview: unknown[] };
}
export function NetworkDirectoryCandidate({ enabled, t }: { enabled: boolean; t: (text: string) => string }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [prepared, setPrepared] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const key = useRef("");
  useEffect(() => () => request.current?.abort(), []);
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
      if (prepare) setPrepared(result.mapVersionId);
      else { setPreview(result as Preview); key.current = ""; }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Não foi possível preparar a candidata DoomsDay.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="data-foundation-card">
    <div className="data-foundation-card-heading"><div><span className="card-eyebrow">DOOMSDAY</span><h2>{t("Nova fonte oficial — Gestão de Rede")}</h2>
      <p>{t("A candidata será preparada para revisão. A publicação exige aprovação em uma etapa futura.")}</p></div></div>
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
  </section>;
}
