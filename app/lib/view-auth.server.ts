import { env } from "cloudflare:workers";
import { verifyUploadAuthorization } from "./upload-auth";

export interface ViewerIdentity {
  username: string;
  region: string | null;
  base: string | null;
  role: "matrix" | "regional";
}

interface ViewerAccount {
  username: string;
  password: string;
  region?: string | null;
  base?: string | null;
  role?: "matrix" | "regional";
}

function accounts(): ViewerAccount[] {
  try {
    const parsed = JSON.parse(String(env.VIEWER_ACCOUNTS_JSON ?? "[]"));
    const configured = Array.isArray(parsed) ? parsed : [];
    const baseUsername = String(env.BASE_VIEWER_USERNAME ?? "").trim();
    const basePassword = String(env.BASE_VIEWER_PASSWORD ?? "");
    const base = String(env.BASE_VIEWER_BASE ?? "").trim();
    return baseUsername && basePassword && base ? [...configured, { username: baseUsername, password: basePassword, base, role: "regional" }] : configured;
  } catch {
    return [];
  }
}

export function viewerAccountsConfigured() {
  return accounts().length > 0;
}

export async function authenticateViewer(request: Request): Promise<ViewerIdentity | null> {
  for (const account of accounts()) {
    if (!account.username || !account.password) continue;
    if (!(await verifyUploadAuthorization(request.headers.get("authorization"), account.username, account.password))) continue;
    const configuredRegion = String(account.region ?? "").trim().toUpperCase() || null;
    const configuredBase = String(account.base ?? "").trim().toUpperCase() || null;
    const isMatrix = account.role === "matrix";
    if (!isMatrix && !configuredRegion && !configuredBase) continue;
    return {
      username: account.username,
      // Matrix accounts are never constrained by a stale regional setting.
      region: isMatrix ? null : configuredRegion,
      base: isMatrix ? null : configuredBase,
      role: isMatrix ? "matrix" : "regional",
    };
  }
  return null;
}

export function viewerAuthorizationError(status = 401) {
  return Response.json(
    { error: status === 503 ? "Acesso ao dashboard ainda não configurado." : "Usuário ou senha inválidos." },
    { status, headers: { "cache-control": "no-store" } },
  );
}
