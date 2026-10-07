// The autopilot's trust gate — per-run span allowance (AQU-1300).
//
// WHY this file exists: before the allowance, a run had no work budget at all.
// Pressing Play on a book walked every span in scope in waves of six, and the
// first thing a new user saw was several hundred drafts they had never agreed
// to. The fix is a budget that starts at ONE passage and grows only with human
// input, so the product earns the right to keep going instead of assuming it.
//
// That makes "stops when it should" a correctness property, not a preference,
// and it is only observable at the seams this file pins:
//
//   1. The gate holds at the span edge — BEFORE any model call, so an
//      exhausted budget costs nothing. A gate that stopped after spending
//      would be decoration.
//   2. The budget is debited by spans actually PROCESSED. A blocked span
//      produced a question, not a passage; charging for it makes the user pay
//      twice for one passage.
//   3. An open question outranks remaining budget. Drafting past an unanswered
//      decision buries it under work that assumes one particular answer.
//   4. Every wake path is gated. Steering, review, and Continue each buy a
//      known amount; if any one of them resumed a run without paying, the
//      whole gate would be a formality — that is the regression to fear here,
//      because each of those paths lives in a different file.
//   5. `null` means unlimited, and is what pre-AQU-1300 rows carry, so the
//      deploy cannot truncate a run that was already in flight.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  createRun,
  getRun,
  grantSpanAllowance,
  parkRun,
  resumeRun,
  recordWaveOutcome,
  DEFAULT_SPAN_ALLOWANCE,
  INPUT_GRANT_CAP,
  INPUT_GRANT_SPANS,
  CONTINUE_BATCH_SPANS,
  type ContextualRun,
} from "../../../db/shared/contextual-runs"
import { raiseDecision } from "../../../db/shared/contextual-decisions"
import { runOneTick, makeLlmCall } from "../lib/contextual/tick"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const db = env.AQUILLA_PG
const PROJECT = "proj-allowance"
const FILE = "file-allowance"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"

// ── Fetch stub (same real path as contextual-waves.test.ts) ─────────────────

const realFetch = globalThis.fetch
/** Counts real drafter calls, which is the only honest measure of "did it
 *  actually spend". Cursor position can advance for reasons the budget does
 *  not pay for; a model call cannot. */
let draftCalls = 0

beforeEach(() => {
  draftCalls = 0
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== MOCK_URL) throw new Error(`unexpected fetch in allowance test: ${url}`)
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: { role: string; content: string }[]
    }
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    if (system.includes("[[ctx:draft]]")) draftCalls++
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

let seq = 0

async function seedCell(cellId: string, ref: string, source: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, sequence_index, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, ?, 0)`,
    )
    .bind(PROJECT, FILE, cellId, source, ref, ++seq, `ev-src-${FILE}-${cellId}`)
    .run()
}

/** Six chapters → six derived spans, all untranslated. Deliberately more than
 *  MAX_WAVE_CONCURRENCY so an ungated run would visibly overshoot. */
async function seedSixSpans(): Promise<void> {
  const refs = ["MRK 1:1", "MRK 2:1", "MRK 3:1", "MRK 4:1", "MRK 5:1", "MRK 6:1"]
  for (const [i, ref] of refs.entries()) {
    await seedCell(`a${i + 1}`, ref, `Passage number ${i + 1}`)
  }
}

async function startRun(spanAllowance?: number | null): Promise<ContextualRun> {
  const created = await createRun(db, {
    projectId: PROJECT,
    fileId: FILE,
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
    ...(spanAllowance === undefined ? {} : { spanAllowance }),
  })
  if (created.status !== "ok") throw new Error(`run not created: ${created.status}`)
  return created.run
}

/** Drive the run the way the route's loop does, with a hard cap so a gate
 *  regression fails as a wrong count rather than hanging the suite. */
async function drive(runId: string, maxWaves = 20): Promise<number> {
  let waves = 0
  for (; waves < maxWaves; waves++) {
    const result = await runOneTick({ db, runId, llm: llm() })
    if (!result.continueRun) break
  }
  return waves + 1
}

// ── The default: one passage, then ask ──────────────────────────────────────

describe("default span allowance", () => {
  it("drafts exactly one passage on a fresh run, then parks awaiting input", async () => {
    await seedSixSpans()
    const run = await startRun()
    expect(run.spanAllowance).toBe(DEFAULT_SPAN_ALLOWANCE)

    await drive(run.id)

    const after = await getRun(db, run.id)
    expect(after?.status).toBe("parked")
    // The whole point: "waiting for you", never "all done". There are five
    // spans left, and the UI must be able to say so.
    expect(after?.parkReason).toBe("awaiting_input")
    expect(after?.doneSpans).toBe(1)
    expect(after?.spanCursor?.nextIndex).toBe(1)
    expect(after?.totalSpans).toBe(6)
    expect(after?.spanAllowance).toBe(0)
    expect(draftCalls).toBe(1)
  })

  it("caps the WAVE, not just the loop — one span of budget cannot buy six", async () => {
    await seedSixSpans()
    // Concurrency is explicitly wide. Without the budget capping wave WIDTH,
    // the first wave alone would draft six passages and only then notice it
    // had a budget of one — which is the original bug, one wave later.
    const run = await startRun(1)
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 6 })

    expect(draftCalls).toBe(1)
    expect((await getRun(db, run.id))?.doneSpans).toBe(1)
  })

  it("spends nothing once the budget is gone — the gate holds before the model call", async () => {
    await seedSixSpans()
    const run = await startRun(1)
    await drive(run.id)
    const spentOnFirstPass = draftCalls
    expect(spentOnFirstPass).toBe(1)

    // Force it back to running with an empty budget, the shape a stray resume
    // or the stranded-run sweeper produces.
    const resumed = await resumeRun(db, run.id)
    expect(resumed.status).toBe("ok")
    const result = await runOneTick({ db, runId: run.id, llm: llm() })

    expect(result.continueRun).toBe(false)
    expect(draftCalls).toBe(spentOnFirstPass) // not one token more
    const after = await getRun(db, run.id)
    expect(after?.status).toBe("parked")
    expect(after?.parkReason).toBe("awaiting_input")
  })
})

// ── Decrement ───────────────────────────────────────────────────────────────

describe("allowance decrement", () => {
  it("debits one span per processed span and stops exactly on empty", async () => {
    await seedSixSpans()
    const run = await startRun(3)

    // Serial waves so each tick's debit is individually observable.
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })
    expect((await getRun(db, run.id))?.spanAllowance).toBe(2)
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })
    expect((await getRun(db, run.id))?.spanAllowance).toBe(1)
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })

    const after = await getRun(db, run.id)
    expect(after?.spanAllowance).toBe(0)
    expect(after?.doneSpans).toBe(3)
    expect(after?.status).toBe("parked")
    expect(after?.parkReason).toBe("awaiting_input")
    // Three spans of budget bought three passages — no more, and no fewer.
    expect(draftCalls).toBe(3)
  })

  it("never drives the budget negative, so a replayed wave cannot wrap the gate", async () => {
    const run = await startRun(1)
    const cursor = { seeds: [], nextIndex: 0 }
    await recordWaveOutcome(db, run.id, {
      cursor,
      doneCount: 0,
      failedCount: 0,
      unitsUsed: 0,
      callsUsed: 0,
      spansProcessed: 5,
    })
    // Floored at 0. A negative allowance would pass `<= 0` today, but any
    // future `=== 0` check would silently let an over-debited run run forever.
    expect((await getRun(db, run.id))?.spanAllowance).toBe(0)
  })

  it("leaves an unlimited run unlimited no matter how much it processes", async () => {
    const run = await startRun(null)
    await recordWaveOutcome(db, run.id, {
      cursor: { seeds: [], nextIndex: 0 },
      doneCount: 4,
      failedCount: 1,
      unitsUsed: 0,
      callsUsed: 0,
    })
    expect((await getRun(db, run.id))?.spanAllowance).toBeNull()
  })
})

// ── An open question outranks the budget ────────────────────────────────────

describe("open decisions park the run", () => {
  it("parks at the next span edge with budget still in hand", async () => {
    await seedSixSpans()
    const run = await startRun(5)
    await raiseDecision(db, {
      projectId: PROJECT,
      runId: run.id,
      fileId: FILE,
      reason: "Is 'brother' kinship or fellowship here?",
    })

    const result = await runOneTick({ db, runId: run.id, llm: llm() })

    expect(result.continueRun).toBe(false)
    const after = await getRun(db, run.id)
    expect(after?.status).toBe("parked")
    expect(after?.parkReason).toBe("awaiting_input")
    // Budget untouched — it parked on the question, not on the budget, and the
    // user must not be charged a span for a passage that never ran.
    expect(after?.spanAllowance).toBe(5)
    expect(draftCalls).toBe(0)
  })

  it("parks an UNLIMITED run too — 'translate everything' is not 'ignore me'", async () => {
    await seedSixSpans()
    const run = await startRun(null)
    await raiseDecision(db, {
      projectId: PROJECT,
      runId: run.id,
      fileId: FILE,
      reason: "Which register for the narrator?",
    })

    await runOneTick({ db, runId: run.id, llm: llm() })

    const after = await getRun(db, run.id)
    expect(after?.status).toBe("parked")
    expect(after?.parkReason).toBe("awaiting_input")
    expect(after?.spanAllowance).toBeNull()
    expect(draftCalls).toBe(0)
  })

  it("ignores another run's open question — one file must not halt the fan-out", async () => {
    await seedSixSpans()
    const mine = await startRun(1)
    const otherRunId = "run-belonging-to-another-file"
    await raiseDecision(db, {
      projectId: PROJECT,
      runId: otherRunId,
      fileId: "some-other-file",
      reason: "Unrelated question on a different file",
    })

    await runOneTick({ db, runId: mine.id, llm: llm() })

    // Project-scoped gating here would deadlock a project-wide start: every
    // file would stop on the first question raised by any other file.
    expect(draftCalls).toBe(1)
    expect((await getRun(db, mine.id))?.doneSpans).toBe(1)
  })
})

// ── Unlimited ───────────────────────────────────────────────────────────────

describe("unlimited allowance", () => {
  it("runs the scope to exhaustion and parks 'work_exhausted', not 'awaiting_input'", async () => {
    await seedSixSpans()
    const run = await startRun(null)

    await drive(run.id)

    const after = await getRun(db, run.id)
    expect(after?.status).toBe("parked")
    // Genuinely finished. Offering "Continue" here would be nonsense, so the
    // reason has to distinguish it from the trust-gate park above.
    expect(after?.parkReason).toBe("work_exhausted")
    expect(after?.doneSpans).toBe(6)
    expect(after?.spanCursor?.nextIndex).toBe(6)
  })

  it("is what a run created before the allowance shipped carries", async () => {
    // Rows written by the previous deploy have span_allowance NULL. Reading
    // that as "budget spent" would park every live run on the deploy that
    // added the column — a silent outage dressed up as a feature.
    const run = await startRun(null)
    expect(run.spanAllowance).toBeNull()
    await seedSixSpans()
    await drive(run.id)
    expect((await getRun(db, run.id))?.doneSpans).toBe(6)
  })
})

// ── Grants ──────────────────────────────────────────────────────────────────

describe("grantSpanAllowance", () => {
  it("caps incidental input — reviewing a backlog is not consent to run on", async () => {
    const run = await startRun(0)
    for (let i = 0; i < 10; i++) {
      await grantSpanAllowance(db, run.id, { spans: INPUT_GRANT_SPANS, cap: INPUT_GRANT_CAP })
    }
    expect((await getRun(db, run.id))?.spanAllowance).toBe(INPUT_GRANT_CAP)
  })

  it("never lowers an allowance already above the cap", async () => {
    // A Continue batch (4) outruns the incidental cap (3). A review landing
    // afterwards must not claw the batch back down to the cap.
    const run = await startRun(CONTINUE_BATCH_SPANS)
    await grantSpanAllowance(db, run.id, { spans: INPUT_GRANT_SPANS, cap: INPUT_GRANT_CAP })
    expect((await getRun(db, run.id))?.spanAllowance).toBe(CONTINUE_BATCH_SPANS)
  })

  it("grants the full batch uncapped for an explicit Continue", async () => {
    const run = await startRun(0)
    await grantSpanAllowance(db, run.id, { spans: CONTINUE_BATCH_SPANS })
    expect((await getRun(db, run.id))?.spanAllowance).toBe(CONTINUE_BATCH_SPANS)
  })

  it("cannot narrow an unlimited run back to a budget", async () => {
    const run = await startRun(null)
    await grantSpanAllowance(db, run.id, { spans: INPUT_GRANT_SPANS, cap: INPUT_GRANT_CAP })
    expect((await getRun(db, run.id))?.spanAllowance).toBeNull()
  })

  it("lifts the budget for 'translate everything'", async () => {
    const run = await startRun(1)
    await grantSpanAllowance(db, run.id, { spans: 0, unlimited: true })
    expect((await getRun(db, run.id))?.spanAllowance).toBeNull()
  })

  it("buys exactly one more passage, then parks again", async () => {
    await seedSixSpans()
    const run = await startRun()
    await drive(run.id)
    expect(draftCalls).toBe(1)

    // The shape every input path produces: grant one, wake, tick.
    await grantSpanAllowance(db, run.id, { spans: INPUT_GRANT_SPANS, cap: INPUT_GRANT_CAP })
    await resumeRun(db, run.id)
    await drive(run.id)

    expect(draftCalls).toBe(2)
    const after = await getRun(db, run.id)
    expect(after?.doneSpans).toBe(2)
    expect(after?.status).toBe("parked")
    expect(after?.parkReason).toBe("awaiting_input")
  })
})

// ── Park reason is owned by the status write ────────────────────────────────

describe("park reason", () => {
  it("clears on every return to running, so a stale reason cannot outlive the park", async () => {
    const run = await startRun(1)
    await parkRun(db, run.id, "awaiting_input")
    expect((await getRun(db, run.id))?.parkReason).toBe("awaiting_input")

    await resumeRun(db, run.id)

    // A resumed run showing "waiting for you" is how a live run gets reported
    // as stuck, and how a user learns to distrust the state entirely.
    expect((await getRun(db, run.id))?.parkReason).toBeNull()
  })

  it("defaults to work_exhausted so a caller cannot accidentally cry for help", async () => {
    const run = await startRun(1)
    await parkRun(db, run.id)
    expect((await getRun(db, run.id))?.parkReason).toBe("work_exhausted")
  })
})
