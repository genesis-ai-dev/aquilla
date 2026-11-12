// Before/after Bible data in autopilot, from its per-span metrics (AQU-1690).
//
// Autopilot writes one `span-metrics` trace row per span
// (auth-worker/src/lib/contextual/span-metrics.ts). This groups them by the
// span's Bible data state and reports the measures in the design doc §9.6:
// units and construe rounds per span, how often a span parks on a question
// (and how often that question is "who is speaking?"), bkp: findings per 100
// staged cells before and after repair, and Jev calls with their answers.
// Pure: scripts/autopilot-bible-metrics.ts reads the rows.

/** One span's metrics, as the trace row's JSON carries it. Mirrors SpanMetrics in span-metrics.ts. */
export interface SpanMetricsRow {
  spanId: string
  bibleData: string
  units: number
  calls: number
  construeRounds: number | null
  closureExit: string | null
  decisionRequired: "speaker" | "unspecified" | "other" | null
  bkpFindings: Record<string, number>
  bkpResidual: Record<string, number>
  jevCalls: number
  judgments: { check: string; outcome: string; mode: string; decidedBy: string; certainty?: number }[]
  repaired: number
  staged: number
  skipped: number
}

export interface GroupSummary {
  bibleData: string
  spans: number
  meanUnits: number
  meanCalls: number
  meanConstrueRounds: number | null
  /** Share of spans that parked on a question, and of those, the share about the speaker. */
  decisionRate: number
  speakerDecisionShare: number | null
  stagedCells: number
  /** bkp: findings per 100 staged cells, on drafts and left at staging. */
  bkpPer100Drafted: number | null
  bkpPer100Staged: number | null
  repairedCells: number
  jevCallsPerSpan: number
  /** Per check and outcome: how many answers, and their mean certainty. */
  judgments: Record<string, { count: number; meanCertainty: number | null }>
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length === 0 ? null : sum(values) / values.length)
const round = (value: number | null, digits = 2) => (value === null ? null : Number(value.toFixed(digits)))
const total = (record: Record<string, number>) => sum(Object.values(record))

export function parseSpanMetricsRow(output: string | null): SpanMetricsRow | null {
  if (!output) return null
  try {
    const value = JSON.parse(output) as Partial<SpanMetricsRow>
    if (typeof value.spanId !== "string" || typeof value.bibleData !== "string") return null
    return {
      spanId: value.spanId,
      bibleData: value.bibleData,
      units: Number(value.units ?? 0),
      calls: Number(value.calls ?? 0),
      construeRounds: typeof value.construeRounds === "number" ? value.construeRounds : null,
      closureExit: typeof value.closureExit === "string" ? value.closureExit : null,
      decisionRequired: value.decisionRequired ?? null,
      bkpFindings: value.bkpFindings ?? {},
      bkpResidual: value.bkpResidual ?? {},
      jevCalls: Number(value.jevCalls ?? 0),
      judgments: Array.isArray(value.judgments) ? value.judgments : [],
      repaired: Number(value.repaired ?? 0),
      staged: Number(value.staged ?? 0),
      skipped: Number(value.skipped ?? 0),
    }
  } catch {
    return null
  }
}

export function summarizeSpanMetrics(rows: readonly SpanMetricsRow[]): GroupSummary[] {
  const groups = new Map<string, SpanMetricsRow[]>()
  for (const row of rows) groups.set(row.bibleData, [...(groups.get(row.bibleData) ?? []), row])
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bibleData, spans]) => {
      const decided = spans.filter((s) => s.decisionRequired !== null)
      const staged = sum(spans.map((s) => s.staged))
      const judgments: GroupSummary["judgments"] = {}
      const certainties: Record<string, number[]> = {}
      for (const j of spans.flatMap((s) => s.judgments)) {
        const key = `${j.check}:${j.outcome}`
        judgments[key] = { count: (judgments[key]?.count ?? 0) + 1, meanCertainty: null }
        if (j.certainty !== undefined) certainties[key] = [...(certainties[key] ?? []), j.certainty]
      }
      for (const key of Object.keys(judgments)) judgments[key].meanCertainty = round(mean(certainties[key] ?? []))
      return {
        bibleData,
        spans: spans.length,
        meanUnits: round(mean(spans.map((s) => s.units))) ?? 0,
        meanCalls: round(mean(spans.map((s) => s.calls))) ?? 0,
        meanConstrueRounds: round(mean(spans.flatMap((s) => (s.construeRounds === null ? [] : [s.construeRounds])))),
        decisionRate: round(decided.length / spans.length) ?? 0,
        speakerDecisionShare: decided.length === 0 ? null : round(decided.filter((s) => s.decisionRequired === "speaker").length / decided.length),
        stagedCells: staged,
        bkpPer100Drafted: staged === 0 ? null : round((sum(spans.map((s) => total(s.bkpFindings))) / staged) * 100),
        bkpPer100Staged: staged === 0 ? null : round((sum(spans.map((s) => total(s.bkpResidual))) / staged) * 100),
        repairedCells: sum(spans.map((s) => s.repaired)),
        jevCallsPerSpan: round(sum(spans.map((s) => s.jevCalls)) / spans.length) ?? 0,
        judgments,
      }
    })
}
