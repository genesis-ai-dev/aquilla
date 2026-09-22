// The playhead's output-latency compensation. (AQU-646)
//
// Two things are being pinned here. One is arithmetic. The other is the rule
// that every environment without a usable AudioContext — which is EVERY unit
// test in this repo, because happy-dom does not implement one — reports zero
// and therefore compensates by nothing. That rule is load-bearing far beyond
// this file: TimelineEditor.test.tsx asserts the playhead's exact pixel while
// the transport is playing, and it passes only because the latency here is 0.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  armOutputLatency,
  displaySec,
  getOutputLatencySec,
  isHighLatencyOutput,
  refreshOutputLatency,
  HIGH_LATENCY_SEC,
  MAX_COMPENSATION_SEC,
  __resetOutputLatencyForTests,
} from "./output-latency"
import { resetOutputContextForTests } from "./output-context"
import { setMicHeld, __resetMicHoldForTests } from "./mic-hold"
import { MAX_REGRESSION_SEC } from "@/components/timeline/TimelinePlayhead"

/** A stand-in for the platform's AudioContext, since happy-dom has none. */
class StubCtx {
  static made = 0
  state: string
  outputLatency: number | undefined
  baseLatency: number | undefined
  constructor(opts?: { state?: string; outputLatency?: number; baseLatency?: number }) {
    StubCtx.made += 1
    this.state = opts?.state ?? "running"
    this.outputLatency = opts?.outputLatency
    this.baseLatency = opts?.baseLatency
  }
  resume() { this.state = "running"; return Promise.resolve() }
  addEventListener() {}
  removeEventListener() {}
}

function stubContext(opts: { state?: string; outputLatency?: number; baseLatency?: number }) {
  vi.stubGlobal("AudioContext", function AC(this: unknown) {
    return new StubCtx(opts)
  } as unknown as typeof AudioContext)
}

beforeEach(() => {
  StubCtx.made = 0
  __resetOutputLatencyForTests()
  resetOutputContextForTests()
  __resetMicHoldForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  __resetOutputLatencyForTests()
  resetOutputContextForTests()
  __resetMicHoldForTests()
})

describe("with no AudioContext at all — the ordinary case in this suite", () => {
  it("reports zero, so nothing anywhere is compensated", () => {
    // happy-dom implements <audio> but not AudioContext. THIS is why
    // TimelineEditor.test.tsx can assert an exact playhead pixel while playing.
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined()
    armOutputLatency()
    expect(getOutputLatencySec()).toBe(0)
    expect(isHighLatencyOutput()).toBe(false)
  })
})

describe("reading the latency", () => {
  it("uses outputLatency when the context is running", () => {
    stubContext({ outputLatency: 0.178 })
    armOutputLatency()
    expect(getOutputLatencySec()).toBeCloseTo(0.178, 5)
    expect(isHighLatencyOutput()).toBe(true)
  })

  it("refuses to read a context that is not running", () => {
    // The value describes a real output stream, and that stream does not exist
    // until the context starts — a suspended context tends to report 0, which
    // is indistinguishable from a genuine zero.
    stubContext({ state: "suspended", outputLatency: 0.178 })
    expect(refreshOutputLatency()).toBe(false)
    expect(getOutputLatencySec()).toBe(0)
  })

  it("treats a genuine zero as a real reading, not as unsupported", () => {
    // Firefox on macOS built-in speakers reports literal 0. Falling through to
    // baseLatency there would invent a latency that is not real.
    stubContext({ outputLatency: 0, baseLatency: 0.005 })
    armOutputLatency()
    expect(getOutputLatencySec()).toBe(0)
  })

  it("falls back to baseLatency only when outputLatency is absent", () => {
    stubContext({ baseLatency: 0.005 })
    armOutputLatency()
    expect(getOutputLatencySec()).toBeCloseTo(0.005, 5)
  })

  it("ignores nonsense readings", () => {
    stubContext({ outputLatency: Number.NaN, baseLatency: -1 })
    armOutputLatency()
    expect(getOutputLatencySec()).toBe(0)
  })
})

describe("the compensation ceiling", () => {
  it("clamps an implausible reading", () => {
    stubContext({ outputLatency: 3 })
    armOutputLatency()
    expect(getOutputLatencySec()).toBe(MAX_COMPENSATION_SEC)
  })

  it("stays under the playhead's never-move-backward bound, which is WHY it exists", () => {
    // Applying the shift is a one-time BACKWARD step. Under the bound the
    // playhead renders it as a hold — the correct picture of "the sound is
    // still in the buffer". Over the bound it would pass through as a visible
    // backward jump. If MAX_REGRESSION_SEC ever moves, this fails first.
    expect(MAX_COMPENSATION_SEC).toBeLessThan(MAX_REGRESSION_SEC)
  })
})

describe("the mic interlock", () => {
  it("never opens the audio device while the recorder holds the mic", () => {
    // Creating a context is what makes the OS reconfigure the shared device,
    // and on a headset that reaches the microphone mid-take.
    stubContext({ outputLatency: 0.178 })
    setMicHeld(true)
    armOutputLatency()
    expect(StubCtx.made).toBe(0)
    expect(getOutputLatencySec()).toBe(0)
  })
})

describe("displaySec", () => {
  it("draws the head where the sound actually is, while compensating", () => {
    expect(displaySec(10, 0.178, true)).toBeCloseTo(9.822, 5)
  })

  it("draws the head exactly on the clock when not compensating", () => {
    // A seek must land where it was aimed: this is an editor, and at rest the
    // head has to agree with the chip edge under it.
    expect(displaySec(10, 0.178, false)).toBe(10)
  })

  it("never draws before the start of the file", () => {
    expect(displaySec(0.05, 0.178, true)).toBe(0)
  })

  it("is a no-op when there is no latency to apply", () => {
    expect(displaySec(10, 0, true)).toBe(10)
    expect(displaySec(10, Number.NaN, true)).toBe(10)
  })
})

describe("the high-latency threshold", () => {
  it("sits between wired and Bluetooth", () => {
    // Wired readings cluster around 0.015-0.025s; Bluetooth lands near 0.18s.
    expect(HIGH_LATENCY_SEC).toBeGreaterThan(0.03)
    expect(HIGH_LATENCY_SEC).toBeLessThan(0.15)
  })
})
