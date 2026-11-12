// AQU-1835 — the per-request Postgres connection must outlive the work that
// index.ts fires into ctx.waitUntil (comment/@mention notification emails,
// linked-project notify, import notifies). Before this, index.ts closed the
// connection in its `finally` the moment the Response returned, so any query a
// background job issued after its first `await` raced `end()` and was rejected
// — reported only as a console.warn, so the email or notify silently vanished.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { trackBackgroundWork, BACKGROUND_DRAIN_TIMEOUT_MS, type Closeable } from "./background-work"

/** The half of ExecutionContext this module touches, plus the forwarded
 *  promises so a test can assert the runtime still hears about every one. */
function fakeContext() {
  const forwarded: Promise<unknown>[] = []
  let passedThrough = 0
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      forwarded.push(promise)
    },
    passThroughOnException() {
      passedThrough += 1
    },
    props: { tenant: "aquilla" },
  }
  return {
    ctx: ctx as unknown as ExecutionContext,
    forwarded,
    passedThroughCount: () => passedThrough,
  }
}

/** A connection handle that behaves like the postgres.js shim: once closed,
 *  every further query is rejected. This is the actual failure mode AQU-1835
 *  describes, so the regression test asserts against it rather than a flag. */
function fakeConnection() {
  let closed = false
  return {
    closed: () => closed,
    handle: {
      async close() {
        closed = true
      },
    } satisfies Closeable,
    async query(label: string) {
      if (closed) throw new Error(`write CONNECTION_ENDED (${label})`)
      return label
    },
  }
}

describe("trackBackgroundWork", () => {
  it("forwards waitUntil to the real context as well as recording it", async () => {
    const { ctx, forwarded } = fakeContext()
    const background = trackBackgroundWork(ctx)
    const work = Promise.resolve("done")

    background.ctx.waitUntil(work)

    expect(forwarded).toEqual([work])
    await background.closeWhenSettled(fakeConnection().handle)
  })

  it("still tracks work when the runtime refuses the registration", async () => {
    // The vitest harnesses have no real ExecutionContext, and the runtime
    // itself refuses a waitUntil whose window has closed. Either way the work
    // must still hold the connection open.
    const connection = fakeConnection()
    const refusing = {
      waitUntil() {
        throw new Error("The script will never generate a response.")
      },
    } as unknown as ExecutionContext
    const background = trackBackgroundWork(refusing)
    const observed: boolean[] = []

    expect(() =>
      background.ctx.waitUntil(
        (async () => {
          await Promise.resolve()
          observed.push(connection.closed())
        })(),
      ),
    ).not.toThrow()
    await background.closeWhenSettled(connection.handle)

    expect(observed).toEqual([false])
    expect(connection.closed()).toBe(true)
  })

  it("reads context members off the real context, not the proxy", () => {
    // Guards the Reflect.get receiver: ExecutionContext's members are native,
    // and a native accessor invoked with the proxy as `this` throws.
    const receivers: unknown[] = []
    const real = {
      waitUntil() {},
      get props() {
        receivers.push(this)
        return { tenant: "aquilla" }
      },
    }
    const background = trackBackgroundWork(real as unknown as ExecutionContext)

    const props = (background.ctx as unknown as { props: { tenant: string } }).props

    expect(props.tenant).toBe("aquilla")
    expect(receivers).toEqual([real])
  })

  it("passes through the rest of the ExecutionContext surface", () => {
    const { ctx, passedThroughCount } = fakeContext()
    const background = trackBackgroundWork(ctx)

    background.ctx.passThroughOnException()

    expect(passedThroughCount()).toBe(1)
    expect((background.ctx as unknown as { props: { tenant: string } }).props.tenant).toBe("aquilla")
  })

  it("holds the connection open until recorded work settles", async () => {
    const connection = fakeConnection()
    const { ctx } = fakeContext()
    const background = trackBackgroundWork(ctx)
    const closedDuringWork: boolean[] = []
    let release: (() => void) | undefined

    background.ctx.waitUntil(
      new Promise<void>((resolve) => {
        release = resolve
      }).then(() => {
        closedDuringWork.push(connection.closed())
      }),
    )

    const closing = background.closeWhenSettled(connection.handle)
    await Promise.resolve()
    expect(connection.closed()).toBe(false)

    release?.()
    await closing

    expect(closedDuringWork).toEqual([false])
    expect(connection.closed()).toBe(true)
  })

  it("waits for work that registers further work while it runs", async () => {
    const connection = fakeConnection()
    const { ctx } = fakeContext()
    const background = trackBackgroundWork(ctx)
    const order: string[] = []

    background.ctx.waitUntil(
      (async () => {
        await Promise.resolve()
        order.push("first")
        // A second-generation registration, like a notify that fans out per
        // downstream once its first query comes back.
        background.ctx.waitUntil(
          (async () => {
            await Promise.resolve()
            order.push(`second (closed=${connection.closed()})`)
          })(),
        )
      })(),
    )

    await background.closeWhenSettled(connection.handle)

    expect(order).toEqual(["first", "second (closed=false)"])
    expect(connection.closed()).toBe(true)
  })

  it("still closes when background work rejects", async () => {
    const connection = fakeConnection()
    const { ctx } = fakeContext()
    const background = trackBackgroundWork(ctx)

    background.ctx.waitUntil(Promise.reject(new Error("email provider blip")))

    await expect(background.closeWhenSettled(connection.handle)).resolves.toBeUndefined()
    expect(connection.closed()).toBe(true)
  })

  it("closes with no background work at all", async () => {
    const connection = fakeConnection()
    const { ctx } = fakeContext()

    await trackBackgroundWork(ctx).closeWhenSettled(connection.handle)

    expect(connection.closed()).toBe(true)
  })

  it("never throws when the close itself fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { ctx } = fakeContext()
    const background = trackBackgroundWork(ctx)

    await expect(
      background.closeWhenSettled({ close: () => Promise.reject(new Error("pool gone")) }),
    ).resolves.toBeUndefined()

    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe("trackBackgroundWork — the drain watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is long enough that ordinary post-response work never races it", () => {
    expect(BACKGROUND_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000)
  })

  it("releases the connection rather than leaking it when work never settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const connection = fakeConnection()
    const { ctx } = fakeContext()
    const background = trackBackgroundWork(ctx, { timeoutMs: 1_000 })

    background.ctx.waitUntil(new Promise<void>(() => {}))
    const closing = background.closeWhenSettled(connection.handle)

    await vi.advanceTimersByTimeAsync(1_000)
    await closing

    expect(connection.closed()).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[background-work]"))
    warn.mockRestore()
  })
})

describe("the AQU-1835 regression: a route's post-response query", () => {
  // Composes the real producer/consumer pair at the seam index.ts owns: a
  // route that fires ctx.waitUntil and then queries the REQUEST's connection
  // after an await (what events/route.ts does for comment notification emails
  // and the link-notify hook), against index.ts's release-in-finally.
  async function serveRequest(
    route: (ctx: Pick<ExecutionContext, "waitUntil">, query: (label: string) => Promise<string>) => void,
    { trackWork }: { trackWork: boolean },
  ) {
    const connection = fakeConnection()
    // `forwarded` is what the runtime itself holds open: every waitUntil the
    // route registered. The release below is registered the same way, so the
    // two are concurrent — exactly the race AQU-1835 is about.
    const { ctx, forwarded } = fakeContext()
    const background = trackBackgroundWork(ctx)

    try {
      route(trackWork ? background.ctx : ctx, (label) => connection.query(label))
    } finally {
      // index.ts: `finally { ctx.waitUntil(<release the connection>) }`
      ctx.waitUntil(
        trackWork ? background.closeWhenSettled(connection.handle) : connection.handle.close(),
      )
    }
    await Promise.allSettled(forwarded)
    return connection
  }

  /** Stand-in for sendCommentNotifications: resolve the recipients, then write
   *  the notification row — the second query lands after the response. */
  function emailRoute(
    ctx: Pick<ExecutionContext, "waitUntil">,
    query: (label: string) => Promise<string>,
    outcome: { sent: string[]; failed: string[] },
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          await query("select mention recipients")
          await new Promise((resolve) => setTimeout(resolve, 0))
          outcome.sent.push(await query("insert notification row"))
        } catch (err) {
          // What the shipped code does with the failure: warn and drop it.
          outcome.failed.push(err instanceof Error ? err.message : String(err))
        }
      })(),
    )
  }

  it("fails on an untracked context — the bug this ticket reports", async () => {
    const outcome = { sent: [] as string[], failed: [] as string[] }
    const connection = await serveRequest((ctx, query) => emailRoute(ctx, query, outcome), {
      trackWork: false,
    })

    expect(outcome.sent).toEqual([])
    expect(outcome.failed).toEqual([expect.stringContaining("CONNECTION_ENDED")])
    expect(connection.closed()).toBe(true)
  })

  it("delivers every notification when the context is tracked", async () => {
    const outcome = { sent: [] as string[], failed: [] as string[] }
    const connection = await serveRequest((ctx, query) => emailRoute(ctx, query, outcome), {
      trackWork: true,
    })

    expect(outcome.failed).toEqual([])
    expect(outcome.sent).toEqual(["insert notification row"])
    // And the connection is still released afterwards — no leak.
    expect(connection.closed()).toBe(true)
  })

  it("delivers all of them for a comment that mentions many recipients", async () => {
    const outcome = { sent: [] as string[], failed: [] as string[] }
    const connection = await serveRequest(
      (ctx, query) => {
        for (let i = 0; i < 20; i++) emailRoute(ctx, query, outcome)
      },
      { trackWork: true },
    )

    expect(outcome.failed).toEqual([])
    expect(outcome.sent).toHaveLength(20)
    expect(connection.closed()).toBe(true)
  })
})
