// An IMPORTED film's folder (Nov 8, the film bundle).
//
// A video imported as its own file is stored once and drawn twice: as the film
// (the picture, cut along its lines) and as the Source audio row (its sound,
// cut into the same lines). With an audio cue file beside it, the heard lines
// are a third row of the same film: Source cues. The timeline gathers the
// three into one folder at the top, named after the file, so it reads as the
// one thing it is.
//
// DERIVED, NEVER STORED. Like `filmKindOf` (film-pieces.ts), the folder is
// worked out from the data the importer already writes, every time, so files
// imported before this get it too. Nothing names it in `trackOverrides`: it
// cannot be renamed or dissolved, its rows cannot be dragged out, and nothing
// can be dragged in. Whether it is folded is personal, like any folder's.
//
// It is NOT a track in the contract (tracks.ts). The gutter and the lanes draw
// it as a pinned block above the track list, where the film alone sat, and the
// Source audio row it holds is taken out of the list the drag code measures.
// So no write can ever name it, and no reorder arithmetic ever meets it.
//
// Linked films (YouTube, a film link) and folders people make are unchanged.

import type { CellData } from "@/hooks/useCells"
import type { FilmKind, FilmPiece } from "./film-pieces"
import type { TimelineTrack } from "./tracks"

/** The folder's id in the per-file "which folders are closed" set. Never a
 *  track id: a user-made track's id is generated, and nothing stores this. */
export const FILM_FOLDER_ID = "film-folder"

export interface FilmFolderPlan {
  /** The derived Source audio row it holds (the film's sound), or null on a
   *  file that has none to draw. */
  sourceAudio: TimelineTrack | null
  /** An audio cue file is beside the film, so its heard lines get their own
   *  row inside the folder (Source cues), under the Source audio. */
  showCues: boolean
  /** Every other track, for the track list below the folder. */
  rest: TimelineTrack[]
}

/**
 * The folder for a file's film, or null when it gets none: only an IMPORTED
 * film has one (its picture and its Source audio are one upload).
 */
export function filmFolderPlan(args: {
  filmKind: FilmKind | null
  tracks: readonly TimelineTrack[]
  hasAudioCues: boolean
}): FilmFolderPlan | null {
  if (args.filmKind !== "imported") return null
  // The DERIVED row only, by its reserved id: an added audio track a person
  // made stays theirs, in the list below.
  const sourceAudio = args.tracks.find((track) => track.id === "source-audio" && track.kind === "source-audio") ?? null
  return {
    sourceAudio,
    showCues: args.hasAudioCues,
    rest: args.tracks.filter((track) => track !== sourceAudio),
  }
}

/** A heard line drawn in more than one piece gets this between its id and the
 *  piece's number, from the second piece on. */
const FRAGMENT_SEP = "~piece-"

/** The heard line a drawn cue chip stands for. */
export function cueIdOfChip(chipId: string): string {
  const at = chipId.indexOf(FRAGMENT_SEP)
  return at < 0 ? chipId : chipId.slice(0, at)
}

/**
 * The heard lines where the film's pieces put them, following the recordings.
 *
 * A heard line is timed on the film's own clock. Following the source that is
 * the timeline's clock too, so they are drawn where they are. Following the
 * recordings the film is cut into its lines' pieces, each moved with its line,
 * so a heard line is drawn inside the piece that shows its stretch of film, at
 * the same place in it. One that crosses from one line's stretch into the next
 * is drawn in both pieces; what falls between lines, or in a stretch cut away
 * because a line's recording is shorter, is not shown, as the film is not.
 *
 * Copies for drawing only: a moved heard line keeps its own times in the data.
 */
export function cuesOnFilmPieces(cues: readonly CellData[], pieces: readonly FilmPiece[]): CellData[] {
  const out: CellData[] = []
  for (const cue of cues) {
    const s = cue.startTime
    const e = cue.endTime
    if (typeof s !== "number" || typeof e !== "number" || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
    let n = 0
    for (const piece of pieces) {
      const from = Math.max(s, piece.filmStartSec)
      const to = Math.min(e, piece.filmEndSec)
      if (to - from < 0.01) continue
      n += 1
      out.push({
        ...cue,
        id: n === 1 ? cue.id : `${cue.id}${FRAGMENT_SEP}${n}`,
        startTime: piece.atSec + (from - piece.filmStartSec),
        endTime: piece.atSec + (to - piece.filmStartSec),
      })
    }
  }
  return out.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
}
