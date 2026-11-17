// AQU-2432 (Sam, Nov 9, rule 8): a line whose room is too narrow to draw as
// its usual box — down to no room at all — is drawn as a MARKER at the seam,
// so it is always possible to see that a line sits there. These pin WHICH
// lines get one and WHERE it goes; the look is the lane's
// (components/timeline/EmptyLineMarker).

import { describe, expect, it } from "vitest"
import { buildProgramme } from "./programme"
import { emptyLineMarkers, LINE_MARKER_TAB_PX } from "./line-markers"
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

const markers = (cells: CellData[], pxPerSec = PX, view: [number, number] = [0, 1000]) =>
  emptyLineMarkers({
    cells,
    programme: buildProgramme(cells, { standInLenSec: () => 4 }),
    pxPerSec,
    viewStartSec: view[0],
    viewEndSec: view[1],
  })

describe("which lines get a marker", () => {
  it("a line with no room: one marker, at the seam between the takes either side", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 0 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells)).toEqual([
      { cell: cells[1], atPx: 200, tabLeftPx: 200 - LINE_MARKER_TAB_PX / 2, roomSec: 0, position: 2 },
    ])
  })

  it("a line whose room is narrower than the marker's tab: a marker in the middle of its room, saying how much it has", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 200 }), bookLine("c", { takeMs: 6_000 })]
    const [m] = markers(cells)
    expect(m.roomSec).toBeCloseTo(0.2, 5)
    expect(m.atPx).toBeCloseTo(204, 5) // 5.1 s
  })

  it("a narrowed room still wide enough for its usual box is drawn as that box: no marker", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 2_000 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells)).toEqual([])
  })

  it("…until the timeline is zoomed out far enough that it no longer fits, and back in again", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 2_000 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells, 4)).toHaveLength(1) // 2 s is 8 px
    expect(markers(cells, 400)).toHaveLength(0)
    // A line with no room has its marker at both zoom extremes.
    const closed = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 0 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(closed, 2)).toHaveLength(1)
    expect(markers(closed, 2_000)).toHaveLength(1)
  })

  // AQU-2432 (review, Nov 9): the marker stands in for the box only when the
  // SQUEEZE, not the zoom, is why the box cannot be drawn.
  it("zoomed far out, a line narrowed a little is drawn like its untouched neighbours, not as a marker", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 3_500 }), bookLine("b2"), bookLine("c", { takeMs: 6_000 })]
    // At 2 px a second: b's 3.5 s is 7 px, and its natural 4 s would be 8 px —
    // too narrow for the tab either way, like b2 beside it.
    expect(markers(cells, 2)).toEqual([])
    // At 3 px a second its natural length would be 12 px and its room is
    // 10.5 px: now the squeeze is why, so it is a marker.
    expect(markers(cells, 3).map((m) => m.cell.id)).toEqual(["b"])
    // No room at all is a marker at every zoom.
    expect(markers([bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 0 }), bookLine("c", { takeMs: 6_000 })], 0.5)).toHaveLength(1)
  })

  it("a line at its natural length never gets one, however far out the timeline is zoomed", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b"), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells, 1)).toEqual([])
  })

  it("a recorded line never gets one: its stored room is ignored", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { takeMs: 3_000, roomMs: 0 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells)).toEqual([])
  })

  it("a line the person has hidden stays hidden: no marker", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 0, hidden: true }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells)).toEqual([])
  })

  it("only the lines in view", () => {
    const cells = [bookLine("a", { takeMs: 5_000 }), bookLine("b", { roomMs: 0 }), bookLine("c", { takeMs: 6_000 })]
    expect(markers(cells, PX, [20, 30])).toEqual([])
    expect(markers(cells, PX, [4.9, 30])).toHaveLength(1)
  })
})

describe("at the very start of the file", () => {
  it("the tab stays on the timeline: it starts at the edge instead of hanging off it, and the line keeps its place", () => {
    const cells = [bookLine("a", { roomMs: 0 }), bookLine("b", { takeMs: 6_000 })]
    const [m] = markers(cells)
    expect(m.atPx).toBe(0)
    expect(m.tabLeftPx).toBe(0)
  })
})

describe("several markers at one seam", () => {
  it("their tabs sit side by side, in the lines' order, so each can be pointed at; each line keeps its own place", () => {
    const cells = [
      bookLine("a", { takeMs: 5_000 }),
      bookLine("b", { roomMs: 0 }),
      bookLine("c", { roomMs: 0 }),
      bookLine("d", { takeMs: 6_000 }),
    ]
    const [b, c] = markers(cells)
    expect([b.cell.id, c.cell.id]).toEqual(["b", "c"])
    expect([b.atPx, c.atPx]).toEqual([200, 200])
    expect(b.tabLeftPx).toBe(194)
    expect(c.tabLeftPx).toBe(194 + LINE_MARKER_TAB_PX)
    expect([b.position, c.position]).toEqual([2, 3])
  })
})
