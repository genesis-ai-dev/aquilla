// The take-chip waveform's geometry. (AQU-646)
//
// Everything here is about ONE question: which slice of a clip is the chip
// currently showing? A chip's width is not its clip's length, for three
// independent reasons that stack — trims window a longer file, an unmeasured
// clip borrows its section's width, and a chip that trespasses on its
// neighbour is deliberately painted short until hovered.

import { describe, expect, it } from "vitest"
import { chipWaveformWindow, waveformPathD } from "./chip-waveform"
import type { TargetChipGeom } from "./lane-timing"

const BINS = 320

/** A 10-second clip anchored at file second 100, drawn untrimmed. */
function geom(over: Partial<TargetChipGeom> = {}): TargetChipGeom {
  return {
    anchor: 100,
    start: 100,
    end: 110,
    trimStartSec: 0,
    trimEndSec: null,
    durationSec: 10,
    usingFallback: false,
    ...over,
  }
}

describe("chipWaveformWindow — which slice of the clip the chip shows", () => {
  it("shows the whole clip when nothing is trimmed", () => {
    const w = chipWaveformWindow({ geom: geom(), paintedStart: 100, paintedEnd: 110, bins: BINS })
    expect(w).toEqual({ x0: 0, x1: BINS })
  })

  it("skips the head margin a take is born with", () => {
    // Every recorded take keeps ~0.3s of pre-roll and is born trimmed flush to
    // its cue, so the audible window starts inside the file.
    const g = geom({ trimStartSec: 1, start: 101 })
    const w = chipWaveformWindow({ geom: g, paintedStart: 101, paintedEnd: 110, bins: BINS })
    expect(w).toEqual({ x0: 32, x1: BINS }) // 1s of 10s = a tenth of 320
  })

  it("stops at the tail trim", () => {
    const g = geom({ trimEndSec: 8, end: 108 })
    const w = chipWaveformWindow({ geom: g, paintedStart: 100, paintedEnd: 108, bins: BINS })
    expect(w).toEqual({ x0: 0, x1: 256 })
  })

  it("windows both ends at once", () => {
    const g = geom({ trimStartSec: 2, trimEndSec: 8, start: 102, end: 108 })
    const w = chipWaveformWindow({ geom: g, paintedStart: 102, paintedEnd: 108, bins: BINS })
    expect(w).toEqual({ x0: 64, x1: 256 })
  })
})

describe("chipWaveformWindow — the SUB-48 painted-short rule", () => {
  it("clips the tail of a chip that is drawn short because it trespasses", () => {
    // At rest the at-fault chip is cut at its neighbour's edge.
    const w = chipWaveformWindow({ geom: geom(), paintedStart: 100, paintedEnd: 105, bins: BINS })
    expect(w).toEqual({ x0: 0, x1: 160 })
  })

  it("reveals the hidden tail on hover WITHOUT moving anything already drawn", () => {
    const atRest = chipWaveformWindow({ geom: geom(), paintedStart: 100, paintedEnd: 105, bins: BINS })
    const engaged = chipWaveformWindow({ geom: geom(), paintedStart: 100, paintedEnd: 110, bins: BINS })
    // Same origin, wider window: the bars that were visible stay exactly where
    // they were and more appear to their right. This is the whole reason the
    // window is a viewBox over one whole-clip path.
    expect(engaged!.x0).toBe(atRest!.x0)
    expect(engaged!.x1).toBeGreaterThan(atRest!.x1)
  })
})

describe("chipWaveformWindow — while a drag is in flight", () => {
  it("keeps the window still when the whole clip is being MOVED", () => {
    // Dragged 5s later: the clip travelled with the chip, so the same audio is
    // under the pointer and the waveform must not slide inside its own box.
    const g = geom({ trimStartSec: 1, start: 101 })
    const still = chipWaveformWindow({ geom: g, paintedStart: 101, paintedEnd: 110, bins: BINS })
    const moved = chipWaveformWindow({
      geom: g,
      paintedStart: 106,
      paintedEnd: 115,
      drag: { mode: "move", spanStart: 106 },
      bins: BINS,
    })
    expect(moved).toEqual(still)
  })

  it("widens toward the clip's head as a left TRIM handle is pulled back", () => {
    // A trim does not move the clip, so the resting anchor still applies and
    // the kept margin scrolls into view live.
    const g = geom({ trimStartSec: 2, start: 102 })
    const before = chipWaveformWindow({ geom: g, paintedStart: 102, paintedEnd: 110, bins: BINS })
    const during = chipWaveformWindow({
      geom: g,
      paintedStart: 100.5,
      paintedEnd: 110,
      drag: { mode: "resize-l", spanStart: 100.5 },
      bins: BINS,
    })
    expect(during!.x0).toBeLessThan(before!.x0)
    expect(during!.x1).toBe(before!.x1)
  })
})

describe("chipWaveformWindow — when it must refuse to draw", () => {
  it("draws nothing for a clip whose length was never measured", () => {
    const g = geom({ durationSec: null, usingFallback: true })
    expect(chipWaveformWindow({ geom: g, paintedStart: 100, paintedEnd: 110, bins: BINS })).toBeNull()
  })

  it("draws nothing when the duration is missing even though usingFallback is false", () => {
    // The trap: a trimEnd with no measured duration reports usingFallback
    // FALSE and durationSec NULL. Gating on the wrong one of those two would
    // scale the clip to a guessed width and make a guess look measured.
    const g = geom({ durationSec: null, trimEndSec: 8, usingFallback: false })
    expect(g.usingFallback).toBe(false)
    expect(chipWaveformWindow({ geom: g, paintedStart: 100, paintedEnd: 108, bins: BINS })).toBeNull()
  })

  it("draws nothing for an empty or inverted window", () => {
    expect(chipWaveformWindow({ geom: geom(), paintedStart: 105, paintedEnd: 105, bins: BINS })).toBeNull()
    expect(chipWaveformWindow({ geom: geom(), paintedStart: 108, paintedEnd: 102, bins: BINS })).toBeNull()
  })

  it("clamps a window that persisted data says runs off the end of its own clip", () => {
    // targetChipGeom never checks trimEndMs against durationMs, so this is
    // reachable from stored data rather than hypothetical.
    const g = geom({ trimEndSec: 30, end: 130 })
    const w = chipWaveformWindow({ geom: g, paintedStart: 90, paintedEnd: 130, bins: BINS })
    expect(w).toEqual({ x0: 0, x1: BINS })
  })
})

describe("waveformPathD — a filled envelope, not bars", () => {
  it("traces the top edge out and the bottom edge back, closed so it fills", () => {
    const d = waveformPathD(new Float32Array([1, 1]), 40)
    // Two bins, full scale: usable height 38, so each half is 19 either side of
    // the midline at 20 — the top edge at 1, the bottom at 39. Points sit at
    // BIN CENTRES (0.5, 1.5).
    expect(d).toBe("M0.5 1L1.5 1L1.5 39L0.5 39Z")
  })

  it("puts points at bin CENTRES, not bin starts", () => {
    // The half-bin offset is why the envelope replaced bars cleanly: bars were
    // anchored at the bin's start, which made audio read early on screen.
    const d = waveformPathD(new Float32Array([1]), 40)
    expect(d).toContain("0")
    expect(waveformPathD(new Float32Array([1, 1]), 40).startsWith("M0.5 ")).toBe(true)
  })

  it("gives a silent bin a visible hairline rather than a gap", () => {
    // Silence inside a take is information — the gap between words. Drawing
    // nothing there would read as the take having stopped.
    const d = waveformPathD(new Float32Array([0, 0]), 40)
    expect(d).toBe("M0.5 19.5L1.5 19.5L1.5 20.5L0.5 20.5Z")
  })

  it("keeps a loud bin distinguishable from a quiet one", () => {
    const loud = waveformPathD(new Float32Array([0, 0, 1]), 40)
    const quiet = waveformPathD(new Float32Array([0, 0, 0]), 40)
    expect(loud).not.toBe(quiet)
  })

  it("covers the whole clip, so the viewBox can window it without a rebuild", () => {
    const d = waveformPathD(new Float32Array(320).fill(0.5), 40)
    // One M, 639 Ls (319 out + 320 back), one Z.
    expect((d.match(/L/g) ?? []).length).toBe(639)
    expect(d.endsWith("Z")).toBe(true)
  })

  it("does not depend on zoom at all — that is the point of the envelope", () => {
    // Bars needed a stride that changed with pixel width; this signature has no
    // width term, so a zoom glide cannot rebuild the path.
    expect(waveformPathD.length).toBe(2)
  })

  it("scales to the row height", () => {
    const tall = waveformPathD(new Float32Array([1]), 40)
    const short = waveformPathD(new Float32Array([1]), 18)
    expect(tall).not.toBe(short)
  })

  it("is total on empty peaks and nonsense heights", () => {
    expect(waveformPathD(new Float32Array(0), 40)).toBe("")
    expect(waveformPathD(new Float32Array([1]), 0)).toBe("")
    expect(waveformPathD(new Float32Array([1]), Number.NaN)).toBe("")
  })
})
