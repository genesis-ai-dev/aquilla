// Waveforms on take chips. (AQU-646)
//
// A separate file from TargetAudioLane.test.tsx on purpose: that one is 1094
// lines of geometry contract and this feature must not disturb it.
//
// Everything here drives the `peaksByAudioId` seam, so there is no OPFS, no
// network, no AudioContext and no mocking at all — the loader is tested on its
// own in peaks-loader.test.ts and the maths in chip-waveform.test.ts. What is
// left to prove is the wiring: that the right window reaches the right chip.

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { RowMetricsContext } from "./useRowMetrics"
import { chipHeightPx, chipPadPx, ROW_H_MIN } from "@/lib/timeline/row-metrics"
import type { CellData } from "@/hooks/useCells"

const BINS = 320

function item(
  durationMs: number | undefined,
  trims: { trimStartMs?: number; trimEndMs?: number } = {},
  id = "c1",
): TargetAudioItem {
  const takeId = `audio-${id}-1700000000-take.wav`
  const cell = {
    id, fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: {
        type: "audio",
        url: `frontier-audio://audio-${id}-1700000000-take.wav`,
        ...(durationMs != null ? { durationMs } : {}),
        ...trims,
      },
    },
  } as unknown as CellData
  return { cell, kind: "take", audioId: takeId }
}

const base = {
  // AQU-490: required on the lane, so a missing threshold can never silently
  // read as one again.
  validationRequirementAudio: 1,
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

/** A full-scale clip, so every bar is the same known height. */
const peaks = (key: string) => new Map([[key, new Float32Array(BINS).fill(1)]])
const keyOf = (id = "c1") => `audio-${id}-1700000000-take.wav`

const wave = () => screen.queryByTestId("tl-chip-waveform")
const viewBox = () => wave()?.getAttribute("viewBox")

describe("the waveform reaches the chip", () => {
  it("draws inside the chip, under everything else on it", () => {
    render(
      <TargetAudioLane {...base} items={[item(10_000)]} peaksByAudioId={peaks(keyOf())} />,
    )
    const svg = wave()
    expect(svg).toBeTruthy()
    // It is the chip's background: first child, no pointer events, so the body
    // drag and both trim handles still get every event.
    expect(svg!.parentElement?.firstElementChild).toBe(svg)
    expect(svg!.getAttribute("class")).toContain("pointer-events-none")
    expect(svg!.querySelector("path")?.getAttribute("d")).toBeTruthy()
  })

  // AQU-2235 (board 54): the 46px clip carries a 14px name bar, so the
  // waveform is drawn in the 30px under it (46 less the 2px frame and the
  // bar), starting below the bar — never behind it.
  it("shows the whole clip when nothing is trimmed", () => {
    render(
      <TargetAudioLane {...base} items={[item(10_000)]} peaksByAudioId={peaks(keyOf())} />,
    )
    expect(viewBox()).toBe(`0 0 ${BINS} 30`)
    expect(wave()!.style.top).toBe("14px")
    expect(wave()!.style.height).toBe("30px")
  })

  it("skips the head margin a take is born with", () => {
    // 1s of head trim on a 10s clip = a tenth of the bins.
    render(
      <TargetAudioLane
        {...base}
        items={[item(10_000, { trimStartMs: 1000 })]}
        peaksByAudioId={peaks(keyOf())}
      />,
    )
    expect(viewBox()).toBe(`32 0 288 30`)
  })

  it("windows both ends when the take is trimmed at both", () => {
    render(
      <TargetAudioLane
        {...base}
        items={[item(10_000, { trimStartMs: 2000, trimEndMs: 8000 })]}
        peaksByAudioId={peaks(keyOf())}
      />,
    )
    expect(viewBox()).toBe(`64 0 192 30`)
  })
})

describe("the waveform refuses to lie about an unmeasured clip", () => {
  it("draws nothing when the clip's length was never measured", () => {
    // The chip still renders — dashed, with its `?` badge — it just has no
    // honest mapping from bins to seconds, and a waveform stretched over a
    // guessed width would make the guess look measured.
    render(<TargetAudioLane {...base} items={[item(undefined)]} peaksByAudioId={peaks(keyOf())} />)
    expect(screen.getByTestId("tl-target-c1")).toBeTruthy()
    expect(wave()).toBeNull()
  })

  it("draws nothing before its peaks have arrived", () => {
    render(<TargetAudioLane {...base} items={[item(10_000)]} peaksByAudioId={new Map()} />)
    expect(screen.getByTestId("tl-target-c1")).toBeTruthy()
    expect(wave()).toBeNull()
  })

  it("draws nothing at all when the lane was given no way to load peaks", () => {
    // Exactly the shape TargetAudioLane.test.tsx renders in: no projectId, no
    // session, no seam. Every one of its 1094 lines must keep passing.
    render(<TargetAudioLane {...base} items={[item(10_000)]} />)
    expect(wave()).toBeNull()
  })
})

describe("the waveform survives the compact row", () => {
  it("still draws at the 24px band, scaled to it", () => {
    // ROW_H_MIN gives an 18px chip — below the label gate, so the band has no
    // other content. The waveform is the only thing left worth showing.
    const rowH = ROW_H_MIN
    const chipH = chipHeightPx(rowH)
    render(
      <RowMetricsContext.Provider value={{ rowH, chipH, chipPad: chipPadPx(rowH) }}>
        <TargetAudioLane {...base} items={[item(10_000)]} peaksByAudioId={peaks(keyOf())} />
      </RowMetricsContext.Provider>,
    )
    expect(viewBox()).toBe(`0 0 ${BINS} ${chipH}`)
  })
})

describe("generated voices get one too", () => {
  it("draws for a TTS clip, which travels the identical attachment path", () => {
    const it0 = item(10_000)
    const generated: TargetAudioItem = { ...it0, kind: "generated" }
    render(
      <TargetAudioLane {...base} items={[generated]} peaksByAudioId={peaks(keyOf())} />,
    )
    expect(wave()).toBeTruthy()
    // The chip keeps saying which it is; only the hue and the icon differ.
    expect(screen.getByTestId("tl-target-c1").getAttribute("data-kind")).toBe("generated")
  })
})

// AQU-2664 (board 72): the waveform is drawn at the level the take plays, and
// an evened take's name bar says so.
describe("evening out on the clip (AQU-2664, board 72)", () => {
  function measured(extra: Record<string, unknown>): TargetAudioItem {
    const it_ = item(10_000)
    const att = it_.cell.attachments![it_.audioId] as unknown as Record<string, unknown>
    Object.assign(att, extra)
    return it_
  }
  const pathD = () => wave()!.querySelector("path")!.getAttribute("d")!
  /** The tallest point the path reaches above the middle line. */
  const height = () => {
    const ys = pathD().match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1)
    return Math.max(...ys) - Math.min(...ys)
  }

  it("draws a quiet take shorter, and taller once evened out", () => {
    const { unmount } = render(<TargetAudioLane {...base} items={[measured({ loudnessLufs: -27, truePeakDb: -12 })]} peaksByAudioId={peaks(keyOf())} />)
    const quiet = height()
    unmount()
    render(<TargetAudioLane {...base} items={[measured({ loudnessLufs: -27, truePeakDb: -12, evenTargetLufs: -16 })]} peaksByAudioId={peaks(keyOf())} />)
    expect(height()).toBeGreaterThan(quiet * 3)
  })

  it("puts ≈ on an evened take's name bar, and the amber mark on one that couldn't go all the way", () => {
    const { unmount } = render(<TargetAudioLane {...base} items={[measured({ loudnessLufs: -20, truePeakDb: -6, evenTargetLufs: -16 })]} />)
    const bar = screen.getByTestId("tl-target-c1-bar")
    const mark = screen.getByTestId("tl-target-c1-evened")
    expect(bar.contains(mark)).toBe(true)
    expect(mark).toHaveAttribute("title", "Evened out")
    expect(screen.queryByTestId("tl-target-c1-even-held")).toBeNull()
    unmount()
    render(<TargetAudioLane {...base} items={[measured({ loudnessLufs: -30.4, truePeakDb: -4, evenTargetLufs: -16 })]} />)
    const held = screen.getByTestId("tl-target-c1-even-held")
    expect(held).toHaveAttribute("title", "Not raised all the way")
    expect(held.className).toContain("text-amber-900")
    expect(screen.queryByTestId("tl-target-c1-evened")).toBeNull()
  })

  it("marks nothing on a take that isn't evened", () => {
    render(<TargetAudioLane {...base} items={[measured({ loudnessLufs: -20, truePeakDb: -6 })]} />)
    expect(screen.queryByTestId("tl-target-c1-evened")).toBeNull()
    expect(screen.queryByTestId("tl-target-c1-even-held")).toBeNull()
  })
})
