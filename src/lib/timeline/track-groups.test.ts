// AQU-646 stage 2 — folders, and the display list they produce.
//
// The cases worth reading first are the cycle ones. They pass not because
// anything checks for a cycle but because a folder's own `groupId` is never
// read, so self-reference and mutual reference cannot be expressed. If someone
// later "improves" this into a graph walk, those are the tests that fail.

import { describe, expect, it } from "vitest"
import {
  blockEndRow,
  buildTrackRows,
  dragScope,
  folderIdsOf,
  folderMembers,
  FOLDER_DROP_INDENT_PX,
  folderReachInPx,
  orderForScopeAppend,
  resolveDropTarget,
  scopeSiblings,
  trackScope,
} from "./track-groups"
import { compareTracksBySeat, type TimelineTrack } from "./tracks"
import type { RowBound } from "./track-reorder"

function track(
  id: string,
  kind: TimelineTrack["kind"],
  order: number,
  groupId: string | null = null,
): TimelineTrack {
  return { id, kind, name: id, order, groupId }
}

/** Ids of the rendered rows, which is what almost every case asserts on. */
const ids = (tracks: readonly TimelineTrack[], collapsed?: ReadonlySet<string>) =>
  buildTrackRows(tracks, collapsed).map((r) => r.track.id)

const depths = (tracks: readonly TimelineTrack[], collapsed?: ReadonlySet<string>) =>
  buildTrackRows(tracks, collapsed).map((r) => r.depth)

describe("buildTrackRows — no folders", () => {
  it("passes the list through untouched", () => {
    const tracks = [
      track("source-subtitles", "source-subtitles", 0),
      track("source-audio", "source-audio", 2),
      track("target-audio", "target-audio", 3),
    ]
    expect(ids(tracks)).toEqual(["source-subtitles", "source-audio", "target-audio"])
    expect(depths(tracks)).toEqual([0, 0, 0])
  })

  // The state every existing project is in. Folders are the new thing; nothing
  // about the rows a dubbing file has always drawn may change.
  it("leaves a groupId naming nothing at the top level rather than hiding the track", () => {
    const tracks = [track("target-audio", "target-audio", 3), track("trk-a", "audio", 4, "gone")]
    expect(ids(tracks)).toEqual(["target-audio", "trk-a"])
  })
})

describe("buildTrackRows — folders", () => {
  const withFolder = () => [
    track("source-subtitles", "source-subtitles", 0),
    track("grp", "folder", 1),
    track("trk-a", "audio", 0, "grp"),
    track("trk-b", "audio", 1, "grp"),
    track("target-audio", "target-audio", 3),
  ]

  it("draws members indented under their folder", () => {
    expect(ids(withFolder())).toEqual(["source-subtitles", "grp", "trk-a", "trk-b", "target-audio"])
    expect(depths(withFolder())).toEqual([0, 0, 1, 1, 0])
  })

  it("hides members when the folder is collapsed, keeping the folder itself", () => {
    expect(ids(withFolder(), new Set(["grp"]))).toEqual(["source-subtitles", "grp", "target-audio"])
  })

  it("hands a folder row its members and collapse state, even while collapsed", () => {
    const rows = buildTrackRows(withFolder(), new Set(["grp"]))
    const folder = rows.find((r) => r.track.id === "grp")
    expect(folder?.collapsed).toBe(true)
    // The summary band draws from these, so they must survive collapsing.
    expect(folder?.members.map((m) => m.id)).toEqual(["trk-a", "trk-b"])
  })

  it("draws an empty folder — making one before filling it is normal", () => {
    const tracks = [track("grp", "folder", 1), track("target-audio", "target-audio", 3)]
    expect(ids(tracks)).toEqual(["grp", "target-audio"])
    expect(buildTrackRows(tracks)[0].members).toEqual([])
  })

  // REPOSITIONS, NEVER RE-SORTS. The incoming list is already in
  // compareTracksBySeat order, and that comparator exists because ties are a
  // reachable state. A second sort here could break a tie the other way, and
  // the symptom would be a row swapping places at the instant a drag is
  // released — the exact bug the shared comparator was written to prevent.
  it("keeps the arrival order of tied members instead of re-sorting them", () => {
    const tracks = [
      track("grp", "folder", 1),
      track("trk-z", "audio", 5, "grp"),
      track("trk-a", "audio", 5, "grp"),
    ]
    expect(ids(tracks)).toEqual(["grp", "trk-z", "trk-a"])
  })
})

describe("one level only, enforced by never reading a folder's own groupId", () => {
  it("keeps a folder that names ITSELF as its group at the top level", () => {
    const tracks = [track("grp", "folder", 1, "grp"), track("target-audio", "target-audio", 3)]
    expect(ids(tracks)).toEqual(["grp", "target-audio"])
    expect(depths(tracks)).toEqual([0, 0])
  })

  it("keeps two folders naming each other both at the top level", () => {
    const tracks = [track("a", "folder", 0, "b"), track("b", "folder", 1, "a")]
    expect(ids(tracks)).toEqual(["a", "b"])
    expect(depths(tracks)).toEqual([0, 0])
  })

  it("draws a folder inside a folder as a sibling, not a child", () => {
    const tracks = [
      track("outer", "folder", 0),
      track("inner", "folder", 1, "outer"),
      track("trk-a", "audio", 0, "inner"),
    ]
    // `inner` stays top-level (its own groupId is never read), and trk-a goes
    // under `inner` where it belongs. Nothing is lost and nothing recurses.
    expect(ids(tracks)).toEqual(["outer", "inner", "trk-a"])
    expect(depths(tracks)).toEqual([0, 0, 1])
  })

  it("never loses a track to any of those shapes", () => {
    const tracks = [
      track("a", "folder", 0, "b"),
      track("b", "folder", 1, "a"),
      track("c", "folder", 2, "c"),
      track("trk-a", "audio", 0, "a"),
      track("target-audio", "target-audio", 3),
    ]
    expect(ids(tracks).sort()).toEqual(["a", "b", "c", "target-audio", "trk-a"])
  })
})

describe("trackScope", () => {
  const folders = new Set(["grp"])

  it("puts a member in its folder's scope and everything else at the top", () => {
    expect(trackScope(track("trk-a", "audio", 0, "grp"), folders)).toBe("grp")
    expect(trackScope(track("trk-a", "audio", 0), folders)).toBeNull()
  })

  it("reads a groupId naming a non-folder as top level", () => {
    expect(trackScope(track("trk-a", "audio", 0, "target-audio"), folders)).toBeNull()
  })

  it("never asks a folder where it lives", () => {
    expect(trackScope(track("grp2", "folder", 0, "grp"), folders)).toBeNull()
  })
})

describe("dragScope — a drag reorders within one scope and never across", () => {
  const rows = () => [
    track("source-subtitles", "source-subtitles", 0),
    track("grp", "folder", 1),
    track("trk-a", "audio", 0, "grp"),
    track("trk-b", "audio", 1, "grp"),
    track("target-audio", "target-audio", 3),
  ]
  // Five rows, 20px each.
  const bounds = (n: number): RowBound[] =>
    Array.from({ length: n }, (_, i) => ({ top: i * 20, bottom: i * 20 + 20 }))

  it("dragging a top-level track offers only the top-level tracks", () => {
    const built = buildTrackRows(rows())
    const scope = dragScope(built, bounds(built.length), 0)
    expect(scope?.groupId).toBeNull()
    expect(scope?.tracks.map((t) => t.id)).toEqual(["source-subtitles", "grp", "target-audio"])
    expect(scope?.fromIndex).toBe(0)
  })

  it("dragging a folder member offers only its siblings", () => {
    const built = buildTrackRows(rows())
    const scope = dragScope(built, bounds(built.length), 2) // trk-a
    expect(scope?.groupId).toBe("grp")
    expect(scope?.tracks.map((t) => t.id)).toEqual(["trk-a", "trk-b"])
    expect(scope?.fromIndex).toBe(0)
  })

  // A FOLDER MOVES AS A BLOCK. Its hit-test extent has to be what the user sees
  // themselves picking up, or dropping "just below the folder" would read as
  // dropping above it while two member rows sat in between.
  it("gives a folder the extent of its whole open block", () => {
    const built = buildTrackRows(rows())
    const scope = dragScope(built, bounds(built.length), 1)
    // rows 1..3 are the folder and its two members: 20 → 80.
    expect(scope?.bounds[1]).toEqual({ top: 20, bottom: 80 })
  })

  it("gives a COLLAPSED folder just its own row — there is no block on screen", () => {
    const built = buildTrackRows(rows(), new Set(["grp"]))
    const scope = dragScope(built, bounds(built.length), 1)
    expect(scope?.bounds[1]).toEqual({ top: 20, bottom: 40 })
  })

  it("returns null when there is nothing to reorder against", () => {
    const only = buildTrackRows([track("grp", "folder", 0), track("trk-a", "audio", 0, "grp")])
    expect(dragScope(only, bounds(only.length), 1)).toBeNull() // the folder's only member
  })

  // The bounds are snapshotted from the live DOM; a row whose element could not
  // be measured yields a short array. Hit-testing against bounds that do not
  // line up with the rows would silently address the wrong track, which is the
  // failure shape that cost a debug cycle last round.
  it("refuses to hit-test against bounds that do not match the rows", () => {
    const built = buildTrackRows(rows())
    expect(dragScope(built, bounds(built.length - 1), 0)).toBeNull()
  })

  it("returns null for a row index that does not exist", () => {
    const built = buildTrackRows(rows())
    expect(dragScope(built, bounds(built.length), 99)).toBeNull()
  })

  // The lists dragScope hands to orderForDrop must be ascending, because that
  // is the precondition the midpoint arithmetic depends on. Scoping is what
  // makes it true: globally, this folder at 1 holding a member at 0 is not.
  it("hands out lists that are ascending by order, which global orders are not", () => {
    const built = buildTrackRows(rows())
    for (const from of [0, 2]) {
      const scope = dragScope(built, bounds(built.length), from)
      const orders = scope?.tracks.map((t) => t.order) ?? []
      expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    }
  })
})

describe("scopeSiblings — the same scoping, without needing measured bounds", () => {
  // The keyboard path (Alt+Arrow) reorders with no pointer and therefore no
  // bounds, and it MUST be confined to the same scope as the drag or the two
  // inputs to one implementation would disagree about what a move means.
  const rows = () =>
    buildTrackRows([
      track("source-subtitles", "source-subtitles", 0),
      track("grp", "folder", 1),
      track("trk-a", "audio", 0, "grp"),
      track("trk-b", "audio", 1, "grp"),
      track("target-audio", "target-audio", 3),
    ])

  it("scopes a top-level row and reports where its siblings render", () => {
    const scope = scopeSiblings(rows(), 0)
    expect(scope?.tracks.map((t) => t.id)).toEqual(["source-subtitles", "grp", "target-audio"])
    expect(scope?.rowIndexes).toEqual([0, 1, 4])
    expect(scope?.groupId).toBeNull()
  })

  it("scopes a folder member to its siblings", () => {
    const scope = scopeSiblings(rows(), 3) // trk-b
    expect(scope?.tracks.map((t) => t.id)).toEqual(["trk-a", "trk-b"])
    expect(scope?.rowIndexes).toEqual([2, 3])
    expect(scope?.fromIndex).toBe(1)
  })
})

describe("blockEndRow — where a drop line at the end of a scope goes", () => {
  const rows = () =>
    buildTrackRows([
      track("grp", "folder", 0),
      track("trk-a", "audio", 0, "grp"),
      track("trk-b", "audio", 1, "grp"),
      track("target-audio", "target-audio", 3),
    ])

  // Drawn above "the row after the block", the line would appear INSIDE the
  // folder it is meant to follow.
  it("runs an open folder's block to its last member", () => {
    expect(blockEndRow(rows(), 0)).toBe(2)
  })

  it("leaves an ordinary row as itself", () => {
    expect(blockEndRow(rows(), 3)).toBe(3)
  })

  it("leaves a collapsed folder as itself — there is no block on screen", () => {
    const collapsed = buildTrackRows(
      [track("grp", "folder", 0), track("trk-a", "audio", 0, "grp"), track("target-audio", "target-audio", 3)],
      new Set(["grp"]),
    )
    expect(blockEndRow(collapsed, 0)).toBe(0)
  })
})

describe("orderForScopeAppend", () => {
  const tracks = [
    track("grp", "folder", 1),
    track("trk-a", "audio", 0, "grp"),
    track("trk-b", "audio", 4, "grp"),
    track("target-audio", "target-audio", 3),
  ]

  it("puts a track below everything already in the folder", () => {
    expect(orderForScopeAppend(tracks, "grp")).toBe(5)
  })

  it("measures the TOP-LEVEL scope separately — the whole point of scoping", () => {
    // Top level holds orders 1 and 3; the folder's 4 must not be counted.
    expect(orderForScopeAppend(tracks, null)).toBe(4)
  })

  it("starts an empty folder at zero", () => {
    expect(orderForScopeAppend([track("grp", "folder", 1)], "grp")).toBe(0)
  })
})

describe("folderMembers", () => {
  it("lists what a delete would take with it", () => {
    const tracks = [
      track("grp", "folder", 1),
      track("trk-a", "audio", 0, "grp"),
      track("trk-b", "audio", 1, "grp"),
      track("trk-c", "audio", 0, "other"),
    ]
    expect(folderMembers(tracks, "grp").map((t) => t.id)).toEqual(["trk-a", "trk-b"])
  })

  it("does not count a folder that names this one as its group", () => {
    // A folder is never inside anything, so deleting `grp` cannot take `inner`
    // with it — `inner` is a sibling and stays.
    const tracks = [track("grp", "folder", 1), track("inner", "folder", 2, "grp")]
    expect(folderMembers(tracks, "grp")).toEqual([])
  })
})

describe("folderIdsOf", () => {
  it("names only the folders", () => {
    const tracks = [track("grp", "folder", 1), track("trk-a", "audio", 0), track("target-audio", "target-audio", 3)]
    expect([...folderIdsOf(tracks)]).toEqual(["grp"])
  })
})

// The rows arrive already sorted by the merge. This pins the composition rather
// than assuming it: sort as the merge does, THEN build rows, and check the
// result is what a reader would expect on screen.
describe("composed with the merge's own ordering", () => {
  it("draws a folder's block where the folder's own order puts it", () => {
    const seats = new Map([["target-audio", 0]])
    const tracks = [
      track("target-audio", "target-audio", 3),
      track("grp", "folder", 1),
      track("trk-a", "audio", 0, "grp"),
    ].sort(compareTracksBySeat(seats, 9))
    expect(ids(tracks)).toEqual(["grp", "trk-a", "target-audio"])
  })
})

// ── AQU-646 stage 2b: dragging into and out of a folder, Logic's way ────────
//
// Y picks the position, X picks the depth. These are the cases where the two
// axes disagree, which is the whole of the feature — and the `allowCrossing`
// ones are the permission gate, which has no other test anywhere.

describe("resolveDropTarget", () => {
  /** Subtitles, an open folder holding two tracks, then the dub row. */
  const tree = () => [
    track("source-subtitles", "source-subtitles", 0),
    track("grp", "folder", 1),
    track("trk-a", "audio", 0, "grp"),
    track("trk-b", "audio", 1, "grp"),
    track("target-audio", "target-audio", 3),
  ]
  const ROW = 20
  const bounds = (n: number): RowBound[] =>
    Array.from({ length: n }, (_, i) => ({ top: i * ROW, bottom: i * ROW + ROW }))
  /** A Y that sits just past the midpoint of row `i`, i.e. in the gap below it. */
  const belowRow = (i: number) => i * ROW + ROW - 1

  const at = (
    rows: ReturnType<typeof buildTrackRows>,
    fromRowIndex: number,
    contentY: number,
    indentX: number,
    allowCrossing = true,
  ) => resolveDropTarget(rows, bounds(rows.length), fromRowIndex, { contentY, indentX }, { allowCrossing })

  // ── Where the pointer's HEIGHT has already decided (Sam, 2026-08-25) ─────
  //
  // "If I take a row from inside a folder and just reorder it within the
  // folder… the option to unindent it is presented even when hovering within a
  // folder despite that not actually being an option. And then if I let go in
  // this improper state, the track jumps to below the folder and unindents."
  //
  // There is no legal top-level insertion point BETWEEN a folder's own rows, so
  // at those heights X must not get a vote.
  //
  // THREE members, not the two above, on purpose: with two, every boundary
  // between them is the dragged row's own position, so the resolver correctly
  // returns null for "you did not move it" and the interesting case cannot be
  // expressed at all.
  //   0 subtitles · 1 [folder] · 2 trk-a · 3 trk-b · 4 trk-c · 5 dub
  const deepTree = () => [
    track("source-subtitles", "source-subtitles", 0),
    track("grp", "folder", 1),
    track("trk-a", "audio", 0, "grp"),
    track("trk-b", "audio", 1, "grp"),
    track("trk-c", "audio", 2, "grp"),
    track("target-audio", "target-audio", 3),
  ]

  describe("a boundary inside a folder's run ignores the pointer's X", () => {
    it("keeps a member in its folder when hovering between two others", () => {
      const rows = buildTrackRows(deepTree())
      // trk-a down to between trk-b and trk-c, FAR LEFT — which used to read as
      // "take it out of the folder", and on release threw it below the folder.
      const target = at(rows, 2, belowRow(3), 0)
      expect(target?.groupId).toBe("grp")
      expect(target?.indicator.indent).toBe(true)
    })

    it("keeps a member in its folder when moving to the top of it", () => {
      const rows = buildTrackRows(deepTree())
      // trk-c up to just under the folder's heading, far left.
      const target = at(rows, 4, belowRow(1), 0)
      expect(target?.groupId).toBe("grp")
      expect(target?.indicator.indent).toBe(true)
    })

    // The SAME height from the right must agree — the answer is not "whatever X
    // says", it is "inside", from either direction.
    it("gives the same answer from the right", () => {
      const rows = buildTrackRows(deepTree())
      const left = at(rows, 2, belowRow(3), 0)
      const right = at(rows, 2, belowRow(3), 400)
      expect(left?.groupId).toBe(right?.groupId)
      expect(left?.indicator.indent).toBe(right?.indicator.indent)
    })

    // A track coming in from OUTSIDE cannot sit between two members either.
    // (It has to be reaching right to be on per-row boundaries at all — far
    // left still steps over the whole folder as one block, unchanged.)
    it("applies to a track dragged in from outside", () => {
      const rows = buildTrackRows(deepTree())
      expect(at(rows, 5, belowRow(3), 400)?.groupId).toBe("grp")
    })
  })

  // …and the ONE place both answers are real: past the folder's last member,
  // where "last inside it" and "first after it" are both things you might mean.
  describe("the folder's end edge is where X still chooses", () => {
    it("drops inside when reaching right", () => {
      const rows = buildTrackRows(deepTree())
      const target = at(rows, 5, belowRow(4), 400)
      expect(target?.groupId).toBe("grp")
      expect(target?.indicator.indent).toBe(true)
    })

    it("drops after the folder when staying left", () => {
      const rows = buildTrackRows(deepTree())
      // The subtitles row, from above the folder to below it, staying left.
      const target = at(rows, 0, belowRow(4), 0)
      expect(target?.groupId).toBeNull()
      expect(target?.indicator.indent).toBe(false)
    })

    // Which is also how a member LEAVES its folder by dragging: the bottom edge
    // is the exit, and it is the only height that offers one.
    it("lets a member out of its folder there", () => {
      const rows = buildTrackRows(deepTree())
      expect(at(rows, 2, belowRow(4), 0)?.groupId).toBeNull()
    })
  })

  it("offers no indent above a folder's heading", () => {
    const rows = buildTrackRows(deepTree())
    // Even reaching far right: the boundary is above the folder row, so there
    // is nothing to be inside of yet.
    const target = at(rows, 4, belowRow(0), 400)
    expect(target?.groupId).toBeNull()
    expect(target?.indicator.indent).toBe(false)
  })

  it("drops at the top level when the pointer stays left", () => {
    const rows = buildTrackRows(tree())
    // The dub row lifted ABOVE the folder — reaching left, so the folder is one
    // obstacle to step over rather than somewhere to go.
    const target = at(rows, 4, belowRow(0), 2)
    expect(target?.groupId).toBeNull()
    expect(target?.indicator.indent).toBe(false)
  })

  // Reaching LEFT, an open folder is hit-tested as a single block, so a track
  // cannot land in the middle of one it was only stepping past.
  it("steps over an open folder as one block when reaching left", () => {
    const rows = buildTrackRows(tree())
    // A Y inside the folder's members, but far left.
    expect(at(rows, 0, belowRow(2), 2)?.groupId).toBeNull()
  })

  // THE FEATURE. Same pointer height, further right, different meaning.
  it("drops INSIDE the folder when the pointer moves right", () => {
    const rows = buildTrackRows(tree())
    const target = at(rows, 4, belowRow(3), FOLDER_DROP_INDENT_PX + 4)
    expect(target?.groupId).toBe("grp")
    expect(target?.indicator.indent).toBe(true)
  })

  it("puts a track dropped right under the folder's heading first inside it", () => {
    const rows = buildTrackRows(tree())
    const target = at(rows, 4, belowRow(1), FOLDER_DROP_INDENT_PX + 4)
    expect(target?.groupId).toBe("grp")
    // Before trk-a (order 0), so under it.
    expect(target?.order).toBeLessThan(0)
  })

  // THE GATE, and it has no other test. A bare `{order}` write is ungated
  // because dragging shipped before the setting existed; crossing writes
  // `groupId` and is gated. With the setting off, the same gesture at the same
  // pixel must stay at the top level.
  it("refuses to cross when crossing is not allowed, at any X", () => {
    const rows = buildTrackRows(tree())
    // Subtitles dragged down past the folder. Reaching right WOULD put it
    // inside; with the setting off it must stay at the top level.
    expect(at(rows, 0, belowRow(3), FOLDER_DROP_INDENT_PX + 40, true)?.groupId).toBe("grp")
    for (const x of [0, FOLDER_DROP_INDENT_PX + 40]) {
      const target = at(rows, 0, belowRow(3), x, false)
      expect(target?.groupId, `x=${x}`).toBeNull()
      expect(target?.indicator.indent, `x=${x}`).toBe(false)
    }
  })

  it("…and equally refuses to let a member OUT while crossing is off", () => {
    const rows = buildTrackRows(tree())
    // trk-a (row 2) dragged to the very bottom, far left — would leave the
    // folder if it could.
    const target = at(rows, 2, belowRow(4), 0, false)
    expect(target?.groupId).toBe("grp")
  })

  it("lets a member out to the top level when crossing is allowed", () => {
    const rows = buildTrackRows(tree())
    const target = at(rows, 2, belowRow(4), 0, true)
    expect(target?.groupId).toBeNull()
  })

  // Folders do not nest — enforced by construction — so a dragged folder has no
  // depth to choose and X is not consulted at all.
  it("ignores X entirely when a FOLDER is being dragged", () => {
    const rows = buildTrackRows(tree())
    for (const x of [0, FOLDER_DROP_INDENT_PX + 40]) {
      const target = at(rows, 1, belowRow(4), x)
      expect(target?.groupId, `x=${x}`).toBeNull()
    }
  })

  // A closed folder is still somewhere to drop into, and its members are not on
  // screen — so the position comes from the folder ROW's member list, which
  // survives collapsing, rather than from rendered rows that do not exist.
  it("appends into a COLLAPSED folder", () => {
    const rows = buildTrackRows(tree(), new Set(["grp"]))
    expect(rows).toHaveLength(3)
    const target = at(rows, 2, belowRow(1), FOLDER_DROP_INDENT_PX + 4)
    expect(target?.groupId).toBe("grp")
    // Past trk-b's order of 1, i.e. appended rather than landing on 0.
    expect(target?.order).toBeGreaterThan(1)
  })

  it("returns null for a drop that would change nothing", () => {
    const rows = buildTrackRows(tree())
    // The dub row released in the gap it already occupies.
    expect(at(rows, 4, belowRow(4), 2)).toBeNull()
  })

  it("refuses to hit-test against bounds that do not match the rows", () => {
    const rows = buildTrackRows(tree())
    expect(
      resolveDropTarget(rows, bounds(rows.length - 1), 4, { contentY: 10, indentX: 0 }, { allowCrossing: true }),
    ).toBeNull()
  })

  it("stays put when the pointer cannot be measured", () => {
    const rows = buildTrackRows(tree())
    expect(at(rows, 4, Number.NaN, 0)).toBeNull()
  })

  it("reports an indicator that names a real row", () => {
    const rows = buildTrackRows(tree())
    const target = at(rows, 0, belowRow(4), 2)
    expect(target?.indicator.rowIndex).toBeGreaterThanOrEqual(0)
    expect(target?.indicator.rowIndex).toBeLessThan(rows.length)
  })
})

// AQU-646 stage 3c — how far right is "into the folder".
describe("folderReachInPx", () => {
  // Sam, 2026-08-24: "I find out if I drag to the left enough for it not to
  // place itself in the folder." The threshold used to be a flat 16px, sized to
  // match the 14px `pl-3.5` a member row is drawn with — a DRAWING measurement
  // pressed into service as a GESTURE one. On the 240px expanded gutter that
  // left 93% of the column meaning "drop inside", so a plain reorder needed the
  // pointer inside the leftmost 16px and the indent looked like it never
  // responded to sideways movement at all.
  it("splits the gutter down the middle, whatever width it is", () => {
    expect(folderReachInPx(240)).toBe(120)
    expect(folderReachInPx(200)).toBe(100)
  })

  // The collapsed strip is 56px, so half of it is 28 — still above the floor,
  // but the floor is what stops a future narrower strip collapsing the reorder
  // zone to nothing.
  it("never falls below the drawn indent", () => {
    expect(folderReachInPx(56)).toBe(28)
    expect(folderReachInPx(10)).toBe(FOLDER_DROP_INDENT_PX)
    expect(folderReachInPx(0)).toBe(FOLDER_DROP_INDENT_PX)
  })

  // The regression in one line: at 240px the old constant said "inside" for
  // essentially the whole column.
  it("leaves a real reorder zone on the wide gutter", () => {
    expect(folderReachInPx(240)).toBeGreaterThan(FOLDER_DROP_INDENT_PX * 4)
  })
})
