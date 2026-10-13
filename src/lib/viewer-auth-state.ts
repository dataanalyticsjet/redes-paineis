export type ViewerAuthState = "CHECKING" | "AUTHENTICATED" | "UNAUTHENTICATED" | "ERROR";

export interface ViewerSessionPayload {
  authenticated?: boolean;
  is_active?: boolean;
}

export function viewerAuthStateFromResponse(
  statusCode: number,
  identity: ViewerSessionPayload | null,
): ViewerAuthState {
  if (statusCode === 401) return "UNAUTHENTICATED";
  if (statusCode < 200 || statusCode >= 300) return "ERROR";
  if (identity?.authenticated !== true || identity.is_active === false) return "UNAUTHENTICATED";
  return "AUTHENTICATED";
}
