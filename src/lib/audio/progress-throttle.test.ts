import { afterEach, describe, expect, it, vi } from "vitest"
import { throttleModelProgress } from "./progress-throttle"

// The throttle exists to stop the per-chunk download flood from freezing the
// UI: transformers.js fires "progress" on every network chunk, and each event
// fans out to every cell row's store subscription. These tests pin the two
// behaviours that matter: high-frequency events are coalesced, and the events
// that move the bar between states are never dropped.

afterEach(() => {
  vi.restoreAllMocks()
})

function mockClock(): (ms: number) => void {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  return (ms: number) => { now = ms }
}

describe("throttleModelProgress", () => {
  it("coalesces a burst of progress events to the throttle cadence", () => {
    const advance = mockClock()
    const emit = vi.fn()
    const throttled = throttleModelProgress(emit, 100)

    // 50 chunk events arriving 1ms apart — a fast-download flood.
    for (let i = 0; i < 50; i++) {
      advance(i)
      throttled({ status: "progress", loaded: i, total: 50 })
    }

    // First event passes (lastEmit starts at 0, now=0 is not < 0); the rest
    // within the 100ms window are dropped. Without the throttle this would be 50.
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it("emits again once the interval has elapsed", () => {
    const advance = mockClock()
    const emit = vi.fn()
    const throttled = throttleModelProgress(emit, 100)

    advance(0); throttled({ status: "progress", loaded: 1, total: 10 }) // passes
    advance(50); throttled({ status: "progress", loaded: 2, total: 10 }) // dropped
    advance(150); throttled({ status: "progress", loaded: 3, total: 10 }) // passes

    expect(emit).toHaveBeenCalledTimes(2)
  })

  it("never drops terminal / state-change statuses", () => {
    const advance = mockClock()
    const emit = vi.fn()
    const throttled = throttleModelProgress(emit, 100)

    // All within one 100ms window — only repeated "progress" is throttled;
    // every state-change status passes through untouched.
    advance(0); throttled({ status: "initiate", file: "model.onnx" })
    advance(1); throttled({ status: "progress", loaded: 1, total: 10 }) // first progress passes
    advance(2); throttled({ status: "progress", loaded: 2, total: 10 }) // dropped (window)
    advance(3); throttled({ status: "done", file: "model.onnx" })
    advance(4); throttled({ status: "ready" })

    const statuses = emit.mock.calls.map((c) => (c[0] as { status: string }).status)
    expect(statuses).toEqual(["initiate", "progress", "done", "ready"])
  })

  it("also throttles the MMS 'downloading' status", () => {
    const advance = mockClock()
    const emit = vi.fn()
    const throttled = throttleModelProgress(emit, 100)

    advance(0); throttled({ status: "downloading", loaded: 1, total: 10 }) // passes
    advance(10); throttled({ status: "downloading", loaded: 2, total: 10 }) // dropped
    advance(20); throttled({ status: "downloaded", loaded: 10, total: 10 }) // terminal, passes

    const statuses = emit.mock.calls.map((c) => (c[0] as { status: string }).status)
    expect(statuses).toEqual(["downloading", "downloaded"])
  })
})
