// span-metrics — what one span cost and what Bible data did in it (AQU-1690;
// design doc §9.6 "Measuring it").
//
// Two code-only rows per span go into contextual_run_traces (tier "code"):
//   bible-facts   the facts lines the span's prompts carried (when Bible data
//                 was on), so the activity inspector can show what a span used;
//   span-metrics  units, calls, construe rounds, the decisionRequired category,
//                 bkp: findings (on drafts and left at staging), Jev calls with
//                 each answer's certainty, cells repaired — for every span,
//                 with Bible data or without, so a project can be compared
//                 before and after (scripts/autopilot-bible-metrics.ts).
// Traces are the project's own working data, kept 30 days.

import type { CellPair } from "../agent/tools/select-cells"
import type { BibleRun } from "./bible-run"
import type { TraceInput } from "./traces"
import type { SpanReport } from "./types"

export const BIBLE_FACTS_TRACE_LABEL = "bible-facts"
export const SPAN_METRICS_TRACE_LABEL = "span-metrics"

function codeRow(spanId: string, label: string, model: string, user: string, output: string | null): TraceInput {
  return {
    label,
    tier: "code",
    model,
    spanId,
    system: "",
    user,
    output,
    error: null,
    promptTokens: 0,
    completionTokens: 0,
    costCents: 0,
    latencyMs: 0,
    ok: true,
    attempts: 1,
  }
}

/** The facts lines the span's cells carried, one "ref: facts" line each; null without Bible data. */
export function bibleFactsTraceRow(spanId: string, pairs: readonly CellPair[], bible: BibleRun): TraceInput | null {
  if (bible.state !== "ready") return null
  const lines = pairs.flatMap((pair) => {
    const facts = bible.data.draftLines.get(pair.cellId)
    return facts ? [`${pair.canonicalRef ?? pair.cellId}: ${facts}`] : []
  })
  if (lines.length === 0) return null
  return codeRow(spanId, BIBLE_FACTS_TRACE_LABEL, `bkp@${bible.data.packVersion}`, lines.join("\n"), null)
}

/**
 * Which kind of question parked the span. "speaker": the model's open
 * questions ask who speaks or to whom — the question Bible facts exist to
 * answer. "unspecified": the generic fallback with no model question. A
 * metrics bucket, not a judgment the run acts on.
 */
export function decisionCategory(reason: string | undefined): "speaker" | "unspecified" | "other" | null {
  if (!reason) return null
  const colon = reason.indexOf(": ")
  if (colon === -1) return "unspecified"
  return /\b(speak|speaks|speaking|speaker|said|says|saying|talking|addressee|addressed|addressing)\b/i.test(reason.slice(colon + 2))
    ? "speaker"
    : "other"
}

export interface SpanMetrics {
  spanId: string
  bibleData: string
  units: number
  calls: number
  construeRounds: number | null
  closureExit: string | null
  decisionRequired: "speaker" | "unspecified" | "other" | null
  /** bkp: findings per code over every draft of the span. */
  bkpFindings: Record<string, number>
  /** bkp: codes per code on the cells staged (after repair). */
  bkpResidual: Record<string, number>
  jevCalls: number
  judgments: { check: string; outcome: string; mode: string; decidedBy: string; certainty?: number }[]
  repaired: number
  staged: number
  skipped: number
}

function bibleDataState(bible: BibleRun): string {
  if (bible.state === "off") return "off"
  if (bible.state === "unavailable") return `unavailable:${bible.reason}`
  return bible.data.checks ? "facts+checks" : "facts"
}

export function spanMetrics(
  spanId: string,
  report: SpanReport | undefined,
  bible: BibleRun,
  residual: Readonly<Record<string, number>>,
): SpanMetrics {
  return {
    spanId,
    bibleData: bibleDataState(bible),
    units: report?.unitsUsed ?? 0,
    calls: report?.callsUsed ?? 0,
    construeRounds: report?.closure?.rounds ?? null,
    closureExit: report?.closure?.exit ?? null,
    decisionRequired: decisionCategory(report?.decisionRequired?.reason),
    bkpFindings: report?.bible?.findings ?? {},
    bkpResidual: { ...residual },
    jevCalls: report?.bible?.jevCalls ?? 0,
    judgments: (report?.bible?.judgments ?? []).map(({ check, outcome, mode, decidedBy, certainty }) => ({
      check,
      outcome,
      mode,
      decidedBy,
      ...(certainty !== undefined ? { certainty } : {}),
    })),
    repaired: report?.bible?.repaired ?? 0,
    staged: report?.cellsStaged.length ?? 0,
    skipped: report?.cellsSkipped.length ?? 0,
  }
}

export function spanMetricsTraceRow(metrics: SpanMetrics): TraceInput {
  return codeRow(metrics.spanId, SPAN_METRICS_TRACE_LABEL, "metrics", "", JSON.stringify(metrics))
}
