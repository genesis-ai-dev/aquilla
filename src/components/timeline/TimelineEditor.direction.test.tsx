// AQU-2340: the timeline runs left to right in every interface language, as
// every audio and video editor does, and the words inside it keep their own
// direction. In an Arabic or Urdu interface `<html dir="rtl">` used to reach
// into the timeline and flip its grid: the track names went to the right and
// the track column became a right-to-left scroller that opened at the far end,
// with a negative scroll position that the chip windowing read as a time before
// zero. Paint and scroll are the browser's; what is pinned here is the markup
// that decides them.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { TimelineEditor } from "./TimelineEditor"
import { deriveTracksForFile } from "@/lib/timeline/tracks"
import type { CellData } from "@/hooks/useCells"

const cell = (o: Partial<CellData>): CellData =>
  ({ fileId: "f1", original: "", translated: "", ...o }) as unknown as CellData

const cells = [
  cell({ id: "s1", original: "Simon, where are you going?", translated: "سمعان، إلى أين أنت ذاهب؟", medium: "text", startTime: 0, endTime: 4 }),
]
const tracks = deriveTracksForFile(null, { isSubtitleImport: true, hasMediaCells: false, hasAudioCues: false })

describe("the timeline stays left to right in a right-to-left interface (AQU-2340)", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.dir = "rtl"
  })
  afterEach(() => {
    document.documentElement.dir = ""
  })

  const renderTimeline = () =>
    render(
      <TimelineEditor fileId="f1" coreMediaUrl={null} editable cells={cells} tracks={tracks} onRetimeSubtitle={() => {}} />,
    )

  it("pins the grid of track names, ruler, chips and playhead left to right", () => {
    renderTimeline()
    const scroll = screen.getByTestId("tl-scroll")
    // The grid holds both columns; the track column and the ruler inherit it.
    const grid = scroll.parentElement as HTMLElement
    expect(grid.getAttribute("dir")).toBe("ltr")
    expect(grid.contains(screen.getByTestId("tl-ruler"))).toBe(true)
    expect(grid.contains(screen.getByTestId("tl-playhead"))).toBe(true)
    // Nothing between the grid and the track column sets a direction of its own.
    expect(scroll.closest("[dir]")).toBe(grid)
    // The track names' column comes first, so in a left-to-right grid it is on the left.
    expect(grid.firstElementChild).toBe(scroll.previousElementSibling)
  })

  it("lets the line text on the chips keep its own direction", () => {
    renderTimeline()
    const source = screen.getByText("Simon, where are you going?")
    const target = screen.getByText("سمعان، إلى أين أنت ذاهب؟")
    expect(source.getAttribute("dir")).toBe("auto")
    expect(target.getAttribute("dir")).toBe("auto")
  })

  it("lets the track names and the Tracks label keep their own direction", () => {
    renderTimeline()
    const gutter = screen.getByTestId("tl-scroll").previousElementSibling as HTMLElement
    for (const name of ["Source text", "Target text"]) {
      // The innermost span that holds the name (its row's line holds it too).
      const label = [...gutter.querySelectorAll("span")].find((s) => s.textContent === name && s.children.length === 0)
      expect(label, name).toBeDefined()
      expect(label!.getAttribute("dir"), name).toBe("auto")
    }
    const tracksLabel = [...screen.getByTestId("tl-corner").querySelectorAll("span")].find((s) => s.textContent === "Tracks")
    expect(tracksLabel?.getAttribute("dir")).toBe("auto")
  })
})
