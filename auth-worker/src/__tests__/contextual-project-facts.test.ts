// AQU-1691 — durable decision facts.
//
// THE BUG THIS FIXES: answering a decision appended steering text
// ("Decision: … / Human answer: …") that autopilot consumes after ONE wave. So
// "Andrew is Peter's younger brother" reached at most one wave of the run that
// asked, and never a later wave, another run, or another file.
//
// WHY these tests:
//   - durability: the answer must reach the next wave of the same run, a
//     different run, and a different file — while the steering copy is still
//     consumed after one wave, exactly as before;
//   - transaction: the fact and the resolution commit together; a failure
//     after the fact is written must leave neither;
//   - parking: a fact question is raised with no run, so it never stops
//     autopilot (the trust gate parks only on a run's own question);
//   - supersession: a newer question for the same key closes the older one,
//     so nobody answers the same fact twice;
//   - profile keys: an answer for a Language-profile slot updates the profile
//     itself, keeps slots this version does not know, and is refused (rolled
//     back) when the slot cannot hold it.
//
// The LLM path is the real one (makeLlmCall → scripts/mock-openrouter.ts), as
// in contextual-tick.test.ts, so the assertions read the actual prompts.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { blockRunOnDecision, createRun, getRun } from "../../../db/shared/contextual-runs"
import { getDecision, raiseDecision } from "../../../db/shared/contextual-decisions"
import { resolveBlockingDecision } from "../../../db/shared/contextual-decision-lifecycle"
import { readSettingsBlob } from "../../../db/shared/project-facts-write"
import { raiseFactQuestion } from "../lib/contextual/fact-questions"
import { makeLlmCall, runOneTick } from "../lib/contextual/tick"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
import type { AquillaDb } from "../../../db/shim/postgres"

const db = env.AQUILLA_PG
const PROJECT = "proj-facts"
const FILE_A = "file-mrk"
const FILE_B = "file-luk"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"
const KIN_KEY = "kin.andrew-peter.relative-age"
const KIN_LINE = `${KIN_KEY} = "younger"`

let draftPrompts: string[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  draftPrompts = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== MOCK_URL) throw new Error(`unexpected fetch: ${String(input)}`)
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    if (system.includes("[[ctx:draft]]")) draftPrompts.push(system)
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
  makeLlmCall({ url: MOCK_URL, apiKey: "mock", models: { fast: "mock/fast", mid: "mock/mid", deep: "mock/deep" } })

async function seedCell(fileId: string, cellId: string, ref: string, source: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
    .bind(PROJECT, fileId, cellId, source, ref, `ev-src-${cellId}`)
    .run()
}

/** File A: two chapters, so two spans and two waves. File B: a different file and book. */
async function seedFiles(): Promise<void> {
  await seedCell(FILE_A, "a1", "MRK 1:16", "Simon and Andrew his brother were casting a net")
  await seedCell(FILE_A, "a2", "MRK 1:17", "Come after me")
  await seedCell(FILE_A, "a3", "MRK 2:1", "Some days later he returned")
  await seedCell(FILE_A, "a4", "MRK 2:2", "and many gathered")
  await seedCell(FILE_B, "b1", "LUK 6:14", "Simon, whom he also named Peter, and Andrew his brother")
}

async function startRun(fileId: string) {
  const created = await createRun(db, {
    projectId: PROJECT,
    fileId,
    targetLang: "",
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
    // Unlimited: these cases are about what each wave READS, not the budget.
    spanAllowance: null,
  })
  if (created.status !== "ok") throw new Error("run not created")
  return created.run
}

/** Today's path: a question the run raised, the run waiting on it. Now it names a fact key. */
async function blockOnKinQuestion(runId: string) {
  const decision = await raiseDecision(db, {
    projectId: PROJECT,
    runId,
    fileId: FILE_A,
    cellIds: ["a1"],
    reason: "Is Andrew older or younger than Peter? Kin terms here must say.",
    readinessItem: "bible-fact",
    factKey: KIN_KEY,
    options: [{ value: "younger" }, { value: "older" }],
  })
  const blocked = await blockRunOnDecision(db, runId, decision.id)
  if (blocked.status !== "ok") throw new Error("run did not block")
  return decision
}

const answerKin = (decisionId: string, on: AquillaDb = db) =>
  resolveBlockingDecision(on, {
    decisionId,
    action: "answer",
    answer: "younger",
    byUserId: 7,
    byUsername: "reviewer",
  })

describe("durability: an answer outlives the wave that asked", () => {
  it("reaches the next wave of run A, a different run, and a different file — the steering copy still lasts one wave", async () => {
    await seedFiles()
    const runA = await startRun(FILE_A)
    const decision = await blockOnKinQuestion(runA.id)

    const resolved = await answerKin(decision.id)
    expect(resolved).toMatchObject({ status: "ok", fact: { kind: "fact" }, run: { status: "running" } })

    // Wave 1 of run A: the fact, and (unchanged) the one-wave steering copy.
    await runOneTick({ db, runId: runA.id, llm: llm(), concurrency: 1 })
    expect(draftPrompts).toHaveLength(1)
    expect(draftPrompts[0]).toContain("Project decisions — HARD constraints")
    expect(draftPrompts[0]).toContain(KIN_LINE)
    expect(draftPrompts[0]).toContain("Human answer: younger")

    // Wave 2 of run A: the steering is consumed; the fact is still there.
    await runOneTick({ db, runId: runA.id, llm: llm(), concurrency: 1 })
    expect(draftPrompts).toHaveLength(2)
    expect(draftPrompts[1]).not.toContain("Human answer: younger")
    expect(draftPrompts[1]).toContain(KIN_LINE)

    // Run B, in a different file: it never saw the question, and still gets the answer.
    const runB = await startRun(FILE_B)
    await runOneTick({ db, runId: runB.id, llm: llm(), concurrency: 1 })
    expect(draftPrompts).toHaveLength(3)
    expect(draftPrompts[2]).toContain(KIN_LINE)
  })
})

/** The real handle, except that preparing SQL that matches `pattern` throws. */
function failingOn(pattern: RegExp): AquillaDb {
  const wrap = (inner: AquillaDb): AquillaDb => ({
    prepare: (sql) => {
      if (pattern.test(sql)) throw new Error("injected failure")
      return inner.prepare(sql)
    },
    batch: (stmts) => inner.batch(stmts),
    exec: (query) => inner.exec(query),
    close: () => inner.close(),
    transaction: (fn) => {
      if (!inner.transaction) throw new Error("test handle has no transaction()")
      return inner.transaction((tx) => fn(wrap(tx)))
    },
  })
  return wrap(db)
}

describe("transaction: the fact and the resolution commit together", () => {
  it("writes no fact and keeps the card open when the transaction fails after the fact is written", async () => {
    await seedFiles()
    const run = await startRun(FILE_A)
    const decision = await blockOnKinQuestion(run.id)

    // The steering insert runs AFTER the fact write in the same transaction.
    await expect(answerKin(decision.id, failingOn(/INSERT INTO contextual_steering/))).rejects.toThrow(
      "injected failure",
    )

    expect((await getDecision(db, decision.id))?.status).toBe("open")
    expect((await getRun(db, run.id))?.status).toBe("waiting")
    expect((await readSettingsBlob(db, PROJECT)).projectFacts).toBeUndefined()

    // The same answer then commits whole.
    expect((await answerKin(decision.id)).status).toBe("ok")
    expect((await readSettingsBlob(db, PROJECT)).projectFacts).toMatchObject([
      { key: KIN_KEY, value: "younger", author: "reviewer", sourceDecisionId: decision.id },
    ])
  })
})

describe("parking: a fact question never stops autopilot", () => {
  it("keeps a run drafting while its fact question waits, because the question has no run", async () => {
    await seedFiles()
    const run = await startRun(FILE_A)
    const raised = await raiseFactQuestion(db, {
      projectId: PROJECT,
      factKey: KIN_KEY,
      reason: "Is Andrew older or younger than Peter?",
      fileId: FILE_A,
      cellIds: ["a1"],
      options: [{ value: "younger" }, { value: "older" }],
    })
    expect(raised).toMatchObject({ status: "raised", decision: { runId: null, readinessItem: "bible-fact" } })

    const tick = await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })
    expect(tick).toMatchObject({ continueRun: true, status: "running" })
    expect(draftPrompts).toHaveLength(1)
    if (raised.status !== "raised") throw new Error("not raised")
    expect((await getDecision(db, raised.decision.id))?.status).toBe("open")
  })
})

describe("supersession: one open question per fact", () => {
  const ask = (reason: string, factKey = KIN_KEY) =>
    raiseFactQuestion(db, { projectId: PROJECT, factKey, reason, options: [{ value: "younger" }, { value: "older" }] })

  it("closes the older open question for the same key, and only that one", async () => {
    const first = await ask("Is Andrew older than Peter?")
    const other = await ask("How is 'the Twelve' rendered?", "render.the-twelve")
    const second = await ask("Andrew or Peter: who is older? (asked again with context)")
    if (first.status !== "raised" || second.status !== "raised" || other.status !== "raised") throw new Error("not raised")
    expect(second.superseded).toBe(1)
    expect((await getDecision(db, first.decision.id))?.status).toBe("superseded")
    expect((await getDecision(db, second.decision.id))?.status).toBe("open")
    expect((await getDecision(db, other.decision.id))?.status).toBe("open")
  })

  it("does not ask again once the key is decided", async () => {
    const asked = await ask("Is Andrew older than Peter?")
    if (asked.status !== "raised") throw new Error("not raised")
    await resolveBlockingDecision(db, {
      decisionId: asked.decision.id,
      action: "answer",
      answer: "younger",
      byUserId: 7,
      byUsername: "reviewer",
    })
    expect(await ask("Is Andrew older than Peter?")).toEqual({ status: "already_decided" })
  })

  it("refuses an option the fact could not store", async () => {
    expect(
      await raiseFactQuestion(db, {
        projectId: PROJECT,
        factKey: "measures",
        reason: "How should measures be rendered?",
        options: [{ value: "convert" }, { value: "metric" }],
      }),
    ).toEqual({ status: "invalid", reason: "option-not-storable" })
  })
})

describe("a key that names a Language-profile slot", () => {
  async function seedSettings(settings: Record<string, unknown>) {
    await db
      .prepare(`INSERT INTO project_settings (project_id, settings, version) VALUES (?, ?, 3)`)
      .bind(PROJECT, JSON.stringify(settings))
      .run()
  }

  it("updates the profile, keeps slots this version does not know, and leaves the decision log alone", async () => {
    await seedSettings({ targetLanguage: "fr", languageProfile: { futureSlot: { kept: true }, headings: "none" } })
    const raised = await raiseFactQuestion(db, {
      projectId: PROJECT,
      factKey: "divineNames.yhwh",
      reason: "How is the divine name YHWH rendered?",
      options: [{ value: "the LORD" }, { value: "Yahweh" }],
    })
    if (raised.status !== "raised") throw new Error("not raised")
    const resolved = await resolveBlockingDecision(db, {
      decisionId: raised.decision.id,
      action: "answer",
      answer: "the LORD",
      byUserId: 9,
      byUsername: "maintainer",
    })
    expect(resolved).toMatchObject({ status: "ok", fact: { kind: "profile", settingsVersion: 4 } })
    const settings = await readSettingsBlob(db, PROJECT)
    expect(settings.languageProfile).toEqual({
      futureSlot: { kept: true },
      headings: "none",
      divineNames: { yhwh: "the LORD" },
    })
    expect(settings.projectFacts).toBeUndefined()
    expect(settings.targetLanguage).toBe("fr")
  })

  it("rolls back and reports a reason code when the slot cannot hold the answer", async () => {
    await seedSettings({ languageProfile: { headings: "none" } })
    const decision = await raiseDecision(db, {
      projectId: PROJECT,
      runId: null,
      fileId: null,
      reason: "How should measures be rendered?",
      readinessItem: "bible-fact",
      factKey: "measures",
    })
    const resolved = await resolveBlockingDecision(db, {
      decisionId: decision.id,
      action: "answer",
      answer: "metric",
      byUserId: 9,
      byUsername: "maintainer",
    })
    expect(resolved).toEqual({ status: "invalid_answer", reason: "profile-value-invalid" })
    expect((await getDecision(db, decision.id))?.status).toBe("open")
    expect((await readSettingsBlob(db, PROJECT)).languageProfile).toEqual({ headings: "none" })
  })
})
