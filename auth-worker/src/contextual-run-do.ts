/**
 * Per-run Autopilot driver — AQU-1845.
 *
 * Before this, a run was driven by `executionCtx.waitUntil` on the request
 * that started it. Workers extend `waitUntil` only ~30 s past the response, so
 * a run of any size was cut off after its first wave or two and left for the
 * 5-minute cron to re-adopt — at most 10 runs a sweep, which made ~10 runs per
 * 5 minutes the platform-wide ceiling no matter how much provider capacity was
 * free. The calls the killed wave had already made were paid for and thrown
 * away.
 *
 * A Durable Object alarm has none of that budget: it is its own invocation, it
 * can re-arm itself indefinitely, and the runtime runs at most one alarm per
 * object at a time — which is exactly the "one driver per run" guarantee the
 * waitUntil driver never had. One object per RUN (`idFromName(runId)`), so ten
 * projects starting at once get ten independent drivers and no one waits for
 * the cron; total model concurrency stays bounded where it already was, by the
 * durable project lease that each wave acquires.
 *
 * Holds NO authoritative state: every run's cursor, status and staged drafts
 * live in Postgres, so a lost object, an evicted object or a redeploy costs at
 * most the wave in flight — and with the per-call checkpoint
 * (lib/contextual/checkpoint.ts) not even that wave's finished model calls.
 * DO storage carries only the job handle the alarm needs to pick the run back
 * up.
 *
 * The cron sweep (`sweepStrandedContextualRuns`) stays exactly as it was. It
 * is now the safety net it was always described as — for a run whose object
 * died between waves, or one started before this driver existed — rather than
 * the main driver.
 */

import { DurableObject } from "cloudflare:workers"
import { makePostgres } from "../../db/shim/postgres"
import type { AquillaDb } from "../../db/shim/postgres"
import { selfTickLoop } from "./routes/contextual"
import {
  MAX_WAVES_PER_KICK,
  parseContextualDriverJob,
  WAVES_PER_ALARM,
  type ContextualDriverJob,
} from "./lib/contextual/run-driver"
import type { Env } from "./types"

const JOB_KEY = "job"

export class ContextualRunDriver extends DurableObject<Env> {
  /** True while `alarm()` is inside the wave loop. A kick that lands then does
   *  not need to re-arm: the running loop re-arms itself when it still has
   *  work, and overwriting the alarm time from outside would only schedule a
   *  redundant invocation that finds nothing to do. */
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
    const job = parseContextualDriverJob(parsed)
    if (!job) return new Response("invalid job", { status: 400 })

    await this.ctx.storage.put(JOB_KEY, job)
    if (!this.driving) await this.ctx.storage.setAlarm(Date.now())
    return new Response(null, { status: 202 })
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<ContextualDriverJob>(JOB_KEY)
    if (!job) return

    const connectionString = this.env.HYPERDRIVE?.connectionString
    if (!connectionString) {
      // A config error, not a transient one: retrying the alarm would just
      // burn the retry budget. The cron sweep still has the run.
      console.error(`[contextual driver] HYPERDRIVE not bound — cannot drive run ${job.runId}`)
      await this.ctx.storage.delete(JOB_KEY)
      return
    }

    // Same shape the cron builds (src/index.ts `scheduled`): one shim for this
    // invocation, handed to the loop as AQUILLA_PG so the loop borrows it and
    // this handler owns closing it.
    const shim = makePostgres(connectionString)
    const driverEnv: Env = {
      ...this.env,
      AQUILLA_PG: shim as unknown as AquillaDb,
      HYPERDRIVE: undefined,
    }

    // The per-invocation budget, clipped by what is left of this kick's total
    // ceiling. On the last batch the re-arm hook is withheld deliberately, so
    // selfTickLoop takes its own park path and the run ends as `awaiting_input`
    // with a Continue rather than silently stopping.
    const alreadyDriven = job.wavesDriven ?? 0
    const remaining = Math.max(0, MAX_WAVES_PER_KICK - alreadyDriven)
    const maxWaves = Math.min(WAVES_PER_ALARM, remaining)
    if (maxWaves === 0) {
      // Defensive: the ceiling is applied before re-arming, so a job should
      // never reach an alarm with nothing left.
      await this.ctx.storage.delete(JOB_KEY)
      try {
        await shim.close()
      } catch {
        /* already closed */
      }
      return
    }

    this.driving = true
    let moreWork = false
    try {
      await selfTickLoop(driverEnv, job.projectId, job.runId, job.concurrency, {
        maxWaves,
        // The wave budget is this invocation's, not the run's: hand the rest
        // to the next alarm instead of parking a run that still has spans.
        ...(remaining > maxWaves
          ? {
              onWaveBudgetExhausted: async () => {
                moreWork = true
                return true
              },
            }
          : {}),
      })
    } catch (err) {
      // selfTickLoop settles the run itself and does not throw; anything that
      // escapes is a driver bug. Do not rethrow — an alarm that throws is
      // retried, and a retry would re-enter the same bug.
      console.error(`[contextual driver] run ${job.runId} driver threw:`, err)
    } finally {
      this.driving = false
      try {
        await shim.close()
      } catch {
        /* already closed */
      }
    }

    if (moreWork) {
      await this.ctx.storage.put(JOB_KEY, {
        ...job,
        wavesDriven: alreadyDriven + maxWaves,
      } satisfies ContextualDriverJob)
      // Immediately: the point of the object is that there is no 30-second
      // cliff and no five-minute wait between waves.
      await this.ctx.storage.setAlarm(Date.now())
    } else {
      await this.ctx.storage.delete(JOB_KEY)
    }
  }
}
