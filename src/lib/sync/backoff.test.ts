import { describe, it, expect } from "vitest"
import {
  ONLINE_FLUSH_SPREAD_MS,
  OUTBOX_BACKOFF_JITTER,
  staggerMs,
  withJitter,
} from "./backoff"

// AQU-1838. The point of these schedules is not the delay but the SPREAD: a
// sync-worker deploy drops every client at the same instant, so a schedule
// with no random component puts the whole fleet back on the wire together.

describe("withJitter", () => {
  it("leaves the nominal delay alone at the midpoint draw", () => {
    // 0.5 is the identity factor — the schedule's shape is unchanged, only
    // scattered. Tests across the codebase pin this draw for that reason.
    expect(withJitter(5_000, OUTBOX_BACKOFF_JITTER, () => 0.5)).toBe(5_000)
  })

  it("spans exactly ±spread across the draw range", () => {
    expect(withJitter(5_000, 0.3, () => 0)).toBe(3_500)
    expect(withJitter(5_000, 0.3, () => 1)).toBe(6_500)
  })

  it("gives two clients that failed together different delays", () => {
    const a = withJitter(10_000, 0.3, () => 0.1)
    const b = withJitter(10_000, 0.3, () => 0.9)
    expect(a).not.toBe(b)
    // Both still recognisably the same schedule — this is jitter, not a
    // different backoff curve.
    for (const delay of [a, b]) {
      expect(delay).toBeGreaterThanOrEqual(7_000)
      expect(delay).toBeLessThanOrEqual(13_000)
    }
  })

  it("passes a non-delay through as 0 so 'retry now' is never pushed forward", () => {
    expect(withJitter(0)).toBe(0)
    expect(withJitter(-1)).toBe(0)
    expect(withJitter(Number.NaN)).toBe(0)
  })

  it("never returns a negative delay even at full spread", () => {
    expect(withJitter(10, 1, () => 0)).toBe(0)
  })
})

describe("staggerMs", () => {
  it("draws uniformly across the spread", () => {
    expect(staggerMs(2_500, () => 0)).toBe(0)
    expect(staggerMs(2_500, () => 0.5)).toBe(1_250)
    expect(staggerMs(2_500, () => 1)).toBe(2_500)
  })

  it("defaults to the online-flush spread", () => {
    expect(staggerMs(undefined, () => 1)).toBe(ONLINE_FLUSH_SPREAD_MS)
  })

  it("treats a non-positive spread as no stagger", () => {
    expect(staggerMs(0, () => 1)).toBe(0)
    expect(staggerMs(Number.NaN, () => 1)).toBe(0)
  })
})
