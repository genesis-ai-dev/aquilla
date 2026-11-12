/**
 * Report assembly for the AQU-1868 performance harness.
 *
 * One flat `metrics` map is what budgets are checked against, and it is also
 * what a CI artifact diff is readable in. The per-operation `LatencySummary`
 * objects are kept alongside it so a breach can be read without re-running:
 * p95 says a budget was missed, the distribution says whether it was a tail
 * or the whole curve moving.
 */

import { round, type LatencySummary } from "./stats"
import type { BudgetEvaluation } from "./budgets"

export type MetricMap = Record<string, number>

export interface PerfReportTarget {
  authBase: string
  syncBase: string
  appBase: string | null
}

export interface PerfReportFixture {
  projectId: string
  files: number
  cells: number
  measuredFileId: string | null
  measuredFileName: string | null
  measuredFileCells: number | null
}

export interface PerfReport {
  harness: "big-bible"
  startedAt: string
  durationMs: number
  gitSha: string | null
  target: PerfReportTarget
  fixture: PerfReportFixture
  /** Per-operation distributions, keyed by the metric prefix. */
  operations: Record<string, LatencySummary>
  /** Everything budgets are evaluated against, flat. */
  metrics: MetricMap
  /** Operations the run deliberately skipped, and why. */
  skipped: Record<string, string>
  budgets: BudgetEvaluation | null
  passed: boolean
}

/**
 * Flatten one operation's distribution into budget-checkable metric keys:
 * `<prefix>.p95Ms`, `<prefix>.throughputPerSec`, …
 */
export function flattenSummary(prefix: string, summary: LatencySummary): MetricMap {
  const metrics: MetricMap = {
    [`${prefix}.count`]: summary.count,
    [`${prefix}.minMs`]: round(summary.minMs),
    [`${prefix}.p50Ms`]: round(summary.p50Ms),
    [`${prefix}.p95Ms`]: round(summary.p95Ms),
    [`${prefix}.p99Ms`]: round(summary.p99Ms),
    [`${prefix}.maxMs`]: round(summary.maxMs),
    [`${prefix}.meanMs`]: round(summary.meanMs),
  }
  if (summary.throughputPerSec !== undefined) {
    metrics[`${prefix}.throughputPerSec`] = round(summary.throughputPerSec, 2)
  }
  return metrics
}

/** Console/PR rendering: one aligned line per operation, then the verdict. */
export function renderReport(report: PerfReport): string {
  const lines: string[] = []
  lines.push(`Big Bible perf report — ${report.startedAt}`)
  lines.push(
    `  project ${report.fixture.projectId} — ${report.fixture.files} files, ${report.fixture.cells.toLocaleString()} cells`,
  )
  if (report.fixture.measuredFileName) {
    lines.push(
      `  measured file ${report.fixture.measuredFileName} (${(report.fixture.measuredFileCells ?? 0).toLocaleString()} cells)`,
    )
  }
  lines.push(`  target auth=${report.target.authBase} sync=${report.target.syncBase}`)
  lines.push("")

  const names = Object.keys(report.operations).sort()
  const width = names.reduce((max, name) => Math.max(max, name.length), 10)
  lines.push(`  ${"operation".padEnd(width)}   n     p50      p95      p99      max`)
  for (const name of names) {
    const summary = report.operations[name]
    const cells = [summary.p50Ms, summary.p95Ms, summary.p99Ms, summary.maxMs]
      .map((value) => `${round(value)}ms`.padStart(8))
      .join(" ")
    lines.push(`  ${name.padEnd(width)} ${String(summary.count).padStart(3)} ${cells}`)
    if (summary.throughputPerSec !== undefined) {
      lines.push(`  ${" ".repeat(width)}     ${round(summary.throughputPerSec, 2)}/s sustained`)
    }
  }

  const longTasks = Object.entries(report.metrics).filter(([metric]) => metric.includes("longTask"))
  if (longTasks.length > 0) {
    lines.push("")
    lines.push("  main-thread long tasks (>50ms)")
    for (const [metric, value] of longTasks.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    ${metric} = ${value}`)
    }
  }

  const skipped = Object.entries(report.skipped)
  if (skipped.length > 0) {
    lines.push("")
    lines.push("  skipped")
    for (const [name, reason] of skipped) lines.push(`    ${name} — ${reason}`)
  }

  lines.push("")
  if (!report.budgets) {
    lines.push("  budgets: not evaluated")
    return lines.join("\n")
  }
  if (report.budgets.breaches.length === 0) {
    lines.push(`  budgets: ${report.budgets.passed.length} passed, 0 breached`)
  } else {
    lines.push(`  BUDGET BREACHES (${report.budgets.breaches.length}):`)
    for (const breach of report.budgets.breaches) {
      const comparator = breach.direction === "max" ? "exceeds max" : "below min"
      lines.push(
        `    ${breach.metric}: ${round(breach.measured)} ${comparator} ${round(breach.budget)}`,
      )
    }
  }
  if (report.budgets.unmeasured.length > 0) {
    lines.push(`  unmeasured budgets: ${report.budgets.unmeasured.join(", ")}`)
  }
  return lines.join("\n")
}
