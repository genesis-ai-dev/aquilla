/**
 * Stable error envelope shared across every route (contract §1):
 *   { error: { code, message } }
 */
export type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "validation_failed"
  | "exec_failed"
  | "too_large"
  // AQU-1848: the container pool (or the caller's share of it) is saturated.
  // 503 + Retry-After, because it is transient and the caller should come back.
  | "pool_busy"

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_failed: 400,
  exec_failed: 500,
  too_large: 413,
  pool_busy: 503,
}

export class ApiError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "ApiError"
  }
  get status(): number {
    return STATUS[this.code]
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string }
}

export function envelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } }
}
