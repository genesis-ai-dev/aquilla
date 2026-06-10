// RES-6: hard request timeouts for sync-worker HTTP calls. A hung connection
// must not strand the caller until the browser's multi-minute socket timeout.
//
// `AbortSignal.timeout` is missing on older WebKit/engines. The read path
// (cells-read.ts) always feature-detected it, but the write path
// (outbox-flush.ts) once called it unconditionally — on engines without it
// every flush threw BEFORE the fetch, permanently bricking writes that the
// read path happily served. Both paths share this guard so they can never
// diverge again. `undefined` means "no timeout": callers degrade to the
// browser's own socket timeout rather than losing the request entirely.
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined
}
