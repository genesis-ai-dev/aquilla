// SWARM-TODO(W1-C): W1-B owns the canonical `external/errors.ts` per the
// AGENT-API COMMON contract (docs/AGENT-API.md §4 "Stable, machine-actionable
// error codes"). This file did not exist in this worktree at build time, so
// W1-C ships a minimal local copy with the same shape. When W1-B's version
// lands, delete this file and repoint the import in `read-routes.ts`.
//
// JSON error envelope: { error: { code, message } }.

export type ExternalErrorCode =
  | "permission_denied"
  | "scope_denied"
  | "validation_failed"
  | "not_found"
  | "rate_limited"

const STATUS_BY_CODE: Record<ExternalErrorCode, number> = {
  permission_denied: 403,
  scope_denied: 403,
  validation_failed: 400,
  not_found: 404,
  rate_limited: 429,
}

/** Build the standard `{ error: { code, message } }` JSON error response.
 *  `status` defaults to the code's canonical HTTP status but can be
 *  overridden (e.g. 401 for "missing credential" while still using the
 *  `permission_denied` code). */
export function externalError(code: ExternalErrorCode, message: string, status?: number): Response {
  return Response.json({ error: { code, message } }, { status: status ?? STATUS_BY_CODE[code] })
}
