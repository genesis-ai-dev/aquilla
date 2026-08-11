// WHY these tests exist: the row has to read as ONE piece of audio that has
// been marked up, not as a row of clips — so the continuous bar underneath is
// pinned separately from the per-region rectangles on top. The windowing is
// pinned because a 70-minute file produces a couple of thousand regions and
// this row is the only one that draws the whole span.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SourceRegionLane } from "./SourceRegionLane"
import { deriveSourceRegions } from "@/lib/timeline/source-regions"

const map = deriveSourceRegions(
  [
    { id: "a", startTime: 10, endTime: 12 },
    { id: "b", startTime: 20, endTime: 22 },
  ],
  30,
)

function renderLane(over: Partial<React.ComponentProps<typeof SourceRegionLane>> = {}) {
  const onSeek = vi.fn()
  render(
    <SourceRegionLane
      map={map}
      pxPerSec={10}
      viewStartSec={0}
      viewEndSec={30}
      onSeek={onSeek}
      {...over}
    />,
  )
  return { onSeek }
}

describe("SourceRegionLane", () => {
  it("draws one continuous bar spanning the whole footage", () => {
    renderLane()
    // 30s × 10px/s — the audio does not stop where the last subtitle does.
    expect(screen.getByTestId("tl-source-band").style.width).toBe("300px")
  })

  it("marks the spoken stretches and leaves the silences plain", () => {
    renderLane()
    expect(screen.getAllByTestId("tl-source-region-cue")).toHaveLength(2)
    // Before the first line, between the two, and after the last.
    expect(screen.getAllByTestId("tl-source-region-gap")).toHaveLength(3)
  })

  it("positions a region at its own seconds", () => {
    renderLane()
    const cue = screen.getAllByTestId("tl-source-region-cue")[0]
    expect(cue.style.left).toBe("100px") // 10s
    expect(cue.style.width).toBe("20px") // 2s
  })

  it("says what a stretch is on hover, including that a silence is empty", () => {
    renderLane()
    expect(screen.getAllByTestId("tl-source-region-gap")[0]).toHaveAttribute(
      "title",
      "No subtitle here · 10.0s",
    )
    expect(screen.getAllByTestId("tl-source-region-cue")[0]).toHaveAttribute("title", "Subtitle · 2.0s")
  })

  it("names an overlap for what it is — the import's own doing", () => {
    const overlapped = deriveSourceRegions(
      [
        { id: "a", startTime: 0, endTime: 6 },
        { id: "b", startTime: 4, endTime: 10 },
      ],
      10,
    )
    renderLane({ map: overlapped, viewEndSec: 10 })
    expect(screen.getByTestId("tl-source-region-overlap")).toHaveAttribute(
      "title",
      "2 lines at once · 2.0s",
    )
  })

  it("draws only the stretches inside the window", () => {
    renderLane({ viewStartSec: 19, viewEndSec: 23 })
    // The [12,20] gap still touches the window, so it survives alongside
    // [20,22] and [22,30] — but the first cue and the leading gap do not.
    expect(screen.getAllByTestId("tl-source-region-cue")).toHaveLength(1)
    expect(screen.getAllByTestId("tl-source-region-gap")).toHaveLength(2)
  })

  it("clicking anywhere moves the playhead there", () => {
    const { onSeek } = renderLane()
    // happy-dom getBoundingClientRect is 0-origin, so clientX maps directly.
    fireEvent.click(screen.getByTestId("tl-source-regions"), { clientX: 150 })
    expect(onSeek).toHaveBeenCalledWith(15) // 150 / 10
  })

  it("never seeks to a negative second", () => {
    const { onSeek } = renderLane()
    fireEvent.click(screen.getByTestId("tl-source-regions"), { clientX: -40 })
    expect(onSeek).toHaveBeenCalledWith(0)
  })

  it("renders nothing but the bar when there is no band at all", () => {
    renderLane({ map: { regions: [], totalSec: 0 } })
    expect(screen.getByTestId("tl-source-band").style.width).toBe("0px")
    expect(screen.queryByTestId("tl-source-region-gap")).not.toBeInTheDocument()
  })
})
