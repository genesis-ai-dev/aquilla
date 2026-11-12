// Shadow eval for seam classification (AQU-1386 §5).
//
// AQU-1386 requires that meaning-unit drafting stay behind a flag until this
// has run and the thresholds are justified by data. This is that instrument.
//
// It scores TWO systems against the same labelled seams:
//   1. the deterministic punctuation heuristic alone — the baseline the model
//      has to beat to earn its latency and its cost;
//   2. Jev, swept across join/confidence thresholds, with the heuristic
//      standing in wherever the gate rejects the model's answer (which is
//      exactly what production does, so the reported number is the number the
//      product gets, not the model's number in isolation).
//
// Usage:
//   pnpm seams:eval                     # heuristic baseline only, no key needed
//   pnpm seams:eval --live              # also call Jev (needs an API key)
//   pnpm seams:eval --live --json       # machine-readable, for the PR
//   pnpm seams:eval --fixture path.json
//
// Key: OPENROUTER_API_KEY (via OpenRouter's decisions endpoint) or
// TYPESAFE_API_KEY (direct). Endpoint override: JEV_DECISIONS_URL.
//
// Re-run this whenever JEV_MODEL is bumped — a pinned version is only half the
// protection; the other half is re-measuring before trusting the old numbers.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  combineSeam,
  heuristicJoin,
  DEFAULT_SEAM_THRESHOLDS,
  type SeamAnswers,
  type SeamThresholds,
} from "../src/lib/completion/seams"
import {
  buildSeamRequest,
  parseSeamAnswers,
  JEV_DECISIONS_URL,
  JEV_MODEL,
  MAX_SEAMS_PER_REQUEST,
  type SeamWindowCell,
} from "../src/lib/completion/seam-request"

interface FixtureDoc {
  id: string
  source: string
  note?: string
  cells: { id: string; text: string; ref?: string; style?: string }[]
  labels: boolean[]
  levels?: number[]
  labelNote?: string
}

interface Fixture {
  documents: FixtureDoc[]
}

interface Scored {
  /** Fraction of seams decided correctly. */
  accuracy: number
  /** Of the seams we joined, how many should have been joined. Low precision
   *  means over-grouping: "I clicked one cell and three changed". */
  precision: number
  /** Of the seams that should have joined, how many we caught. Low recall means
   *  the mid-sentence splits survive — the thing the ticket is about. */
  recall: number
  f1: number
  total: number
  /** How many decisions came from the model rather than the gate's fallback. */
  modelDecided: number
}

function score(predicted: boolean[], labels: boolean[], modelDecided = 0): Scored {
  let tp = 0, fp = 0, fn = 0, correct = 0
  for (let i = 0; i < labels.length; i++) {
    if (predicted[i] === labels[i]) correct++
    if (predicted[i] && labels[i]) tp++
    else if (predicted[i] && !labels[i]) fp++
    else if (!predicted[i] && labels[i]) fn++
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return {
    accuracy: labels.length === 0 ? 1 : correct / labels.length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    total: labels.length,
    modelDecided,
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function loadFixture(path: string): Fixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Fixture
  for (const doc of raw.documents) {
    if (doc.labels.length !== doc.cells.length - 1) {
      throw new Error(
        `fixture ${doc.id}: ${doc.labels.length} labels for ${doc.cells.length} cells ` +
          `(expected ${doc.cells.length - 1})`,
      )
    }
  }
  return raw
}

// ---------------------------------------------------------------------------
// Live Jev
// ---------------------------------------------------------------------------

interface LiveResult {
  answers: (SeamAnswers | null)[]
  latencyMs: number
  inputTokens: number
  outputTokens: number
}

function resolveUrl(): string {
  return process.env.JEV_DECISIONS_URL?.trim() || JEV_DECISIONS_URL
}

async function classifyLive(cells: SeamWindowCell[]): Promise<LiveResult> {
  const key = process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY
  if (!key) throw new Error("--live needs OPENROUTER_API_KEY or TYPESAFE_API_KEY")
  if (cells.length - 1 > MAX_SEAMS_PER_REQUEST) {
    throw new Error(`document has more than ${MAX_SEAMS_PER_REQUEST} seams; window it`)
  }

  const started = Date.now()
  const res = await fetch(resolveUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildSeamRequest(cells)),
  })
  const latencyMs = Date.now() - started
  if (!res.ok) {
    throw new Error(`decisions endpoint ${res.status}: ${await res.text()}`)
  }
  const body = await res.json() as { usage?: { input_tokens?: number; output_tokens?: number } }
  return {
    answers: parseSeamAnswers(body, cells.length - 1),
    latencyMs,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

const JOIN_GRID = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]
const CONFIDENCE_GRID = [0, 0.2, 0.3, 0.4, 0.5, 0.6]

function evaluateThresholds(
  docs: FixtureDoc[],
  answersByDoc: Map<string, (SeamAnswers | null)[]>,
  thresholds: SeamThresholds,
): Scored {
  const predicted: boolean[] = []
  const labels: boolean[] = []
  let modelDecided = 0
  for (const doc of docs) {
    const answers = answersByDoc.get(doc.id) ?? []
    for (let i = 0; i < doc.labels.length; i++) {
      const d = combineSeam(answers[i] ?? null, doc.cells[i].text, thresholds)
      if (d.decidedBy === "model") modelDecided++
      predicted.push(d.join)
      labels.push(doc.labels[i])
    }
  }
  return score(predicted, labels, modelDecided)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const live = args.includes("--live")
  const asJson = args.includes("--json")
  const fixtureArg = args[args.indexOf("--fixture") + 1]
  const fixturePath = args.includes("--fixture") && fixtureArg
    ? resolve(fixtureArg)
    : resolve(import.meta.dirname, "fixtures/seam-eval.json")

  const fixture = loadFixture(fixturePath)
  const docs = fixture.documents

  // 1. Baseline: punctuation alone.
  const basePredicted: boolean[] = []
  const baseLabels: boolean[] = []
  for (const doc of docs) {
    for (let i = 0; i < doc.labels.length; i++) {
      basePredicted.push(heuristicJoin(doc.cells[i].text))
      baseLabels.push(doc.labels[i])
    }
  }
  const baseline = score(basePredicted, baseLabels)

  const bySource = new Map<string, { predicted: boolean[]; labels: boolean[] }>()
  for (const doc of docs) {
    const bucket = bySource.get(doc.source) ?? { predicted: [], labels: [] }
    for (let i = 0; i < doc.labels.length; i++) {
      bucket.predicted.push(heuristicJoin(doc.cells[i].text))
      bucket.labels.push(doc.labels[i])
    }
    bySource.set(doc.source, bucket)
  }

  const report: Record<string, unknown> = {
    fixture: fixturePath,
    seams: baseLabels.length,
    sources: [...bySource.keys()].sort(),
    baseline,
    baselineBySource: Object.fromEntries(
      [...bySource].map(([k, v]) => [k, score(v.predicted, v.labels)]),
    ),
  }

  if (live) {
    const answersByDoc = new Map<string, (SeamAnswers | null)[]>()
    let totalLatency = 0
    let inputTokens = 0
    let outputTokens = 0
    for (const doc of docs) {
      const result = await classifyLive(doc.cells)
      answersByDoc.set(doc.id, result.answers)
      totalLatency += result.latencyMs
      inputTokens += result.inputTokens
      outputTokens += result.outputTokens
    }

    const sweep = []
    for (const join of JOIN_GRID) {
      for (const confidence of CONFIDENCE_GRID) {
        const thresholds = { join, confidence }
        sweep.push({ ...thresholds, ...evaluateThresholds(docs, answersByDoc, thresholds) })
      }
    }
    // Rank by F1 then accuracy: over-grouping and under-grouping are both real
    // failures, so neither precision nor recall alone is the objective.
    sweep.sort((a, b) => b.f1 - a.f1 || b.accuracy - a.accuracy)

    report.model = JEV_MODEL
    report.endpoint = resolveUrl()
    report.defaults = evaluateThresholds(docs, answersByDoc, DEFAULT_SEAM_THRESHOLDS)
    report.best = sweep[0]
    report.sweep = sweep
    report.latency = {
      totalMs: totalLatency,
      callCount: docs.length,
      msPer100Seams: baseLabels.length
        ? Math.round((totalLatency / baseLabels.length) * 100)
        : 0,
    }
    report.tokens = { inputTokens, outputTokens }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`seam eval — ${baseLabels.length} labelled seams from ${docs.length} documents`)
  console.log(`fixture: ${fixturePath}`)
  console.log(`sources: ${(report.sources as string[]).join(", ")}`)
  if (!(report.sources as string[]).includes("ebl")) {
    console.log(
      "\n  ! no `ebl` document in the fixture. AQU-1386 asks for the files Cleiton\n" +
      "    flagged; until one is added these thresholds are provisional.",
    )
  }
  console.log("\nbaseline — punctuation heuristic alone")
  console.log(
    `  accuracy ${pct(baseline.accuracy)}  precision ${pct(baseline.precision)}  ` +
    `recall ${pct(baseline.recall)}  f1 ${pct(baseline.f1)}`,
  )
  for (const [source, bucket] of bySource) {
    const s = score(bucket.predicted, bucket.labels)
    console.log(`    ${source.padEnd(8)} accuracy ${pct(s.accuracy)} over ${s.total} seams`)
  }

  if (!live) {
    console.log("\n(no model run — pass --live with an API key to score Jev)")
    return
  }

  const defaults = report.defaults as Scored
  const best = report.best as Scored & SeamThresholds
  const latency = report.latency as { msPer100Seams: number }
  console.log(`\nJev ${JEV_MODEL} at shipped defaults ` +
    `(join ${DEFAULT_SEAM_THRESHOLDS.join}, confidence ${DEFAULT_SEAM_THRESHOLDS.confidence})`)
  console.log(
    `  accuracy ${pct(defaults.accuracy)}  precision ${pct(defaults.precision)}  ` +
    `recall ${pct(defaults.recall)}  f1 ${pct(defaults.f1)}  ` +
    `model-decided ${defaults.modelDecided}/${defaults.total}`,
  )
  console.log(`\nbest thresholds on this fixture: join ${best.join}, confidence ${best.confidence}`)
  console.log(
    `  accuracy ${pct(best.accuracy)}  precision ${pct(best.precision)}  ` +
    `recall ${pct(best.recall)}  f1 ${pct(best.f1)}`,
  )
  console.log(`\nlatency: ${latency.msPer100Seams}ms per 100 seams`)
  console.log(`tokens: ${JSON.stringify(report.tokens)}`)
  console.log(
    "\nIf `best` beats `baseline` by less than the noise on this fixture, the model\n" +
    "is not earning its call — keep the flag off and ship the heuristic.",
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
