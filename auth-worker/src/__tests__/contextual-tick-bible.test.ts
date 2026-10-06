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
import { createRun, listContextualRunEvents, listDrafts } from "../../../db/shared/contextual-runs"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import { JHN4_PEOPLE, JHN4_TEXT } from "../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import { runOneTick, makeLlmCall } from "../lib/contextual/tick"
import { makeBibleTickDeps } from "../lib/contextual/bible-deps"
import { __resetBkpServerMemory } from "../lib/bkp/pack-loader"
import { JHN4_SOURCES } from "../lib/contextual/bible-test-helpers"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"
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
  packFiles = goodPack()
  __resetBkpServerMemory()
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(PACK)) {
      const file = packFiles[url.slice(PACK.length)]
      return file ? file() : new Response("not found", { status: 404 })
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

async function tickOnce() {
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
  const bible = makeBibleTickDeps({ ...env, BKP_BASE: PACK }, db, { projectId: PROJECT })
  await runOneTick({ db, runId: created.run.id, llm, bible })
  return created.run.id
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
