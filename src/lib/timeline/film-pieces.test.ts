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

  it("a line with no take keeps its stand-in length, and its piece is cut or held to it", () => {
    const { programme } = layOutProgramme([line("a", 0.5, 4.0, 3.5), line("b", 4.6, 8.8)])
    const [, b] = filmPiecesFor(programme)
    const slot = programme.byCellId.get("b")!
    expect(b.lenSec).toBe(slot.slotLenSec)
    expect(b.filmEndSec - b.filmStartSec).toBeCloseTo(Math.min(4.2, slot.slotLenSec), 9)
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
