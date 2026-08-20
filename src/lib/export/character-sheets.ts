// Anna's two character sheets, back in her hands with our corrections in them.
// (AQU-646, 2026-08-19; annotations dropped 2026-08-20)
//
// THE LOOP THIS CLOSES. The client contact owns two spreadsheets per episode: a
// subtitle character sheet and an audio character sheet, made by two different
// teams, which is precisely why they disagree with each other. She imports both
// here, the app shows her every line the two sheets contradict
// (`lib/timeline/character-agreement.ts`), and she settles them one at a time.
// And then nothing happens. Her team carries on working from the same two
// spreadsheets — which still contain every error she just spent an afternoon
// finding — and the next episode arrives with the same five bad links in it.
// The resolving was real work that stayed inside our app. Sam, weighing this
// against everything else in the round: "a big one".
//
// So this hands the sheets back: her columns, in her order, with the character
// and camera values as they now stand. NOTHING ELSE. The first cut also marked
// every corrected row — a highlight on the changed cell, a "Changed" column
// reading `was ANDREW`, `unresolved` on links still in dispute — and Sam
// dropped all of it after seeing the real output (2026-08-20): "I don't think
// it's necessary to note that something was or wasn't resolved or what it used
// to be." So the workbook that leaves here has exactly her column set, with
// the corrected values simply sitting where the wrong ones were.
//
// A LINK STILL IN DISPUTE goes back untouched — not because a rule here says
// so any more, but structurally: resolving is the only operation that ever
// writes a value across the two sheets, so an unresolved link's two rows still
// hold what each team wrote. The old safety rule survived the removal of the
// feature that used to advertise it.
//
// WHAT REGENERATING USED TO LOSE, and no longer does (2026-08-20). Both of
// these were flagged as unfixable-by-regeneration on 2026-08-19; both turned
// out to be fixable by STORING MORE AT IMPORT, which is a much smaller change
// than rewriting her original workbook in place:
//
//   - `Line #` is HER PRODUCTION NUMBERING — episode 101 runs 10 to 710 across
//     548 rows, with 86 gaps where lines were cut. It is not derivable from
//     anything, and a 1..n counter is a different number against every row.
//     The importer now stores each row's own number on its cue
//     (`metadata.line_number`) and this file writes it back. A file imported
//     before that change carries none, so it falls back to the counter rather
//     than exporting an empty column.
//   - `Group` is her fourth camera state (25 rows in the subtitle sheet, 7 in
//     the audio one). Both importers folded it into `mixed`, so it could not
//     come back out. It is a real `CameraState` now, kept separate end to end.
//     Sam: "If those are separate camera labels, then they need to remain
//     separate camera labels throughout the project."
//
// Neither is retroactive: 101 has to be re-imported for its numbers and Group
// values to exist at all.
//
// TWO COLUMNS ARE DELIBERATELY MISSING. Her audio sheet carries `TC In (orig)`
// and `TC Out (orig)`, frame-grid timecodes like `00:01:03:05`. We cannot
// reproduce them faithfully: we store seconds, the frame rate the original
// grid was struck at is not always recoverable, and 24-against-23.976 rounds
// differently every few minutes. Writing a plausible-looking timecode that is
// two frames out in the back half of the episode would be worse than absent —
// an absent column is obviously absent, whereas a wrong timecode is invisible
// until somebody conforms an edit against it. The seconds columns beside them
// are exact and go back as they came.
//
// WE NEVER INVENT A NAME. A row whose sheet left the character blank goes back
// blank, even when the OTHER sheet names that line and the app is perfectly
// happy to resolve one across the links on screen. Filling it would not be
// correcting her file, it would be merging the other team's file into it — new
// content, from a source she did not ask us to trust, in a document she is
// about to treat as her own team's work.
//
// PURE. Two builders and an assembler; no fetching, no React, no dates. The
// orchestrator reads the cells and calls these.

import type { CellData } from "@/hooks/useCells"
import type { CameraState } from "@/lib/sync/cells-read-types"
import { formatVttTime } from "@/lib/video/vtt-generator"
import { buildXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-write"

export interface CharacterSheetsArgs {
  /** The subtitle file's cells, in any order. */
  textCells: CellData[]
  /** The audio-cue sibling's cells. */
  cueCells: CellData[]
}

/**
 * The tab names. Hers are episode-specific ("101_split subs_characters"); ours
 * say which of the two sheets this is and nothing else, because the workbook
 * she receives is one file containing both and the tabs are how she tells them
 * apart at a glance.
 */
const SUBTITLE_TAB = "Subtitle characters"
const AUDIO_TAB = "Audio characters"

/**
 * Her column order, verbatim, including the part that looks like a mistake:
 * `endTime` really does come before `startTime` in the file she sends. It is
 * copied rather than corrected because this workbook goes back into a pipeline
 * that reads her columns, and a helpful tidy-up here is a silent breaking
 * change out there.
 */
const SUBTITLE_HEADERS = [
  "ID",
  "Source",
  "endTime",
  "startTime",
  "timeStamp",
  "Character Label",
  "VTT_closest",
  "Camera",
]

/** Hers again, minus the two frame-grid timecodes — see the module header. */
const AUDIO_HEADERS = [
  "Line #",
  "startTime",
  "endTime",
  "Character",
  "Translation",
  "Camera",
]

/**
 * The gap between a name and its angle, MEASURED FROM HER OWN FILES rather than
 * guessed — they are different in the two sheets, and both are load-bearing if
 * anything downstream matches on the string.
 *
 * The audio sheet uses a NON-BREAKING space followed by three ordinary ones
 * (`LITTLE MARY MAGDALENE\u00a0   (ON)`, all 548 rows); the subtitle sheet uses
 * two ordinary spaces after a name that already ends in a full stop
 * (`LITTLE MARY MAGDALENE.  (On)`, 637 of 650 rows). A first cut wrote four
 * plain spaces into both, which is byte-different from every row she sent.
 *
 * `splitCastName` in `lib/parsers/spreadsheet.ts` reads either back — its
 * pattern wants whitespace before the bracket, and `\s` matches the
 * non-breaking space — so a sheet we export can still be re-imported without
 * losing the angle. There is a test that runs exactly that round trip.
 */
const AUDIO_SUFFIX_GAP = "\u00a0   "
const SUBTITLE_SUFFIX_GAP = "  "

// ─── Reading a cell ──────────────────────────────────────────────────────────

const castNameOf = (cell: CellData): string =>
  cell.metadata && typeof cell.metadata.cast_name === "string" ? cell.metadata.cast_name : ""

/** Her own `Line #` for this row, stored at import. Empty when this cue never
 *  came from her sheet — a line added in the app, or a file imported before
 *  2026-08-20, when nothing stored it. */
const lineNumberOf = (cell: CellData): string =>
  cell.metadata && typeof cell.metadata.line_number === "string" ? cell.metadata.line_number : ""

/**
 * The `Line #` cell: her number where we have one.
 *
 * Numeric-looking values go in as NUMBERS so the column sorts and filters in
 * Excel the way her original does; anything else (a `10a`) goes in as text
 * rather than being coerced to NaN.
 */
function lineNumberCell(stored: string): XlsxCell {
  if (!stored) return { value: "" }
  return /^-?\d+$/.test(stored) ? { value: Number(stored) } : { value: stored }
}

/** A time she can read, or nothing at all. An untimed line gets empty cells
 *  rather than `00:00:00.000`, which would read as "this line is at the top of
 *  the episode" instead of "we do not know when this line is". */
const timeCell = (seconds: number | undefined): string =>
  seconds === undefined || !Number.isFinite(seconds) ? "" : formatVttTime(seconds)

/** `00:00:22.940 --> 00:00:24.441`, the form both her sheets use — and only
 *  when both ends are known, since half a range is not a range. */
function rangeCell(start: number | undefined, end: number | undefined): string {
  const from = timeCell(start)
  const to = timeCell(end)
  return from && to ? `${from} --> ${to}` : ""
}

/** Her subtitle sheet's vocabulary: `On`, `Off`, `Mixed`, or an empty cell for
 *  a line nobody has decided about. */
function subtitleCamera(state: CameraState | undefined): string {
  if (state === "on") return "On"
  if (state === "off") return "Off"
  if (state === "mixed") return "Mixed"
  if (state === "group") return "Group"
  return ""
}

/**
 * Her audio sheet's vocabulary, which is NOT the same three words uppercased.
 *
 * She writes `ON` but `Off`, `Mixed` and `Group` — counted across all 548 rows,
 * so it is her house style and not a typo in one cell. A first cut derived this
 * by uppercasing the subtitle spelling, which turned `Off` into `OFF` in every
 * row of the file she gets back.
 *
 * `Group` reaches here for the first time on 2026-08-20; until then both
 * importers folded it into `mixed` and this column could only ever say three
 * of her four words.
 */
function audioCamera(state: CameraState | undefined): string {
  if (state === "on") return "ON"
  if (state === "off") return "Off"
  if (state === "mixed") return "Mixed"
  if (state === "group") return "Group"
  return ""
}

/**
 * A name the way the AUDIO sheet spells it: no trailing full stop.
 *
 * Her two sheets have different naming conventions — every subtitle name ends
 * in a period (`NICODEMUS.`, 637 of 650 rows) and no audio name does (0 of
 * 548). Resolving a disagreement writes the winning string onto BOTH cells, so
 * a dispute the subtitle side won leaves `NICODEMUS.` sitting on the audio
 * cue, and rendering it verbatim puts a subtitle-style name in her audio
 * column — which is how Sam's first real export came out, and why this strips
 * it (2026-08-20). Safe on every row, not just resolved ones, because a
 * trailing period simply is not part of the audio sheet's vocabulary.
 */
const audioName = (name: string): string => name.replace(/[.\s]+$/, "")

/** `LITTLE MARY MAGDALENE\u00a0   (ON)`. A name with no angle keeps no brackets
 *  — an empty `()` is not something `splitCastName` will match, and
 *  `(UNKNOWN)` would be us inventing an answer. */
function audioCharacter(name: string, state: CameraState | undefined): string {
  const clean = audioName(name)
  if (!clean) return ""
  const angle = audioCamera(state)
  return angle ? `${clean}${AUDIO_SUFFIX_GAP}(${angle})` : clean
}

/** `LITTLE MARY MAGDALENE.  (On)` — the subtitle sheet carries the angle in the
 *  Character Label too, which a first cut dropped, writing the bare name into a
 *  column that had never held one. The trailing period is HERS and stays. */
function subtitleCharacterLabel(name: string, state: CameraState | undefined): string {
  if (!name) return ""
  const angle = subtitleCamera(state)
  return angle ? `${name}${SUBTITLE_SUFFIX_GAP}(${angle})` : name
}

/**
 * Time order, with the untimed lines last.
 *
 * `Array.prototype.sort` has been stable since ES2019, so lines sharing a start
 * — and the whole untimed tail, which all compares equal at infinity — come out
 * in the order the caller had them, which is the file's own order. That matters
 * more than it sounds: the ID column is a positional counter, so an unstable
 * sort would renumber the same episode differently on two exports and make the
 * two files impossible to talk about.
 */
const inTimeOrder = (cells: readonly CellData[]): CellData[] =>
  [...cells].sort(
    (a, b) =>
      (a.startTime ?? Number.POSITIVE_INFINITY) - (b.startTime ?? Number.POSITIVE_INFINITY),
  )

// ─── The two sheets ──────────────────────────────────────────────────────────

/**
 * Her subtitle character sheet, corrected.
 *
 * `ID` is a positional counter rather than the cell id: her file numbers its
 * rows 1..n and the number is how her team refers to a line in an email. A
 * UUID in that column would be true and useless.
 */
export function buildSubtitleSheet(args: CharacterSheetsArgs): XlsxSheet {
  const rows: XlsxCell[][] = inTimeOrder(args.textCells).map((cell, index) => [
    { value: index + 1 },
    { value: cell.original },
    { value: timeCell(cell.endTime) },
    { value: timeCell(cell.startTime) },
    { value: rangeCell(cell.startTime, cell.endTime) },
    { value: subtitleCharacterLabel(castNameOf(cell), cell.cameraState) },
    // `VTT_closest` holds the same range as `timeStamp` in every row of her
    // file — it is the cue this row was matched to, and after an import that
    // is by definition the cue whose times these are.
    { value: rangeCell(cell.startTime, cell.endTime) },
    { value: subtitleCamera(cell.cameraState) },
  ])

  return { name: SUBTITLE_TAB, headers: SUBTITLE_HEADERS, rows }
}

/**
 * Her audio character sheet, corrected.
 *
 * `Translation` keeps her name for the column even though what goes in it is,
 * in our model, the cue's source text — the audio sheet was imported as a file
 * of heard lines, so the words her team typed under "Translation" are the words
 * we hold as the cue's own. Renaming a column in a file that goes back into her
 * pipeline is a change she did not ask for.
 */
export function buildAudioSheet(args: CharacterSheetsArgs): XlsxSheet {
  const ordered = inTimeOrder(args.cueCells)

  // HER NUMBERS IF WE HAVE ANY, ours if we have none at all.
  //
  // Deciding per FILE rather than per row, because the two answers mean
  // different things and mixing them would be the worst of both. A file
  // imported before line numbers were stored has none anywhere: falling back
  // per row would hand her a column of 548 blanks, which is strictly less
  // useful than our own count. A file that does carry them has one per line
  // she gave us, and a blank against anything added in the app since — and
  // there a blank is the honest answer, because that line has no number in her
  // production and inventing one is how a spreadsheet starts lying.
  const useStored = ordered.some((cell) => lineNumberOf(cell) !== "")

  const rows: XlsxCell[][] = ordered.map((cell, index) => [
    useStored ? lineNumberCell(lineNumberOf(cell)) : { value: index + 1 },
    { value: timeCell(cell.startTime) },
    { value: timeCell(cell.endTime) },
    { value: audioCharacter(castNameOf(cell), cell.cameraState) },
    { value: cell.original },
    { value: audioCamera(cell.cameraState) },
  ])

  return { name: AUDIO_TAB, headers: AUDIO_HEADERS, rows }
}

/**
 * Both sheets as one workbook, subtitle tab first.
 *
 * One file rather than two downloads, and in that order, because the subtitle
 * sheet is the one keyed to the script she reads: opening the workbook puts her
 * where she already knows how to look, with the audio sheet a click away.
 */
export function buildCharacterSheets(args: CharacterSheetsArgs): Promise<Blob> {
  return buildXlsx([buildSubtitleSheet(args), buildAudioSheet(args)])
}
