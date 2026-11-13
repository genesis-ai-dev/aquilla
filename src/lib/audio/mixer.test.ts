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
