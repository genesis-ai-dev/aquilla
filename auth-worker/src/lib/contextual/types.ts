// Contextual-translation pipeline — edge schemas + the model interface.
//
// These are the typed edges of the graph in
// docs/superpowers/specs/2026-07-25-contextual-translation.graph.yaml. Every
// node is a plain async function whose inputs/outputs are these JSON-safe
// shapes — no class instances cross a node boundary, so the Workflows runtime
// (or a plain test harness) can serialize any edge value verbatim.

// ── Model interface ──────────────────────────────────────────────────────────

export type Tier = "fast" | "mid" | "deep"

export interface LlmRequest {
  system: string
  user: string
  tier: Tier
  maxTokens: number
  temperature: number
}

/** The ONLY way any node reaches a model. Injected; tests script it. */
export type LlmCall = (req: LlmRequest) => Promise<string>

// ── Budget (graph spec §budget: caps enforced in code, not by convention) ────

export const TIER_WEIGHTS: Record<Tier, number> = { fast: 1, mid: 5, deep: 25 }
export const MAX_UNITS_PER_SPAN = 200
export const MAX_CALLS_PER_SPAN = 24
/** scene_closure loop-local unit cap (graph loop stop: max_units 40). */
export const CLOSURE_LOOP_MAX_UNITS = 40
export const CLOSURE_MAX_ITERATIONS = 6
export const REDRAFT_MAX_ITERATIONS = 2

export interface RunBudget {
  unitsUsed: number
  callsUsed: number
  maxUnits: number
  maxCalls: number
}

export function createRunBudget(overrides?: Partial<Pick<RunBudget, "maxUnits" | "maxCalls">>): RunBudget {
  return {
    unitsUsed: 0,
    callsUsed: 0,
    maxUnits: overrides?.maxUnits ?? MAX_UNITS_PER_SPAN,
    maxCalls: overrides?.maxCalls ?? MAX_CALLS_PER_SPAN,
  }
}

export type ChargeResult = { ok: true } | { ok: false; reason: string }

/** Charge one model call at the tier's weight. Mutates the counters; refuses
 *  (without charging) when either cap would be exceeded. */
export function chargeBudget(budget: RunBudget, tier: Tier): ChargeResult {
  const weight = TIER_WEIGHTS[tier]
  if (budget.callsUsed + 1 > budget.maxCalls) {
    return { ok: false, reason: `call cap reached (${budget.maxCalls})` }
  }
  if (budget.unitsUsed + weight > budget.maxUnits) {
    return { ok: false, reason: `unit cap reached (${budget.unitsUsed}+${weight} > ${budget.maxUnits})` }
  }
  budget.unitsUsed += weight
  budget.callsUsed += 1
  return { ok: true }
}

// ── Edge schemas ─────────────────────────────────────────────────────────────

export interface Scope {
  projectId: string
  fileId: string
  targetLang: string
  orderedCellIds: string[]
  untranslatedCellIds: string[]
  fileKind: string
}

export type SpanSeedSource = "canonical-ref" | "paragraph" | "chunk"

export interface SpanSeed {
  id: string
  fileId: string
  anchorCellId: string
  startCellId: string
  endCellId: string
  seedSource: SpanSeedSource
}

export interface Window {
  spanId: string
  cellIds: string[]
  precedingBriefIds: string[]
  layerAboveRefs: string[]
}

export interface Construal {
  spanId: string
  situation: string
  participants: string[]
  tenor: string
  moves: string[]
  closed: boolean
  openQuestions: string[]
  evidenceCellIds: string[]
}

/** A registered ambiguity: a question the scene leaves open ON PURPOSE. Drafts
 *  must not resolve it (verify_ambiguity holds a veto on violations). */
export interface AmbiguityEntry {
  id: string
  question: string
}

export interface SceneBriefDraft {
  spanId: string
  startCellId: string
  endCellId: string
  /** L2: deterministic markdown render of the construal. */
  l2Construal: string
  /** L1: model-compressed, ≤ L1_MAX_CHARS (stated budget + hard truncation). */
  l1Summary: string
  ambiguityRegister: AmbiguityEntry[]
  provenance: {
    closureRounds: number
    closureExit: ClosureExit
    windowCellIds: string[]
  }
}

export interface SpanDraft {
  spanId: string
  sceneBriefId: string
  cells: { cellId: string; text: string }[]
  exampleIds: string[]
  promptVersion: string
}

export interface LintFlag {
  spanId: string
  cellId: string
  ruleId: string
  message: string
}

export type VerifierKey = "force" | "ambiguity" | "naturalness"

export interface Risk {
  spanId: string
  level: "low" | "high"
  reasons: string[]
  sourceFindingIds: string[]
  /** Which verifiers to run — branched in code, per the router's level. */
  verifiers: VerifierKey[]
}

export interface CellVerdict {
  cellId: string
  approve: boolean
  reason?: string
}

export interface Vote {
  spanId: string
  verifier: VerifierKey
  approve: boolean
  cellVerdicts: CellVerdict[]
  reason: string
}

export interface StagedOutcome {
  proposalId: string
  spanId: string
  stagedCellIds: string[]
  verdicts: Record<string, string>
}

export interface SkippedCell {
  cellId: string
  reason: string
}

export type ClosureExit = "model-closed" | "fixpoint" | "window-exhausted" | "max-iterations" | "budget"

export interface SpanReport {
  spanId: string
  fileId: string
  cellsStaged: string[]
  cellsSkipped: SkippedCell[]
  ambiguities: number
  /** True when work was dropped (closure/verification/budget). Never silent:
   *  incompleteReasons + cellsSkipped name everything that was dropped. */
  incomplete: boolean
  incompleteReasons: string[]
  notes: string[]
  unitsUsed: number
  callsUsed: number
}
