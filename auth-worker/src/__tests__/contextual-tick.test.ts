// Tick executor (lib/contextual/tick.ts, design §8 slice D1). WHY: the tick
// is the durable engine's whole contract — every test here pins a resumability
// or control guarantee: seeds derived once and pinned, exactly one span per
// tick, pause honoured at the span edge (never lost, never mid-span), steering
// consumed exactly once and actually injected into prompts, refresh_span
// re-enqueueing without disturbing the cursor position, and the run parking
// (not wedging in 'running') when spans run out.
//
// The LLM path is the REAL one: makeLlmCall → global fetch (stubbed here for
// the mock OpenRouter URL) → scripts/mock-openrouter.ts scriptMockResponse,
// routed by the [[ctx:*]] prompt markers — so this suite also validates the
// mock ↔ node-parser contract the e2e stack depends on.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  createRun,
  getRun,
  requestPause,
  resumeRun,
  appendSteering,
  readUnconsumedSteering,
  listDrafts,
  listContextualRunEvents,
  setSpanCursor,
  recordWaveOutcome,
} from "../../../db/shared/contextual-runs"
import {
  listSceneBriefs,
  getSceneBrief,
  proposeSceneBrief,
  reviewSceneBrief,
} from "../../../db/shared/scene-briefs"
import { runOneTick, makeLlmCall, type ContextualProgressFrame } from "../lib/contextual/tick"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
import type { AquillaDb } from "../../../db/shim/postgres"

const db = env.AQUILLA_PG
const PROJECT = "proj-tick"
const FILE = "file-mrk"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"

// ── Fetch stub: the real mock-openrouter script answers the real makeLlmCall ─

interface CapturedCall {
  system: string
  user: string
  model: string
}

let captured: CapturedCall[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  captured = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url !== MOCK_URL) throw new Error(`unexpected fetch in tick test: ${url}`)
    const body = JSON.parse(String(init?.body)) as {
      model: string
      messages: { role: string; content: string }[]
    }
    captured.push({
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
      model: body.model,
    })
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

// ── Seeding: two chapters (MRK 1, MRK 2) → two derived spans ────────────────

async function seedCell(
  cellId: string,
  ref: string,
  source: string,
  target?: { text: string; validated?: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
    .bind(PROJECT, FILE, cellId, source, ref, `ev-src-${cellId}`)
    .run()
  if (target) {
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, source_event_id, last_edit_at, validated)
         VALUES (?, ?, ?, 'target', ?, ?, ?, ?, 0, ?)`,
      )
      .bind(PROJECT, FILE, cellId, target.text, ref, `ev-tgt-${cellId}`, `ev-src-${cellId}`, target.validated ? 1 : 0)
      .run()
  }
}

async function seedFile(): Promise<void> {
  // Chapter 1: c1 validated (an example pair), c2+c3 untranslated → span 1.
  await seedCell("c1", "MRK 1:1", "In the beginning", { text: "Al principio", validated: true })
  await seedCell("c2", "MRK 1:2", "was the word")
  await seedCell("c3", "MRK 1:3", "and the word was near")
  // Chapter 2: c4+c5 untranslated → span 2.
  await seedCell("c4", "MRK 2:1", "Some days later")
  await seedCell("c5", "MRK 2:2", "he returned home")
}

async function startRun(targetLang = "") {
  const created = await createRun(db, {
    projectId: PROJECT,
    fileId: FILE,
    targetLang,
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
  })
  if (created.status !== "ok") throw new Error("run not created")
  return created.run
}

describe("runOneTick", () => {
  it("stages a French run into the French review queue without leaking into the default lane", async () => {
    await seedFile()
    const run = await startRun("fr")
    const result = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(result.continueRun).toBe(true)

    const french = await listDrafts(db, PROJECT, FILE, "proposed", "fr")
    const def = await listDrafts(db, PROJECT, FILE, "proposed", "")
    expect(french.length).toBeGreaterThan(0)
    expect(french.every((draft) => draft.targetLang === "fr")).toBe(true)
    expect(def).toEqual([])
    expect(await getRun(db, run.id)).toMatchObject({
      status: "running",
      targetLang: "fr",
    })
  })

  it("injects only approved scene context from the run's target lane", async () => {
    await seedFile()
    const approveNeighbor = async (targetLang: string, summary: string) => {
      const proposed = await proposeSceneBrief(db, {
        projectId: PROJECT,
        fileId: FILE,
        startCellId: "c4",
        endCellId: "c5",
        targetLang,
        construal: summary,
        l1Summary: summary,
      })
      if (proposed.status !== "ok") throw new Error(proposed.message)
      const reviewed = await reviewSceneBrief(db, {
        id: proposed.brief.id,
        action: "approve",
        reviewedBy: "lead",
      })
      expect(reviewed.status).toBe("ok")
    }
    await approveNeighbor("", "DEFAULT_NEIGHBOR_ONLY")
    await approveNeighbor("fr", "FRENCH_NEIGHBOR_MUST_NOT_LEAK")

    const run = await startRun()
    const construePrompts: string[] = []
    let construeCalls = 0
    const laneCheckingLlm: ReturnType<typeof llm> = async (request) => {
      if (request.system.includes("[[ctx:construe]]")) {
        construeCalls += 1
        construePrompts.push(request.user)
        return JSON.stringify({
          situation: "A narrator addresses a reader.",
          participants: ["narrator", "reader"],
          tenor: "neutral",
          moves: ["relate"],
          closed: construeCalls > 1,
          openQuestions: construeCalls > 1 ? [] : ["Need adjacent scene context"],
          evidenceCellIds: ["c1", "c2", "c3"],
        })
      }
      const response = scriptMockResponse([
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ])
      return response.choices[0]?.message.content ?? ""
    }

    await runOneTick({ db, runId: run.id, llm: laneCheckingLlm, concurrency: 1 })

    expect(construePrompts.some((prompt) => prompt.includes("DEFAULT_NEIGHBOR_ONLY"))).toBe(true)
    expect(construePrompts.every((prompt) => !prompt.includes("FRENCH_NEIGHBOR_MUST_NOT_LEAK")))
      .toBe(true)
  })

  it("keeps translating when durable activity storage is temporarily unavailable", async () => {
    await seedFile()
    const run = await startRun()
    const telemetryDownDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("contextual_run_events")) throw new Error("activity table unavailable")
            return target.prepare(query)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as AquillaDb
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(runOneTick({ db: telemetryDownDb, runId: run.id, llm: llm() }))
        .resolves.toMatchObject({ continueRun: true, status: "running" })
    } finally {
      warn.mockRestore()
    }

    expect((await getRun(db, run.id))?.doneSpans).toBe(1)
    expect((await listDrafts(db, PROJECT, FILE, "proposed"))).toHaveLength(2)
  })

  it("keeps translating when the live collaborator relay is unavailable", async () => {
    await seedFile()
    const run = await startRun()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(runOneTick({
        db,
        runId: run.id,
        llm: llm(),
        notify: async () => { throw new Error("sync relay unavailable") },
      })).resolves.toMatchObject({ continueRun: true, status: "running" })
    } finally {
      warn.mockRestore()
    }

    expect((await getRun(db, run.id))?.doneSpans).toBe(1)
    expect((await listDrafts(db, PROJECT, FILE, "proposed"))).toHaveLength(2)
  })

  it("first tick derives seeds, processes exactly span 1, stages drafts + a scene brief, advances the cursor", async () => {
    await seedFile()
    const run = await startRun()
    const frames: ContextualProgressFrame[] = []

    const result = await runOneTick({
      db,
      runId: run.id,
      llm: llm(),
      notify: async (f) => {
        frames.push(f)
      },
    })

    expect(result.continueRun).toBe(true) // span 2 remains
    expect(result.status).toBe("running")

    const after = await getRun(db, run.id)
    expect(after?.spanCursor?.seeds).toHaveLength(2) // MRK 1 + MRK 2
    expect(after?.spanCursor?.nextIndex).toBe(1)
    expect(after?.totalSpans).toBe(2)
    expect(after?.doneSpans).toBe(1)
    expect(after?.failedSpans).toBe(0)
    expect(after?.unitsSpent).toBeGreaterThan(0)
    expect(after?.callsSpent).toBeGreaterThan(0)

    // A proposed scene brief landed, stamped with the run's provenance.
    const briefs = await listSceneBriefs(db, PROJECT, { fileId: FILE, status: "proposed" })
    expect(briefs).toHaveLength(1)
    expect(briefs[0].provenance?.runId).toBe(run.id)
    expect(briefs[0].startCellId).toBe("c1")
    expect(briefs[0].endCellId).toBe("c3")

    // Drafts staged for span 1's UNTRANSLATED cells only (c1 is validated).
    const drafts = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(drafts.map((d) => d.cellId).sort()).toEqual(["c2", "c3"])
    expect(drafts[0].text).toMatch(/^MOCK /)
    expect(drafts[0].sceneBriefId).toBe(briefs[0].id)
    expect(drafts[0].runId).toBe(run.id)

    // Progress frames: scene → span → run.state, with the design's shapes.
    const types = frames.map((f) => f.type)
    expect(types).toContain("contextual.scene")
    expect(types).toContain("contextual.span")
    expect(types).toContain("contextual.run.state")
    const span = frames.find((f) => f.type === "contextual.span")
    expect(span).toMatchObject({ runId: run.id, staged: 2, skipped: 0, spanLabel: "MRK 1:1–MRK 1:3" })

    // Second tick finishes span 2, then parks (spans exhausted).
    const second = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(second.continueRun).toBe(false)
    expect(second.status).toBe("parked")
    const done = await getRun(db, run.id)
    expect(done?.status).toBe("parked")
    expect(done?.doneSpans).toBe(2)
    expect((await listDrafts(db, PROJECT, FILE, "proposed")).map((d) => d.cellId).sort()).toEqual([
      "c2",
      "c3",
      "c4",
      "c5",
    ])
  })

  it("never publishes cropped draft text as a complete live suggestion", async () => {
    await seedFile()
    const run = await startRun()
    const frames: ContextualProgressFrame[] = []
    const baseLlm = llm()
    const longText = `LONG ${"x".repeat(2_100)}`

    await runOneTick({
      db,
      runId: run.id,
      llm: async (request) => {
        if (request.system.includes("[[ctx:draft]]")) {
          return JSON.stringify([
            { i: 1, t: longText },
            { i: 2, t: "SHORT COMPLETE DRAFT" },
          ])
        }
        return baseLlm(request)
      },
      notify: async (frame) => { frames.push(frame) },
    })

    const persisted = await listDrafts(db, PROJECT, FILE, "proposed")
    expect(persisted.find((draft) => draft.cellId === "c2")?.text).toBe(longText)

    const live = frames.find((frame) => frame.type === "contextual.drafts")
    expect(live).toMatchObject({
      type: "contextual.drafts",
      runId: run.id,
      targetLang: "",
      draftCount: 2,
      truncated: true,
    })
    if (!live || live.type !== "contextual.drafts") throw new Error("missing draft frame")
    expect(live.drafts).toEqual([
      expect.objectContaining({ cellId: "c3", text: "SHORT COMPLETE DRAFT" }),
    ])
    expect(live.drafts.some((draft) => draft.text === longText.slice(0, 2_000))).toBe(false)
  })

  it("steering directions are consumed exactly once and injected into the construe + draft prompts", async () => {
    await seedFile()
    const run = await startRun()
    await appendSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      kind: "direction",
      body: "Prefer short sentences throughout",
    })

    await runOneTick({ db, runId: run.id, llm: llm() })

    const construe = captured.find((c) => c.system.includes("[[ctx:construe]]"))
    const draft = captured.find((c) => c.system.includes("[[ctx:draft]]"))
    expect(construe?.system).toContain("Prefer short sentences throughout")
    expect(draft?.system).toContain("Prefer short sentences throughout")

    // Consumed: the next tick sees no unconsumed steering.
    expect(
      await readUnconsumedSteering(db, { projectId: PROJECT, fileId: FILE, runId: run.id }),
    ).toEqual([])
    const spent = captured.length
    await runOneTick({ db, runId: run.id, llm: llm() })
    const secondTick = captured.slice(spent)
    expect(secondTick.some((c) => c.system.includes("Prefer short sentences"))).toBe(false)
  })

  it("a direction sent to a span-exhausted run stays queued through the park (not swallowed)", async () => {
    // Regression (caught by the e2e steering journey): consuming directions at
    // tick start swallowed any direction sent to a fully-drafted run — the
    // park-only wake had no span to apply it to. Directions must survive until
    // a span actually runs.
    await seedFile()
    const run = await startRun()
    // Drain every span so the cursor exhausts and the run parks.
    for (let i = 0; i < 20; i++) {
      const r = await runOneTick({ db, runId: run.id, llm: llm() })
      if (!r.continueRun) break
    }
    await appendSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      kind: "direction",
      body: "Keep the tone formal in dialogue",
    })

    // Mirror the steering route: wake the parked run, then tick. The wake
    // tick parks again (no spans) — the direction must remain.
    const resumed = await resumeRun(db, run.id)
    expect(resumed.status).toBe("ok")
    const wake = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(wake.continueRun).toBe(false)
    const remaining = await readUnconsumedSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      runId: run.id,
    })
    expect(remaining.map((e) => e.body)).toEqual(["Keep the tone formal in dialogue"])
  })

  it("refresh_span marks the target brief stale and re-enqueues that span past the cursor", async () => {
    await seedFile()
    const run = await startRun()
    await runOneTick({ db, runId: run.id, llm: llm() })
    await runOneTick({ db, runId: run.id, llm: llm() }) // → parked, 2 briefs

    const [brief] = await listSceneBriefs(db, PROJECT, { fileId: FILE, status: "proposed" })
    expect(brief.staleSince).toBeNull()

    await appendSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      kind: "refresh_span",
      body: brief.id,
    })
    const resumed = await resumeRun(db, run.id) // parked → running (the route does this on steering)
    expect(resumed.status).toBe("ok")

    const result = await runOneTick({ db, runId: run.id, llm: llm() })
    // The brief is stale, its span re-enqueued and processed as span 3.
    const refreshed = (await listSceneBriefs(db, PROJECT, { fileId: FILE })).find((b) => b.id === brief.id)
    expect(refreshed?.staleSince).not.toBeNull()
    expect(refreshed?.staleReason).toBe("steering-refresh")

    const after = await getRun(db, run.id)
    expect(after?.spanCursor?.seeds).toHaveLength(3)
    expect(after?.spanCursor?.nextIndex).toBe(3)
    expect(after?.status).toBe("parked") // re-enqueued span was the last → parks again
    expect(result.continueRun).toBe(false)

    // The re-run superseded the span's old drafts (one live proposal per cell).
    const all = await listDrafts(db, PROJECT, FILE)
    const proposed = all.filter((d) => d.status === "proposed")
    const superseded = all.filter((d) => d.status === "superseded")
    expect(proposed.map((d) => d.cellId).sort()).toEqual(["c2", "c3", "c4", "c5"])
    expect(superseded.map((d) => d.cellId).sort()).toEqual(
      brief.startCellId === "c1" ? ["c2", "c3"] : ["c4", "c5"],
    )
  })

  it("does not refresh a scene brief from another file or target lane", async () => {
    await seedFile()
    const run = await startRun()
    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })

    const makeForeignBrief = async (fileId: string, targetLang: string) => {
      const proposed = await proposeSceneBrief(db, {
        projectId: PROJECT,
        fileId,
        startCellId: "c1",
        endCellId: "c3",
        targetLang,
        construal: `Foreign ${fileId}/${targetLang || "default"} scene.`,
        l1Summary: "Must not be injected or refreshed.",
      })
      if (proposed.status !== "ok") throw new Error(proposed.message)
      return proposed.brief
    }
    const otherFile = await makeForeignBrief("file-other", "")
    const otherLane = await makeForeignBrief(FILE, "fr")
    for (const brief of [otherFile, otherLane]) {
      await appendSteering(db, {
        projectId: PROJECT,
        fileId: FILE,
        runId: run.id,
        kind: "refresh_span",
        body: brief.id,
      })
    }

    await runOneTick({ db, runId: run.id, llm: llm(), concurrency: 1 })

    expect((await getSceneBrief(db, otherFile.id))?.staleSince).toBeNull()
    expect((await getSceneBrief(db, otherLane.id))?.staleSince).toBeNull()
    expect((await getRun(db, run.id))?.spanCursor?.seeds).toHaveLength(2)
    expect(await readUnconsumedSteering(db, {
      projectId: PROJECT,
      fileId: FILE,
      runId: run.id,
    })).toEqual([])
  })

  it("a pause requested mid-run stops continuation at the span edge; resume continues the cursor", async () => {
    await seedFile()
    const run = await startRun()

    const first = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(first.continueRun).toBe(true)

    // User pauses while the loop is between spans.
    await requestPause(db, run.id)
    const callsBefore = captured.length
    const second = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(second).toMatchObject({ continueRun: false, status: "paused" })
    expect(captured.length).toBe(callsBefore) // NO model calls while pausing
    expect((await getRun(db, run.id))?.status).toBe("paused")

    // A paused run's tick is a no-op too.
    const third = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(third).toMatchObject({ continueRun: false, status: "paused" })

    // Resume → the cursor picks up at span 2, not span 1.
    await resumeRun(db, run.id)
    const fourth = await runOneTick({ db, runId: run.id, llm: llm() })
    expect(fourth.status).toBe("parked")
    const after = await getRun(db, run.id)
    expect(after?.doneSpans).toBe(2)
    expect(after?.spanCursor?.nextIndex).toBe(2)
  })

  it("a pause requested during an in-flight wave converges to paused at that same edge", async () => {
    await seedFile()
    const run = await startRun()
    const baseLlm = llm()
    let releaseFirstCall: (() => void) | undefined
    let markFirstCallStarted: (() => void) | undefined
    const firstCallStarted = new Promise<void>((resolve) => { markFirstCallStarted = resolve })
    const firstCallRelease = new Promise<void>((resolve) => { releaseFirstCall = resolve })
    let callCount = 0
    const deferredLlm: typeof baseLlm = async (...args) => {
      callCount += 1
      if (callCount === 1) {
        markFirstCallStarted?.()
        await firstCallRelease
      }
      return baseLlm(...args)
    }
    const frames: ContextualProgressFrame[] = []

    const tick = runOneTick({
      db,
      runId: run.id,
      llm: deferredLlm,
      notify: async (frame) => { frames.push(frame) },
    })
    await firstCallStarted
    expect((await requestPause(db, run.id)).status).toBe("ok")
    releaseFirstCall?.()

    const result = await tick
    expect(result).toMatchObject({ continueRun: false, status: "paused" })
    expect((await getRun(db, run.id))?.status).toBe("paused")
    const liveStates = frames
      .filter((frame) => frame.type === "contextual.run.state")
      .map((frame) => frame.status)
    expect(liveStates.at(-1)).toBe("paused")
    const durable = await listContextualRunEvents(db, {
      projectId: PROJECT,
      runId: run.id,
    })
    expect(durable.events.filter((event) => event.kind === "run_state").at(-1)?.status).toBe("paused")
  })

  it("resume after a paused final failure restores terminal attention instead of idle", async () => {
    await seedFile()
    const run = await startRun()
    const cursor = {
      seeds: [{
        id: `${FILE}#failed`,
        fileId: FILE,
        anchorCellId: "c2",
        startCellId: "c2",
        endCellId: "c3",
        seedSource: "canonical-ref",
      }],
      nextIndex: 1,
    }
    await setSpanCursor(db, run.id, cursor)
    await recordWaveOutcome(db, run.id, {
      cursor,
      doneCount: 0,
      failedCount: 1,
      unitsUsed: 1,
      callsUsed: 1,
      lastError: "This passage could not produce a reviewable draft.",
    })
    expect((await requestPause(db, run.id)).status).toBe("ok")
    expect(await runOneTick({ db, runId: run.id, llm: llm() })).toMatchObject({ status: "paused" })
    expect((await resumeRun(db, run.id)).status).toBe("ok")

    let modelCalls = 0
    const resumed = await runOneTick({
      db,
      runId: run.id,
      llm: async () => {
        modelCalls++
        return "unused"
      },
    })
    expect(resumed).toMatchObject({ continueRun: false, status: "failed" })
    expect(modelCalls).toBe(0)
    expect(await getRun(db, run.id)).toMatchObject({
      status: "failed",
      failedSpans: 1,
      lastError: "This passage could not produce a reviewable draft.",
    })
  })

  it("an LLM failure records a failed span (cursor still advances; run keeps going)", async () => {
    await seedFile()
    const run = await startRun()
    const failing = makeLlmCall({
      url: "http://mock.local/other",
      apiKey: "mock",
      models: { fast: "m", mid: "m", deep: "m" },
    })
    // The stub throws for any URL but MOCK_URL → every model call fails →
    // construal cannot close → the span reports incomplete with zero staged.
    const result = await runOneTick({ db, runId: run.id, llm: failing })
    const after = await getRun(db, run.id)
    expect(after?.failedSpans).toBe(1)
    expect(after?.doneSpans).toBe(0)
    expect(after?.spanCursor?.nextIndex).toBe(1)
    expect(after?.lastError).toBeTruthy()
    expect(result.continueRun).toBe(true) // span 2 still gets its chance
  })
})
