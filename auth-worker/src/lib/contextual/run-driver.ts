// AQU-1845 — the handshake between a route and a run's Durable Object driver.
//
// Kept apart from both the route module and the DO class so the two sides of
// the handshake share one definition of the job, and so neither has to be
// loaded to exercise the other.

/** The job an alarm picks a run back up from. Deliberately minimal —
 *  everything else about the run is read from Postgres, which is the only
 *  authority on its cursor, status and staged drafts. */
export interface ContextualDriverJob {
  projectId: string
  runId: string
  /** Per-file wave width the kicking route resolved, when it narrowed it. */
  concurrency?: number
  /** Waves this object has already driven for this job, so the total ceiling
   *  below survives the alarm invocations it is spread across. Absent on a
   *  fresh kick — a person explicitly continuing a run starts the count
   *  again, which is the whole point of the park the ceiling produces. */
  wavesDriven?: number
}

/** Waves one alarm invocation drives before re-arming. Bounded so each
 *  invocation holds a Postgres connection for a bounded time (AQU-1835) and so
 *  a crash costs one short invocation's progress, not an hour's. Re-arming is
 *  immediate, so this is not a throughput limit. */
export const WAVES_PER_ALARM = 5

/**
 * Waves one kick may drive in total, across every alarm invocation it spreads
 * over, before the run PARKS instead of re-arming.
 *
 * The point of the object is that a run is not cut off by someone else's
 * budget — but "re-arm until the run says stop" would also re-arm forever if
 * a run ever managed to continue without making progress, and an Autopilot
 * wave costs real money. So the ceiling stays, moved from per-invocation
 * (where it cut healthy runs short) to per-kick, and generous enough that a
 * whole book finishes inside it: at the six-span maximum this is several
 * thousand spans. Reaching it parks the run as `awaiting_input` — the state
 * that surfaces Continue — rather than ending it, so nothing is lost and a
 * person decides whether to carry on.
 */
export const MAX_WAVES_PER_KICK = 500

/** The DO's only route. Absolute because `fetch` on a stub needs a URL; the
 *  host is never resolved. */
export const DRIVE_URL = "https://contextual-run-driver.invalid/drive"

export function parseContextualDriverJob(body: unknown): ContextualDriverJob | null {
  if (typeof body !== "object" || body === null) return null
  const { projectId, runId, concurrency } = body as Record<string, unknown>
  if (typeof projectId !== "string" || projectId === "") return null
  if (typeof runId !== "string" || runId === "") return null
  if (
    concurrency !== undefined &&
    (typeof concurrency !== "number" || !Number.isFinite(concurrency) || concurrency < 1)
  ) {
    return null
  }
  return {
    projectId,
    runId,
    ...(typeof concurrency === "number" ? { concurrency: Math.floor(concurrency) } : {}),
  }
}

/**
 * Ask the per-run Durable Object to drive this run, or return null when there
 * is no binding to ask.
 *
 * One object per RUN: the runtime runs at most one alarm per object at a time,
 * so naming the object after the run is what makes "exactly one driver per
 * run" true — a guarantee the `waitUntil` driver never had. The handshake is
 * deliberately tiny (store the job, arm the alarm, 202) so it never delays the
 * response that is kicking it.
 *
 * Naming the object after the run also makes the kick idempotent: a cron sweep
 * that adopts a run its object is already driving reaches that same object,
 * which sees itself driving and does not start again.
 *
 * A failed handshake is NOT fatal, and must not become a second driver: the
 * run row is already `running` with a fresh heartbeat, so the 5-minute cron
 * sweep adopts it exactly as it adopts a run whose driver died. Starting the
 * in-request loop as a "fallback" here would instead race the object we may
 * well have armed.
 */
export function kickRunDriver(
  env: { CONTEXTUAL_RUN_DRIVER?: DurableObjectNamespace },
  projectId: string,
  runId: string,
  concurrency?: number,
): Promise<void> | null {
  const namespace = env.CONTEXTUAL_RUN_DRIVER
  if (!namespace) return null
  const job: ContextualDriverJob = {
    projectId,
    runId,
    ...(concurrency !== undefined ? { concurrency } : {}),
  }
  return (async () => {
    try {
      const stub = namespace.get(namespace.idFromName(runId))
      const response = await stub.fetch(DRIVE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(job),
      })
      if (!response.ok) {
        console.warn(
          `[contextual] run driver refused run ${runId}: ${response.status} — leaving it to the cron sweep`,
        )
      }
    } catch (err) {
      console.warn(`[contextual] run driver kick failed for run ${runId}:`, err)
    }
  })()
}
