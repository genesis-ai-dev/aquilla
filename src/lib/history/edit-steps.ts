/**
 * History steps for what people write and decide: committed text, their own
 * approvals (text and audio), and project settings. (AQU-1767 phase 2)
 *
 * TEXT. Typing inside a cell keeps the editor's own undo while the cell is
 * open; a COMMITTED edit becomes a step here. Undo commits the previous text
 * again — the same write "Restore this version" makes — and only while the
 * cell still holds exactly the text this edit left.
 *
 * APPROVALS. Only your own vote is ever undone: it flips back while the vote
 * is still as you left it, and (for text) while the translation is still the
 * one you voted on — a vote on text that has since changed is not the same
 * vote.
 *
 * SETTINGS. A save in Project settings is one step. Undo writes back the old
 * value of each setting it changed, but only for settings still holding the
 * value this save wrote; one somebody has changed since keeps theirs.
 */
import type { StepHandler, StepOutcome } from "./history"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

export interface TextValue { value: string; valueHtml?: string }
export interface TextCommitData { cellId: string; lane: string; side: "target" | "source"; before: TextValue; after: TextValue }
export interface TextVoteData { cellId: string; lane: string; voted: boolean; editEventId: string }
export interface AudioVoteData { cellId: string; audioId: string; voted: boolean }
export interface SettingsData { changes: Array<{ key: string; before: unknown; after: unknown }> }

export interface EditStepContext {
  /** The cell's current text on a side/lane, or null when the cell is gone. */
  readText(cellId: string, side: "target" | "source", lane: string): TextValue | null
  commitText(cellId: string, side: "target" | "source", lane: string, text: TextValue): Promise<void>
  /** The translation head your vote is about, and whether you have voted on it. */
  readTextVote(cellId: string, lane: string): { editEventId: string | null; voted: boolean } | null
  setTextVote(cellId: string, lane: string, editEventId: string, voted: boolean): Promise<void>
  /** Whether you have voted on a take (null when the take is gone). */
  readAudioVote(cellId: string, audioId: string): boolean | null
  setAudioVote(cellId: string, audioId: string, voted: boolean): Promise<void>
  /** The current value of each project setting named. */
  readSettings(keys: readonly string[]): Record<string, unknown> | null
  writeSettings(patch: Record<string, unknown>): Promise<void>
}

/** Text equality the way a reader sees it: the plain value decides. */
const sameText = (a: TextValue | null, b: TextValue) => a != null && a.value === b.value

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function editStepHandlers(ctx: EditStepContext): Record<string, StepHandler<never>> {
  const textFlip = async (d: TextCommitData, from: TextValue, to: TextValue): Promise<StepOutcome> => {
    const now = ctx.readText(d.cellId, d.side, d.lane)
    if (!now) return GONE
    if (!sameText(now, from)) return CHANGED
    await ctx.commitText(d.cellId, d.side, d.lane, to)
    return DONE
  }
  const textVoteFlip = async (d: TextVoteData, from: boolean): Promise<StepOutcome> => {
    const now = ctx.readTextVote(d.cellId, d.lane)
    if (!now) return GONE
    if (now.editEventId !== d.editEventId || now.voted !== from) return CHANGED
    await ctx.setTextVote(d.cellId, d.lane, d.editEventId, !from)
    return DONE
  }
  const audioVoteFlip = async (d: AudioVoteData, from: boolean): Promise<StepOutcome> => {
    const now = ctx.readAudioVote(d.cellId, d.audioId)
    if (now == null) return GONE
    if (now !== from) return CHANGED
    await ctx.setAudioVote(d.cellId, d.audioId, !from)
    return DONE
  }
  const settingsFlip = async (d: SettingsData, which: "undo" | "redo"): Promise<StepOutcome> => {
    const now = ctx.readSettings(d.changes.map((c) => c.key))
    if (!now) return GONE
    const patch: Record<string, unknown> = {}
    for (const c of d.changes) {
      const from = which === "undo" ? c.after : c.before
      const to = which === "undo" ? c.before : c.after
      if (sameValue(now[c.key], from)) patch[c.key] = to ?? null
    }
    if (Object.keys(patch).length === 0) return CHANGED
    await ctx.writeSettings(patch)
    return Object.keys(patch).length < d.changes.length
      ? { kind: "done", partial: { skipped: d.changes.length - Object.keys(patch).length } }
      : DONE
  }

  return {
    "text.commit": {
      undo: (d: TextCommitData) => textFlip(d, d.after, d.before),
      redo: (d: TextCommitData) => textFlip(d, d.before, d.after),
    } as StepHandler<never>,
    "vote.text": {
      undo: (d: TextVoteData) => textVoteFlip(d, d.voted),
      redo: (d: TextVoteData) => textVoteFlip(d, !d.voted),
    } as StepHandler<never>,
    "vote.audio": {
      undo: (d: AudioVoteData) => audioVoteFlip(d, d.voted),
      redo: (d: AudioVoteData) => audioVoteFlip(d, !d.voted),
    } as StepHandler<never>,
    "settings.project": {
      undo: (d: SettingsData) => settingsFlip(d, "undo"),
      redo: (d: SettingsData) => settingsFlip(d, "redo"),
    } as StepHandler<never>,
  }
}
