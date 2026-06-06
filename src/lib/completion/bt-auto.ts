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
