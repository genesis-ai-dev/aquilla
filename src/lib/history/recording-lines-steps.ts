/**
 * History steps for making lines from a recording. (Decision 11, slice 13.)
 *
 * Two ways a recording becomes lines:
 *
 * - LINES IN THE OPEN FILE ("or make rows from an audio or video file", and a
 *   linked video's own sound): the recording is cut at its pauses and each
 *   piece becomes a line. Undo removes the lines again (each removal is the
 *   same `source.cell.delete` "Remove row" writes, so Redo restores them with
 *   their timings and transcripts), but ONLY while every one of them is
 *   untouched — the rule today's "Add row" follows (P13.6). Once anyone has
 *   recorded, translated or edited one, the whole step is skipped: removing
 *   the rest would leave a file with holes in it.
 * - A NEW FILE imported from an audio or video file (gap 30): Undo moves the
 *   file to Recently deleted, again only while nobody has worked on its
 *   lines; Redo brings it back from there.
 *
 * Both belong to every language (step-lane.ts).
 */
import type { StepHandler, StepOutcome } from "./history"
import type { LineWordsMeta } from "@/lib/timeline/split-recording-line"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
/** Sam, Oct 28: its own words — "These lines have changed since you made
 *  them, so Undo left them as they are." */
const CHANGED: StepOutcome = { kind: "skipped", reason: "linesChanged" }

export interface RecordingLinesData {
  /** In file order; `eventId` is the line's creating event, its source head
   *  for as long as nobody has edited or moved it. */
  lines: Array<{ cellId: string; eventId: string | null }>
}

export interface ImportedRecordingData { fileId: string }

/** A line's place on the timeline and its stretch of the recording. */
export interface LineWindow {
  startMs: number
  endMs: number
  trimStartMs: number | null
  trimEndMs: number | null
}

/**
 * AQU-2426: Split into lines…. The line itself became the first piece, and
 * `lines` were made after it. Undo removes those (by the "lines.fromRecording"
 * rule: only while untouched) and gives the line its whole window and its
 * text back; Redo restores them and narrows the line again.
 */
export interface SplitLinesData extends RecordingLinesData {
  fileId: string
  cellId: string
  audioId: string
  before: LineWindow
  after: LineWindow
  /**
   * AQU-2426 (review, Nov 9): the line's own text, when the split rewrote it
   * (a split by words leaves the first sentence on it). Undo puts `before`
   * back and Redo `after`, each only while the text is still what the other
   * left: a correction typed since is never overwritten. Absent for a split
   * that wrote no text (at pauses, on a line with no kept words).
   */
  text?: { before: string; after: string }
  /**
   * AQU-2426 (browser pass, Nov 9): the word times and heard text that went
   * with each text, written back with it. Undo used to put the text back over
   * the first sentence's times, so the line could not be shared out again.
   */
  words?: { before: LineWordsMeta; after: LineWordsMeta }
  /** AQU-2426 (browser pass, Nov 9): the recording's address, so the text can
   *  be written back without finding the line's recordings first. */
  url?: string
}

export interface RecordingLinesContext {
  /** Whether a line is still as it was made (null when it is not there). */
  lineUntouched(cellId: string, createdEventId: string | null): boolean | null
  /** Remove a line, as "Remove row" does, naming its creating event so the
   *  server knows the undo is its author's own. False when refused. */
  removeLine(cellId: string, createdEventId: string | null): Promise<boolean>
  /**
   * Whether this person may remove the line at all. Below Maintainer the
   * server lets someone remove a line added by hand, or (Sam, Oct 28) a line
   * they made from a recording, named by its creating event, while nobody
   * else has written to it (sync-worker recording-line-authority.ts). Asked
   * before any removal, so an undo that would be refused is skipped instead
   * of queuing writes the server turns down (slice 13 evidence, Oct 27).
   * Absent: everyone may.
   */
  mayRemoveLine?(cellId: string, createdEventId: string | null): boolean
  /** Bring a removed line back. False when refused. */
  restoreLine(cellId: string): Promise<boolean>
  /** Where a file is: live, in Recently deleted, or gone for good. */
  fileState(fileId: string): "live" | "deleted" | null
  /** Whether every line of the file is untouched; "notOpen" when it can't be
   *  told because the file is not the one open. */
  fileUntouched(fileId: string): boolean | "notOpen"
  /** Move the file to Recently deleted, or bring it back from there. False
   *  when the write was refused and the file stayed where it was. */
  trashFile(fileId: string): Promise<boolean>
  restoreFile(fileId: string): Promise<boolean>
  /** AQU-2426: set a line's timing and trim. False when refused. Absent: a
   *  split cannot be undone here. */
  writeLineWindow?(d: { fileId: string; cellId: string; audioId: string }, w: LineWindow): Promise<boolean>
  /** AQU-2426 (review, Nov 9): a line's text now; null when the line is not there. */
  lineText?(cellId: string): string | null
  /** …and set it ("" clears it), with the words that go with it. False when refused. */
  writeLineText?(d: { fileId: string; cellId: string; audioId: string; url?: string }, text: string, words?: LineWordsMeta): Promise<boolean>
}

export function recordingLinesStepHandlers(ctx: RecordingLinesContext): Record<string, StepHandler<never>> {
  /** Why the lines can't be removed, asked before anything is written. */
  const refuseRemoval = (d: RecordingLinesData): StepOutcome | null => {
    const states = d.lines.map((l) => ctx.lineUntouched(l.cellId, l.eventId))
    if (states.every((s) => s === null)) return GONE
    if (states.some((s) => s !== true)) return CHANGED
    if (ctx.mayRemoveLine && d.lines.some((l) => ctx.lineUntouched(l.cellId, null) !== null && !ctx.mayRemoveLine!(l.cellId, l.eventId))) {
      return { kind: "skipped", reason: "notAllowed" }
    }
    return null
  }
  const removeAll = async (d: RecordingLinesData): Promise<StepOutcome> => {
    // Last first: each removal then has no line after it to re-point.
    let removed = 0
    for (const l of [...d.lines].reverse()) if (await ctx.removeLine(l.cellId, l.eventId)) removed += 1
    if (removed === 0) return { kind: "failed", error: new Error("the lines could not be removed") }
    return removed < d.lines.length ? { kind: "done", partial: { skipped: d.lines.length - removed } } : DONE
  }
  const fromRecording = {
    async undo(d: RecordingLinesData): Promise<StepOutcome> {
      return refuseRemoval(d) ?? removeAll(d)
    },
    async redo(d: RecordingLinesData): Promise<StepOutcome> {
      if (d.lines.some((l) => ctx.lineUntouched(l.cellId, null) !== null)) return CHANGED
      let restored = 0
      for (const l of d.lines) if (await ctx.restoreLine(l.cellId)) restored += 1
      if (restored === 0) return GONE
      return restored < d.lines.length ? { kind: "done", partial: { skipped: d.lines.length - restored } } : DONE
    },
  }
  /**
   * AQU-2426 (browser pass, Nov 9): may the line's text go from `from` to
   * `to`? Asked before anything is written. It is written when the line reads
   * `from`, and also when it already reads `to` (a page that has not yet read
   * back the split's own text); anything else is a correction typed since,
   * and the whole step is left alone. Undo used to write the window, remove
   * the lines and only then find it could not put the text back, leaving the
   * whole recording with its first sentence and the rest of the transcript
   * gone.
   */
  const textMove = (d: SplitLinesData, from: string, to: string): "none" | "write" | "changed" | "gone" => {
    if (!d.text || !ctx.writeLineText) return "none"
    const now = ctx.lineText ? ctx.lineText(d.cellId) : from
    if (now === null) return "gone"
    return now.trim() === from.trim() || now.trim() === to.trim() ? "write" : "changed"
  }
  return {
    "lines.split": {
      async undo(d: SplitLinesData) {
        if (!ctx.writeLineWindow) return { kind: "skipped", reason: "notAllowed" }
        const text = textMove(d, d.text?.after ?? "", d.text?.before ?? "")
        if (text === "gone") return GONE
        if (text === "changed") return CHANGED
        const refused = refuseRemoval(d)
        if (refused) return refused
        // The text first: should anything after it be refused, the whole
        // transcript is on the line, never lost.
        if (text === "write" && !(await ctx.writeLineText!(d, d.text!.before, d.words?.before))) {
          return { kind: "failed", error: new Error("the line's text could not be put back") }
        }
        const removed = await removeAll(d)
        if (removed.kind !== "done") {
          // Nothing was removed: the split stands, so its first line's text does too.
          if (text === "write") await ctx.writeLineText!(d, d.text!.after, d.words?.after)
          return removed
        }
        if (!(await ctx.writeLineWindow(d, d.before))) return { kind: "failed", error: new Error("the line could not be put back") }
        return removed
      },
      async redo(d: SplitLinesData) {
        if (!ctx.writeLineWindow) return { kind: "skipped", reason: "notAllowed" }
        const text = textMove(d, d.text?.before ?? "", d.text?.after ?? "")
        if (text === "gone") return GONE
        if (text === "changed") return CHANGED
        const restored = await fromRecording.redo(d)
        if (restored.kind !== "done") return restored
        if (!(await ctx.writeLineWindow(d, d.after))) return { kind: "failed", error: new Error("the line could not be split again") }
        // The text last: the lines it was shared out to are back first.
        if (text === "write" && !(await ctx.writeLineText!(d, d.text!.after, d.words?.after))) {
          return { kind: "failed", error: new Error("the line's text could not be written again") }
        }
        return restored
      },
    } as StepHandler<never>,
    "lines.fromRecording": fromRecording as StepHandler<never>,
    "file.importRecording": {
      async undo(d: ImportedRecordingData) {
        const state = ctx.fileState(d.fileId)
        if (state === null) return GONE
        if (state === "deleted") return CHANGED
        const untouched = ctx.fileUntouched(d.fileId)
        if (untouched === "notOpen") return { kind: "blocked", reason: "elsewhere" }
        if (!untouched) return CHANGED
        if (!(await ctx.trashFile(d.fileId))) return { kind: "failed", error: new Error("the file could not be moved to Recently deleted") }
        return DONE
      },
      async redo(d: ImportedRecordingData) {
        const state = ctx.fileState(d.fileId)
        if (state === null) return GONE
        if (state === "live") return CHANGED
        if (!(await ctx.restoreFile(d.fileId))) return { kind: "failed", error: new Error("the file could not be brought back") }
        return DONE
      },
    } as StepHandler<never>,
  }
}
