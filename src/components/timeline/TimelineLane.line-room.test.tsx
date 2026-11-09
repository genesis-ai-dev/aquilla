// AQU-2432 (Sam, Nov 9, rule 8): the line's OWN rows. A line whose room was
// closed too narrow to draw its dashed box — down to none — is drawn there as
// the same marker the takes row shows, so the line never silently disappears
// from the rows that are its own (its box would be a sliver under the next
// line's box).

import { describe, it, expect, vi } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineLane } from "./TimelineLane"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import { LINE_MARKER_TAB_PX } from "@/lib/timeline/line-markers"
import type { CellData } from "@/hooks/useCells"

const PX = 40
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`

function bookLine(id: string, opts: { takeMs?: number; roomMs?: number; hidden?: boolean } = {}): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(opts.takeMs != null ? { selectedAudioId: takeId(id) } : {}),
    ...(opts.roomMs != null ? { recordingsRoomMs: opts.roomMs } : {}),
    ...(opts.hidden ? { hidden: true } : {}),
    attachments: opts.takeMs != null
      ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: opts.takeMs } }
      : {},
  } as unknown as CellData
}

const book = (b: Parameters<typeof bookLine>[1] = {}) => [bookLine("a", { takeMs: 5_000 }), bookLine("b", b), bookLine("c", { takeMs: 6_000 })]

function renderLane(cells: CellData[], props: Partial<Parameters<typeof TimelineLane>[0]> = {}) {
  const layout = buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 4 })
  return renderWithTooltips(
    <TimelineLane
      cells={cells}
      variant="subtitle"
      layout={layout}
      pxPerSec={PX}
      viewStartSec={0}
      viewEndSec={100}
      selectedId={null}
      editable
      retimable={false}
      onSelect={() => {}}
      onRetime={() => {}}
      {...props}
    />,
  )
}

describe("a line with too little room, in its own rows (AQU-2432, Nov 9)", () => {
  it("at its natural length it is its usual dashed box", () => {
    renderLane(book())
    const card = screen.getByTestId("tl-card-b")
    expect(card).toHaveAttribute("data-stand-in")
    expect(card.className).toContain("border-dashed")
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
  })

  it("with no room it is the marker at the seam, in place of a box nobody could see", () => {
    renderLane(book({ roomMs: 0 }))
    expect(screen.queryByTestId("tl-card-b")).toBeNull()
    const marker = screen.getByTestId("tl-line-marker-b")
    expect(parseFloat(marker.style.left)).toBe(5 * PX - LINE_MARKER_TAB_PX / 2)
    // Its neighbours' boxes are where the layout puts them.
    expect(parseFloat(screen.getByTestId("tl-card-c").style.left)).toBe(5 * PX)
  })

  it("a narrowed room still wide enough for its box keeps the box", () => {
    renderLane(book({ roomMs: 2_000 }))
    expect(screen.getByTestId("tl-card-b")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
  })

  it("clicking the marker selects the line and takes the playhead to it, as clicking its box does", () => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    renderLane(book({ roomMs: 0 }), { onSelect, onSeek })
    fireEvent.click(screen.getByTestId("tl-line-marker-b-tab"))
    expect(onSelect).toHaveBeenCalledWith("b")
    expect(onSeek).toHaveBeenCalledWith("b")
  })

  it("a hidden line stays as it was drawn: faded, and no marker", () => {
    renderLane(book({ roomMs: 0, hidden: true }))
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
    expect(screen.getByTestId("tl-card-b")).toHaveAttribute("data-hidden-line")
  })

  it("following the source there is no room and no marker", () => {
    const cells = book({ roomMs: 0 }).map((c, i) => ({ ...c, startTime: i * 4, endTime: i * 4 + 4 }) as CellData)
    renderWithTooltips(
      <TimelineLane
        cells={cells} variant="subtitle" layout={buildTimelineLayout("dubbing", cells, cells)}
        pxPerSec={PX} viewStartSec={0} viewEndSec={100} selectedId={null} editable retimable={false}
        onSelect={() => {}} onRetime={() => {}}
      />,
    )
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
    expect(screen.getByTestId("tl-card-b")).toBeInTheDocument()
  })
})
