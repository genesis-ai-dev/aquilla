// route_risk — send high-risk spans to the full verifier panel (graph node
// `route_risk`). A CODE heuristic on inspectable fields — no model call, no
// free-text judgment of its own; the one input that needed judgment (is
// unattested wording invention or morphology?) was already resolved on the
// FAST tier by support.ts, and arrives here as a boolean per cell.
// Low-risk spans still get verify_ambiguity:
// over-clarification is the failure mode this design exists to prevent, so
// that check is never skipped; the router only gates the expensive rest of
// the panel.

import type { SupportSignal } from "./support"
import type { AmbiguityEntry, ClosureExit, LintFlag, Risk, SpanDraft, VerifierKey } from "./types"

/** Register at or above this size ⇒ enough live ambiguity to warrant the panel. */
export const REGISTER_HIGH_THRESHOLD = 3
/** Any lint flags at all ⇒ the draft already violated a project rule. */
export const FLAGS_HIGH_THRESHOLD = 1
/** Validated-example coverage below this ⇒ weak retrieval support. */
export const COVERAGE_LOW_THRESHOLD = 0.5
/** Closure that needed this many rounds fought for its construal. */
export const CLOSURE_ROUNDS_HIGH_THRESHOLD = 4
/** Span-level attested share below this ⇒ the draft as a whole drifted off the
 *  retrieval, even if no single cell tripped the per-cell floor. */
export const SUPPORT_RATIO_LOW_THRESHOLD = 0.7

const ALL_VERIFIERS: VerifierKey[] = ["force", "ambiguity", "naturalness"]
const AMBIGUITY_ONLY: VerifierKey[] = ["ambiguity"]

export interface ClosureHistory {
  rounds: number
  exit: ClosureExit
}

export function classifyRisk(
  draft: SpanDraft,
  flags: LintFlag[],
  register: AmbiguityEntry[],
  /** Validated-example coverage, 0..1 (validated examples / retrieval target). */
  exampleCoverage: number,
  closure?: ClosureHistory,
  /** Two-tier support check (code flag → fast-model confirmation). Omitted or
   *  `applicable: false` means the check abstained — a thin corpus must not
   *  route every span high. */
  support?: SupportSignal,
): Risk {
  const reasons: string[] = []
  const sourceFindingIds: string[] = []

  if (register.length >= REGISTER_HIGH_THRESHOLD) {
    reasons.push(`ambiguity register has ${register.length} entries (≥${REGISTER_HIGH_THRESHOLD})`)
    sourceFindingIds.push(...register.map((a) => a.id))
  }
  if (flags.length >= FLAGS_HIGH_THRESHOLD) {
    reasons.push(`${flags.length} lint flag(s)`)
    sourceFindingIds.push(...flags.map((f) => f.ruleId))
  }
  if (exampleCoverage < COVERAGE_LOW_THRESHOLD) {
    reasons.push(`validated-example coverage ${exampleCoverage.toFixed(2)} < ${COVERAGE_LOW_THRESHOLD}`)
  }
  if (support?.applicable) {
    if (support.riskyCellIds.length > 0) {
      reasons.push(
        `${support.riskyCellIds.length} cell(s) carry wording unattested in the retrieved examples and confirmed risky`,
      )
      sourceFindingIds.push(...support.riskyCellIds.map((id) => `support:${id}`))
    }
    if (support.ratio < SUPPORT_RATIO_LOW_THRESHOLD) {
      reasons.push(
        `span support ${support.ratio.toFixed(2)} < ${SUPPORT_RATIO_LOW_THRESHOLD} (draft drifted off its retrieval)`,
      )
    }
  }
  if (closure && (closure.rounds >= CLOSURE_ROUNDS_HIGH_THRESHOLD || closure.exit === "max-iterations" || closure.exit === "budget")) {
    reasons.push(`closure took ${closure.rounds} round(s), exit=${closure.exit}`)
  }

  const level: Risk["level"] = reasons.length > 0 ? "high" : "low"
  return {
    spanId: draft.spanId,
    level,
    reasons:
      level === "high"
        ? reasons
        : [
            support?.applicable
              ? `small register, clean lint, strong validated-example support, span support ${support.ratio.toFixed(2)}`
              : "small register, clean lint, strong validated-example support",
          ],
    sourceFindingIds: Array.from(new Set(sourceFindingIds)),
    verifiers: level === "high" ? [...ALL_VERIFIERS] : [...AMBIGUITY_ONLY],
  }
}
