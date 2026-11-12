// bible-check-mode — "Check with Bible data" over TRANSLATED cells (AQU-1690;
// design doc §9.4 "Check mode").
//
// Autopilot drafts only untranslated cells, so nothing re-checks text that
// already exists. Check mode does: for each translated cell of a file it runs
// the bkp: expectations in code, then the Jev questions (shadow or active, as
// for drafts), and reports findings. It NEVER writes text — no draft, no
// commit. The caller (routes/contextual-bible-check.ts) also raises the
// Language-profile fact questions the file needs: those are the decision
// cards.
//
// The smallest correct version, deliberately outside the contextual run
// framework: runs are built around drafting (cursor of spans → runSpan →
// staged drafts), and a check needs none of that. It is a bounded,
// synchronous pass over at most MAX_CHECK_CELLS cells per call, continued
// with `startAfter`.
//
// AQU-1701: it also asks the Translation Questions (C1) whose verses are all
// translated — an automated community check. A TQ belongs to the call that
// checks its first verse, so one that spans two calls is asked once.

import { statusOf, type CellPair } from "../agent/tools/select-cells"
import { bibleReasonParams } from "../../../../db/shared/bible-checks/params"
import { bibleFindings } from "./bible-gates"
import type { BibleRunData } from "./bible-run"
import type { BibleJudgeDeps } from "./bible-span"
import { judgeComprehension } from "./judge-comprehension"
import { activeFailures, BIBLE_QA_CODES, judgeExpectations, type Judgment } from "./judge-expectations"

/** Cells one call checks. About ten Jev calls at most, plus one per chapter for C1, so the request stays short. */
export const MAX_CHECK_CELLS = 120
/** Cells per Jev call: one batched decide() each, like one span. */
export const CHECK_CELLS_PER_JEV_CALL = 12

export interface CheckModeFinding {
  code: `bkp:${string}`
  /** The finding's reason and evidence (code findings, and C1's question and answer), as the review chips read them. */
  params?: Record<string, string>
}

export interface CheckModeCell {
  cellId: string
  ref: string | null
  findings: CheckModeFinding[]
}

export interface CheckModeResult {
  packVersion: string
  /** Translated cells checked in this call. */
  checked: number
  /** Only the cells with findings. */
  cells: CheckModeCell[]
  /** Every judgment, shadow ones included — the route is maintainer-only. AQU-1701: C1's carry their `tq` and `refs`. */
  judgments: Judgment[]
  jevCalls: number
  /** The last cell checked, when more remain: pass it as `startAfter` to continue. */
  nextAfter: string | null
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function checkTranslatedCells(input: {
  pairs: readonly CellPair[]
  data: BibleRunData
  judge?: BibleJudgeDeps
  startAfter?: string
  maxCells?: number
}): Promise<CheckModeResult> {
  const { data } = input
  const gate = { expectations: data.expectations, profile: data.profile }
  const translated = input.pairs.filter((p) => statusOf(p) !== "untranslated" && data.expectations.has(p.cellId))
  const from = input.startAfter ? translated.findIndex((p) => p.cellId === input.startAfter) + 1 : 0
  const max = input.maxCells ?? MAX_CHECK_CELLS
  const batch = translated.slice(from, from + max)
  const more = from + max < translated.length

  const findings = new Map<string, CheckModeFinding[]>()
  for (const pair of batch) {
    const code = bibleFindings(gate, pair.cellId, pair.target).map((f) => ({ code: f.code, params: bibleReasonParams(f) }))
    if (code.length > 0) findings.set(pair.cellId, code)
  }

  const judgments: Judgment[] = []
  let jevCalls = 0
  if (data.checks) {
    const decide: BibleJudgeDeps["decide"] =
      input.judge?.decide ?? (async (q) => ({ answers: q.fallback(), decidedBy: "heuristic", reason: "disabled", model: null, usage: null }))
    const cache = input.judge?.cache ?? new Map<string, number>()
    for (const [index, group] of chunks(batch, CHECK_CELLS_PER_JEV_CALL).entries()) {
      const result = await judgeExpectations(
        group.map((p) => ({
          cellId: p.cellId,
          ref: p.canonicalRef,
          source: p.source,
          text: p.target,
          ...(data.facts.get(p.cellId) ? { facts: data.facts.get(p.cellId) } : {}),
          ...(data.expectations.get(p.cellId) ? { expectation: data.expectations.get(p.cellId) } : {}),
          ...(data.draftLines.get(p.cellId) ? { factsLine: data.draftLines.get(p.cellId) } : {}),
        })),
        {
          profile: data.profile,
          packVersion: data.packVersion,
          decide,
          cache,
          ...(input.judge?.record ? { record: input.judge.record } : {}),
          ...(input.judge?.modes ? { modes: input.judge.modes } : {}),
        },
        `check:${index}`,
      )
      jevCalls += result.jevCalls
      judgments.push(...result.judgments)
      for (const failure of activeFailures(result)) {
        const list = findings.get(failure.cellId) ?? []
        list.push({ code: BIBLE_QA_CODES[failure.check] })
        findings.set(failure.cellId, list)
      }
    }

    // C1 over the whole file's translated text, for the questions whose first verse this call checks.
    const comprehension = await judgeComprehension(
      {
        questions: data.questions,
        cells: translated.flatMap((p) => {
          const refs = data.expectations.get(p.cellId)?.refs
          return refs ? [{ cellId: p.cellId, refs, text: p.target }] : []
        }),
        checked: new Set(batch.map((p) => p.cellId)),
        owner: "first-verse",
        traceSpanId: "check:tq",
      },
      {
        packVersion: data.packVersion,
        decide,
        cache,
        ...(input.judge?.record ? { record: input.judge.record } : {}),
        ...(input.judge?.modes?.tq ? { mode: input.judge.modes.tq } : {}),
      },
    )
    jevCalls += comprehension.jevCalls
    judgments.push(...comprehension.judgments)
    for (const finding of comprehension.findings) {
      const list = findings.get(finding.cellId) ?? []
      list.push({ code: finding.code, params: finding.params })
      findings.set(finding.cellId, list)
    }
  }

  return {
    packVersion: data.packVersion,
    checked: batch.length,
    cells: batch.flatMap((p) => {
      const list = findings.get(p.cellId)
      return list ? [{ cellId: p.cellId, ref: p.canonicalRef, findings: list }] : []
    }),
    judgments,
    jevCalls,
    nextAfter: more && batch.length > 0 ? batch[batch.length - 1].cellId : null,
  }
}
