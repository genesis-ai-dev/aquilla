// WHY these tests exist: the row must look like an mp3 import's source row —
// the SAME TimelineCard chips, broken at the VTT timestamps — plus a dashed
// empty chip over each silence, because the silences are the point of the
// feature. The sub-0.2s gap rule is pinned because a real VTT carries 1–100ms
// rounding gaps between most consecutive cues, and a sliver chip at every one
// reads as dirt.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceRegionLane } from "./SourceRegionLane"
import { deriveSourceRegions } from "@/lib/timeline/source-regions"
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
    renderLane()
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

  it("says a silence is empty, in words, on hover", () => {
    renderLane()
    expect(screen.getAllByTestId("tl-source-gap")[0]).toHaveAttribute("title", "No subtitle here · 10.0s")
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
})
