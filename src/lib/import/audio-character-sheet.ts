// The AUDIO character sheet: who speaks each HEARD line. (AQU-646, 2026-08-18)
//
// The client ships two character spreadsheets per episode and they are keyed to
// opposite sides of the same script. The one we already read is keyed to the
// SUBTITLE rows, so its characters reach the recording surface only by being
// carried across the links. This one is keyed to the AUDIO cues themselves —
// the units that actually get performed — so it needs no inference at all.
//
// IT IS A MIRROR OF THE AUDIO VTT, exactly. Measured on episode 101: 548 rows
// against 548 cues, the `Translation` column byte-identical to every cue's own
// text, and `startTime` agreeing to within two milliseconds. That is what makes
// this module thin, and it is why rows are matched to cues BY THEIR WORDS.
//
// NOT BY TIMESTAMP, and the reason is specific rather than stylistic: the
// sheet's times are the delivered file's own, at 24fps, while the cues we store
// have been timebase-corrected onto the subtitles' 23.976. Keying on time would
// therefore be wrong by exactly the drift the import just finished removing —
// up to three seconds by the end of an episode. The words moved with neither.
//
// The subtitle sheet's importer keys on timestamps because it has nothing else;
// this one has the line itself, which is strictly better evidence.

import { normalizeCueText, alignPairs } from "./cue-reconcile"
import type { CharacterRow, CameraState } from "./character-sheet"

/** The slice of an audio cue this needs. `CellData` satisfies it. */
export interface AlignableCue {
  id: string
  /** Seconds, as STORED — i.e. already timebase-corrected. */
  startTime?: number
  /** The heard line's own words. */
  original?: string
}

export interface AudioCharacterAssignment {
  cellId: string
  castName: string
  cameraState: CameraState | undefined
  /** The sheet row it came from — what an error message cites. */
  rowNumber: number
  /** Her own `Line #` for this row, when the sheet carried the column. Stored
   *  on the cue so a corrected sheet can go back in her numbering rather than
   *  ours — see `CharacterSheetColumns.lineNumber`. */
  lineNumber?: string
}

export interface AudioCharacterPlan {
  assignments: AudioCharacterAssignment[]
  /** Distinct names, for the "N people in all" line. */
  distinctCharacters: number
  /** Rows with a line but no character — screen text and the like. Skipped. */
  blankRows: number
  /** Cues the sheet does not cover. Fine: they keep whatever they have. */
  cuesWithoutRow: number
  /** Rows matching no cue at all — the wrong-episode signal. Row numbers. */
  unmatchedRows: number[]
  /** Rows where the Camera column and the angle inside the name disagreed. */
  cameraDisagreements: number
  /**
   * Rows recovered by POSITION rather than by wording — see the bracketing
   * pass below. Zero on episode 101, where the two files agree word for word,
   * and worth reporting when it is not: it means the sheet and the transcript
   * have started to drift apart.
   */
  filledByPosition: number
}

const EMPTY: AudioCharacterPlan = {
  assignments: [],
  distinctCharacters: 0,
  blankRows: 0,
  cuesWithoutRow: 0,
  unmatchedRows: [],
  cameraDisagreements: 0,
  filledByPosition: 0,
}

export interface PlanAudioCharacterArgs {
  rows: readonly CharacterRow[]
  /** The audio-cue cells, in document order. */
  cues: readonly AlignableCue[]
}

/**
 * Match the sheet's rows to the audio cues and say what assigning them would
 * do. Pure; no I/O, nothing written.
 *
 * The alignment is `alignPairs` from the reconcile path — the same
 * order-preserving matcher, with the same reason for existing. An episode
 * carries dozens of bare "Yes." lines, and plain longest-common-subsequence
 * picks the earliest of several equally long readings, which pairs a line at
 * 0:50 with one at 1:30. Proximity breaks those ties without ever being able
 * to REFUSE a match, so the three-second gap between the sheet's uncorrected
 * times and our corrected ones costs nothing.
 */
export function planAudioCharacterAssignments({
  rows,
  cues,
}: PlanAudioCharacterArgs): AudioCharacterPlan {
  if (rows.length === 0 || cues.length === 0) return EMPTY

  const pairs = alignPairs(
    rows.map((r) => normalizeCueText(r.text)),
    cues.map((c) => normalizeCueText(c.original ?? "")),
    rows.map((r) => (typeof r.startSec === "number" ? Math.round(r.startSec * 1000) : 0)),
    cues.map((c) => (typeof c.startTime === "number" ? Math.round(c.startTime * 1000) : 0)),
  )

  // Row index → cue index. `alignPairs` matches on IDENTICAL wording only, so
  // everything it returns is exact; the recovery pass below handles the rest.
  const rowToCue = new Map<number, number>(pairs)
  const matchedCues = new Set<number>(pairs.map(([, ci]) => ci))

  // A HOLE IN THE ALIGNMENT IS ALMOST CERTAINLY A MATCH. The same reasoning
  // the subtitle importer uses for its own drifted rows, and the same reason:
  // refusing a whole sheet because one line was re-transcribed would make the
  // import brittle without making it safer. If a row's nearest matched
  // neighbours on either side bracket exactly ONE spare cue, that cue is the
  // partner — no wording needed, because the neighbours pin it.
  //
  // Strictly one. Two spare cues means a wide hole, and guessing inside it is
  // how a character lands on the wrong line.
  let filledByPosition = 0
  for (let ri = 0; ri < rows.length; ri++) {
    if (rowToCue.has(ri) || rows[ri].castName === "") continue
    let before: number | undefined
    let after: number | undefined
    for (let j = ri - 1; j >= 0; j--) if (rowToCue.has(j)) { before = rowToCue.get(j); break }
    for (let j = ri + 1; j < rows.length; j++) if (rowToCue.has(j)) { after = rowToCue.get(j); break }
    if (before === undefined || after === undefined) continue
    const spare: number[] = []
    for (let ci = before + 1; ci < after; ci++) if (!matchedCues.has(ci)) spare.push(ci)
    if (spare.length !== 1) continue
    rowToCue.set(ri, spare[0])
    matchedCues.add(spare[0])
    filledByPosition++
  }

  const assignments: AudioCharacterAssignment[] = []
  const names = new Set<string>()
  let blankRows = 0
  let cameraDisagreements = 0

  for (const [ri, ci] of [...rowToCue].sort((a, b) => a[0] - b[0])) {
    const row = rows[ri]
    // A matched row with no character is screen text or a sound effect: it is
    // covered, it simply has nobody to assign.
    if (row.castName === "") {
      blankRows++
      continue
    }
    if (row.cameraDisagrees) cameraDisagreements++
    names.add(row.castName)
    assignments.push({
      cellId: cues[ci].id,
      castName: row.castName,
      cameraState: row.cameraState,
      rowNumber: row.rowNumber,
      ...(row.lineNumber ? { lineNumber: row.lineNumber } : {}),
    })
  }

  // Rows with no cue at all. THE REFUSAL SIGNAL, and the same one the subtitle
  // importer uses: a sheet from a different episode matches almost nothing, and
  // assigning the handful that happened to land is worse than doing nothing.
  // Blank rows are excluded — an uncovered row with no character to give was
  // never going to do anything either way.
  const unmatchedRows = rows
    .map((r, i) => (rowToCue.has(i) || r.castName === "" ? -1 : r.rowNumber))
    .filter((n) => n >= 0)

  return {
    assignments,
    distinctCharacters: names.size,
    blankRows,
    cuesWithoutRow: cues.length - matchedCues.size,
    unmatchedRows,
    cameraDisagreements,
    filledByPosition,
  }
}
