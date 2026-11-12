// Extract a clip's subtitles into the SOURCE lane of the time-ordered file the
// clip is attached to. (AQU-1139)
//
// The gap this closes: once a video is attached to a time-ordered file
// (`attachMediaFileToTimeline` / `attachMediaUrlToTimeline`), the only way text
// ever appeared on that file was ASR — `autoTranscribeImportedMedia` over the
// silence-split segments. A video that SHIPS WITH subtitles had nowhere to put
// them: the Import dialog's subtitle path (`emitSubtitleFile`) always mints a
// NEW file, so the cues landed beside the clip rather than on it, and
// `import-file-target.ts` only fills an existing file's TARGET column. There
// was no source-side equivalent.
//
// So this is the deterministic sibling of the ASR path: split by the sidecar's
// cues instead of by silence, and take the cue's own words as the source text.
//
// TWO DELIBERATE RESTRAINTS, both about not drifting from the Import dialog's
// subtitle import, which these cells have to be indistinguishable from:
//
//  (a) the parsers are used EXACTLY as that path uses them — no markup
//      stripping, no timing repair beyond WebVTT short-form padding, cues with
//      an end at or before their start kept as written. A sidecar is someone
//      else's finished artifact; a "repair" here would put these cells at odds
//      with the same file imported the ordinary way, and with the clip.
//  (b) speakers are dropped. `extractVttStrings` lifts a `<v Name>` voice tag
//      into `speaker`, and the normal import turns those into Cast rows — but
//      cast assignment is gated at MAINTAINER (`cast.assign`), and writing a
//      cast name into create-time metadata would route around that gate. The
//      Characters import in the same Sources menu is where cast comes from.
//
// No audio attachment is emitted either, and that is not an omission: the clip
// already sits on the file's media track, and a timed text cell is placed on
// the timeline by its own `startMs`/`endMs`. Attaching a per-cue trim window
// would be a second, redundant copy of timings the cell already carries.

import { v7 as uuidv7 } from "uuid"

import { detectFileType, isSubtitleImportFile } from "@/lib/parsers/types"
import type { TranslatableString } from "@/lib/parsers/types"
import {
  extractSrtStrings,
  extractVttStrings,
  repairShortFormCueTimestamps,
} from "@/lib/parsers/subtitle"
import { extractSbvStrings } from "@/lib/parsers/sbv"
import { emitSourceCellCreate } from "@/lib/sync/events-emit"

/** `accept` for the sidecar picker — the three formats `isSubtitleImportFile`
 *  recognises, which is the canonical answer to "is this a subtitle import?"
 *  (see its doc comment on why `sbv` keeps getting forgotten). */
export const SUBTITLE_SIDECAR_ACCEPT = ".vtt,.srt,.sbv"

export type SubtitleSidecarFormat = "vtt" | "srt" | "sbv"

export interface SubtitleSidecarReport {
  format: SubtitleSidecarFormat
  /** Cues that survived parsing — what actually gets written. */
  totalCues: number
  /** Cues whose timestamp line had to be padded to strict `HH:MM:SS.mmm`.
   *  Every one of these would otherwise have vanished WITH ITS WORDS — see
   *  `repairShortFormCueTimestamps`. VTT only; the other two formats have no
   *  short form. */
  repairedShortForm: number
  /**
   * Timestamp lines that produced no cue: an unparseable range, or a range
   * with no text under it.
   *
   * ZERO FOR SBV, AND THAT IS A LIMIT RATHER THAN A FINDING. The denominator
   * is "lines that look like a cue range", which `repairShortFormCueTimestamps`
   * counts by looking for `-->`; an SBV range is comma-separated and matches
   * nothing, so there is no honest count to report. Do not read a 0 here as
   * "nothing was dropped" for that format.
   */
  droppedCues: number
  /** Cues carrying no usable timing at all. They still import — an untimed row
   *  is translatable — but they cannot be placed on the timeline, so the count
   *  is worth showing before anything is written. */
  untimedCues: number
  /** The span the timed cues cover, in ms. Absent when none of them is timed. */
  spanStartMs?: number
  spanEndMs?: number
}

export interface ParsedSubtitleSidecar {
  cues: TranslatableString[]
  report: SubtitleSidecarReport
}

/**
 * Parse a picked sidecar into cues plus a report the dialog shows BEFORE
 * anything is written — picking the wrong file is the easy mistake here, and
 * the cue count and span are the tells.
 *
 * Throws with a user-presentable message for the two refusals: a format that
 * is not a subtitle file, and a file that yielded no cues at all.
 */
export function parseSubtitleSidecar(fileName: string, content: string): ParsedSubtitleSidecar {
  const type = detectFileType(fileName)
  if (!isSubtitleImportFile({ type })) {
    throw new Error(`"${fileName}" isn't a subtitle file — pick a .vtt, .srt or .sbv.`)
  }
  const format = type as SubtitleSidecarFormat

  // The loose `-->` count is the denominator for `droppedCues`. For VTT it is
  // also the padding pass the parser's strictness requires; for SRT the pass is
  // a no-op on the timestamps themselves (`padTimestamp` only matches a `.`
  // fraction, and SRT writes `,`), so the ORIGINAL content is what gets parsed
  // and only the count is taken from it.
  const repaired = repairShortFormCueTimestamps(content)

  const cues =
    format === "vtt"
      ? extractVttStrings(repaired.text)
      : format === "srt"
        ? extractSrtStrings(content)
        : extractSbvStrings(content)

  if (cues.length === 0) {
    throw new Error(`No subtitle cues were found in "${fileName}".`)
  }

  const starts: number[] = []
  const ends: number[] = []
  let untimedCues = 0
  for (const cue of cues) {
    if (typeof cue.start === "number" && typeof cue.end === "number") {
      starts.push(cue.start)
      ends.push(cue.end)
    } else {
      untimedCues++
    }
  }

  return {
    cues,
    report: {
      format,
      totalCues: cues.length,
      repairedShortForm: format === "vtt" ? repaired.repaired : 0,
      // Never negative: a `-->` inside a NOTE block inflates the loose count
      // without the parser having refused anything.
      droppedCues: format === "sbv" ? 0 : Math.max(0, repaired.cueLines - cues.length),
      untimedCues,
      // Min/max rather than first/last: a sidecar is not guaranteed to be
      // sorted, and a span read off the ends of an unsorted file is wrong in
      // the direction that looks plausible.
      ...(starts.length > 0
        ? {
            spanStartMs: Math.round(Math.min(...starts) * 1000),
            spanEndMs: Math.round(Math.max(...ends) * 1000),
          }
        : {}),
    },
  }
}

/** One `source.cell.create` worth of cue, chained and sequenced. */
export interface SubtitleSourceCellSpec {
  cellId: string
  /** Previous cue's cell, or the file's current tail for the first one. */
  anchorCellId: string | null
  value: string
  sequenceIndex: number
  startMs?: number
  endMs?: number
}

export interface PlanSubtitleSourceCellsOptions {
  /** The file's current LAST cell in chain order — the cues are appended after
   *  it. Null puts them at the head of the file (an empty file). */
  anchorCellId?: string | null
  /** First `sequenceIndex` to use, i.e. the file's current cell count. The
   *  media segments already attached hold 0..n-1, and a cue reusing one of
   *  those would collide on the time-ordered tiebreak. */
  startSequenceIndex?: number
}

/**
 * Map cues onto cell specs. Pure — exported so the timing/chaining arithmetic
 * is testable without an outbox.
 *
 * `startMs`/`endMs` are written only when BOTH are present, matching
 * `buildBulkCellsWithSpeakers`: half a span cannot be placed on the timeline,
 * and defaulting the missing half to zero would file the cue at the clip's
 * head. Seconds → ms uses the same `Math.round` the normalizer does
 * (`normalized-manifest.ts`), so a cue imported either way lands on the same
 * millisecond.
 */
export function planSubtitleSourceCells(
  cues: readonly TranslatableString[],
  options: PlanSubtitleSourceCellsOptions = {},
): SubtitleSourceCellSpec[] {
  const startSequenceIndex = options.startSequenceIndex ?? 0
  let prevCellId: string | null = options.anchorCellId ?? null
  return cues.map((cue, i) => {
    const cellId = uuidv7()
    const { start, end } = cue
    const spec: SubtitleSourceCellSpec = {
      cellId,
      anchorCellId: prevCellId,
      value: cue.original,
      sequenceIndex: startSequenceIndex + i,
      ...(typeof start === "number" && typeof end === "number"
        ? { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) }
        : {}),
    }
    prevCellId = cellId
    return spec
  })
}

export interface ImportSubtitleSourceContext {
  projectId: string
  fileId: string
  author: string
  anchorCellId?: string | null
  startSequenceIndex?: number
}

/**
 * Append the cues to the file as translatable source cells.
 *
 * Sequential on purpose: each cue anchors on the one before it, so a parallel
 * burst would race the projection's chain walk. Same shape as
 * `attachMediaFileToTimeline`, which chains its segments the same way. The
 * caller flushes the outbox and revalidates afterwards.
 *
 * `type: "cue"` rather than the default "text" — that is what a subtitle row is
 * everywhere else in the app, and what the timeline reads to draw a Subtitle
 * chip instead of a dialogue one.
 */
export async function importSubtitleSourceCells(
  cues: readonly TranslatableString[],
  ctx: ImportSubtitleSourceContext,
): Promise<{ cells: number }> {
  const specs = planSubtitleSourceCells(cues, {
    anchorCellId: ctx.anchorCellId ?? null,
    startSequenceIndex: ctx.startSequenceIndex ?? 0,
  })
  for (const spec of specs) {
    await emitSourceCellCreate({
      projectId: ctx.projectId,
      fileId: ctx.fileId,
      cellId: spec.cellId,
      anchorCellId: spec.anchorCellId,
      value: spec.value,
      type: "cue",
      sequenceIndex: spec.sequenceIndex,
      ...(spec.startMs !== undefined && spec.endMs !== undefined
        ? { startMs: spec.startMs, endMs: spec.endMs }
        : {}),
      author: ctx.author,
    })
  }
  return { cells: specs.length }
}

/**
 * Why an extraction must NOT be written, or null when it may be.
 *
 * Extracted as a pure guard — the `shouldApplyCheckResult` /
 * `shouldSelfHealZeroFileLink` pattern — because it is consulted at WRITE time,
 * after a person has spent a while reading a parse report, and every one of its
 * three refusals is about the world having moved in that window. Checking any of
 * them only at the render that offered the control leaves exactly the gap the
 * check exists to close.
 */
export type SubtitleExtractionRefusal =
  /** The dialog was opened for a different file than the one now active. */
  | "wrong-file"
  /** The file has no media segment, so the cues have no clock to be timed against. */
  | "no-clip"
  /** The file already has source rows; appending would duplicate them. */
  | "already-has-source-rows"

export function subtitleExtractionRefusal(args: {
  /** The file the dialog was opened for. */
  dialogFileId: string | null
  /** The file that is active now. */
  activeFileId: string | null
  /** The active file's cells. Only `medium` is read. */
  cells: readonly { medium?: string }[]
}): SubtitleExtractionRefusal | null {
  const { dialogFileId, activeFileId, cells } = args
  if (!dialogFileId || dialogFileId !== activeFileId) return "wrong-file"
  if (!cells.some((c) => c.medium === "media")) return "no-clip"
  // MEDIA SEGMENTS ARE NOT SOURCE ROWS for this test. Counting them would make
  // the check unsatisfiable: a file with a clip attached always has some, so the
  // extraction could never be offered at all.
  if (cells.some((c) => c.medium !== "media")) return "already-has-source-rows"
  return null
}
