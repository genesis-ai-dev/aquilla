/**
 * Budget file parsing and evaluation for the AQU-1868 performance harness.
 *
 * The budgets live in the repo (`scripts/perf/budgets.json`) so a regression is
 * a diff someone has to argue with, not a number remembered from a run last
 * month. Two directions, because both kinds of regression exist:
 *
 *   max — latency and long-task metrics: higher is worse.
 *   min — throughput metrics: lower is worse.
 *
 * A budget whose metric the run never measured is reported as UNMEASURED
 * rather than passing silently. A partial run (`--only`) is allowed to leave
 * budgets unmeasured; a full run is not — a harness that quietly stops
 * checking half its budgets is worse than no harness.
 */

export type BudgetDirection = "max" | "min"

export interface BudgetFile {
  max: Record<string, number>
  min: Record<string, number>
}

export interface BudgetBreach {
  metric: string
  direction: BudgetDirection
  measured: number
  budget: number
  /** How far past the budget, always positive. */
  overBy: number
}

export interface BudgetEvaluation {
  breaches: BudgetBreach[]
  /** Metrics that had a budget and a measurement, and passed. */
  passed: string[]
  /** Budgeted metrics the run produced no measurement for. */
  unmeasured: string[]
  /** Measured metrics with no budget — reported, never failed. */
  unbudgeted: string[]
}

function parseDirection(raw: unknown, direction: BudgetDirection): Record<string, number> {
  if (raw === undefined) return {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`budgets.${direction} must be an object of metric → number`)
  }
  const out: Record<string, number> = {}
  for (const [metric, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`budgets.${direction}.${metric} must be a finite number, got ${String(value)}`)
    }
    out[metric] = value
  }
  return out
}

/** Validate a parsed budgets.json. Throws with the offending key named. */
export function parseBudgetFile(raw: unknown): BudgetFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("budgets file must be a JSON object")
  }
  const body = raw as Record<string, unknown>
  const file: BudgetFile = {
    max: parseDirection(body.max, "max"),
    min: parseDirection(body.min, "min"),
  }
  const overlap = Object.keys(file.max).filter((metric) => metric in file.min)
  if (overlap.length > 0) {
    throw new Error(`metric(s) budgeted in both max and min: ${overlap.join(", ")}`)
  }
  if (Object.keys(file.max).length + Object.keys(file.min).length === 0) {
    throw new Error("budgets file declares no budgets")
  }
  return file
}

/** Compare a run's flat metric map against the budget file. */
export function evaluateBudgets(
  measured: Readonly<Record<string, number>>,
  budgets: BudgetFile,
): BudgetEvaluation {
  const breaches: BudgetBreach[] = []
  const passed: string[] = []
  const unmeasured: string[] = []

  const check = (direction: BudgetDirection, entries: Record<string, number>): void => {
    for (const [metric, budget] of Object.entries(entries)) {
      const value = measured[metric]
      if (value === undefined) {
        unmeasured.push(metric)
        continue
      }
      const over = direction === "max" ? value - budget : budget - value
      if (over > 0) breaches.push({ metric, direction, measured: value, budget, overBy: over })
      else passed.push(metric)
    }
  }
  check("max", budgets.max)
  check("min", budgets.min)

  const budgeted = new Set([...Object.keys(budgets.max), ...Object.keys(budgets.min)])
  const unbudgeted = Object.keys(measured).filter((metric) => !budgeted.has(metric))

  // Sort so a report diff between two runs is about the numbers, not the order.
  breaches.sort((a, b) => a.metric.localeCompare(b.metric))
  return {
    breaches,
    passed: passed.sort(),
    unmeasured: unmeasured.sort(),
    unbudgeted: unbudgeted.sort(),
  }
}

/** One line per breach, for the console and the PR body. */
export function renderBreaches(breaches: readonly BudgetBreach[]): string[] {
  return breaches.map((breach) => {
    const comparator = breach.direction === "max" ? "exceeds max" : "below min"
    return `${breach.metric}: ${breach.measured.toFixed(1)} ${comparator} ${breach.budget.toFixed(1)} (by ${breach.overBy.toFixed(1)})`
  })
}
