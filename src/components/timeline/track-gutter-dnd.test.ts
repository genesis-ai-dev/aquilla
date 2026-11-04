import { describe, expect, it } from "vitest"
import { buildTrackRows } from "@/lib/timeline/track-groups"
import { deriveTracksForFile } from "@/lib/timeline/tracks"
import {
  TIMELINE_ROOT_GROUP,
  adjustTrackDrop,
  canDragTrack,
  commitTrackReorder,
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
