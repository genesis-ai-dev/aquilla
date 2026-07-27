import type { IdmlDiagnostic, IdmlDiagnosticCode } from "./types.js"

export class IdmlError extends Error {
  readonly code: IdmlDiagnosticCode
  readonly diagnostics: readonly IdmlDiagnostic[]

  constructor(code: IdmlDiagnosticCode, message: string, diagnostics?: readonly IdmlDiagnostic[]) {
    super(message)
    this.name = "IdmlError"
    this.code = code
    this.diagnostics = diagnostics ?? [{ code, severity: "error", message }]
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("IDML operation aborted", "AbortError")
  }
}
