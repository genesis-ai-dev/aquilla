// AQU-2253 (Sam, Oct 30): two kinds of film. A linked film plays straight
// through on its own clock; an imported one (a video uploaded through the
// importer) is cut along its source cues and is picture only.

import { describe, expect, it } from "vitest"
import {
  FILM_PIECE_LAST_FRAME_SEC,
  filmKindOf,
  filmMomentAt,
  filmPiecesFor,
  filmVoicesProgramme,
  linkedFilmBehindLines,
  programmeFilmFor,
  stripLinesFor,
  pieceHeldSec,
  visibleFilmPieceStrips,
  type FilmPiece,
} from "./film-pieces"
import { buildProgramme, layOutProgramme } from "./programme"
import { buildTimelineLayout } from "./layout"
import type { CellData } from "@/hooks/useCells"

/** The upload the importer stores once: the film AND every line's recording. */
const UPLOAD = "frontier-audio://f1/audio-f1-1690000000-film.webm"
const SOURCE_ID = "audio-f1-1690000000-film.webm"

/** A line of an imported film: its stretch of the film, the shared upload as
 *  its Source audio recording, and optionally a take of its own. */
function line(
  id: string,
  startTime: number,
  endTime: number,
  takeSec?: number,
  sourceUrl: string = UPLOAD,
): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: `Line ${id}`,
    translated: "",
    medium: "media",
    startTime,
    endTime,
    ...(takeSec != null ? { selectedAudioId: takeId } : {}),
    attachments: {
      ...(takeSec != null ? { [takeId]: { type: "audio", url: "frontier-audio://take", durationMs: takeSec * 1000 } } : {}),
      [SOURCE_ID]: { type: "audio", url: sourceUrl, trimStartMs: startTime * 1000, trimEndMs: endTime * 1000 },
    },
  } as unknown as CellData
}

/** A subtitle cue on a linked film: text, no recording. */
const cue = (id: string, startTime: number, endTime: number): CellData =>
  ({ id, fileId: "f1", original: `Cue ${id}`, translated: "", medium: "text", startTime, endTime }) as unknown as CellData

describe("filmKindOf — telling the two kinds of film apart from the data", () => {
  it("no film", () => {
    expect(filmKindOf(undefined, [])).toBeNull()
    expect(filmKindOf("", [line("a", 0, 2)])).toBeNull()
  })

  it("a YouTube film is linked", () => {
    expect(filmKindOf("https://www.youtube.com/watch?v=aqbHRKZ1bVs", [cue("a", 0, 2)])).toBe("linked")
  })

  it("a film link (a streamed film) is linked", () => {
    expect(filmKindOf("https://cdn.thechosen.media/videos/x/master.m3u8", [cue("a", 0, 2)])).toBe("linked")
  })

  it("an upload the lines' recordings point at too is imported", () => {
    expect(filmKindOf(UPLOAD, [line("a", 0, 2), line("b", 2, 4)])).toBe("imported")
  })

  it("a linked film with an uploaded recording of its source beside it stays linked", () => {
    // The recording is its own upload; the film is the YouTube link.
    const recording = "frontier-audio://f1/audio-f1-1690000000-original.mp3"
    expect(filmKindOf("https://www.youtube.com/watch?v=aqbHRKZ1bVs", [line("a", 0, 2, undefined, recording)])).toBe("linked")
  })

  it("an upload no line plays as its recording has nothing to be cut along: linked", () => {
    expect(filmKindOf(UPLOAD, [cue("a", 0, 2)])).toBe("linked")
    expect(filmKindOf(UPLOAD, [line("a", 0, 2, undefined, "frontier-audio://f1/other.mp3")])).toBe("linked")
  })
})

describe("filmVoicesProgramme — whose sound plays following the recordings", () => {
  it("a linked film's own sound plays straight through, so the programme's original goes quiet", () => {
    expect(filmVoicesProgramme({ kind: "linked", paneOnScreen: true, followsRecordings: true })).toBe(true)
  })

  it("an imported film never: its Source audio row is the sound", () => {
    expect(filmVoicesProgramme({ kind: "imported", paneOnScreen: true, followsRecordings: true })).toBe(false)
  })

  it("following the source, the recording is the sound for both kinds", () => {
    expect(filmVoicesProgramme({ kind: "linked", paneOnScreen: true, followsRecordings: false })).toBe(false)
    expect(filmVoicesProgramme({ kind: "imported", paneOnScreen: true, followsRecordings: false })).toBe(false)
  })

  it("no film on screen, nothing to voice", () => {
    expect(filmVoicesProgramme({ kind: "linked", paneOnScreen: false, followsRecordings: true })).toBe(false)
    expect(filmVoicesProgramme({ kind: null, paneOnScreen: true, followsRecordings: true })).toBe(false)
  })

  // AQU-2253 (review, Nov 9): the sound pick and a film that cannot play count
  // following the recordings too, as they always have following the source.
  it("the recording was picked as the sound: the film stays quiet and the lines' original is heard", () => {
    expect(
      filmVoicesProgramme({ kind: "linked", paneOnScreen: true, followsRecordings: true, recordingIsTheSound: true }),
    ).toBe(false)
  })

  it("a film that could not be loaded voices nothing, so the lines' original is heard", () => {
    expect(
      filmVoicesProgramme({ kind: "linked", paneOnScreen: true, followsRecordings: true, filmFailed: true }),
    ).toBe(false)
  })

  it("the film's own sound picked and the film playing: the film voices the programme", () => {
    expect(
      filmVoicesProgramme({
        kind: "linked", paneOnScreen: true, followsRecordings: true, recordingIsTheSound: false, filmFailed: false,
      }),
    ).toBe(true)
  })
})

// AQU-2253 (Sam, Nov 9): following the recordings a LINKED film plays on its
// own clock, so Play runs to whichever ends later: the lines or the film.
describe("linkedFilmBehindLines: the film behind the lines, following the recordings", () => {
  const linked = { kind: "linked", paneOnScreen: true, followsRecordings: true, durationSec: 2700 } as const

  it("a linked film on screen: its length, and Play runs on past the lines to it", () => {
    expect(linkedFilmBehindLines(linked)).toEqual({ endSec: 2700, runsOn: true })
  })

  it("following the source: nothing, the film or the recording is the transport there", () => {
    expect(linkedFilmBehindLines({ ...linked, followsRecordings: false })).toBeNull()
  })

  it("an imported film: nothing, it is cut into its lines and its sound is their originals", () => {
    expect(linkedFilmBehindLines({ ...linked, kind: "imported" })).toBeNull()
  })

  it("a film that could not be loaded: nothing, it is not something to play", () => {
    expect(linkedFilmBehindLines({ ...linked, filmFailed: true })).toBeNull()
  })

  it("no film, or none on screen: nothing", () => {
    expect(linkedFilmBehindLines({ ...linked, kind: null })).toBeNull()
    expect(linkedFilmBehindLines({ ...linked, paneOnScreen: false })).toBeNull()
  })

  // AQU-2253 (Sam, Nov 9): these two said "nothing" while Play only ran on
  // past the lines. The film is the lines' source too, so it is behind them
  // before its length is known. (The review of the Nov 19 merge, S1: a book
  // is no longer a case of its own; its run holds every chapter.)
  it("a length not known yet, or not a length: still behind the lines, its length unknown", () => {
    expect(linkedFilmBehindLines({ ...linked, durationSec: null })).toEqual({ endSec: null, runsOn: true })
    expect(linkedFilmBehindLines({ ...linked, durationSec: 0 })).toEqual({ endSec: null, runsOn: true })
    expect(linkedFilmBehindLines({ ...linked, durationSec: Number.NaN })).toEqual({ endSec: null, runsOn: true })
  })


  it("a film whose sound is not what plays is still behind the lines: its picture is running", () => {
    // The uploaded recording picked as the sound: the film is the quiet one…
    expect(filmVoicesProgramme({ kind: "linked", paneOnScreen: true, followsRecordings: true, recordingIsTheSound: true })).toBe(false)
    // …and still the lines' source.
    expect(linkedFilmBehindLines(linked)).toEqual({ endSec: 2700, runsOn: true })
  })
})

describe("filmPiecesFor — the film cut along its source cues", () => {
  it("following the source there is no programme and no pieces: the one strip on the film's clock", () => {
    expect(filmPiecesFor(null)).toEqual([])
    expect(buildTimelineLayout("dubbing", [line("a", 0, 2)], [line("a", 0, 2)]).programme).toBeNull()
  })

  it("following the recordings, each line's piece is its own stretch of the film, at its line's slot", () => {
    // Line a: 0.5–4.0 in the film (3.5 s), its take 3.5 s: an exact fit.
    // Line b: 4.6–8.8 (4.2 s), its take 6.0 s: the piece holds 1.8 s.
    // Line c: 9.2–13.5 (4.3 s), its take 2.0 s: the piece is cut at 2.0 s.
    const prog = buildProgramme([line("a", 0.5, 4.0, 3.5), line("b", 4.6, 8.8, 6.0), line("c", 9.2, 13.5, 2.0)])
    const pieces = filmPiecesFor(prog)
    expect(pieces.map((p) => [p.cellId, p.atSec, p.lenSec])).toEqual([
      ["a", 0, 3.5],
      ["b", 3.5, 6],
      ["c", 9.5, 2],
    ])
    expect(pieces.map((p) => [p.filmStartSec, p.filmEndSec])).toEqual([
      [0.5, 4.0],
      [4.6, 8.8],
      [9.2, 11.2],
    ])
    expect(pieces.map((p) => pieceHeldSec(p))).toEqual([0, expect.closeTo(1.8, 6), 0])
    // c's 4.3 s stretch shows 2.0 s: 2.3 s of it is cut away, as its Source audio is.
    expect(pieces.map((p) => p.cutSec)).toEqual([undefined, undefined, expect.closeTo(2.3, 6)])
  })

  it("is cut exactly where the Source audio is cut: each piece is its line's Source audio window", () => {
    const prog = buildProgramme([line("a", 0.5, 4.0, 3.0), line("b", 4.6, 8.8, 6.0)])
    for (const [i, p] of filmPiecesFor(prog).entries()) {
      const slot = prog.slots[i]
      expect([p.atSec, p.filmStartSec, p.filmEndSec]).toEqual([slot.startSec, slot.sourceWindow!.start, slot.sourceWindow!.end])
    }
  })

  it("the stretches between cues are left out, as the Source audio leaves them out", () => {
    // 4.0–4.6 and 8.8–9.2 belong to no line: following the recordings
    // nothing of the source plays there, and no piece shows them.
    const pieces = filmPiecesFor(buildProgramme([line("a", 0.5, 4.0, 3.5), line("b", 4.6, 8.8, 4.2), line("c", 9.2, 13.5, 4.3)]))
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i].atSec).toBeCloseTo(pieces[i - 1].atSec + pieces[i - 1].lenSec, 9)
      expect(pieces[i].filmStartSec).toBeGreaterThan(pieces[i - 1].filmEndSec)
    }
  })

  // Nov 8 (the film bundle; import map X-D-filmtrack-cut): a line nobody has
  // recorded plays its original whole, so its piece is its whole stretch and
  // nothing says "cut". A transcript used to set a reading-time stand-in
  // ("Hi." is 1.5 s against a 4.2 s line) and cut the piece to it.
  it("a line with no take shows its whole stretch: no cut, no hold", () => {
    const b = { ...line("b", 4.6, 8.8), transcription: "Hi." } as CellData
    const { programme } = layOutProgramme([line("a", 0.5, 4.0, 3.5), b])
    const [, piece] = filmPiecesFor(programme)
    expect(piece).toMatchObject({ cellId: "b", filmStartSec: 4.6, filmEndSec: 8.8 })
    expect(piece.lenSec).toBeCloseTo(4.2, 9)
    expect(piece.cutSec).toBeUndefined()
    expect(pieceHeldSec(piece)).toBe(0)
  })

  it("a line with no original to hear has no piece", () => {
    const silent = { ...line("b", 4.6, 8.8, 3), attachments: { "audio-b-1700000000-take.webm": { type: "audio", url: "frontier-audio://take", durationMs: 3000 } } } as unknown as CellData
    const pieces = filmPiecesFor(buildProgramme([line("a", 0.5, 4.0, 3.5), silent, line("c", 9.2, 13.5, 4.3)]))
    expect(pieces.map((p) => p.cellId)).toEqual(["a", "c"])
  })
})

describe("filmMomentAt — what the Film panel shows at a moment of the timeline", () => {
  const pieces: FilmPiece[] = [
    { cellId: "a", atSec: 0, lenSec: 3.5, filmStartSec: 0.5, filmEndSec: 4.0 },
    { cellId: "b", atSec: 3.5, lenSec: 6, filmStartSec: 4.6, filmEndSec: 8.8 },
    { cellId: "d", atSec: 12, lenSec: 4, filmStartSec: 14, filmEndSec: 18 },
  ]

  it("inside a line's stretch, that moment of the stretch", () => {
    expect(filmMomentAt(pieces, 1)).toEqual({ sec: 1.5, held: false, cellId: "a" })
    expect(filmMomentAt(pieces, 3.5)).toEqual({ sec: 4.6, held: false, cellId: "b" })
    expect(filmMomentAt(pieces, 5)).toMatchObject({ sec: expect.closeTo(6.1, 9), held: false, cellId: "b" })
  })

  it("a recording longer than its line's original: the stretch's last frame, held until the line ends", () => {
    // b's stretch is 4.2 s in a 6 s line: from 7.7 s to 9.5 s it holds.
    for (const t of [7.75, 8.5, 9.49]) {
      expect(filmMomentAt(pieces, t)).toEqual({ sec: 8.8 - FILM_PIECE_LAST_FRAME_SEC, held: true, cellId: "b" })
    }
  })

  it("a line with no piece holds the last frame before it", () => {
    expect(filmMomentAt(pieces, 10)).toEqual({ sec: 8.8 - FILM_PIECE_LAST_FRAME_SEC, held: true, cellId: null })
  })

  it("past the last line, the last piece's last frame", () => {
    expect(filmMomentAt(pieces, 30)).toEqual({ sec: 18 - FILM_PIECE_LAST_FRAME_SEC, held: true, cellId: null })
  })

  it("no pieces, nothing to say", () => {
    expect(filmMomentAt([], 3)).toBeNull()
  })
})

describe("visibleFilmPieceStrips — the strip's frames come from each piece's own stretch", () => {
  const pieces: FilmPiece[] = [
    { cellId: "a", atSec: 0, lenSec: 3.5, filmStartSec: 0.5, filmEndSec: 4.0 },
    { cellId: "b", atSec: 3.5, lenSec: 6, filmStartSec: 4.6, filmEndSec: 8.8 },
  ]

  it("each piece is its own chip at its line's slot, 2 px short of its end", () => {
    const strips = visibleFilmPieceStrips({ pieces, pxPerSec: 40, viewStartSec: 0, viewEndSec: 20, tilePx: 58, gridSec: 0.5 })
    expect(strips.map((s) => [s.piece.cellId, s.leftPx, s.widthPx])).toEqual([
      ["a", 0, 138],
      ["b", 140, 238],
    ])
  })

  it("every tile shows a moment inside its own piece's stretch", () => {
    const strips = visibleFilmPieceStrips({ pieces, pxPerSec: 40, viewStartSec: 0, viewEndSec: 20, tilePx: 58, gridSec: 0.5 })
    for (const s of strips) {
      for (const tile of s.tiles) {
        expect(tile.sec).toBeGreaterThanOrEqual(s.piece.filmStartSec)
        expect(tile.sec).toBeLessThanOrEqual(s.piece.filmEndSec)
      }
    }
    // a's first tile, its middle 0.725 s into the line, is 1.225 s into the
    // film, snapped to the half second.
    expect(strips[0].tiles[0].sec).toBe(1)
  })

  it("the held tail starts where the stretch ends, and its tiles show the last frame", () => {
    const [, b] = visibleFilmPieceStrips({ pieces, pxPerSec: 40, viewStartSec: 0, viewEndSec: 20, tilePx: 58, gridSec: 0.5 })
    expect(b.heldFromPx).toBeCloseTo(4.2 * 40, 6)
    const held = b.tiles.filter((t) => t.held)
    expect(held.length).toBeGreaterThan(0)
    for (const t of held) expect(t.sec).toBe(8.76)
    expect(b.tiles.filter((t) => !t.held).every((t) => t.sec < 8.76)).toBe(true)
  })

  it("only the pieces and tiles in view", () => {
    const strips = visibleFilmPieceStrips({ pieces, pxPerSec: 40, viewStartSec: 5, viewEndSec: 7, tilePx: 58, gridSec: 0.5 })
    expect(strips.map((s) => s.piece.cellId)).toEqual(["b"])
    const tiles = strips[0].tiles
    expect(Math.min(...tiles.map((t) => t.leftPx))).toBeGreaterThanOrEqual(Math.floor((5 * 40 - 140) / 58) * 58)
    expect(Math.max(...tiles.map((t) => t.leftPx))).toBeLessThan(7 * 40 - 140)
  })
})

// AQU-2253 (review, Nov 9): the film's lines and the bottom strip's lines are
// the lines Play plays, by id (the queue-side proof is in
// components/ProjectWorkspace.filmRunLines.test.ts).
describe("programmeFilmFor and stripLinesFor: one list of lines, by id", () => {
  const ids = (lines: readonly { id: string }[]) => lines.map((c) => c.id)
  const plain = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const merged = plain.map((c) => ({ ...c }))

  it("no film to run on over: nothing is named", () => {
    expect(programmeFilmFor(null, plain)).toBeNull()
  })

  it("names the film's length, whether Play runs on, and exactly the lines Play plays", () => {
    const film = programmeFilmFor({ endSec: 2700, runsOn: true }, merged)
    expect(film?.endSec).toBe(2700)
    expect(film?.runsOn).toBe(true)
    expect([...(film?.cellIds ?? [])]).toEqual(["a", "b", "c"])
    expect(programmeFilmFor({ endSec: null, runsOn: false }, merged)).toMatchObject({ endSec: null, runsOn: false })
  })

  it("the strip gets the file's lines plain when the timeline draws them all", () => {
    expect(stripLinesFor(merged, merged, merged, plain)).toBe(plain)
  })

  it("only the timeline's lines when it draws fewer (a book's chapter)", () => {
    const chapter = [merged[0], merged[2]]
    const strip = stripLinesFor(chapter, chapter, merged, plain)
    expect(ids(strip)).toEqual(["a", "c"])
    expect(strip[0]).toBe(plain[0])
  })

  it("the heard lines themselves where the file plays those", () => {
    const heard = [{ id: "h1" }, { id: "h2" }]
    expect(stripLinesFor(heard, merged, merged, plain)).toBe(heard)
  })

  it("whichever it is, the strip's ids are the film's ids", () => {
    const chapter = [merged[1]]
    const cases: [{ id: string }[], { id: string }[]][] = [[merged, merged], [chapter, chapter], [[{ id: "h1" }], merged]]
    for (const [playback, timeline] of cases) {
      const film = programmeFilmFor({ endSec: 60, runsOn: true }, playback)
      expect(ids(stripLinesFor(playback, timeline, merged, plain)).sort()).toEqual([...(film?.cellIds ?? [])].sort())
    }
  })
})
