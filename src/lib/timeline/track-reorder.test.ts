// WHY these tests exist: an off-by-one here does not crash, it drops the
// track one row away from where the user let go — the classic reorder bug, and
// one that reads as "the app moved it somewhere else on purpose". The pointer
// plumbing in TimelineEditor is deliberately thin so that everything capable of
// being wrong by a row is in these two pure functions instead.
//
// The two things pinned hardest are the drag-DOWN adjustment (an insertion
// boundary below the dragged row is one slot too low once that row is lifted
// out of the list) and `needsRenormalise` on neighbours that tie, which is the
// only one of its two triggers a real user can reach.

import { describe, expect, it } from "vitest"
import { orderForDrop, proposeDropIndex, type RowBound } from "./track-reorder"
import type { TimelineTrack } from "./tracks"

/** Four default-height rows: midpoints at 33, 99, 165 and 231. */
const ROWS: RowBound[] = [
  { top: 0, bottom: 66 },
  { top: 66, bottom: 132 },
  { top: 132, bottom: 198 },
  { top: 198, bottom: 264 },
]

const track = (id: string, order: number): TimelineTrack => ({
  id,
  kind: "target-audio",
  name: id,
  order,
  groupId: null,
})

/** Four rows one apart, the shape a freshly derived file has. */
const FOUR = [track("a", 0), track("b", 1), track("c", 2), track("d", 3)]

describe("proposeDropIndex", () => {
  it("stays put while the pointer is inside its own row", () => {
    expect(proposeDropIndex(1, 70, ROWS)).toBe(1)
    expect(proposeDropIndex(1, 130, ROWS)).toBe(1)
  })

  it("needs the pointer past the NEXT row's midpoint to move down one", () => {
    // The drag-down adjustment, isolated. At 98 the pointer has passed one
    // midpoint (33), so the insertion boundary is 1 — but row 0 is still
    // occupying slot 0, so boundary 1 is where it already is. Only at 100, past
    // row 1's midpoint, does the boundary become 2 and the destination 1.
    expect(proposeDropIndex(0, 98, ROWS)).toBe(0)
    expect(proposeDropIndex(0, 100, ROWS)).toBe(1)
  })

  it("does not apply that adjustment going up — the boundary IS the index", () => {
    // Above the dragged row's own slot nothing has been vacated below the
    // pointer, so the boundary needs no correction. Two pixels either side of
    // row 1's midpoint therefore land one row apart, with no dead zone.
    expect(proposeDropIndex(3, 98, ROWS)).toBe(1)
    expect(proposeDropIndex(3, 100, ROWS)).toBe(2)
    expect(proposeDropIndex(3, 32, ROWS)).toBe(0)
  })

  it("clamps the tail rather than proposing a slot that does not exist", () => {
    // Boundary 4 exists (below the last row); index 4 does not.
    expect(proposeDropIndex(0, 5000, ROWS)).toBe(3)
    expect(proposeDropIndex(2, -5000, ROWS)).toBe(0)
  })

  it("hit-tests measured midpoints, so a compact row is not half a tall one", () => {
    // Vertical zoom can leave rows at different heights mid-session, which is
    // exactly why this takes bounds instead of dividing by a row height.
    const mixed: RowBound[] = [
      { top: 0, bottom: 24 },
      { top: 24, bottom: 156 },
      { top: 156, bottom: 180 },
    ]
    expect(proposeDropIndex(2, 11, mixed)).toBe(0) // above 12, the first midpoint
    expect(proposeDropIndex(2, 13, mixed)).toBe(1) // between 12 and 90
    expect(proposeDropIndex(0, 91, mixed)).toBe(1) // past 90, minus the drag-down slot
  })

  it("stays put on an unmeasurable pointer or an empty gutter", () => {
    expect(proposeDropIndex(2, Number.NaN, ROWS)).toBe(2)
    expect(proposeDropIndex(2, 100, [])).toBe(2)
  })
})

describe("orderForDrop", () => {
  it("is a no-op when the row has not moved", () => {
    expect(orderForDrop(FOUR, 2, 2)).toBeNull()
  })

  it("takes the midpoint of the neighbours in the list WITHOUT the dragged row", () => {
    // a moves to index 2. Without it the list is b(1) c(2) d(3), so slot 2 sits
    // between c and d — never between b and c, which is what reading the
    // neighbours off the unmodified list would give.
    expect(orderForDrop(FOUR, 0, 2)).toEqual({ trackId: "a", order: 2.5, needsRenormalise: false })
  })

  it("goes one below the first row at the head, and renumbers nothing else", () => {
    expect(orderForDrop(FOUR, 2, 0)).toEqual({ trackId: "c", order: -1, needsRenormalise: false })
  })

  it("goes one below a first row that is already negative", () => {
    // Orders are sort keys, not indices: there is no floor to bump into, and
    // the head drop must not be special-cased to 0 or the row lands second.
    const negative = [track("a", -1), track("b", 0), track("c", 1)]
    expect(orderForDrop(negative, 2, 0)).toEqual({ trackId: "c", order: -2, needsRenormalise: false })
  })

  it("goes one above the last row at the tail", () => {
    expect(orderForDrop(FOUR, 0, 3)).toEqual({ trackId: "a", order: 4, needsRenormalise: false })
  })

  it("asks for a renormalise when the new neighbours share an order", () => {
    // The reachable trigger. b and c both sit at 1 — a state the merge's total
    // order exists to cope with — so there is no number strictly between them
    // and the midpoint lands ON both.
    const tied = [track("a", 0), track("b", 1), track("c", 1), track("d", 3)]
    expect(orderForDrop(tied, 0, 1)).toEqual({ trackId: "a", order: 1, needsRenormalise: true })
  })

  it("refuses an index that is not a row", () => {
    expect(orderForDrop(FOUR, -1, 2)).toBeNull()
    expect(orderForDrop(FOUR, 0, 4)).toBeNull()
    expect(orderForDrop([track("a", 0)], 0, 0)).toBeNull()
  })
})
