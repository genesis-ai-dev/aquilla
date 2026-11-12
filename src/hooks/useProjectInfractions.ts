/**
 * useProjectInfractions — project-wide rule violations, computed without
 * blocking the main thread (AQU-1864).
 *
 * The rules pane used to compute this inside a render-time `useMemo`: every
 * enabled rule over every cell of the project, synchronously, during render.
 * On a full Bible (~31k cells, ~20 rules) that is ~600k evaluations and the
 * page froze for seconds — on open, and again on every outbox change, because
 * `useProjectCells` republishes the corpus whenever the outbox moves.
 *
 * Here the work is scheduled instead: `InfractionScan` is advanced in slices
 * bounded by a time budget, each slice is followed by a yield back to the
 * browser, and the result is published after every slice so counts fill in
 * progressively rather than arriving all at once. Because the scan caches per
 * cell, a corpus republished after one edit re-evaluates one cell.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { InfractionScan, rulesFingerprint } from "@/lib/rules/incremental-infractions"
import type { CellData } from "@/hooks/useCells"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"

/**
 * Milliseconds of rule evaluation per slice. Well under the ~50 ms "long
 * task" threshold, so even a slice that overruns its last cell stays far from
 * the ~200 ms responsiveness budget in the ticket's acceptance criteria.
 */
const SLICE_BUDGET_MS = 8

/**
 * Cells per slice before the clock is consulted. Reading `performance.now()`
 * once per cell would itself be a measurable share of the work on cheap rules.
 */
const CELLS_PER_PROBE = 64

export interface UseProjectInfractionsResult {
  /** Infractions by cell id — the same shape the eager scan produced. */
  infractions: Map<string, RuleInfraction[]>
  /** True while cells remain to evaluate; `infractions` is then partial. */
  scanning: boolean
  /** Cells still to evaluate, for a progress hint. */
  pending: number
}

/**
 * Two published maps are equal when they hold the same cells and the very same
 * result arrays — the scan reuses a cell's array by reference while the cell is
 * unchanged, so this is exact, not a heuristic.
 *
 * It exists to keep a new Map from being published when nothing changed, which
 * does two jobs: a slice that finds no new infractions (most of them, on a
 * mostly-clean corpus) costs no re-render, and a caller that rebuilds its
 * `cells` array on every render (a `.flatMap()` in the render body rather than
 * a memo) cannot spin — set state, re-render, re-plan, repeat.
 */
function sameInfractions(
  a: ReadonlyMap<string, RuleInfraction[]>,
  b: ReadonlyMap<string, RuleInfraction[]>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [cellId, infractions] of a) {
    if (b.get(cellId) !== infractions) return false
  }
  return true
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

/** Hand the thread back, preferring idle time but never waiting for it. */
function scheduleSlice(run: () => void): () => void {
  const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : null
  if (idle) {
    // `timeout` keeps a busy page from starving the scan indefinitely.
    const handle = idle(() => run(), { timeout: 100 })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, 0)
  return () => clearTimeout(handle)
}

export function useProjectInfractions(
  cells: readonly CellData[],
  enabledRules: readonly TranslationRule[],
): UseProjectInfractionsResult {
  const scanRef = useRef<InfractionScan | null>(null)
  const [state, setState] = useState<{ infractions: Map<string, RuleInfraction[]>; pending: number }>(
    () => ({ infractions: new Map(), pending: 0 }),
  )

  // Re-planning is keyed on the rule set's identity, not its array identity:
  // `useRules` rebuilds the array on unrelated renders, and a re-plan that
  // found nothing to do would still publish a new Map every time.
  const rulesKey = useMemo(() => rulesFingerprint(enabledRules), [enabledRules])

  useEffect(() => {
    const publish = (scan: InfractionScan) => {
      setState((prev) => {
        const infractions = scan.snapshot()
        if (prev.pending === scan.pending && sameInfractions(prev.infractions, infractions)) return prev
        return { infractions, pending: scan.pending }
      })
    }

    const scan = scanRef.current ?? (scanRef.current = new InfractionScan())
    scan.plan(cells, enabledRules)

    // Publish what the cache already knows (the unchanged cells) immediately,
    // so an outbox republish never blanks counts that are still correct.
    publish(scan)
    if (scan.done) return

    let cancel: (() => void) | null = null
    let disposed = false

    const runSlice = () => {
      cancel = null
      if (disposed) return
      const deadline = now() + SLICE_BUDGET_MS
      let done = scan.step(CELLS_PER_PROBE)
      while (!done && now() < deadline) done = scan.step(CELLS_PER_PROBE)
      publish(scan)
      if (!done) cancel = scheduleSlice(runSlice)
    }

    cancel = scheduleSlice(runSlice)
    return () => {
      disposed = true
      cancel?.()
    }
    // `rulesKey` stands in for `enabledRules`: same rules, same scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, rulesKey])

  return { infractions: state.infractions, scanning: state.pending > 0, pending: state.pending }
}
