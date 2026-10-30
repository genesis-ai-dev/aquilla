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
}

export function recordingLinesStepHandlers(ctx: RecordingLinesContext): Record<string, StepHandler<never>> {
  return {
    "lines.fromRecording": {
      async undo(d: RecordingLinesData) {
        const states = d.lines.map((l) => ctx.lineUntouched(l.cellId, l.eventId))
        if (states.every((s) => s === null)) return GONE
        if (states.some((s) => s !== true)) return CHANGED
        if (ctx.mayRemoveLine && d.lines.some((l) => ctx.lineUntouched(l.cellId, null) !== null && !ctx.mayRemoveLine!(l.cellId, l.eventId))) {
          return { kind: "skipped", reason: "notAllowed" }
        }
        // Last first: each removal then has no line after it to re-point.
        let removed = 0
        for (const l of [...d.lines].reverse()) if (await ctx.removeLine(l.cellId, l.eventId)) removed += 1
        if (removed === 0) return { kind: "failed", error: new Error("the lines could not be removed") }
        return removed < d.lines.length ? { kind: "done", partial: { skipped: d.lines.length - removed } } : DONE
      },
      async redo(d: RecordingLinesData) {
        if (d.lines.some((l) => ctx.lineUntouched(l.cellId, null) !== null)) return CHANGED
        let restored = 0
        for (const l of d.lines) if (await ctx.restoreLine(l.cellId)) restored += 1
        if (restored === 0) return GONE
        return restored < d.lines.length ? { kind: "done", partial: { skipped: d.lines.length - restored } } : DONE
      },
    } as StepHandler<never>,
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
