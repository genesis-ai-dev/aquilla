// Park-time reflection against the real database and the real tick (AQU-1302).
//
// The pure half (prompt/parse/cap) is pinned in
// lib/contextual/reflect.test.ts. What only a database can show is here: that
// the watermark makes a reflection see each piece of work exactly once, that a
// note already approved is not re-proposed, and — the contract that matters
// most — that a run parks normally whether reflection succeeds, says nothing,
// or fails outright.
//
// The tick cases drive the REAL LlmCall through the scripted mock, so the
// prompt marker → mock → parse → propose path is exercised end to end rather
// than stubbed in the middle.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  createRun,
  getRun,
  insertDrafts,
  appendSteering,
  markSteeringConsumed,
  listContextualRunEvents,
  recordWaveOutcome,
  markRunReflected,
} from "../../../db/shared/contextual-runs"
import { createProposal, listMemories, reviewMemory } from "../../../db/shared/agent-memory"
import { raiseDecision, answerDecision } from "../../../db/shared/contextual-decisions"
import {
  gatherReflectionEvidence,
  reflectAtPark,
  reflectionWatermark,
} from "../lib/contextual/reflect"
import { runOneTick, makeLlmCall } from "../lib/contextual/tick"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
import type { AquillaDb } from "../../../db/shim/postgres"

const db: AquillaDb = env.AQUILLA_PG
const PROJECT = "proj-reflect"
const FILE = "file-reflect"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"
/** What the scripted mock's reflect branch proposes, slugified. */
const MOCK_NOTE_PATH = "autopilot/mock-register-convention.md"

// ── The real LlmCall over the scripted mock ────────────────────────────────

let reflectCalls = 0
/** Set to make ONLY the reflection call fail, leaving drafting healthy. */
let failReflect = false
const realFetch = globalThis.fetch

beforeEach(() => {
  reflectCalls = 0
  failReflect = false
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== MOCK_URL) throw new Error(`unexpected fetch in reflect test: ${url}`)
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[]
    }
    const isReflect = body.messages.some(
      (message) => message.role === "system" && message.content.includes("[[ctx:reflect]]"),
    )
    if (isReflect) {
      reflectCalls += 1
      if (failReflect) return new Response("provider exploded", { status: 500 })
    }
    return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
})

afterEach(() => {
  vi.stubGlobal("fetch", realFetch)
})

const llm = () =>
  makeLlmCall({
    url: MOCK_URL,
    apiKey: "mock",
    models: { fast: "mock/fast", mid: "mock/mid", deep: "mock/deep" },
  })

// ── Seeding ─────────────────────────────────────────────────────────────────

async function seedCell(
  project: string,
  file: string,
  cellId: string,
  ref: string,
  source: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
    .bind(project, file, cellId, source, ref, `ev-src-${project}-${cellId}`)
    .run()
}

/** Two chapters → two derived spans, so a run to exhaustion clears the gate. */
async function seedTwoChapters(project: string, file: string): Promise<void> {
  await seedCell(project, file, "c1", "MRK 1:1", "In the beginning")
  await seedCell(project, file, "c2", "MRK 1:2", "was the word")
  await seedCell(project, file, "c3", "MRK 2:1", "Some days later")
  await seedCell(project, file, "c4", "MRK 2:2", "he returned home")
}

async function startRun(project = PROJECT, file = FILE) {
  const created = await createRun(db, {
    projectId: project,
    fileId: file,
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
    // Unlimited allowance (AQU-1300): these runs must walk BOTH seeded
    // chapters before parking, or the two-passage reflection gate never opens.
    spanAllowance: null,
  })
  if (created.status !== "ok") throw new Error("run not created")
  return created.run
}

/** Give the run `count` finished passages without running the pipeline. */
async function creditSpans(runId: string, count: number): Promise<void> {
  await recordWaveOutcome(db, runId, {
    cursor: { seeds: [], nextIndex: 0 },
    doneCount: count,
    failedCount: 0,
    unitsUsed: 0,
    callsUsed: 0,
  })
}

async function stageDraft(runId: string, cellId: string, text: string): Promise<void> {
  await insertDrafts(db, {
    runId,
    projectId: PROJECT,
    fileId: FILE,
    drafts: [{ cellId, text }],
  })
}

async function runToPark(runId: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const result = await runOneTick({ db, runId, llm: llm() })
    if (!result.continueRun) return
  }
  throw new Error("run never settled")
}

// ── The span gate ───────────────────────────────────────────────────────────

describe("reflectAtPark — the span gate", () => {
  it("proposes nothing after a single passage, and leaves the watermark alone", async () => {
    const run = await startRun()
    await creditSpans(run.id, 1)
    await stageDraft(run.id, "c1", "MOCK In the beginning")
    const fresh = await getRun(db, run.id)

    const staged = await reflectAtPark({ db, run: fresh!, llm: llm() })

    expect(staged).toBe(0)
    expect(reflectCalls).toBe(0)
    expect(await listMemories(db, PROJECT, "proposed")).toHaveLength(0)
    // Untouched, so the passage still counts toward the NEXT reflection.
    expect((await getRun(db, run.id))?.reflectedAt).toBeNull()
  })

  it("reflects once two passages have landed, and stages a reviewable proposal", async () => {
    const run = await startRun()
    await creditSpans(run.id, 2)
    await stageDraft(run.id, "c1", "MOCK In the beginning")
    await stageDraft(run.id, "c2", "MOCK was the word")

    const staged = await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })

    expect(staged).toBe(1)
    const proposed = await listMemories(db, PROJECT, "proposed")
    expect(proposed).toHaveLength(1)
    expect(proposed[0].path).toBe(MOCK_NOTE_PATH)
    expect(proposed[0].status).toBe("proposed")
    expect(proposed[0].provenance?.runId).toBe(run.id)
    expect(proposed[0].rationale).toBeTruthy()
  })

  it("does not reflect again until two MORE passages land", async () => {
    const run = await startRun()
    await creditSpans(run.id, 2)
    await stageDraft(run.id, "c1", "MOCK one")
    await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })
    expect(reflectCalls).toBe(1)

    // One more passage: still short of the gate measured from the watermark.
    await creditSpans(run.id, 1)
    await stageDraft(run.id, "c2", "MOCK two")
    expect(await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })).toBe(0)
    expect(reflectCalls).toBe(1)

    // The second one clears it.
    await creditSpans(run.id, 1)
    await stageDraft(run.id, "c3", "MOCK three")
    await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })
    expect(reflectCalls).toBe(2)
  })

  it("marks the watermark even when there was no output to reflect on", async () => {
    // Two passages that staged nothing (every cell was already filled). There
    // is nothing to abstract, and no reason to pay for a call to learn that.
    const run = await startRun()
    await creditSpans(run.id, 2)

    expect(await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })).toBe(0)
    expect(reflectCalls).toBe(0)
    expect((await getRun(db, run.id))?.reflectedAt).not.toBeNull()
  })
})

// ── Not re-proposing what the project already knows ─────────────────────────

describe("reflectAtPark — deduplication", () => {
  it("does not re-propose a note the project already approved", async () => {
    const seeded = await createProposal(db, {
      projectId: PROJECT,
      path: MOCK_NOTE_PATH,
      content: "# Mock register convention\n\nAlready known.",
    })
    if (seeded.status !== "ok") throw new Error("seed failed")
    await reviewMemory(db, { id: seeded.memory.id, action: "approve", reviewedBy: "lead" })

    const run = await startRun()
    await creditSpans(run.id, 2)
    await stageDraft(run.id, "c1", "MOCK one")

    const staged = await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })

    expect(staged).toBe(0)
    expect(await listMemories(db, PROJECT, "proposed")).toHaveLength(0)
    // The reflection still happened and still counts — the model was asked and
    // had nothing new, which is exactly the outcome the prompt aims for.
    expect(reflectCalls).toBe(1)
    expect((await getRun(db, run.id))?.reflectedAt).not.toBeNull()
  })

  it("does not stack a second copy of a proposal still awaiting review", async () => {
    const run = await startRun()
    await creditSpans(run.id, 2)
    await stageDraft(run.id, "c1", "MOCK one")
    await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })

    await creditSpans(run.id, 2)
    await stageDraft(run.id, "c2", "MOCK two")
    await reflectAtPark({ db, run: (await getRun(db, run.id))!, llm: llm() })

    expect(await listMemories(db, PROJECT, "proposed")).toHaveLength(1)
  })
})

// ── Evidence ────────────────────────────────────────────────────────────────

describe("gatherReflectionEvidence", () => {
  it("collects the run's drafts, consumed directions and answered questions", async () => {
    const run = await startRun()
    await stageDraft(run.id, "c1", "MOCK In the beginning")
    const steering = await appendSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      runId: run.id,
      kind: "direction",
      body: "keep the register plain",
      createdBy: "tester",
    })
    if (steering.status !== "ok") throw new Error("steering failed")
    await markSteeringConsumed(db, [steering.entry.id])
    const decision = await raiseDecision(db, {
      projectId: PROJECT,
      runId: run.id,
      fileId: FILE,
      reason: "Formal or informal you?",
    })
    await answerDecision(db, decision.id, "informal", 1)

    const evidence = await gatherReflectionEvidence(db, (await getRun(db, run.id))!)

    expect(evidence.drafts.map((draft) => draft.text)).toEqual(["MOCK In the beginning"])
    expect(evidence.directions).toEqual(["keep the register plain"])
    expect(evidence.answeredDecisions).toEqual([
      { question: "Formal or informal you?", answer: "informal" },
    ])
  })

  it("only sees work newer than the last reflection", async () => {
    const run = await startRun()
    await stageDraft(run.id, "c1", "MOCK before")
    await markRunReflected(db, run.id)
    const afterMark = (await getRun(db, run.id))!
    expect(reflectionWatermark(afterMark)).toBe(afterMark.reflectedAt)

    expect((await gatherReflectionEvidence(db, afterMark)).drafts).toEqual([])

    await stageDraft(run.id, "c2", "MOCK after")
    const evidence = await gatherReflectionEvidence(db, (await getRun(db, run.id))!)
    expect(evidence.drafts.map((draft) => draft.text)).toEqual(["MOCK after"])
  })

  it("ignores another run's drafts", async () => {
    const mine = await startRun()
    const theirs = await createRun(db, {
      projectId: PROJECT,
      fileId: "file-other",
      initiatedBy: "someone-else",
    })
    if (theirs.status !== "ok") throw new Error("second run not created")
    await insertDrafts(db, {
      runId: theirs.run.id,
      projectId: PROJECT,
      fileId: "file-other",
      drafts: [{ cellId: "x1", text: "MOCK not mine" }],
    })
    await stageDraft(mine.id, "c1", "MOCK mine")

    const evidence = await gatherReflectionEvidence(db, (await getRun(db, mine.id))!)
    expect(evidence.drafts.map((draft) => draft.text)).toEqual(["MOCK mine"])
  })
})

// ── Through the tick: a park is a park, whatever reflection does ────────────

describe("the tick reflects when a run parks", () => {
  it("proposes notes and posts ONE activity line after a multi-passage run parks", async () => {
    await seedTwoChapters(PROJECT, FILE)
    const run = await startRun()

    await runToPark(run.id)

    const parked = await getRun(db, run.id)
    expect(parked?.status).toBe("parked")
    expect(parked!.doneSpans).toBeGreaterThanOrEqual(2)
    expect(await listMemories(db, PROJECT, "proposed")).toHaveLength(1)
    const events = await listContextualRunEvents(db, { projectId: PROJECT, runId: run.id })
    const proposedEvents = events.events.filter((event) => event.kind === "memories_proposed")
    expect(proposedEvents).toHaveLength(1)
    expect(proposedEvents[0].summary).toBe("Proposed 1 note for review")
    expect(proposedEvents[0].details.count).toBe(1)
    expect(proposedEvents[0].status).toBe("complete")
  })

  it("stays silent when the run parked after a single passage", async () => {
    const project = "proj-reflect-one"
    const file = "file-one"
    await seedCell(project, file, "only", "MRK 1:1", "In the beginning")
    const run = await startRun(project, file)

    await runToPark(run.id)

    const parked = await getRun(db, run.id)
    expect(parked?.status).toBe("parked")
    expect(parked?.doneSpans).toBe(1)
    expect(reflectCalls).toBe(0)
    expect(await listMemories(db, project, "proposed")).toHaveLength(0)
    const events = await listContextualRunEvents(db, { projectId: project, runId: run.id })
    expect(events.events.some((event) => event.kind === "memories_proposed")).toBe(false)
  })

  it("parks normally when the reflection call fails, and says so in the activity", async () => {
    await seedTwoChapters(PROJECT, FILE)
    const run = await startRun()
    failReflect = true

    await runToPark(run.id)

    const parked = await getRun(db, run.id)
    expect(parked?.status).toBe("parked")
    expect(parked!.doneSpans).toBeGreaterThanOrEqual(2)
    expect(await listMemories(db, PROJECT, "proposed")).toHaveLength(0)
    const events = await listContextualRunEvents(db, { projectId: PROJECT, runId: run.id })
    const failures = events.events.filter((event) => event.kind === "memories_proposed")
    expect(failures).toHaveLength(1)
    expect(failures[0].status).toBe("failed")
    // The watermark stays put, so the next park retries over the same work
    // rather than losing it to one bad provider minute.
    expect(parked?.reflectedAt).toBeNull()
  })
})
