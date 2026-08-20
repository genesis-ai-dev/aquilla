// The character spreadsheet: reading it, and keying it to a file's cells.
// (AQU-646 stage 6, 2026-08-15)
//
// The Chosen ships a third file per episode alongside the subtitle and audio
// VTTs: an XLSX with one row per subtitle line, carrying who says it and
// whether the camera is on them. Camera state is what makes a line lip-sync
// critical, so it is worth as much as the name.
//
// THIS FILE IS ONLY THE KEYING. Everything downstream already exists —
// `splitCastName` pulls "JESUS.  (On)" apart, `emitCastAssign` writes the name
// AND the camera state, `EditorTable`'s cast gutter and `ExportDialog`'s voice
// filter both read `metadata.cast_name` directly. The one thing the existing
// cast importer (LabelImportPanel) cannot do is take a FOREIGN sheet: it
// round-trips a template we generate, keyed by our own cell refs. The client's
// sheet is keyed by timestamp. That difference is this module.
//
// THE REFUSAL IS DIRECTIONAL, AND THAT IS THE WHOLE SAFETY STORY. A cell with
// no row is fine and silent — a line nobody wrote a character for. A ROW with
// no cell is not: it means the sheet is not this episode's, and going ahead
// would assign hundreds of characters to lines they do not belong to, silently
// and with nothing on screen to say so. Row-count equality is deliberately NOT
// the test: it refuses a perfectly good file the moment anything legitimately
// differs, and it would still pass a sheet that had drifted by one.
//
// Matching by timestamp is safe HERE in a way it would not be in general,
// because these text cells never move: the source-subtitles lane is frozen for
// imported VTTs (only user-added lines are draggable) and adding lines is off
// by default. If that ever stops being true, this needs revisiting.

import { splitCastName } from "@/lib/parsers/spreadsheet"
import type { CameraState } from "@/lib/sync/cells-read-types"
import { parseTimestampRange } from "@/lib/video/vtt-generator"

// Re-exported rather than redeclared: this file used to carry its own copy of
// the union, which meant widening it for `group` (2026-08-20) would have left
// the import path three values behind the rest of the app.
export type { CameraState }

/**
 * How close a row's timestamp must be to a cell's start to be the same line.
 *
 * 25ms. Subtitle cues in these files sit at least two frames apart (~83ms at
 * 23.976fps), so this is comfortably inside the gap between neighbours while
 * still absorbing the rounding between the sheet's `HH:MM:SS.mmm` text and the
 * cell's integer `start_ms`.
 */
export const MATCH_TOLERANCE_MS = 25

export interface CharacterSheetColumns {
  /** The character/voice name. Required — without it there is nothing to do. */
  character: number
  /** Dedicated camera column, when the sheet has one. */
  camera: number | null
  /** A plain start timestamp (`00:00:22.940`). */
  start: number | null
  /** A full range (`00:00:22.940 --> 00:00:24.441`), used when there is no
   *  separate start column. */
  range: number | null
  /** The line's own words, when the sheet carries them. The AUDIO character
   *  sheet does, under "Translation", and that column is what lets its rows be
   *  matched to cues by wording instead of by timestamp — see
   *  `audio-character-sheet.ts`. Null on the subtitle sheet, which has none. */
  text: number | null
  /**
   * The client's OWN line numbering, when the sheet carries it.
   *
   * Her audio sheet does, under `Line #`, and it is production numbering
   * rather than a row count: episode 101 runs 10 to 710 across 548 rows, with
   * 86 gaps where lines were cut. Nothing about it is derivable, so an export
   * that does not store it renumbers every line in the file — which is what
   * Sam found in the first real corrected workbook (2026-08-20).
   *
   * Null on the subtitle sheet: its `ID` column is a contiguous 1..650, which
   * a positional counter already reproduces exactly (measured).
   */
  lineNumber: number | null
}

const HEADER_PATTERNS: { key: keyof CharacterSheetColumns; test: RegExp }[] = [
  { key: "character", test: /^(character|character label|cast|cast[_ ]?name|speaker|voice)$/i },
  { key: "camera", test: /^(camera|camera state|angle|on[/ ]off)$/i },
  { key: "start", test: /^(start|start[_ ]?time|begin|in)$/i },
  { key: "range", test: /^(timestamp|time[_ ]?stamp|timecode|range|cue)$/i },
  { key: "text", test: /^(translation|text|line|dialogue|dialog|source)$/i },
  // AFTER `text` on purpose. That pattern is anchored `^line$`, so the two
  // cannot both match one header — but a sheet headed plainly `Line` should
  // keep meaning the words, which is what it has always meant here.
  { key: "lineNumber", test: /^(line\s*#|line\s*(no\.?|num(ber)?)|#)$/i },
]

/**
 * Guess the mapping from a header row. Null when there is no character column,
 * which is the one field nothing can be inferred without.
 *
 * A guess, not a decision — the panel shows it and lets a person correct it,
 * which is what makes classifying by header safe enough. The 2026-08-12 plan
 * called for classifying by CONTENT SHAPE instead, and that is unnecessary
 * precisely because a human confirms.
 */
export function guessCharacterColumns(header: readonly string[]): CharacterSheetColumns | null {
  const found: Record<string, number> = {}
  header.forEach((raw, i) => {
    const name = (raw ?? "").trim()
    for (const { key, test } of HEADER_PATTERNS) {
      if (found[key] === undefined && test.test(name)) found[key] = i
    }
  })
  if (found.character === undefined) return null
  return {
    character: found.character,
    camera: found.camera ?? null,
    start: found.start ?? null,
    range: found.range ?? null,
    text: found.text ?? null,
    lineNumber: found.lineNumber ?? null,
  }
}

const CAMERA_WORDS: Record<string, CameraState> = {
  on: "on",
  off: "off",
  mixed: "mixed",
  // Its own state since 2026-08-20, not folded into `mixed` — the client's
  // sheets distinguish a group shot from a mixed one, and collapsing them here
  // meant a corrected workbook could never write `Group` back. Same change as
  // `splitCastName` makes for the embedded form.
  group: "group",
}

/** Seconds from `HH:MM:SS.mmm`, `MM:SS.mmm`, or a bare number. */
function parseClock(raw: string): number | undefined {
  const t = (raw ?? "").trim()
  if (!t) return undefined
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const parts = t.split(":")
  if (parts.length < 2 || parts.length > 3) return undefined
  const nums = parts.map(Number)
  if (nums.some((n) => Number.isNaN(n))) return undefined
  return parts.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1]
}

export interface CharacterRow {
  /** 1-based row in the sheet, header included — what an error message cites. */
  rowNumber: number
  /** The label as written, angle suffix and all. */
  raw: string
  /** `splitCastName`'s voice: the name with any trailing `(angle)` removed. */
  castName: string
  cameraState: CameraState | undefined
  /** The dedicated column and the embedded angle disagreed. Counted rather
   *  than resolved loudly — see `planCharacterAssignments`. */
  cameraDisagrees: boolean
  startSec: number | undefined
  /** The line's own words when the sheet carries them; "" when it does not. */
  text: string
  /**
   * The client's own line number for this row, verbatim and untrimmed of
   * meaning — a string, because it is an identifier rather than a quantity and
   * a value like `10a` must survive. Undefined when the sheet has no such
   * column, or when this row's cell is blank.
   *
   * NOT `rowNumber`, which is this reader's own positional counter and exists
   * to be cited in an error message. They are different numbers on every row
   * of the real file.
   */
  lineNumber: string | undefined
}

/**
 * Read the data rows. Blank-character rows come back too, flagged by an empty
 * `castName`, so the caller can count them rather than lose them silently.
 */
export function readCharacterRows(
  rows: readonly (readonly string[])[],
  cols: CharacterSheetColumns,
  hasHeader = true,
): CharacterRow[] {
  const out: CharacterRow[] = []
  const body = hasHeader ? rows.slice(1) : rows
  const offset = hasHeader ? 2 : 1
  body.forEach((row, i) => {
    const raw = (row[cols.character] ?? "").trim()
    const { voice, cameraState: embedded } = splitCastName(raw)

    // THE DEDICATED COLUMN WINS. Both carry the same vocabulary and on episode
    // 101 they never disagree — but a column is more likely to be maintained
    // than a suffix inside a display string, and the disagreement count below
    // is how a future file tells us if that stops being true.
    const columnRaw = cols.camera == null ? "" : (row[cols.camera] ?? "").trim().toLowerCase()
    const fromColumn = columnRaw ? (CAMERA_WORDS[columnRaw] ?? "mixed") : undefined
    const cameraState = fromColumn ?? embedded

    let startSec = cols.start == null ? undefined : parseClock(row[cols.start] ?? "")
    if (startSec === undefined && cols.range != null) {
      startSec = parseTimestampRange(row[cols.range] ?? "")?.start
    }

    out.push({
      rowNumber: i + offset,
      raw,
      castName: voice,
      cameraState,
      cameraDisagrees: Boolean(fromColumn && embedded && fromColumn !== embedded),
      startSec,
      text: cols.text == null ? "" : (row[cols.text] ?? "").trim(),
      lineNumber:
        cols.lineNumber == null ? undefined : (row[cols.lineNumber] ?? "").trim() || undefined,
    })
  })
  return out
}

/** The slice of a cell this needs. `CellSummary` and `CellData` both satisfy it. */
export interface KeyableCell {
  cellId?: string
  id?: string
  /** Seconds. */
  startTime?: number
}

export interface CharacterAssignment {
  cellId: string
  castName: string
  cameraState: CameraState | undefined
  rowNumber: number
  /** The client's own line number for this row, when her sheet had the column.
   *  Stored on the cell so an export can hand her numbering back. */
  lineNumber?: string
}

export interface CharacterAssignmentPlan {
  assignments: CharacterAssignment[]
  /** Rows with no character at all — the screen-text cards. Skipped, counted. */
  blankRows: number
  /** Rows whose timestamp matched no cell. NON-EMPTY MEANS REFUSE: the sheet
   *  is not this file's. Row numbers so the message can cite them. */
  unmatchedRows: number[]
  /** Cells no row covered. Fine and silent — reported for completeness only. */
  cellsWithoutRow: number
  /** Rows where the camera column and the embedded angle disagreed. */
  cameraDisagreements: number
  /** Rows the timestamp missed but POSITION recovered — see the second pass in
   *  `planCharacterAssignments`. Worth reporting: it means the sheet and the
   *  subtitles disagree slightly about where some lines start. */
  filledByPosition: number
  /** How many different people are in this episode. */
  distinctCharacters: number
}

export interface PlanCharacterAssignmentsArgs {
  rows: readonly CharacterRow[]
  cells: readonly KeyableCell[]
  toleranceMs?: number
}

/**
 * Key the sheet's rows onto the file's cells by timestamp. Pure; no I/O.
 *
 * Nearest-within-tolerance rather than first-within-tolerance, so a row sitting
 * between two cells goes to the closer one instead of whichever the loop met
 * first. A cell is claimed once — two rows cannot both take it.
 */
export function planCharacterAssignments({
  rows,
  cells,
  toleranceMs = MATCH_TOLERANCE_MS,
}: PlanCharacterAssignmentsArgs): CharacterAssignmentPlan {
  const timed = cells
    .map((c) => ({ id: c.cellId ?? c.id ?? "", startMs: Math.round((c.startTime ?? NaN) * 1000) }))
    .filter((c) => c.id !== "" && Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs)

  const assignments: CharacterAssignment[] = []
  const unmatchedRows: number[] = []
  const claimed = new Set<string>()
  let blankRows = 0
  let cameraDisagreements = 0

  for (const row of rows) {
    if (row.cameraDisagrees) cameraDisagreements++
    // A row with no character is the screen text — nothing to assign, and not
    // a failure. Counted so the report can say so.
    if (row.castName === "") {
      blankRows++
      continue
    }
    if (row.startSec === undefined) {
      unmatchedRows.push(row.rowNumber)
      continue
    }
    const wantMs = Math.round(row.startSec * 1000)
    let best: { id: string; d: number } | null = null
    for (const cell of timed) {
      if (claimed.has(cell.id)) continue
      const d = Math.abs(cell.startMs - wantMs)
      if (d > toleranceMs) continue
      if (!best || d < best.d) best = { id: cell.id, d }
    }
    if (!best) {
      unmatchedRows.push(row.rowNumber)
      continue
    }
    claimed.add(best.id)
    assignments.push({
      cellId: best.id,
      castName: row.castName,
      cameraState: row.cameraState,
      rowNumber: row.rowNumber,
      ...(row.lineNumber ? { lineNumber: row.lineNumber } : {}),
    })
  }

  // ── Second pass: recover rows that DRIFTED but are pinned by their
  // neighbours. (2026-08-15, from Sam's real import.)
  //
  // Episode 101's sheet has two rows sitting exactly 84ms after the cell they
  // belong to — two frames at 23.976fps, i.e. the minimum gap between adjacent
  // cues. Widening the tolerance is the WRONG fix for that: 84ms IS the
  // neighbour gap, so a window that reaches it can also reach the wrong line.
  //
  // Position settles it instead, with the same reasoning the cue linker uses.
  // Both lists are in time order, so if the rows either side of an unmatched
  // one took cells N and N+2, the cell at N+1 is the only thing it can be.
  // Requiring EXACTLY one free cell in the gap is what keeps this honest —
  // two candidates is a guess, and a wrong-episode sheet matches nothing at
  // all, so nothing brackets anything and this pass cannot rescue it.
  let filledByPosition = 0
  if (unmatchedRows.length > 0 && assignments.length > 0) {
    const cellIndex = new Map(timed.map((c, i) => [c.id, i]))
    const rowOrder = rows.filter((r) => r.castName !== "")
    const takenIndexFor = new Map(assignments.map((a) => [a.rowNumber, cellIndex.get(a.cellId)!]))
    const stillUnmatched: number[] = []

    for (const rowNumber of unmatchedRows) {
      const at = rowOrder.findIndex((r) => r.rowNumber === rowNumber)
      let before: number | undefined
      let after: number | undefined
      for (let i = at - 1; i >= 0; i--) {
        const t = takenIndexFor.get(rowOrder[i].rowNumber)
        if (t !== undefined) { before = t; break }
      }
      for (let i = at + 1; i < rowOrder.length; i++) {
        const t = takenIndexFor.get(rowOrder[i].rowNumber)
        if (t !== undefined) { after = t; break }
      }
      if (before === undefined || after === undefined) { stillUnmatched.push(rowNumber); continue }

      const free: number[] = []
      for (let i = before + 1; i < after; i++) if (!claimed.has(timed[i].id)) free.push(i)
      if (free.length !== 1) { stillUnmatched.push(rowNumber); continue }

      const row = rows.find((r) => r.rowNumber === rowNumber)!
      const cell = timed[free[0]]
      claimed.add(cell.id)
      takenIndexFor.set(rowNumber, free[0])
      assignments.push({
        cellId: cell.id,
        castName: row.castName,
        cameraState: row.cameraState,
        rowNumber,
        ...(row.lineNumber ? { lineNumber: row.lineNumber } : {}),
      })
      filledByPosition++
    }
    unmatchedRows.length = 0
    unmatchedRows.push(...stillUnmatched)
  }

  assignments.sort((a, b) => a.rowNumber - b.rowNumber)

  return {
    assignments,
    blankRows,
    unmatchedRows,
    cellsWithoutRow: timed.length - claimed.size,
    cameraDisagreements,
    filledByPosition,
    distinctCharacters: new Set(assignments.map((a) => a.castName)).size,
  }
}
