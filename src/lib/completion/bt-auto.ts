/**
 * bt-auto.ts — Automatic statistical back-translation wiring helpers.
 *
 * Provides:
 *  - `buildStatisticalBt(glosser, translatedText)` — synchronous, no network.
 *  - `shouldAutoRecomputeBt(cell, cachedBtText)` — returns true when the cell's
 *    translated text has changed since the cached BT was produced.
 *
 * Design goals (FRO-203):
 *  - Statistical BT is the DEFAULT and runs on every target commit, client-side.
 *  - LLM polish is opt-in and layered on top — handled in ProjectWorkspace.
 *  - No per-keystroke recompute; only fires on commit.
 *  - No network calls in this module.
 *
 * This module does NOT mutate React state — callers own persistence.
 */

import type { Glosser } from "./bt-glosser"

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Run the statistical glosser on `translatedText`.
 * Returns a non-empty string (falls back to the input when the glosser
 * produces nothing useful).
 */
export function buildStatisticalBt(glosser: Glosser, translatedText: string): string {
  if (!translatedText?.trim()) return ""
  const result = glosser.gloss(translatedText)
  return result?.trim() ? result : translatedText
}

/**
 * Returns `true` when a cell's statistical BT should be (re)computed.
 *
 * A BT is stale when:
 *  - there is no cached BT yet, OR
 *  - the cell has non-empty translated text (worth glossing), AND
 *  - `cachedBtText` is empty or was produced for a different `translated` value
 *    (detected by comparing the candidate against the translated text — BTs
 *    that equal the raw translated text are the last-resort literal fallback
 *    stored when the glosser had no model yet; those should be refreshed once
 *    the corpus grows).
 *
 * NOTE: We intentionally do NOT compare event IDs here — this module has no
 * access to `targetEventId`. Callers that have event-ID staleness data may
 * apply that check independently.
 */
export function shouldAutoRecomputeBt(
  translated: string,
  cachedBtText: string | undefined,
): boolean {
  if (!translated?.trim()) return false
  if (!cachedBtText?.trim()) return true
  // If the cached BT is identical to the translated text it was the initial
  // no-model fallback — always worth a refresh when we have corpus data.
  return cachedBtText.trim() === translated.trim()
}

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
 * Prefer the just-committed event id when the caller has it (the auto-BT-on-
 * commit path); fall back to the projected head for the manual Generate/Polish
 * path, where there is no in-flight commit and the projection is already
 * current. Returns "" when neither is known so callers can skip the durable
 * emit (which requires a real target event id).
 */
export function resolveBtTargetEventId(
  committedEventId: string | undefined,
  projectedTargetEventId: string | undefined,
): string {
  return committedEventId || projectedTargetEventId || ""
}
