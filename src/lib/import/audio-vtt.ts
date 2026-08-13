// The audio-VTT import: an episode's own soundtrack transcript, parsed into
// frozen timeline cues. (AQU-646 stage 2)
//
// The Chosen ships two VTTs per episode — the subtitle file that becomes the
// project's text, and an AUDIO file: ~550 near-verbatim lines timing what is
// actually SAID in the film, deliberately misaligned with the subtitles (71 of
// episode 101's cues have no subtitle partner at all). Those cues never become
// editable rows. They land in a hidden sibling file (`AUDIO_CUES_ROLE`) whose
// only reader is the timeline's Source-audio track.
//
// This module WRAPS `extractVttStrings` instead of changing it: that parser's
// strictness is load-bearing for real subtitle imports. Wrapping costs two
// repairs, both verified against the episode-101 files:
//
//  (a) its timestamp matcher is strict `HH:MM:SS.mmm`, so a perfectly legal
//      short-form cue (`01:03.209 --> 01:03.667`, which WebVTT permits) never
//      opens a cue — and the text lines that follow are then swallowed as
//      junk, so the cue disappears WITH ITS WORDS. The trap here is silent
//      loss, not an untimed row: the parser cannot emit a cue without timings
//      at all. So short-form timestamps are padded before the text is handed
//      over, and the repairs are counted for the import report.
//  (b) it strips no markup. Episode 101's subtitle file carries seven `<i>`
//      cues; on a timeline chip that renders as a literal "<i>". So residual
//      cue tags are stripped afterwards, and a cue that was nothing but markup
//      is dropped.
//
// Everything else is left exactly as the file states it — including cues whose
// end is at or before their start. This is a transcript of a finished film:
// the cues are frozen, nothing in the app will ever edit them, and a "repair"
// that moved a boundary would only make the chips disagree with the audio.

import { v7 as uuidv7 } from "uuid"

import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { extractVttStrings } from "@/lib/parsers/subtitle"
import { AUDIO_CUES_ROLE, type TranslatableString } from "@/lib/parsers/types"
import { bulkUploadSource } from "@/lib/sync/bulk-import"

export interface AudioVttReport {
  /** Cues that survived parsing + stripping — what actually gets imported. */
  totalCues: number
  /** Cues whose timestamp line had to be padded to `HH:MM:SS.mmm`. Every one
   *  of these would otherwise have vanished, text and all. */
  repairedShortForm: number
  /** Cues that carried markup (`<i>`, `<c.loud>`, karaoke timings, …). Counts
   *  a cue that stripping emptied too — it appears in `droppedCues` as well. */
  strippedTagCues: number
  /** Timestamp lines in the file that produced no cue: unparseable ranges, a
   *  range with no text under it, or text that was pure markup. */
  droppedCues: number
}

export interface ParsedAudioVtt {
  cues: TranslatableString[]
  report: AudioVttReport
}

/** Anything shaped like a cue's timestamp line, however malformed — the
 *  denominator for `droppedCues`. Deliberately looser than the parser's own
 *  matcher: its whole job is to notice the lines the parser refused. */
const LOOSE_CUE_LINE = /^[\d:.,]+\s*-->\s*[\d:.,]+/

/** A single timestamp, with the hours field optional and either field allowed
 *  to be a single digit (`1:03.209`, `01:03.209`, `0:01:03.209`). */
const TIMESTAMP = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})$/

/**
 * Cue tags WebVTT allows inside a payload: HTML-ish spans (`<i>`, `</i>`,
 * `<c.loud>`, `<lang en>`, a mid-payload `<v Name>` — the LEADING voice tag is
 * already lifted off into `speaker` by `extractVttStrings`) and karaoke
 * timestamps (`<00:00:01.000>`).
 */
const CUE_TAG = /<(?:\/?[a-zA-Z][^>]*|\d{1,2}:\d{2}(?::\d{2})?\.\d{3})>/g

/** Pad one timestamp to the strict `HH:MM:SS.mmm` the stock parser demands.
 *  Returns the token untouched when it is already strict or isn't a timestamp
 *  at all (cue settings like `align:start` ride along on the same line). */
function padTimestamp(token: string): string {
  const m = token.match(TIMESTAMP)
  if (!m) return token
  const [, hours, minutes, seconds, millis] = m
  return `${(hours ?? "00").padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds}.${millis}`
}

/** Rewrite a cue's timestamp line. `repaired` reports whether a TIMESTAMP
 *  actually changed — not whether the line's text did, so re-spacing an
 *  already-strict line is never miscounted as a rescue. */
function repairTimestampLine(line: string): { text: string; repaired: boolean } {
  const arrow = line.indexOf("-->")
  if (arrow < 0) return { text: line, repaired: false }
  const start = line.slice(0, arrow).trim()
  const tail = line.slice(arrow + 3).trim()
  // The end timestamp is the first token after the arrow; anything after it is
  // cue settings (`align:start position:10%`), which must survive verbatim.
  const [end = "", ...settings] = tail.split(/\s+/)
  const paddedStart = padTimestamp(start)
  const paddedEnd = padTimestamp(end)
  return {
    text: [`${paddedStart} --> ${paddedEnd}`, ...settings].join(" "),
    repaired: paddedStart !== start || paddedEnd !== end,
  }
}

/** Strip cue markup and flatten the payload to the one line a chip can show.
 *  `hadTags` reports the STRIPPING only — a two-line cue being joined into one
 *  is not markup, and counting it would report hundreds of imaginary repairs
 *  on a file that contained no tags at all. */
function stripCueMarkup(text: string): { text: string; hadTags: boolean } {
  const stripped = text.replace(CUE_TAG, "")
  return { text: stripped.replace(/\s+/g, " ").trim(), hadTags: stripped !== text }
}

/**
 * Parse an audio VTT into frozen cues plus a report the import dialog shows
 * before anything is written. Pure — no network, no ids beyond the ones
 * `extractVttStrings` mints.
 */
export function parseAudioVtt(content: string): ParsedAudioVtt {
  const lines = content.split("\n")
  let looseCueLines = 0
  let repairedShortForm = 0

  const normalized = lines.map((line) => {
    const trimmed = line.trim()
    if (!LOOSE_CUE_LINE.test(trimmed)) return line
    looseCueLines++
    const { text, repaired } = repairTimestampLine(trimmed)
    if (repaired) repairedShortForm++
    return text
  })

  let strippedTagCues = 0
  const cues: TranslatableString[] = []
  for (const cue of extractVttStrings(normalized.join("\n"))) {
    const { text, hadTags } = stripCueMarkup(cue.original)
    if (hadTags) strippedTagCues++
    // A cue that was only markup has nothing to show on a chip and nothing to
    // read aloud; keeping it would put an empty card on the timeline.
    if (text === "") continue
    cues.push({ ...cue, original: text })
  }

  return {
    cues,
    report: {
      totalCues: cues.length,
      repairedShortForm,
      strippedTagCues,
      // Never negative: a `-->` inside a NOTE block would inflate the loose
      // count without the parser ever having refused anything.
      droppedCues: Math.max(0, looseCueLines - cues.length),
    },
  }
}

export interface UploadAudioCueFileArgs {
  projectId: string
  /** The text file these cues time — `files.anchor_file_id`, and the only
   *  route back to the sibling once it is hidden from every file list. */
  anchorFileId: string
  /** Names the sibling after its anchor, so the two are recognisable together
   *  in the one place siblings do surface: the server's row. */
  anchorFileName: string
  /** The picked file's name, kept in the import manifest as provenance. */
  sourceFileName: string
  cues: TranslatableString[]
  /** Mints a sync-token scoped to (projectId, fileId) — for a brand-new file
   *  that is `getTokenForFile(newFileId)`, as with every fresh import. */
  getToken: (fileId: string) => Promise<string | null>
  signal?: AbortSignal
}

export interface UploadedAudioCueFile {
  fileId: string
  cellCount: number
}

/**
 * Write the parsed cues as the anchor file's hidden audio-cue sibling.
 *
 * The cells are built by `buildBulkCellsWithSpeakers` — the exact mapping a
 * real VTT import uses (UUIDv7 ids, `anchorCellId` chained in cue order,
 * `sequenceIndex`, seconds → `startMs`/`endMs`, `type: "cue"`). Critically it
 * never sets `medium`, so these read as ordinary text cells: `medium` is the
 * app's only cell→surface discriminator, and "media" would put them on the
 * wrong surfaces entirely. Speaker pairs are discarded — an audio cue is not
 * addressable in the dialogue table, so there is no Cast row to build.
 *
 * Atomicity comes free from `bulkUploadSource`'s staged-create → finalize: the
 * file is created hidden and only published once every cell has landed, so a
 * half-failed upload leaves a tombstoned file nobody can see rather than a
 * partial track. That is why the caller can safely import first and delete the
 * previous sibling second.
 *
 * No `rawSource`/`rawBytes`: skipping the R2 artifact leg entirely is
 * deliberate. Nothing round-trips these cues back out to a file — they are
 * frozen cue data — and the artifact would only be a second copy to keep.
 */
export async function uploadAudioCueFile(
  args: UploadAudioCueFileArgs,
): Promise<UploadedAudioCueFile> {
  const fileId = uuidv7()
  const { cells } = buildBulkCellsWithSpeakers(args.cues, {
    fileName: args.sourceFileName,
    fileType: "vtt",
  })

  await bulkUploadSource({
    projectId: args.projectId,
    fileId,
    file: {
      id: uuidv7(),
      name: `${args.anchorFileName} · audio cues`,
      fileType: "vtt",
      // `role` is the discriminator; `kind: "vtt"` keeps `fileType` deriving as
      // an ordinary subtitle type, so no FileType union has to learn about it.
      role: AUDIO_CUES_ROLE,
      kind: "vtt",
      anchorFileId: args.anchorFileId,
      importFormat: "vtt",
      orderedBy: "time",
      importManifest: {
        audioVtt: { sourceFileName: args.sourceFileName, cueCount: args.cues.length },
      },
    },
    cells,
    getToken: args.getToken,
    signal: args.signal,
  })

  return { fileId, cellCount: cells.length }
}
