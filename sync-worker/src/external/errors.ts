// Stable, machine-actionable error contract for the Agent API (AQU-533 §4).
//
// This module OWNS the external error shape. Every external endpoint returns
// errors as JSON `{ error: { code, message, details? } }` with a code from the
// fixed set below, so an agent can branch on the code and self-correct.

export type ExternalErrorCode =
  | 'permission_denied'
  | 'scope_denied'
  | 'plan_stale'
  | 'confirmation_required'
  | 'validation_failed'
  | 'job_failed'
  | 'rate_limited'
  | 'not_found'

/** HTTP status per error code. */
const STATUS: Record<ExternalErrorCode, number> = {
  permission_denied: 403,
  scope_denied: 403,
  plan_stale: 409,
  confirmation_required: 428, // Precondition Required — a human approval must land first.
  validation_failed: 400,
  job_failed: 500,
  rate_limited: 429,
  not_found: 404,
}

/** Build the canonical error Response. */
export function errorResponse(
  code: ExternalErrorCode,
  message: string,
  details?: unknown,
): Response {
  const body = details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } }
  return Response.json(body, { status: STATUS[code] })
}

/**
 * Typed error carrier so deep helpers (token-bridge scope checks, precondition
 * drift) can throw and let the route wrapper serialize a consistent Response.
 */
export class ExternalError extends Error {
  constructor(
    readonly code: ExternalErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ExternalError'
  }

  toResponse(): Response {
    return errorResponse(this.code, this.message, this.details)
  }
}

/** Map any thrown value to an error Response — ExternalError verbatim, else 500. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ExternalError) return err.toResponse()
  const message = err instanceof Error ? err.message : String(err)
  return errorResponse('job_failed', message)
}
