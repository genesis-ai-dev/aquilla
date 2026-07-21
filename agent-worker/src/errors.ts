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

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_failed: 400,
  exec_failed: 500,
  too_large: 413,
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
