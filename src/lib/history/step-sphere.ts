/**
 * Undo, Redo and the History panel for one part of the app, acting on that
 * part's own steps and nothing else. (AQU-2262; Sam, Oct 30: "We should have
 * different spheres of what undos are doing. So like in settings, it should
 * only be really applying to settings.")
 *
 * The part's Undo always takes back its own newest step, even when steps made
 * elsewhere since sit above it, so it is never greyed because of them. Its
 * Redo brings back only its own steps, and its History panel lists, undoes
 * and reports only its own. Cmd/Ctrl+Z stays the project's newest step, in
 * every part of the app.
 *
 * Built on the history's out-of-order steps: `newestMatchingStep` and
 * `undoStepById` (the Station's own Undo, AQU-2327), `matchingSteps` and
 * `redoStepById`. Each step's own "changed since?" guard still decides.
 */
import { useMemo } from "react"
import {
  matchingSteps,
  newestMatchingStep,
  redoStepById,
  undoStepById,
  type HistoryResult,
  type HistoryView,
} from "./history"
import { useHistoryView } from "./useHistory"

/** Which steps belong to the part: asked of each step (of each part, for a group). */
export type StepMatch = (kind: string, data: unknown) => boolean

/** The part's Undo: its own newest step, past any newer one made elsewhere. */
export function undoNewestMatching(match: StepMatch): Promise<HistoryResult | null> {
  const next = newestMatchingStep(match)
  return next ? undoStepById(next.id) : Promise.resolve(null)
}

/** The part's Redo: the next of its own undone steps, never one made elsewhere. */
export function redoNewestMatching(match: StepMatch): Promise<HistoryResult | null> {
  const next = matchingSteps(match).redo.at(-1)
  return next ? redoStepById(next.id) : Promise.resolve(null)
}

/**
 * The part's "Undo to here": its own steps, newest first, down to and
 * including `id`; steps made elsewhere stay where they are. Stops early where
 * `undoTo` does: at a blocked, failed or moved step.
 */
export async function undoMatchingTo(
  id: string,
  match: StepMatch,
  onStep?: (result: HistoryResult) => void,
): Promise<HistoryResult[]> {
  const results: HistoryResult[] = []
  if (!matchingSteps(match).undo.some((s) => s.id === id)) return results
  for (;;) {
    const next = newestMatchingStep(match)
    if (!next) break
    const r = await undoStepById(next.id)
    if (!r) break
    results.push(r)
    onStep?.(r)
    if (r.outcome.kind === "blocked" || r.outcome.kind === "failed" || r.outcome.kind === "moved") break
    if (next.id === id) break
  }
  return results
}

/**
 * The history as the part's buttons and panel see it: only its own steps and
 * skips. Without `match`, the whole project's (the workspace's buttons).
 */
export function useMatchingHistory(match?: StepMatch): HistoryView {
  const view = useHistoryView()
  return useMemo(() => {
    if (!match) return view
    const { undo, redo } = matchingSteps(match)
    return {
      ...view,
      canUndo: !view.busy && undo.length > 0,
      canRedo: !view.busy && redo.length > 0,
      nextUndo: undo[undo.length - 1] ?? null,
      nextRedo: redo[redo.length - 1] ?? null,
      undoSteps: undo,
      redoSteps: redo,
      // A skip names only its step's kind; one logged before kinds were kept
      // belongs to no part.
      skipped: view.skipped.filter((e) => e.kind !== undefined && match(e.kind, undefined)),
    }
  }, [view, match])
}
