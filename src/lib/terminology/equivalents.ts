/**
 * equivalents.ts — target-equivalent PREDICTION for source terms.
 *
 * Pure, deterministic, client-side. Combines two independent signals over the
 * bilingual WIP corpus:
 *
 *   1. χ² association  (chi-square-align.ts) — deterministic, warms instantly.
 *   2. IBM Model 1 EM  (interlinear.ts)      — read-only import, never mutated.
 *
 * Used as a CROSS-CHECK. The two models are computed independently and then
 * reconciled per source term:
 *
 *   - Both rank the same target token highly  → AGREEMENT → boost to HIGH.
 *   - Only one model surfaces it (or they disagree on the top pick) → AMBER.
 *   - Weak/low single signal                  → LOW.
 *
 * Every result is "AI-assumed": probabilistic, not a managed Concept rendering.
 * Crossing that line (promotion) is an explicit user act handled in the UI.
 *
 * `examples` carry up to 3 nearby corpus pairs that contain the source term —
 * the few-shot evidence the prediction drew from, surfaced to signal the
 * probabilistic origin (spec Slice 3, pre-mortem P6).
 */

import {
  buildAlignmentModel,
  CONFIDENCE_AMBER,
  CONFIDENCE_HIGH,
  type VersPair,
} from "@/lib/completion/interlinear"
import {
  chiSquareEquivalents,
  type BilingualPair,
  type ChiSquareCandidate,
} from "@/lib/completion/chi-square-align"

// ── Public types ──────────────────────────────────────────────────────────────

export type EquivalentSource = "chi2" | "em" | "both"
export type EquivalentConfidence = "HIGH" | "AMBER" | "LOW"

/** A corpus pair shown as few-shot evidence. */
export interface EquivalentExample {
  source: string
  target: string
}

/** A single predicted target equivalent for a source term. */
export interface PredictedEquivalent {
  /** Target token (lowercased). */
  target: string
  /** Which model(s) surfaced this candidate. */
  source: EquivalentSource
  /** Confidence band — agreement boosts to HIGH; disagreement caps at AMBER. */
  confidence: EquivalentConfidence
  /** χ² statistic, if χ² surfaced it. */
  chi2?: number
  /** IBM Model 1 P(target | source), if EM surfaced it. */
  emProb?: number
  /** Up to 3 nearby corpus pairs containing the source term (few-shot evidence). */
  examples: EquivalentExample[]
}

export interface PredictEquivalentsOpts {
  /** Max predicted equivalents per source term (default 8). */
  maxResults?: number
  /** Max few-shot examples attached to each prediction (default 3). */
  maxExamples?: number
}

// ── Tokenization (mirrors the two underlying models) ──────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu

function tokenizeSet(s: string): Set<string> {
  return new Set(Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase()))
}

// ── Confidence reconciliation ─────────────────────────────────────────────────

/**
 * Band a single EM probability against interlinear.ts thresholds
 * (HIGH ≥ 0.6, AMBER 0.3–0.6, else LOW).
 */
function bandEmProb(p: number): EquivalentConfidence {
  if (p >= CONFIDENCE_HIGH) return "HIGH"
  if (p >= CONFIDENCE_AMBER) return "AMBER"
  return "LOW"
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Predict ranked target equivalents for `sourceTerm` over `pairs`, using χ² and
 * IBM Model 1 EM as mutual cross-checks.
 *
 * Agreement (both models surface the token) → `source: "both"` and a boost to
 * HIGH confidence. Single-model candidates are capped at AMBER (χ²-only) or
 * banded by their EM probability (EM-only), reflecting pre-mortem P10: never
 * present a contested probabilistic guess as settled.
 *
 * @param pairs       Bilingual (source, target) WIP corpus pairs.
 * @param sourceTerm  Source token/term (case-insensitive).
 * @param opts        maxResults (default 8), maxExamples (default 3).
 * @returns           Predicted equivalents, ranked HIGH→AMBER→LOW then by signal.
 */
export function predictEquivalents(
  pairs: BilingualPair[],
  sourceTerm: string,
  opts: PredictEquivalentsOpts = {},
): PredictedEquivalent[] {
  const maxResults = opts.maxResults ?? 8
  const maxExamples = opts.maxExamples ?? 3
  const term = sourceTerm.trim().toLowerCase()
  if (!term || pairs.length === 0) return []

  // ── Signal 1: χ² (deterministic) ──
  const chiCandidates = chiSquareEquivalents(pairs, term, { maxResults: maxResults * 2 })
  const chiByTarget = new Map<string, ChiSquareCandidate>()
  for (const c of chiCandidates) chiByTarget.set(c.target, c)

  // ── Signal 2: IBM Model 1 EM (read-only import; not mutated) ──
  // interlinear.ts uses { source, target } pairs identical to BilingualPair.
  const model = buildAlignmentModel(pairs as VersPair[])
  const emRow = model.probTable.get(term)
  const emByTarget = new Map<string, number>()
  if (emRow) {
    // Keep the strongest EM candidates (mirror the χ² breadth).
    const sorted = Array.from(emRow.entries()).sort((a, b) => b[1] - a[1])
    for (const [t, p] of sorted.slice(0, maxResults * 2)) {
      if (p > 0) emByTarget.set(t, p)
    }
  }

  // ── Few-shot examples: nearby pairs containing the source term ──
  const termExamples: EquivalentExample[] = []
  for (const p of pairs) {
    if (tokenizeSet(p.source).has(term)) {
      termExamples.push({ source: p.source, target: p.target })
      if (termExamples.length >= maxExamples) break
    }
  }
  // Per-candidate examples: prefer pairs that show BOTH the source term and the
  // predicted target token; fall back to generic term examples.
  function examplesFor(target: string): EquivalentExample[] {
    const both: EquivalentExample[] = []
    for (const p of pairs) {
      if (tokenizeSet(p.source).has(term) && tokenizeSet(p.target).has(target)) {
        both.push({ source: p.source, target: p.target })
        if (both.length >= maxExamples) break
      }
    }
    if (both.length > 0) return both
    return termExamples.slice(0, maxExamples)
  }

  // ── Reconcile ──
  const allTargets = new Set<string>([...chiByTarget.keys(), ...emByTarget.keys()])
  const out: PredictedEquivalent[] = []

  for (const t of allTargets) {
    const chi = chiByTarget.get(t)
    const emProb = emByTarget.get(t)
    const inChi = chi !== undefined
    const inEm = emProb !== undefined

    let source: EquivalentSource
    let confidence: EquivalentConfidence

    if (inChi && inEm) {
      // Agreement across two independent models → boost to HIGH.
      source = "both"
      confidence = "HIGH"
    } else if (inEm) {
      // EM-only: band by its own probability.
      source = "em"
      confidence = bandEmProb(emProb as number)
    } else {
      // χ²-only: a single deterministic signal without EM corroboration.
      // Cap at AMBER (disagreement / unconfirmed), never HIGH.
      source = "chi2"
      confidence = "AMBER"
    }

    out.push({
      target: t,
      source,
      confidence,
      chi2: chi?.chi2,
      emProb,
      examples: examplesFor(t),
    })
  }

  // Rank: HIGH → AMBER → LOW, then by χ² (desc), then EM prob (desc), then target.
  const bandRank: Record<EquivalentConfidence, number> = { HIGH: 0, AMBER: 1, LOW: 2 }
  out.sort(
    (x, y) =>
      bandRank[x.confidence] - bandRank[y.confidence] ||
      (y.chi2 ?? 0) - (x.chi2 ?? 0) ||
      (y.emProb ?? 0) - (x.emProb ?? 0) ||
      (x.target < y.target ? -1 : x.target > y.target ? 1 : 0),
  )

  return out.slice(0, maxResults)
}
