// WHY these tests exist: the row must look like an mp3 import's source row —
// the SAME TimelineCard chips, one per audio-VTT cue — plus a dashed empty chip
// over each silence, because the silences are the point of the feature. The
// sub-0.2s gap rule is pinned because a real VTT carries 1–100ms rounding gaps
// between most consecutive cues, and a sliver chip at every one reads as dirt.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceRegionLane } from "./SourceRegionLane"
import { deriveSourceRegions } from "@/lib/timeline/source-regions"
import { chipRadiusPx } from "@/lib/timeline/scale"
import type { CellData } from "@/hooks/useCells"

const cell = (id: string, startTime: number, endTime: number, original = id): CellData =>
  ({ id, fileId: "f1", original, translated: "", medium: "text", startTime, endTime }) as unknown as CellData

const cells = [cell("a", 10, 12, "First line"), cell("b", 20, 22, "Second line")]
const map = deriveSourceRegions(cells, 30)

function renderLane(over: Partial<React.ComponentProps<typeof SourceRegionLane>> = {}) {
  const onSelect = vi.fn()
  const onSeek = vi.fn()
  const onSeekSec = vi.fn()
  render(
    <SourceRegionLane
      map={map}
      cells={cells}
      pxPerSec={10}
      viewStartSec={0}
      viewEndSec={30}
      selectedId={null}
      editable
      onSelect={onSelect}
      onSeek={onSeek}
      onSeekSec={onSeekSec}
      {...over}
    />,
  )
  return { onSelect, onSeek, onSeekSec }
}

describe("SourceRegionLane", () => {
  it("draws each cue as the SAME card an mp3 import's source row uses", () => {
    // Zoomed IN relative to the rest of this file: at the default 10px/s these
    // 2s cues are 20px wide, and round 9 stopped a card that narrow from
    // rendering text at all. The point of this test is the card's identity, so
    // it asks at a width where a card has something to say.
    renderLane({ pxPerSec: 40 })
    const cards = screen.getAllByTestId(/^tl-card-/)
    expect(cards).toHaveLength(2)
    // TimelineCard's dialogue variant shows the cell's text, like a transcript.
    expect(screen.getByText("First line")).toBeInTheDocument()
    expect(screen.getByText("Second line")).toBeInTheDocument()
  })

  it("positions a cue card at the cell's own seconds", () => {
    renderLane()
    const card = screen.getByTestId("tl-card-a")
    expect(card.style.left).toBe("100px") // 10s × 10px/s
    expect(card.style.width).toBe("20px") // 2s
  })

  it("draws a dashed empty chip over each silence — before, between, after", () => {
    renderLane()
    const gaps = screen.getAllByTestId("tl-source-gap")
    expect(gaps.map((g) => [Number(g.getAttribute("data-region-start")), Number(g.getAttribute("data-region-end"))])).toEqual([
      [0, 10],
      [12, 20],
      [22, 30],
    ])
    expect(gaps[0].className).toContain("border-dashed")
  })

  // Stage 2: "no speech", not "no subtitle". These gaps come from a transcript
  // of the soundtrack, so they say nobody was talking — a subtitle may well sit
  // over one, and on a real episode plenty do.
  it("says a silence is empty, in words, on hover", () => {
    renderLane()
    expect(screen.getAllByTestId("tl-source-gap")[0]).toHaveAttribute("title", "No speech here · 10.0s")
  })

  it("marks itself as the audio-cue row in the DOM", () => {
    renderLane()
    expect(screen.getByTestId("tl-source-regions")).toHaveAttribute("data-variant", "source-audio-cues")
  })

  it("skips a chip for the millisecond rounding gaps between consecutive cues", () => {
    const tight = [cell("a", 0, 5), cell("b", 5.05, 10)] // 50ms gap
    const tightMap = deriveSourceRegions(tight, 10)
    renderLane({ map: tightMap, cells: tight, viewEndSec: 10 })
    expect(screen.queryByTestId("tl-source-gap")).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^tl-card-/)).toHaveLength(2)
  })

  it("clicking a cue card selects and navigates, like any other lane", () => {
    const { onSelect, onSeek } = renderLane()
    fireEvent.click(screen.getByTestId("tl-card-a"))
    expect(onSelect).toHaveBeenCalledWith("a")
    expect(onSeek).toHaveBeenCalledWith("a")
  })

  // Round 8: this used to seek to wherever the pointer landed. Being dropped at
  // an arbitrary second inside a stretch that means "nothing is said here" told
  // you nothing; the start of the silence is the only second in it worth naming
  // and it is where you would begin listening.
  it("clicking a silence seeks to its START, not to the pointer", () => {
    const { onSeekSec, onSelect } = renderLane()
    // The middle gap spans 12–20s at 10px/s. Click well inside it.
    fireEvent.click(screen.getAllByTestId("tl-source-gap")[1], { clientX: 30 })
    expect(onSeekSec).toHaveBeenCalledWith(12)
    // A silence is not a thing you can select, so nothing gains a ring.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("windows both cards and gap chips to the visible range", () => {
    renderLane({ viewStartSec: 19, viewEndSec: 23 })
    expect(screen.getAllByTestId(/^tl-card-/)).toHaveLength(1) // "b" only
    // The [12,20] and [22,30] gaps both touch the window; [0,10] does not.
    expect(screen.getAllByTestId("tl-source-gap")).toHaveLength(2)
  })

  it("the trailing silence runs to the end of the footage", () => {
    renderLane()
    const gaps = screen.getAllByTestId("tl-source-gap")
    const last = gaps[gaps.length - 1]
    expect(Number(last.getAttribute("data-region-end"))).toBe(30)
    expect(last.style.width).toBe("80px") // 22→30s × 10px/s
  })

  it("marks the selected cue exactly as other lanes do", () => {
    renderLane({ selectedId: "a" })
    expect(screen.getByTestId("tl-card-a").className).toContain("ring-2")
  })

  it("renders nothing when there is neither footage nor timing", () => {
    renderLane({ map: { regions: [], totalSec: 0 }, cells: [] })
    expect(screen.queryByTestId(/^tl-card-/)).not.toBeInTheDocument()
    expect(screen.queryByTestId("tl-source-gap")).not.toBeInTheDocument()
  })

  // Round 9: the gap's time range is absolutely positioned with NO right
  // anchor, so at a narrow width it shrink-to-fits, wraps onto several lines,
  // and `bottom-1` pushes them up out of the 46px chip where overflow-hidden
  // slices them mid-glyph. Fully zoomed out that read as ranges bleeding across
  // neighbouring chips.
  it("a narrow gap chip shows no time range, and never wraps when it does", () => {
    const cells = [cell("a", 0, 5), cell("b", 6, 10)]
    const map = deriveSourceRegions(cells, 10)
    // 1s gap at 20px/s = 20px — nowhere near a clock string.
    renderLane({ map, cells, pxPerSec: 20, viewStartSec: 0, viewEndSec: 10 })
    const narrow = screen.getAllByTestId("tl-source-gap")[0]
    expect(narrow.textContent).toBe("")
  })

  it("a wide gap chip shows its range, on one line", () => {
    const cells = [cell("a", 0, 5), cell("b", 12, 16)]
    const map = deriveSourceRegions(cells, 16)
    // 7s gap at 40px/s = 280px.
    renderLane({ map, cells, pxPerSec: 40, viewStartSec: 0, viewEndSec: 16 })
    const wide = screen.getAllByTestId("tl-source-gap").find((g) => g.textContent !== "")!
    expect(wide.textContent).toContain("–")
    expect(wide.querySelector("span")!.className).toContain("whitespace-nowrap")
  })

  // Round 9b: the illusion Sam reported lived exactly here — a narrow silence
  // flush against a solid-walled cue, both carrying an 8px corner, reading as
  // one interlocked shape with a solid wall and a dashed wall.
  it("a narrow silence sharpens its corners; a wide one keeps them", () => {
    const cs = [cell("a", 0, 5), cell("b", 6, 10), cell("c", 30, 34)]
    const m = deriveSourceRegions(cs, 34)
    renderLane({ map: m, cells: cs, pxPerSec: 20, viewStartSec: 0, viewEndSec: 34 })
    const gaps = screen.getAllByTestId("tl-source-gap")
    const byStart = (start: string) => gaps.find((g) => g.getAttribute("data-region-start") === start)!
    // 5→6s = 1s at 20px/s = 20px wide; 10→30s = 400px wide.
    const narrow = parseFloat(byStart("5").style.borderRadius)
    const wide = parseFloat(byStart("10").style.borderRadius)
    expect(narrow).toBeCloseTo(chipRadiusPx(20), 3)
    expect(wide).toBe(8)
    expect(narrow).toBeLessThan(wide)
  })
})
