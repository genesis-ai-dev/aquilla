// bible-deps — the Bible data side effects one autopilot run uses (AQU-1690).
//
// Built ONCE per run by the run driver (routes/contextual.ts selfTickLoop),
// so anything that should last a run (the Jev answer cache, the run's Jev
// time budget, the fact questions already raised) lives in this closure and
// spans every wave.
//
// `db` is the run loop's own connection. The request's env.AQUILLA_PG may be
// closed by the time a background wave runs, and the flag reader fails
// closed — Bible data would switch off without a word.
//
// Every Jev call is traced (contextual_run_traces, label "jev:bible-qa", tier
// "jev": the request, the answers, and each judgment with its certainty and
// mode) and metered (agent_cost_meter, when COST_METER=1). The trace is where
// shadow-mode answers can be seen, by maintainers only (the traces route
// hides these rows from other roles).

import type { Env } from "../../types"
import type { AquillaDb } from "../../../../db/shim/postgres"
import { readBibleEnrichmentFlags } from "../aquifer/gate"
import { loadBookPack } from "../bkp/pack-loader"
import { decide } from "../jev/decide"
import { JEV_MODEL } from "../../../../src/lib/completion/seam-request"
import type { CostMeter } from "../cost-meter"
import type { BibleTickDeps } from "./bible-run"
import type { BibleQaTrace } from "./judge-expectations"
import type { TraceInput } from "./traces"

/** Jev time one run may spend on Bible data questions, like REACT_JEV_BUDGET_MS for a react sweep. */
export const BIBLE_QA_RUN_BUDGET_MS = 120_000
export const BIBLE_QA_TRACE_LABEL = "jev:bible-qa"

/** A Jev call as a trace row: what was asked, what came back, and what each answer meant. */
export function bibleQaTraceRow(trace: BibleQaTrace): TraceInput {
  const { result } = trace
  return {
    label: BIBLE_QA_TRACE_LABEL,
    tier: "jev",
    model: result.model ?? JEV_MODEL,
    spanId: trace.spanId,
    system: "Jev decisions, purpose bible-qa (AQU-1690)",
    user: JSON.stringify(trace.request),
    output: JSON.stringify({
      decidedBy: result.decidedBy,
      ...(result.reason ? { reason: result.reason } : {}),
      answers: result.answers,
      judgments: trace.judgments,
    }),
    error: result.decidedBy === "heuristic" ? (result.reason ?? "heuristic") : null,
    promptTokens: result.usage?.input_tokens ?? 0,
    completionTokens: result.usage?.output_tokens ?? 0,
    costCents: 0,
    latencyMs: trace.latencyMs,
    ok: result.decidedBy !== "heuristic",
    attempts: 1,
  }
}

export interface BibleRunRecorders {
  traces?: { add: (row: TraceInput) => void }
  meter?: Pick<CostMeter, "add">
}

export function makeBibleTickDeps(
  env: Env,
  db: AquillaDb,
  run: { projectId: string; runId: string },
  recorders: BibleRunRecorders = {},
): BibleTickDeps {
  const runEnv: Env = { ...env, AQUILLA_PG: db }
  let jevMs = 0
  return {
    flags: async () => {
      // Bible data off already turns every enrichment off.
      const flags = await readBibleEnrichmentFlags(runEnv, run.projectId)
      return { autopilot: flags.autopilot, checks: flags.autopilot && flags.checks }
    },
    loadPack: (book, opts) => loadBookPack(env, book, opts),
    judge: {
      cache: new Map(),
      decide: async (input) => {
        const started = Date.now()
        // Past the run's budget the deadline is already gone, so decide()
        // answers from the fallback (every question abstains) without a call.
        const deadline = started + Math.max(0, BIBLE_QA_RUN_BUDGET_MS - jevMs)
        try {
          return await decide(runEnv, { purpose: "bible-qa", projectId: run.projectId, ...input, deadline })
        } finally {
          jevMs += Date.now() - started
        }
      },
      record: (trace) => {
        const row = bibleQaTraceRow(trace)
        recorders.traces?.add(row)
        recorders.meter?.add({
          surface: "autopilot",
          runId: run.runId,
          projectId: run.projectId,
          kind: "llm",
          label: row.label,
          spanId: row.spanId,
          tier: row.tier,
          model: row.model,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          costCents: row.costCents,
          latencyMs: row.latencyMs,
          ok: row.ok,
        })
      },
    },
  }
}
