// AQU-1849: the vendor-deadline primitive every outbound call now shares.
//
// `vendorDeadline` is the interesting half — `AbortSignal.timeout` cannot be
// disarmed (which a first-byte deadline on a streaming call needs) and cannot
// be combined with a caller's own signal, so this wrapper exists and has to
// get three things right: it fires, `clear()` stops it firing, and a *linked*
// abort is never mistaken for our deadline.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  isAbortTimeout,
  logVendorTimeout,
  vendorDeadline,
  vendorTimeoutMessage,
  VENDOR_TIMEOUT_MS,
} from "./vendor-timeouts"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("VENDOR_TIMEOUT_MS", () => {
  it("gives every vendor a positive, finite deadline", () => {
    const entries = Object.entries(VENDOR_TIMEOUT_MS)
    expect(entries.length).toBeGreaterThan(0)
    for (const [vendor, ms] of entries) {
      expect(Number.isFinite(ms), vendor).toBe(true)
      expect(ms, vendor).toBeGreaterThan(0)
    }
  })

  it("bounds a streaming call's FIRST BYTE more tightly than a whole non-streaming completion", () => {
    // The distinction this ticket turns on: a long generation is not a hang,
    // so the streaming deadline measures time-to-first-frame and can be far
    // shorter than the total a non-streaming completion legitimately needs.
    expect(VENDOR_TIMEOUT_MS.openRouterStreamFirstByte)
      .toBeLessThan(VENDOR_TIMEOUT_MS.openRouterNonStreaming)
  })

  it("keeps the live-edit-path nudge the shortest deadline of the Monday three", () => {
    // notifyMondayProgress fires from the DO broadcast, so it must give up
    // well before the API calls that run off the request path.
    expect(VENDOR_TIMEOUT_MS.mondayPushNudge).toBeLessThan(VENDOR_TIMEOUT_MS.mondayTokenEndpoint)
    expect(VENDOR_TIMEOUT_MS.mondayPushNudge).toBeLessThan(VENDOR_TIMEOUT_MS.mondayGraphQL)
  })
})

describe("isAbortTimeout", () => {
  it("recognizes the DOMException an expired or aborted fetch rejects with", () => {
    expect(isAbortTimeout(new DOMException("too slow", "TimeoutError"))).toBe(true)
    expect(isAbortTimeout(new DOMException("gone", "AbortError"))).toBe(true)
  })

  it("does not swallow ordinary failures", () => {
    expect(isAbortTimeout(new TypeError("network error"))).toBe(false)
    expect(isAbortTimeout(null)).toBe(false)
    expect(isAbortTimeout("TimeoutError")).toBe(false)
  })
})

describe("vendorTimeoutMessage", () => {
  it("names the vendor and the deadline in seconds", () => {
    const msg = vendorTimeoutMessage("aquifer")
    expect(msg).toContain("aquifer")
    expect(msg).toContain(`${VENDOR_TIMEOUT_MS.aquifer / 1000}s`)
  })
})

describe("logVendorTimeout", () => {
  it("logs one line carrying the vendor name, so it can be alerted on per vendor", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logVendorTimeout("modalVoiceConvert")
    expect(spy).toHaveBeenCalledTimes(1)
    const line = String(spy.mock.calls[0]?.[0])
    expect(line).toContain("[vendor-timeout]")
    expect(line).toContain("modalVoiceConvert")
    expect(line).toContain(String(VENDOR_TIMEOUT_MS.modalVoiceConvert))
  })
})

describe("vendorDeadline", () => {
  it("aborts the signal once the vendor's deadline passes", () => {
    vi.useFakeTimers()
    const deadline = vendorDeadline("aquifer")
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut()).toBe(false)

    vi.advanceTimersByTime(VENDOR_TIMEOUT_MS.aquifer)

    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(true)
    expect((deadline.signal.reason as DOMException).name).toBe("TimeoutError")
  })

  it("does not fire before the deadline", () => {
    vi.useFakeTimers()
    const deadline = vendorDeadline("aquifer")
    vi.advanceTimersByTime(VENDOR_TIMEOUT_MS.aquifer - 1)
    expect(deadline.signal.aborted).toBe(false)
  })

  it("stays disarmed after clear() — this is what makes a streaming call's first-byte deadline possible", () => {
    vi.useFakeTimers()
    const deadline = vendorDeadline("openRouterStreamFirstByte")
    // The headers arrived; the stream itself must run unbounded from here.
    deadline.clear()
    vi.advanceTimersByTime(VENDOR_TIMEOUT_MS.openRouterStreamFirstByte * 10)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut()).toBe(false)
  })

  it("tolerates clear() being called more than once", () => {
    vi.useFakeTimers()
    const deadline = vendorDeadline("aquifer")
    deadline.clear()
    expect(() => deadline.clear()).not.toThrow()
  })

  it("aborts when the linked signal aborts, WITHOUT counting it as a vendor timeout", () => {
    // A user who navigates away must not show up in the vendor-timeout logs,
    // or the per-vendor alert becomes a measure of user impatience.
    vi.useFakeTimers()
    const client = new AbortController()
    const deadline = vendorDeadline("openRouterNonStreaming", client.signal)

    client.abort(new DOMException("client went away", "AbortError"))

    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  it("is already aborted when handed a signal that aborted first", () => {
    const client = new AbortController()
    client.abort()
    const deadline = vendorDeadline("openRouterNonStreaming", client.signal)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  it("treats a null linked signal as 'no linked signal'", () => {
    vi.useFakeTimers()
    const deadline = vendorDeadline("aquifer", null)
    vi.advanceTimersByTime(VENDOR_TIMEOUT_MS.aquifer)
    expect(deadline.timedOut()).toBe(true)
  })
})
