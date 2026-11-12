/**
 * Per-document knowledge-base indexing driver — AQU-2051.
 *
 * Before this, indexing was driven by `executionCtx.waitUntil` on the request
 * that uploaded (or reindexed) the document. Workers extend `waitUntil` only
 * ~30 s past the response, so summarizing a document of any real size was cut
 * off mid-flight: AQU-2050 found `Art of Survival_Arabic_clean.docx` (60,805
 * characters of Arabic) stuck at `pending` forever on dev, while two 1.9 MB
 * uploads that happened to finish in 24 s landed fine. AQU-2050 made each run
 * land safely inside the window and made "Try indexing again" resume from
 * where the last one stopped — which turned an unbounded document into a human
 * pressing a button once per 30 s of work. This removes the ceiling itself.
 *
 * A Durable Object alarm has none of that budget: it is its own invocation, and
 * the runtime runs at most one alarm per object at a time — which, with one
 * object per DOCUMENT (`idFromName(docId)`), is exactly the "one job per
 * document" guarantee the `waitUntil` driver never had. AQU-1845 took the
 * Autopilot run driver off `waitUntil` the same way; this follows it.
 *
 * Holds NO authoritative state: the document's text, tree, status and error
 * reason all live in Postgres, so a lost object, an evicted object or a
 * redeploy costs at most the run in flight, which the read-side staleness
 * window (src/lib/frontier/knowledge-base.ts) already surfaces as a retry.
 * DO storage carries only the job handle the alarm needs to pick the document
 * up.
 *
 * What does NOT change: the job still owns its own Postgres connection
 * (AQU-1763), still lands provider failures as "Indexed without summaries"
 * with a reason (AQU-2002), and still batches large documents (AQU-2029). Only
 * where it executes, how it is triggered, and — because the window it was
 * derived from no longer applies — the budget it is given (see
 * `KB_DRIVER_BUDGET_MS`) moved.
 */

import { DurableObject } from "cloudflare:workers"
import { makePostgres, type AquillaDb } from "../../db/shim/postgres"
import { withStoreSecrets } from "../../db/shared/secrets-store-overlay"
import { indexKnowledgeDoc } from "./lib/knowledge/index-doc"
import {
  KB_DRIVER_BUDGET_MS,
  parseKnowledgeIndexJob,
  startIndexHeartbeat,
  type KnowledgeIndexJob,
} from "./lib/knowledge/index-driver"
import type { Env } from "./types"

const JOB_KEY = "job"

export class KnowledgeIndexDriver extends DurableObject<Env> {
  /** True while `alarm()` is inside the indexing job. A kick that lands then
   *  is a second request for work already in flight (a double-clicked retry, a
   *  replayed request, two agents reindexing the same document) — it must not
   *  arm a second alarm, because the point of the object is that one document
   *  has one job. */
  private driving = false

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/drive") {
      return new Response("not found", { status: 404 })
    }
    let parsed: unknown
    try {
      parsed = await request.json()
    } catch {
      return new Response("invalid json", { status: 400 })
    }
    const job = parseKnowledgeIndexJob(parsed)
    if (!job) return new Response("invalid job", { status: 400 })

    // Already working this document: the running job will index the row as it
    // now stands, so there is nothing a second pass would add.
    if (this.driving) return new Response(null, { status: 202 })

    await this.ctx.storage.put(JOB_KEY, job)
    await this.ctx.storage.setAlarm(Date.now())
    return new Response(null, { status: 202 })
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<KnowledgeIndexJob>(JOB_KEY)
    if (!job) return

    // Forget the job BEFORE the work starts. The runtime retries an alarm that
    // throws, and a retry that re-ran a job already past its model calls would
    // pay for every summary a second time. Everything that can actually fail
    // inside `indexKnowledgeDoc` it handles itself, landing a terminal row with
    // a reason; a retry would add nothing but cost.
    await this.ctx.storage.delete(JOB_KEY)

    const connectionString = this.env.HYPERDRIVE?.connectionString
    if (!connectionString) {
      // A config error, not a transient one: retrying the alarm would just burn
      // the retry budget, and with no connection there is nothing to write a
      // reason onto either. The row stays `pending` and the read-side stale
      // window gives its owner the retry, exactly as before this driver.
      console.error(
        `[knowledge driver] HYPERDRIVE not bound — cannot index doc ${job.docId}`,
      )
      return
    }

    // Same shape the fetch wrapper builds (src/index.ts): one shim for this
    // invocation, which this handler owns and closes. HYPERDRIVE is dropped and
    // PG_CONNECTION_STRING set so anything downstream that opens its own
    // connection finds the string rather than the binding.
    const shim = makePostgres(connectionString)
    const db = shim as unknown as AquillaDb
    const driverEnv: Env = {
      // Secrets Store values (SS_<NAME> bindings) win over Worker secrets —
      // the model call needs the OpenRouter key off this overlay.
      ...(await withStoreSecrets(this.env)),
      AQUILLA_PG: db,
      HYPERDRIVE: undefined,
      PG_CONNECTION_STRING: connectionString,
    }

    // The driver owns liveness while it works, so a long but healthy run never
    // looks stalled to the page (and never offers a retry that would double the
    // model spend). See KB_DRIVER_HEARTBEAT_MS.
    const heartbeat = startIndexHeartbeat(db, job.docId)
    this.driving = true
    try {
      // The budget MUST be the driver's. `indexKnowledgeDoc` defaults to
      // `KB_INDEX_BUDGET_MS`, which AQU-2050 derived from the 30 s `waitUntil`
      // window — a window that does not apply here. Leaving the default would
      // keep the ~24 s ceiling this ticket exists to lift, and the document
      // would still come back "Summaries are missing for N of M sections".
      await indexKnowledgeDoc(driverEnv, db, job.docId, { timeoutMs: KB_DRIVER_BUDGET_MS })
    } catch (err) {
      // indexKnowledgeDoc settles the row itself and does not throw; anything
      // that escapes is a driver bug. Do not rethrow — an alarm that throws is
      // retried, and a retry would re-enter the same bug at full model price.
      console.error(`[knowledge driver] doc ${job.docId} driver threw:`, err)
    } finally {
      this.driving = false
      heartbeat.stop()
      await heartbeat.done
      try {
        await shim.close()
      } catch {
        /* already closed */
      }
    }
  }
}
