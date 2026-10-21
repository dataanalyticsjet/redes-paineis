"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api-url";
import {
  loadIndependently,
  PUBLICATION_HISTORY_LIMIT,
  PUBLICATION_SUMMARY_LIMIT,
  publicationHeadChanged,
  publicationRequestPlan,
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
  const [contractErrors, setContractErrors] = useState<Record<string, string>>({});
  const [publicationErrors, setPublicationErrors] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<MappingStatus | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [selectedSource, setSelectedSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mappingFile, setMappingFile] = useState<File | null>(null);
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
  const [publicationHistoryLoading, setPublicationHistoryLoading] = useState<Record<string, boolean>>({});
  const metadataLoadGeneration = useRef(0);
  const metadataAbortController = useRef<AbortController | null>(null);
  const selectedSourceRef = useRef("");
  const publicationValuesRef = useRef<Record<string, Publication[]>>({});
  const detailedHistorySourcesRef = useRef(new Set<string>());
  const selectedHistoryAbortController = useRef<AbortController | null>(null);
  const selectedHistoryRequestGeneration = useRef(0);
  const initialSummaryLoad = useRef<Promise<void>>(Promise.resolve());
  const t4t5RecoveryStarted = useRef(false);

  const fetchFullHistory = useCallback(async (sourceId: string, loadGeneration: number) => {
    selectedHistoryAbortController.current?.abort();
    const controller = new AbortController();
    selectedHistoryAbortController.current = controller;
    const requestGeneration = ++selectedHistoryRequestGeneration.current;
    const isCurrentRequest = () => (
      metadataLoadGeneration.current === loadGeneration
      && selectedHistoryRequestGeneration.current === requestGeneration
      && selectedSourceRef.current === sourceId
      && !controller.signal.aborted
    );

    setPublicationHistoryLoading((current) => ({ ...current, [sourceId]: true }));
    setPublicationErrors((current) => {
      if (!current[sourceId]) return current;
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
    try {
      const result = await requestPublications(sourceId, PUBLICATION_HISTORY_LIMIT, controller.signal);
      if (!isCurrentRequest()) return;
      publicationValuesRef.current[sourceId] = result.publications;
      detailedHistorySourcesRef.current.add(sourceId);
      setPublications((current) => ({ ...current, [sourceId]: result.publications }));
    } catch (caught) {
      if (!isCurrentRequest()) return;
      publicationValuesRef.current[sourceId] = [];
      detailedHistorySourcesRef.current.delete(sourceId);
      setPublications((current) => ({ ...current, [sourceId]: [] }));
      setPublicationErrors((current) => ({
        ...current,
        [sourceId]: caught instanceof Error ? caught.message : "data_foundation_request_failed",
      }));
    } finally {
      if (isCurrentRequest()) {
        setPublicationHistoryLoading((current) => ({ ...current, [sourceId]: false }));
      }
    }
  }, []);

  const ensureSourceHistory = useCallback(async (sourceId: string) => {
    const loadGeneration = metadataLoadGeneration.current;
    await initialSummaryLoad.current;
    if (
      metadataLoadGeneration.current !== loadGeneration
      || selectedSourceRef.current !== sourceId
    ) return;

    if (!detailedHistorySourcesRef.current.has(sourceId)) {
      await fetchFullHistory(sourceId, loadGeneration);
      return;
    }

    selectedHistoryAbortController.current?.abort();
    const controller = new AbortController();
    selectedHistoryAbortController.current = controller;
    const requestGeneration = ++selectedHistoryRequestGeneration.current;
    const isCurrentRequest = () => (
      metadataLoadGeneration.current === loadGeneration
      && selectedHistoryRequestGeneration.current === requestGeneration
      && selectedSourceRef.current === sourceId
      && !controller.signal.aborted
    );
    setPublicationHistoryLoading((current) => ({ ...current, [sourceId]: true }));
    try {
      const head = await requestPublications(sourceId, 1, controller.signal);
      if (!isCurrentRequest()) return;
      const cachedLatest = publicationValuesRef.current[sourceId]?.[0] ?? null;
      const currentLatest = head.publications[0] ?? null;
      if (!publicationHeadChanged(cachedLatest, currentLatest)) {
        setPublicationErrors((current) => {
          if (!current[sourceId]) return current;
          const next = { ...current };
          delete next[sourceId];
          return next;
        });
        setPublicationHistoryLoading((current) => ({ ...current, [sourceId]: false }));
        return;
      }
      await fetchFullHistory(sourceId, loadGeneration);
    } catch (caught) {
      if (!isCurrentRequest()) return;
      publicationValuesRef.current[sourceId] = [];
      detailedHistorySourcesRef.current.delete(sourceId);
      setPublications((current) => ({ ...current, [sourceId]: [] }));
      setPublicationErrors((current) => ({
        ...current,
        [sourceId]: caught instanceof Error ? caught.message : "data_foundation_request_failed",
      }));
      setPublicationHistoryLoading((current) => ({ ...current, [sourceId]: false }));
    }
  }, [fetchFullHistory]);

  const loadMetadata = useCallback(async () => {
    metadataAbortController.current?.abort();
    selectedHistoryAbortController.current?.abort();
    const controller = new AbortController();
    metadataAbortController.current = controller;
    const loadGeneration = ++metadataLoadGeneration.current;
    selectedHistoryRequestGeneration.current += 1;
    const isCurrentLoad = () => (
      metadataLoadGeneration.current === loadGeneration && !controller.signal.aborted
    );
    setLoading(true);
    setError(null);
    setNotice(null);
    setContracts({});
    setPublications({});
    publicationValuesRef.current = {};
    detailedHistorySourcesRef.current.clear();
    initialSummaryLoad.current = Promise.resolve();
    setPublicationHistoryLoading({});
    setContractErrors({});
    setPublicationErrors({});
    setMapping(null);
    setMappingError(null);
    setMappingLoading(true);
    try {
      const result = await requestJson<{ sources: Source[] }>("/api/v2/data-sources", { signal: controller.signal });
      if (!isCurrentLoad()) return;
      setSources(result.sources);
      const selectedStillExists = result.sources.some((source) => source.source_id === selectedSourceRef.current);
      const activeSource = selectedStillExists ? selectedSourceRef.current : result.sources[0]?.source_id ?? "";
      selectedSourceRef.current = activeSource;
      setSelectedSource(activeSource);
      setLoading(false);

      const publicationPlan = publicationRequestPlan(result.sources, activeSource);
      const activeHistory = publicationPlan.find((item) => item.limit === PUBLICATION_HISTORY_LIMIT);
      if (activeHistory) void fetchFullHistory(activeHistory.source.source_id, loadGeneration);

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
        result.sources,
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

      initialSummaryLoad.current = loadIndependently(
        publicationPlan.filter((item) => item.limit === PUBLICATION_SUMMARY_LIMIT),
        (item) => requestPublications(
          item.source.source_id,
          item.limit,
          controller.signal,
        ),
        (item, history) => {
          if (!isCurrentLoad()) return;
          publicationValuesRef.current[item.source.source_id] = history.publications;
          setPublications((current) => ({ ...current, [item.source.source_id]: history.publications }));
          setPublicationErrors((current) => {
            if (!current[item.source.source_id]) return current;
            const next = { ...current };
            delete next[item.source.source_id];
            return next;
          });
        },
        (item, caught) => {
          if (!isCurrentLoad()) return;
          setPublicationErrors((current) => ({
            ...current,
            [item.source.source_id]: caught instanceof Error ? caught.message : "data_foundation_request_failed",
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
  }, [fetchFullHistory]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadMetadata();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      metadataAbortController.current?.abort();
      selectedHistoryAbortController.current?.abort();
      metadataLoadGeneration.current += 1;
      selectedHistoryRequestGeneration.current += 1;
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
        selectedSourceRef.current = status.sourceId;
        setSelectedSource(status.sourceId);
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
        selectedSourceRef.current = status.sourceId;
        setSelectedSource(status.sourceId);
        if (["VALIDATED", "INVALID"].includes(status.state) || (status.state === "FAILED" && status.canPublish)) {
          setPreview(status as unknown as Preview);
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

  const selectSource = useCallback((sourceId: string) => {
    if (sourceId === selectedSourceRef.current || loading) return;
    const previousSourceId = selectedSourceRef.current;
    selectedSourceRef.current = sourceId;
    selectedHistoryAbortController.current?.abort();
    selectedHistoryRequestGeneration.current += 1;
    setPublicationHistoryLoading((current) => ({
      ...current,
      ...(previousSourceId ? { [previousSourceId]: false } : {}),
      [sourceId]: true,
    }));
    setSelectedSource(sourceId);
    setPreview(null);
    setLargeImportProgress(null);
    setCandidates([]);
    setMappingReviewDirty(false);
    setFile(null);
    void ensureSourceHistory(sourceId);
  }, [ensureSourceHistory, loading]);

  const contract = contracts[selectedSource];
  const sourcePublications = publications[selectedSource] ?? [];
  const latestPublication = sourcePublications[0];
  const sourceHistoryLoading = publicationHistoryLoading[selectedSource] ?? false;
  const importActionsEnabled = canImport && error !== "data_foundation_v2_disabled";
  const visibleCandidates = useMemo(() => {
    const query = normalize(candidateQuery.trim());
    return candidates
      .filter((candidate) => !query || normalize(candidate.sourceBaseName).includes(query))
      .slice(0, 50);
  }, [candidateQuery, candidates]);

  async function waitForT4T5Job(jobId: string): Promise<T4T5ImportStatus> {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await requestJson<T4T5ImportStatus>(`/api/v2/imports/${encodeURIComponent(jobId)}`);
      setLargeImportProgress(status);
      if (["VALIDATED", "INVALID", "PUBLISHED", "REUSED"].includes(status.state)) return status;
      if (status.state === "FAILED") throw new Error(status.errorCode || "import_processing_failed");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
    }
    throw new Error("import_processing_timeout");
  }

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !selectedSource) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setLargeImportProgress(null);
    setCandidates([]);
    setMappingReviewDirty(false);
    setAcknowledgeUnmapped(false);
    try {
      const body = new FormData();
      body.append("source_id", selectedSource);
      body.append("file", file, file.name);
      let result: Preview;
      if (selectedSource === "collection_monitoring_t4_t5") {
        const accepted = await requestJson<T4T5ImportStatus>("/api/v2/imports/preview", { method: "POST", body });
        window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({ jobId: accepted.jobId }));
        setLargeImportProgress(accepted);
        result = await waitForT4T5Job(accepted.jobId) as unknown as Preview;
      } else {
        result = await requestJson<Preview>("/api/v2/imports/preview", { method: "POST", body });
      }
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
        result = await waitForT4T5Job(preview.jobId) as unknown as Preview;
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
      const t4t5IdempotencyKey = preview.sourceId === "collection_monitoring_t4_t5" ? crypto.randomUUID() : null;
      if (t4t5IdempotencyKey) {
        window.sessionStorage.setItem(T4T5_SESSION_JOB_KEY, JSON.stringify({
          jobId: preview.jobId,
          idempotencyKey: t4t5IdempotencyKey,
        }));
      }
      const headers = {
        "Idempotency-Key": mappingPublish
          ? `base-mapping-initial:${preview.jobId}`
          : t4t5IdempotencyKey ?? crypto.randomUUID(),
      };
      const path = mappingPublish
        ? `/api/v2/base-mapping/initial-migration/${encodeURIComponent(preview.jobId)}/publish`
        : `/api/v2/imports/${encodeURIComponent(preview.jobId)}/publish`;
      let result: { version: number; mappingRowCount?: number; reused?: boolean };
      if (preview.sourceId === "collection_monitoring_t4_t5") {
        const queued = await requestJson<T4T5ImportStatus>(path, { method: "POST", headers });
        setLargeImportProgress(queued);
        const completed = await waitForT4T5Job(preview.jobId);
        if (!["PUBLISHED", "REUSED"].includes(completed.state) || typeof completed.version !== "number") {
          throw new Error("import_publication_failed");
        }
        result = { version: completed.version, reused: completed.reused };
      } else {
        result = await requestJson<{ version: number; mappingRowCount?: number; reused?: boolean }>(path, { method: "POST", headers });
      }
      invalidateDashboardDataCache(mappingPublish ? undefined : preview.sourceId);
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
      setLargeImportProgress(null);
      if (preview.sourceId === "collection_monitoring_t4_t5") window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY);
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
      ) : mappingError ? (
        <div className="data-foundation-alert is-error" role="alert">
          <AlertTriangle size={18} />
          <span>{t("Não foi possível verificar o de-para vigente.")} {displayApiError(mappingError, t)}</span>
        </div>
      ) : mappingLoading ? <p className="data-foundation-loading">{t("Verificando de-para vigente…")}</p> : null}

      {error ? (
        <div className={`data-foundation-alert ${error === "data_foundation_v2_disabled" ? "is-disabled" : "is-error"}`} role="alert">
          {error === "data_foundation_v2_disabled" ? <Clock3 size={18} /> : <AlertTriangle size={18} />}
          <div>
            <strong>{error === "data_foundation_v2_disabled" ? t("Data Foundation V2 desativada neste ambiente") : displayApiError(error, t)}</strong>
            {error === "data_foundation_v2_disabled" ? <p>{t("Configure DATA_QUERIES_ENABLED=true e DATA_IMPORT_ENABLED=true com as credenciais dedicadas DATA_DB_* e o diretório DATA_IMPORT_STAGING_DIRECTORY para habilitar a Central localmente.")}</p> : null}
          </div>
        </div>
      ) : null}
      {!canImport && !error?.includes("disabled") ? <div className="data-foundation-alert is-disabled"><AlertTriangle size={18} /><p>{t("Seu perfil pode consultar apenas dados do próprio escopo. A administração e publicação exigem perfil ADMIN; isso não amplia o escopo dos dashboards.")}</p></div> : null}
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
                  onClick={() => selectSource(source.source_id)}
                  disabled={loading}
                >
                  <FileSpreadsheet size={18} />
                  <span><strong>{t(source.display_name)}</strong><small>{sourceContract ? `${sourceContract.columns.length} ${t("colunas")} · v${sourceContract.version}` : contractErrors[source.source_id] ? t("Contrato indisponível") : t("Carregando contrato…")}</small></span>
                  <small>{publicationHistoryLoading[source.source_id] ? t("Carregando…") : last ? `v${last.version}` : publicationErrors[source.source_id] ? t("Histórico indisponível") : publications[source.source_id] ? t("Sem publicação") : t("Carregando…")}</small>
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
                  <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("PUBLICAÇÕES")}</span><h2>{t("Última publicação e histórico")}</h2></div>{sourceHistoryLoading ? <span className="data-foundation-state">{t("Carregando…")}</span> : latestPublication ? <span className="data-foundation-state is-ready">{t("Versão {version}", { version: latestPublication.version })}</span> : <span className="data-foundation-state">{t("Sem publicação")}</span>}</div>
                  {!sourceHistoryLoading && latestPublication ? <p className="data-foundation-latest"><Clock3 size={15} /> {formatDateTime(latestPublication.publishedAt)} · {formatCount(latestPublication.visibleRowCount)} {t("registros visíveis")}{latestPublication.periodStart ? ` · ${latestPublication.periodStart} – ${latestPublication.periodEnd}` : ""}</p> : null}
                  {sourceHistoryLoading ? <p className="data-foundation-loading">{t("Carregando histórico…")}</p> : publicationErrors[selectedSource] ? <div className="data-foundation-alert is-error" role="alert"><AlertTriangle size={17} /><span>{t("Não foi possível carregar o histórico desta fonte.")} {displayApiError(publicationErrors[selectedSource], t)}</span></div> : sourcePublications.length ? <div className="data-foundation-history">{sourcePublications.map((publication) => <div key={publication.publicationId}><span>{t("Versão {version}", { version: publication.version })}</span><span>{formatDateTime(publication.publishedAt)}</span><strong>{formatCount(publication.visibleRowCount)} {t("registros")}</strong><small>{publication.periodStart ? `${publication.periodStart} – ${publication.periodEnd}` : t("Snapshot")}</small></div>)}</div> : publications[selectedSource] ? <p className="data-foundation-empty">{t("Ainda não há publicações visíveis para este escopo.")}</p> : <p className="data-foundation-loading">{t("Carregando histórico…")}</p>}
                </section>

                <section className="data-foundation-card">
                  <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("NOVA CARGA")}</span><h2>{t("Validar arquivo Excel")}</h2></div></div>
                  <form className="data-foundation-upload-form" onSubmit={(event) => void makePreview(event)}>
                    <label>{t("Arquivo oficial .xlsx")}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setLargeImportProgress(null); window.sessionStorage.removeItem(T4T5_SESSION_JOB_KEY); setMappingReviewDirty(false); }} disabled={!importActionsEnabled || !contract || busy} /></label>
                    <button type="submit" disabled={!importActionsEnabled || !contract || !file || busy}><Upload size={16} />{t("Gerar prévia")}</button>
                  </form>
                  {largeImportProgress?.sourceId === selectedSource && ["RECEIVED", "PARSING"].includes(largeImportProgress.state) ? (
                    <div className="data-foundation-alert is-disabled" role="status" aria-live="polite">
                      <Clock3 size={17} />
                      <div>
                        <strong>{t(largeImportProgress.phase === "PUBLICATION" ? "Publicando arquivo T4/T5 em lotes…" : "Validando arquivo T4/T5 em segundo plano…")}</strong>
                        <p>{t("Linhas analisadas")}: {formatCount(largeImportProgress.inputRowCount ?? 0)}</p>
                        <progress aria-label={t("Progresso da importação")}></progress>
                      </div>
                    </div>
                  ) : null}
                </section>

                {preview && !isMappingPreview ? <PreviewPanel preview={preview} candidates={candidates} candidateQuery={candidateQuery} reviewNote={reviewNote} visibleCandidates={visibleCandidates} canImport={importActionsEnabled} busy={busy} mappingReviewDirty={mappingReviewDirty} acknowledgeUnmapped={acknowledgeUnmapped} onCandidateQuery={setCandidateQuery} onReviewNote={setReviewNote} onAcknowledge={setAcknowledgeUnmapped} onDecision={(candidate, state, targetCode) => void saveDecision(candidate, state, targetCode)} onRevalidate={() => void revalidate()} onPublish={() => void publish()} canPublish={canPublish} t={t} /> : null}
              </>
            ) : contractErrors[selectedSource] ? (
              <div className="data-foundation-alert is-error" role="alert"><AlertTriangle size={17} /><span>{t("Não foi possível carregar o contrato desta fonte.")} {displayApiError(contractErrors[selectedSource], t)}</span></div>
            ) : <p className="data-foundation-loading">{t("Carregando contrato…")}</p>}
          </div>
        </div>
      ) : null}

      {canImport ? (
        <section className="data-foundation-card data-foundation-initial-map">
          <div className="data-foundation-card-heading"><div><span className="card-eyebrow">{t("MIGRAÇÃO INICIAL")}</span><h2>{t("De-para oficial DoomsDay")}</h2><p>{t("A migração preserva o arquivo original como versão 1 e só atualiza o ponteiro após validação e confirmação.")}</p></div><span className={`data-foundation-state ${mapping?.state === "PUBLISHED" ? "is-ready" : ""}`}>{mapping ? mapping.state === "PUBLISHED" ? t("Publicado") : t("Pendente") : mappingError ? t("Estado indisponível") : t("Verificando…")}</span></div>
          <form className="data-foundation-upload-form" onSubmit={(event) => void makeMappingPreview(event)}>
            <label>{t("De_para DoomsDay.xlsx · aba Ativas")}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setMappingFile(event.target.files?.[0] ?? null); setPreview(null); }} disabled={!importActionsEnabled || !mapping || Boolean(mappingError) || busy || mapping.state === "PUBLISHED"} /></label>
            <button type="submit" disabled={!importActionsEnabled || !mapping || Boolean(mappingError) || !mappingFile || busy || mapping.state === "PUBLISHED"}><Upload size={16} />{t("Validar de-para")}</button>
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
      {preview.duplicateCount || preview.exactNameCandidateRowCount || preview.normalizedNameCandidateRowCount || preview.noMappingMatchRowCount || preview.missingIdentifierRowCount || preview.ambiguousRowCount ? <div className="data-foundation-extra-counts"><span>{t("Duplicatas preservadas")}: <strong>{formatCount(preview.duplicateCount)}</strong></span><span>{t("Candidatas por nome exato")}: <strong>{formatCount(preview.exactNameCandidateRowCount)}</strong></span><span>{t("Candidatas por nome normalizado")}: <strong>{formatCount(preview.normalizedNameCandidateRowCount ?? 0)}</strong></span><span>{t("Sem correspondência")}: <strong>{formatCount(preview.noMappingMatchRowCount)}</strong></span><span>{t("Identificador ausente")}: <strong>{formatCount(preview.missingIdentifierRowCount)}</strong></span><span>{t("Ambíguas")}: <strong>{formatCount(preview.ambiguousRowCount)}</strong></span></div> : null}
      {Object.keys(preview.perDateCounts).length ? <details className="data-foundation-details"><summary>{t("Contagem por data")}</summary><div className="data-foundation-date-counts">{Object.entries(preview.perDateCounts).map(([date, count]) => <span key={date}>{date}<strong>{formatCount(count)}</strong></span>)}</div></details> : null}
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
