/**
 * useSmoothedText.test.ts — chat stream smoothing
 *
 * The hook exists so streamed replies reveal at a visually even pace without
 * ever showing a torn grapheme cluster. These tests encode that intent:
 *  - bursty chunks must not teleport, yet the reveal must catch up (backlog-
 *    proportional rate) and never stall behind a growing buffer;
 *  - the revealed prefix must always sit on a grapheme-cluster boundary of
 *    the final text (Devanagari conjuncts, emoji ZWJ sequences) even when
 *    chunk boundaries split clusters;
 *  - when streaming ends (done/stop/error) the user must see the full text
 *    immediately;
 *  - no RAF may survive unmount.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useSmoothedText, segmentGraphemes } from "./useSmoothedText"

const FRAME_MS = 16

function advanceFrames(n: number) {
  for (let i = 0; i < n; i++) {
    act(() => {
      vi.advanceTimersByTime(FRAME_MS)
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"],
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useSmoothedText", () => {
  it("reveals gradually under a burst — neither teleports nor stalls", () => {
    const target = "word ".repeat(200).trim() // ~1000 chars in one burst
    const { result } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: target, streaming: true } },
    )

    advanceFrames(1)
    const afterOne = result.current.length
    // Not a teleport: one frame must not reveal the whole burst.
    expect(afterOne).toBeGreaterThan(0)
    expect(afterOne).toBeLessThan(target.length / 2)

    // Monotonic, and catches up (modulo the held-back tail cluster) within a
    // few seconds rather than stalling behind the buffer.
    let prev = afterOne
    for (let i = 0; i < 200; i++) {
      advanceFrames(1)
      expect(result.current.length).toBeGreaterThanOrEqual(prev)
      prev = result.current.length
    }
    expect(result.current.length).toBeGreaterThanOrEqual(target.length - 1)
  })

  it("adapts rate to backlog: large backlog reveals faster per frame than small", () => {
    const small = "abcdefghijklmnopqrstuvwxyz" // 26-grapheme backlog
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: small, streaming: true } },
    )

    advanceFrames(1)
    const smallDelta = result.current.length
    // Near the head: floor rate ≈ MIN_RATE * 16ms ≈ 2-3 graphemes/frame.
    expect(smallDelta).toBeGreaterThan(0)
    expect(smallDelta).toBeLessThan(10)

    // Burst in a big chunk: per-frame reveal must be much larger (proportional
    // to backlog), so the reveal never falls behind a growing buffer.
    const big = small + "x".repeat(3000)
    rerender({ text: big, streaming: true })
    const before = result.current.length
    advanceFrames(1)
    const bigDelta = result.current.length - before
    expect(bigDelta).toBeGreaterThan(smallDelta * 5)
  })

  it("paces near the head at fast-typing speed (steady state)", () => {
    // Keep a modest backlog and measure ~1s of reveal: should be in the
    // fast-fluid-typing band (roughly 100-400 graphemes/sec), not a crawl and
    // not an instant dump.
    const target = "a".repeat(120)
    const { result } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: target, streaming: true } },
    )
    advanceFrames(31) // ~0.5s
    const halfSecond = result.current.length
    expect(halfSecond).toBeGreaterThan(50)
    expect(halfSecond).toBeLessThanOrEqual(target.length)
  })

  it("never splits a grapheme cluster even when chunks cut mid-cluster (Devanagari + emoji ZWJ)", () => {
    const target = "क्षत्रिय 👩‍👩‍👧‍👦 done"
    // Valid reveal boundaries = prefixes made of whole clusters of the FINAL text.
    const clusters = segmentGraphemes(target)
    const validPrefixes = new Set<string>([""])
    let acc = ""
    for (const c of clusters) {
      acc += c
      validPrefixes.add(acc)
    }

    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: "", streaming: true } },
    )

    // Stream by code units, 3 at a time — guaranteed to split surrogate
    // pairs, combining marks, and ZWJ sequences across chunk boundaries.
    const observed = new Set<string>()
    for (let i = 3; i <= target.length; i += 3) {
      rerender({ text: target.slice(0, Math.min(i, target.length)), streaming: true })
      advanceFrames(2)
      observed.add(result.current)
    }
    rerender({ text: target, streaming: true })
    advanceFrames(60)
    observed.add(result.current)

    for (const value of observed) {
      expect(validPrefixes.has(value), `revealed ${JSON.stringify(value)} splits a grapheme`).toBe(true)
    }
  })

  it("flushes the full text immediately when streaming ends mid-reveal", () => {
    const target = "x".repeat(2000)
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: target, streaming: true } },
    )
    advanceFrames(2)
    expect(result.current.length).toBeLessThan(target.length) // mid-reveal

    rerender({ text: target, streaming: false }) // done / Stop / error
    expect(result.current).toBe(target)
  })

  it("flush also covers the tail cluster held back during streaming", () => {
    const target = "hi 👩‍👩‍👧‍👦"
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: target, streaming: true } },
    )
    advanceFrames(120)
    // While streaming, the final cluster is withheld (it could still grow).
    expect(result.current).toBe("hi ")
    rerender({ text: target, streaming: false })
    expect(result.current).toBe(target)
  })

  it("resets when the target is not an extension (new message)", () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: "first reply text", streaming: true } },
    )
    advanceFrames(5)
    expect(result.current.length).toBeGreaterThan(0)

    rerender({ text: "", streaming: false }) // stream cleared between sends
    expect(result.current).toBe("")

    rerender({ text: "second", streaming: true })
    advanceFrames(60)
    expect(result.current).toBe("secon") // tail held back while streaming
  })

  it("cancels the RAF loop on unmount and runs no timers when idle", () => {
    const target = "y".repeat(500)
    const { unmount } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: target, streaming: true } },
    )
    advanceFrames(2)
    expect(vi.getTimerCount()).toBeGreaterThan(0) // loop active mid-backlog
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("runs no RAF once caught up while the stream is quiet", () => {
    const { rerender } = renderHook(
      ({ text, streaming }) => useSmoothedText(text, streaming),
      { initialProps: { text: "short", streaming: true } },
    )
    advanceFrames(60) // plenty to catch up on 5 graphemes
    expect(vi.getTimerCount()).toBe(0)
    rerender({ text: "short and more text now", streaming: true })
    expect(vi.getTimerCount()).toBeGreaterThan(0) // loop restarts on new chunk
  })
})

describe("segmentGraphemes fallback (no Intl.Segmenter)", () => {
  it("falls back to code-point-safe slicing that never splits surrogate pairs", async () => {
    vi.resetModules()
    const original = Intl.Segmenter
    // Simulate an environment without Intl.Segmenter.
    ;(Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter = undefined
    try {
      const fresh = await import("./useSmoothedText")
      const parts = fresh.segmentGraphemes("a𝄞b😀") // 𝄞 and 😀 are surrogate pairs
      expect(parts).toEqual(["a", "𝄞", "b", "😀"])
    } finally {
      ;(Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter = original
      vi.resetModules()
    }
  })
})
