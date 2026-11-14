import { describe, expect, it } from "vitest"
import { buildTrackRows } from "@/lib/timeline/track-groups"
import { deriveTracksForFile } from "@/lib/timeline/tracks"
import type { DragEndEvent, DroppableContainer } from "@dnd-kit/core"
import {
  TIMELINE_ROOT_GROUP,
  adjustTrackDrop,
  canDragTrack,
  commitTrackReorder,
  dragGapForDrop,
  orderAboveClosedFolder,
  releasePlanFor,
  orderBesideFolder,
  orderToLeaveFolder,
  paintLaneShifts,
  folderDragEdge,
  shouldRetainTopDragGap,
  trackCollision,
  type TrackDragGap,
  type TrackLaneShift,
  type TrackPointerDrop,
} from "./track-gutter-dnd"

const rows = buildTrackRows(deriveTracksForFile(null))
const folded = buildTrackRows(deriveTracksForFile({
  trackOverrides: {
    grp: { kind: "folder", name: "Dubs", order: 4 },
    "target-audio": { groupId: "grp", order: 0 },
    "trk-es": { kind: "audio", name: "Spanish", groupId: "grp", order: 1, sourceTrackId: "source-subtitles" },
  },
}))

describe("commitTrackReorder", () => {
  it("writes the same sort key the keyboard move does, and a folder drop as a scope move", () => {
    const cases: { name: string; rows: typeof rows; drop: TrackPointerDrop; crossing: boolean; commit: ReturnType<typeof commitTrackReorder> }[] = [
      {
        name: "down one slot inside the root",
        rows,
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 1 },
        crossing: false,
        commit: { kind: "reorder", trackId: "source-subtitles", order: 2.5 },
      },
      {
        name: "released on its own slot",
        rows,
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 0 },
        crossing: true,
        commit: null,
      },
      {
        name: "into a folder, before its first member",
        rows: folded,
        drop: { kind: "regroup", trackId: "source-subtitles", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 0 },
        crossing: true,
        commit: { kind: "move", trackId: "source-subtitles", groupId: "grp", order: -1 },
      },
      {
        name: "into a folder between two members that share a number, at its end instead",
        rows: buildTrackRows(deriveTracksForFile({
          trackOverrides: {
            grp: { kind: "folder", name: "Dubs", order: 4 },
            "target-audio": { groupId: "grp", order: 0 },
            "trk-es": { kind: "audio", name: "Spanish", groupId: "grp", order: 0, sourceTrackId: "source-subtitles" },
          },
        })),
        drop: { kind: "regroup", trackId: "source-subtitles", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 1 },
        crossing: true,
        commit: { kind: "move", trackId: "source-subtitles", groupId: "grp", order: 1 },
      },
      {
        name: "into a folder is refused while track editing is off",
        rows: folded,
        drop: { kind: "regroup", trackId: "source-subtitles", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 0 },
        crossing: false,
        commit: null,
      },
      {
        name: "a folder cannot land inside a folder",
        rows: folded,
        drop: { kind: "regroup", trackId: "grp", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 0 },
        crossing: true,
        commit: null,
      },
      {
        name: "out of a folder onto the first root slot",
        rows: folded,
        drop: { kind: "regroup", trackId: "target-audio", fromGroup: "grp", group: TIMELINE_ROOT_GROUP, toPosition: 0 },
        crossing: true,
        commit: { kind: "move", trackId: "target-audio", groupId: null, order: -1 },
      },
      {
        name: "onto an open folder's heading, in at the top",
        rows: folded,
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 2 },
        crossing: true,
        commit: { kind: "move", trackId: "source-subtitles", groupId: "grp", order: -1 },
      },
      {
        name: "onto a folder's heading while track editing is off",
        rows: folded,
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 2 },
        crossing: false,
        commit: { kind: "reorder", trackId: "source-subtitles", order: 5 },
      },
      {
        name: "onto a closed folder, beside it rather than into it",
        rows: buildTrackRows(deriveTracksForFile({
          trackOverrides: {
            grp: { kind: "folder", name: "Dubs", order: 4 },
            "target-audio": { groupId: "grp", order: 0 },
            "trk-es": { kind: "audio", name: "Spanish", groupId: "grp", order: 1, sourceTrackId: "source-subtitles" },
          },
        }), new Set(["grp"])),
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 2 },
        crossing: true,
        commit: { kind: "reorder", trackId: "source-subtitles", order: 5 },
      },
      {
        name: "onto an empty folder, beside it until the rest-to-enter",
        rows: buildTrackRows(deriveTracksForFile({
          trackOverrides: { grp: { kind: "folder", name: "Dubs", order: 4 } },
        })),
        drop: { kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 3 },
        crossing: true,
        commit: { kind: "reorder", trackId: "source-subtitles", order: 5 },
      },
    ]
    for (const item of cases) {
      expect(commitTrackReorder(item.rows, item.drop, item.crossing), item.name).toEqual(item.commit)
    }
  })

  it("treats the lower half of a folder's last member as the end of the folder", () => {
    const overLast: TrackPointerDrop = {
      kind: "regroup",
      trackId: "source-subtitles",
      fromGroup: TIMELINE_ROOT_GROUP,
      group: "grp",
      toPosition: 1,
    }
    const below = adjustTrackDrop(folded, overLast, { y: 30, overTop: 0, overHeight: 40 })
    const above = adjustTrackDrop(folded, overLast, { y: 10, overTop: 0, overHeight: 40 })
    expect(below).toMatchObject({ kind: "regroup", toPosition: 2 })
    expect(above).toMatchObject({ kind: "regroup", toPosition: 1 })

    // …and the lower half of any OTHER member as the slot after it, so a
    // track still outside the folder can be aimed between two of its
    // members without first having to hover the next one.
    const overFirst: TrackPointerDrop = { ...overLast, toPosition: 0 }
    expect(adjustTrackDrop(folded, overFirst, { y: 30, overTop: 0, overHeight: 40 })).toMatchObject({ toPosition: 1 })
    expect(adjustTrackDrop(folded, overFirst, { y: 10, overTop: 0, overHeight: 40 })).toMatchObject({ toPosition: 0 })

    // Past the last member entirely — in the empty space under the folder —
    // the drop leaves the folder for the top level, just after it, so a
    // track dragged down through a folder comes out the other side in the
    // same drag instead of having to be dropped in and dragged back out.
    const belowFolder = adjustTrackDrop(folded, overLast, { y: 55, overTop: 0, overHeight: 40 })
    expect(belowFolder).toMatchObject({ kind: "regroup", group: TIMELINE_ROOT_GROUP })
    expect(commitTrackReorder(folded, belowFolder, true)).toEqual({
      kind: "reorder", trackId: "source-subtitles", order: 5,
    })

    // A folder first in the column, a track dragged up onto it from below.
    // The collision reads the folder where it lies, but the track has slid
    // it down by its own height: the pointer over the heading's old place is
    // over the slot above the folder. That slot, and the space above the
    // column, are the root before the folder, with no gap inside it and no
    // drop into it. The heading where it is drawn is still the way in.
    const folderFirst = buildTrackRows(deriveTracksForFile({
      trackOverrides: { grp: { kind: "folder", name: "Dubs", order: -1 }, "target-audio": { groupId: "grp", order: 0 } },
    }))
    const ontoHeading: TrackPointerDrop = { kind: "move", trackId: "source-audio", group: TIMELINE_ROOT_GROUP, toPosition: 0 }
    const folderAt = { overTop: 0, overHeight: 120, activeHeight: 72 }
    for (const y of [-20, 30]) {
      const aboveFolder = adjustTrackDrop(folderFirst, ontoHeading, { ...folderAt, y })
      expect(aboveFolder, `y ${y}`).toMatchObject({ kind: "regroup", group: TIMELINE_ROOT_GROUP, toPosition: 0 })
      expect(dragGapForDrop(folderFirst, aboveFolder, 72), `y ${y}`).toBeNull()
      expect(commitTrackReorder(folderFirst, aboveFolder, true), `y ${y}`).toEqual({
        kind: "reorder", trackId: "source-audio", order: orderBesideFolder(folderFirst, "grp", "above"),
      })
    }
    expect(adjustTrackDrop(folderFirst, ontoHeading, { ...folderAt, y: 90 })).toEqual(ontoHeading)
  })

  it("moves a folder above an open folder instead of snapping it back", () => {
    const twoFolders = buildTrackRows(deriveTracksForFile({
      trackOverrides: {
        a: { kind: "folder", name: "A", order: -1 },
        "target-audio": { groupId: "a", order: 0 },
        b: { kind: "folder", name: "B", order: 5 },
        "trk-es": { kind: "audio", name: "Spanish", groupId: "b", order: 0, sourceTrackId: "source-subtitles" },
      },
    }))
    const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height })
    const slot = (id: string, group: string, index: number) => ({
      id, key: id, disabled: false, node: { current: null }, rect: { current: null },
      data: { current: { group, sortable: { containerId: group, index, items: [] } } },
    }) as unknown as DroppableContainer
    const containers = [slot("a", TIMELINE_ROOT_GROUP, 0), slot("target-audio", "a", 0), slot("b", TIMELINE_ROOT_GROUP, 3), slot("trk-es", "b", 0)]
    const droppableRects = new Map([["a", box(0, 120)], ["target-audio", box(48, 72)], ["b", box(300, 120)], ["trk-es", box(348, 72)]])
    const collide = (activeId: string) => trackCollision({
      active: { id: activeId, data: { current: null }, rect: { current: { initial: null, translated: null } } },
      collisionRect: box(60, 120),
      droppableRects,
      droppableContainers: containers,
      pointerCoordinates: { x: 50, y: 80 },
    } as unknown as Parameters<typeof trackCollision>[0])
    // Over another folder's member, a folder aims at that folder; a track still goes in.
    expect(collide("b")[0]?.id).toBe("a")
    expect(collide("source-audio")[0]?.id).toBe("target-audio")

    const ontoA: TrackPointerDrop = { kind: "move", trackId: "b", group: TIMELINE_ROOT_GROUP, toPosition: 0 }
    const drop = adjustTrackDrop(twoFolders, ontoA, { y: 30, overTop: 0, overHeight: 120, activeHeight: 120 })
    expect(drop).toEqual(ontoA)
    expect(commitTrackReorder(twoFolders, drop, true)).toMatchObject({ kind: "reorder", trackId: "b" })
  })

  it("plans a scope drop as a hold carrying where the pointer left the row", () => {
    const event = {
      active: { id: "target-audio", rect: { current: { initial: { top: 200 } } } },
      over: null,
      delta: { x: 0, y: 130 },
    } as unknown as DragEndEvent
    // The remounted row in the new scope has no memory of the drag — this
    // visual top is what it rebuilds its glide home from.
    expect(releasePlanFor(event, "scope", null)).toMatchObject({
      mode: "hold", activeId: "target-audio", fromVisualTop: 330,
    })
    expect(releasePlanFor(event, false, null).mode).toBe("home")
  })

  it("paints a lane's shift onto every copy, and a member follows its folder", () => {
    const root = document.createElement("div")
    const lane = document.createElement("div")
    lane.setAttribute("data-tl-track-lane", "source-audio")
    const copy = document.createElement("div")
    copy.setAttribute("data-tl-track-lane", "source-audio")
    const member = document.createElement("div")
    member.setAttribute("data-tl-track-lane", "target-audio")
    member.setAttribute("data-tl-lane-group", "grp")
    root.append(lane, copy, member)
    const slide = "transform 180ms cubic-bezier(0.2, 0, 0, 1)"
    const shifts = new Map<string, TrackLaneShift>([
      ["source-audio", { y: -36, hidden: false, transition: slide, hold: true }],
      ["grp", { y: 48, hidden: false, transition: slide, hold: true }],
    ])
    paintLaneShifts(root, shifts)
    expect(lane.style.transform).toBe("translateY(-36px)")
    expect(copy.style.transform).toBe("translateY(-36px)")
    expect(lane.style.transition).toBe(slide)
    expect(member.style.transform).toBe("translateY(48px)")
    expect(member.style.transition).toBe(slide)
    // The member under the pointer reports its own shift with no curve, and
    // keeps none while its folder slides: borrowing the folder's made the
    // lane trail the pointer by the slide.
    shifts.set("target-audio", { y: -100, hidden: false, hold: true })
    paintLaneShifts(root, shifts)
    expect(member.style.transform).toBe("translateY(-52px)")
    expect(member.style.transition).toBe("")
    shifts.delete("target-audio")
    shifts.set("source-audio", { y: 0, hidden: false, transition: slide, hold: true })
    paintLaneShifts(root, shifts)
    expect(lane.style.transform).toBe("translateY(0px)")
    shifts.delete("source-audio")
    shifts.delete("grp")
    paintLaneShifts(root, shifts)
    expect(lane.style.transform).toBe("")
    expect(member.style.transform).toBe("")
  })

  it("leaves a folder from anywhere under it, and from above with no pause", () => {
    expect(orderToLeaveFolder(folded, "grp")).toBe(5)
    expect(orderBesideFolder(folded, "grp", "above")).toBe(3)
    expect(orderBesideFolder(folded, "missing", "below")).toBeNull()
    expect(folderDragEdge(100, 200, 40)).toBe("above")
    expect(folderDragEdge(100, 200, 150)).toBeNull()
    expect(folderDragEdge(100, 200, 201)).toBe("below")
    expect(folderDragEdge(100, 200, 900)).toBe("below")
    const closed = buildTrackRows(deriveTracksForFile({
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 4 },
        "target-audio": { groupId: "grp", order: 0 },
      },
    }), new Set(["grp"]))
    const ontoFolder = { kind: "move" as const, trackId: "source-audio", group: TIMELINE_ROOT_GROUP, toPosition: 2 }
    expect(orderAboveClosedFolder(closed, ontoFolder, 40, 100)).toEqual({ trackId: "source-audio", order: 3 })
    expect(orderAboveClosedFolder(closed, ontoFolder, 120, 100)).toBeNull()
    expect(orderAboveClosedFolder(folded, ontoFolder, 40, 100)).toBeNull()
  })

  it("opens a gap where a cross-folder drag would land, and nowhere for a same-list drag", () => {
    const H = 40
    // A member dragged above its folder: the whole folder block slides down
    // by the member's height, so the member has somewhere visible to land.
    const out = dragGapForDrop(folded, {
      kind: "regroup", trackId: "target-audio", fromGroup: "grp", group: TIMELINE_ROOT_GROUP, toPosition: 2,
    }, H)
    expect(out?.groupId).toBeNull()
    expect(out?.shifts.get("grp")).toBe(H)
    // The member left behind rides the block down while closing the vacated
    // slot: net still in flattened space, so the gutter subtracts the block.
    expect(out?.shifts.get("trk-es") ?? 0).toBe(0)

    // A root track dragged into the folder before its first member: the
    // members stay where they are and the folder heading slides up into the
    // vacated root slot — the gap opens between heading and first member.
    const into = dragGapForDrop(folded, {
      kind: "regroup", trackId: "source-subtitles", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 0,
    }, H)
    expect(into?.groupId).toBe("grp")
    expect(into?.shifts.get("grp")).toBe(-H)
    expect(into?.shifts.get("target-audio") ?? 0).toBe(0)

    // Onto an open folder's heading means the same landing, at the top.
    const heading = dragGapForDrop(folded, {
      kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 2,
    }, H)
    expect(heading?.groupId).toBe("grp")
    expect(heading?.boundary).toBe(into?.boundary)

    // Between the two members: the first member slides up into the vacated
    // root slot with the heading, the second stays — the gap opens between
    // them, and the boundary moves with the aim while the drag is still
    // in the air.
    const between = dragGapForDrop(folded, {
      kind: "regroup", trackId: "source-subtitles", fromGroup: TIMELINE_ROOT_GROUP, group: "grp", toPosition: 1,
    }, H)
    expect(between?.groupId).toBe("grp")
    expect(between?.boundary).toBe((into?.boundary ?? 0) + 1)
    expect(between?.shifts.get("grp")).toBe(-H)
    expect(between?.shifts.get("target-audio")).toBe(-H)
    expect(between?.shifts.get("trk-es") ?? 0).toBe(0)

    // A reorder inside one list is the sortable's own preview, not a gap.
    expect(dragGapForDrop(folded, {
      kind: "move", trackId: "source-subtitles", group: TIMELINE_ROOT_GROUP, toPosition: 1,
    }, H)).toBeNull()
    expect(dragGapForDrop(folded, { kind: "cancel" }, H)).toBeNull()
  })

  it("retains only the same track's top-level first gap above the column", () => {
    const topGap: Pick<TrackDragGap, "groupId" | "boundary"> & { trackId: string } = {
      trackId: "target-audio", groupId: null, boundary: 0,
    }
    const cases: {
      current: typeof topGap | null
      trackId: string
      pointerY: number | null
      columnTop: number | null
      expected: boolean
    }[] = [
      // The one hold: same track, top level, first boundary, pointer above.
      { current: topGap, trackId: "target-audio", pointerY: 99, columnTop: 100, expected: true },
      // At the column's top edge the pointer is back in the rows' world.
      { current: topGap, trackId: "target-audio", pointerY: 100, columnTop: 100, expected: false },
      { current: topGap, trackId: "target-audio", pointerY: 140, columnTop: 100, expected: false },
      // A different drag, a folder gap, or a later boundary is re-aimed freely.
      { current: topGap, trackId: "source-subtitles", pointerY: 99, columnTop: 100, expected: false },
      { current: { ...topGap, groupId: "grp" }, trackId: "target-audio", pointerY: 99, columnTop: 100, expected: false },
      { current: { ...topGap, boundary: 1 }, trackId: "target-audio", pointerY: 99, columnTop: 100, expected: false },
      // No gap yet, or no measured pointer/column, holds nothing.
      { current: null, trackId: "target-audio", pointerY: 99, columnTop: 100, expected: false },
      { current: topGap, trackId: "target-audio", pointerY: null, columnTop: 100, expected: false },
      { current: topGap, trackId: "target-audio", pointerY: 99, columnTop: null, expected: false },
    ]
    for (const { current, trackId, pointerY, columnTop, expected } of cases) {
      expect(shouldRetainTopDragGap(current, trackId, pointerY, columnTop)).toBe(expected)
    }
  })

  it("offers a drag when the track can change places", () => {
    const source = rows[0]
    expect(canDragTrack(source, rows, false)).toBe(true)
    expect(canDragTrack(folded[3], folded, false)).toBe(true)
    const alone = buildTrackRows(deriveTracksForFile({
      trackOverrides: {
        grp: { kind: "folder", name: "Dubs", order: 4 },
        "target-audio": { groupId: "grp", order: 0 },
      },
    }))
    const onlyMember = alone.find((row) => row.track.id === "target-audio")!
    expect(canDragTrack(onlyMember, alone, false)).toBe(false)
    expect(canDragTrack(onlyMember, alone, true)).toBe(true)
    const folder = alone.find((row) => row.track.kind === "folder")!
    expect(canDragTrack(folder, alone, true)).toBe(true)
  })
})
