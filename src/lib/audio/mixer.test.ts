// AQU-2327 slice 8: the one mixer's level arithmetic, and that nothing is
// routed where there is no AudioContext (every element keeps its volume).
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetMixerForTests, clipLevelOf, joinedLevelsOf, levelAt, mixElement, mixerInput, isMixed, playUnmixed, setPlayerMuted, setPlayerVolume } from "./mixer"
import { resetOutputContextForTests } from "./output-context"
import { applyClipLevelPcm, guardPeak, hasClipLevel } from "@/lib/export/clip-level"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetMixerForTests()
  resetOutputContextForTests()
})

describe("a take's level", () => {
  it("is read off the take, and absent when flat", () => {
    expect(clipLevelOf({ gainDb: null })).toBeNull()
    expect(clipLevelOf({ gainDb: -6, trimStartMs: 500, trimEndMs: 2500 })).toEqual({ gainDb: -6, fadeInSec: 0, fadeOutSec: 0, startSec: 0.5, endSec: 2.5 })
  })

  it("is the volume, with fades inside the kept part", () => {
    const l = { gainDb: 6, fadeInSec: 0.5, fadeOutSec: 0.5, startSec: 1, endSec: 3 }
    const g = Math.pow(10, 6 / 20)
    expect(levelAt(1, l)).toBe(0)
    expect(levelAt(1.25, l)).toBeCloseTo(g / 2, 5)
    expect(levelAt(2, l)).toBeCloseTo(g, 5)
    expect(levelAt(3, l)).toBe(0)
  })

  it("still gives a one-off player somewhere to play when the context has no compressor", () => {
    // The chip's Play goes through mixerInput(); a context without
    // createDynamicsCompressor used to throw there and silence every chip.
    const connections: string[] = []
    const node = (name: string) => ({ name, gain: { value: 1 }, connect: (to: { name?: string }) => connections.push(`${name}→${to.name ?? "out"}`) })
    vi.stubGlobal("AudioContext", function AC(this: unknown) {
      return { state: "running", currentTime: 0, destination: { name: "out" }, createGain: () => node("gain"), resume: () => Promise.resolve() }
    } as unknown as typeof AudioContext)
    expect(() => mixerInput()).not.toThrow()
    expect(mixerInput()).not.toBeNull()
    expect(connections).toEqual(["gain→out"])
  })

  it("routes nothing without an AudioContext", () => {
    const el = { src: "blob:x", currentSrc: "blob:x" } as unknown as HTMLMediaElement
    expect(mixElement(el, "recording", null)).toBe(false)
    expect(isMixed(el)).toBe(false)
  })
})

// AQU-2494 (review, Nov 9): a cut take joined into one copy is levelled piece
// by piece, each where it sits in the copy.
describe("a joined copy's levels", () => {
  it("puts each piece's level on the copy's clock, after the silence left before it", () => {
    const levels = joinedLevelsOf([
      { start: 1, end: 2.5, att: { gainDb: 6, fadeInMs: 500, trimStartMs: 1000, trimEndMs: 2500 } },
      { start: 2.5, end: 5, gapBeforeSec: 0.5, att: { fadeOutMs: 500, trimStartMs: 2500, durationMs: 5000 } },
    ])
    expect(levels).toEqual([
      { gainDb: 6, fadeInSec: 0.5, fadeOutSec: 0, startSec: 0, endSec: 1.5 },
      { gainDb: 0, fadeInSec: 0, fadeOutSec: 0.5, startSec: 2, endSec: 4.5 },
    ])
    const g = Math.pow(10, 6 / 20)
    expect(levelAt(0.25, levels!)).toBeCloseTo(g / 2, 5)
    expect(levelAt(1.4, levels!)).toBeCloseTo(g, 5)
    // The second piece starts at its own level, where it begins.
    expect(levelAt(2, levels!)).toBe(1)
    expect(levelAt(4.25, levels!)).toBeCloseTo(0.5, 5)
    expect(levelAt(4.5, levels!)).toBe(0)
  })

  it("is absent when every piece plays as recorded", () => {
    expect(joinedLevelsOf([{ start: 0, end: 1, att: {} }, { start: 1, end: 2, att: undefined }])).toBeNull()
  })
})

// AQU-2494 (review, Nov 9): a player that plays straight to the output (the
// context asleep, a streamed take) carries its take's level on its own volume,
// as AQU-2471's does — here for a cut take's pieces too, each at its own level.
describe("a player straight to the output", () => {
  class FakePlayer {
    paused = true
    ended = false
    volume = 1
    muted = false
    playbackRate = 1
    src = "http://stream.test/take.webm"
    currentSrc = "http://stream.test/take.webm"
    private pos = 0
    private since = 0
    private listeners = new Map<string, Set<() => void>>()
    get currentTime(): number { return this.paused ? this.pos : this.pos + ((Date.now() - this.since) / 1000) * this.playbackRate }
    set currentTime(v: number) { this.pos = v; this.since = Date.now(); this.emit("seeked") }
    addEventListener(type: string, fn: () => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(fn)
    }
    play() { this.since = Date.now(); this.paused = false; this.emit("play"); this.emit("playing") }
    pause() { this.pos = this.currentTime; this.paused = true; this.emit("pause") }
    private emit(type: string) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn() }
  }

  it("turns a take down, but never raises one above as recorded", () => {
    const el = new FakePlayer()
    playUnmixed(el as unknown as HTMLMediaElement, { gainDb: -6, fadeInSec: 0, fadeOutSec: 0, startSec: 0, endSec: 2 }, 1)
    expect(el.volume).toBeCloseTo(Math.pow(10, -6 / 20), 5)
    const raised = new FakePlayer()
    playUnmixed(raised as unknown as HTMLMediaElement, { gainDb: 9, fadeInSec: 0, fadeOutSec: 0, startSec: 0, endSec: 2 }, 1)
    expect(raised.volume).toBe(1)
  })

  it("steps from one piece of a cut take to the next within a step of where it begins", () => {
    vi.useFakeTimers()
    const el = new FakePlayer()
    const levels = joinedLevelsOf([
      { start: 0, end: 1, att: { gainDb: -6, trimEndMs: 1000 } },
      { start: 1, end: 2, att: { gainDb: -12, fadeOutMs: 200, trimStartMs: 1000, trimEndMs: 2000 } },
    ])!
    playUnmixed(el as unknown as HTMLMediaElement, levels, 1)
    el.play()
    vi.advanceTimersByTime(500)
    expect(el.volume).toBeCloseTo(Math.pow(10, -6 / 20), 5)
    vi.advanceTimersByTime(520)
    // 1.02 s: the second piece, at its own level.
    expect(el.volume).toBeCloseTo(Math.pow(10, -12 / 20), 5)
    vi.advanceTimersByTime(880)
    // 1.9 s: half way down its fade-out.
    expect(el.volume).toBeLessThanOrEqual(Math.pow(10, -12 / 20) * 0.5 + 0.02)
  })

  it("follows the main volume, and is muted at 0 (iPhone and iPad ignore a player's volume)", () => {
    const el = new FakePlayer()
    setPlayerMuted(el as unknown as HTMLMediaElement, false)
    playUnmixed(el as unknown as HTMLMediaElement, { gainDb: -6, fadeInSec: 0, fadeOutSec: 0, startSec: 0, endSec: 2 }, 0.5)
    expect(el.volume).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 5)
    expect(el.muted).toBe(false)
    setPlayerVolume(el as unknown as HTMLMediaElement, 0)
    expect(el.muted).toBe(true)
    setPlayerVolume(el as unknown as HTMLMediaElement, 1)
    expect(el.muted).toBe(false)
    expect(el.volume).toBeCloseTo(Math.pow(10, -6 / 20), 5)
  })
})

describe("a take's level in an export", () => {
  it("raises, lowers and fades the kept part, and leaves a flat take alone", () => {
    const kept = new Float32Array(100).fill(0.5)
    expect(applyClipLevelPcm(kept, 100, {})).toBe(kept)
    const out = applyClipLevelPcm(kept, 100, { gainDb: -6, fadeInMs: 100, fadeOutMs: 100 })
    expect(out[0]).toBe(0)
    expect(out[50]).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 5)
    expect(out[99]).toBeLessThan(0.05)
    expect(hasClipLevel({ gainDb: 0 })).toBe(false)
  })

  it("guards a summed peak below full scale instead of clipping it", () => {
    expect(guardPeak(0.5)).toBe(0.5)
    expect(guardPeak(1.8)).toBeLessThan(1)
    expect(guardPeak(-1.8)).toBeGreaterThan(-1)
  })
})
