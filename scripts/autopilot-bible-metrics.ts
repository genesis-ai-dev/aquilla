// autopilot-bible-metrics — before/after Bible data for one project, from
// autopilot's per-span metrics traces (AQU-1690; design doc §9.6).
//
//   npx tsx scripts/autopilot-bible-metrics.ts --project <id> [--since 2026-10-01] [--json]
//
// Reads the `span-metrics` rows autopilot writes into contextual_run_traces
// (one per span; kept 30 days) and groups the spans by their Bible data state:
// "off", "facts", "facts+checks" or "unavailable:<reason>". Compare "off"
// against the others for the same project. Read-only.

import { Client } from "pg"
import { parseSpanMetricsRow, summarizeSpanMetrics, type SpanMetricsRow } from "./lib/bible-metrics-summary"

const PG_URL =
  process.env.LOCAL_PG_URL ||
  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ||
  "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev"

const argv = process.argv.slice(2)
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

async function main(): Promise<void> {
  const project = arg("--project")
  if (!project) {
    console.error("usage: npx tsx scripts/autopilot-bible-metrics.ts --project <id> [--since <ISO date>] [--json]")
    process.exit(2)
  }
  const since = arg("--since")
  const client = new Client({ connectionString: PG_URL })
  await client.connect()
  try {
    const { rows } = await client.query<{ output: string | null }>(
      `SELECT output FROM contextual_run_traces
        WHERE project_id = $1 AND label = 'span-metrics' AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        ORDER BY created_at`,
      [project, since ?? null],
    )
    const metrics = rows.flatMap((row): SpanMetricsRow[] => {
      const parsed = parseSpanMetricsRow(row.output)
      return parsed ? [parsed] : []
    })
    const summary = summarizeSpanMetrics(metrics)
    if (argv.includes("--json")) {
      console.log(JSON.stringify(summary, null, 2))
      return
    }
    if (summary.length === 0) {
      console.log(`No span metrics for project ${project}${since ? ` since ${since}` : ""} (traces are kept 30 days).`)
      return
    }
    for (const group of summary) {
      console.log(`\nBible data: ${group.bibleData} — ${group.spans} span(s), ${group.stagedCells} staged cell(s)`)
      console.log(`  units/span ${group.meanUnits}   calls/span ${group.meanCalls}   construe rounds/span ${group.meanConstrueRounds ?? "—"}`)
      console.log(`  parked on a question: ${(group.decisionRate * 100).toFixed(1)}% of spans; "who is speaking": ${group.speakerDecisionShare === null ? "—" : `${(group.speakerDecisionShare * 100).toFixed(1)}%`}`)
      console.log(`  bkp findings per 100 staged cells: drafted ${group.bkpPer100Drafted ?? "—"}, left at staging ${group.bkpPer100Staged ?? "—"}; repaired ${group.repairedCells}`)
      console.log(`  Jev calls/span ${group.jevCallsPerSpan}`)
      for (const [key, value] of Object.entries(group.judgments)) {
        console.log(`    ${key}: ${value.count} (mean certainty ${value.meanCertainty ?? "—"})`)
      }
    }
  } finally {
    await client.end()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
