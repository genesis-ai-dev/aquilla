// AQU-2432 (Sam, Nov 9): following the recordings, a take dragged against a
// line NOBODY HAS RECORDED sets that line's room (never the take's place), and
// a line whose room is too narrow to draw — down to none — is drawn as a
// MARKER at the seam, so it is always possible to see that a line sits there.
// These pin what the takes row does: the drag it hands up, and the marker.

import { describe, it, expect, vi } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import { LINE_MARKER_TAB_PX } from "@/lib/timeline/line-markers"
import type { CellData } from "@/hooks/useCells"

const PX = 40
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`

type LineOpts = { takeMs?: number; recordingsOffsetMs?: number; roomMs?: number; hidden?: boolean; cellLabel?: string; ref?: string }

/** A book's line (no times), with a take on the main track or none. */
function bookLine(id: string, opts: LineOpts = {}): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(opts.takeMs != null ? { selectedAudioId: takeId(id) } : {}),
    ...(opts.roomMs != null ? { recordingsRoomMs: opts.roomMs } : {}),
    ...(opts.hidden ? { hidden: true } : {}),
    ...(opts.cellLabel ? { cellLabel: opts.cellLabel } : {}),
    ...(opts.ref ? { globalReferences: [opts.ref] } : {}),
    attachments: opts.takeMs != null
      ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: opts.takeMs, ...(opts.recordingsOffsetMs != null ? { recordingsOffsetMs: opts.recordingsOffsetMs } : {}) } }
      : {},
  } as unknown as CellData
}

/** a: a 5 s take · b: nobody has recorded it (4 s natural) · c: a 6 s take. */
const book = (b: LineOpts = {}, c: LineOpts = {}) => [bookLine("a", { takeMs: 5_000 }), bookLine("b", b), bookLine("c", { takeMs: 6_000, ...c })]

function renderLane(cells: CellData[], props: Partial<Parameters<typeof TargetAudioLane>[0]> = {}) {
  const layout = buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 4 })
  const recorded = cells.filter((c) => c.selectedAudioId)
  const items: TargetAudioItem[] = recorded.map((cell) => ({ cell, kind: "take" as const, audioId: takeId(cell.id) }))
  return renderWithTooltips(
    <TargetAudioLane
      validationRequirementAudio={1}
      pxPerSec={PX}
      viewStartSec={0}
      viewEndSec={100}
      selectedId={null}
      editable
      snapEnabled={false}
      onSelect={() => {}}
      layout={layout}
      items={items}
      emptyCells={cells.filter((c) => !c.selectedAudioId)}
      {...props}
    />,
  )
}

const left = (el: HTMLElement) => parseFloat(el.style.left)
const dragBy = (chip: HTMLElement, sec: number) => {
  fireEvent.pointerDown(chip, { clientX: 400, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 400 + sec * PX })
  fireEvent.pointerUp(window, { clientX: 400 + sec * PX })
}

const NO_ROOM = "Line 2 isn't recorded yet. It has no room here. Drag the next take later to give it room."

describe("dragging a take against a line nobody has recorded (AQU-2432, Nov 9)", () => {
  it("2 s earlier: the empty line's room is 2 s smaller, and nothing is stored on the take", () => {
    const onMoveTakeRooms = vi.fn()
    const onRetimeTarget = vi.fn()
    renderLane(book(), { onMoveTakeRooms, onRetimeTarget })
    dragBy(screen.getByTestId("tl-target-c"), -2)
    expect(onRetimeTarget).not.toHaveBeenCalled()
    expect(onMoveTakeRooms).toHaveBeenCalledTimes(1)
    expect(onMoveTakeRooms).toHaveBeenCalledWith({
      cellId: "c", audioId: takeId("c"), rooms: [{ cellId: "b", roomMs: 2_000 }], take: null,
    })
  })

  it("it stops when the line has no room left: the take sits at the end of the take before, never over it", () => {
    const onMoveTakeRooms = vi.fn()
    renderLane(book(), { onMoveTakeRooms, onRetimeTarget: vi.fn() })
    const c = screen.getByTestId("tl-target-c")
    fireEvent.pointerDown(c, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 - 10 * PX })
    // Held at 5 s, the end of line a's take, and not red: nothing overlaps.
    expect(c).toHaveAttribute("data-span-start", "5.000")
    expect(c).toHaveAttribute("data-overflow", "none")
    fireEvent.pointerUp(window, { clientX: 400 - 10 * PX })
    expect(onMoveTakeRooms).toHaveBeenCalledWith({
      cellId: "c", audioId: takeId("c"), rooms: [{ cellId: "b", roomMs: 0 }], take: null,
    })
  })

  it("later, with the room closed: the room comes back first, and only the rest is the take's own pause", () => {
    const onMoveTakeRooms = vi.fn()
    renderLane(book({ roomMs: 1_000 }), { onMoveTakeRooms, onRetimeTarget: vi.fn() })
    // 3 s of room is missing; dragged 5 s later.
    dragBy(screen.getByTestId("tl-target-c"), 5)
    const move = onMoveTakeRooms.mock.calls[0]![0]
    expect(move.rooms).toEqual([{ cellId: "b", roomMs: null }])
    expect(move.take.place.recordingsOffsetMs).toBe(2_000)
  })

  // AQU-2432 (review, Nov 9): an old pull-back on the dragged take reads as
  // none while the line before is empty, but stays stored and would come back
  // as an overlap once that line is recorded. The drag clears it, in its step.
  it("a take still holding an old pull-back is put back on its line's start in the same step", () => {
    const onMoveTakeRooms = vi.fn()
    renderLane(book({}, { recordingsOffsetMs: -1_000 }), { onMoveTakeRooms, onRetimeTarget: vi.fn() })
    dragBy(screen.getByTestId("tl-target-c"), -2)
    expect(onMoveTakeRooms).toHaveBeenCalledTimes(1)
    const move = onMoveTakeRooms.mock.calls[0]![0]
    expect(move.rooms).toEqual([{ cellId: "b", roomMs: 2_000 }])
    expect(move.take.place.recordingsOffsetMs).toBe(0)
  })

  it("a take whose line before is recorded moves exactly as before", () => {
    const onMoveTakeRooms = vi.fn()
    const onRetimeTarget = vi.fn()
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("c", { takeMs: 6_000 })]
    renderLane(cells, { onMoveTakeRooms, onRetimeTarget })
    dragBy(screen.getByTestId("tl-target-c"), -1)
    expect(onMoveTakeRooms).not.toHaveBeenCalled()
    expect(onRetimeTarget.mock.calls[0]![3]).toMatchObject({ recordingsOffsetMs: -1_000 })
  })

  it("where rooms cannot be saved, the take stops at its own line's start", () => {
    const onRetimeTarget = vi.fn()
    renderLane(book(), { onRetimeTarget })
    const c = screen.getByTestId("tl-target-c")
    fireEvent.pointerDown(c, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400 - 2 * PX })
    expect(c).toHaveAttribute("data-span-start", "9.000")
    fireEvent.pointerUp(window, { clientX: 400 - 2 * PX })
    expect(onRetimeTarget).not.toHaveBeenCalled()
  })
})

describe("the marker for a line with too little room (AQU-2432, Nov 9, rule 8)", () => {
  it("a line with no room is drawn at the seam: a dashed line the height of the row, with a dashed tab at its top", () => {
    renderLane(book({ roomMs: 0 }))
    const marker = screen.getByTestId("tl-line-marker-b")
    const tab = screen.getByTestId("tl-line-marker-b-tab")
    const rule = screen.getByTestId("tl-line-marker-b-line")
    // The seam is at 5 s; the tab is centred on it, the line exactly on it.
    expect(left(marker)).toBe(5 * PX - LINE_MARKER_TAB_PX / 2)
    expect(marker.style.width).toBe(`${LINE_MARKER_TAB_PX}px`)
    expect(marker.className).toContain("inset-y-0")
    expect(rule.className).toContain("border-dashed")
    expect(rule.className).toContain("inset-y-0")
    expect(rule.style.left).toBe(`${LINE_MARKER_TAB_PX / 2}px`)
    expect(tab.className).toContain("border-dashed")
    expect(tab.className).toContain("top-0")
    // The existing dashed look, in the row's own colour: no new colour.
    expect(tab.className).toContain("border-[color:var(--tl-track-hue)]")
    expect(rule.className).toContain("border-[color:var(--tl-track-hue)]")
  })

  it("it never moves its neighbours: the takes either side sit exactly where the layout puts them", () => {
    renderLane(book({ roomMs: 0 }))
    expect(left(screen.getByTestId("tl-target-a"))).toBe(0)
    expect(left(screen.getByTestId("tl-target-c"))).toBe(5 * PX)
    // Only the tab answers the pointer; the line through the row lets the
    // takes' own edges be grabbed.
    expect(screen.getByTestId("tl-line-marker-b").className).toContain("pointer-events-none")
    expect(screen.getByTestId("tl-line-marker-b-tab").className).toContain("pointer-events-auto")
  })

  it("hover or focus says which line, that it isn't recorded, and how to give it room; the same words are its name", async () => {
    renderLane(book({ roomMs: 0 }))
    const tab = screen.getByTestId("tl-line-marker-b-tab")
    expect(tab).toHaveAttribute("aria-label", NO_ROOM)
    await expectTooltip(tab, NO_ROOM)
  })

  it("a narrow room says how much it has", () => {
    renderLane(book({ roomMs: 200 }))
    expect(screen.getByTestId("tl-line-marker-b-tab")).toHaveAttribute(
      "aria-label",
      "Line 2 isn't recorded yet. It has only 0.2 s of room here. Drag the next take later to give it room.",
    )
  })

  it("it names the line by its reference when it has one", () => {
    renderLane(book({ roomMs: 0, ref: "GEN 1:3" }))
    expect(screen.getByTestId("tl-line-marker-b-tab").getAttribute("aria-label")).toMatch(/^Genesis 1:3 isn't recorded yet\./)
  })

  it("clicking it selects that line, as clicking its box would, and leaves the playhead where it is, as a click on a take does", () => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    renderLane(book({ roomMs: 0 }), { onSelect, onSeek })
    fireEvent.click(screen.getByTestId("tl-line-marker-b-tab"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("b")
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("the keyboard reaches it: it is a button, and Space still plays", () => {
    renderLane(book({ roomMs: 0 }))
    const tab = screen.getByTestId("tl-line-marker-b-tab")
    expect(tab.tagName).toBe("BUTTON")
    expect(tab).not.toHaveAttribute("tabindex", "-1")
    expect(tab).toHaveAttribute("data-spacebar-transport")
    tab.focus()
    expect(document.activeElement).toBe(tab)
  })

  it("the selected line's marker shows it is selected", () => {
    renderLane(book({ roomMs: 0 }), { selectedId: "b" })
    expect(screen.getByTestId("tl-line-marker-b")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("tl-line-marker-b-tab").className.split(" ")).toContain("ring-2")
  })

  it("a track made a layer has no seam to mark: no marker there", () => {
    renderLane(book({ roomMs: 0 }), { lineMarkers: false })
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
  })

  it("it shows to someone who cannot edit too", () => {
    renderLane(book({ roomMs: 0 }), { editable: false })
    expect(screen.getByTestId("tl-line-marker-b")).toBeInTheDocument()
  })

  it("a line the person has hidden stays hidden: no marker", () => {
    renderLane(book({ roomMs: 0, hidden: true }))
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
  })

  it("a line at its natural length, or with room for its usual box, has no marker — and keeps its record button", () => {
    const { unmount } = renderLane(book(), { onOpenRecording: vi.fn() })
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
    expect(screen.getByTestId("tl-target-empty-b")).toBeInTheDocument()
    unmount()
    renderLane(book({ roomMs: 2_000 }), { onOpenRecording: vi.fn() })
    expect(screen.queryByTestId("tl-line-marker-b")).toBeNull()
    expect(screen.getByTestId("tl-target-empty-b")).toBeInTheDocument()
  })

  it("the marker takes the place of the record button when the room is too narrow for both", () => {
    // 0.2 s is 8 px: wide enough for the old slot, narrower than the tab.
    renderLane(book({ roomMs: 200 }), { onOpenRecording: vi.fn() })
    expect(screen.getByTestId("tl-line-marker-b")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-target-empty-b")).toBeNull()
  })

  it("with a red overlap at the same seam, the tab keeps to the top of the row and the red mark stays where it is", () => {
    // a's 10 s take rings on under everything after it: b is pulled back 9 s
    // inside it; c has no room; d starts at 3 s, still under a's take.
    const cells = [
      bookLine("a", { takeMs: 10_000 }),
      bookLine("b", { takeMs: 2_000, recordingsOffsetMs: -9_000 }),
      bookLine("c", { roomMs: 0 }),
      bookLine("d", { takeMs: 3_000 }),
    ]
    renderLane(cells)
    const d = screen.getByTestId("tl-target-d")
    expect(d).toHaveAttribute("data-overflow", "overlap")
    expect(d.className).toContain("bg-red-100")
    const tab = screen.getByTestId("tl-line-marker-c-tab")
    // The tab lives in the band above the takes, so it never covers the red.
    expect(tab.className).toContain("top-0")
    expect(tab.className).toContain("h-[var(--tl-chip-top,10px)]")
    expect(left(screen.getByTestId("tl-line-marker-c"))).toBe(3 * PX - LINE_MARKER_TAB_PX / 2)
  })
})
