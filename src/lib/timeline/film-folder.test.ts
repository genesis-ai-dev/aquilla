import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { cueIdOfChip, cuesOnFilmPieces, filmFolderPlan, FILM_FOLDER_ID } from "./film-folder"
import type { FilmPiece } from "./film-pieces"
import { deriveDefaultTracks, type TimelineTrack } from "./tracks"

const mediaTracks = () => deriveDefaultTracks({ isSubtitleImport: false, hasMediaCells: true, hasAudioCues: false })

describe("filmFolderPlan — an imported film's folder", () => {
  it("only an imported film gets one", () => {
    const tracks = mediaTracks()
    expect(filmFolderPlan({ filmKind: "linked", tracks, hasAudioCues: false })).toBeNull()
    expect(filmFolderPlan({ filmKind: null, tracks, hasAudioCues: false })).toBeNull()
    expect(filmFolderPlan({ filmKind: "imported", tracks, hasAudioCues: false })).not.toBeNull()
  })

  it("holds the Source audio row and leaves every other track below it", () => {
    const tracks = mediaTracks()
    const plan = filmFolderPlan({ filmKind: "imported", tracks, hasAudioCues: false })!
    expect(plan.sourceAudio?.id).toBe("source-audio")
    expect(plan.rest.map((t) => t.id)).toEqual(["source-subtitles", "target-audio"])
    expect(plan.showCues).toBe(false)
  })

  it("adds the heard lines' row when an audio cue file is beside the film", () => {
    const plan = filmFolderPlan({ filmKind: "imported", tracks: mediaTracks(), hasAudioCues: true })!
    expect(plan.showCues).toBe(true)
  })

  it("leaves an added audio track a person made in the list", () => {
    const added: TimelineTrack = { id: "t-music", kind: "audio", name: "Music", order: 9, groupId: null }
    const plan = filmFolderPlan({ filmKind: "imported", tracks: [...mediaTracks(), added], hasAudioCues: false })!
    expect(plan.rest.map((t) => t.id)).toContain("t-music")
  })

  it("its id can never be a track's", () => {
    expect(mediaTracks().some((t) => t.id === FILM_FOLDER_ID)).toBe(false)
  })
})

const cue = (id: string, startTime: number, endTime: number) =>
  ({ id, cellId: id, startTime, endTime, original: id, medium: "text" }) as unknown as CellData

describe("cuesOnFilmPieces — the heard lines where the film's pieces put them", () => {
  // Line 1 is the film's 1–4 s, laid at 0; line 2 is 6–9 s, laid at 5 after a
  // dub that ran 2 s longer (so its piece holds), cut nothing.
  const pieces: FilmPiece[] = [
    { cellId: "l1", atSec: 0, lenSec: 5, filmStartSec: 1, filmEndSec: 4 },
    { cellId: "l2", atSec: 5, lenSec: 3, filmStartSec: 6, filmEndSec: 9 },
  ]

  it("draws a heard line inside the piece that shows its stretch, at the same place in it", () => {
    const [moved] = cuesOnFilmPieces([cue("c1", 2, 3)], pieces)
    expect(moved).toMatchObject({ id: "c1", startTime: 1, endTime: 2 })
  })

  it("a heard line crossing two lines' stretches is drawn in both pieces", () => {
    const out = cuesOnFilmPieces([cue("c2", 3.5, 7)], pieces)
    expect(out.map((c) => [c.id, c.startTime, c.endTime])).toEqual([
      ["c2", 2.5, 3],
      ["c2~piece-2", 5, 6],
    ])
    expect(out.map((c) => cueIdOfChip(c.id))).toEqual(["c2", "c2"])
  })

  it("leaves out what falls between lines, as the film does", () => {
    expect(cuesOnFilmPieces([cue("gap", 4.2, 5.8)], pieces)).toEqual([])
  })

  it("skips a heard line with no times", () => {
    expect(cuesOnFilmPieces([{ id: "x" } as unknown as CellData], pieces)).toEqual([])
  })

  it("keeps the heard line's own times in the data", () => {
    const original = cue("c1", 2, 3)
    cuesOnFilmPieces([original], pieces)
    expect(original.startTime).toBe(2)
  })
})
