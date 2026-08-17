/** Shared retry for Node-side e2e fetches against local wrangler workers.
 * Wrangler/workerd can drop a connection during a brief restart; a hard
 * ECONNREFUSED that lasts across all attempts means the process is gone. */

export const E2E_TRANSPORT_ATTEMPTS = 3

export function isRetryableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /socket hang up|ECONNRESET|ECONNREFUSED|fetch failed|HTTP 503|worker restarted/i.test(message)
}

export async function waitForTransportRetry(attempt: number): Promise<void> {
  // Worker restarts need more than a 100ms hop; keep this a stall watchdog,
  // not a correctness wait — the next attempt still observes a real response.
  await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
}

export async function withTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < E2E_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isRetryableTransportError(error) || attempt === E2E_TRANSPORT_ATTEMPTS - 1) {
        throw error
      }
      await waitForTransportRetry(attempt)
    }
  }
  throw lastError
}
