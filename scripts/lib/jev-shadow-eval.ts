/**
 * The Jev shadow eval's arithmetic (AQU-1701; design doc §10): a HARD cap on
 * calls, batches that never put a verse beside its own planted twin, and per
 * question the precision and recall at each certainty band, the abstain
 * rate, the calls and the cost. Pure, with no worker imports, so it is
 * typechecked with the scripts and tested with a fake decide()
 * (./jev-shadow-eval.test.ts). The CLI, scripts/jev-shadow-eval.ts, builds
 * the cases and asks Jev.
 *
 * A "no" with enough certainty is a flag. On a planted error a flag is right
 * (a true positive); on published text it is a false positive. Precision is
 * right flags over all flags; recall is right flags over all planted errors,
 * so an abstention on a planted error counts as a miss, as it does in
 * production.
 */

/** Certainty |p − 0.5|·2 thresholds to report. Production abstains below the first. */
export const CERTAINTY_BANDS = [0.4, 0.6, 0.8] as const
/** auth-worker contextual/judge-expectations.ts BIBLE_QA_ABSTAIN_BELOW; the CLI checks the two agree. */
export const ABSTAIN_BELOW = 0.4
/** The design doc's ship gate (§10): precision ≥ 0.90 and recall ≥ 0.80, on enough cases to mean it. */
export const SHIP_GATE = { precision: 0.9, recall: 0.8, minCases: 30 } as const
/** Design doc §9.1: about $0.00003 a call, when the response reports no cost. */
export const ESTIMATED_USD_PER_CALL = 0.00003

export interface EvalCase {
  /** The Jev question: "speaker", "tq", … */
  question: string
  /** correct: published text, so a "yes, it keeps the fact" is right. planted: a planted error, so a "no" is right. */
  kind: "correct" | "planted"
  /** p(yes) means the text keeps the fact; you_number asks "one person?", so a plural case passes on a "no". */
  passWhenYes: boolean
  /** The verse or verses: a batch never holds two cases of one. */
  ref: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** USD the response reported, when it did. */
  costUsd: number | null
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null }

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}

/** The cap on calls: calls are taken before they are made, all of a unit's or none. */
export class CallBudget {
  readonly max: number
  used = 0

  constructor(max: number) {
    this.max = max
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used)
  }

  take(calls: number): boolean {
    if (this.used + calls > this.max) return false
    this.used += calls
    return true
  }
}

/** Batches of at most `size` cases with no verse twice in one: a verse beside its planted twin would give the answer away. */
export function batchCases<C extends EvalCase>(cases: readonly C[], size: number): C[][] {
  const batches: C[][] = []
  for (const c of cases) {
    const open = batches.find((batch) => batch.length < size && !batch.some((other) => other.ref === c.ref))
    if (open) open.push(c)
    else batches.push([c])
  }
  return batches
}

/** One unit of work: its cases, asked in `calls` decide() calls (a batch: 1; a C1 chapter: one per 40 questions). */
export interface EvalUnit<C extends EvalCase> {
  question: string
  cases: C[]
  calls: number
}

/** p(yes) per case, in order; null when the question went unanswered (fallback, capped, upstream error). */
export type AskUnit<C extends EvalCase> = (unit: EvalUnit<C>) => Promise<{ p: (number | null)[]; usage: Usage }>

export interface Answered<C extends EvalCase> {
  case: C
  p: number | null
}

export interface RunResult<C extends EvalCase> {
  answered: Answered<C>[]
  /** Cases never asked: the cap was reached first. */
  notAsked: C[]
  /** Calls made and usage, per question. */
  calls: Record<string, number>
  usage: Record<string, Usage>
  /** Units whose calls failed outright; their cases count as unanswered. */
  errors: number
  capped: boolean
}

/**
 * Run the units, at most `concurrency` at a time, never past the budget: a
 * unit whose calls no longer fit is not started, and neither is any after it.
 */
export async function runUnits<C extends EvalCase>(
  units: readonly EvalUnit<C>[],
  ask: AskUnit<C>,
  budget: CallBudget,
  concurrency = 1,
): Promise<RunResult<C>> {
  const result: RunResult<C> = { answered: [], notAsked: [], calls: {}, usage: {}, errors: 0, capped: false }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < units.length) {
      const unit = units[next++]
      if (result.capped || !budget.take(unit.calls)) {
        result.capped = true
        result.notAsked.push(...unit.cases)
        continue
      }
      result.calls[unit.question] = (result.calls[unit.question] ?? 0) + unit.calls
      try {
        const { p, usage } = await ask(unit)
        result.usage[unit.question] = addUsage(result.usage[unit.question] ?? NO_USAGE, usage)
        unit.cases.forEach((c, i) => result.answered.push({ case: c, p: p[i] ?? null }))
      } catch {
        result.errors += 1
        unit.cases.forEach((c) => result.answered.push({ case: c, p: null }))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return result
}

export function certaintyOf(p: number): number {
  return Math.abs(p - 0.5) * 2
}

/** A "no" with at least `band` certainty: what production treats as a failure at that threshold. */
export function flaggedAt(answer: { p: number | null; case: Pick<EvalCase, "passWhenYes"> }, band: number): boolean {
  if (answer.p === null) return false
  const yes = answer.p >= 0.5
  return certaintyOf(answer.p) >= band && yes !== answer.case.passWhenYes
}

export interface BandScore {
  band: number
  /** False positives: flags on published text. */
  flaggedCorrect: number
  /** True positives: flags on planted errors. */
  flaggedPlanted: number
  precision: number | null
  recall: number | null
}

export interface QuestionScore {
  question: string
  correct: number
  planted: number
  /** Asked, but no answer came back (fallback, upstream error). */
  unanswered: number
  /** Answers below certainty 0.4, or none, over all cases asked. */
  abstainRate: number | null
  bands: BandScore[]
  calls: number
  usage: Usage
  notAsked: number
}

export function scoreQuestion<C extends EvalCase>(question: string, run: RunResult<C>): QuestionScore {
  const answered = run.answered.filter((a) => a.case.question === question)
  const correct = answered.filter((a) => a.case.kind === "correct")
  const planted = answered.filter((a) => a.case.kind === "planted")
  const abstained = answered.filter((a) => a.p === null || certaintyOf(a.p) < ABSTAIN_BELOW).length
  return {
    question,
    correct: correct.length,
    planted: planted.length,
    unanswered: answered.filter((a) => a.p === null).length,
    abstainRate: answered.length > 0 ? abstained / answered.length : null,
    bands: CERTAINTY_BANDS.map((band) => {
      const fp = correct.filter((a) => flaggedAt(a, band)).length
      const tp = planted.filter((a) => flaggedAt(a, band)).length
      return {
        band,
        flaggedCorrect: fp,
        flaggedPlanted: tp,
        precision: tp + fp > 0 ? tp / (tp + fp) : null,
        recall: planted.length > 0 ? tp / planted.length : null,
      }
    }),
    calls: run.calls[question] ?? 0,
    usage: run.usage[question] ?? NO_USAGE,
    notAsked: run.notAsked.filter((c) => c.question === question).length,
  }
}

export interface Recommendation {
  mode: "active" | "shadow"
  why: string
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`
}

/**
 * The mode the numbers support at production's threshold (0.4). Active only
 * past the ship gate on enough cases; a question precise only at a higher
 * band stays in shadow, with that noted.
 */
export function recommendMode(score: QuestionScore): Recommendation {
  const at = (band: number) => score.bands.find((b) => b.band === band)
  const base = at(ABSTAIN_BELOW)
  if (score.correct < SHIP_GATE.minCases || score.planted < SHIP_GATE.minCases) {
    return { mode: "shadow", why: `too few cases (${score.correct} published, ${score.planted} planted; the gate needs ${SHIP_GATE.minCases} each)` }
  }
  if (base && (base.precision ?? 0) >= SHIP_GATE.precision && (base.recall ?? 0) >= SHIP_GATE.recall) {
    return { mode: "active", why: `precision ${pct(base.precision)} and recall ${pct(base.recall)} at certainty ≥ 0.4 pass the gate` }
  }
  const high = at(0.8)
  const note = high && (high.precision ?? 0) >= SHIP_GATE.precision
    ? `; at certainty ≥ 0.8 precision is ${pct(high.precision)} (recall ${pct(high.recall)}), which a per-question threshold could use`
    : ""
  return { mode: "shadow", why: `precision ${pct(base?.precision ?? null)}, recall ${pct(base?.recall ?? null)} at certainty ≥ 0.4${note}` }
}

/** USD: what the responses reported, else the design doc's estimate per call. */
export function costOf(score: Pick<QuestionScore, "calls" | "usage">): { usd: number; estimated: boolean } {
  return score.usage.costUsd !== null
    ? { usd: score.usage.costUsd, estimated: false }
    : { usd: score.calls * ESTIMATED_USD_PER_CALL, estimated: true }
}

function usd(cost: { usd: number; estimated: boolean }): string {
  return `${cost.estimated ? "≈ " : ""}$${cost.usd.toFixed(4)}`
}

/** The per-question table, in Markdown. */
export function renderTable(scores: readonly QuestionScore[]): string {
  const header = [
    "Question", "Published", "Planted", "Abstain",
    ...CERTAINTY_BANDS.flatMap((b) => [`P ≥ ${b}`, `R ≥ ${b}`]),
    "Calls", "Tokens in/out", "Cost", "Recommended",
  ]
  const rows = scores.map((s) => [
    s.question,
    String(s.correct),
    String(s.planted),
    pct(s.abstainRate),
    ...s.bands.flatMap((b) => [pct(b.precision), pct(b.recall)]),
    String(s.calls),
    `${s.usage.inputTokens}/${s.usage.outputTokens}`,
    usd(costOf(s)),
    recommendMode(s).mode,
  ])
  return [header, header.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n")
}
