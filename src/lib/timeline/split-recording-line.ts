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
//     as the dialog says;
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
  const kept: number[] = []
  for (const c of [...cuts].sort((a, b) => a - b)) {
    const prev = kept.length ? kept[kept.length - 1] : lo
    if (c - prev >= MIN_PIECE_MS && hi - c >= MIN_PIECE_MS) kept.push(Math.round(c))
  }
  const bounds = [lo, ...kept, hi]
  const at = (clipMs: number) => line.startMs + (clipMs - lo)
  const last = bounds.length - 2
  return bounds.slice(0, -1).map((b, i) => ({
    startMs: i === 0 ? line.startMs : at(b),
    endMs: i === last ? line.endMs : at(bounds[i + 1]),
    trimStartMs: b,
    trimEndMs: bounds[i + 1],
    ...(texts?.[i] !== undefined ? { text: texts[i] } : {}),
  }))
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
  if (first.text) {
    // The words land on the line's own source text, as transcription writes them.
    await emitCellAudioAttach({ ...base, ...attachShared, cellId: line.cellId, transcription: first.text })
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
