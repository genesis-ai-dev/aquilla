import { describe, expect, it } from "vitest"
import { buildTrackRows } from "@/lib/timeline/track-groups"
import { deriveTracksForFile } from "@/lib/timeline/tracks"
import {
  TIMELINE_ROOT_GROUP,
  adjustTrackDrop,
  canDragTrack,
  commitTrackReorder,
  paintLaneShifts,
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
    expect(below.toPosition).toBe(2)
    expect(above.toPosition).toBe(1)
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
    shifts.set("source-audio", { y: 0, hidden: false, transition: slide, hold: true })
    paintLaneShifts(root, shifts)
    expect(lane.style.transform).toBe("translateY(0px)")
    shifts.delete("source-audio")
    shifts.delete("grp")
    paintLaneShifts(root, shifts)
    expect(lane.style.transform).toBe("")
    expect(member.style.transform).toBe("")
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
