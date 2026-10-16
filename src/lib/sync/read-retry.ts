// Bounded retry for idempotent sync-worker reads (AQU-775, AQU-1248).
//
// A projection read can recover on its own from a dropped connection, a
// timeout, or a worker that is briefly overloaded. It cannot recover from a
// refused token or a missing route, so those fail on the first attempt. Each
// caller owns its error class and its backoff; this module owns which
// failures are worth another attempt and the loop itself.

/** HTTP statuses that can succeed on a later attempt: request timeout, too
 *  early, rate limited, and any 5xx. 401/403 and every other 4xx are
 *  deterministic and fail immediately. */
export function isTransientReadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** The request never got an answer. Browser fetch rejects with TypeError for
 *  transport and CORS failures (a worker that dies without CORS headers looks
 *  the same as one that is unreachable); AbortError/TimeoutError are the
 *  `timeoutSignal` watchdog firing. */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
}

/**
 * Run `read`, and again after each of `delaysMs` while it keeps failing with
 * an error `isTransient` accepts: `delaysMs.length + 1` attempts in all. The
 * last error is rethrown unchanged. `read` must build its request (and its
 * timeout signal) per call, so every attempt gets a fresh deadline.
 */
export async function retryTransientRead<T>(
  read: () => Promise<T>,
  isTransient: (error: unknown) => boolean,
  delaysMs: readonly number[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransient(error)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}
