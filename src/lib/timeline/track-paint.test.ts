// AQU-2492 (review of the dev merge, Nov 14): an Undo straight after a track
// move goes out in the same batch as the move, so the project read goes from
// "before" to "before" and never shows the moved place. The move's display
// overlay settles only on the moved place, so the row stayed drawn moved after
// its Undo. The Undo's write paints its own target into the same overlays, and
// the read that follows settles it.

import { describe, it, expect } from "vitest"
import { paintTrackWrites, unpaintTrackWrites, type TrackOverlays } from "./track-paint"
import { applyPendingOrders, applyPendingScopes, settledPendingOrders, settledPendingScopes } from "./track-reorder"
import type { TimelineTrack } from "./tracks"

const track = (id: string, order: number, groupId: string | null = null, kind: TimelineTrack["kind"] = "audio"): TimelineTrack =>
  ({ id, kind, name: id, order, groupId })

const EMPTY: TrackOverlays = { orders: new Map(), scopes: new Map(), newTracks: [] }

/** The rows as the workspace draws them: the read, then each overlay. */
function drawn(read: readonly TimelineTrack[], o: TrackOverlays): Array<[string, string | null, number]> {
  const known = new Set(read.map((t) => t.id))
  let tracks = [...read, ...o.newTracks.filter((t) => !known.has(t.id))]
  tracks = applyPendingOrders(tracks, o.orders)
  tracks = applyPendingScopes(tracks, o.scopes)
  return tracks.map((t) => [t.id, t.groupId ?? null, t.order])
}

/** What the workspace's settle effects leave once `read` arrives. */
function settle(read: readonly TimelineTrack[], o: TrackOverlays): TrackOverlays {
  const orders = new Map(o.orders)
  for (const id of settledPendingOrders(o.orders, read)) orders.delete(id)
  const scopes = new Map(o.scopes)
  for (const id of settledPendingScopes(o.scopes, read)) scopes.delete(id)
  const known = new Set(read.map((t) => t.id))
  return { orders, scopes, newTracks: o.newTracks.filter((t) => !known.has(t.id)) }
}

describe("an Undo's track write is drawn at once, and settles on the read that follows", () => {
  const before = [track("a", 0), track("b", 1), track("dubs", 2, null, "folder")]

  it("Move to folder, then Undo: the row is drawn back out of the folder, and nothing is left held", () => {
    // The move painted its place: b inside Dubs.
    const moved: TrackOverlays = { ...EMPTY, scopes: new Map([["b", { groupId: "dubs", order: 0 }]]) }
    expect(drawn(before, moved)).toContainEqual(["b", "dubs", 0])
    // Its Undo writes b's old place back.
    const undone = paintTrackWrites(moved, [{ trackId: "b", patch: { groupId: null, order: 1 } }], new Set(before.map((t) => t.id)))
    expect(drawn(before, undone)).toEqual(drawn(before, EMPTY))
    // The move and its Undo landed together: the read is "before" again.
    const after = settle(before, undone)
    expect(after.scopes.size).toBe(0)
    expect(after.orders.size).toBe(0)
  })

  it("a drag, then Undo: the row is drawn at its old rank, and nothing is left held", () => {
    const dragged: TrackOverlays = { ...EMPTY, orders: new Map([["a", 1.5]]) }
    const undone = paintTrackWrites(dragged, [{ trackId: "a", patch: { order: 0 } }], new Set(before.map((t) => t.id)))
    expect(drawn(before, undone)).toEqual(drawn(before, EMPTY))
    expect(settle(before, undone).orders.size).toBe(0)
  })

  it("Create folder from, then Undo: the new folder goes, and its members are drawn where they were", () => {
    const made: TrackOverlays = {
      orders: new Map(),
      scopes: new Map([["a", { groupId: "f1", order: 0 }], ["b", { groupId: "f1", order: 1 }]]),
      newTracks: [track("f1", 0, null, "folder")],
    }
    const undone = paintTrackWrites(made, [
      { trackId: "f1", patch: null },
      { trackId: "a", patch: { groupId: null, order: 0 } },
      { trackId: "b", patch: { groupId: null, order: 1 } },
    ], new Set(before.map((t) => t.id)))
    expect(drawn(before, undone)).toEqual(drawn(before, EMPTY))
    const after = settle(before, undone)
    expect(after).toEqual(EMPTY)
  })

  it("Redo of Create folder: the folder is drawn at once, before the read has it", () => {
    const redone = paintTrackWrites(EMPTY, [
      { trackId: "f1", patch: { kind: "folder", name: "Folder", order: 0 } },
      { trackId: "a", patch: { groupId: "f1", order: 0 } },
    ], new Set(before.map((t) => t.id)))
    expect(redone.newTracks.map((t) => [t.id, t.kind, t.name])).toEqual([["f1", "folder", "Folder"]])
    expect(drawn(before, redone)).toContainEqual(["a", "f1", 0])
  })

  it("a refused write takes its paint off, and leaves what it did not paint", () => {
    const held: TrackOverlays = { ...EMPTY, orders: new Map([["b", 4]]) }
    const changes = [
      { trackId: "a", patch: { order: 3 } },
      { trackId: "dubs", patch: { groupId: null, order: 9 } },
    ]
    const painted = paintTrackWrites(held, changes, new Set(before.map((t) => t.id)))
    const back = unpaintTrackWrites(painted, changes, new Set(before.map((t) => t.id)))
    expect(back.orders).toEqual(new Map([["b", 4]]))
    expect(back.scopes.size).toBe(0)
  })
})
