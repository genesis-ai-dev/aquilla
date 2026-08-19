// Anna's two character sheets, back in her hands with our corrections in them.
// (AQU-646, 2026-08-19)
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
// and camera values as they now stand, and a visible record of what we changed.
//
// THE TRUST MECHANISM IS THE POINT, not the file format. A corrected
// spreadsheet that looks exactly like the one she sent us is a spreadsheet
// nobody can check, and the reasonable response to receiving one is to ignore
// it — her team would have to diff two files by eye to find out what we
// claim to have fixed. So every row we changed says so twice: the changed cell
// is highlighted, and a "Changed" column at the end reads `was ANDREW`, naming
// the value that used to be there. Her team reviews a list of diffs instead of
// trusting a file blind, and the sheet stays useful even printed.
//
// THE SAFETY RULE, and it is the one thing in here that must not be traded
// away for tidiness: a link whose disagreement is STILL OPEN goes back
// completely untouched, with "unresolved" in the Changed column. Not our best
// guess, not the value the majority of the episode uses, not the audio sheet
// because it is usually righter. Nothing. A half-corrected sheet that silently
// guessed at the rest would be strictly worse than the errors she started
// with, because the errors she started with are at least the errors her own
// team made and can recognise. Guesses wearing our name are errors nobody can
// account for. When in doubt this export says "I don't know" out loud.
//
// WHAT REGENERATING CANNOT GIVE BACK, and the reason this file may not be the
// final shape of the feature (flagged to Sam, 2026-08-19):
//
//   - `Line #` on the audio sheet is HER PRODUCTION NUMBERING, and episode
//     101's starts at 10. We never stored it — the importer reads character,
//     camera and timing and nothing else — so what goes back is our own 1..n
//     counter, which is a different number against every line in the file. If
//     anything in her process refers to a line by that number, this column is
//     actively wrong rather than merely absent.
//   - `Group` is a fourth camera state her sheets use (25 rows in the subtitle
//     sheet, 7 in the audio one). Our `CameraState` has three; `splitCastName`
//     folds Group into `mixed` on the way in, so it cannot come back out.
//
// Both are consequences of REGENERATING the sheet from what we hold rather
// than editing the file she sent. The honest fix for both is to take her
// original workbook as input and rewrite only the cells we have an opinion
// about — which is a different build, and Sam's call.
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
// about to treat as her own team's work. Same instinct as the safety rule.
//
// PURE. Two builders and an assembler; no fetching, no React, no dates. The
// orchestrator reads the cells and calls these.

import type { CellData } from "@/hooks/useCells"
import type { CharacterResolution, ProjectTtsSettings } from "@/lib/parsers/types"
import type { CueLinkIndex } from "@/lib/sync/cell-links-read"
import type { CameraState } from "@/lib/sync/cells-read-types"
import {
  compareCharacterSources,
  resolutionKey,
  type CharacterDisagreement,
} from "@/lib/timeline/character-agreement"
import { formatVttTime } from "@/lib/video/vtt-generator"
import { buildXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-write"

export interface CharacterSheetsArgs {
  /** The subtitle file's cells, in any order. */
  textCells: CellData[]
  /** The audio-cue sibling's cells. */
  cueCells: CellData[]
  links: CueLinkIndex
  settings: ProjectTtsSettings | undefined
  /**
   * The decisions, when the caller already has them to hand. Otherwise they are
   * read out of `settings` — which is the only reason `settings` is here at
   * all, and why an explicit empty record is honoured rather than falling
   * through to the settings blob.
   */
  resolutions?: Record<string, CharacterResolution>
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
  "Changed",
]

/** Hers again, minus the two frame-grid timecodes — see the module header. */
const AUDIO_HEADERS = [
  "Line #",
  "startTime",
  "endTime",
  "Character",
  "Translation",
  "Camera",
  "Changed",
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
  return state === "on" ? "On" : state === "off" ? "Off" : state === "mixed" ? "Mixed" : ""
}

/**
 * Her audio sheet's vocabulary, which is NOT the same three words uppercased.
 *
 * She writes `ON` but `Off`, `Mixed` and `Group` — counted across all 548 rows,
 * so it is her house style and not a typo in one cell. A first cut derived this
 * by uppercasing the subtitle spelling, which turned `Off` into `OFF` in every
 * row of the file she gets back.
 */
function audioCamera(state: CameraState | undefined): string {
  return state === "on" ? "ON" : state === "off" ? "Off" : state === "mixed" ? "Mixed" : ""
}

/** `LITTLE MARY MAGDALENE\u00a0   (ON)`. A name with no angle keeps no brackets
 *  — an empty `()` is not something `splitCastName` will match, and
 *  `(UNKNOWN)` would be us inventing an answer. */
function audioCharacter(name: string, state: CameraState | undefined): string {
  if (!name) return ""
  const angle = audioCamera(state)
  return angle ? `${name}${AUDIO_SUFFIX_GAP}(${angle})` : name
}

/** `LITTLE MARY MAGDALENE.  (On)` — the subtitle sheet carries the angle in the
 *  Character Label too, which a first cut dropped, writing the bare name into a
 *  column that had never held one. */
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

// ─── What happened to this row ───────────────────────────────────────────────

/** Which of the two sheets a row belongs to. The resolution record names the
 *  side that WON; a row is the rejected side exactly when it is the other one. */
type Side = "subtitle" | "audio"

interface RowMarks {
  /** The character value on this row was overruled and now holds the winner. */
  name: boolean
  /** The camera value was. */
  camera: boolean
  /** What the Changed column says. Empty for a row nobody argued about. */
  changed: string
}

const QUIET: RowMarks = { name: false, camera: false, changed: "" }

interface MarksArgs {
  side: Side
  cell: CellData
  /** The cells on the other sheet this one is linked to. */
  linkedIds: readonly string[]
  /** Every link still in dispute, by resolution key. */
  open: ReadonlyMap<string, CharacterDisagreement>
  resolutions: Record<string, CharacterResolution> | undefined
  /** The camera vocabulary of the sheet being written, so the note reads in the
   *  same words as the column it is about. */
  formatCamera: (state: CameraState | undefined) => string
}

/**
 * Decide, per axis, whether this row was corrected — and say so in words.
 *
 * WHICH SHEET WAS THE REJECTED SIDE. The record keeps `chose` (the sheet that
 * was believed) and `rejected` (what the other one said), and nothing else: the
 * losing SIDE is not stored because it is always the one `chose` is not. That
 * is enough, because resolving writes the winning value to BOTH cells — so the
 * sheet that changed underneath Anna's team is exactly the sheet `chose` does
 * not name, and its row is the one that owes them an explanation. The winning
 * sheet's row is unremarkable and goes back with an empty Changed cell; it says
 * today what it said when she sent it.
 *
 * PER AXIS, not per row. One line can disagree about the speaker AND the shot,
 * and the two can be settled weeks apart. A row whose name is decided and whose
 * camera is still argued about must be able to say both things at once —
 * hiding the settled half would waste the review, and claiming the open half
 * would break the safety rule.
 *
 * A record whose rejected value EQUALS what the cell holds now says nothing and
 * is skipped, mirroring the self-healing in `character-agreement.ts`. Such
 * records exist: the 2026-08-18 re-click bug wrote them, and undoing a
 * resolution leaves one behind too. Rendering it would put `was ANDREW` beside
 * a cell reading ANDREW, which is not a diff — it is a reason to distrust every
 * other row in the file.
 */
function marksFor({ side, cell, linkedIds, open, resolutions, formatCamera }: MarksArgs): RowMarks {
  if (linkedIds.length === 0) return QUIET

  const currentName = castNameOf(cell)
  const nameNotes: string[] = []
  const cameraNotes: string[] = []
  let nameChanged = false
  let cameraChanged = false
  let unresolved = false

  for (const otherId of linkedIds) {
    const key =
      side === "subtitle" ? resolutionKey(cell.id, otherId) : resolutionKey(otherId, cell.id)
    const dispute = open.get(key)
    const record = resolutions?.[key]

    // An OPEN axis wins over any record on that axis, always. A record can
    // survive a hand edit that reopened the argument, and marking the row
    // corrected while the two sheets currently contradict each other would be
    // the one lie this column exists to prevent.
    if (dispute?.name) {
      unresolved = true
    } else if (
      record?.name &&
      record.name.chose !== side &&
      record.name.rejected !== currentName
    ) {
      nameChanged = true
      nameNotes.push(`was ${record.name.rejected}`)
    }

    if (dispute?.camera) {
      unresolved = true
    } else if (
      record?.camera &&
      record.camera.chose !== side &&
      record.camera.rejected !== cell.cameraState
    ) {
      cameraChanged = true
      cameraNotes.push(`was ${formatCamera(record.camera.rejected)}`)
    }
  }

  // Notes in column order — the name column comes before the camera column on
  // both sheets — so a row with two of them reads left to right against the two
  // highlighted cells. Deduplicated because a row serving several cues can
  // collect the same note once per cue.
  const notes = [...new Set([...nameNotes, ...cameraNotes])]
  if (unresolved) notes.push("unresolved")
  return { name: nameChanged, camera: cameraChanged, changed: notes.join("; ") }
}

/** The caller's record if there is one, else the project's. See
 *  `CharacterSheetsArgs.resolutions`. */
const resolutionsOf = (
  args: CharacterSheetsArgs,
): Record<string, CharacterResolution> | undefined =>
  args.resolutions ?? args.settings?.characterResolutions

/**
 * Every link still in dispute, keyed the way the records are.
 *
 * Asked of `compareCharacterSources` rather than worked out here, because a
 * second implementation of "do these two sheets disagree" would drift from the
 * one on screen — and then the export would mark a row corrected that the
 * drawer is still asking her about. The comparison is the subtle part (trailing
 * full stops, non-breaking spaces, `mixed` contradicting nothing); it lives in
 * one place.
 */
function openByLink(args: CharacterSheetsArgs): Map<string, CharacterDisagreement> {
  const resolutions = resolutionsOf(args)
  const agreement = compareCharacterSources({
    cues: args.cueCells,
    textCells: args.textCells,
    links: args.links,
    ...(resolutions ? { resolutions } : {}),
  })
  return new Map(agreement.open.map((d) => [resolutionKey(d.textCellId, d.cueCellId), d]))
}

// ─── The two sheets ──────────────────────────────────────────────────────────

/**
 * Her subtitle character sheet, corrected.
 *
 * `ID` is a positional counter rather than the cell id: her file numbers its
 * rows 1..n and the number is how her team refers to a line in an email. A
 * UUID in that column would be true and useless.
 */
export function buildSubtitleSheet(args: CharacterSheetsArgs): XlsxSheet {
  const open = openByLink(args)
  const resolutions = resolutionsOf(args)

  const rows: XlsxCell[][] = inTimeOrder(args.textCells).map((cell, index) => {
    const marks = marksFor({
      side: "subtitle",
      cell,
      linkedIds: args.links.cuesForText.get(cell.id) ?? [],
      open,
      resolutions,
      formatCamera: subtitleCamera,
    })
    return [
      { value: index + 1 },
      { value: cell.original },
      { value: timeCell(cell.endTime) },
      { value: timeCell(cell.startTime) },
      { value: rangeCell(cell.startTime, cell.endTime) },
      {
        value: subtitleCharacterLabel(castNameOf(cell), cell.cameraState),
        // Highlighted for EITHER axis: the one string carries both, exactly as
        // it does on the audio sheet.
        highlight: marks.name || marks.camera,
      },
      // `VTT_closest` holds the same range as `timeStamp` in every row of her
      // file — it is the cue this row was matched to, and after an import that
      // is by definition the cue whose times these are.
      { value: rangeCell(cell.startTime, cell.endTime) },
      { value: subtitleCamera(cell.cameraState), highlight: marks.camera },
      { value: marks.changed },
    ]
  })

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
  const open = openByLink(args)
  const resolutions = resolutionsOf(args)

  const rows: XlsxCell[][] = inTimeOrder(args.cueCells).map((cell, index) => {
    const marks = marksFor({
      side: "audio",
      cell,
      linkedIds: args.links.textForCue.get(cell.id) ?? [],
      open,
      resolutions,
      formatCamera: audioCamera,
    })
    return [
      { value: index + 1 },
      { value: timeCell(cell.startTime) },
      { value: timeCell(cell.endTime) },
      // Highlighted for EITHER axis, because the string in this one cell
      // carries both: settling a camera dispute rewrites the `(ON)` suffix
      // inside it, and an unmarked `(ON)` where her team wrote `(OFF)` is
      // exactly the silent change the highlight exists to prevent.
      {
        value: audioCharacter(castNameOf(cell), cell.cameraState),
        highlight: marks.name || marks.camera,
      },
      { value: cell.original },
      { value: audioCamera(cell.cameraState), highlight: marks.camera },
      { value: marks.changed },
    ]
  })

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
