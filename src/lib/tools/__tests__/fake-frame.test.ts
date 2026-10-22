/**
 * The fake frame's own contract (AQU-2072). A message posted on a window
 * reaches it asynchronously, from its peer, with the payload cloned — the
 * delivery every tool test builds on. And nothing a test made can deliver once
 * that test is over — not what it left in flight, and not what the frame's own
 * timers post afterwards: a delivery that fires after vitest has torn the
 * environment down is an unhandled error that fails a run with zero failing
 * tests.
 */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"
import { closeFakeWindows, createFakeFramePair } from "./fake-frame"

type MessageLike = Event & { data: unknown; origin: string; source: unknown }

function recordMessages(target: EventTarget): MessageLike[] {
  const got: MessageLike[] = []
  target.addEventListener("message", (e) => got.push(e as MessageLike))
  return got
}

describe("fake frame deliveries", () => {
  afterEach(() => vi.useRealTimers())

  it("delivers a posted message to that window, asynchronously, from its peer, with the payload cloned", async () => {
    const { host, frame } = createFakeFramePair()
    const got = recordMessages(host)
    const data = { channel: "aquilla-tool", nested: { list: [1, 2] } }
    host.postMessage(data)
    expect(got).toHaveLength(0)
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: STALL_WATCHDOG_MS })
    expect(got[0].data).toEqual(data)
    expect(got[0].data).not.toBe(data)
    expect(got[0].origin).toBe("null")
    expect(got[0].source).toBe(frame)
    expect(host.pending.size).toBe(0)
  })

  it("delivers nothing once the pair is disposed, and schedules nothing after that", () => {
    vi.useFakeTimers()
    const pair = createFakeFramePair()
    const messages = recordMessages(pair.host)
    const loads: Event[] = []
    pair.frame.addEventListener("load", (e) => loads.push(e))
    pair.host.postMessage({ late: true })
    pair.run("<body></body>")
    expect(pair.host.pending.size).toBe(1)
    expect(pair.frame.pending.size).toBe(1)
    pair.dispose()
    pair.host.postMessage({ later: true })
    expect(pair.host.pending.size).toBe(0)
    expect(pair.frame.pending.size).toBe(0)
    vi.runAllTimers()
    expect(messages).toHaveLength(0)
    expect(loads).toHaveLength(0)
  })

  it("closes every open window: what is in flight is dropped and a later post schedules nothing", () => {
    vi.useFakeTimers()
    const a = createFakeFramePair()
    const b = createFakeFramePair()
    const gotA = recordMessages(a.host)
    const gotB = recordMessages(b.frame)
    a.host.postMessage("a")
    b.frame.postMessage("b")
    closeFakeWindows()
    expect([a.host, a.frame, b.host, b.frame].map((w) => w.closed)).toEqual([true, true, true, true])
    a.host.postMessage("again")
    expect(a.host.pending.size).toBe(0)
    vi.runAllTimers()
    expect(gotA).toHaveLength(0)
    expect(gotB).toHaveLength(0)
  })

  it("leaves nothing in flight once its hooks have run, even when it ends mid-delivery", () => {
    const pair = createFakeFramePair()
    recordMessages(pair.host)
    pair.host.postMessage({ late: true })
    pair.run("<body></body>")
    expect(pair.host.pending.size + pair.frame.pending.size).toBe(2)
    // Runs after every afterEach hook, the helper's own included.
    onTestFinished(() => {
      expect(pair.host.closed && pair.frame.closed).toBe(true)
      expect(pair.host.pending.size + pair.frame.pending.size).toBe(0)
    })
  })

  it("drops what the frame's own timers post once its hooks have run", () => {
    // The shipped runtime and SDK schedule plain timers the helper cannot see
    // (the SDK's `later`, call deadlines, repaint intervals). One that fires
    // after the hooks must not schedule a delivery: nothing cancels it, and it
    // fires after the environment is torn down.
    const pair = createFakeFramePair()
    const got = recordMessages(pair.host)
    pair.run('<body><script>setTimeout(function () { window.parent.postMessage({ late: true }, "*"); }, 0);</script></body>')
    expect(pair.host.pending.size).toBe(0)
    onTestFinished(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(pair.host.closed).toBe(true)
      expect(pair.host.pending.size).toBe(0)
      expect(got).toHaveLength(0)
    })
  })
})
