// Tests for the session-expired signal module (AQU-293).
//
// Verifies:
//  1. notifySessionExpired fires handlers registered via onSessionExpired.
//  2. Unsubscribing via the returned cleanup function stops future events.
//  3. Multiple subscribers all receive the event.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  clearSessionExpired,
  isSessionExpired,
  notifySessionExpired,
  onSessionExpired,
} from "./session-expired-signal"

afterEach(() => {
  // The latched flag (AQU-884) IS module-level state — reset it. Listeners are
  // still removed per-test via the cleanup function.
  clearSessionExpired()
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

// AQU-884: the flag latches so a 401 raised before the banner mounts (the boot
// redirect case) is not lost, and navigation cannot silently drop it.
describe("latched session-expired state", () => {
  it("starts clear and latches on notify", () => {
    expect(isSessionExpired()).toBe(false)
    notifySessionExpired()
    expect(isSessionExpired()).toBe(true)
  })

  it("stays latched until explicitly cleared", () => {
    notifySessionExpired()
    expect(isSessionExpired()).toBe(true)
    clearSessionExpired()
    expect(isSessionExpired()).toBe(false)
  })

  it("hands subscribers the current value on both set and clear", () => {
    const handler = vi.fn()
    const unsub = onSessionExpired(handler)
    notifySessionExpired()
    clearSessionExpired()
    expect(handler.mock.calls).toEqual([[true], [false]])
    unsub()
  })

  it("does not notify subscribers when clearing an already-clear flag", () => {
    const handler = vi.fn()
    const unsub = onSessionExpired(handler)
    clearSessionExpired()
    expect(handler).not.toHaveBeenCalled()
    unsub()
  })
})
