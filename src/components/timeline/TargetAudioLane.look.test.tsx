// AQU-2235: the waveform look on the timeline's take chips (Sam, Oct 25,
// boards 51–53 of the Media Redesign canvas).
//
//   ground 12% · frame 1px at 26% · waveform 0.167 darker than its track
//   (Oct 28; it was oklch(0.55 0.14 <hue>) for every track) at 90%
//   playing: played ground 27% + waveform 90%, not yet 12% + waveform 30%,
//            a 1.5px line in the darkened hue
//   AI voice: the same values · muted track: the whole clip at 50%
//   corners 6px, 4px under 24px tall
//
// Driven through the lane's test seams (`peaksByAudioId`, `previewFactory`),
// as TargetAudioLane.waveform.test.tsx and the playhead suite are.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { RowMetricsContext } from "./useRowMetrics"
import { chipHeightPx, chipPadPx, ROW_H_MIN } from "@/lib/timeline/row-metrics"
import type { CellData } from "@/hooks/useCells"

const BINS = 320
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

function item(id = "c1", over: Partial<CellData> = {}, durationMs = 4000): TargetAudioItem {
  const takeId = `audio-${id}-1700000000-take.webm`
  const cell = {
    id, fileId: "f1", original: "", translated: "",
    medium: "media", startTime: 10, endTime: 20,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: "frontier-audio://take", durationMs },
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
    ...over,
  } as unknown as CellData
  return { cell, kind: "take", audioId: takeId }
}
const keyOf = (id = "c1") => `audio-${id}-1700000000-take.webm`
const peaks = (...ids: string[]) => new Map(ids.map((id) => [keyOf(id), new Float32Array(BINS).fill(0.5)]))

const base = {
  validationRequirementAudio: 1,
  pxPerSec: 40,
  viewStartSec: 0,
  viewEndSec: 100,
  selectedId: null,
  editable: true,
  snapEnabled: false,
  onSelect: () => {},
}

describe("the take look on a timeline chip", () => {
  it("publishes the look's colours on the lane, in the track's hue", () => {
    render(<TargetAudioLane {...base} color="azure" items={[item()]} />)
    const lane = screen.getByTestId("tl-target-lane").style
    expect(lane.getPropertyValue("--tl-track-ground")).toBe("rgba(36, 137, 235, 0.12)")
    expect(lane.getPropertyValue("--tl-track-frame")).toBe("rgba(36, 137, 235, 0.26)")
    expect(lane.getPropertyValue("--tl-track-played")).toBe("rgba(36, 137, 235, 0.27)")
    expect(lane.getPropertyValue("--tl-track-wave")).toBe("oklch(0.458 0.140 252.4)")
  })

  it("draws the waveform in the track's deep shade at 90%, with no hover lift", () => {
    render(<TargetAudioLane {...base} items={[item()]} peaksByAudioId={peaks("c1")} />)
    const svg = screen.getByTestId("tl-chip-waveform")
    expect(svg.getAttribute("class")).toContain("fill-[color:var(--tl-track-wave)]")
    expect(svg.getAttribute("class")).not.toContain("opacity-40")
    expect(svg.getAttribute("class")).not.toContain("group-hover/chip:opacity")
    expect(svg.style.opacity).toBe("0.9")
  })

  it("keeps the alarm's own colour on the red chip at fault", () => {
    const first = item("c1", {}, 12500) // [10, 22.5] — runs into the next chip
    const second = item("c2", { startTime: 20, endTime: 30 } as Partial<CellData>)
    render(<TargetAudioLane {...base} items={[first, second]} peaksByAudioId={peaks("c1", "c2")} />)
    const [offender, clean] = screen.getAllByTestId("tl-chip-waveform")
    expect(screen.getByTestId("tl-target-c1")).toHaveAttribute("data-overflow", "overlap")
    expect(offender.getAttribute("class")).toContain("fill-current")
    expect(clean.getAttribute("class")).toContain("fill-[color:var(--tl-track-wave)]")
  })

  it("draws a muted track's takes at half strength", () => {
    const { unmount } = render(<TargetAudioLane {...base} items={[item()]} />)
    expect(screen.getByTestId("tl-target-c1").className).not.toContain("opacity-50")
    unmount()
    render(<TargetAudioLane {...base} items={[item()]} muted />)
    expect(screen.getByTestId("tl-target-c1").className).toContain("opacity-50")
  })

  it("rounds 6px, and 4px on a clip under 24px tall", () => {
    const { unmount } = render(<TargetAudioLane {...base} items={[item()]} />)
    expect(screen.getByTestId("tl-target-c1").style.borderRadius).toBe("6px")
    unmount()
    const rowH = ROW_H_MIN
    const chipH = chipHeightPx(rowH) // 18
    render(
      <RowMetricsContext.Provider value={{ rowH, chipH, chipPad: chipPadPx(rowH) }}>
        <TargetAudioLane {...base} items={[item()]} />
      </RowMetricsContext.Provider>,
    )
    expect(chipH).toBeLessThan(24)
    expect(screen.getByTestId("tl-target-c1").style.borderRadius).toBe("4px")
  })
})

describe("the take look while it plays", () => {
  let rafQ: FrameRequestCallback[] = []
  beforeEach(() => {
    rafQ = []
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => (rafQ.push(cb), rafQ.length))
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())
  const frame = () => { const q = rafQ; rafQ = []; q.forEach((cb) => cb(0)) }

  function stub() {
    let pos: number | null = null
    let onEnded: (() => void) | undefined
    const handle = { stop: () => onEnded?.(), isPlaying: () => true, positionSec: () => pos, audible: true }
    const factory = () => ({
      prime: async () => "ready" as const,
      play: (_w: unknown, opts?: { onEnded?(): void }) => { onEnded = opts?.onEnded; return handle },
    })
    return { factory, setPos: (p: number | null) => { pos = p } }
  }
  const pressPlay = async () => {
    fireEvent.click(screen.getByTestId("tl-target-c1-play"))
    await act(async () => { await Promise.resolve() })
  }

  it("keeps the played part at 90% and drops the rest to 30%, split at the playhead", async () => {
    const s = stub()
    render(<TargetAudioLane {...base} items={[item()]} peaksByAudioId={peaks("c1")} previewFactory={s.factory} />)
    expect(screen.queryByTestId("tl-chip-waveform-unplayed")).toBeNull()
    await pressPlay()
    s.setPos(1)
    frame()
    const played = screen.getByTestId("tl-chip-waveform")
    const ahead = screen.getByTestId("tl-chip-waveform-unplayed")
    expect(played.style.opacity).toBe("0.9")
    expect(ahead.style.opacity).toBe("0.3")
    // Both halves split at the same `--tl-play-x` the ground's gradient uses.
    expect(played.style.clipPath).toContain("var(--tl-play-x")
    expect(ahead.style.clipPath).toContain("var(--tl-play-x")
    expect(screen.getByTestId("tl-target-c1").style.getPropertyValue("--tl-play-x")).toBe("40px")
  })

  it("draws the play line 1.5px wide in the track's darkened hue", async () => {
    const s = stub()
    render(<TargetAudioLane {...base} items={[item()]} previewFactory={s.factory} />)
    await pressPlay()
    const line = screen.getByTestId("tl-target-c1-playline")
    expect(line.className).toContain("w-[1.5px]")
    expect(line.className).toContain("bg-[color:var(--tl-track-line)]")
    expect(line.className).not.toContain("bg-white")
  })
})
