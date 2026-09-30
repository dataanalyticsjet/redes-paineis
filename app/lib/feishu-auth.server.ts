import { env } from "cloudflare:workers";
import { authenticateViewer, viewerAccountsConfigured, type ViewerIdentity } from "./view-auth.server";

const SESSION_COOKIE = "jt_dashboard_session";
const STATE_COOKIE = "jt_feishu_oauth_state";
const DIAGNOSTIC_COOKIE = "jt_feishu_auth_attempt";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const CALLBACK_PATH = "/api/auth/feishu/callback";
const encoder = new TextEncoder();

type LocalViewerRow = {
  id: string;
  tenant_key: string;
  open_id: string | null;
  email: string;
  username: string;
  profile: "USER";
  region: string | null;
  base: string | null;
};

type FeishuViewerAuthorization = {
  email: string;
  tenant_key: string;
  role: "matrix" | "regional";
  region: string | null;
  base: string | null;
};

function runtimeValue(name: string) {
  return String((env as unknown as Record<string, unknown>)[name] ?? "").trim();
}

export function parseFeishuViewerAuthorizations(value: string): FeishuViewerAuthorization[] | null {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const entries: FeishuViewerAuthorization[] = [];
    const identities = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const email = String(entry.email ?? "").trim().toLowerCase();
      const tenant_key = String(entry.tenant_key ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !tenant_key) return null;
      if (entry.role !== "matrix" && entry.role !== "regional") return null;
      const region = String(entry.region ?? "").trim().toUpperCase() || null;
      const base = String(entry.base ?? "").trim().toUpperCase() || null;
      if (entry.role === "regional" && !region && !base) return null;
      if (entry.role === "matrix" && (region || base)) return null;
      const identity = `${email}\u0000${tenant_key}`;
      if (identities.has(identity)) return null;
      identities.add(identity);
      entries.push({ email, tenant_key, role: entry.role, region, base });
    }
    return entries;
  } catch {
    return null;
  }
}

export function feishuAuthorizationConfigured() {
  return Boolean(parseFeishuViewerAuthorizations(runtimeValue("FEISHU_VIEWER_ACCOUNTS_JSON"))?.length);
}

function feishuViewerAuthorization(email: string, tenantKey: string): FeishuViewerAuthorization | null {
  const parsed = parseFeishuViewerAuthorizations(runtimeValue("FEISHU_VIEWER_ACCOUNTS_JSON"));
  if (!parsed) return null;
  const normalizedEmail = email.trim().toLowerCase();
  return parsed.find((item) => item.email === normalizedEmail && item.tenant_key === tenantKey.trim()) ?? null;
}

function database(): D1Database {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("O banco local D1 não está disponível.");
  return db;
}

export function isDevelopmentEnvironment() {
  return typeof process !== "undefined" && process.env.NODE_ENV === "development";
}

export function feishuConfiguration() {
  return {
    clientId: runtimeValue("FEISHU_APP_ID"),
    clientSecret: runtimeValue("FEISHU_APP_SECRET"),
    redirectUri: runtimeValue("FEISHU_REDIRECT_URI"),
    sessionSecret: runtimeValue("FEISHU_SESSION_SECRET"),
  };
}

export function feishuLoginConfigured() {
  const config = feishuConfiguration();
  return Boolean(
    config.clientId && config.clientSecret && config.redirectUri &&
    config.sessionSecret.length >= 32
  );
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator >= 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function keyedDigest(value: string) {
  const secret = feishuConfiguration().sessionSecret;
  if (secret.length < 32) throw new Error("FEISHU_SESSION_SECRET não está configurada.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function secureCookie(request: Request) {
  const url = new URL(request.url);
  return !(isDevelopmentEnvironment() && url.protocol === "http:" && url.hostname === "localhost");
}

function cookieAttributes(request: Request, maxAge: number) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(request) ? "; Secure" : ""}`;
}

function cookieDomainMatchesRequest(request: Request, redirectUri: string) {
  const current = new URL(request.url);
  const callback = new URL(redirectUri);
  if (current.hostname === "localhost" || current.hostname === "127.0.0.1") return current.origin === callback.origin;
  return current.origin === callback.origin;
}

export function feishuRedirectUriMatchesRequest(request: Request) {
  const redirectUri = feishuConfiguration().redirectUri;
  if (!redirectUri || !cookieDomainMatchesRequest(request, redirectUri)) return false;
  const callback = new URL(redirectUri);
  const localHttp = callback.protocol === "http:" && (callback.hostname === "localhost" || callback.hostname === "127.0.0.1");
  return callback.pathname === CALLBACK_PATH && !callback.search && !callback.hash && (callback.protocol === "https:" || (isDevelopmentEnvironment() && localHttp));
}

export function createOAuthState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createOAuthAttempt() {
  const state = createOAuthState();
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64UrlEncode(await digest(verifier));
  const now = Date.now();
  await database().prepare("INSERT INTO feishu_oauth_states (state_hash, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(base64UrlEncode(await keyedDigest(state)), verifier, now + STATE_TTL_SECONDS * 1000, now).run();
  return { state, challenge };
}

export function appendOAuthStateCookie(headers: Headers, request: Request, state: string) {
  headers.append("set-cookie", `${STATE_COOKIE}=${state}; ${cookieAttributes(request, STATE_TTL_SECONDS)}`);
}

export function createAuthAttemptId() {
  return crypto.randomUUID();
}

export function appendAuthAttemptCookie(headers: Headers, request: Request, attemptId: string) {
  headers.append("set-cookie", `${DIAGNOSTIC_COOKIE}=${attemptId}; ${cookieAttributes(request, STATE_TTL_SECONDS)}`);
}

export function authAttemptId(request: Request) {
  const value = cookieValue(request, DIAGNOSTIC_COOKIE);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export function logFeishuAuth(attemptId: string, step: string, details: Record<string, string | number | boolean | null> = {}) {
  if (!isDevelopmentEnvironment()) return;
  // Callers pass only fixed, non-sensitive metadata. Never log request URLs,
  // cookies, OAuth parameters, provider messages, credentials, or tokens.
  console.info("[feishu-auth]", JSON.stringify({ attemptId, step, ...details }));
}

export function clearOAuthStateCookie(request: Request) {
  const expired = `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
  return `${STATE_COOKIE}=; ${expired}`;
}

export function clearAuthAttemptCookie(request: Request) {
  const expired = `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
  return `${DIAGNOSTIC_COOKIE}=; ${expired}`;
}

export async function consumeOAuthState(request: Request, state: string | null): Promise<string | null> {
  const cookieState = cookieValue(request, STATE_COOKIE);
  if (!state || !cookieState || !constantTimeEqual(encoder.encode(state), encoder.encode(cookieState))) return null;
  const result = await database().prepare("DELETE FROM feishu_oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING code_verifier")
    .bind(base64UrlEncode(await keyedDigest(state)), Date.now()).first<{ code_verifier: string }>();
  return result?.code_verifier ?? null;
}

export function clearFeishuCookies(request: Request) {
  const expired = `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
  return [`${SESSION_COOKIE}=; ${expired}`, clearOAuthStateCookie(request), clearAuthAttemptCookie(request)];
}

export async function provisionOrFindFeishuUser(input: { openId: string; tenantKey: string; email: string; name?: string | null }) {
  if (!input.tenantKey.trim() || !input.openId.trim() || !input.email.trim()) return null;
  const db = database();
  const normalizedEmail = input.email.trim().toLowerCase();
  const authorization = feishuViewerAuthorization(normalizedEmail, input.tenantKey);
  if (!authorization) return null;
  const existing = await db.prepare("SELECT id, tenant_key, open_id, email, username, profile, region, base FROM local_auth_users WHERE normalized_email = ? AND disabled_at IS NULL")
    .bind(normalizedEmail).first<LocalViewerRow & { normalized_email: string }>();
  if (!existing) {
    const user: LocalViewerRow = {
      id: crypto.randomUUID(), tenant_key: input.tenantKey, open_id: input.openId, email: input.email,
      username: input.name?.trim() || input.email, profile: "USER",
      region: authorization.region, base: authorization.base,
    };
    await db.prepare("INSERT INTO local_auth_users (id, tenant_key, open_id, normalized_email, email, username, profile, region, base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'USER', ?, ?, ?, ?)")
      .bind(user.id, user.tenant_key, user.open_id, normalizedEmail, user.email, user.username, user.region, user.base, Date.now(), Date.now()).run();
    return user;
  }
  if (existing.tenant_key !== input.tenantKey || (existing.open_id && existing.open_id !== input.openId)) return null;
  if (existing.profile !== "USER") return null;
  if ((existing.region?.trim().toUpperCase() || null) !== authorization.region || (existing.base?.trim().toUpperCase() || null) !== authorization.base) return null;
  if (!existing.open_id) {
    const linked = await db.prepare("UPDATE local_auth_users SET open_id = ?, updated_at = ? WHERE id = ? AND open_id IS NULL RETURNING id")
      .bind(input.openId, Date.now(), existing.id).first<{ id: string }>();
    if (!linked) return null;
    existing.open_id = input.openId;
  }
  return existing;
}

export async function sessionCookie(userId: string, request: Request) {
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const sessionHash = base64UrlEncode(await keyedDigest(token));
  const now = Date.now();
  await database().prepare("INSERT INTO local_auth_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionHash, userId, now + SESSION_TTL_SECONDS * 1000, now).run();
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(request, SESSION_TTL_SECONDS)}`;
}

async function sessionViewer(request: Request): Promise<ViewerIdentity | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const sessionHash = base64UrlEncode(await keyedDigest(token));
  const row = await database().prepare("SELECT u.username, u.email, u.tenant_key, u.region, u.base FROM local_auth_sessions s JOIN local_auth_users u ON u.id = s.user_id WHERE s.session_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL AND u.disabled_at IS NULL AND u.profile = 'USER'")
    .bind(sessionHash, Date.now()).first<{ username: string; email: string; tenant_key: string; region: string | null; base: string | null }>();
  if (!row) return null;
  const authorization = feishuViewerAuthorization(row.email, row.tenant_key);
  if (!authorization || authorization.region !== (row.region?.trim().toUpperCase() || null) || authorization.base !== (row.base?.trim().toUpperCase() || null)) return null;
  return { username: row.username, role: authorization.role, region: authorization.region, base: authorization.base };
}

export async function revokeFeishuSession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return;
  const sessionHash = base64UrlEncode(await keyedDigest(token));
  await database().prepare("UPDATE local_auth_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), sessionHash).run();
}

export async function dashboardViewer(request: Request): Promise<ViewerIdentity | null> {
  if (cookieValue(request, SESSION_COOKIE)) {
    try {
      const viewer = await sessionViewer(request);
      if (viewer) return viewer;
    } catch {
      return null;
    }
  }
  if (isDevelopmentEnvironment()) return authenticateViewer(request);
  return null;
}

export function dashboardAuthConfigured() {
  return feishuLoginConfigured() || (isDevelopmentEnvironment() && viewerAccountsConfigured());
}
