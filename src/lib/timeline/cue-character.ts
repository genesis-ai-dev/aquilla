// Who speaks this heard line, and is the camera on them?
// (AQU-646, 2026-08-16)
//
// The character spreadsheet is keyed to the SUBTITLE cells — one row per line
// of the text VTT. Since stage 4 the work happens on AUDIO CUES, which carry no
// character of their own. So 637 correctly-imported names were invisible
// wherever it mattered: the timeline chip strip reads `cell.metadata.cast_name`
// and a cue has none, and the recording modal never showed a character at all.
//
// The bridge is the links, which is what they were designed for on 2026-08-12:
// "links carry character/camera data from the text-keyed xlsx onto audio cues."
// A cue's characters are the cast names of the subtitle lines it performs.
//
// SEVERAL NAMES IS RARE BUT REAL. Counted in episode 101: 96 cues cover two or
// more subtitle rows, and of those exactly FIVE have two different characters —
// the other 91 are one speaker whose line was split across two rows. Five is
// still five performances misattributed if we showed only the first name, so
// both are shown, in document order. (8:09 DRIVER/MATTHEW, 10:53 the two
// students on "Rabbi.", 26:01 EDEN/SIMON, 32:50 MARY MAGDALENE/SOL, 45:58
// ANDREW/SIMON.)
//
// The camera merge earns its keep more often: 27 cues link lines that disagree
// about it, and each would otherwise silently take whichever came first.

import type { CameraState } from "@/lib/sync/cells-read-types"
import type { CellData } from "@/hooks/useCells"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"

export interface CueCharacter {
  /** Distinct cast names, in document order. Empty when nobody is named. */
  names: string[]
  /**
   * The lip-sync constraint. `mixed` when the linked lines disagree, because a
   * cue covering two lines shot differently constrains neither exactly.
   *
   * A "(Group)" label used to land here as `mixed` too. It no longer does —
   * `group` is its own state since 2026-08-20 (AQU-646) and survives all the
   * way to the corrected sheets; only genuine DISAGREEMENT between linked
   * lines still collapses to `mixed`.
   */
  cameraState: CameraState | undefined
}

const EMPTY: CueCharacter = { names: [], cameraState: undefined }

const ownCastName = (cell: CellData): string | null =>
  cell.metadata && typeof cell.metadata.cast_name === "string" && cell.metadata.cast_name !== ""
    ? cell.metadata.cast_name
    : null

/** One state, or `mixed` when they disagree. Undefined when none are known. */
function mergeCamera(states: readonly (CameraState | undefined)[]): CameraState | undefined {
  const known = [...new Set(states.filter((s): s is CameraState => Boolean(s)))]
  if (known.length === 0) return undefined
  return known.length === 1 ? known[0] : "mixed"
}

export interface ResolveCueCharacterArgs {
  /** The cell being described — an audio cue, or an ordinary text cell. */
  cell: CellData | null | undefined
  links: CueLinkIndex
  /** The subtitle file's cells, IN DOCUMENT ORDER. */
  textCells: readonly CellData[]
}

/**
 * Pure; no I/O.
 *
 * A cell that carries its OWN cast name answers for itself and no link lookup
 * happens — which is what keeps every file without audio cues behaving exactly
 * as it does today.
 */
export function resolveCueCharacter({
  cell,
  links,
  textCells,
}: ResolveCueCharacterArgs): CueCharacter {
  if (!cell) return EMPTY

  const own = ownCastName(cell)
  if (own) return { names: [own], cameraState: cell.cameraState }

  const linked = links.textForCue.get(cell.id)
  if (!linked || linked.length === 0) return EMPTY

  // Filtering the ordered list preserves document order, which is what decides
  // how "A / B" reads for a cue covering two speakers.
  const wanted = new Set(linked)
  const rows = textCells.filter((c) => wanted.has(c.id))
  const names = [...new Set(rows.map(ownCastName).filter((n): n is string => n !== null))]
  if (names.length === 0) return EMPTY

  return { names, cameraState: mergeCamera(rows.map((c) => c.cameraState)) }
}

/** "MARY" or "MARY / JESUS" — how the two surfaces print it. */
export function formatCueCharacter(names: readonly string[]): string | null {
  return names.length === 0 ? null : names.join(" / ")
}

/**
 * Plain words rather than the stored token: a bare "on" reads as a toggle.
 *
 * THE ONE PLACE camera states are put into words. The character-check drawer
 * carried a second copy of this ternary until 2026-08-20, which is exactly the
 * kind of duplicate that ends up one arm behind — as it would have when
 * `group` arrived.
 */
export function cameraLabel(state: CameraState | undefined): string | null {
  if (!state) return null
  if (state === "on") return "on camera"
  if (state === "off") return "off camera"
  if (state === "group") return "group shot"
  return "mixed"
}
