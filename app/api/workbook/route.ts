import { env } from "cloudflare:workers";
import { mergeTaxaHistory, type TaxaHistoryMergeResult } from "../../lib/taxa-history";
import type { ParsedWorkbook } from "../../lib/workbook";
import { filterWorkbookForBase, filterWorkbookForRegion, filterSellerReferenceForBase, filterSellerReferenceForRegion, readRegionalWorkbook } from "../../lib/regional-scope";
import {
  isUploadAuthorized,
  uploadAuthorizationError,
  uploadSecretsConfigured,
} from "../../lib/upload-auth.server";
import {
  dashboardAuthConfigured,
  dashboardViewer,
} from "../../lib/feishu-auth.server";
import {
  viewerAuthorizationError,
} from "../../lib/view-auth.server";

interface SavedWorkbookPayload {
  fileName?: string;
  parsed?: ParsedWorkbook;
  kind?: string;
  mergeHistory?: boolean;
}

type WorkbookKind = "monitoring" | "taxa" | "epop" | "movement" | "sellerList" | "sellerSpecialList" | "sellerPerformance" | "responsibilityList" | "bipagem" | "damage";

const LATEST_ID = "latest";
const LATEST_OBJECT_KEY = "workbooks/latest.json";
const MONITORING_MANIFEST_KEY = "workbooks/monitoring-history-manifest.json";
const TAXA_MANIFEST_KEY = "workbooks/taxa-history-manifest.json";
const DAMAGE_MANIFEST_KEY = "workbooks/damage-history-manifest.json";
const EPOP_MANIFEST_KEY = "workbooks/epop-history-manifest.json";

const WORKBOOK_TARGETS: Record<WorkbookKind, { id: string; objectKey: string }> = {
  monitoring: { id: LATEST_ID, objectKey: LATEST_OBJECT_KEY },
  taxa: { id: "taxa", objectKey: "workbooks/taxa-latest.json" },
  epop: { id: "epop", objectKey: "workbooks/epop-latest.json" },
  movement: { id: "movement", objectKey: "workbooks/movement-latest.json" },
  sellerList: { id: "seller-list", objectKey: "workbooks/seller-list-latest.json" },
  sellerSpecialList: { id: "seller-special-list", objectKey: "workbooks/seller-special-list-latest.json" },
  sellerPerformance: { id: "seller-performance", objectKey: "workbooks/seller-performance-latest.json" },
  responsibilityList: { id: "responsibility-list", objectKey: "workbooks/responsibility-list-latest.json" },
  bipagem: { id: "bipagem", objectKey: "workbooks/bipagem-latest.json" },
  damage: { id: "damage", objectKey: "workbooks/damage-latest.json" },
};

function normalizeKind(value: string | null | undefined): WorkbookKind {
  if (value === "movement") return "movement";
  if (value === "epop") return "epop";
  if (value === "sellerList") return "sellerList";
  if (value === "sellerSpecialList") return "sellerSpecialList";
  if (value === "sellerPerformance") return "sellerPerformance";
  if (value === "responsibilityList") return "responsibilityList";
  if (value === "bipagem") return "bipagem";
  if (value === "damage") return "damage";
  return value === "taxa" ? "taxa" : "monitoring";
}

function getDatabase() {
  if (!env.DB) {
    throw new Error("O banco de dados do dashboard ainda não está disponível.");
  }

  return env.DB;
}

function getBucket() {
  if (!env.WORKBOOKS) {
    throw new Error("O armazenamento da planilha ainda não está disponível.");
  }

  return env.WORKBOOKS;
}

async function ensureSchema(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS dashboard_state (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        object_key TEXT,
        workbook_json TEXT NOT NULL
      )`,
    )
    .run();

  try {
    await db.prepare("ALTER TABLE dashboard_state ADD COLUMN object_key TEXT").run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) throw error;
  }
}

function responseError(error: unknown, status = 500) {
  const message = status >= 500
    ? "Não foi possível acessar os dados salvos do dashboard."
    : error instanceof Error
      ? error.message
      : "Não foi possível processar a solicitação.";

  if (status >= 500) {
    console.error("[api/workbook] unexpected request error", {
      status,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function streamWorkbookPayload(
  body: ReadableStream<Uint8Array>,
  fileName: string,
  updatedAt: string,
) {
  const encoder = new TextEncoder();
  const prefix = `{"workbook":{"fileName":${JSON.stringify(fileName)},"updatedAt":${JSON.stringify(updatedAt)},"parsed":`;
  const suffix = "}}";
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush(controller) {
      controller.enqueue(encoder.encode(suffix));
    },
  }));

  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function scopeForViewer(parsed: ParsedWorkbook, region: string, kind: WorkbookKind, db: D1Database) {
  if (kind !== "sellerList" && kind !== "sellerSpecialList") return filterWorkbookForRegion(parsed, region);
  const row = await db.prepare("SELECT object_key AS objectKey, workbook_json AS workbookJson FROM dashboard_state WHERE id = ?")
    .bind(WORKBOOK_TARGETS.sellerPerformance.id).first<{ objectKey: string | null; workbookJson: string | null }>();
  const object = row?.objectKey ? await getBucket().get(row.objectKey) : null;
  if (object) {
    const { sellerIds } = await readRegionalWorkbook(object.body, region, true);
    return filterSellerReferenceForRegion(parsed, null, region, kind === "sellerSpecialList", sellerIds);
  }
  const performance = row?.workbookJson ? JSON.parse(row.workbookJson) as ParsedWorkbook : null;
  return filterSellerReferenceForRegion(parsed, performance, region, kind === "sellerSpecialList");
}

export async function GET(request: Request) {
  const viewer = await dashboardViewer(request);
  if (!viewer) return viewerAuthorizationError(dashboardAuthConfigured() ? 401 : 503);
  try {
    const kind = normalizeKind(new URL(request.url).searchParams.get("kind"));
    const target = WORKBOOK_TARGETS[kind];
    const db = getDatabase();
    await ensureSchema(db);

    const row = await db
      .prepare(
        `SELECT file_name AS fileName,
                updated_at AS updatedAt,
                object_key AS objectKey,
                workbook_json AS workbookJson
         FROM dashboard_state
         WHERE id = ?`,
      )
      .bind(target.id)
      .first<{
        fileName: string;
        updatedAt: string;
        objectKey: string | null;
        workbookJson: string | null;
      }>();

    if (!row) return Response.json({ workbook: null });

    const part = new URL(request.url).searchParams.get("part");
    const manifestKey = kind === "monitoring" ? MONITORING_MANIFEST_KEY : kind === "taxa" ? TAXA_MANIFEST_KEY : kind === "damage" ? DAMAGE_MANIFEST_KEY : kind === "epop" ? EPOP_MANIFEST_KEY : null;
    if (manifestKey && row.objectKey === manifestKey) {
      const manifestObject = await getBucket().get(manifestKey);
      if (!manifestObject) throw new Error("O histórico não foi encontrado no armazenamento.");
      const manifest = await manifestObject.json() as { parts?: string[] };
      const parts = manifest.parts?.filter((key): key is string => typeof key === "string") ?? [];
      if (part) {
        if (!parts.includes(part)) return Response.json({ error: "Parte do histórico inválida." }, { status: 400 });
        const object = await getBucket().get(part);
        if (!object) throw new Error("Uma parte do histórico não foi encontrada.");
        if (viewer.base) {
          const parsed = filterWorkbookForBase((await object.json()) as ParsedWorkbook, viewer.base);
          return Response.json({ workbook: { fileName: row.fileName, updatedAt: row.updatedAt, parsed } }, { headers: { "cache-control": "no-store" } });
        }
        return streamWorkbookPayload(object.body, row.fileName, row.updatedAt);
      }
      return Response.json({ workbook: null, historyParts: parts, fileName: row.fileName, updatedAt: row.updatedAt }, { headers: { "cache-control": "no-store" } });
    }

    if (row.objectKey) {
      const object = await getBucket().get(row.objectKey);
      if (!object) throw new Error("O arquivo publicado não foi encontrado no armazenamento.");
      if (viewer.region || viewer.base) {
        if (viewer.base) {
          const raw = (await object.json()) as ParsedWorkbook;
          if (kind === "sellerList" || kind === "sellerSpecialList") {
            const performanceRow = await db.prepare("SELECT object_key AS objectKey, workbook_json AS workbookJson FROM dashboard_state WHERE id = ?")
              .bind(WORKBOOK_TARGETS.sellerPerformance.id).first<{ objectKey: string | null; workbookJson: string | null }>();
            const performanceObject = performanceRow?.objectKey ? await getBucket().get(performanceRow.objectKey) : null;
            const performance = performanceObject ? (await performanceObject.json()) as ParsedWorkbook : performanceRow?.workbookJson ? JSON.parse(performanceRow.workbookJson) as ParsedWorkbook : null;
            const parsed = filterSellerReferenceForBase(raw, performance, viewer.base, kind === "sellerSpecialList");
            return Response.json({ workbook: { fileName: row.fileName, updatedAt: row.updatedAt, parsed } }, { headers: { "cache-control": "no-store" } });
          }
          const parsed = filterWorkbookForBase(raw, viewer.base);
          return Response.json({ workbook: { fileName: row.fileName, updatedAt: row.updatedAt, parsed } }, { headers: { "cache-control": "no-store" } });
        }
        const parsed = kind === "sellerList" || kind === "sellerSpecialList"
          ? await scopeForViewer((await object.json()) as ParsedWorkbook, viewer.region, kind, db)
          : (await readRegionalWorkbook(object.body, viewer.region)).parsed;
        return Response.json({ workbook: { fileName: row.fileName, updatedAt: row.updatedAt, parsed } }, { headers: { "cache-control": "no-store" } });
      }
      return streamWorkbookPayload(object.body, row.fileName, row.updatedAt);
    }

    if (!row.workbookJson) throw new Error("A última atualização está sem dados salvos.");
    const source = JSON.parse(row.workbookJson) as ParsedWorkbook;
    const parsed = viewer.base ? filterWorkbookForBase(source, viewer.base) : viewer.region ? await scopeForViewer(source, viewer.region, kind, db) : source;

    return Response.json({
      workbook: {
        fileName: row.fileName,
        updatedAt: row.updatedAt,
        parsed,
      },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  if (!uploadSecretsConfigured()) return uploadAuthorizationError(503);
  if (!(await isUploadAuthorized(request))) return uploadAuthorizationError();

  try {
    const payload = (await request.json()) as SavedWorkbookPayload;
    const fileName = payload.fileName?.trim();
    let parsed = payload.parsed;

    if (!fileName || !parsed) {
      return responseError(new Error("Envie o nome do arquivo e os dados processados."), 400);
    }

    if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.headers)) {
      return responseError(new Error("Os dados da planilha estão incompletos."), 400);
    }

    const db = getDatabase();
    await ensureSchema(db);

    const updatedAt = new Date().toISOString();
    const kind = normalizeKind(payload.kind);
    const target = WORKBOOK_TARGETS[kind];

    // Store each collection-rate upload as an immutable part. Merging a large
    // history and the new file inside one Worker creates several full copies
    // of the dataset and exceeds the Worker memory limit.
    if (kind === "monitoring" || kind === "taxa" || kind === "damage" || kind === "epop") {
      const historyManifestKey = kind === "monitoring" ? MONITORING_MANIFEST_KEY : kind === "taxa" ? TAXA_MANIFEST_KEY : kind === "damage" ? DAMAGE_MANIFEST_KEY : EPOP_MANIFEST_KEY;
      const current = await db.prepare("SELECT object_key AS objectKey FROM dashboard_state WHERE id = ?")
        .bind(target.id).first<{ objectKey: string | null }>();
      let parts: string[] = [];
      if (current?.objectKey === historyManifestKey) {
        const manifestObject = await getBucket().get(historyManifestKey);
        if (manifestObject) {
          const manifest = await manifestObject.json() as { parts?: string[] };
          parts = manifest.parts?.filter((key): key is string => typeof key === "string") ?? [];
        }
      } else if (current?.objectKey) {
        parts = [current.objectKey];
      }
      const partKey = `workbooks/${kind}-history/${crypto.randomUUID()}.json`;
      await getBucket().put(partKey, JSON.stringify(parsed), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      await getBucket().put(historyManifestKey, JSON.stringify({ parts: [...parts, partKey] }), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      await db.prepare(
        `INSERT INTO dashboard_state (id, file_name, updated_at, object_key, workbook_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET file_name = excluded.file_name, updated_at = excluded.updated_at,
         object_key = excluded.object_key, workbook_json = excluded.workbook_json`,
      ).bind(target.id, fileName, updatedAt, historyManifestKey, "").run();
      return Response.json({ workbook: { fileName, updatedAt }, historyMerge: { addedDates: 0, replacedDates: 0, totalDates: 0, totalRows: 0 } });
    }
    const objectKey = target.objectKey;
    let historyMerge: Omit<TaxaHistoryMergeResult, "parsed"> | undefined;

    if (kind === "taxa" && payload.mergeHistory) {
      const current = await db
        .prepare("SELECT object_key AS objectKey, workbook_json AS workbookJson FROM dashboard_state WHERE id = ?")
        .bind(target.id)
        .first<{ objectKey: string | null; workbookJson: string | null }>();
      let existing: ParsedWorkbook | null = null;
      if (current?.objectKey) {
        const object = await getBucket().get(current.objectKey);
        if (object) existing = (await object.json()) as ParsedWorkbook;
      } else if (current?.workbookJson) {
        existing = JSON.parse(current.workbookJson) as ParsedWorkbook;
      }
      const merged = mergeTaxaHistory(existing, [parsed]);
      parsed = merged.parsed;
      historyMerge = {
        addedDates: merged.addedDates,
        replacedDates: merged.replacedDates,
        totalDates: merged.totalDates,
        totalRows: merged.totalRows,
      };
    }

    await getBucket().put(objectKey, JSON.stringify(parsed), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { fileName, updatedAt },
    });

    await db
      .prepare(
        `INSERT INTO dashboard_state (id, file_name, updated_at, object_key, workbook_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file_name = excluded.file_name,
           updated_at = excluded.updated_at,
           object_key = excluded.object_key,
           workbook_json = excluded.workbook_json`,
      )
      .bind(target.id, fileName, updatedAt, objectKey, "")
      .run();

    // The consolidated collection-rate history can be large. Returning it
    // immediately after serializing it for R2 creates another full in-memory
    // copy and can exceed the Worker memory limit. The client reloads this
    // workbook from the R2-backed GET endpoint instead.
    if (kind === "taxa") {
      return Response.json({
        workbook: { fileName, updatedAt },
        historyMerge,
      });
    }

    return Response.json({
      workbook: { fileName, updatedAt, parsed },
      historyMerge,
    });
  } catch (error) {
    return responseError(error);
  }
}
