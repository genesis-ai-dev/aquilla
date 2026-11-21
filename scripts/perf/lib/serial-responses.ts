/**
 * Deliver a page's API responses one at a time, each only once React has gone
 * quiet — PERF-BACKLOG item 37.
 *
 * Why: opening a file sends ~39 reads. Each response that sets state renders
 * the workspace (100–900 components) unless it lands in the same task as
 * another response, in which case React batches the two into one commit. Which
 * responses share a batch depends on server and CPU timing, so the open's
 * render count moved by ±15% run to run on one tree (7,033…9,581) with no code
 * change. Holding every response and releasing them in request order, one per
 * quiet page, removes the timing: each response pays its own render, every
 * time. The count is the no-batching cost of the open: an upper bound that a
 * change can only move by changing what the responses render.
 *
 * Requests still go to the server at once (`route.fetch`); only the hand-over
 * to the page is serialized. WebSocket frames are not intercepted.
 */

import type { APIResponse, Page, Route } from "@playwright/test"

/** No React commit for this long = the previous response has finished rendering. */
const QUIET_MS = 400
/** No new request for this long, with nothing held, = the open has settled (as Recorder.end). */
const SETTLE_MS = 2_500
/** Stall watchdog, not a target (AGENTS.md rule 15). */
const STALL_MS = 600_000

interface Held {
  route: Route
  response: APIResponse | null
  failed: boolean
}

/**
 * Ms since the last React commit, read from an idle callback. Time since the last commit alone
 * is not enough: a render that takes longer than QUIET_MS has not committed yet, and React's
 * time-sliced work keeps posting tasks, which holds idle callbacks back until it is done.
 * Resolves -1 if the page was not idle within a second, which counts as not quiet.
 */
const SINCE_LAST_COMMIT = `new Promise((resolve) => requestIdleCallback((deadline) => {
  if (deadline.didTimeout) return resolve(-1);
  const log = window.__interactionProbe.react.log;
  resolve(log.length === 0 ? 1e9 : performance.now() - log[log.length - 1][0]);
}, { timeout: 1000 }))`

export interface SerialGate {
  /**
   * Release held responses one by one until nothing is held, no request has started for
   * SETTLE_MS, and `ready()` holds.
   */
  drain(ready: () => Promise<boolean>): Promise<{ released: number }>
  stop(): Promise<void>
}

/** Start holding every response whose URL is not on `appOrigin` (the app's own assets pass). */
export async function holdResponses(page: Page, appOrigin: string): Promise<SerialGate> {
  const queue: Held[] = []
  let lastRequestAt = Date.now()
  const matcher = (url: URL) => url.origin !== appOrigin
  const handler = async (route: Route) => {
    const held: Held = { route, response: null, failed: false }
    queue.push(held)
    lastRequestAt = Date.now()
    try {
      held.response = await route.fetch()
    } catch {
      held.failed = true
    }
  }
  await page.route(matcher, handler)

  const waitQuiet = async () => {
    const t0 = Date.now()
    for (;;) {
      // Throws while the document is being replaced (navigation): not quiet yet.
      const since = (await page.evaluate(SINCE_LAST_COMMIT).catch(() => 0)) as number
      if (since >= QUIET_MS) return
      if (Date.now() - t0 > STALL_MS) throw new Error("serial open: the page never went quiet")
      await page.waitForTimeout(50)
    }
  }

  return {
    async drain(ready) {
      let released = 0
      const t0 = Date.now()
      for (;;) {
        await waitQuiet()
        const next = queue[0]
        if (next && (next.response || next.failed)) {
          queue.shift()
          if (next.response) await next.route.fulfill({ response: next.response })
          else await next.route.abort()
          released++
          // Give the page a moment to start on it before checking for quiet again.
          await page.waitForTimeout(QUIET_MS)
          continue
        }
        if (!next && Date.now() - lastRequestAt >= SETTLE_MS && (await ready())) return { released }
        if (Date.now() - t0 > STALL_MS) throw new Error(`serial open: stalled with ${queue.length} responses held`)
        await page.waitForTimeout(50)
      }
    },
    async stop() {
      await page.unroute(matcher, handler)
      for (const held of queue.splice(0)) await held.route.continue().catch(() => {})
    },
  }
}
