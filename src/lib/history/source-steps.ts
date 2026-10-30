/**
 * The history step for editing a line's SOURCE text. (Decision 11, slice 13.)
 *
 * Typing inside the open source editor keeps the editor's own undo; the whole
 * editing session becomes one step once the editor closes. Undo commits the
 * text the line had before the session — on a recorded section that is its
 * transcript, as the edit itself was (cell-text.ts) — and redo the text it
 * left. Source text belongs to every language (step-lane.ts).
 *
 * A source commit is a head compare-and-swap (AD-2): it must chain on the
 * line's current head or the server drops it as a stale sibling. So the step
 * keeps every head it has known — where the session started, each save it
 * made, each undo and redo since — and chains each write on the newest. That
 * also tells a projection that has not caught up yet (its head is one of
 * ours) from somebody else's edit (a head we never made), which skips it,
 * unless it left the words as they were: then it chains on that head.
 */
import { recordStep, type StepHandler, type StepOutcome } from "./history"
import type { TextValue } from "./edit-steps"

const DONE: StepOutcome = { kind: "done" }
const GONE: StepOutcome = { kind: "skipped", reason: "gone" }
const CHANGED: StepOutcome = { kind: "skipped", reason: "changed" }

export interface SourceTextData {
  cellId: string
  before: TextValue
  after: TextValue
  /** Every source head this step has known for the line, oldest first. */
  heads: string[]
}

export interface SourceStepContext {
  /** The line's source text as it reads now, and its head; null when gone. */
  readSource(cellId: string): { value: string; eventId: string | null } | null
  /** Commit source text chained on `parentId`; the new head, or null when refused. */
  commitSource(cellId: string, text: TextValue, parentId: string | null): Promise<string | null>
}

export function sourceStepHandlers(ctx: SourceStepContext): Record<string, StepHandler<never>> {
  const flip = async (d: SourceTextData, from: TextValue, to: TextValue): Promise<StepOutcome> => {
    const now = ctx.readSource(d.cellId)
    if (!now) return GONE
    const ours = now.eventId != null && d.heads.includes(now.eventId)
    if (!ours && now.value !== from.value) return CHANGED
    // Our own head showing: the projection may lag, so chain on our newest.
    // Someone else's head with our words (an identical re-commit) is the
    // line's head now; chaining past it would be a stale sibling the server
    // drops (review, Oct 29).
    const parent = ours ? (d.heads[d.heads.length - 1] ?? now.eventId) : (now.eventId ?? d.heads[d.heads.length - 1] ?? null)
    const id = await ctx.commitSource(d.cellId, to, parent)
    if (!id) return { kind: "failed", error: new Error("source commit refused") }
    d.heads.push(id)
    return DONE
  }
  return {
    "source.text": {
      undo: (d: SourceTextData) => flip(d, d.after, d.before),
      redo: (d: SourceTextData) => flip(d, d.before, d.after),
    } as StepHandler<never>,
  }
}

/** An open source-editing session, as the row collects it. */
export interface SourceSession {
  before: TextValue
  after: TextValue
  heads: string[]
  /** Each save's enqueue: true once queued, false when refused. */
  writes: Promise<boolean>[]
}

/** The session is over: once its saves are queued, record it as one step. */
export async function settleSourceStep(session: SourceSession, where: { cellId: string; fileId: string }): Promise<void> {
  const queued = await Promise.all(session.writes)
  if (!queued.some(Boolean) || session.before.value === session.after.value) return
  recordStep<SourceTextData>({
    kind: "source.text",
    data: { cellId: where.cellId, before: session.before, after: session.after, heads: session.heads },
    labelKey: "editor.history.stepEditSource",
    fileId: where.fileId,
  })
}
