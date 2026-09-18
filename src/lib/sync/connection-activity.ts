// Passive, tab-local sync telemetry. No probes, retained payloads, or timers.
// Rates are recent application payload activity, not available link bandwidth.
const WINDOW_MS = 5_000
const HISTORY_MS = 5 * 60_000
const LATENCY_MAX_AGE_MS = 30_000
const encoder = new TextEncoder()
interface ActivityBucket {
  upload: number
  download: number
  requests: number
  failures: number
  replies: number
  replyMs: number
  slowestMs: number
}
// One aggregate per second bounds memory even during heavy sync activity.
const buckets = new Map<number, ActivityBucket>()
let responseTime: { ms: number; at: number } | null = null

function currentBucket(now: number): ActivityBucket {
  prune(now)
  const second = Math.floor(now / 1000)
  let bucket = buckets.get(second)
  if (!bucket) {
    bucket = { upload: 0, download: 0, requests: 0, failures: 0, replies: 0, replyMs: 0, slowestMs: 0 }
    buckets.set(second, bucket)
  }
  return bucket
}

function prune(now: number) {
  for (const second of buckets.keys()) {
    if (second <= Math.floor((now - HISTORY_MS) / 1000)) buckets.delete(second)
  }
}

export function recordSyncBytes(direction: "upload" | "download", payload: string) {
  currentBucket(performance.now())[direction] += encoder.encode(payload).byteLength
}

export function getConnectionActivity() {
  const now = performance.now()
  prune(now)
  let upload = 0
  let download = 0
  const recent: ActivityBucket = { upload: 0, download: 0, requests: 0, failures: 0, replies: 0, replyMs: 0, slowestMs: 0 }
  for (const [second, bytes] of buckets) {
    if (second > Math.floor((now - WINDOW_MS) / 1000)) {
      upload += bytes.upload
      download += bytes.download
    }
    recent.upload += bytes.upload
    recent.download += bytes.download
    recent.requests += bytes.requests
    recent.failures += bytes.failures
    recent.replies += bytes.replies
    recent.replyMs += bytes.replyMs
    recent.slowestMs = Math.max(recent.slowestMs, bytes.slowestMs)
  }
  return {
    upload: upload / (WINDOW_MS / 1000),
    download: download / (WINDOW_MS / 1000),
    latency: responseTime && now - responseTime.at < LATENCY_MAX_AGE_MS
      ? responseTime.ms : null,
    lastReplyAgeMs: responseTime ? Math.max(0, now - responseTime.at) : null,
    recent: {
      upload: recent.upload,
      download: recent.download,
      requests: recent.requests,
      failures: recent.failures,
      averageLatency: recent.replies ? recent.replyMs / recent.replies : null,
      slowestLatency: recent.replies ? recent.slowestMs : null,
    },
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
  let response: Response
  try {
    response = await fetchFn(input, init)
  } catch (error) {
    // Intentional navigation/caller cancellation isn't a connection failure.
    if (!(error instanceof Error && error.name === "AbortError")) {
      const bucket = currentBucket(performance.now())
      bucket.requests++
      bucket.failures++
    }
    throw error
  }
  const at = performance.now()
  const ms = Math.max(0, at - started)
  responseTime = { ms, at }
  const bucket = currentBucket(at)
  bucket.requests++
  if (!response.ok) bucket.failures++
  bucket.replies++
  bucket.replyMs += ms
  bucket.slowestMs = Math.max(bucket.slowestMs, ms)
  if (typeof init?.body === "string") recordSyncBytes("upload", init.body)
  return response
}

/** Count the JSON payload already being consumed, without cloning responses. */
export async function readSyncJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  recordSyncBytes("download", text)
  return JSON.parse(text) as T
}
