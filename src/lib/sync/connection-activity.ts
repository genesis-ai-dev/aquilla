// Passive, tab-local sync telemetry. No probes, retained payloads, or timers.
// Rates are recent application payload activity, not available link bandwidth.
const WINDOW_MS = 5_000
const LATENCY_MAX_AGE_MS = 30_000
const encoder = new TextEncoder()
const buckets = new Map<number, { upload: number; download: number }>()
let responseTime: { ms: number; at: number } | null = null

export function recordSyncBytes(direction: "upload" | "download", payload: string) {
  const now = performance.now()
  for (const second of buckets.keys()) {
    if (second <= Math.floor((now - WINDOW_MS) / 1000)) buckets.delete(second)
  }
  const second = Math.floor(now / 1000)
  const bucket = buckets.get(second) ?? { upload: 0, download: 0 }
  bucket[direction] += encoder.encode(payload).byteLength
  buckets.set(second, bucket)
}

export function getConnectionActivity() {
  const now = performance.now()
  let upload = 0
  let download = 0
  for (const [second, bytes] of buckets) {
    if (second > Math.floor((now - WINDOW_MS) / 1000)) {
      upload += bytes.upload
      download += bytes.download
    }
  }
  return {
    upload: upload / (WINDOW_MS / 1000),
    download: download / (WINDOW_MS / 1000),
    latency: responseTime && now - responseTime.at < LATENCY_MAX_AGE_MS
      ? responseTime.ms : null,
  }
}

/** Observe the existing request only. Failed transport attempts provide no
 * trustworthy byte count or response time. HTTP errors still measure a reply.
 * Fetch exposes request-to-headers time, including server processing, not ping. */
export async function observedSyncFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const started = performance.now()
  const response = await fetchFn(input, init)
  const at = performance.now()
  responseTime = { ms: Math.max(0, at - started), at }
  if (typeof init?.body === "string") recordSyncBytes("upload", init.body)
  return response
}

/** Count the JSON payload already being consumed, without cloning responses. */
export async function readSyncJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  recordSyncBytes("download", text)
  return JSON.parse(text) as T
}
