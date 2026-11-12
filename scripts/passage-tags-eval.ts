// Shadow eval for document-understanding tags (AQU-657, capability 3 — slice 1).
//
// AQU-657 requires each slice to ship "behind a flag, with a shadow eval". This
// is that instrument, and the kill switch in
// src/lib/understanding/passage-tags-flag.ts stays off until its numbers justify
// flipping it.
//
// It scores TWO systems against the same labelled passage nodes:
//   1. the deterministic lexical heuristics alone — name matching, quoted-share,
//      chapter-change, token overlap. This is the baseline the model has to beat
//      to earn its latency and its cost, and it is what a caller gets today with
//      the flag off;
//   2. Jev, swept across assert/confidence thresholds, with the heuristic
//      standing in wherever the gate rejects an answer — which is exactly what
//      production does, so the reported number is the number the product gets,
//      not the model's number in isolation.
//
// Usage:
//   pnpm tags:eval                      # heuristic baseline only, no key needed
//   pnpm tags:eval --live               # also call Jev (needs an API key)
//   pnpm tags:eval --live --json        # machine-readable, for the PR
//   pnpm tags:eval --fixture path.json
//
// Key: OPENROUTER_API_KEY (via OpenRouter's decisions endpoint) or
// TYPESAFE_API_KEY (direct). Endpoint override: JEV_DECISIONS_URL.
//
// Re-run this whenever JEV_MODEL is bumped — a pinned version is only half the
// protection; the other half is re-measuring before trusting the old numbers.
//
// WHY THE TAGS ARE SCORED SEPARATELY. They are read by different consumers:
// retrieval and few-shot selection read `participants` and `speech`, the
// propagation slice reads `refersTo`, and the navigator reads `sceneChange`. One
// blended F1 would let a strong cast score hide a useless reference set, and a
// consumer would ship on the blend.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_TAG_THRESHOLDS,
  MAX_RELATED_CANDIDATES,
  combinePassageTags,
  shortlistRelated,
  taggedParticipants,
  taggedReferences,
  type PassageTagAnswers,
  type PassageTagNode,
  type TagCandidates,
  type TagThresholds,
} from "../src/lib/understanding/passage-tags"
import {
  JEV_DECISIONS_URL,
  JEV_MODEL,
  buildPassageTagRequest,
  parsePassageTagAnswers,
  tagWindows,
  type TaggedNodeRequest,
} from "../src/lib/understanding/passage-tag-request"

interface FixtureLabels {
  participants: string[]
  /** null = this node has no predecessor, so the tag is not scored for it. */
  sceneChange: boolean | null
  speech: boolean
  refersTo: string[]
}

interface FixtureNode {
  key: string
  label: string
  text: string
  startRef?: string
  endRef?: string
  labels: FixtureLabels
  labelNote?: string
}

interface FixtureDoc {
  id: string
  kind: string
  provenance: string
  /** The book's cast, as an LLM extraction pass would supply it. */
  cast: string[]
  nodes: FixtureNode[]
}

interface Fixture {
  documents: FixtureDoc[]
}

interface Scored {
  precision: number
  recall: number
  f1: number
  /** Pairs or nodes scored, depending on the tag. */
  total: number
  /** Decisions that came from the model rather than the gate's fallback. */
  modelDecided: number
}

interface Accuracy {
  accuracy: number
  total: number
  modelDecided: number
}

function setScore(
  predicted: readonly Set<string>[],
  labels: readonly Set<string>[],
  universe: readonly number[],
  modelDecided: number,
): Scored {
  let tp = 0
  let fp = 0
  let fn = 0
  for (let i = 0; i < labels.length; i += 1) {
    for (const value of predicted[i]) {
      if (labels[i].has(value)) tp += 1
      else fp += 1
    }
    for (const value of labels[i]) {
      if (!predicted[i].has(value)) fn += 1
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    total: universe.reduce((sum, n) => sum + n, 0),
    modelDecided,
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function loadFixture(path: string): Fixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Fixture
  for (const doc of raw.documents) {
    if (doc.nodes.length === 0) throw new Error(`fixture ${doc.id}: no nodes`)
    for (const node of doc.nodes) {
      for (const name of node.labels.participants) {
        if (!doc.cast.includes(name)) {
          throw new Error(
            `fixture ${doc.id}: node ${node.key} labels participant "${name}" `
            + "which is not in the document's cast",
          )
        }
      }
      for (const key of node.labels.refersTo) {
        if (!doc.nodes.some((other) => other.key === key)) {
          throw new Error(
            `fixture ${doc.id}: node ${node.key} refers to unknown node "${key}"`,
          )
        }
      }
    }
    if (doc.nodes[0].labels.sceneChange !== null) {
      throw new Error(
        `fixture ${doc.id}: the first node has no predecessor, so its sceneChange label `
        + "must be null",
      )
    }
  }
  return raw
}

// ---------------------------------------------------------------------------
// Nodes, candidates, and what the model is asked
// ---------------------------------------------------------------------------

function toNode(node: FixtureNode): PassageTagNode {
  return {
    key: node.key,
    label: node.label,
    text: node.text,
    startRef: node.startRef ?? null,
    endRef: node.endRef ?? null,
  }
}

/**
 * The candidates production would ask about: the whole cast, and the lexical
 * shortlist of related passages.
 *
 * The shortlist is scored in its own right below — a reference the shortlister
 * never proposes is one neither the model nor the heuristic can find, and that
 * ceiling belongs in the report rather than hidden inside the `refersTo` number.
 */
function candidatesFor(doc: FixtureDoc, index: number): TagCandidates {
  const nodes = doc.nodes.map(toNode)
  return {
    participants: doc.cast,
    related: shortlistRelated(nodes[index], nodes, MAX_RELATED_CANDIDATES),
  }
}

function requestsFor(doc: FixtureDoc): TaggedNodeRequest[] {
  return doc.nodes.map((node, index) => ({
    node: toNode(node),
    candidates: candidatesFor(doc, index),
  }))
}

// ---------------------------------------------------------------------------
// Scoring one configuration
// ---------------------------------------------------------------------------

interface Report {
  participants: Scored
  refersTo: Scored
  sceneChange: Accuracy
  speech: Accuracy
  /** Share of labelled references the lexical shortlister even proposed. */
  shortlistRecall: number
}

function evaluate(
  docs: readonly FixtureDoc[],
  answersByDoc: Map<string, (PassageTagAnswers | null)[]>,
  thresholds: TagThresholds,
): Report {
  const participantPredicted: Set<string>[] = []
  const participantLabels: Set<string>[] = []
  const participantUniverse: number[] = []
  let participantModelDecided = 0

  const refersPredicted: Set<string>[] = []
  const refersLabels: Set<string>[] = []
  const refersUniverse: number[] = []
  let refersModelDecided = 0

  let sceneCorrect = 0
  let sceneTotal = 0
  let sceneModel = 0
  let speechCorrect = 0
  let speechTotal = 0
  let speechModel = 0

  let shortlisted = 0
  let labelledRefs = 0

  for (const doc of docs) {
    const requests = requestsFor(doc)
    const answers = answersByDoc.get(doc.id) ?? []

    requests.forEach(({ node, candidates }, index) => {
      const labels = doc.nodes[index].labels
      const tags = combinePassageTags(
        node,
        requests[index - 1]?.node ?? null,
        candidates,
        answers[index] ?? null,
        thresholds,
      )

      participantPredicted.push(new Set(taggedParticipants(tags)))
      participantLabels.push(new Set(labels.participants))
      participantUniverse.push(candidates.participants.length)
      participantModelDecided += tags.participants
        .filter((p) => p.decidedBy === "model").length

      const candidateKeys = new Set(candidates.related.map((c) => c.key))
      labelledRefs += labels.refersTo.length
      shortlisted += labels.refersTo.filter((key) => candidateKeys.has(key)).length

      refersPredicted.push(new Set(taggedReferences(tags)))
      refersLabels.push(new Set(labels.refersTo))
      refersUniverse.push(candidates.related.length)
      refersModelDecided += tags.refersTo.filter((r) => r.decidedBy === "model").length

      if (labels.sceneChange !== null) {
        sceneTotal += 1
        if (tags.sceneChange.value === labels.sceneChange) sceneCorrect += 1
        if (tags.sceneChange.decidedBy === "model") sceneModel += 1
      }

      speechTotal += 1
      if (tags.speech.value === labels.speech) speechCorrect += 1
      if (tags.speech.decidedBy === "model") speechModel += 1
    })
  }

  return {
    participants: setScore(
      participantPredicted,
      participantLabels,
      participantUniverse,
      participantModelDecided,
    ),
    refersTo: setScore(refersPredicted, refersLabels, refersUniverse, refersModelDecided),
    sceneChange: {
      accuracy: sceneTotal === 0 ? 1 : sceneCorrect / sceneTotal,
      total: sceneTotal,
      modelDecided: sceneModel,
    },
    speech: {
      accuracy: speechTotal === 0 ? 1 : speechCorrect / speechTotal,
      total: speechTotal,
      modelDecided: speechModel,
    },
    shortlistRecall: labelledRefs === 0 ? 1 : shortlisted / labelledRefs,
  }
}

// ---------------------------------------------------------------------------
// Live Jev
// ---------------------------------------------------------------------------

interface LiveResult {
  answers: (PassageTagAnswers | null)[]
  latencyMs: number
  inputTokens: number
  outputTokens: number
  calls: number
}

function resolveUrl(): string {
  return process.env.JEV_DECISIONS_URL?.trim() || JEV_DECISIONS_URL
}

/**
 * Tag one document, windowed exactly as the store windows it (one node of
 * overlap, so `scene_change` always has a predecessor in state). A later
 * window's answer for an overlapped node replaces the earlier one — it is the
 * same question with more context.
 */
async function tagLive(requests: readonly TaggedNodeRequest[]): Promise<LiveResult> {
  const key = process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY
  if (!key) throw new Error("--live needs OPENROUTER_API_KEY or TYPESAFE_API_KEY")

  const answers: (PassageTagAnswers | null)[] = requests.map(() => null)
  let latencyMs = 0
  let inputTokens = 0
  let outputTokens = 0
  let calls = 0

  for (const { from, to } of tagWindows(requests.length)) {
    const window = requests.slice(from, to)
    if (window.length === 0) continue

    const started = Date.now()
    const res = await fetch(resolveUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPassageTagRequest(window)),
    })
    latencyMs += Date.now() - started
    calls += 1
    if (!res.ok) {
      throw new Error(`decisions endpoint ${res.status}: ${await res.text()}`)
    }
    const body = await res.json() as {
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    inputTokens += body.usage?.input_tokens ?? 0
    outputTokens += body.usage?.output_tokens ?? 0

    parsePassageTagAnswers(body, window).forEach((answer, offset) => {
      answers[from + offset] = answer
    })
  }

  return { answers, latencyMs, inputTokens, outputTokens, calls }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

const ASSERT_GRID = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]
const CONFIDENCE_GRID = [0, 0.2, 0.3, 0.4, 0.5, 0.6]

/** One number to rank configurations by: the mean of the four tags' primary
 *  metrics. Ranking on one tag would tune the thresholds for one consumer. */
function overall(report: Report): number {
  return (
    report.participants.f1
    + report.refersTo.f1
    + report.sceneChange.accuracy
    + report.speech.accuracy
  ) / 4
}

function printReport(name: string, report: Report): void {
  console.log(`\n${name}`)
  console.log(
    `  participants  f1 ${pct(report.participants.f1)}  `
    + `precision ${pct(report.participants.precision)}  `
    + `recall ${pct(report.participants.recall)}  `
    + `(${report.participants.total} candidate pairs, `
    + `${report.participants.modelDecided} model-decided)`,
  )
  console.log(
    `  refersTo      f1 ${pct(report.refersTo.f1)}  `
    + `precision ${pct(report.refersTo.precision)}  `
    + `recall ${pct(report.refersTo.recall)}  `
    + `(${report.refersTo.total} candidate pairs, `
    + `${report.refersTo.modelDecided} model-decided)`,
  )
  console.log(
    `  sceneChange   accuracy ${pct(report.sceneChange.accuracy)}  `
    + `(${report.sceneChange.total} nodes, ${report.sceneChange.modelDecided} model-decided)`,
  )
  console.log(
    `  speech        accuracy ${pct(report.speech.accuracy)}  `
    + `(${report.speech.total} nodes, ${report.speech.modelDecided} model-decided)`,
  )
  console.log(`  overall       ${pct(overall(report))}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const live = args.includes("--live")
  const asJson = args.includes("--json")
  const fixtureArg = args[args.indexOf("--fixture") + 1]
  const fixturePath = args.includes("--fixture") && fixtureArg
    ? resolve(fixtureArg)
    : resolve(import.meta.dirname, "fixtures/passage-tags-eval.json")

  const fixture = loadFixture(fixturePath)
  const docs = fixture.documents
  const nodeCount = docs.reduce((sum, doc) => sum + doc.nodes.length, 0)

  // 1. Baseline: the lexical heuristics alone (no answers at all).
  const baseline = evaluate(docs, new Map(), DEFAULT_TAG_THRESHOLDS)

  const report: Record<string, unknown> = {
    fixture: fixturePath,
    nodes: nodeCount,
    documents: docs.map((doc) => ({ id: doc.id, kind: doc.kind, nodes: doc.nodes.length })),
    shortlistRecall: baseline.shortlistRecall,
    baseline,
  }

  if (live) {
    const answersByDoc = new Map<string, (PassageTagAnswers | null)[]>()
    let latencyMs = 0
    let inputTokens = 0
    let outputTokens = 0
    let calls = 0
    for (const doc of docs) {
      const result = await tagLive(requestsFor(doc))
      answersByDoc.set(doc.id, result.answers)
      latencyMs += result.latencyMs
      inputTokens += result.inputTokens
      outputTokens += result.outputTokens
      calls += result.calls
    }

    const sweep = ASSERT_GRID.flatMap((assert) =>
      CONFIDENCE_GRID.map((confidence) => {
        const thresholds = { assert, confidence }
        const scored = evaluate(docs, answersByDoc, thresholds)
        return { ...thresholds, overall: overall(scored), ...scored }
      }))
    sweep.sort((a, b) => b.overall - a.overall)

    report.model = JEV_MODEL
    report.endpoint = resolveUrl()
    report.defaults = evaluate(docs, answersByDoc, DEFAULT_TAG_THRESHOLDS)
    report.best = sweep[0]
    report.sweep = sweep
    report.cost = { calls, latencyMs, msPerNode: Math.round(latencyMs / nodeCount) }
    report.tokens = { inputTokens, outputTokens }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`passage-tag eval — ${nodeCount} labelled nodes from ${docs.length} documents`)
  console.log(`fixture: ${fixturePath}`)
  console.log(
    `shortlist ceiling: ${pct(baseline.shortlistRecall)} of labelled references are even `
    + "proposed as candidates",
  )
  printReport("baseline — lexical heuristics alone", baseline)

  if (!live) {
    console.log("\n(no model run — pass --live with an API key to score Jev)")
    return
  }

  printReport(
    `Jev ${JEV_MODEL} at shipped defaults `
    + `(assert ${DEFAULT_TAG_THRESHOLDS.assert}, confidence ${DEFAULT_TAG_THRESHOLDS.confidence})`,
    report.defaults as Report,
  )
  const best = report.best as Report & TagThresholds
  printReport(
    `best thresholds on this fixture: assert ${best.assert}, confidence ${best.confidence}`,
    best,
  )
  const cost = report.cost as { calls: number; msPerNode: number }
  console.log(`\ncost: ${cost.calls} calls, ${cost.msPerNode}ms per node`)
  console.log(`tokens: ${JSON.stringify(report.tokens)}`)
  console.log(
    "\nIf `best` beats `baseline` by less than the noise on this fixture, the model is\n"
    + "not earning its call — keep the flag off and ship the heuristic. A tag that wins\n"
    + "on its own may still be worth enabling alone; the tags are read separately.",
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
