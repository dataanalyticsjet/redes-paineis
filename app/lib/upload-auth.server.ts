import { env } from "cloudflare:workers";
import { verifyUploadAuthorization } from "./upload-auth";

export function uploadSecretsConfigured() {
  return Boolean(env.UPLOAD_USERNAME && env.UPLOAD_PASSWORD);
}

export function isUploadAuthorized(request: Request) {
  return verifyUploadAuthorization(
    request.headers.get("authorization"),
    env.UPLOAD_USERNAME,
    env.UPLOAD_PASSWORD,
  );
}

export function uploadAuthorizationError(status = 401) {
  return Response.json(
    { error: status === 503 ? "Upload não configurado." : "Credenciais inválidas." },
    { status, headers: { "cache-control": "no-store" } },
  );
}
