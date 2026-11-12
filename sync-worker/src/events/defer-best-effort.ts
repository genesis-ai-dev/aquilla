// AQU-1837: handing best-effort post-commit work off the response path.
//
// POST /events fans `event.applied` frames out to each project's ProjectSync
// DO. That fan-out is best-effort by design — a missed broadcast only means a
// peer reconciles on its next revalidate (see the `__broadcast` call site in
// route.ts). What it must never do is charge the AUTHOR for the DO's own
// queueing delay: a busy project DO (large presence room, link-sync fold)
// queues the `__broadcast` subrequest behind its own work, and awaiting it
// added that wait to every save in the project, up to the client's 15 s abort.

/**
 * How long `deferBestEffort` waits for the work when it has no
 * ExecutionContext to hand it to. Long enough for a healthy DO to answer,
 * short enough that a stalled one cannot dominate the response.
 */
export const DEFER_FALLBACK_TIMEOUT_MS = 500

/**
 * Let `work` finish without the caller waiting for it.
 *
 * With an ExecutionContext, the work is registered on `ctx.waitUntil` and the
 * caller returns immediately — the runtime keeps the request alive until it
 * settles. Without one (the external Agent-API engines pass `undefined`, as do
 * unit tests that call a route directly) awaiting is the only thing keeping
 * already-in-flight subrequests alive, so fall back to a BOUNDED await: the
 * work still gets a chance to finish, but a stalled peer costs the caller at
 * most `timeoutMs` rather than its full delay.
 *
 * Either way a rejection is swallowed and logged — this is for work whose
 * failure is non-fatal, and an unhandled rejection handed to `waitUntil`
 * would fail the request that already succeeded.
 */
export async function deferBestEffort(
  work: Promise<unknown>,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
  label = 'deferBestEffort',
  timeoutMs: number = DEFER_FALLBACK_TIMEOUT_MS,
): Promise<void> {
  const guarded = work.then(
    () => undefined,
    (err: unknown) => {
      console.warn(`[${label}] deferred work failed:`, err)
    },
  )

  if (ctx) {
    ctx.waitUntil(guarded)
    return
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      guarded,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
