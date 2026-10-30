// One HTTP check against one target.

import type { Target } from "./config"

export interface ProbeResult {
  id: string
  ok: boolean
  /** HTTP status, when a response arrived. */
  status?: number
  latencyMs: number
  /** Why the check failed, short enough for a Discord field. */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000
/** Bodies past this size are not searched; health routes are tiny. */
const MAX_BODY_CHARS = 64_000

export async function probe(
  target: Target,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const started = now()
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const elapsed = () => now() - started
  try {
    const response = await fetchImpl(target.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "aquilla-monitor/1", "Cache-Control": "no-cache" },
    })
    const expectStatus = target.expectStatus ?? 200
    if (response.status !== expectStatus) {
      await response.body?.cancel()
      return { id: target.id, ok: false, status: response.status, latencyMs: elapsed(), error: `HTTP ${response.status} (expected ${expectStatus})` }
    }
    if (target.expectBodyIncludes !== undefined) {
      const body = (await response.text()).slice(0, MAX_BODY_CHARS)
      if (!body.includes(target.expectBodyIncludes)) {
        return { id: target.id, ok: false, status: response.status, latencyMs: elapsed(), error: `body is missing ${JSON.stringify(target.expectBodyIncludes)}` }
      }
    } else {
      await response.body?.cancel()
    }
    return { id: target.id, ok: true, status: response.status, latencyMs: elapsed() }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    const message = timedOut
      ? `no response in ${Math.round(timeoutMs / 1000)}s`
      : error instanceof Error ? error.message : String(error)
    return { id: target.id, ok: false, latencyMs: elapsed(), error: message.slice(0, 200) }
  }
}
