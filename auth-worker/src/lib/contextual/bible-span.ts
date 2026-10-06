// bible-span — what one span gets from Bible data (AQU-1690).
//
// The tick builds this from the wave's BibleRunData (./bible-run.ts) and
// hands it to runSpan. Everything here is data or an injected function, so
// the pipeline stays pure composition and its tests script every edge.

import type { CellPair } from "../agent/tools/select-cells"
import type { CellFacts } from "../../../../db/shared/bible-facts/types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import { bibleConstraint, isRepairable, type BibleGate } from "./bible-gates"
import type { BibleRun, BibleRunData } from "./bible-run"
import {
  activeFailures,
  BIBLE_QA_CODES,
  judgeExpectations,
  judgmentConstraint,
  type BibleQaDecide,
  type BibleQaTrace,
  type JudgeResult,
} from "./judge-expectations"
import type { LintFlag, SpanDraft } from "./types"

export interface SpanBible {
  /** Short facts per cell id, for scene construal (who speaks to whom, who is named). */
  construeFacts: ReadonlyMap<string, string>
  /** Full facts per cell id, for the drafter and the verifiers. */
  draftFacts: ReadonlyMap<string, string>
  /** Present when the checks enrichment is on too: the bkp: gates' repairs and the Jev questions. */
  checks?: {
    facts: ReadonlyMap<string, CellFacts>
    profile: LanguageProfile
    /** judgeExpectations on a drafted span: code first, Jev only where code cannot decide. */
    judge: (draft: SpanDraft) => Promise<JudgeResult>
  }
}

/** The run driver's Jev side: purpose bible-qa, traced and metered, with a cache that lasts the run. */
export interface BibleJudgeDeps {
  decide: BibleQaDecide
  cache: Map<string, number>
  record?: (trace: BibleQaTrace) => void
}

/** The span's view of the wave's Bible data. */
export function spanBible(
  data: BibleRunData,
  input: { pairs: readonly CellPair[]; spanId: string; judge?: BibleJudgeDeps },
): SpanBible {
  const base = { construeFacts: data.construeLines, draftFacts: data.draftLines }
  if (!data.checks) return base
  const pairById = new Map(input.pairs.map((p) => [p.cellId, p]))
  const judgeDeps = input.judge
  return {
    ...base,
    checks: {
      facts: data.facts,
      profile: data.profile,
      judge: async (draft) => {
        // Without a Jev side (tests, or no driver), code still decides what it can.
        const decide: BibleQaDecide = judgeDeps?.decide ?? (async (q) => ({ answers: q.fallback(), decidedBy: "heuristic", reason: "disabled", model: null, usage: null }))
        return judgeExpectations(
          draft.cells.map((cell) => ({
            cellId: cell.cellId,
            ref: pairById.get(cell.cellId)?.canonicalRef ?? null,
            source: pairById.get(cell.cellId)?.source ?? "",
            text: cell.text,
            ...(data.facts.get(cell.cellId) ? { facts: data.facts.get(cell.cellId) } : {}),
            ...(data.expectations.get(cell.cellId) ? { expectation: data.expectations.get(cell.cellId) } : {}),
            ...(data.draftLines.get(cell.cellId) ? { factsLine: data.draftLines.get(cell.cellId) } : {}),
          })),
          {
            profile: data.profile,
            packVersion: data.packVersion,
            decide,
            cache: judgeDeps?.cache ?? new Map(),
            ...(judgeDeps?.record ? { record: judgeDeps.record } : {}),
          },
          input.spanId,
        )
      },
    },
  }
}

/** The `bkp:` gate, when the wave has Bible data AND the checks enrichment is on. */
export function bibleGateOf(bible: BibleRun): BibleGate | null {
  if (bible.state !== "ready" || !bible.data.checks) return null
  return { expectations: bible.data.expectations, profile: bible.data.profile }
}

/** One attempt's Bible data verdict on a drafted span. */
export interface SpanBibleCheck {
  judged?: JudgeResult
  /** Per cell: codes for ACTIVE Jev questions answered "no". */
  activeCodes: Map<string, `bkp:${string}`[]>
  /** Per cell: templated constraints to repair — warning findings and active Jev failures. Shadow answers never add one. */
  constraints: Map<string, string[]>
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? []
  if (!list.includes(value)) list.push(value)
  map.set(key, list)
}

/** Run the Jev questions on a drafted span and turn failures into constraints. Empty without checks. */
export async function checkSpanBible(
  bible: SpanBible | undefined,
  draft: SpanDraft,
  flags: readonly LintFlag[],
): Promise<SpanBibleCheck> {
  const out: SpanBibleCheck = { activeCodes: new Map(), constraints: new Map() }
  const checks = bible?.checks
  if (!checks) return out
  for (const flag of flags) {
    if (flag.bible && isRepairable(flag.bible)) {
      push(out.constraints, flag.cellId, bibleConstraint(flag.bible, checks.facts.get(flag.cellId), checks.profile))
    }
  }
  out.judged = await checks.judge(draft)
  for (const judgment of activeFailures(out.judged)) {
    push(out.activeCodes, judgment.cellId, BIBLE_QA_CODES[judgment.check])
    push(out.constraints, judgment.cellId, judgmentConstraint(judgment, checks.facts.get(judgment.cellId)))
  }
  return out
}
