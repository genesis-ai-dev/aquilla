// AQU-2495 (review, Nov 9): the part of a take trimmed off its start is never
// heard, so it may sit before the start of the file. Only the take's SOUND may
// not. Before this the stored place was floored so the clip's sample zero
// stayed at or after file zero:
//   - following the recordings on a timed file, a music take with 45 s trimmed
//     off its start, dropped on a line that starts 12 s into the source file
//     but 1:00 on the timeline, was stored 33 s late and sprang to 1:33;
//   - following the source, the same take could not sit anywhere before 0:45.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout, type TimelineLayout } from "./layout"
import { targetOffsetMsFor } from "./lane-timing"
import { clampMoveStart, movedStartSec, movedTakePlace, type PlacedTake } from "./take-place"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"

type Take = {
  durationMs?: number
  trimStartMs?: number
  trimEndMs?: number
  targetOffsetMs?: number
  recordingsOffsetMs?: number
}
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
const trackId = (id: string) => `audio-${id}-1700000500-track.wav`

function line(id: string, startTime: number, endTime: number, take?: Take, track?: Take): CellData {
  return {
    id, fileId: "f1", original: id, translated: "", medium: "media", startTime, endTime,
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    ...(track ? { selectedBySlot: { [TRACK]: trackId(id) } } : {}),
    attachments: {
      ...(take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {}),
      ...(track ? { [trackId(id)]: { type: "audio", url: "frontier-audio://track", slot: TRACK, ...track } } : {}),
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
  } as unknown as CellData
}

/** Music on a layer track: 3 minutes, its first 45 s trimmed off. */
const SONG: Take = { durationMs: 180_000, trimStartMs: 45_000 }

/**
 * A sermon. Line 1 is 0–12 s in the source file and its take is a minute
 * long, so following the recordings line 2 (12–20 s in the file) starts at
 * 1:00. The song is on line 2, on a track made a layer.
 */
const sermon = (song: Take = SONG) => [
  line("l1", 0, 12, { durationMs: 60_000 }),
  line("l2", 12, 20, { durationMs: 5_000 }, song),
  line("l3", 20, 30, { durationMs: 5_000 }),
]
const TRACKS = { layerSlots: [TRACK], layerTrackSlots: [TRACK] }
const layouts = (cells: CellData[], tracks: object = TRACKS) => ({
  source: buildTimelineLayout("dubbing", cells, cells, null, tracks),
  recordings: buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 1, ...tracks }),
})
const song = (cells: CellData[]): PlacedTake => ({ cell: cells[1], audioId: trackId("l2") })
const startOf = (layout: TimelineLayout, take: PlacedTake) =>
  layout.targetGeom(take.cell, take.cell.attachments?.[take.audioId], take.audioId)!.start

/** Drop the take's sound at `toSec` on `here`'s clock, as the lane does: the
 *  lane's own move clamp first, then the place in both timings. */
function dropAt(here: TimelineLayout, other: TimelineLayout, take: PlacedTake, toSec: number) {
  const from = startOf(here, take)
  return movedTakePlace({ here, other, track: [take], take, fromStartSec: from, toStartSec: movedStartSec(here, [take], take, toSec - from)! })
}
const withPlace = (place: { targetOffsetMs: number; recordingsOffsetMs: number }) => sermon({ ...SONG, ...place })

describe("a take with its start trimmed off, moved (AQU-2495)", () => {
  it("following the recordings on a timed file: dropped on its line's start, it stays there", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    // Line 2 starts a minute in; unplaced, the song's sound starts 45 s later.
    expect(recordings.programme!.byCellId.get("l2")!.startSec).toBe(60)
    const moved = dropAt(recordings, source, song(cells), 60)!
    // Its clip's start goes 45 s before the line's — not the 12 s the file clock has room for.
    expect(moved.place.recordingsOffsetMs).toBe(-45_000)
    const after = withPlace(moved.place)
    expect(startOf(layouts(after).recordings, song(after))).toBe(60)
  })

  it("…and the same distance following the source, where it now reaches its line too", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    const moved = dropAt(recordings, source, song(cells), 60)!
    expect(moved.place.targetOffsetMs).toBe(-45_000)
    const after = withPlace(moved.place)
    expect(startOf(layouts(after).source, song(after))).toBe(12)
  })

  it("following the source: it can sit earlier than its trim length, on a line that starts before it", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    expect(startOf(source, song(cells))).toBe(57) // unplaced: 12 s + its 45 s head
    const moved = dropAt(source, recordings, song(cells), 12)!
    expect(moved.place.targetOffsetMs).toBe(-45_000)
    const after = withPlace(moved.place)
    expect(startOf(layouts(after).source, song(after))).toBe(12)
    // The same distance following the recordings: from 1:45 back to the line's start.
    expect(startOf(layouts(after).recordings, song(after))).toBe(60)
  })

  it("following the source: its sound still never starts before the start of the file", () => {
    // On line 1, which starts at file zero.
    const cells = [line("l1", 0, 12, { durationMs: 5_000 }, SONG), line("l2", 12, 20, { durationMs: 5_000 })]
    const { source, recordings } = layouts(cells)
    const take: PlacedTake = { cell: cells[0], audioId: trackId("l1") }
    const moved = dropAt(source, recordings, take, -30)!
    expect(moved.place.targetOffsetMs).toBe(-45_000)
    const after = [line("l1", 0, 12, { durationMs: 5_000 }, { ...SONG, ...moved.place }), cells[1]]
    expect(startOf(layouts(after).source, { cell: after[0], audioId: trackId("l1") })).toBe(0)
  })

  it("the same on the main track following the source: a head-trimmed take reaches the start of the file", () => {
    const cells = [line("l1", 0, 12, { durationMs: 10_000, trimStartMs: 4_000 }), line("l2", 12, 20, { durationMs: 5_000 })]
    const { source, recordings } = layouts(cells, {})
    const take: PlacedTake = { cell: cells[0], audioId: takeId("l1") }
    expect(startOf(source, take)).toBe(4)
    const moved = dropAt(source, recordings, take, 0)!
    expect(moved.place.targetOffsetMs).toBe(-4_000)
  })
})

describe("the limits themselves (AQU-2495)", () => {
  const section = { start: 12, end: 20 }
  it("clampMoveStart: the floor is the start of the file, not the take's head trim", () => {
    const c = { free: false, lineStartSec: null, section, lenSec: 135, prevChipStartSec: null, nextChipStartSec: null }
    expect(clampMoveStart(12, c)).toBe(12)
    expect(clampMoveStart(-3, c)).toBe(0)
  })

  it("targetOffsetMsFor: the clip's start may go a head trim before file zero, and no further", () => {
    const cell = { startTime: 12 } as CellData
    expect(targetOffsetMsFor(cell, -33, 45)).toBe(-45_000)
    expect(targetOffsetMsFor(cell, -50, 45)).toBe(-57_000)
    // With no head trim (and for a caller that names none) it is file zero, as before.
    expect(targetOffsetMsFor(cell, -2)).toBe(-12_000)
    expect(targetOffsetMsFor(cell, -2, 0)).toBe(-12_000)
    // Following the recordings there is no file clock to fall off: kept as asked.
    expect(targetOffsetMsFor(cell, -33, null)).toBe(-45_000)
  })
})
