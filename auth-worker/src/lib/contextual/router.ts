// route_risk — send high-risk spans to the full verifier panel (graph node
// `route_risk`). A CODE heuristic on inspectable fields — no model call, no
// free-text judgment. Low-risk spans still get verify_ambiguity:
// over-clarification is the failure mode this design exists to prevent, so
// that check is never skipped; the router only gates the expensive rest of
// the panel.

import type { AmbiguityEntry, ClosureExit, LintFlag, Risk, SpanDraft, VerifierKey } from "./types"

/** Register at or above this size ⇒ enough live ambiguity to warrant the panel. */
export const REGISTER_HIGH_THRESHOLD = 3
/** Any lint flags at all ⇒ the draft already violated a project rule. */
export const FLAGS_HIGH_THRESHOLD = 1
/** Validated-example coverage below this ⇒ weak retrieval support. */
export const COVERAGE_LOW_THRESHOLD = 0.5
/** Closure that needed this many rounds fought for its construal. */
export const CLOSURE_ROUNDS_HIGH_THRESHOLD = 4

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
  if (closure && (closure.rounds >= CLOSURE_ROUNDS_HIGH_THRESHOLD || closure.exit === "max-iterations" || closure.exit === "budget")) {
    reasons.push(`closure took ${closure.rounds} round(s), exit=${closure.exit}`)
  }

  const level: Risk["level"] = reasons.length > 0 ? "high" : "low"
  return {
    spanId: draft.spanId,
    level,
    reasons: level === "high" ? reasons : ["small register, clean lint, strong validated-example support"],
    sourceFindingIds: Array.from(new Set(sourceFindingIds)),
    verifiers: level === "high" ? [...ALL_VERIFIERS] : [...AMBIGUITY_ONLY],
  }
}
