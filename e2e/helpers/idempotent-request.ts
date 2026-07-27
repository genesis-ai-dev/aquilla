const DEFAULT_RETRY_DELAYS_MS = [200, 800] as const

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function waitForRetry(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface PostIdempotentJsonArgs {
  url: string
  headers: Record<string, string>
  body: unknown
  operation: string
  fetchImpl?: typeof fetch
  /** Unit-test override. The number of delays determines the retry count. */
  retryDelaysMs?: readonly number[]
}

/**
 * POST an idempotent E2E fixture request with the same transient-failure
 * contract as the production bulk importer. The serialized body is reused
 * byte-for-byte, so a response lost during a local worker reload cannot mint
 * different event ids or duplicate state.
 */
export async function postIdempotentJson({
  url,
  headers,
  body,
  operation,
  fetchImpl = fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}: PostIdempotentJsonArgs): Promise<void> {
  const serializedBody = JSON.stringify(body)
  const attempts = retryDelaysMs.length + 1
  let lastError: Error | undefined

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response | undefined
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: serializedBody,
      })
    } catch (error) {
      lastError = new Error(
        `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response) {
      if (response.ok) return
      const detail = await response.text().catch(() => "")
      lastError = new Error(
        `${operation} failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
      )
      if (!isTransientStatus(response.status)) throw lastError
    }

    if (attempt < retryDelaysMs.length) {
      await waitForRetry(retryDelaysMs[attempt])
    }
  }

  throw new Error(`${lastError?.message ?? `${operation} failed`} after ${attempts} attempts`)
}
