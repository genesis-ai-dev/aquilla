// AQU-2432 (Sam, Nov 9): the whole timeline, on a book that follows its
// recordings. A line whose room was closed shows its marker on the takes row
// and on its own text rows; a drag against a line nobody has recorded reaches
// the workspace as ONE move (the rooms, and the take's place when it changed).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { screen, fireEvent, within } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { TimelineEditor } from "./TimelineEditor"
import type { CellData } from "@/hooks/useCells"

const takeId = (id: string) => `audio-${id}-1700000000-take.wav`

function bookLine(id: string, opts: { takeMs?: number; roomMs?: number } = {}): CellData {
  return {
    id, fileId: "f1", original: `${id} words here`, translated: "", medium: "text",
    ...(opts.takeMs != null ? { selectedAudioId: takeId(id) } : {}),
    ...(opts.roomMs != null ? { recordingsRoomMs: opts.roomMs } : {}),
    attachments: opts.takeMs != null
      ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: opts.takeMs } }
      : {},
  } as unknown as CellData
}

const book = (roomMs?: number) => [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs }), bookLine("c", { takeMs: 6_000 })]
const px = (el: Element, prop: "left" | "width") => parseFloat((el as HTMLElement).style[prop])

function renderBook(cells: CellData[], props: Partial<Parameters<typeof TimelineEditor>[0]> = {}) {
  return renderWithTooltips(
    <TimelineEditor
      fileId="f1" coreMediaUrl={null} editable cells={cells} timingMode="audioFirst" sequenceOrdered
      onRetimeSubtitle={() => {}} onRetimeTarget={() => {}} onTrimTarget={() => {}}
      {...props}
    />,
  )
}

describe("a book following its recordings: an unrecorded line's room (AQU-2432, Nov 9)", () => {
  beforeEach(() => localStorage.clear())

  it("a line with no room: the take after it sits at the end of the take before it, and the line's marker is on the takes row", () => {
    renderBook(book(0))
    const a = screen.getByTestId("tl-target-a")
    const c = screen.getByTestId("tl-target-c")
    const perSec = px(a, "width") / 5
    expect(px(c, "left")).toBeCloseTo(5 * perSec, 0)
    const lane = screen.getByTestId("tl-target-lane")
    const marker = within(lane).getByTestId("tl-line-marker-b")
    // Centred on the seam between the two takes.
    expect(px(marker, "left") + px(marker, "width") / 2).toBeCloseTo(5 * perSec, 0)
    expect(within(lane).getByTestId("tl-line-marker-b-tab").getAttribute("aria-label")).toMatch(/isn't recorded yet\. It has no room here\./)
  })

  it("…and on the line's own text rows, in place of a box nobody could see", () => {
    renderBook(book(0))
    expect(screen.queryByTestId("tl-card-b")).toBeNull()
    expect(screen.getAllByTestId("tl-line-marker-b").length).toBeGreaterThan(1)
  })

  it("clicking the marker selects the line", () => {
    const onSelectedCellChange = vi.fn()
    renderBook(book(0), { onSelectedCellChange })
    fireEvent.click(within(screen.getByTestId("tl-target-lane")).getByTestId("tl-line-marker-b-tab"))
    expect(onSelectedCellChange).toHaveBeenLastCalledWith("b")
  })

  it("dragging the next take earlier against the empty line hands up ONE move: the line's room, nothing for the take", () => {
    const onMoveTakeRooms = vi.fn()
    const onRetimeTarget = vi.fn()
    renderBook(book(), { onMoveTakeRooms, onRetimeTarget })
    const c = screen.getByTestId("tl-target-c")
    const perSec = px(c, "width") / 6
    fireEvent.pointerDown(c, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 - perSec * 50 })
    fireEvent.pointerUp(window, { clientX: 400 - perSec * 50 })
    expect(onRetimeTarget).not.toHaveBeenCalled()
    expect(onMoveTakeRooms).toHaveBeenCalledTimes(1)
    expect(onMoveTakeRooms).toHaveBeenCalledWith({ cellId: "c", audioId: takeId("c"), rooms: [{ cellId: "b", roomMs: 0 }], take: null })
  })
})
