// pipeline — one graph instance: run ONE SPAN end to end (construe loop →
// summarize → persist → draft → lint → route → verifiers → quorum → one
// redraft → stage → report).
//
// This function is PURE composition: every side effect (persisting the brief,
// linting, staging, neighbor-brief reads) arrives as an injected callback,
// and the model is behind LlmCall — so the whole graph unit-tests with a
// scripted mock and serializable values on every edge. The Workflows runtime
// (slice D) wraps each phase in step.do(); nothing here knows about it.
//
// Budget is threaded through every model call. On exhaustion the report marks
// the span incomplete and NAMES the dropped work — no silent truncation.

import { statusOf, type CellPair } from "../agent/tools/select-cells"
import { construeScene, type ClosureContext, type ClosureResult } from "./closure"
import { performSpan, type ExamplePair, type PerformSpanResult } from "./draft"
import { classifyRisk } from "./router"
import { summarizeConstrual, renderConstrualL2 } from "./summarize"
import { tallyVotes } from "./quorum"
import { verifySpan } from "./verify"
import type { LintRule } from "../agent/lint"
import {
  createRunBudget,
  type Construal,
  type LintFlag,
  type LlmCall,
  type RunBudget,
  type SceneBriefDraft,
  type Scope,
  type SkippedCell,
  type SpanDraft,
  type SpanPhase,
  type SpanReport,
  type SpanSeed,
  type StagedOutcome,
  type VerifierKey,
  type Vote,
} from "./types"

/** Retrieval target for few-shot examples (draft tool's EXAMPLES_N). */
export const EXAMPLES_TARGET = 8
const PRECEDING_CONTEXT = 3
/** Barrier at quorum: minimum successful verifier votes with the full panel. */
const MIN_PANEL_SUCCESS = 2

export interface RunSpanDeps {
  seed: SpanSeed
  scope: Scope
  /** The whole file's pairs in display order. */
  pairs: CellPair[]
  /** Closure context beyond the raw pairs. */
  neighborBriefs: ClosureContext["neighborBriefs"]
  layerAbove: ClosureContext["layerAbove"]
  examples: ExamplePair[]
  projectBriefL1?: string
  steeringDirections?: string[]
  rules?: LintRule[]
  sourceLanguage?: string
  targetLanguage?: string
  priorConstrual?: Construal
  llm: LlmCall
  budget?: RunBudget
  // ── Injected side effects ──
  /** Upsert the scene brief row (proposed); returns the sceneBriefId. */
  persistBrief: (brief: SceneBriefDraft) => Promise<string>
  /** Deterministic project-rule lint over the drafted cells (wraps lintDraft). */
  lint: (draft: SpanDraft) => Promise<LintFlag[]>
  /** Stage accepted commits through the emit-stage perimeter. */
  stage: (draft: SpanDraft) => Promise<StagedOutcome>
  /** Live progress only (fire-and-forget). Never awaited, never a control
   *  signal — a throwing reporter must not fail the span. */
  onPhase?: (phase: SpanPhase) => void
}

function spanPairs(seed: SpanSeed, pairs: CellPair[]): CellPair[] {
  const start = pairs.findIndex((p) => p.cellId === seed.startCellId)
  const end = pairs.findIndex((p) => p.cellId === seed.endCellId)
  if (start === -1 || end === -1 || end < start) return []
  return pairs.slice(start, end + 1)
}

function precedingValidated(seed: SpanSeed, pairs: CellPair[]): CellPair[] {
  const start = pairs.findIndex((p) => p.cellId === seed.startCellId)
  const out: CellPair[] = []
  for (let i = start - 1; i >= 0 && out.length < PRECEDING_CONTEXT; i--) {
    if (pairs[i].validated && pairs[i].target.trim()) out.unshift(pairs[i])
  }
  return out
}

interface VerifyPhaseResult {
  votes: Vote[]
  failed: { verifier: VerifierKey; error: string }[]
  /** Barrier verdict: mandatory ambiguity vote present + min_success met. */
  barrierMet: boolean
}

/**
 * Run the verifier set with the barrier's retry-once-on-failure policy.
 *
 * The stances are `independent: true` in the graph spec — they share no state
 * and never read each other's votes — so they dispatch CONCURRENTLY. On a
 * three-stance panel that turns three serial deep/mid round-trips into one,
 * which is the single largest latency term in a high-risk span.
 *
 * Budget stays exact under concurrency without extra machinery: `chargeBudget`
 * is synchronous (no await between reading and writing the counters), so on
 * JS's single thread each charge is atomic and the cap cannot be overshot.
 * Charges land in dispatch order, exactly as they did serially.
 */
async function runVerifiers(
  verifiers: VerifierKey[],
  deps: RunSpanDeps,
  brief: { spanId: string; l1Summary: string; ambiguityRegister: SceneBriefDraft["ambiguityRegister"] },
  draft: SpanDraft,
  pairs: CellPair[],
  budget: RunBudget,
): Promise<VerifyPhaseResult> {
  const settled = await Promise.all(
    verifiers.map(async (key) => {
      const args = { sceneBrief: brief, draft, pairs, llm: deps.llm, budget }
      let result = await verifySpan(key, args)
      // Barrier on_partial: retry, retries: 1.
      if (!result.ok) result = await verifySpan(key, args)
      return { key, result }
    }),
  )

  const votes: Vote[] = []
  const failed: { verifier: VerifierKey; error: string }[] = []
  for (const { key, result } of settled) {
    if (result.ok) votes.push(result.vote)
    else failed.push({ verifier: key, error: result.error })
  }
  const hasAmbiguity = votes.some((v) => v.verifier === "ambiguity")
  const minSuccess = verifiers.length >= 3 ? MIN_PANEL_SUCCESS : 1
  return { votes, failed, barrierMet: hasAmbiguity && votes.length >= minSuccess }
}

export async function runSpan(deps: RunSpanDeps): Promise<SpanReport> {
  const budget = deps.budget ?? createRunBudget()
  const skipped: SkippedCell[] = []
  const notes: string[] = []
  const incompleteReasons: string[] = []
  /** Progress is decoration: a broken reporter must never fail a span. */
  const phase = (p: SpanPhase): void => {
    try {
      deps.onPhase?.(p)
    } catch {
      /* ignore */
    }
  }

  const report = (cellsStaged: string[], ambiguities: number): SpanReport => ({
    spanId: deps.seed.id,
    fileId: deps.scope.fileId,
    cellsStaged,
    cellsSkipped: skipped,
    ambiguities,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
    notes,
    unitsUsed: budget.unitsUsed,
    callsUsed: budget.callsUsed,
  })

  const inSpan = spanPairs(deps.seed, deps.pairs)
  const work = inSpan.filter((p) => statusOf(p) === "untranslated")
  if (work.length === 0) {
    notes.push("no untranslated cells in span")
    return report([], 0)
  }

  // ── scene_closure loop (construe ⇄ expand_window, register at exit) ──
  phase("reading")
  const context: ClosureContext = {
    orderedPairs: deps.pairs,
    neighborBriefs: deps.neighborBriefs,
    layerAbove: deps.layerAbove,
  }
  const closure: ClosureResult = await construeScene({
    seed: deps.seed,
    llm: deps.llm,
    budget,
    context,
    ...(deps.priorConstrual ? { priorConstrual: deps.priorConstrual } : {}),
    ...(deps.steeringDirections ? { steeringDirections: deps.steeringDirections } : {}),
  })
  if (!closure.closed) {
    // Budget/iteration exhaustion — the OTHER exit. Drafting from an
    // unconverged construal would ship confident nonsense; every cell is
    // named as dropped instead.
    incompleteReasons.push(`scene construal did not close (exit: ${closure.exit}, ${closure.rounds} rounds)`)
    for (const p of work) skipped.push({ cellId: p.cellId, reason: `construal incomplete (${closure.exit})` })
    return report([], 0)
  }

  // ── summarize → persist ──
  const summary = await summarizeConstrual({ construal: closure.construal, llm: deps.llm, budget })
  if (summary.fallback) notes.push("L1 summary fell back to truncated L2 (summarize unavailable)")
  const briefDraft: SceneBriefDraft = {
    spanId: deps.seed.id,
    startCellId: deps.seed.startCellId,
    endCellId: deps.seed.endCellId,
    l2Construal: renderConstrualL2(closure.construal),
    l1Summary: summary.l1Summary,
    ambiguityRegister: closure.register,
    provenance: {
      closureRounds: closure.rounds,
      closureExit: closure.exit,
      windowCellIds: closure.window.cellIds,
    },
  }
  const sceneBriefId = await deps.persistBrief(briefDraft)
  const brief = {
    id: sceneBriefId,
    spanId: deps.seed.id,
    l1Summary: briefDraft.l1Summary,
    ambiguityRegister: briefDraft.ambiguityRegister,
  }

  // ── draft → lint → route → verify → quorum, then ONE redraft pass ──
  const exampleCoverage = Math.min(
    deps.examples.filter((e) => e.validated).length / EXAMPLES_TARGET,
    1,
  )
  const accepted: { cellId: string; text: string }[] = []
  const ambiguityCount = briefDraft.ambiguityRegister.length
  let attemptPairs = work
  let carriedConstraints: { cellId: string; constraints: string[] }[] = []
  let stagePromptVersion = ""

  for (let attempt = 1; attempt <= 2; attempt++) {
    phase("drafting")
    const drafted: PerformSpanResult = await performSpan({
      sceneBrief: brief,
      pairs: attemptPairs,
      examples: deps.examples,
      precedingValidated: precedingValidated(deps.seed, deps.pairs),
      ...(deps.steeringDirections ? { steeringDirections: deps.steeringDirections } : {}),
      ...(deps.projectBriefL1 ? { projectBriefL1: deps.projectBriefL1 } : {}),
      ...(deps.rules ? { rules: deps.rules } : {}),
      ...(carriedConstraints.length > 0 ? { constraints: carriedConstraints } : {}),
      ...(deps.sourceLanguage ? { sourceLanguage: deps.sourceLanguage } : {}),
      ...(deps.targetLanguage ? { targetLanguage: deps.targetLanguage } : {}),
      llm: deps.llm,
      budget,
    })
    if (!drafted.ok) {
      incompleteReasons.push(`draft attempt ${attempt} failed: ${drafted.error}`)
      for (const p of attemptPairs) skipped.push({ cellId: p.cellId, reason: `draft failed (${drafted.error})` })
      break
    }
    stagePromptVersion = drafted.draft.promptVersion
    for (const cellId of drafted.missedCellIds) {
      skipped.push({ cellId, reason: `no draft returned (attempt ${attempt})` })
    }
    if (drafted.draft.cells.length === 0) break

    phase("checking")
    const flags = await deps.lint(drafted.draft)
    const risk = classifyRisk(drafted.draft, flags, brief.ambiguityRegister, exampleCoverage, {
      rounds: closure.rounds,
      exit: closure.exit,
    })
    const verified = await runVerifiers(risk.verifiers, deps, brief, drafted.draft, attemptPairs, budget)
    for (const f of verified.failed) {
      notes.push(`verifier ${f.verifier} failed after retry: ${f.error}`)
    }
    if (!verified.barrierMet) {
      // Mandatory verify_ambiguity (or min_success) unmet: the run cannot
      // claim its distinctive guarantee for these cells — skip, never stage.
      incompleteReasons.push(
        `verifier barrier unmet on attempt ${attempt} (votes: ${verified.votes.length}/${risk.verifiers.length}, ambiguity ${verified.votes.some((v) => v.verifier === "ambiguity") ? "present" : "MISSING"})`,
      )
      for (const c of drafted.draft.cells) {
        skipped.push({ cellId: c.cellId, reason: "verification unavailable (barrier unmet)" })
      }
      break
    }

    const tally = tallyVotes(verified.votes, drafted.draft)
    const textById = new Map(drafted.draft.cells.map((c) => [c.cellId, c.text]))
    for (const cellId of tally.accepted) {
      accepted.push({ cellId, text: textById.get(cellId) ?? "" })
    }

    if (tally.rejected.length === 0 || attempt === 2) {
      // Second rejection ships as skipped-with-reason — never a worse draft
      // shipped to look complete.
      for (const r of tally.rejected) {
        skipped.push({ cellId: r.cellId, reason: `rejected by quorum twice: ${r.constraints.join("; ")}` })
      }
      break
    }
    const rejectedIds = new Set(tally.rejected.map((r) => r.cellId))
    attemptPairs = attemptPairs.filter((p) => rejectedIds.has(p.cellId))
    carriedConstraints = tally.rejected
    notes.push(`redrafting ${tally.rejected.length} rejected cell(s) with verifier constraints`)
  }

  // ── stage → report ──
  let stagedCellIds: string[] = []
  if (accepted.length > 0) {
    phase("staging")
    const staged = await deps.stage({
      spanId: deps.seed.id,
      sceneBriefId,
      cells: accepted,
      exampleIds: Array.from(new Set(deps.examples.flatMap((e) => (e.cellId ? [e.cellId] : [])))),
      promptVersion: stagePromptVersion,
    })
    stagedCellIds = staged.stagedCellIds
  }
  return report(stagedCellIds, ambiguityCount)
}
