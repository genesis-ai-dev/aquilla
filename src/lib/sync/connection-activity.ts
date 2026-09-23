// Passive, tab-local sync telemetry. No probes, retained payloads, or timers.
// Rates are recent application payload activity, not available link bandwidth.
// Everything shown as "now" is the average of the last three signals (three
// one-second buckets for traffic, three replies for ping) so a single spike
// cannot flip what the user sees.
const SIGNALS = 3
const WINDOW_MS = SIGNALS * 1000
const HISTORY_MS = 5 * 60_000
const LATENCY_MAX_AGE_MS = 30_000
// Keep showing the last real rate for a moment after traffic stops, so a burst
// of saves reads as a speed rather than a flicker back to Idle.
const RATE_LINGER_MS = 10_000
const LATENCY_SAMPLES = SIGNALS
// Bands are what a user acts on; the number is a detail. Boundaries are far
// apart so ordinary jitter does not flip the label.
export const LATENCY_FAIR_MS = 300
export const LATENCY_SLOW_MS = 1_000
export type ConnectionQuality = "good" | "fair" | "slow"
const encoder = new TextEncoder()
const collectionStartedAt = performance.now()

export interface ConnectionHistoryPoint {
  upload: number | null
  download: number | null
  latency: number | null
}
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
// Last three replies: the "now" ping is their mean; slowestMs keeps the tail.
let replies: { ms: number; at: number }[] = []
const lastRate = { upload: { value: 0, at: 0 }, download: { value: 0, at: 0 } }

function lingering(direction: "upload" | "download", rate: number, now: number): number {
  if (rate > 0) {
    lastRate[direction] = { value: rate, at: now }
    return rate
  }
  const last = lastRate[direction]
  return last.value > 0 && now - last.at < RATE_LINGER_MS ? last.value : 0
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

export function qualityFor(latency: number | null): ConnectionQuality | null {
  if (latency == null) return null
  return latency < LATENCY_FAIR_MS ? "good" : latency < LATENCY_SLOW_MS ? "fair" : "slow"
}

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
  const firstSecond = Math.floor(now / 1000) - 299
  const historyBuckets = Array.from({ length: 60 }, () => ({ upload: 0, download: 0, replies: 0, replyMs: 0 }))
  const recent: ActivityBucket = { upload: 0, download: 0, requests: 0, failures: 0, replies: 0, replyMs: 0, slowestMs: 0 }
  for (const [second, bytes] of buckets) {
    if (second > Math.floor((now - WINDOW_MS) / 1000)) {
      upload += bytes.upload
      download += bytes.download
    }
    const point = historyBuckets[Math.floor((second - firstSecond) / 5)]
    point.upload += bytes.upload
    point.download += bytes.download
    point.replies += bytes.replies
    point.replyMs += bytes.replyMs
    recent.upload += bytes.upload
    recent.download += bytes.download
    recent.requests += bytes.requests
    recent.failures += bytes.failures
    recent.replies += bytes.replies
    recent.replyMs += bytes.replyMs
    recent.slowestMs = Math.max(recent.slowestMs, bytes.slowestMs)
  }
  const history: ConnectionHistoryPoint[] = historyBuckets.map((point, index) => {
    // Blank before this tab started collecting; missing replies are never 0 ms.
    const observed = (firstSecond + (index + 1) * 5) * 1000 > collectionStartedAt
    return {
      upload: observed ? point.upload / 5 : null,
      download: observed ? point.download / 5 : null,
      latency: point.replies ? point.replyMs / point.replies : null,
    }
  })
  const fresh = replies.filter(reply => now - reply.at < LATENCY_MAX_AGE_MS).map(reply => reply.ms)
  const latency = fresh.length ? mean(fresh) : null
  const lastReply = replies.at(-1)
  return {
    history,
    upload: lingering("upload", upload / (WINDOW_MS / 1000), now),
    download: lingering("download", download / (WINDOW_MS / 1000), now),
    latency,
    quality: qualityFor(latency),
    lastReplyAgeMs: lastReply ? Math.max(0, now - lastReply.at) : null,
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
  replies = [...replies.slice(-(LATENCY_SAMPLES - 1)), { ms, at }]
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
