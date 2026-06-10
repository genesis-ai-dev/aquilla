// Tests for the session-expired signal module (FRO-293).
//
// Verifies:
//  1. notifySessionExpired fires handlers registered via onSessionExpired.
//  2. Unsubscribing via the returned cleanup function stops future events.
//  3. Multiple subscribers all receive the event.

import { describe, it, expect, vi, afterEach } from "vitest"
import { notifySessionExpired, onSessionExpired } from "./session-expired-signal"

afterEach(() => {
  // No global state to reset — bus is module-level but listeners are removed
  // in each test via the cleanup function.
})

describe("onSessionExpired / notifySessionExpired", () => {
  it("fires a registered handler when notifySessionExpired is called", () => {
    const handler = vi.fn()
    const unsub = onSessionExpired(handler)
    notifySessionExpired()
    expect(handler).toHaveBeenCalledOnce()
    unsub()
  })

  it("does not fire after the handler is unsubscribed", () => {
    const handler = vi.fn()
    const unsub = onSessionExpired(handler)
    unsub()
    notifySessionExpired()
    expect(handler).not.toHaveBeenCalled()
  })

  it("fires multiple subscribers", () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    const u1 = onSessionExpired(h1)
    const u2 = onSessionExpired(h2)
    notifySessionExpired()
    expect(h1).toHaveBeenCalledOnce()
    expect(h2).toHaveBeenCalledOnce()
    u1(); u2()
  })

  it("fires again on subsequent notifications (not one-shot at module level)", () => {
    const handler = vi.fn()
    const unsub = onSessionExpired(handler)
    notifySessionExpired()
    notifySessionExpired()
    expect(handler).toHaveBeenCalledTimes(2)
    unsub()
  })
})
