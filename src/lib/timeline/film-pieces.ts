// AQU-2253 (Sam, Oct 30): TWO KINDS OF FILM, and an imported one is cut along
// its source cues.
//
// A LINKED film (YouTube, or a film link) is for playback only. It plays
// straight through on its own clock in both timings, its sound lives on the
// film track, and it never makes a Source audio row. That includes a linked
// film with an uploaded recording of its source beside it: the film stays
// straight through, and the recording keeps its own Source audio row.
//
// An IMPORTED film (a video file uploaded through the importer, like any other
// file) has its sound treated like any uploaded audio. The upload is stored
// once, as the film and as the recording under every line, so its Source audio
// row is cut into the lines' cues, as on dev. Its picture is cut the same way:
//
//   - Each cue is already a stretch of the film, on the same clock, so the
//     film's piece for a line is exactly that line's stretch.
//   - Following the source, the pieces sit end to end and play as one film:
//     nothing looks or plays differently from one strip.
//   - Following the recordings, each line's piece moves with its line, so the
//     picture stays with that line's original sound. The film is cut wherever
//     the Source audio is cut: a piece is the line's Source audio window, and
//     where a recording runs longer than its line's original, the piece holds
//     its last frame until the line ends.
//   - Its sound comes only from the Source audio row, by the rules any
//     uploaded audio follows in each timing; the film element is always muted.
//
// Nothing is stored. How the film is told apart is the data the importer
// already writes: an imported film's address is a `frontier-audio://` upload
// that the lines' recordings point at too (import.ts stores `coreMediaUrl:
// upload.url` beside every line's attachment; sync-worker's import route only
// accepts such an address alongside that attachment). A linked film's address
// is a link. So files imported before this get the new behaviour too.

import type { CellData } from "@/hooks/useCells"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import type { Programme } from "./programme"

export type FilmKind = "linked" | "imported"

const UPLOAD_SCHEME = "frontier-audio://"

/**
 * Which kind of film a file has, or null with none. Imported only when the
 * film's address is an upload AND a line's Source audio recording is that same
 * upload: an upload nothing plays as the source has no cues to be cut along,
 * so it stays one film.
 */
export function filmKindOf(
  coreMediaUrl: string | null | undefined,
  cells: readonly Pick<CellData, "medium" | "selectedAudioId" | "attachments" | "id" | "fileId">[],
): FilmKind | null {
  if (!coreMediaUrl) return null
  if (!coreMediaUrl.startsWith(UPLOAD_SCHEME)) return "linked"
  for (const cell of cells) {
    if (sourceClipAudioForCell(cell as CellData)?.url === coreMediaUrl) return "imported"
  }
  return "linked"
}

/**
 * Following the recordings, whether the film's OWN sound is what plays, so the
 * programme's original goes quiet rather than sound twice (play-queue's
 * `setProgrammeSourceVoicedByFilm`). A linked film on screen: yes, its sound
 * plays straight through with its picture. An imported film: never, its Source
 * audio row is the sound, cut into the lines as any uploaded recording is.
 * Following the source the recording is always the sound.
 */
export function filmVoicesProgramme(args: {
  kind: FilmKind | null
  paneOnScreen: boolean
  followsRecordings: boolean
}): boolean {
  return args.kind === "linked" && args.paneOnScreen && args.followsRecordings
}

/**
 * One line's piece of an imported film, following the recordings: where it
 * sits on the timeline (the line's slot) and which stretch of the film it
 * shows. `atSec`/`lenSec` are timeline seconds, `filmStartSec`/`filmEndSec`
 * the film's own. When the slot is longer than the stretch (a recording
 * longer than its line's original), the rest of the slot holds the last frame.
 */
export interface FilmPiece {
  cellId: string
  atSec: number
  lenSec: number
  filmStartSec: number
  filmEndSec: number
}

/** The last frame of a piece is this far before its stretch ends: one frame
 *  at 25 fps, so it is the line's own picture and never the next line's. */
export const FILM_PIECE_LAST_FRAME_SEC = 0.04

export function pieceLastFrameSec(piece: Pick<FilmPiece, "filmStartSec" | "filmEndSec">): number {
  return Math.max(piece.filmStartSec, piece.filmEndSec - FILM_PIECE_LAST_FRAME_SEC)
}

/** How long a piece holds its last frame, in timeline seconds (0 for none). */
export function pieceHeldSec(piece: FilmPiece): number {
  return Math.max(0, piece.lenSec - (piece.filmEndSec - piece.filmStartSec))
}

/**
 * The film's pieces following the recordings, from the laid-out programme the
 * timeline draws and the queue plays: one per line whose Source audio sounds,
 * at the line's slot, showing exactly the window the Source audio plays
 * (`sourceWindow`, already cut where the line ends). A line with no original
 * to hear has no piece. Following the source there is no programme, and no
 * pieces: the film is one strip on its own clock there.
 */
export function filmPiecesFor(programme: Programme | null | undefined): FilmPiece[] {
  if (!programme) return []
  const out: FilmPiece[] = []
  for (const slot of programme.slots) {
    const w = slot.sourceWindow
    if (!w || !(slot.sourceLenSec > 0) || !(slot.slotLenSec > 0)) continue
    out.push({
      cellId: slot.cellId,
      atSec: slot.startSec,
      lenSec: slot.slotLenSec,
      filmStartSec: w.start,
      filmEndSec: w.end,
    })
  }
  return out
}

/** What the Film panel shows at a moment of the timeline. */
export interface FilmMoment {
  /** The film's own second. */
  sec: number
  /** The picture is held still here: past its line's stretch (the recording
   *  runs longer), or on a line with no piece of its own. */
  held: boolean
  /** The line whose piece it is, or null on a moment no piece covers. */
  cellId: string | null
}

/** The piece covering timeline second `sec`, or the index of the last piece
 *  that starts before it (negated, minus one) when none covers it. */
function pieceIndexAt(pieces: readonly FilmPiece[], sec: number): number {
  let lo = 0
  let hi = pieces.length - 1
  let before = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const p = pieces[mid]
    if (sec < p.atSec) hi = mid - 1
    else if (sec >= p.atSec + p.lenSec) {
      before = mid
      lo = mid + 1
    } else return mid
  }
  return -2 - before
}

/**
 * Where the film is at timeline second `sec`, following the recordings, for an
 * imported film cut into `pieces`:
 *   - inside a line's stretch, that moment of the stretch;
 *   - past it (the recording runs longer), the stretch's last frame, held;
 *   - on a moment no piece covers (a line with no original to hear, or past
 *     the last line), the last frame of the piece before it, held — or the
 *     first piece's first frame before any.
 * Null with no pieces at all.
 */
export function filmMomentAt(pieces: readonly FilmPiece[], sec: number): FilmMoment | null {
  if (pieces.length === 0 || !Number.isFinite(sec)) return null
  const i = pieceIndexAt(pieces, Math.max(0, sec))
  if (i >= 0) {
    const p = pieces[i]
    const into = Math.max(0, sec) - p.atSec
    const stretch = p.filmEndSec - p.filmStartSec
    if (into < stretch) return { sec: p.filmStartSec + into, held: false, cellId: p.cellId }
    return { sec: pieceLastFrameSec(p), held: true, cellId: p.cellId }
  }
  const before = -2 - i
  if (before < 0) return { sec: pieces[0].filmStartSec, held: true, cellId: null }
  return { sec: pieceLastFrameSec(pieces[before]), held: true, cellId: null }
}

/** One tile of a piece: its place inside the piece, and the film moment its
 *  picture shows. `held` tiles show the piece's last frame. */
export interface FilmPieceTile {
  index: number
  leftPx: number
  widthPx: number
  sec: number
  held: boolean
}

/** A piece as the strip draws it: its chip's place on the timeline, where its
 *  held tail starts inside it (null with none), and its tiles in view. */
export interface FilmPieceStrip {
  piece: FilmPiece
  leftPx: number
  widthPx: number
  heldFromPx: number | null
  tiles: FilmPieceTile[]
}

/**
 * The pieces that touch the visible window, each with only its tiles in view.
 * Each piece is its own chip, 2 px short of its end like every chip, and its
 * tiles start at its own left edge. A tile shows the film at its middle,
 * snapped to `gridSec` (so zooming reuses fetched frames) and kept inside the
 * piece's stretch; a tile in the held tail shows the last frame.
 */
export function visibleFilmPieceStrips(args: {
  pieces: readonly FilmPiece[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  tilePx: number
  gridSec: number
}): FilmPieceStrip[] {
  const { pieces, pxPerSec, viewStartSec, viewEndSec, tilePx, gridSec } = args
  if (!(pxPerSec > 0) || !(tilePx > 0)) return []
  const out: FilmPieceStrip[] = []
  for (const piece of pieces) {
    if (piece.atSec + piece.lenSec <= viewStartSec) continue
    if (piece.atSec >= viewEndSec) break
    const leftPx = piece.atSec * pxPerSec
    const widthPx = Math.max(4, piece.lenSec * pxPerSec - 2)
    const stretchPx = (piece.filmEndSec - piece.filmStartSec) * pxPerSec
    const heldFromPx = pieceHeldSec(piece) > 0.01 && stretchPx < widthPx ? stretchPx : null
    const last = pieceLastFrameSec(piece)
    // The tiles in view, measured inside the piece.
    const viewL = Math.max(0, viewStartSec * pxPerSec - leftPx)
    const viewR = Math.min(widthPx, viewEndSec * pxPerSec - leftPx)
    const tiles: FilmPieceTile[] = []
    if (viewR > viewL) {
      const first = Math.floor(viewL / tilePx)
      const lastIndex = Math.ceil(viewR / tilePx) - 1
      for (let i = first; i <= lastIndex; i++) {
        const tLeft = i * tilePx
        const tWidth = Math.min(tilePx, widthPx - tLeft)
        if (tWidth <= 0) break
        const midSec = (tLeft + tWidth / 2) / pxPerSec
        const held = heldFromPx != null && tLeft + tWidth / 2 >= heldFromPx
        let sec: number
        if (held) sec = last
        else {
          const raw = piece.filmStartSec + midSec
          const snapped = gridSec > 0 ? Math.round(raw / gridSec) * gridSec : raw
          sec = Math.min(last, Math.max(piece.filmStartSec, snapped))
        }
        tiles.push({ index: i, leftPx: tLeft, widthPx: tWidth, sec: Math.round(sec * 100) / 100, held })
      }
    }
    out.push({ piece, leftPx, widthPx, heldFromPx, tiles })
  }
  return out
}
