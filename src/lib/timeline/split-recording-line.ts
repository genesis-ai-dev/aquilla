// AQU-2426: Split into lines… — cut one line of source audio into several lines
// (board 58, part 3; Sam Nov 6: "a split into lines should exist on any source
// audio, not recordings").
//
// A source line is a window onto a shared recording: its timing (startMs/endMs)
// says where it sits on the timeline, its attachment's trim says which stretch
// of the recording it plays. Splitting it keeps the bytes where they are and
// only makes more windows:
//
//   • the FIRST piece stays the line itself (same cell id), so a translation,
//     takes or anything else already on the line stay on the first new line,
//     as the dialog says — and the takes stay chosen (writeLineWords);
//   • every other piece is a new line right after it, sharing the recording
//     with its own trim window (the shape the importer gives a recording cut at
//     its pauses: same audioId, url and role "source");
//   • the line that followed is re-pointed at the last piece, so the file's
//     order holds (quote-split-plan.ts does the same for Split at quotes).
//
// The pieces tile the line's window exactly: the first starts where the line
// started, the last ends where it ended, nothing is dropped between them.

import { v7 as uuidv7 } from "uuid"
import { sequenceBetween } from "./derive"
import { joinWords } from "@/lib/audio/lines-from-words"
import { tokenizeWords } from "@/lib/audio/timings"
import {
  emitCellAudioAttach, emitCellAudioTrim, emitCellRetime, emitSourceCellCreate, emitSourceCellReorder,
} from "@/lib/sync/events-emit"

/** A source line of shared recording, as the split needs it. */
export interface RecordingLine {
  projectId: string
  fileId: string
  cellId: string
  /** The line's name: the recording's file name, as the importer writes it. */
  name: string
  /** Where it sits on the timeline, ms. */
  startMs: number
  endMs: number
  /** The shared recording. */
  audioId: string
  url: string
  durationMs?: number
  mimeType?: string
  /** Its stretch of the recording; absent = from the start / to the end. */
  trimStartMs?: number
  trimEndMs?: number
  sequenceIndex?: number
  /** The line after it in the file, which must be re-pointed at the last piece. */
  successor?: { cellId: string; eventId: string; sequenceIndex?: number } | null
}

export interface LinePiece {
  /** On the timeline, ms. */
  startMs: number
  endMs: number
  /** Its stretch of the recording, ms. */
  trimStartMs: number
  trimEndMs: number
  /** Its words, when the split was made from them. */
  text?: string
}

/** Pieces shorter than this are not made: a cut this close to another is noise. */
export const MIN_PIECE_MS = 200

/** The stretch of the recording a line plays, ms. */
export function lineWindow(line: Pick<RecordingLine, "startMs" | "endMs" | "trimStartMs" | "trimEndMs" | "durationMs">): { lo: number; hi: number } {
  const lo = line.trimStartMs ?? 0
  const hi = line.trimEndMs ?? line.durationMs ?? lo + (line.endMs - line.startMs)
  return { lo, hi: Math.max(lo, hi) }
}

/**
 * The pieces a line becomes when cut at `cuts` (ms on the RECORDING's clock).
 * Cuts outside the line's stretch, or closer than MIN_PIECE_MS to its ends or
 * to each other, are dropped. `texts[i]` is the i-th piece's text.
 */
export function piecesFromCuts(
  line: Pick<RecordingLine, "startMs" | "endMs" | "trimStartMs" | "trimEndMs" | "durationMs">,
  cuts: readonly number[],
  texts?: readonly string[],
): LinePiece[] {
  const { lo, hi } = lineWindow(line)
  // texts[0] is the first piece's; texts[i + 1] belongs to the piece starting
  // at cuts[i]. A cut that is dropped hands its words to the piece before.
  const paired = cuts.map((c, i) => ({ at: c, text: texts?.[i + 1] })).sort((a, b) => a.at - b.at)
  const bounds = [lo]
  const pieceTexts: Array<string | undefined> = [texts?.[0]]
  const join = (a: string | undefined, b: string | undefined) =>
    a === undefined ? b : b === undefined ? a : [a, b].filter((x) => x.trim()).join(" ")
  for (const { at, text } of paired) {
    const prev = bounds[bounds.length - 1]
    if (at - prev >= MIN_PIECE_MS && hi - at >= MIN_PIECE_MS) {
      bounds.push(Math.round(at))
      pieceTexts.push(text)
    } else {
      pieceTexts[pieceTexts.length - 1] = join(pieceTexts[pieceTexts.length - 1], text)
    }
  }
  bounds.push(hi)
  const at = (clipMs: number) => line.startMs + (clipMs - lo)
  const last = bounds.length - 2
  return bounds.slice(0, -1).map((b, i) => ({
    startMs: i === 0 ? line.startMs : at(b),
    endMs: i === last ? line.endMs : at(bounds[i + 1]),
    trimStartMs: b,
    trimEndMs: bounds[i + 1],
    ...(texts && pieceTexts[i] !== undefined ? { text: pieceTexts[i] } : {}),
  }))
}

/**
 * Words already found on a whole line (kept from a words run nobody split by,
 * seconds from `lo`, the stretch's start on the recording), shared out to the
 * pieces of a later split: each word goes to the piece its middle falls in.
 * A piece with no words gets "" — never another piece's words.
 */
export function textsForPieces(
  pieces: readonly Pick<LinePiece, "trimStartMs" | "trimEndMs">[],
  lo: number,
  words: readonly { text: string; start: number; end: number }[],
): string[] {
  const groups: Array<Array<{ text: string }>> = pieces.map(() => [])
  for (const w of words) {
    const mid = lo + ((w.start + w.end) / 2) * 1000
    let i = pieces.findIndex((p) => mid >= p.trimStartMs && mid < p.trimEndMs)
    if (i < 0) i = mid < (pieces[0]?.trimStartMs ?? 0) ? 0 : pieces.length - 1
    groups[i]!.push(w)
  }
  return groups.map((g) => joinWords(g))
}

/** Letters and digits only: punctuation and capitals are retyped freely. */
const wordCore = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

/**
 * AQU-2426 (review, Nov 9): a line's OWN text, shared out to the pieces of a
 * split by word times that go with it (seconds from `lo`): its transcript's
 * stored timings, or a kept words run when the text was corrected since.
 *
 * Each piece gets one unbroken stretch of the text as it is written now, so
 * punctuation and anything someone corrected stay exactly as typed, and no
 * word is lost or repeated. Only where each piece STARTS is taken from the
 * times: the word that starts it is found again in the text by itself and the
 * word before it, near where it should be, so words added or taken out
 * elsewhere don't move the breaks.
 *
 * Null when it can't be done: no text, no times, or text so different in
 * length from the timed words that their times say nothing about it.
 */
export function shareTextByWordTimes(
  pieces: readonly Pick<LinePiece, "trimStartMs" | "trimEndMs">[],
  lo: number,
  text: string,
  words: readonly { text: string; start: number; end: number }[],
): string[] | null {
  const tokens = tokenizeWords(text)
  const n = tokens.length
  const m = words.length
  if (n === 0 || m === 0 || pieces.length === 0) return null
  if (n > m * 2 + 4 || m > n * 2 + 4) return null
  const cores = tokens.map((tok) => wordCore(tok.word))
  const timed = words.map((w) => wordCore(w.text))
  /** The token the timed word `w` is, or where it would be. */
  const tokenOf = (w: number): number => {
    if (w <= 0) return 0
    if (w >= m) return n
    if (n === m) return w
    const guess = Math.min(n - 1, Math.max(1, Math.round((w * n) / m)))
    const reach = Math.abs(n - m) + 8
    const near = (ok: (x: number) => boolean): number | null => {
      for (let d = 0; d <= reach; d++) {
        for (const x of d === 0 ? [guess] : [guess + d, guess - d]) {
          if (x >= 1 && x < n && ok(x)) return x
        }
      }
      return null
    }
    return near((x) => timed[w] !== "" && cores[x] === timed[w] && cores[x - 1] === timed[w - 1])
      ?? near((x) => timed[w] !== "" && cores[x] === timed[w])
      ?? guess
  }
  const mids = words.map((w) => lo + ((w.start + w.end) / 2) * 1000)
  const starts = [0]
  for (let i = 1; i < pieces.length; i++) {
    const first = mids.findIndex((mid) => mid >= pieces[i]!.trimStartMs)
    starts.push(Math.max(starts[i - 1]!, tokenOf(first < 0 ? m : first)))
  }
  starts.push(n)
  return pieces.map((_, i) =>
    starts[i]! < starts[i + 1]! ? text.slice(tokens[starts[i]!]!.start, tokens[starts[i + 1]! - 1]!.end) : "")
}

/**
 * AQU-2426 (review, Nov 9): each piece's text for a split that brings no words
 * of its own (At pauses), on a line that may already have its text.
 *
 *   • A kept words run, and the line's text is still those words (or the
 *     words never reached the line): each piece gets the words in its stretch.
 *   • A kept run, but someone corrected the text since: the corrected text is
 *     shared out by the run's word times. The raw words used to overwrite it.
 *   • No kept run (the text came from Transcribe all, another device, or more
 *     than a week ago): shared out by the transcript's stored word times. It
 *     used to stay whole on the first piece.
 *   • Text with no word times to go by stays on the first piece (`stayed`),
 *     and the caller says so.
 */
export function textsForSplit(args: {
  pieces: readonly Pick<LinePiece, "trimStartMs" | "trimEndMs">[]
  /** The stretch's start on the recording, ms. */
  lo: number
  lineText: string
  kept: { words: readonly { text: string; start: number; end: number }[]; text: string } | null
  /** The transcript's stored word timings (seconds from the stretch's start). */
  timings: readonly { word: string; t0: number; t1: number }[] | undefined
}): { texts: string[] | null; stayed: boolean } {
  const { pieces, lo } = args
  const text = args.lineText.trim()
  if (args.kept && args.kept.words.length > 0) {
    if (!text || text === args.kept.text.trim()) return { texts: textsForPieces(pieces, lo, args.kept.words), stayed: false }
    const shared = shareTextByWordTimes(pieces, lo, text, args.kept.words)
    if (shared) return { texts: shared, stayed: false }
  }
  if (!text) return { texts: null, stayed: false }
  if (args.timings && args.timings.length > 0) {
    const shared = shareTextByWordTimes(pieces, lo, text, args.timings.map((w) => ({ text: w.word, start: w.t0, end: w.t1 })))
    if (shared) return { texts: shared, stayed: false }
  }
  return { texts: null, stayed: true }
}

/** What the line was before the split, for Undo. */
export interface LineBefore {
  startMs: number
  endMs: number
  trimStartMs: number | null
  trimEndMs: number | null
}

export interface SplitResult {
  /** The new lines after the first, in order, with their creating events. */
  created: Array<{ cellId: string; eventId: string }>
  before: LineBefore
  /** The first piece, for Redo. */
  first: LinePiece
  /** The line that now follows the last piece (re-pointed), if any. */
  successorCellId: string | null
}

/**
 * Put words on a line that is already there: the first piece of a split, or a
 * whole line whose words came back with nothing split.
 *
 * AQU-2426 (review, Nov 9): a words-only re-attach of the line's own source
 * clip, with no `role`. Sent as `role: "source"` it claimed the recording slot
 * in every language, so every take chosen on the line was un-chosen and the
 * line read as unrecorded until each was picked again.
 */
export async function writeLineWords(args: {
  line: Pick<RecordingLine, "projectId" | "fileId" | "cellId" | "audioId" | "url" | "durationMs" | "mimeType">
  /** "" clears the words the line had. */
  text: string
  author: string
}): Promise<void> {
  const { line } = args
  await emitCellAudioAttach({
    projectId: line.projectId,
    fileId: line.fileId,
    cellId: line.cellId,
    audioId: line.audioId,
    url: line.url,
    slot: "recording",
    ...(line.mimeType ? { mimeType: line.mimeType } : {}),
    ...(line.durationMs !== undefined ? { durationMs: Math.round(line.durationMs) } : {}),
    transcription: args.text,
    wordsOnly: true,
    author: args.author,
  })
}

/**
 * Write the split. Needs at least two pieces; with fewer, nothing is written
 * and null comes back.
 */
export async function splitRecordingLine(args: {
  line: RecordingLine
  pieces: readonly LinePiece[]
  author: string
  mintId?: () => string
}): Promise<SplitResult | null> {
  const { line, pieces, author } = args
  if (pieces.length < 2) return null
  const mint = args.mintId ?? uuidv7
  const base = { projectId: line.projectId, fileId: line.fileId, author }
  const before: LineBefore = {
    startMs: line.startMs,
    endMs: line.endMs,
    trimStartMs: line.trimStartMs ?? null,
    trimEndMs: line.trimEndMs ?? null,
  }
  const attachShared = {
    audioId: line.audioId,
    url: line.url,
    slot: "recording" as const,
    role: "source" as const,
    ...(line.mimeType ? { mimeType: line.mimeType } : {}),
    ...(line.durationMs !== undefined ? { durationMs: Math.round(line.durationMs) } : {}),
  }

  const [first, ...rest] = pieces
  await emitCellRetime({ ...base, cellId: line.cellId, startMs: first.startMs, endMs: first.endMs })
  await emitCellAudioTrim({ ...base, cellId: line.cellId, audioId: line.audioId, trimStartMs: first.trimStartMs, trimEndMs: first.trimEndMs })
  if (first.text !== undefined) {
    // The words land on the line's own source text, as transcription writes them
    // ("" clears words the whole line had kept, when none fall in this piece).
    await writeLineWords({ line, text: first.text, author })
  }

  const created: SplitResult["created"] = []
  let prev = line.cellId
  const after = line.successor?.sequenceIndex
  for (const [i, piece] of rest.entries()) {
    const cellId = mint()
    const sequenceIndex = line.sequenceIndex !== undefined
      ? (after !== undefined
          ? line.sequenceIndex + ((after - line.sequenceIndex) * (i + 1)) / (rest.length + 1)
          : sequenceBetween(line.sequenceIndex + i, undefined))
      : undefined
    const eventId = await emitSourceCellCreate({
      ...base,
      cellId,
      anchorCellId: prev,
      value: line.name,
      medium: "media",
      startMs: piece.startMs,
      endMs: piece.endMs,
      ...(sequenceIndex !== undefined ? { sequenceIndex } : {}),
      ...(piece.text ? { transcription: piece.text } : {}),
    })
    await emitCellAudioAttach({
      ...base,
      ...attachShared,
      cellId,
      trimStartMs: piece.trimStartMs,
      trimEndMs: piece.trimEndMs,
      ...(piece.text ? { transcription: piece.text } : {}),
      surface: "timeline",
    })
    created.push({ cellId, eventId })
    prev = cellId
  }
  if (line.successor) {
    await emitSourceCellReorder({
      ...base,
      cellId: line.successor.cellId,
      parentId: line.successor.eventId,
      anchorCellId: prev,
    })
  }
  return { created, before, first, successorCellId: line.successor?.cellId ?? null }
}

/** Put the first line's timing and trim back (Undo), or forward again (Redo). */
export async function writeLineWindow(args: {
  projectId: string
  fileId: string
  cellId: string
  audioId: string
  author: string
  startMs: number
  endMs: number
  trimStartMs: number | null
  trimEndMs: number | null
}): Promise<void> {
  const base = { projectId: args.projectId, fileId: args.fileId, cellId: args.cellId, author: args.author }
  await emitCellRetime({ ...base, startMs: args.startMs, endMs: args.endMs })
  await emitCellAudioTrim({ ...base, audioId: args.audioId, trimStartMs: args.trimStartMs, trimEndMs: args.trimEndMs })
}
