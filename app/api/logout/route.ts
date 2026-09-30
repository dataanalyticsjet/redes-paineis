import { clearFeishuCookies, revokeFeishuSession } from "../../lib/feishu-auth.server";

export async function POST(request: Request) {
  const headers = new Headers({ "cache-control": "no-store" });
  try {
    await revokeFeishuSession(request);
  } catch {
    // Always clear the browser cookie even if the local D1 session store is unavailable.
  }
  for (const cookie of clearFeishuCookies(request)) headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
}
