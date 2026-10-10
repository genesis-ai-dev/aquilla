// Request-scoped background-work tracking, so the per-request Postgres
// connection outlives the work that runs AFTER the response (AQU-1835).
//
// index.ts opens one Postgres connection per request and releases it in a
// `finally` as soon as the Response is returned. Several routes, though, hand
// post-response work to `ctx.waitUntil` and keep querying on the request's
// handle: the events route fires comment/@mention notification emails
// (notification-email.ts) and the linked-project notify (events/link-notify.ts)
// that way, and the import routes do the same. postgres.js rejects every query
// issued after `end()`, so whether that work reached the database at all came
// down to whether it won a race against the close — and when it lost, the only
// trace was a `console.warn`: a mention email silently never sent, a downstream
// linked project silently never notified.
//
// The fix keeps the connection alive for exactly as long as the work it serves.
// `trackBackgroundWork` wraps the request's ExecutionContext so every
// `ctx.waitUntil` registration is recorded as well as forwarded, and
// `closeWhenSettled` releases the connection once those promises have settled.
// Routes are unchanged — they keep firing `ctx.waitUntil` and keep using
// `env.AQUILLA_PG`.
//
// auth-worker solves the same hazard the other way round, per job: AQU-1763's
// knowledge indexer and the contextual/chat/agent streaming routes each open
// their OWN connection from `PG_CONNECTION_STRING` because they outlive the
// response by minutes. This tracking approach suits sync-worker, whose
// post-response work is short (an email send, one notify fetch) and spread
// across many routes that all share the request handle.

/** Drain passes allowed before giving up and closing anyway. Background work
 *  may itself register more background work, so one `allSettled` is not
 *  enough; a cap keeps a pathological chain from holding the pool open. */
const MAX_DRAIN_PASSES = 20

/** Watchdog for the drain. Comfortably longer than any post-response work in
 *  this worker (an EMAIL.send, one notify fetch) and shorter than the
 *  runtime's own `waitUntil` budget, so a hung promise still ends with a
 *  logged close rather than a leaked connection. Not a correctness deadline:
 *  nothing here races it on a healthy stack. */
export const BACKGROUND_DRAIN_TIMEOUT_MS = 25_000

/** Anything holding a connection this module can release — the Postgres shim. */
export interface Closeable {
  close(): Promise<void>
}

export interface BackgroundWork {
  /** Pass this to routes instead of the raw context: its `waitUntil` records
   *  the promise as well as forwarding it to the runtime. */
  readonly ctx: ExecutionContext
  /** Release `closeable` once every recorded promise has settled. Never
   *  throws — a failed close is logged, like the bare `close()` it replaces. */
  closeWhenSettled(closeable: Closeable): Promise<void>
}

export function trackBackgroundWork(
  ctx: ExecutionContext,
  options: { timeoutMs?: number } = {},
): BackgroundWork {
  const pending: Promise<unknown>[] = []

  // A Proxy rather than a hand-built object: ExecutionContext carries members
  // beyond waitUntil (`props`, `passThroughOnException`, `abort`, …) and routes
  // or the runtime may use any of them. Methods are bound to the real context
  // so native implementations keep their own receiver.
  const tracked = new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") {
        return (promise: Promise<unknown>) => {
          // Record first: the drain below is what actually keeps the
          // connection alive, so a forward that fails must not lose the work.
          pending.push(promise)
          try {
            target.waitUntil(promise)
          } catch {
            // No real ExecutionContext (vitest harnesses), or a registration
            // the runtime refused because its window had closed. The promise is
            // already tracked, and `closeWhenSettled` — itself registered on
            // the real context — awaits it either way.
          }
        }
      }
      // `target`, never the proxy, as the receiver: ExecutionContext's members
      // are native, and a native accessor or method invoked with the proxy as
      // `this` throws "Illegal invocation".
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value
    },
  })

  /** Settle everything recorded so far, repeatedly, until nothing new is
   *  queued. Resolves true when the queue drained, false when it did not. */
  const drain = async (): Promise<boolean> => {
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
      const batch = pending.splice(0, pending.length)
      if (batch.length === 0) return true
      // allSettled: a rejected background promise is already reported by the
      // runtime's own waitUntil; it must not stop us closing the connection.
      await Promise.allSettled(batch)
    }
    return pending.length === 0
  }

  return {
    ctx: tracked,
    async closeWhenSettled(closeable: Closeable): Promise<void> {
      const timeoutMs = options.timeoutMs ?? BACKGROUND_DRAIN_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          drain().then((drained) => (drained ? ("drained" as const) : ("overflowed" as const))),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs)
          }),
        ])
        if (outcome !== "drained") {
          console.warn(
            `[background-work] post-response work had not settled (${outcome}) — releasing the Postgres connection anyway`,
          )
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        await closeable.close().catch((err: unknown) => {
          console.error("[background-work] releasing the Postgres connection failed:", err)
        })
      }
    },
  }
}
