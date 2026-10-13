/**
 * The per-user edit history — the first slice of Aquilla's app-wide undo.
 * (AQU-1767 phase 1; phase 2 extends this rather than replacing it.)
 *
 * WHAT A STEP IS. One thing a person did, with a name they would recognise
 * ("Cut take in two", "Moved take") and two functions: `undo` and `redo`. Each
 * writes COMPENSATING events — new events that put the old values back — and
 * never deletes or rewrites history, the same rule the agent undo follows
 * (src/lib/agent/undo.ts). That is what keeps undo working offline and in
 * sync: it is just more events in the outbox.
 *
 * WHEN SOMEONE ELSE GOT THERE FIRST. A step captures the state it left behind
 * when the user acted, and checks it is still there before compensating. If a
 * collaborator (or the user, some other way) changed the same thing since, the
 * step is SKIPPED and says why, instead of clobbering their work. A skipped
 * step leaves the stack, so the next undo reaches the step before it.
 *
 * SCOPE. One stack per (project, user), held in memory for the session. A step
 * recorded in one project is never undone from another.
 *
 * HOW PHASE 2 PLUGS IN. More step builders through the same `recordStep` —
 * rows (hide/show, retime), takes (select, delete, rename), settings (the blob
 * before and after) — plus a transaction id so an import or a speaker split is
 * ONE step, persistence per user, and a History panel reading `historyView`.
 * Nothing here knows about the timeline; the three phase-1 builders live with
 * the workspace that owns those writes.
 */

/** What an undo or redo did. `skipped` is not an error: it is the guard working. */
export type StepOutcome =
  | { kind: "done" }
  | { kind: "skipped"; reason: "changed" | "gone" }
  | { kind: "failed"; error: unknown }

export interface HistoryStep {
  /** i18n key naming the step, e.g. "editor.history.stepCut". */
  labelKey: string
  /** Values for the label's placeholders. */
  labelParams?: Record<string, string | number>
  /** When the user acted (ms). Decides who owns the shortcut — see arbiter.ts. */
  at: number
  undo(): Promise<StepOutcome>
  redo(): Promise<StepOutcome>
}

interface Stacks {
  undo: HistoryStep[]
  redo: HistoryStep[]
}

/** Enough to back out of an afternoon's editing without holding it forever. */
export const HISTORY_LIMIT = 100

const stacks = new Map<string, Stacks>()
const listeners = new Set<() => void>()
let activeScope: string | null = null
let busy = false

function scopeKey(projectId: string, username: string): string {
  return `${projectId}\u0000${username}`
}

function stacksFor(key: string): Stacks {
  let s = stacks.get(key)
  if (!s) {
    s = { undo: [], redo: [] }
    stacks.set(key, s)
  }
  return s
}

function emit(): void {
  snapshotCache = null
  for (const fn of listeners) fn()
}

/**
 * Which project and person the shortcut and the buttons act for. The workspace
 * sets it when a project opens; `null` when none is open.
 */
export function setHistoryScope(projectId: string | null, username: string | null): void {
  const next = projectId && username ? scopeKey(projectId, username) : null
  if (next === activeScope) return
  activeScope = next
  emit()
}

/**
 * Record a step the user just took, in the ACTIVE scope. A new step clears the
 * redo stack, as everywhere: redoing past a fresh edit would replay a branch
 * that no longer exists.
 */
export function recordStep(step: HistoryStep): void {
  if (!activeScope) return
  const s = stacksFor(activeScope)
  s.undo.push(step)
  if (s.undo.length > HISTORY_LIMIT) s.undo.splice(0, s.undo.length - HISTORY_LIMIT)
  s.redo = []
  emit()
}

export interface HistoryView {
  canUndo: boolean
  canRedo: boolean
  /** The step Undo would take back, for the button's tooltip. */
  nextUndo: Pick<HistoryStep, "labelKey" | "labelParams" | "at"> | null
  nextRedo: Pick<HistoryStep, "labelKey" | "labelParams" | "at"> | null
  busy: boolean
}

let snapshotCache: HistoryView | null = null

/** A stable snapshot for useSyncExternalStore: the same object until something changes. */
export function historyView(): HistoryView {
  if (snapshotCache) return snapshotCache
  const s = activeScope ? stacks.get(activeScope) : undefined
  const top = (list: HistoryStep[] | undefined) => {
    const step = list?.[list.length - 1]
    return step ? { labelKey: step.labelKey, labelParams: step.labelParams, at: step.at } : null
  }
  snapshotCache = {
    canUndo: !busy && (s?.undo.length ?? 0) > 0,
    canRedo: !busy && (s?.redo.length ?? 0) > 0,
    nextUndo: top(s?.undo),
    nextRedo: top(s?.redo),
    busy,
  }
  return snapshotCache
}

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export interface HistoryResult {
  step: Pick<HistoryStep, "labelKey" | "labelParams">
  outcome: StepOutcome
}

/**
 * Undo the newest step. Resolves null when there is nothing to undo, or while
 * another undo/redo is still writing (a held Ctrl+Z must not race itself).
 *
 * Done → the step moves to the redo stack. Skipped or failed → it is DROPPED:
 * its guard says the world moved on, so redoing it later would be redoing
 * something that no longer matches either.
 */
export async function undoLast(): Promise<HistoryResult | null> {
  return run("undo")
}

/** Redo the newest undone step. Same rules as {@link undoLast}, mirrored. */
export async function redoLast(): Promise<HistoryResult | null> {
  return run("redo")
}

// Presses made while a step is still running wait their turn instead of being
// dropped: five quick Cmd+Z presses undo five steps (slow-network pass,
// 2026-10-13, where a slow write made most presses vanish without a word).
let queue: Promise<unknown> = Promise.resolve()

async function run(which: "undo" | "redo"): Promise<HistoryResult | null> {
  if (!activeScope) return null
  // A press belongs to the project it was made in; if the user has moved on
  // by the time its turn comes, it does nothing.
  const scope = activeScope
  const turn = queue.then(() => runNow(which, scope))
  queue = turn.catch(() => {})
  return turn
}

async function runNow(which: "undo" | "redo", scope: string): Promise<HistoryResult | null> {
  if (activeScope !== scope) return null
  const s = stacksFor(scope)
  const from = which === "undo" ? s.undo : s.redo
  const step = from.pop()
  if (!step) return null
  busy = true
  emit()
  let outcome: StepOutcome
  try {
    outcome = await (which === "undo" ? step.undo() : step.redo())
  } catch (error) {
    outcome = { kind: "failed", error }
  } finally {
    busy = false
  }
  if (outcome.kind === "done") {
    const to = which === "undo" ? s.redo : s.undo
    to.push(step)
  }
  emit()
  return { step: { labelKey: step.labelKey, labelParams: step.labelParams }, outcome }
}

/** Newest step time in the active scope — the shortcut arbiter's input. */
export function newestStepAt(): number | null {
  const s = activeScope ? stacks.get(activeScope) : undefined
  return s?.undo[s.undo.length - 1]?.at ?? null
}

/** Tests only: forget everything. */
export function resetHistoryForTests(): void {
  stacks.clear()
  activeScope = null
  busy = false
  queue = Promise.resolve()
  emit()
}
