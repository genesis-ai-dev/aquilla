// AQU-2327 slice 8: the one mixer's level arithmetic, and that nothing is
// routed where there is no AudioContext (every element keeps its volume).
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetMixerForTests, clipLevelOf, levelAt, mixElement, mixerInput, isMixed } from "./mixer"
import { resetOutputContextForTests } from "./output-context"
import { applyClipLevelPcm, guardPeak, hasClipLevel } from "@/lib/export/clip-level"

afterEach(() => {
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

// AQU-2664: an evened-out take plays at the target — the mixer reads the same
// take-gain rule the exports do. The stages: correction, then the take's own
// volume and fades (its gain node), then the track, main and peak guard.
describe("an evened-out take on playback", () => {
  const evened = { loudnessLufs: -28, truePeakDb: -14, evenTargetLufs: -16 }

  it("reads its gain as its own volume plus the correction to the target", () => {
    expect(clipLevelOf(evened)).toEqual({ gainDb: 12, fadeInSec: 0, fadeOutSec: 0, startSec: 0, endSec: null })
    expect(clipLevelOf({ ...evened, gainDb: -3 })?.gainDb).toBeCloseTo(9, 6)
    // Cleared (no target): back to its own volume, or flat.
    expect(clipLevelOf({ ...evened, evenTargetLufs: null })).toBeNull()
    // The peak holds a raise back: -14 + 12 would pass -1 dBTP.
    expect(clipLevelOf({ loudnessLufs: -28, truePeakDb: -6, evenTargetLufs: -16 })?.gainDb).toBeCloseTo(5, 6)
  })

  it("sets the take's gain node to that gain", () => {
    const sets: Array<{ name: string; v: number }> = []
    const node = (name: string) => ({
      name,
      gain: { value: 1, setValueAtTime: (v: number) => sets.push({ name, v }), cancelScheduledValues: () => {}, linearRampToValueAtTime: () => {} },
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
      connect: () => {},
    })
    let gains = 0
    vi.stubGlobal("AudioContext", function AC(this: unknown) {
      return {
        state: "running", currentTime: 0, destination: { name: "out" },
        createGain: () => node(`gain${gains++}`),
        createDynamicsCompressor: () => node("guard"),
        createMediaElementSource: () => node("source"),
        resume: () => Promise.resolve(),
      }
    } as unknown as typeof AudioContext)
    const el = {
      src: "blob:x", currentSrc: "blob:x", currentTime: 0.5, paused: true, muted: false, playbackRate: 1, volume: 0.4,
      addEventListener: () => {},
    } as unknown as HTMLMediaElement
    expect(mixElement(el, "recording", clipLevelOf(evened))).toBe(true)
    // The last value set on a gain node is the take's own: +12 dB.
    expect(sets[sets.length - 1].v).toBeCloseTo(Math.pow(10, 12 / 20), 6)
    expect(el.volume).toBe(1)
  })
})

describe("an evened-out take in an export", () => {
  it("applies the same gain to its samples", () => {
    const kept = new Float32Array(10).fill(0.1)
    const att = { loudnessLufs: -28, truePeakDb: -14, evenTargetLufs: -16, gainDb: -2 }
    expect(hasClipLevel(att)).toBe(true)
    expect(applyClipLevelPcm(kept, 100, att)[5]).toBeCloseTo(0.1 * Math.pow(10, 10 / 20), 5)
    expect(hasClipLevel({ loudnessLufs: -28, truePeakDb: -14 })).toBe(false)
  })

  it("guards the SUM of the stages: a take turned up past full scale is held under it, not clipped", () => {
    // Evened to its -1 dBTP ceiling, then turned up +6 dB by hand.
    const kept = new Float32Array(10).fill(Math.pow(10, -13 / 20))
    const out = applyClipLevelPcm(kept, 100, { loudnessLufs: -28, truePeakDb: -13, evenTargetLufs: -16, gainDb: 6 })
    expect(out[5]).toBeLessThanOrEqual(1) // never past full scale
    expect(out[5]).toBeGreaterThan(0.891)
    // A modest over is bent under full scale rather than clipped flat.
    const near = applyClipLevelPcm(new Float32Array(4).fill(Math.pow(10, -13 / 20)), 100, { loudnessLufs: -28, truePeakDb: -13, evenTargetLufs: -16, gainDb: 0.5 })
    expect(near[0]).toBeLessThan(1)
    expect(near[0]).toBeGreaterThan(0.891)
    expect(out[5]).toBe(Math.fround(guardPeak(Math.pow(10, 5 / 20))))
  })
})

