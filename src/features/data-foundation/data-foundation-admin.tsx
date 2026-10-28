"use client";

import { NetworkDirectoryCandidate } from "./network-directory-candidate.tsx";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-url";
import {
  loadIndependently,
} from "../../lib/data-foundation/admin-metadata";
import type { DashboardTranslator } from "../../lib/i18n";
import { invalidateDashboardDataCache } from "../../lib/data-foundation/dashboard-data-cache.ts";
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
  contractVersion: number;
  publishedAt: string | null;
  visibleRowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  fileName?: string | null;
  attachedAt?: string | null;
};

type PublicationsResponse = { publications: Publication[]; total: number };

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
  normalizedNameCandidateRowCount?: number;
  noMappingMatchRowCount: number;
  missingIdentifierRowCount: number;
  ambiguousRowCount: number;
  mappingVersionAvailable: boolean;
  mappingVersionId: string | null;
  collectionDate?: string | null;
  botExecutedAt?: string | null;
  exportMetadataSource?: "BOT_METADATA" | "ADMIN_CONFIRMATION" | "UNKNOWN";
  exportMetadataConfirmedByUserId?: number | null;
  perDateCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  errors: { rowNumber: number; column: string | null; code: string }[];
  canPublish: boolean;
};

type T4T5ImportStatus = {
  jobId: string;
  sourceId: string;
  contractVersion?: number;
  state: string;
  phase?: string;
  inputRowCount?: number;
  validRowCount?: number;
  analyzedRowCount?: number;
  writtenRowCount?: number;
  committedRowCount?: number;
  totalExpectedRowCount?: number;
  errorCode?: string;
  publicationId?: string;
  version?: number;
  reused?: boolean;
  canPublish?: boolean;
  [key: string]: unknown;
};

type CandidateTarget = { baseCode: string; baseName: string; region: string | null; uf: string | null };
type NameCandidate = {
  sourceBaseName: string;
  sourceRowCount: number;
  exactTargetCandidates: CandidateTarget[];
  normalizedTargetCandidates: CandidateTarget[];
  matchMethod: "EXACT" | "NORMALIZED" | "NONE";
  decisionState: "AUTO_MATCH" | "UNREVIEWED" | "LINKED" | "AMBIGUOUS" | "REJECTED";
  approvedTargetBaseCode: string | null;
};

function reviewTargets(candidate: NameCandidate): CandidateTarget[] {
  return candidate.exactTargetCandidates.length
    ? candidate.exactTargetCandidates
    : candidate.normalizedTargetCandidates;
}

type MappingStatus = {
  state: string;
  mappingVersionId: string | null;
  version: number | null;
  publishedAt: string | null;
  visibleBaseCount: number;
  fileName?: string | null;
  attachedAt?: string | null;
};

const NAME_MAPPED_SOURCES = new Set(["collection_monitoring", "collection_rate", "jt_monitoring"]);
const INITIAL_MAPPING_SOURCE = "base_mapping_official";
const T4T5_SESSION_JOB_KEY = "new-bi:t4t5:import-job";
const API_ERROR_LABELS: Record<string, string> = {
  admin_required: "Somente administradores podem executar esta ação.",
  matrix_scope_required: "Esta ação exige perfil ADMIN autorizado.",
  data_store_unavailable: "O banco de dados da Data Foundation está indisponível.",
  import_storage_unavailable: "O armazenamento privado de importação não está configurado.",
  official_mapping_unavailable: "O de-para vigente ainda não está publicado.",
  source_contract_not_registered: "O contrato oficial desta fonte não está registrado.",
  official_mapping_changed_repreview: "O arquivo precisa de nova prévia após uma alteração no de-para.",
  import_job_not_found: "Esta importação não pertence ao usuário atual.",
  import_job_not_validatable: "Esta importação não pode ser validada no estado atual.",
  import_job_not_validated: "A importação ainda não foi validada ou não pode ser publicada.",
  import_job_processing: "Esta importação já está em andamento. Aguarde a atualização do estado.",
  import_processing_failed: "Não foi possível processar a planilha. Verifique o estado da importação e tente novamente.",
  import_processing_timeout: "O acompanhamento excedeu 30 minutos. A tarefa pode continuar; consulte o estado antes de reenviar o arquivo.",
  import_publication_failed: "A publicação não foi concluída. A versão anterior continua ativa; é possível retomar a importação.",
  import_publication_count_mismatch: "A conferência final dos registros não corresponde à prévia; nada foi publicado.",
  import_prepared_publication_requires_retry: "Há uma publicação preparada sem ativação. Retome a publicação deste arquivo para concluir com segurança.",
  import_source_hash_mismatch: "O arquivo em processamento não corresponde ao arquivo validado.",
  import_validation_changed: "O arquivo mudou durante o processamento. A publicação foi interrompida.",
  name_mapping_not_supported_for_source: "Nome exato não suportado nesta fonte.",
  mapping_review_note_required: "A decisão de revisão exige uma justificativa.",
  mapping_target_must_be_candidate: "O destino escolhido precisa corresponder a uma base candidata no de-para vigente.",
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

async function requestPublications(sourceId: string, limit: number, signal: AbortSignal): Promise<PublicationsResponse> {
  try {
    return await requestJson<PublicationsResponse>(
      `/api/v2/data-sources/${encodeURIComponent(sourceId)}/publications?limit=${limit}&offset=0`,
      { signal },
    );
  } catch (caught) {
    if (caught instanceof Error && caught.message === "data_foundation_v2_disabled") {
      return { publications: [], total: 0 };
    }
    throw caught;
  }
}

async function waitForT4T5ImportJob(
  jobId: string,
  onStatus: (status: T4T5ImportStatus) => void,
): Promise<T4T5ImportStatus> {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}`);
    onStatus(status);
    if (["VALIDATED", "INVALID", "PUBLISHED", "REUSED"].includes(status.state)) return status;
    if (status.state === "FAILED") throw new Error(status.errorCode || "import_processing_failed");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
  }
  throw new Error("import_processing_timeout");
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatDataFoundationDateTime(value: string | null | undefined): string {
  return formatDateTime(value);
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function displayPanelName(value: string): string {
  return value.replace(/\s+V[123]$/i, "");
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
  const [contractErrors, setContractErrors] = useState<Record<string, string>>({});
  const [publicationErrors, setPublicationErrors] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<MappingStatus | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [operationStartedAt, setOperationStartedAt] = useState<string | null>(null);
  const [confirmNoMovementExport, setConfirmNoMovementExport] = useState(false);
  const [noMovementExportDate, setNoMovementExportDate] = useState("");
  const [noMovementExportTime, setNoMovementExportTime] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewSource, setPreviewSource] = useState("");
  const [largeImportProgress, setLargeImportProgress] = useState<T4T5ImportStatus | null>(null);
  const [candidates, setCandidates] = useState<NameCandidate[]>([]);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [mappingReviewDirty, setMappingReviewDirty] = useState(false);
  const [acknowledgeUnmapped, setAcknowledgeUnmapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [mappingCandidateOpen, setMappingCandidateOpen] = useState(false);
  const previewGeneration = useRef(0);
  const publishInFlight = useRef(false);
  const previewInFlight = useRef(false);
  const metadataLoadGeneration = useRef(0);
  const metadataAbortController = useRef<AbortController | null>(null);
  const t4t5RecoveryStarted = useRef(false);

  const loadMetadata = useCallback(async () => {
    metadataAbortController.current?.abort();
    const controller = new AbortController();
    metadataAbortController.current = controller;
    const loadGeneration = ++metadataLoadGeneration.current;
    const isCurrentLoad = () => (
      metadataLoadGeneration.current === loadGeneration && !controller.signal.aborted
    );
    setLoading(true);
    setError(null);
    setNotice(null);
    setContracts({});
    setPublications({});
    setContractErrors({});
    setPublicationErrors({});
    setMapping(null);
    setMappingError(null);
    setMappingLoading(true);
    try {
      const result = await requestJson<{ sources: Source[] }>("/api/v2/data-sources", { signal: controller.signal });
      if (!isCurrentLoad()) return;
      setSources(result.sources);
      setLoading(false);
      const publicationSources = result.sources.filter((source) => source.source_id !== "base_mapping_official");

      void requestJson<MappingStatus>("/api/v2/base-mapping/current", { signal: controller.signal })
        .then((status) => {
          if (!isCurrentLoad()) return;
          setMapping(status);
          setMappingError(null);
        })
        .catch((caught: unknown) => {
          if (!isCurrentLoad()) return;
          setMappingError(caught instanceof Error ? caught.message : "data_foundation_request_failed");
        })
        .finally(() => {
          if (isCurrentLoad()) setMappingLoading(false);
        });

      void loadIndependently(
        publicationSources,
        (source) => requestJson<Contract>(
          `/api/v2/data-sources/${encodeURIComponent(source.source_id)}/contract`,
          { signal: controller.signal },
        ),
        (source, contract) => {
          if (!isCurrentLoad()) return;
          setContracts((current) => ({ ...current, [source.source_id]: contract }));
          setContractErrors((current) => {
            if (!current[source.source_id]) return current;
            const next = { ...current };
            delete next[source.source_id];
            return next;
          });
        },
        (source, caught) => {
          if (!isCurrentLoad()) return;
          setContractErrors((current) => ({
            ...current,
            [source.source_id]: caught instanceof Error ? caught.message : "data_foundation_request_failed",
          }));
        },
      );

      void loadIndependently(
        publicationSources,
        (source) => requestPublications(source.source_id, 1, controller.signal),
        (source, result) => {
          if (!isCurrentLoad()) return;
          setPublications((current) => ({ ...current, [source.source_id]: result.publications }));
          setPublicationErrors((current) => {
            if (!current[source.source_id]) return current;
            const next = { ...current };
            delete next[source.source_id];
            return next;
          });
        },
        (source, caught) => {
          if (!isCurrentLoad()) return;
          setPublicationErrors((current) => ({
            ...current,
            [source.source_id]: caught instanceof Error ? caught.message : "data_foundation_request_failed",
          }));
        },
        2,
      );
    } catch (caught) {
      if (isCurrentLoad()) {
        setError(caught instanceof Error ? caught.message : "data_foundation_request_failed");
        setMappingLoading(false);
      }
    } finally {
      if (isCurrentLoad()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadMetadata();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      metadataAbortController.current?.abort();
      metadataLoadGeneration.current += 1;
    };
  }, [loadMetadata]);

  useEffect(() => {
    if (t4t5RecoveryStarted.current) return;
    t4t5RecoveryStarted.current = true;
    let saved: { jobId?: unknown; idempotencyKey?: unknown };
    try {
      const raw = window.sessionStorage.getItem(T4T5_SESSION_JOB_KEY);
      if (!raw) return;
      saved = JSON.parse(raw) as { jobId?: unknown; idempotencyKey?: unknown };
    } catch {
      window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
      return;
    }
    if (typeof saved.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(saved.jobId)) {
      window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
      return;
    }
    const jobId = saved.jobId;
    let cancelled = false;
    const recover = async () => {
      try {
        let status = await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        setLargeImportProgress(status);
        if (["RECEIVED", "PARSING"].includes(status.state)) {
          try {
            if (status.phase === "PUBLICATION") {
              const key = typeof saved.idempotencyKey === "string" ? saved.idempotencyKey : crypto.randomUUID();
              window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({ jobId, idempotencyKey: key }));
              await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}/publish`, {
                method: "POST", headers: { "Idempotency-Key": key },
              });
            } else {
              await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}/validate`, { method: "POST" });
            }
          } catch (caught) {
            if (!(caught instanceof Error) || caught.message !== "import_job_processing") throw caught;
          }
          const deadline = Date.now() + 30 * 60 * 1000;
          while (!cancelled && Date.now() < deadline) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
            status = await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}`);
            if (cancelled) return;
            setLargeImportProgress(status);
            if (!["RECEIVED", "PARSING"].includes(status.state)) break;
          }
          if (!cancelled && ["RECEIVED", "PARSING"].includes(status.state)) {
            setError("import_processing_timeout");
            return;
          }
        }
        if (cancelled) return;
        if (["VALIDATED", "INVALID"].includes(status.state) || (status.state === "FAILED" && status.canPublish)) {
          setPreview(status as unknown as Preview);
          setFile(null);
          setPreviewModalOpen(true);
          setPreviewSource(status.sourceId);
          setAcknowledgeUnmapped(false);
        }
        if (["PUBLISHED", "REUSED"].includes(status.state)) {
          window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
          setLargeImportProgress(null);
          await loadMetadata();
          if (!cancelled) setNotice(t("Publicação {state} na versão {version}.", {
            state: status.reused ? t("reutilizada") : t("concluída"),
            version: status.version ?? "—",
          }));
        } else if (status.state === "FAILED") {
          setError(status.errorCode || "import_processing_failed");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "data_foundation_request_failed");
      }
    };
    void recover();
    return () => { cancelled = true; };
  }, [loadMetadata, t]);

  const importActionsEnabled = canImport && error !== "data_foundation_v2_disabled";
  const visibleCandidates = useMemo(() => {
    const query = normalize(candidateQuery.trim());
    return candidates
      .filter((candidate) => !query || normalize(candidate.sourceBaseName).includes(query))
      .slice(0, 50);
  }, [candidateQuery, candidates]);

  async function makePreview(sourceId: string, selectedFile: File | null, useManualExportMetadata = false) {
    if (!selectedFile || !sourceId || previewInFlight.current) return;
    previewInFlight.current = true;
    const requestGeneration = ++previewGeneration.current;
    const isCurrentPreview = () => previewGeneration.current === requestGeneration;
    setBusy(true);
    setError(null);
    setNotice(null);
    setLargeImportProgress(null);
    setCandidates([]);
    setMappingReviewDirty(false);
    setAcknowledgeUnmapped(false);
    setPreview(null);
    setPreviewSource(sourceId);
    setPreviewModalOpen(true);
    if (sourceId === "no_movement" && useManualExportMetadata && (!noMovementExportDate || !noMovementExportTime)) {
      setError("Preencha a data e o horário local da exportação antes de confirmar.");
      setBusy(false);
      previewInFlight.current = false;
      return;
    }
    try {
      const body = new FormData();
      body.append("source_id", sourceId);
      body.append("file", selectedFile, selectedFile.name);
      if (sourceId === "no_movement" && useManualExportMetadata) {
        body.append("confirmed_export_date", noMovementExportDate);
        body.append("confirmed_export_time", noMovementExportTime);
      }
      let result: Preview;
      if (sourceId === "collection_monitoring_t4_t5") {
        const accepted = await requestJson<T4T5ImportStatus>("/api/v2/imports/preview", { method: "POST", body });
        if (!isCurrentPreview()) return;
        window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({ jobId: accepted.jobId }));
        setLargeImportProgress(accepted);
        result = await waitForT4T5ImportJob(accepted.jobId, setLargeImportProgress) as unknown as Preview;
      } else {
        result = await requestJson<Preview>("/api/v2/imports/preview", { method: "POST", body });
      }
      if (!isCurrentPreview()) return;
      setPreview(result);
      if (NAME_MAPPED_SOURCES.has(sourceId)) {
        const candidatesResult = await requestJson<{ candidates: NameCandidate[] }>(
          `/api/v2/base-mapping/name-candidates/${encodeURIComponent(result.jobId)}`,
        );
        if (!isCurrentPreview()) return;
        setCandidates(candidatesResult.candidates);
      }
    } catch (caught) {
      if (isCurrentPreview()) setError(caught instanceof Error ? caught.message : "data_foundation_preview_failed");
    } finally {
      if (isCurrentPreview()) setBusy(false);
    }
  }


  async function saveDecision(candidate: NameCandidate, state: "LINKED" | "AMBIGUOUS" | "REJECTED", targetBaseCode?: string) {
    if (!preview || !reviewNote.trim()) {
      setError("Informe a justificativa da revisão antes de registrar a decisão.");
      return;
    }
    const targets = reviewTargets(candidate);
    const target = targets.find((item) => item.baseCode === targetBaseCode)
      ?? (targets.length === 1 ? targets[0] : null);
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
      let result: Preview;
      if (preview.sourceId === "collection_monitoring_t4_t5") {
        const queued = await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(preview.jobId)}/validate`, { method: "POST" });
        window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({ jobId: preview.jobId }));
        setLargeImportProgress(queued);
        result = await waitForT4T5ImportJob(preview.jobId, setLargeImportProgress) as unknown as Preview;
      } else {
        result = await requestJson<Preview>(`/api/v2/imports/${encodeURIComponent(preview.jobId)}/validate`, { method: "POST" });
      }
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
    if (publishInFlight.current || !preview || !preview.canPublish || mappingReviewDirty) return;
    if (preview.unmappedRowCount > 0 && !acknowledgeUnmapped) return;
    publishInFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const t4t5IdempotencyKey = preview.sourceId === "collection_monitoring_t4_t5" ? crypto.randomUUID() : null;
      if (t4t5IdempotencyKey) {
        window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({
          jobId: preview.jobId,
          idempotencyKey: t4t5IdempotencyKey,
        }));
      }
      const headers = {
        "Idempotency-Key": t4t5IdempotencyKey ?? crypto.randomUUID(),
      };
      const path = `/api/v2/imports/${encodeURIComponent(preview.jobId)}/publish`;
      let result: { version: number; mappingRowCount?: number; reused?: boolean };
      if (preview.sourceId === "collection_monitoring_t4_t5") {
        const queued = await requestJson<T4T5ImportStatus>(path, { method: "POST", headers });
        setLargeImportProgress(queued);
        const completed = await waitForT4T5ImportJob(preview.jobId, setLargeImportProgress);
        if (!["PUBLISHED", "REUSED"].includes(completed.state) || typeof completed.version !== "number") {
          throw new Error("import_publication_failed");
        }
        result = { version: completed.version, reused: completed.reused };
      } else {
        result = await requestJson<{ version: number; mappingRowCount?: number; reused?: boolean }>(path, { method: "POST", headers });
      }
      invalidateDashboardDataCache(preview.sourceId);
      const successNotice = t("Publicação {state} na versão {version}.", {
        state: result.reused ? t("reutilizada") : t("concluída"),
        version: result.version,
      });
      setPreview(null);
      setPreviewModalOpen(false);
      previewGeneration.current += 1;
      setLargeImportProgress(null);
      if (preview.sourceId === "collection_monitoring_t4_t5") window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
      setFile(null);
      setOperationStartedAt(null);
      setMappingReviewDirty(false);
      await loadMetadata();
      setNotice(successNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "data_foundation_publish_failed");
    } finally {
      publishInFlight.current = false;
      setBusy(false);
    }
  }

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
        <div><span className="card-eyebrow"><Database size={15} /> DATA FOUNDATION</span><h1 id="data-foundation-title">{t("Central de Dados")}</h1><p>{t("Atualize os arquivos dos painéis com validação antes da publicação.")}</p></div>
        <button type="button" className="data-foundation-refresh" onClick={() => void loadMetadata()} disabled={loading || busy}><RefreshCw size={16} /> {t("Atualizar")}</button>
      </div>

      {error ? <div className={`data-foundation-alert ${error === "data_foundation_v2_disabled" ? "is-disabled" : "is-error"}`} role="alert"><AlertTriangle size={18} /><div><strong>{error === "data_foundation_v2_disabled" ? t("Data Foundation V2 desativada neste ambiente") : displayApiError(error, t)}</strong>{error === "data_foundation_v2_disabled" ? <p>{t("Configure DATA_QUERIES_ENABLED=true e DATA_IMPORT_ENABLED=true com as credenciais dedicadas DATA_DB_* e o diretório DATA_IMPORT_STAGING_DIRECTORY para habilitar a Central localmente.")}</p> : null}</div></div> : null}
      {!canImport && !error?.includes("disabled") ? <div className="data-foundation-alert is-disabled"><AlertTriangle size={18} /><p>{t("Seu perfil pode consultar apenas dados do próprio escopo. A administração e publicação exigem perfil ADMIN; isso não amplia o escopo dos dashboards.")}</p></div> : null}
      {notice ? <div className="data-foundation-notice" role="status"><Check size={17} /> {t(notice)}</div> : null}
      {loading ? <p className="data-foundation-loading">{t("Carregando fontes…")}</p> : null}
      {!loading && sources.length ? <div className="data-foundation-source-cards" aria-label={t("Fontes de dados")}>
        {sources.filter((source) => source.source_id !== "base_mapping_official").map((source) => {
          const publication = publications[source.source_id]?.[0];
          const sourceContract = contracts[source.source_id];
          return <article className="data-foundation-source-card" key={source.source_id}>
            <div className="data-foundation-source-card-icon"><FileSpreadsheet size={21} /></div>
            <div className="data-foundation-source-card-copy"><h2>{t(displayPanelName(source.display_name))}</h2>
              <p><span>{t("Arquivo atual")}</span><strong title={publication?.fileName ?? undefined}>{publication?.fileName || "—"}</strong></p>
              <p><span>{t("Adicionado em")}</span><strong>{formatDataFoundationDateTime(publication?.attachedAt)}</strong></p>
              {publicationErrors[source.source_id] ? <small role="alert">{t("Metadados do arquivo indisponíveis.")}</small> : null}
              {!publication && !publicationErrors[source.source_id] ? <small>{publications[source.source_id] ? t("Ainda não há arquivo publicado.") : t("Carregando arquivo atual…")}</small> : null}
              {contractErrors[source.source_id] ? <small role="alert">{t("Não foi possível verificar os requisitos deste painel.")}</small> : null}
            </div>
            <label className="data-foundation-update-button"><Upload size={16} /> {t("Atualizar arquivo")}
              <input aria-label={t("Selecionar arquivo para {panel}", { panel: t(source.display_name) })} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!importActionsEnabled || !sourceContract || busy} onChange={(event) => {
                const selectedFile = event.target.files?.[0] ?? null;
                event.currentTarget.value = "";
                if (!selectedFile) return;
                setFile(selectedFile);
                setOperationStartedAt(new Date().toISOString());
                setPreview(null);
                setError(null);
                setLargeImportProgress(null);
                window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
                setMappingReviewDirty(false);
                setConfirmNoMovementExport(false);
                setNoMovementExportDate("");
                setNoMovementExportTime("");
                setPreviewModalOpen(true);
                void makePreview(source.source_id, selectedFile);
              }} />
            </label>
            {!sourceContract && !contractErrors[source.source_id] ? <small className="data-foundation-source-card-wait">{t("Preparando atualização…")}</small> : null}
          </article>;
        })}
      </div> : null}

      {mapping ? <article className="data-foundation-source-card data-foundation-map-card">
        <div className="data-foundation-source-card-icon"><Database size={21} /></div>
        <div className="data-foundation-source-card-copy"><h2>{t("Depara")}</h2>
          <p><span>{t("Arquivo atual")}</span><strong title={mapping.fileName ?? undefined}>{mapping.fileName || "—"}</strong></p>
          <p><span>{t("Adicionado em")}</span><strong>{formatDataFoundationDateTime(mapping.attachedAt)}</strong></p>
        </div>
        <button type="button" className="data-foundation-update-button" disabled={!importActionsEnabled} onClick={() => setMappingCandidateOpen(true)}>{t("Atualizar arquivo")}</button>
      </article> : mappingError ? <div className="data-foundation-alert is-error" role="alert"><AlertTriangle size={18} /><span>{t("Não foi possível verificar o de-para vigente.")} {displayApiError(mappingError, t)}</span></div> : mappingLoading ? <p className="data-foundation-loading">{t("Carregando Depara…")}</p> : null}

      {previewModalOpen ? <div className="data-foundation-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { previewGeneration.current += 1; setPreviewModalOpen(false); setPreview(null); setError(null); } }}>
        <section className="data-foundation-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="data-foundation-confirm-title">
          <header><div><span className="card-eyebrow">{t("ATUALIZAÇÃO DO PAINEL")}</span><h2 id="data-foundation-confirm-title">{t("Confirmar atualização")}</h2><p>{t(sources.find((source) => source.source_id === previewSource)?.display_name ?? previewSource)}</p></div><button type="button" aria-label={t("Fechar")} onClick={() => { previewGeneration.current += 1; setPreviewModalOpen(false); setPreview(null); setError(null); }} disabled={busy}>×</button></header>
          <div className="data-foundation-confirm-file"><FileSpreadsheet size={18} /><div><span>{t("Novo arquivo")}</span><strong>{file?.name ?? "—"}</strong></div><small>{t("Operação")} · {formatDataFoundationDateTime(operationStartedAt)}</small></div>
          {previewSource === "no_movement" ? <div className="no-movement-export-confirmation"><label className="no-movement-export-confirmation-check"><input type="checkbox" checked={confirmNoMovementExport} onChange={(event) => setConfirmNoMovementExport(event.target.checked)} disabled={busy} />{t("Confirmo manualmente a data e hora da exportação se o arquivo não trouxer metadados confiáveis.")}</label><p>{t("Se a aba Execucoes tiver uma execução válida, os metadados do Bot serão priorizados e esta confirmação não os substitui.")}</p><div className="no-movement-export-confirmation-fields"><label>{t("Data da exportação")}<input type="date" value={noMovementExportDate} onChange={(event) => setNoMovementExportDate(event.target.value)} disabled={!confirmNoMovementExport || busy} /></label><label>{t("Horário local da exportação")}<input type="time" value={noMovementExportTime} onChange={(event) => setNoMovementExportTime(event.target.value)} disabled={!confirmNoMovementExport || busy} /></label></div>{confirmNoMovementExport && noMovementExportDate && noMovementExportTime && !busy ? <button type="button" className="data-foundation-retry-validation" onClick={() => void makePreview(previewSource, file, true)}>{t("Validar com data e hora informadas")}</button> : null}</div> : null}
          {largeImportProgress?.sourceId === previewSource && ["RECEIVED", "PARSING"].includes(largeImportProgress.state) ? <div className="data-foundation-alert is-disabled" role="status" aria-live="polite">{t("Processando arquivo em segundo plano…")}{largeImportProgress.committedRowCount !== undefined ? <p>{t("Linhas confirmadas no banco")}: {formatCount(largeImportProgress.committedRowCount)}</p> : null}</div> : null}
          {busy && !preview ? <p className="data-foundation-loading" role="status">{t("Validando arquivo…")}</p> : null}
          {preview ? <PreviewPanel preview={preview} fileName={file?.name ?? null} candidates={candidates} candidateQuery={candidateQuery} reviewNote={reviewNote} visibleCandidates={visibleCandidates} canImport={importActionsEnabled} busy={busy} mappingReviewDirty={mappingReviewDirty} acknowledgeUnmapped={acknowledgeUnmapped} onCandidateQuery={setCandidateQuery} onReviewNote={setReviewNote} onAcknowledge={setAcknowledgeUnmapped} onDecision={(candidate, state, targetCode) => void saveDecision(candidate, state, targetCode)} onRevalidate={() => { if (preview.sourceId === "no_movement" && confirmNoMovementExport) void makePreview(preview.sourceId, file, true); else void revalidate(); }} onPublish={() => void publish()} canPublish={canPublish} t={t} /> : null}
          {!busy && !preview && error ? <div className="data-foundation-alert is-error" role="alert"><AlertTriangle size={17} />{displayApiError(error, t)}</div> : null}
        </section>
      </div> : null}
      {mappingCandidateOpen ? <NetworkDirectoryCandidate
        enabled={importActionsEnabled}
        t={t}
        onClose={() => setMappingCandidateOpen(false)}
        onPublished={() => { void loadMetadata(); }}
      /> : null}
    </section>
  );
}

function PreviewPanel({
  preview,
  fileName,
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
  fileName: string | null;
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
  onDecision: (candidate: NameCandidate, state: "LINKED" | "AMBIGUOUS" | "REJECTED", targetBaseCode?: string) => void;
  onRevalidate: () => void;
  onPublish: () => void;
  canPublish: boolean;
  t: DashboardTranslator;
}) {
  const [selectedTargetCodes, setSelectedTargetCodes] = useState<Record<string, string>>({});
  const isBaseMapping = preview.sourceId === INITIAL_MAPPING_SOURCE;
  const coverage = isBaseMapping
    ? Math.round((preview.validRowCount - preview.duplicateBaseCodeCount) / (preview.expectedBaseCount || 1628) * 100)
    : preview.validRowCount ? Math.round(preview.mappedRowCount / preview.validRowCount * 100) : 0;
  return (
    <section className="data-foundation-card data-foundation-preview" aria-labelledby="data-foundation-preview-title">
      <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("PRÉVIA")}</span><h2 id="data-foundation-preview-title">{t("Resultado da validação")}</h2><p>{t("Arquivo")}: {fileName || "—"}</p></div><span className={`data-foundation-state ${preview.canPublish ? "is-ready" : "is-error"}`}>{preview.canPublish ? t("Válido para publicação") : t("Corrija os erros")}</span></div>
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
      {preview.duplicateCount || preview.exactNameCandidateRowCount || preview.normalizedNameCandidateRowCount || preview.noMappingMatchRowCount || preview.missingIdentifierRowCount || preview.ambiguousRowCount ? <div className="data-foundation-extra-counts"><span>{t("Duplicatas preservadas")}: <strong>{formatCount(preview.duplicateCount)}</strong></span><span>{t("Candidatas por nome exato")}: <strong>{formatCount(preview.exactNameCandidateRowCount)}</strong></span><span>{t("Candidatas por nome normalizado")}: <strong>{formatCount(preview.normalizedNameCandidateRowCount ?? 0)}</strong></span><span>{t("Sem correspondência")}: <strong>{formatCount(preview.noMappingMatchRowCount)}</strong></span><span>{t("Identificador ausente")}: <strong>{formatCount(preview.missingIdentifierRowCount)}</strong></span><span>{t("Ambíguas")}: <strong>{formatCount(preview.ambiguousRowCount)}</strong></span></div> : null}
      {Object.keys(preview.perDateCounts).length ? <details className="data-foundation-details"><summary>{t("Contagem por data")}</summary><div className="data-foundation-date-counts">{Object.entries(preview.perDateCounts).map(([date, count]) => <span key={date}>{date}<strong>{formatCount(count)}</strong></span>)}</div></details> : null}
      {preview.sourceId === "no_movement" && preview.collectionDate ? <div className="data-foundation-latest"><Clock3 size={15} /> {t("Data operacional")}: {preview.collectionDate} · {t("Exportação")}: {preview.botExecutedAt ?? t("Horário não confirmado")}{preview.exportMetadataSource === "ADMIN_CONFIRMATION" ? ` · ${t("Horário confirmado manualmente pelo administrador")}` : ""}</div> : null}
      {preview.errors.length || Object.keys(preview.errorCounts).length ? <div className="data-foundation-validation-errors"><h3><AlertTriangle size={16} /> {t("Erros de validação")}</h3><p>{t("{count} linhas inválidas", { count: formatCount(preview.invalidRowCount) })}</p>{Object.entries(preview.errorCounts).map(([code, count]) => <span key={code}>{t(code)} · {formatCount(count)}</span>)}<ul>{preview.errors.map((error, index) => <li key={`${error.rowNumber}-${error.code}-${index}`}>{t("Linha {row}", { row: error.rowNumber })}{error.column ? ` · ${error.column}` : ""} · {t(error.code)}</li>)}</ul></div> : null}
      {mappingReviewDirty ? <div className="data-foundation-alert is-disabled"><AlertTriangle size={17} />{t("Há decisões de nome novas. Revalide o arquivo para atualizar a cobertura antes de publicar.")}</div> : null}
      {candidates.length ? (
        <div className="data-foundation-name-review">
          <div>
            <h3>{t("Correspondências no de-para oficial")}</h3>
            <p>{t("Nomes com correspondência única são associados automaticamente pelo mapa publicado. A revisão manual fica para nomes ambíguos ou exceções justificadas.")}</p>
          </div>
          {candidates.some((candidate) => candidate.decisionState === "UNREVIEWED" && reviewTargets(candidate).length > 1) ? <label>{t("Justificativa da revisão manual")}<input value={reviewNote} onChange={(event) => onReviewNote(event.target.value)} maxLength={500} placeholder={t("Descreva o que foi conferido")}/></label> : null}
          <label className="data-foundation-search">{t("Buscar nome do arquivo")}<input value={candidateQuery} onChange={(event) => onCandidateQuery(event.target.value)} /></label>
          <div className="data-foundation-candidate-list">
            {visibleCandidates.map((candidate) => {
              const targets = reviewTargets(candidate);
              const unique = targets.length === 1 ? targets[0] : null;
              const isNormalized = candidate.matchMethod === "NORMALIZED";
              const stateLabel = candidate.decisionState === "AUTO_MATCH" ? t("Correspondência automática") : t(candidate.decisionState);
              return <article key={candidate.sourceBaseName}>
                <div>
                  <strong>{candidate.sourceBaseName || t("(nome vazio)")}</strong>
                  <small>{formatCount(candidate.sourceRowCount)} {t("linhas")} · {targets.length ? isNormalized ? t("{count} destinos normalizados", { count: targets.length }) : t("{count} destinos exatos", { count: targets.length }) : t("Sem destino exato ou normalizado")} · {stateLabel}</small>
                  {unique ? <small>{unique.baseName} · {unique.region ?? "—"} · {unique.uf ?? "—"} · {unique.baseCode}</small> : null}
                </div>
                {candidate.decisionState === "UNREVIEWED" && targets.length > 1 ? <div className="data-foundation-candidate-actions">
                  <select aria-label={t("Destino oficial para {name}", { name: candidate.sourceBaseName })} value={selectedTargetCodes[candidate.sourceBaseName] ?? ""} onChange={(event) => setSelectedTargetCodes((current) => ({ ...current, [candidate.sourceBaseName]: event.target.value }))}>
                    <option value="">{t("Escolha o destino após conferência")}</option>
                    {targets.map((target) => <option key={target.baseCode} value={target.baseCode}>{target.baseName} · {target.region ?? "—"} · {target.uf ?? "—"} · {target.baseCode}</option>)}
                  </select>
                  <button type="button" onClick={() => onDecision(candidate, "LINKED", selectedTargetCodes[candidate.sourceBaseName])} disabled={!canImport || busy || !reviewNote.trim() || !selectedTargetCodes[candidate.sourceBaseName]}>{t("Registrar vínculo revisado")}</button>
                </div> : null}
              </article>;
            })}
            {visibleCandidates.length === 0 ? <p>{t("Nenhum nome corresponde à busca.")}</p> : null}
            {visibleCandidates.length === 50 ? <small>{t("Mostrando até 50 resultados. Refine a busca para localizar outros nomes.")}</small> : null}
          </div>
        </div>
      ) : null}
      {preview.unmappedRowCount > 0 ? <label className="data-foundation-unmapped-confirm"><input type="checkbox" checked={acknowledgeUnmapped} onChange={(event) => onAcknowledge(event.target.checked)} />{t("As linhas sem correspondência permanecem nos totais globais e aparecem em Sem regional.")}</label> : null}
      <div className="data-foundation-preview-actions"><button type="button" onClick={onRevalidate} disabled={!canImport || busy}>{t("Revalidar")}</button><button type="button" onClick={onPublish} disabled={!canPublish}><Check size={16} />{t("Confirmar publicação")}</button></div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{formatCount(value)}</strong></div>;
}
