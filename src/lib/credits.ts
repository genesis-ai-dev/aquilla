/**
 * Display helpers for the credits accounting layer.
 *
 * Credit = 1 cent of customer-facing price.
 * creditsFor(rawCents, rail, cfg) = ceil(rawCents * markup(rail))
 *
 * This is the SINGLE SOURCE OF TRUTH for the formula on the frontend — it is
 * intentionally duplicated (not imported from auth-worker / sync-worker) per
 * spec: "small pure functions, no cross-package import".
 *
 * Spec: docs/superpowers/specs/2026-06-13-org-credits-cost-model.md
 */

export interface CreditConfig {
  markup: number
  agentMarkup: number
  dailyCap: number
  weeklyCap: number
  agentDailyCap: number
  agentWeeklyCap: number
  enforce: boolean
}

export type Rail = "llm" | "agent" | "tts"

/**
 * Convert raw provider cost (cents) to org-facing credits for a given rail.
 * Agent rail uses agentMarkup (default 5×); all others use markup (default 4×).
 *
 * WHY: agent is the "dangerous rail" — it compounds fastest. The higher markup
 * and sub-cap exist to surface that risk to org admins before budgets blow out.
 */
export function creditsFor(rawCents: number, rail: Rail, cfg: Pick<CreditConfig, "markup" | "agentMarkup">): number {
  const factor = rail === "agent" ? cfg.agentMarkup : cfg.markup
  return Math.ceil(rawCents * factor)
}

/**
 * Format a credit count as a human-readable string.
 * Credits are always integers (ceil), so we display whole numbers.
 * Large values get locale-specific thousand separators.
 *
 * Examples: 0 → "0 cr", 42 → "42 cr", 1500 → "1,500 cr"
 *
 * Non-finite input (NaN/undefined/±Infinity — e.g. a not-yet-loaded or
 * malformed credit value) is treated as 0 so the UI never renders "NaN cr".
 */
export function formatCredits(n: number): string {
  const value = Number.isFinite(n) ? n : 0
  return `${Math.round(value).toLocaleString()} cr`
}

/**
 * Return what percentage of a cap a spend value represents, clamped 0–100.
 * Returns 0 when cap ≤ 0 (unconfigured / disabled) to avoid division by zero.
 *
 * WHY: bar widths must be clamped — a spend that overshoots its cap (e.g.
 * because enforce=false) must not render a bar >100% wide.
 */
export function capUsagePct(used: number, cap: number): number {
  if (cap <= 0) return 0
  if (!Number.isFinite(used)) return 0
  return Math.min(100, Math.max(0, Math.round((used / cap) * 100)))
}
