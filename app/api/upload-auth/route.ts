import {
  isUploadAuthorized,
  uploadAuthorizationError,
  uploadSecretsConfigured,
} from "../../lib/upload-auth.server";

export async function POST(request: Request) {
  if (!uploadSecretsConfigured()) return uploadAuthorizationError(503);
  if (!(await isUploadAuthorized(request))) return uploadAuthorizationError();
  return Response.json(
    { authenticated: true },
    { headers: { "cache-control": "no-store" } },
  );
}
