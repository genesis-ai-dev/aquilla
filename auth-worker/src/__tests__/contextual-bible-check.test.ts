// AQU-1690 — "Check with Bible data" over TRANSLATED cells.
//
// WHY: autopilot only drafts empty cells, so nothing re-checked text people
// already wrote. Check mode does — and it must never touch that text: it
// reports findings (with their evidence) and raises the Language-profile
// questions the file needs. It spends Jev calls and shows shadow answers, so
// it is a maintainer's tool.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack"
import { JHN4_PEOPLE, JHN4_TEXT } from "../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import { __resetBkpServerMemory } from "../lib/bkp/pack-loader"
import { JHN4_QUESTIONS, JHN4_SOURCES } from "../lib/contextual/bible-test-helpers"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const db = env.AQUILLA_PG
const PACK = "https://packs.test/bkp/v1"
const FILE = "file-jhn-check"
const ASIDE_INSIDE =
  "The Samaritan woman said to him, “How is it that you ask me for a drink? (For Jews have no dealings with Samaritans.)”"
const CORRECT_4_10 =
  "Jesus answered her, “If you knew who it is that is saying to you, ‘Give me a drink,’ you would have asked him.”"
const ENGLISH_PROFILE = {
  quoteMarks: { levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }], continuation: "reopen-each-paragraph" },
  questionMarkers: {},
}

const realFetch = globalThis.fetch
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
const PACK_FILES: Record<string, unknown> = {
  "/manifest.json": {
    pack: "bkp",
    version: "1.0.0",
    builtAt: "2026-10-06T00:00:00Z",
    versification: "org",
    sources: [],
    layers: {},
    books: { JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
  },
  "/voices/JHN.json": JHN4_VOICES,
  "/structure/JHN.json": { ...JHN4_STRUCTURE, segments: [], moves: [] },
  "/people/JHN.json": JHN4_PEOPLE,
  "/text/JHN.json": JHN4_TEXT,
}

/** AQU-1701: pack 1.2, which publishes the notes layer and its Translation Questions. */
const PACK_FILES_WITH_NOTES: Record<string, unknown> = {
  ...PACK_FILES,
  "/manifest.json": {
    ...(PACK_FILES["/manifest.json"] as Record<string, unknown>),
    version: "1.2.0",
    books: { JHN: { layers: ["text", "structure", "voices", "people", "notes"], bytes: {} } },
  },
  "/notes/JHN.json": { book: "JHN", notes: [], questions: JHN4_QUESTIONS },
}

let userSeq = 900
let jevCalls = 0
let files = PACK_FILES
const jevQuestionKeys: string[][] = []

beforeEach(() => {
  __resetBkpServerMemory()
  jevCalls = 0
  files = PACK_FILES
  jevQuestionKeys.length = 0
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(PACK)) {
      const file = files[url.slice(PACK.length)]
      return file ? json(file) : new Response("missing", { status: 404 })
    }
    if (url.endsWith("/alpha/decisions")) {
      jevCalls += 1
      const request = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
      jevQuestionKeys.push(Object.keys(request.questions))
      return json({ answers: Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.1 }])) })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
})

afterEach(() => vi.stubGlobal("fetch", realFetch))

async function member(projectId: string, level: number): Promise<string> {
  const userId = ++userSeq
  await seedUser(userId, `checker-${userId}`)
  await db
    .prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)")
    .bind(projectId, userId, level, userId)
    .run()
  return jwtFor(`checker-${userId}`)
}

async function seedProject(settings: Record<string, unknown>) {
  const id = `proj-bible-check-${++userSeq}`
  const ownerId = ++userSeq
  await seedUser(ownerId, `owner-${ownerId}`)
  await db.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)").bind(id, id, ownerId).run()
  await db
    .prepare("INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, ?)")
    .bind(id, JSON.stringify(settings), ownerId)
    .run()
  for (const [ref, source] of Object.entries(JHN4_SOURCES)) {
    const cellId = `c${ref.split(":")[1]}`
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
         VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
      )
      .bind(id, FILE, cellId, source, ref, `ev-src-${cellId}`)
      .run()
  }
  // Translated: 4:9 (quotation closed after the aside) and 4:10 (correct). 4:7 and 4:8 are empty.
  for (const [cellId, text] of [["c9", ASIDE_INSIDE], ["c10", CORRECT_4_10]]) {
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, source_event_id, last_edit_at)
         VALUES (?, ?, ?, 'target', ?, NULL, ?, ?, 0)`,
      )
      .bind(id, FILE, cellId, text, `ev-tgt-${cellId}`, `ev-src-${cellId}`)
      .run()
  }
  return { id, maintainer: await member(id, 600), contributor: await member(id, 400) }
}

const ON = {
  autopilotEnabled: true,
  bibleResourcesEnabled: true,
  bibleEnrichments: { autopilot: true, checks: true },
  languageProfile: ENGLISH_PROFILE,
}

function check(projectId: string, jwt: string, body: Record<string, unknown> = { fileId: FILE }) {
  return app.request(
    `/api/v2/projects/${projectId}/contextual/bible-check`,
    { method: "POST", headers: { ...authHeader(jwt), "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { ...env, BKP_BASE: PACK, OPENROUTER_API_KEY: "test-key" },
  )
}

describe("POST /contextual/bible-check", () => {
  it("reports findings with evidence for translated cells, and never touches their text", async () => {
    const p = await seedProject(ON)
    const res = await check(p.id, p.maintainer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      checked: number
      cells: { cellId: string; findings: { code: string; params?: Record<string, string> }[] }[]
      judgments: { check: string; mode: string; outcome: string }[]
      jevCalls: number
      nextAfter: string | null
    }
    expect(body.checked).toBe(2)
    expect(body.cells).toEqual([
      { cellId: "c9", ref: "JHN 4:9", findings: [{ code: "bkp:V2", params: expect.objectContaining({ kind: "close-after-aside", startRef: "JHN 4:9" }) }] },
    ])
    // The negation question was asked (no negators in the profile); shadow mode reports it, acts on nothing.
    expect(jevCalls).toBe(1)
    expect(body.judgments).toContainEqual(expect.objectContaining({ check: "negation", mode: "shadow", outcome: "fail" }))
    expect(body.nextAfter).toBeNull()

    const target = await db
      .prepare("SELECT value FROM cells WHERE project_id = ? AND cell_id = 'c9' AND side = 'target'")
      .bind(p.id)
      .first<{ value: string }>()
    expect(target?.value).toBe(ASIDE_INSIDE)
    const drafts = await db.prepare("SELECT COUNT(*)::int AS n FROM contextual_drafts WHERE project_id = ?").bind(p.id).first<{ n: number }>()
    expect(drafts?.n).toBe(0)
  })

  // AQU-1701: C1 makes check mode an automated community check. WHY: the
  // Translation Questions on verses people already translated are exactly
  // what a checker would ask; while C1 is in shadow its answers reach the
  // maintainer's judgments and never the findings.
  it("asks the Translation Questions whose verses are all translated: one call for the chapter, in shadow", async () => {
    files = PACK_FILES_WITH_NOTES
    const p = await seedProject(ON)
    const body = (await (await check(p.id, p.maintainer)).json()) as {
      cells: { cellId: string; findings: { code: string }[] }[]
      judgments: { check: string; mode: string; outcome: string; tq?: string; cellId: string }[]
      jevCalls: number
    }
    // The span-style call (negation), then C1's: 4:9 and 4:10 are translated; 4:7 and 4:8 are not, so their TQs wait.
    expect(jevCalls).toBe(2)
    expect(body.jevCalls).toBe(2)
    expect(jevQuestionKeys[1]).toEqual(["q0", "q1"])
    expect(body.judgments.filter((j) => j.check === "tq")).toEqual([
      expect.objectContaining({ cellId: "c9", tq: "tq:172802", mode: "shadow", outcome: "fail" }),
      expect.objectContaining({ cellId: "c10", tq: "tq:172803", mode: "shadow", outcome: "fail" }),
    ])
    expect(body.cells.flatMap((c) => c.findings.map((f) => f.code))).not.toContain("bkp:C1")
  })

  it("continues where the last call stopped", async () => {
    const p = await seedProject(ON)
    const res = await check(p.id, p.maintainer, { fileId: FILE, startAfter: "c9" })
    expect(((await res.json()) as { checked: number }).checked).toBe(1)
  })

  it("raises the Language-profile questions the file needs as decision cards", async () => {
    const p = await seedProject({ ...ON, languageProfile: {} })
    const body = (await (await check(p.id, p.maintainer)).json()) as { factQuestions: string[] }
    expect(body.factQuestions).toEqual(["quoteMarks", "questionMarkers", "pronouns.secondPerson"])
  })

  it("is a maintainer's tool", async () => {
    const p = await seedProject(ON)
    expect((await check(p.id, p.contributor)).status).toBe(403)
  })

  it("refuses while Bible data checks are off", async () => {
    const p = await seedProject({ ...ON, bibleEnrichments: { autopilot: true, checks: false } })
    const res = await check(p.id, p.maintainer)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bible_data_off")
  })
})
