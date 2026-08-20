/**
 * bt-auto.ts — back-translation event-pinning helper.
 *
 * Since the back-translation UX rework, nothing auto-generates a BT on commit:
 * the LLM path (`generateBacktranslation`) is the only generation that
 * persists, and it runs only from the BT tab's explicit Generate/Refresh
 * buttons. The statistical glosser survives as an on-demand, local-only
 * The statistical glosser survives as an on-demand, local-only
 * reference (live in the BT tab as you translate, and as a disagreement
 * card against the AI reading) — never persisted as the BT of record.
 *
 * This module does NOT mutate React state — callers own persistence.
 */

/**
 * Decide which target-commit event id a freshly-produced BT should be pinned to.
 *
 * Staleness for a BT is `cells.event_id !== targetEventId` — so the BT MUST be
 * pinned to the commit it describes. Right after a `target.cell.commit`,
 * `applyOptimisticTargetEdit` has updated the row's text but NOT its
 * `event_id`: the cells projection still reports the PRE-commit head until the
 * server round-trip lands the new event id. The just-committed event id is
 * known only to the editor row that emitted it (it resolves the enqueue
 * promise). Pinning the lagging projection head makes the BT permanently stale
 * the moment the projection advances — the false "Stale — translation has
 * changed" badge this guards against.
 *
 * Prefer the just-committed event id when the caller has it; fall back to the
 * projected head for the manual Generate path, where there is no in-flight
 * commit and the projection is already current. Returns "" when neither is
 * known so callers can skip the durable emit (which requires a real target
 * event id).
 */
export function resolveBtTargetEventId(
  committedEventId: string | undefined,
  projectedTargetEventId: string | undefined,
): string {
  return committedEventId || projectedTargetEventId || ""
}
