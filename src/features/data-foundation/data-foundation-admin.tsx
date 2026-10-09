"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api-url";
import type { DashboardTranslator } from "../../lib/i18n";
import { AlertTriangle, Check, Clock3, Database, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";

type Source = {
  source_id: string;
  display_name: string;
  source_state: string;
  history_policy: string;
};

type Contract = {
  sourceId: string;
  version: number;
  state: string;
  sheet: string;
  headerRow: number;
  historyPolicy: string;
  contractSha256: string | null;
  grain: string;
  columns: { key: string; header: string; type: string; required: boolean; nullable: boolean }[];
};

type Publication = {
  publicationId: string;
  version: number;
  publishedAt: string | null;
  visibleRowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
};

type Preview = {
  jobId: string;
  sourceId: string;
  expectedBaseCount?: number;
  fileSha256: string;
  inputRowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  duplicateCount: number;
  duplicateBaseCodeCount: number;
  mappedRowCount: number;
  unmappedRowCount: number;
  exactNameCandidateRowCount: number;
  noMappingMatchRowCount: number;
  missingIdentifierRowCount: number;
  ambiguousRowCount: number;
  mappingVersionAvailable: boolean;
  mappingVersionId: string | null;
  perDateCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  errors: { rowNumber: number; column: string | null; code: string }[];
  canPublish: boolean;
};

type CandidateTarget = { baseCode: string; baseName: string; region: string | null; uf: string | null };
type NameCandidate = {
  sourceBaseName: string;
  sourceRowCount: number;
  exactTargetCandidates: CandidateTarget[];
  decisionState: "UNREVIEWED" | "LINKED" | "AMBIGUOUS" | "REJECTED";
  approvedTargetBaseCode: string | null;
};

type MappingStatus = {
  state: string;
  mappingVersionId: string | null;
  version: number | null;
  publishedAt: string | null;
  visibleBaseCount: number;
};

const NAME_MAPPED_SOURCES = new Set(["collection_monitoring", "collection_rate", "jt_monitoring"]);
const INITIAL_MAPPING_SOURCE = "base_mapping_official";
const API_ERROR_LABELS: Record<string, string> = {
  admin_required: "Somente administradores podem executar esta ação.",
  matrix_scope_required: "A ação exige administrador com escopo organizacional matrix.",
  data_store_unavailable: "O banco de dados da Data Foundation está indisponível.",
  import_storage_unavailable: "O armazenamento privado de importação não está configurado.",
  official_mapping_unavailable: "O de-para vigente ainda não está publicado.",
  source_contract_not_registered: "O contrato oficial desta fonte não está registrado.",
  official_mapping_changed_repreview: "O arquivo precisa de nova prévia após uma alteração no de-para.",
  import_job_not_found: "Esta importação não pertence ao usuário atual.",
  name_mapping_not_supported_for_source: "Nome exato não suportado nesta fonte.",
  mapping_review_note_required: "A decisão de revisão exige uma justificativa.",
  mapping_target_must_be_unique_exact_match: "O destino só pode ser aprovado quando houver uma única correspondência exata.",
  legacy_mapping_source_hash_not_reviewed: "O hash do arquivo não corresponde à cópia oficial revisada.",
  legacy_mapping_1628_rows_required: "O de-para precisa conter exatamente 1.628 linhas válidas.",
  base_mapping_migration_already_initialized: "A migração inicial do de-para já foi concluída.",
};

function displayApiError(error: string, t: DashboardTranslator): string {
  const label = API_ERROR_LABELS[error];
  if (label) return t(label);
  if (/^[a-z][a-z0-9_]+$/.test(error)) return t("Não foi possível concluir a operação.");
  return t(error);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, { cache: "no-store", ...init });
  if (response.ok) return await response.json() as T;
  let detail = "data_foundation_request_failed";
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Keep transport details out of the management screen.
  }
  throw new Error(detail);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR");
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

export function DataFoundationAdmin({
  t,
  canImport,
}: {
  t: DashboardTranslator;
  canImport: boolean;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [contracts, setContracts] = useState<Record<string, Contract>>({});
  const [publications, setPublications] = useState<Record<string, Publication[]>>({});
  const [mapping, setMapping] = useState<MappingStatus | null>(null);
  const [selectedSource, setSelectedSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mappingFile, setMappingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewSource, setPreviewSource] = useState("");
  const [candidates, setCandidates] = useState<NameCandidate[]>([]);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [mappingReviewDirty, setMappingReviewDirty] = useState(false);
  const [acknowledgeUnmapped, setAcknowledgeUnmapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMetadata = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestJson<{ sources: Source[] }>("/api/v2/data-sources");
      setSources(result.sources);
      setSelectedSource((current) => current || result.sources[0]?.source_id || "");
      const [mapStatus, sourceMetadata] = await Promise.all([
        requestJson<MappingStatus>("/api/v2/base-mapping/current"),
        Promise.all(result.sources.map(async (source) => {
          const contractRequest = requestJson<Contract>(`/api/v2/data-sources/${encodeURIComponent(source.source_id)}/contract`);
          const historyRequest = requestJson<{ publications: Publication[] }>(`/api/v2/data-sources/${encodeURIComponent(source.source_id)}/publications?limit=50`)
            .catch((caught) => {
              if (caught instanceof Error && caught.message === "data_foundation_v2_disabled") return { publications: [] };
              throw caught;
            });
          const [contract, history] = await Promise.all([contractRequest, historyRequest]);
          return [source.source_id, { contract, publications: history.publications }] as const;
        })),
      ]);
      setMapping(mapStatus);
      setContracts(Object.fromEntries(sourceMetadata.map(([id, data]) => [id, data.contract])));
      setPublications(Object.fromEntries(sourceMetadata.map(([id, data]) => [id, data.publications])));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "data_foundation_request_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMetadata();
  }, [loadMetadata]);

  const contract = contracts[selectedSource];
  const sourcePublications = publications[selectedSource] ?? [];
  const latestPublication = sourcePublications[0];
  const importActionsEnabled = canImport && error !== "data_foundation_v2_disabled";
  const visibleCandidates = useMemo(() => {
    const query = normalize(candidateQuery.trim());
    return candidates
      .filter((candidate) => !query || normalize(candidate.sourceBaseName).includes(query))
      .slice(0, 50);
  }, [candidateQuery, candidates]);

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !selectedSource) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCandidates([]);
    setMappingReviewDirty(false);
    setAcknowledgeUnmapped(false);
    try {
      const body = new FormData();
      body.append("source_id", selectedSource);
      body.append("file", file, file.name);
      const result = await requestJson<Preview>("/api/v2/imports/preview", { method: "POST", body });
      setPreview(result);
      setPreviewSource(selectedSource);
      if (NAME_MAPPED_SOURCES.has(selectedSource)) {
        const candidatesResult = await requestJson<{ candidates: NameCandidate[] }>(
          `/api/v2/base-mapping/name-candidates/${encodeURIComponent(result.jobId)}`,
        );
        setCandidates(candidatesResult.candidates);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "data_foundation_preview_failed");
    } finally {
      setBusy(false);
    }
  }

  async function makeMappingPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mappingFile) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCandidates([]);
    setMappingReviewDirty(false);
    setAcknowledgeUnmapped(false);
    try {
      const body = new FormData();
      body.append("file", mappingFile, mappingFile.name);
      const result = await requestJson<Preview>("/api/v2/base-mapping/initial-migration/preview", { method: "POST", body });
      setPreview(result);
      setPreviewSource(INITIAL_MAPPING_SOURCE);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "base_mapping_preview_failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveDecision(candidate: NameCandidate, state: "LINKED" | "AMBIGUOUS" | "REJECTED") {
    if (!preview || !reviewNote.trim()) {
      setError("Informe a justificativa da revisão antes de registrar a decisão.");
      return;
    }
    const target = candidate.exactTargetCandidates.length === 1 ? candidate.exactTargetCandidates[0] : null;
    if (state === "LINKED" && !target) return;
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/v2/base-mapping/name-decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: preview.sourceId,
          sourceBaseName: candidate.sourceBaseName,
          resolutionState: state,
          targetBaseCode: state === "LINKED" ? target?.baseCode : null,
          reviewNote: reviewNote.trim(),
        }),
      });
      const report = await requestJson<{ candidates: NameCandidate[] }>(
        `/api/v2/base-mapping/name-candidates/${encodeURIComponent(preview.jobId)}`,
      );
      setCandidates(report.candidates);
      setMappingReviewDirty(true);
      setNotice("Revisão registrada. Revalide o arquivo para recalcular a cobertura.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "mapping_decision_failed");
    } finally {
      setBusy(false);
    }
  }

  async function revalidate() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestJson<Preview>(`/api/v2/imports/${encodeURIComponent(preview.jobId)}/validate`, { method: "POST" });
      setPreview(result);
      setMappingReviewDirty(false);
      if (NAME_MAPPED_SOURCES.has(result.sourceId)) {
        const report = await requestJson<{ candidates: NameCandidate[] }>(
          `/api/v2/base-mapping/name-candidates/${encodeURIComponent(result.jobId)}`,
        );
        setCandidates(report.candidates);
      }
      setAcknowledgeUnmapped(false);
      setNotice("Arquivo revalidado com as decisões atuais do de-para.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "data_foundation_validation_failed");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!preview || !preview.canPublish || mappingReviewDirty) return;
    if (preview.unmappedRowCount > 0 && !acknowledgeUnmapped) return;
    const mappingPublish = previewSource === INITIAL_MAPPING_SOURCE;
    const prompt = mappingPublish
      ? "Publicar o de-para oficial como versão inicial? Esta ação altera o ponteiro vigente no banco configurado."
      : `Publicar ${formatCount(preview.validRowCount)} registros em ${sources.find((source) => source.source_id === previewSource)?.display_name ?? previewSource}?`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const headers = { "Idempotency-Key": crypto.randomUUID() };
      const path = mappingPublish
        ? `/api/v2/base-mapping/initial-migration/${encodeURIComponent(preview.jobId)}/publish`
        : `/api/v2/imports/${encodeURIComponent(preview.jobId)}/publish`;
      const result = await requestJson<{ version: number; mappingRowCount?: number; reused?: boolean }>(path, { method: "POST", headers });
      const successNotice = mappingPublish
        ? t("De-para publicado como versão {version} com {count} bases.", {
            version: result.version,
            count: formatCount(result.mappingRowCount ?? 0),
          })
        : t("Publicação {state} na versão {version}.", {
            state: result.reused ? t("reutilizada") : t("concluída"),
            version: result.version,
          });
      setPreview(null);
      setFile(null);
      setMappingFile(null);
      setMappingReviewDirty(false);
      await loadMetadata();
      setNotice(successNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "data_foundation_publish_failed");
    } finally {
      setBusy(false);
    }
  }

  const isMappingPreview = previewSource === INITIAL_MAPPING_SOURCE;
  const canPublish = Boolean(
    importActionsEnabled
    && preview?.canPublish
    && (preview.unmappedRowCount === 0 || acknowledgeUnmapped)
    && !mappingReviewDirty
    && !busy,
  );

  return (
    <section className="data-foundation-admin" aria-labelledby="data-foundation-title">
      <div className="data-foundation-heading">
        <div>
          <span className="card-eyebrow"><Database size={15} /> DATA FOUNDATION V2</span>
          <h1 id="data-foundation-title">{t("Central de Dados")}</h1>
          <p>{t("Contratos, arquivos oficiais, validação e histórico de publicação.")}</p>
        </div>
        <button type="button" className="data-foundation-refresh" onClick={() => void loadMetadata()} disabled={loading || busy}>
          <RefreshCw size={16} /> {t("Atualizar")}
        </button>
      </div>

      {mapping ? (
        <div className={`data-foundation-map-status ${mapping.state === "PUBLISHED" ? "is-ready" : "is-pending"}`}>
          <Database size={17} />
          <span><strong>{t("De-para vigente")}</strong> · {mapping.state === "PUBLISHED" ? t("Versão {version}", { version: mapping.version ?? "—" }) : t("Ainda não publicado")}</span>
          <span>{t("{count} bases visíveis", { count: formatCount(mapping.visibleBaseCount) })}</span>
          {mapping.publishedAt ? <small>{formatDateTime(mapping.publishedAt)}</small> : null}
        </div>
      ) : null}

      {error ? (
        <div className={`data-foundation-alert ${error === "data_foundation_v2_disabled" ? "is-disabled" : "is-error"}`} role="alert">
          {error === "data_foundation_v2_disabled" ? <Clock3 size={18} /> : <AlertTriangle size={18} />}
          <div>
            <strong>{error === "data_foundation_v2_disabled" ? t("Data Foundation V2 desativada neste ambiente") : displayApiError(error, t)}</strong>
            {error === "data_foundation_v2_disabled" ? <p>{t("Configure DATA_QUERIES_ENABLED=true e DATA_IMPORT_ENABLED=true com as credenciais dedicadas DATA_DB_* e o diretório DATA_IMPORT_STAGING_DIRECTORY para habilitar a Central localmente.")}</p> : null}
          </div>
        </div>
      ) : null}
      {!canImport && !error?.includes("disabled") ? <div className="data-foundation-alert is-disabled"><AlertTriangle size={18} /><p>{t("Seu perfil pode consultar apenas dados do próprio escopo. A prévia e a publicação nacional exigem administrador com autorização organizacional matrix.")}</p></div> : null}
      {notice ? <div className="data-foundation-notice" role="status"><Check size={17} /> {t(notice)}</div> : null}

      {loading ? <p className="data-foundation-loading">{t("Carregando fontes e histórico…")}</p> : null}
      {!loading && sources.length ? (
        <div className="data-foundation-layout">
          <nav className="data-foundation-source-list" aria-label={t("Fontes de dados")}>
            {sources.map((source) => {
              const sourceContract = contracts[source.source_id];
              const last = publications[source.source_id]?.[0];
              return (
                <button
                  type="button"
                  key={source.source_id}
                  className={`data-foundation-source${selectedSource === source.source_id ? " is-selected" : ""}`}
                  onClick={() => { setSelectedSource(source.source_id); setPreview(null); setCandidates([]); setMappingReviewDirty(false); setFile(null); }}
                >
                  <FileSpreadsheet size={18} />
                  <span><strong>{t(source.display_name)}</strong><small>{sourceContract ? `${sourceContract.columns.length} ${t("colunas")} · v${sourceContract.version}` : t("Contrato indisponível")}</small></span>
                  <small>{last ? `v${last.version}` : t("Sem publicação")}</small>
                </button>
              );
            })}
          </nav>

          <div className="data-foundation-content">
            {contract ? (
              <>
                <section className="data-foundation-card">
                  <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("CONTRATO OFICIAL")}</span><h2>{t(sources.find((source) => source.source_id === selectedSource)?.display_name ?? selectedSource)}</h2></div><span className="data-foundation-state">{t(contract.state)}</span></div>
                  <div className="data-foundation-facts">
                    <span>{t("Aba")}: <strong>{contract.sheet}</strong></span>
                    <span>{t("Linha do cabeçalho")}: <strong>{contract.headerRow}</strong></span>
                    <span>{t("Colunas")}: <strong>{contract.columns.length}</strong></span>
                    <span>{t("Histórico")}: <strong>{t(contract.historyPolicy)}</strong></span>
                  </div>
                  <p className="data-foundation-grain">{t(contract.grain)}</p>
                  <details className="data-foundation-details"><summary>{t("Ver as {count} colunas", { count: contract.columns.length })}</summary><div className="data-foundation-column-grid">{contract.columns.map((column) => <span key={column.key}><strong>{column.header}</strong><small>{column.type}{column.nullable ? ` · ${t("opcional")}` : ` · ${t("obrigatório")}`}</small></span>)}</div></details>
                </section>

                <section className="data-foundation-card">
                  <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("PUBLICAÇÕES")}</span><h2>{t("Última publicação e histórico")}</h2></div>{latestPublication ? <span className="data-foundation-state is-ready">{t("Versão {version}", { version: latestPublication.version })}</span> : <span className="data-foundation-state">{t("Sem publicação")}</span>}</div>
                  {latestPublication ? <p className="data-foundation-latest"><Clock3 size={15} /> {formatDateTime(latestPublication.publishedAt)} · {formatCount(latestPublication.visibleRowCount)} {t("registros visíveis")}{latestPublication.periodStart ? ` · ${latestPublication.periodStart} – ${latestPublication.periodEnd}` : ""}</p> : null}
                  {sourcePublications.length ? <div className="data-foundation-history">{sourcePublications.map((publication) => <div key={publication.publicationId}><span>{t("Versão {version}", { version: publication.version })}</span><span>{formatDateTime(publication.publishedAt)}</span><strong>{formatCount(publication.visibleRowCount)} {t("registros")}</strong><small>{publication.periodStart ? `${publication.periodStart} – ${publication.periodEnd}` : t("Snapshot")}</small></div>)}</div> : <p className="data-foundation-empty">{t("Ainda não há publicações visíveis para este escopo.")}</p>}
                </section>

                <section className="data-foundation-card">
                  <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("NOVA CARGA")}</span><h2>{t("Validar arquivo Excel")}</h2></div></div>
                  <form className="data-foundation-upload-form" onSubmit={(event) => void makePreview(event)}>
                    <label>{t("Arquivo oficial .xlsx")}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setMappingReviewDirty(false); }} disabled={!importActionsEnabled || busy} /></label>
                    <button type="submit" disabled={!importActionsEnabled || !file || busy}><Upload size={16} />{t("Gerar prévia")}</button>
                  </form>
                </section>

                {preview && !isMappingPreview ? <PreviewPanel preview={preview} candidates={candidates} candidateQuery={candidateQuery} reviewNote={reviewNote} visibleCandidates={visibleCandidates} canImport={importActionsEnabled} busy={busy} mappingReviewDirty={mappingReviewDirty} acknowledgeUnmapped={acknowledgeUnmapped} onCandidateQuery={setCandidateQuery} onReviewNote={setReviewNote} onAcknowledge={setAcknowledgeUnmapped} onDecision={(candidate, state) => void saveDecision(candidate, state)} onRevalidate={() => void revalidate()} onPublish={() => void publish()} canPublish={canPublish} t={t} /> : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {canImport ? (
        <section className="data-foundation-card data-foundation-initial-map">
          <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("MIGRAÇÃO INICIAL")}</span><h2>{t("De-para oficial DoomsDay")}</h2><p>{t("A migração preserva o arquivo original como versão 1 e só atualiza o ponteiro após validação e confirmação.")}</p></div><span className={`data-foundation-state ${mapping?.state === "PUBLISHED" ? "is-ready" : ""}`}>{mapping?.state === "PUBLISHED" ? t("Publicado") : t("Pendente")}</span></div>
          <form className="data-foundation-upload-form" onSubmit={(event) => void makeMappingPreview(event)}>
            <label>{t("De_para DoomsDay.xlsx · aba Ativas")}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setMappingFile(event.target.files?.[0] ?? null); setPreview(null); }} disabled={!importActionsEnabled || busy || mapping?.state === "PUBLISHED"} /></label>
            <button type="submit" disabled={!importActionsEnabled || !mappingFile || busy || mapping?.state === "PUBLISHED"}><Upload size={16} />{t("Validar de-para")}</button>
          </form>
        </section>
      ) : null}

      {preview && isMappingPreview ? <PreviewPanel preview={preview} candidates={[]} candidateQuery="" reviewNote="" visibleCandidates={[]} canImport={importActionsEnabled} busy={busy} mappingReviewDirty={false} acknowledgeUnmapped={acknowledgeUnmapped} onCandidateQuery={() => undefined} onReviewNote={() => undefined} onAcknowledge={setAcknowledgeUnmapped} onDecision={() => undefined} onRevalidate={() => void revalidate()} onPublish={() => void publish()} canPublish={canPublish} t={t} /> : null}
    </section>
  );
}

function PreviewPanel({
  preview,
  candidates,
  candidateQuery,
  reviewNote,
  visibleCandidates,
  canImport,
  busy,
  mappingReviewDirty,
  acknowledgeUnmapped,
  onCandidateQuery,
  onReviewNote,
  onAcknowledge,
  onDecision,
  onRevalidate,
  onPublish,
  canPublish,
  t,
}: {
  preview: Preview;
  candidates: NameCandidate[];
  candidateQuery: string;
  reviewNote: string;
  visibleCandidates: NameCandidate[];
  canImport: boolean;
  busy: boolean;
  mappingReviewDirty: boolean;
  acknowledgeUnmapped: boolean;
  onCandidateQuery: (value: string) => void;
  onReviewNote: (value: string) => void;
  onAcknowledge: (value: boolean) => void;
  onDecision: (candidate: NameCandidate, state: "LINKED" | "AMBIGUOUS" | "REJECTED") => void;
  onRevalidate: () => void;
  onPublish: () => void;
  canPublish: boolean;
  t: DashboardTranslator;
}) {
  const isBaseMapping = preview.sourceId === INITIAL_MAPPING_SOURCE;
  const coverage = isBaseMapping
    ? Math.round((preview.validRowCount - preview.duplicateBaseCodeCount) / (preview.expectedBaseCount || 1628) * 100)
    : preview.validRowCount ? Math.round(preview.mappedRowCount / preview.validRowCount * 100) : 0;
  return (
    <section className="data-foundation-card data-foundation-preview" aria-labelledby="data-foundation-preview-title">
      <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("PRÉVIA")}</span><h2 id="data-foundation-preview-title">{t("Resultado da validação")}</h2><p>{t("Arquivo")}: {preview.fileSha256.slice(0, 16)}…</p></div><span className={`data-foundation-state ${preview.canPublish ? "is-ready" : "is-error"}`}>{preview.canPublish ? t("Válido para publicação") : t("Corrija os erros")}</span></div>
      <div className="data-foundation-metrics">
        <Metric label={t("Linhas recebidas")} value={preview.inputRowCount} />
        <Metric label={isBaseMapping ? t("Linhas válidas") : t("Válidas")} value={preview.validRowCount} />
        <Metric label={t("Inválidas")} value={preview.invalidRowCount} />
        {isBaseMapping ? <>
          <Metric label={t("Códigos únicos validados")} value={preview.validRowCount - preview.duplicateBaseCodeCount} />
          <Metric label={t("Códigos duplicados")} value={preview.duplicateBaseCodeCount} />
        </> : <>
          <Metric label={t("Com mapeamento")} value={preview.mappedRowCount} />
          <Metric label={t("Sem mapeamento")} value={preview.unmappedRowCount} />
        </>}
      </div>
      <div className="data-foundation-coverage"><div><span>{t(isBaseMapping ? "Códigos únicos do de-para" : "Cobertura do de-para")}</span><strong>{coverage}%</strong></div><progress max={100} value={coverage} /><small>{isBaseMapping
        ? `${formatCount(preview.validRowCount - preview.duplicateBaseCodeCount)} / ${formatCount(preview.expectedBaseCount || 1628)} ${t("códigos esperados")}`
        : `${formatCount(preview.mappedRowCount)} / ${formatCount(preview.validRowCount)} ${t("linhas válidas com base associada")}`}</small></div>
      {preview.duplicateCount || preview.exactNameCandidateRowCount || preview.noMappingMatchRowCount || preview.missingIdentifierRowCount || preview.ambiguousRowCount ? <div className="data-foundation-extra-counts"><span>{t("Duplicatas preservadas")}: <strong>{formatCount(preview.duplicateCount)}</strong></span><span>{t("Candidatas por nome exato")}: <strong>{formatCount(preview.exactNameCandidateRowCount)}</strong></span><span>{t("Sem correspondência")}: <strong>{formatCount(preview.noMappingMatchRowCount)}</strong></span><span>{t("Identificador ausente")}: <strong>{formatCount(preview.missingIdentifierRowCount)}</strong></span><span>{t("Ambíguas")}: <strong>{formatCount(preview.ambiguousRowCount)}</strong></span></div> : null}
      {Object.keys(preview.perDateCounts).length ? <details className="data-foundation-details"><summary>{t("Contagem por data")}</summary><div className="data-foundation-date-counts">{Object.entries(preview.perDateCounts).map(([date, count]) => <span key={date}>{date}<strong>{formatCount(count)}</strong></span>)}</div></details> : null}
      {preview.errors.length || Object.keys(preview.errorCounts).length ? <div className="data-foundation-validation-errors"><h3><AlertTriangle size={16} /> {t("Erros de validação")}</h3><p>{t("{count} linhas inválidas", { count: formatCount(preview.invalidRowCount) })}</p>{Object.entries(preview.errorCounts).map(([code, count]) => <span key={code}>{t(code)} · {formatCount(count)}</span>)}<ul>{preview.errors.map((error, index) => <li key={`${error.rowNumber}-${error.code}-${index}`}>{t("Linha {row}", { row: error.rowNumber })}{error.column ? ` · ${error.column}` : ""} · {t(error.code)}</li>)}</ul></div> : null}
      {mappingReviewDirty ? <div className="data-foundation-alert is-disabled"><AlertTriangle size={17} />{t("Há decisões de nome novas. Revalide o arquivo para atualizar a cobertura antes de publicar.")}</div> : null}
      {candidates.length ? <div className="data-foundation-name-review"><div><h3>{t("Revisão de nomes exatos")}</h3><p>{t("A associação nunca é automática. Um nome só pode ser ligado quando encontra um único destino exato no de-para.")}</p></div><label>{t("Justificativa da revisão")}<input value={reviewNote} onChange={(event) => onReviewNote(event.target.value)} maxLength={500} placeholder={t("Descreva o que foi conferido")}/></label><label className="data-foundation-search">{t("Buscar nome do arquivo")}<input value={candidateQuery} onChange={(event) => onCandidateQuery(event.target.value)} /></label><div className="data-foundation-candidate-list">{visibleCandidates.map((candidate) => { const unique = candidate.exactTargetCandidates.length === 1 ? candidate.exactTargetCandidates[0] : null; return <article key={candidate.sourceBaseName}><div><strong>{candidate.sourceBaseName || t("(nome vazio)")}</strong><small>{formatCount(candidate.sourceRowCount)} {t("linhas")} · {candidate.exactTargetCandidates.length ? t("{count} destinos exatos", { count: candidate.exactTargetCandidates.length }) : t("Sem destino exato")} · {t(candidate.decisionState)}</small>{unique ? <small>{unique.baseName} · {unique.region ?? "—"} · {unique.uf ?? "—"} · {unique.baseCode}</small> : null}</div>{candidate.decisionState === "UNREVIEWED" ? <div className="data-foundation-candidate-actions">{unique ? <button type="button" onClick={() => onDecision(candidate, "LINKED")} disabled={!canImport || busy || !reviewNote.trim()}>{t("Aprovar destino único")}</button> : <button type="button" onClick={() => onDecision(candidate, candidate.exactTargetCandidates.length ? "AMBIGUOUS" : "REJECTED")} disabled={!canImport || busy || !reviewNote.trim()}>{candidate.exactTargetCandidates.length ? t("Marcar ambíguo") : t("Rejeitar sem correspondência")}</button>}</div> : null}</article>; })}{visibleCandidates.length === 0 ? <p>{t("Nenhum nome corresponde à busca.")}</p> : null}{visibleCandidates.length === 50 ? <small>{t("Mostrando até 50 resultados. Refine a busca para localizar outros nomes.")}</small> : null}</div></div> : null}
      {preview.unmappedRowCount > 0 ? <label className="data-foundation-unmapped-confirm"><input type="checkbox" checked={acknowledgeUnmapped} onChange={(event) => onAcknowledge(event.target.checked)} />{t("Entendo que as linhas sem mapeamento ficarão fora das consultas regionais até a revisão do de-para.")}</label> : null}
      <div className="data-foundation-preview-actions"><button type="button" onClick={onRevalidate} disabled={!canImport || busy}>{t("Revalidar")}</button><button type="button" onClick={onPublish} disabled={!canPublish}><Check size={16} />{t("Confirmar publicação")}</button></div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{formatCount(value)}</strong></div>;
}
