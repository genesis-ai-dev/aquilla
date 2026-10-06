// AQU-1690: autopilot with Bible data, through the REAL tick, the REAL flag
// reader (project_settings generated columns) and the REAL pack loader, with
// fetch stubbed for the mock OpenRouter and for the pack host.
//
// WHY: Bible data is an aid, never a dependency. A pack that is unreachable,
// missing, or still an HTML page on the live site must leave the run drafting
// as before, with the reason on record; a pack that loads must put the facts
// in the prompts.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRun, getRun, listContextualRunEvents, listDrafts, setSpanCursor, terminateRun } from "../../../db/shared/contextual-runs"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import { JHN4_PEOPLE, JHN4_TEXT } from "../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import { runOneTick, makeLlmCall } from "../lib/contextual/tick"
import { makeBibleTickDeps } from "../lib/contextual/bible-deps"
import { __resetBkpServerMemory } from "../lib/bkp/pack-loader"
import { JHN4_SOURCES } from "../lib/contextual/bible-test-helpers"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
import { listRunTraces, makeTraceRecorder } from "../lib/contextual/traces"
import { decodeBibleParams } from "../../../db/shared/bible-checks/params"
import { seedUser } from "./helpers/db"

const db = env.AQUILLA_PG
const PROJECT = "33333333-3333-4333-8333-333333333333"
const FILE = "file-jhn"
const MOCK_URL = "http://mock.local/api/v1/chat/completions"
const PACK = "https://packs.test/bkp/v1"

interface Captured {
  system: string
  user: string
}

let captured: Captured[] = []
let packFiles: Record<string, () => Response> = {}
let jevCalls: { questions: Record<string, unknown> }[] = []
/** What the stubbed Jev answers to every question: p(yes). */
let jevP = 0.9
const realFetch = globalThis.fetch

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
const html = () => new Response("<!doctype html><title>Bible</title>", { headers: { "content-type": "text/html" } })

function goodPack(): Record<string, () => Response> {
  return {
    "/manifest.json": () =>
      json({
        pack: "bkp",
        version: "1.0.0",
        builtAt: "2026-10-06T00:00:00Z",
        versification: "org",
        sources: [],
        layers: {},
        books: { JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
      }),
    "/voices/JHN.json": () => json(JHN4_VOICES),
    "/structure/JHN.json": () => json({ ...JHN4_STRUCTURE, segments: [], moves: [] }),
    "/people/JHN.json": () => json(JHN4_PEOPLE),
    "/text/JHN.json": () => json(JHN4_TEXT),
  }
}

beforeEach(async () => {
  captured = []
  jevCalls = []
  jevP = 0.9
  packFiles = goodPack()
  __resetBkpServerMemory()
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(PACK)) {
      const file = packFiles[url.slice(PACK.length)]
      return file ? file() : new Response("not found", { status: 404 })
    }
    if (url.endsWith("/alpha/decisions")) {
      const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
      jevCalls.push(request)
      const answers = Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: jevP }]))
      return json({ model: "jev-1.13.0", answers, usage: { input_tokens: 40, output_tokens: 3 } })
    }
    if (url !== MOCK_URL) throw new Error(`unexpected fetch: ${url}`)
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    captured.push({
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    })
    return json(scriptMockResponse(body.messages))
  })
  await seedProject({ bibleResourcesEnabled: true, bibleEnrichments: { autopilot: true, checks: true } })
})

afterEach(() => {
  vi.stubGlobal("fetch", realFetch)
})

async function seedProject(settings: Record<string, unknown>): Promise<void> {
  await seedUser(1, "owner_bible")
  await db.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`).bind(PROJECT).run()
  await db
    .prepare(`INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`)
    .bind(PROJECT, JSON.stringify(settings))
    .run()
  for (const [ref, source] of Object.entries(JHN4_SOURCES)) {
    const cellId = `c${ref.split(":")[1]}`
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
         VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
      )
      .bind(PROJECT, FILE, cellId, source, ref, `ev-src-${cellId}`)
      .run()
  }
}

async function tickOnce(opts: { withTraces?: boolean } = {}) {
  const created = await createRun(db, {
    projectId: PROJECT,
    fileId: FILE,
    targetLang: "",
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 600 },
    spanAllowance: null,
  })
  if (created.status !== "ok") throw new Error("run not created")
  const llm = makeLlmCall({ url: MOCK_URL, apiKey: "mock", models: { fast: "m/f", mid: "m/m", deep: "m/d" } })
  const traces = opts.withTraces ? makeTraceRecorder({}, db, { runId: created.run.id, projectId: PROJECT }) : undefined
  const bible = makeBibleTickDeps(
    { ...env, BKP_BASE: PACK, OPENROUTER_API_KEY: "test-key" },
    db,
    { projectId: PROJECT, runId: created.run.id },
    traces ? { traces } : {},
  )
  await runOneTick({ db, runId: created.run.id, llm, bible })
  await traces?.flush()
  return created.run.id
}

/** English quotation and question rules, so the bkp: gates and M1 run. */
const ENGLISH_PROFILE = {
  quoteMarks: { levels: [{ open: "\u201c", close: "\u201d" }, { open: "\u2018", close: "\u2019" }], continuation: "reopen-each-paragraph" },
  questionMarkers: {},
}

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await db
    .prepare(`UPDATE project_settings SET settings = ? WHERE project_id = ?`)
    .bind(JSON.stringify({ bibleResourcesEnabled: true, bibleEnrichments: { autopilot: true, checks: true }, ...settings }), PROJECT)
    .run()
}

async function spanReasons(runId: string): Promise<string[]> {
  const { events } = await listContextualRunEvents(db, { projectId: PROJECT, runId })
  return events.filter((e) => e.kind === "span_outcome").flatMap((e) => e.details.reasons ?? [])
}

describe("autopilot with Bible data unavailable", () => {
  it("an HTML page where the pack should be: drafts as before, and records bible_data_invalid", async () => {
    packFiles["/manifest.json"] = html
    const runId = await tickOnce()
    expect((await listDrafts(db, PROJECT, FILE, "proposed", "")).length).toBeGreaterThan(0)
    expect(await spanReasons(runId)).toContain("bible_data_invalid")
    expect(captured.some((call) => call.user.includes("Given facts"))).toBe(false)
  })

  it("a book the pack does not have (404): drafts as before, and records bible_data_not_found", async () => {
    delete packFiles["/voices/JHN.json"]
    const runId = await tickOnce()
    expect((await listDrafts(db, PROJECT, FILE, "proposed", "")).length).toBeGreaterThan(0)
    expect(await spanReasons(runId)).toContain("bible_data_not_found")
  })
})

describe("autopilot with Bible data", () => {
  it("gives construe and the drafter each cell's speakers as given facts", async () => {
    const runId = await tickOnce()
    const construe = captured.find((call) => call.system.includes("[[ctx:construe]]"))
    expect(construe?.user).toContain("Given facts: speech Jesus → Samaritan woman")
    expect(await spanReasons(runId)).not.toContain("bible_data_invalid")
  })

  it("loads nothing while the autopilot enrichment is off", async () => {
    await db
      .prepare(`UPDATE project_settings SET settings = ? WHERE project_id = ?`)
      .bind(JSON.stringify({ bibleResourcesEnabled: true, bibleEnrichments: { autopilot: false } }), PROJECT)
      .run()
    await tickOnce()
    expect(captured.some((call) => call.user.includes("Given facts"))).toBe(false)
  })
})

describe("Jev questions, traced", () => {
  it("records the span's one Jev call as a bible-qa trace, with each shadow answer and its certainty", async () => {
    // No negators in the profile: code cannot see the negation in JHN 4:9, so Jev is asked.
    await setSettings({ languageProfile: ENGLISH_PROFILE })
    jevP = 0.1
    const runId = await tickOnce({ withTraces: true })
    expect(jevCalls).toHaveLength(1)
    const all = await listRunTraces(db, { projectId: PROJECT, runId, includeJev: true })
    const jev = all.traces.filter((trace) => trace.label === "jev:bible-qa")
    expect(jev).toHaveLength(1)
    expect(jev[0]).toMatchObject({ tier: "jev", model: "typesafe/jev-1.13", promptTokens: 40, completionTokens: 3 })
    const output = JSON.parse(jev[0].output ?? "{}") as { judgments: { check: string; outcome: string; mode: string; certainty: number }[] }
    expect(output.judgments).toContainEqual(expect.objectContaining({ check: "negation", outcome: "fail", mode: "shadow" }))
    // Shadow answers act on nothing: the draft is staged unredrafted, with no bkp:M3 finding.
    const drafts = await listDrafts(db, PROJECT, FILE, "proposed", "")
    expect(drafts.find((d) => d.cellId === "c9")?.verdicts ?? {}).not.toHaveProperty("bkp:M3")
    // Maintainers only: without includeJev the row is not listed.
    const viewer = await listRunTraces(db, { projectId: PROJECT, runId })
    expect(viewer.traces.some((trace) => trace.label === "jev:bible-qa")).toBe(false)
  })
})

describe("bounded repair, end to end", () => {
  it("stages a cell whose quotation is still wrong after its repair for a person, with its bkp: code and evidence", async () => {
    await setSettings({ languageProfile: ENGLISH_PROFILE })
    // The mock drafter echoes the source, so a source that closes the woman's
    // quotation AFTER the narrator's aside yields a draft that does too — on
    // the first attempt and on the repair.
    await db
      .prepare(`UPDATE cells SET value = ? WHERE project_id = ? AND cell_id = 'c9' AND side = 'source'`)
      .bind(
        "The Samaritan woman said to him, \u201cHow is it that you ask me for a drink? (For Jews have no dealings with Samaritans.)\u201d",
        PROJECT,
      )
      .run()
    await tickOnce()
    const drafts = captured.filter((call) => call.system.includes("[[ctx:draft]]"))
    // First draft, then ONE repair with the templated constraint — never a third.
    expect(drafts).toHaveLength(2)
    expect(drafts[1].user).toContain("Constraints from review (satisfy each): Close Samaritan woman's quotation")
    const c9 = (await listDrafts(db, PROJECT, FILE, "proposed", "")).find((d) => d.cellId === "c9")
    expect(c9?.verdicts?._triage).toBe("human")
    expect(decodeBibleParams(c9?.verdicts?.["bkp:V2"])).toMatchObject({ kind: "close-after-aside", startRef: "JHN 4:9" })
    expect(c9?.verdicts).toHaveProperty("redrafted")
  })
})

describe("fact questions for the Language profile", () => {
  async function factQuestionStatuses(factKey: string): Promise<{ status: string; run_id: string | null }[]> {
    const { results } = await db
      .prepare(`SELECT status, run_id FROM contextual_decisions WHERE project_id = ? AND fact_key = ? ORDER BY created_at, id`)
      .bind(PROJECT, factKey)
      .all<{ status: string; run_id: string | null }>()
    return results ?? []
  }

  /** One run, two waves (one span each), sharing the run's Bible deps as the driver does. */
  async function runTwoWaves(): Promise<string> {
    const created = await createRun(db, {
      projectId: PROJECT,
      fileId: FILE,
      targetLang: "",
      initiatedBy: "tester",
      roleSnapshot: { userId: 1, username: "tester", level: 600 },
      spanAllowance: null,
    })
    if (created.status !== "ok") throw new Error("run not created")
    const seed = (id: string, start: string, end: string) => ({
      id, fileId: FILE, anchorCellId: start, startCellId: start, endCellId: end, seedSource: "canonical-ref",
    })
    await setSpanCursor(db, created.run.id, { seeds: [seed("s1", "c7", "c8"), seed("s2", "c9", "c10")], nextIndex: 0 })
    const llm = makeLlmCall({ url: MOCK_URL, apiKey: "mock", models: { fast: "m/f", mid: "m/m", deep: "m/d" } })
    const bible = makeBibleTickDeps({ ...env, BKP_BASE: PACK }, db, { projectId: PROJECT, runId: created.run.id })
    // Never parked on the question: wave 1 goes on to wave 2, and wave 2
    // parks only because the work is done.
    expect((await runOneTick({ db, runId: created.run.id, llm, bible, concurrency: 1 })).continueRun).toBe(true)
    await runOneTick({ db, runId: created.run.id, llm, bible, concurrency: 1 })
    expect(await getRun(db, created.run.id)).toMatchObject({ status: "parked", parkReason: "work_exhausted" })
    return created.run.id
  }

  it("asks once per run when the profile has no quotation marks, without parking the run", async () => {
    await runTwoWaves()
    expect(await factQuestionStatuses("quoteMarks")).toEqual([{ status: "open", run_id: null }])
    expect((await listDrafts(db, PROJECT, FILE, "proposed", "")).map((d) => d.cellId).sort()).toEqual(["c10", "c7", "c8", "c9"])
  })

  it("a later run asks again and supersedes the open question, so one card stays open", async () => {
    // The first run is finished (a parked run still holds the file), then a new run starts.
    await terminateRun(db, await runTwoWaves())
    await db.prepare(`DELETE FROM contextual_drafts WHERE project_id = ?`).bind(PROJECT).run()
    await runTwoWaves()
    expect(await factQuestionStatuses("quoteMarks")).toEqual([
      { status: "superseded", run_id: null },
      { status: "open", run_id: null },
    ])
  })

  it("asks nothing once the profile has the slot", async () => {
    await setSettings({ languageProfile: ENGLISH_PROFILE })
    await runTwoWaves()
    expect(await factQuestionStatuses("quoteMarks")).toEqual([])
    expect(await factQuestionStatuses("questionMarkers")).toEqual([])
  })
})
