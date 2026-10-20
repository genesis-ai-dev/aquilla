// AQU-2051 — the handshake between a knowledge-base route and the per-document
// Durable Object that indexes it, plus the liveness heartbeat that object runs
// while the job works.
//
// Kept apart from both the route module and the DO class so the two sides of
// the handshake share one definition of the job, and so neither has to be
// loaded to exercise the other — routes/knowledge.ts is the whole Hono app,
// and the DO must not pull that in.
//
// WHY the object exists: indexing used to run on the uploading request's
// `executionCtx.waitUntil`, which the platform cuts off ~30 s after the
// response. AQU-2050 made each run land safely inside that window and made
// "Try indexing again" resume where the last one stopped, so a long document
// still needed a human pressing the button once per 30 s of work. A Durable
// Object alarm has no such budget: it is its own invocation, so one run
// summarizes a document of any size (AQU-1845 took the Autopilot driver off
// `waitUntil` for exactly this reason, and this follows that pattern).

import type { AquillaDb } from "../../../../db/shim/postgres"

/** The job an alarm picks a document back up from. Deliberately minimal —
 *  everything else about the document (its text, its tree, its status) is read
 *  from Postgres, which is the only authority on it. */
export interface KnowledgeIndexJob {
  docId: string
}

/** The DO's only route. Absolute because `fetch` on a stub needs a URL; the
 *  host is never resolved. */
export const KB_DRIVE_URL = "https://knowledge-index-driver.invalid/drive"

/** How often the driver touches `updated_at` on the row it is working.
 *
 *  The read side calls a `pending` document stalled once `updated_at` is older
 *  than `KB_INDEX_STALE_MS` (5 min, src/lib/frontier/knowledge-base.ts) and
 *  offers a retry. That window was sized against a request-hosted job, which
 *  AQU-2050 capped at `KB_INDEX_BUDGET_MS` — so no honest job could still be
 *  running. Under this driver one can, for as long as `KB_DRIVER_BUDGET_MS`
 *  allows. Without a heartbeat the page would say "Indexing stalled" over a job
 *  that is in fact working, and the retry it offers would start a second job
 *  and pay for the same summaries twice.
 *
 *  So the driver — not the job — owns liveness: while it is working the row
 *  looks fresh, and the instant the driver dies the row goes stale on the old
 *  schedule and the retry comes back. That is what keeps the two windows in
 *  step, rather than widening the read-side window and making a genuinely dead
 *  job take longer to notice. */
export const KB_DRIVER_HEARTBEAT_MS = 60_000

/** The whole-job budget when the DRIVER hosts the job, replacing the
 *  request-hosted `KB_INDEX_BUDGET_MS` that AQU-2050 derived from the
 *  platform's 30 s `waitUntil` window.
 *
 *  This is the ceiling AQU-2051 exists to lift, so passing it is not a detail:
 *  left on the request-hosted budget the job would still abort around 24 s and
 *  still report "Summaries are missing for N of M sections", and moving the job
 *  to an alarm would have bought nothing. An alarm has no such window, so the
 *  budget is sized for the work instead — the largest document the uploader
 *  accepts, batched at `KB_ENRICH_BATCH_CHARS`, is minutes of model time.
 *
 *  It stays the *bounded* budget AQU-1376 requires: a hung upstream still has
 *  something to abort it, so the row can never be left `pending` for good. And
 *  it sits below `KB_DRIVER_MAX_MS` with room for the terminal write, so the
 *  heartbeat always outlives the job it vouches for. */
export const KB_DRIVER_BUDGET_MS = 15 * 60_000

/** How long the driver will keep a row looking alive.
 *
 *  A stall watchdog, not a work budget: the job is never interrupted, the
 *  heartbeat just stops claiming liveness it can no longer vouch for, which
 *  hands the document back to the read-side stale window and its retry. Above
 *  `KB_DRIVER_BUDGET_MS` by more than the terminal write needs, so it never
 *  fires on an honest run. */
export const KB_DRIVER_MAX_MS = 20 * 60_000

export function parseKnowledgeIndexJob(body: unknown): KnowledgeIndexJob | null {
  if (typeof body !== "object" || body === null) return null
  const { docId } = body as Record<string, unknown>
  if (typeof docId !== "string" || docId === "") return null
  return { docId }
}

/**
 * Ask the per-document Durable Object to index this document, or return null
 * when there is no binding to ask — the caller then keeps today's
 * `waitUntil` path (the vitest harness and any deploy without the binding).
 *
 * One object per DOCUMENT (`idFromName(docId)`): the runtime runs at most one
 * alarm per object at a time, so naming the object after the document is what
 * makes "one job per document" true. Two uploads of the same document, a
 * double-clicked retry, or two agents reindexing at once reach the same object,
 * which is already driving and does not start again.
 *
 * A failed handshake is NOT retried in-request and must NOT become a second
 * driver: the fetch may well have armed the alarm before it failed, and a local
 * fallback would then race it and pay for every summary twice. The row stays
 * `pending`, goes stale on the read side's schedule, and the owner gets the
 * retry button exactly as they do for a job whose driver died.
 */
export function kickKnowledgeIndexDriver(
  env: { KNOWLEDGE_INDEX_DRIVER?: DurableObjectNamespace },
  docId: string,
): Promise<void> | null {
  const namespace = env.KNOWLEDGE_INDEX_DRIVER
  if (!namespace) return null
  const job: KnowledgeIndexJob = { docId }
  return (async () => {
    try {
      const stub = namespace.get(namespace.idFromName(docId))
      const response = await stub.fetch(KB_DRIVE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(job),
      })
      if (!response.ok) {
        console.warn(
          `[knowledge] index driver refused doc ${docId}: ${response.status} — leaving it to the read-side retry`,
        )
      }
    } catch (err) {
      console.warn(`[knowledge] index driver kick failed for doc ${docId}:`, err)
    }
  })()
}

/** Mark the row as still being worked. Scoped to `pending` so it can never
 *  touch a document the job has already settled, or one a later upload has
 *  replaced. */
export async function touchIndexingDoc(db: AquillaDb, docId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE knowledge_docs
          SET updated_at = now()
        WHERE id = ?
          AND index_status = 'pending'`,
    )
    .bind(docId)
    .run()
}

export interface IndexHeartbeat {
  /** Stop beating. The job is not affected, and the wait between beats is cut
   *  short, so `done` settles at once rather than an interval later. */
  stop(): void
  /** Resolves when the loop has stopped. Always await it before closing the
   *  connection the beats run on. */
  readonly done: Promise<void>
}

/** Sleep that a `stop()` can cut short. Without the abort the driver would hold
 *  its invocation — and its Postgres connection — open for up to one interval
 *  after the job it was vouching for had already finished. */
const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    // `settle` closes over `timer`, which is assigned on this same synchronous
    // tick — it can only ever run from the timer or the abort event, both later.
    const settle = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal.addEventListener("abort", settle, { once: true })
  })

/**
 * Keep `updated_at` fresh on a `pending` document for as long as the driver is
 * working it (see `KB_DRIVER_HEARTBEAT_MS`).
 *
 * Beats are best-effort: a failed touch is logged and the loop carries on. A
 * heartbeat that threw would otherwise take down a job that is making progress,
 * and missing one beat costs nothing — the next one restores the window.
 *
 * `sleep` and `now` are injectable so a test can drive the loop without
 * waiting on real time.
 */
export function startIndexHeartbeat(
  db: AquillaDb,
  docId: string,
  {
    intervalMs = KB_DRIVER_HEARTBEAT_MS,
    ceilingMs = KB_DRIVER_MAX_MS,
    sleep = realSleep,
    now = Date.now,
  }: {
    intervalMs?: number
    ceilingMs?: number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    now?: () => number
  } = {},
): IndexHeartbeat {
  const aborter = new AbortController()
  let stopped = false
  // Raced against each wait so `done` settles the moment `stop()` lands, even
  // where the injected sleep ignores the signal.
  let release: () => void = () => {}
  const stopping = new Promise<void>((resolve) => {
    release = resolve
  })
  const startedAt = now()
  const done = (async () => {
    while (!stopped && now() - startedAt < ceilingMs) {
      await Promise.race([sleep(intervalMs, aborter.signal), stopping])
      if (stopped) return
      try {
        await touchIndexingDoc(db, docId)
      } catch (err) {
        console.warn(`[knowledge] index heartbeat for doc ${docId} failed:`, err)
      }
    }
  })()
  return {
    stop() {
      stopped = true
      aborter.abort()
      release()
    },
    done,
  }
}
