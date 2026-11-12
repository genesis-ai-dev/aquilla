// Contract tests for POST /api/v1/ai/smart-edits/{suggest,feedback}.
//
// What matters: suggestions come from what PEOPLE on this project changed
// (AI draft → human, human → human), from the commit log alone; a dismissal
// counts against the edit; Jev only ever picks between "keep" and wordings the
// memory found — it cannot invent one; and nothing here can fail the caller.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "smart-project"
const FILE = "f1"
const HOUR = 3_600_000
const YHWH = "יְהוָה"

type SuggestBody = {
  suggestions: { cellId: string; old: string; new: string; tier: "memory" | "jev"; examples: { fromAiDraft: boolean }[] }[]
  jev?: string
  disabled?: boolean
}

function testEnv(overrides: Record<string, unknown> = {}): typeof env {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key", ...overrides })
}

async function seedMember(): Promise<string> {
  await seedUser(1, "lead")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Smart', 1)").bind(PROJECT_ID).run()
  for (const [id, role, pos] of [["lane-src", "source", 0], ["lane-default", "target", 1]] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES (?, ?, ?, ?, NULL, '', ?)",
    ).bind(id, PROJECT_ID, role, id, pos).run()
  }
  return jwtFor("lead")
}

let seq = 0
async function commit(cellId: string, id: string, parentId: string | null, value: string, ts: number, extra: Record<string, unknown> = {}, author = "translator") {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES (?, 1, ?, ?, ?, 'target.cell.commit', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, PROJECT_ID, FILE, cellId, author, JSON.stringify({ value, ...extra }), ts, ts, parentId, ++seq).run()
}

async function cell(cellId: string, side: "source" | "target", value: string, opts: { validated?: number; aiDrafted?: number } = {}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id, validated, ai_drafted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(PROJECT_ID, FILE, cellId, side, value, `ev-${cellId}-${side}`, Date.now(), side === "source" ? "lane-src" : "lane-default", opts.validated ?? 0, opts.aiDrafted ?? 0).run()
}

/** Cells c1, c2: an AI draft said "the Lord", a translator changed it to "Yahweh". */
async function seedTwoCorrections() {
  const t0 = Date.now() - 5 * HOUR
  for (const [i, c] of ["c1", "c2"].entries()) {
    const draft = i === 0 ? "and the Lord spoke" : "for the Lord is good"
    const fixed = i === 0 ? "and Yahweh spoke" : "for Yahweh is good"
    await commit(c, `${c}-draft`, null, draft, t0 + i, { ai_suggestion: true })
    // Two idle-commits seconds apart: one edit, not two.
    await commit(c, `${c}-typing`, `${c}-draft`, draft.replace("the Lord", "Yah"), t0 + i + 1000)
    await commit(c, `${c}-fixed`, `${c}-typing`, fixed, t0 + i + 2000)
    await cell(c, "source", `${YHWH} ${i}`)
    await cell(c, "target", fixed)
  }
}

function suggest(jwt: string, body: Record<string, unknown>, e = testEnv()) {
  return app.request("/api/v1/ai/smart-edits/suggest", {
    method: "POST",
    headers: authHeader(jwt),
    body: JSON.stringify({ projectId: PROJECT_ID, ...body }),
  }, e)
}

const SHEPHERD = { fileId: FILE, cellId: "c3", source: `${YHWH} רֹעִי`, target: "the Lord is my shepherd" }

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/ai/smart-edits/suggest", () => {
  it("requires project access", async () => {
    await seedUser(7, "outsider")
    const res = await suggest(await jwtFor("outsider"), { cells: [SHEPHERD] })
    expect(res.status).toBe(403)
  })

  it("suggests the team's own correction of AI drafts, learned from the commit log", async () => {
    const jwt = await seedMember()
    await seedTwoCorrections()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await suggest(jwt, { cells: [SHEPHERD] })
    expect(res.status).toBe(200)
    const out = (await res.json()) as SuggestBody
    expect(out.suggestions).toEqual([expect.objectContaining({ cellId: "c3", old: "the Lord", new: "Yahweh", tier: "memory" })])
    expect(out.suggestions[0].examples.every((e) => e.fromAiDraft)).toBe(true)
    // Confident memory suggestions cost nothing: no model call.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("treats a dismissal as evidence against the edit", async () => {
    const jwt = await seedMember()
    await seedTwoCorrections()
    const fb = await app.request("/api/v1/ai/smart-edits/feedback", {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({ projectId: PROJECT_ID, fileId: FILE, cellId: "c3", oldNorm: "the lord", newNorm: "yahweh", action: "dismiss", tier: "memory" }),
    }, testEnv())
    expect(fb.status).toBe(200)
    const out = (await (await suggest(jwt, { cells: [SHEPHERD], verify: false })).json()) as SuggestBody
    expect(out.suggestions).toEqual([])
  })

  it("does not count an accepted suggestion as fresh evidence for itself", async () => {
    const jwt = await seedMember()
    await seedTwoCorrections()
    // c1's correction was a suggestion the translator accepted, not independent judgement.
    const fb = await app.request("/api/v1/ai/smart-edits/feedback", {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({ projectId: PROJECT_ID, fileId: FILE, cellId: "c1", oldNorm: "the lord", newNorm: "yahweh", action: "accept", tier: "memory" }),
    }, testEnv())
    expect(fb.status).toBe(200)
    const out = (await (await suggest(jwt, { cells: [SHEPHERD], verify: false })).json()) as SuggestBody
    // One independent correction left: below the bar for showing without a check.
    expect(out.suggestions).toEqual([])
  })

  it("asks Jev to choose between keep and the remembered wording when the memory is unsure", async () => {
    const jwt = await seedMember()
    const t0 = Date.now() - 5 * HOUR
    await commit("c1", "c1-a", null, "and the Lord spoke", t0)
    await commit("c1", "c1-b", "c1-a", "and Yahweh spoke", t0 + HOUR)
    await cell("c1", "source", YHWH)
    await cell("c1", "target", "and Yahweh spoke")
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { q0: { type: "choice", choice: "r0", probabilities: { keep: 0.1, r0: 0.9 } } } }), { status: 200 }),
    )
    const out = (await (await suggest(jwt, { cells: [SHEPHERD] })).json()) as SuggestBody
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }
    expect(sent.questions.q0.type).toBe("choice")
    expect(Object.keys(sent.questions.q0.criteria)).toEqual(["keep", "r0"])
    expect(out).toMatchObject({ jev: "model", suggestions: [expect.objectContaining({ new: "Yahweh", tier: "jev" })] })
  })

  it("shows nothing when Jev says keep, and nothing breaks when Jev is down", async () => {
    const jwt = await seedMember()
    const t0 = Date.now() - 5 * HOUR
    await commit("c1", "c1-a", null, "and the Lord spoke", t0)
    await commit("c1", "c1-b", "c1-a", "and Yahweh spoke", t0 + HOUR)
    await cell("c1", "source", YHWH)
    await cell("c1", "target", "and Yahweh spoke")
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ answers: { q0: { type: "choice", choice: "keep", probabilities: { keep: 0.8, r0: 0.2 } } } }), { status: 200 }),
    )
    expect(((await (await suggest(jwt, { cells: [SHEPHERD] })).json()) as SuggestBody).suggestions).toEqual([])
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 500 }))
    const down = await suggest(jwt, { cells: [SHEPHERD] })
    expect(down.status).toBe(200)
    expect(((await down.json()) as SuggestBody).jev).toBe("upstream")
  })

  it("never learns from an agent's commit", async () => {
    const jwt = await seedMember()
    const t0 = Date.now() - 5 * HOUR
    for (const c of ["c1", "c2"]) {
      await commit(c, `${c}-a`, null, "and the Lord spoke", t0)
      await commit(c, `${c}-b`, `${c}-a`, "and Yahweh spoke", t0 + HOUR, { agent_run_id: "run-1" })
      await cell(c, "source", YHWH)
      await cell(c, "target", "and Yahweh spoke")
    }
    const out = (await (await suggest(jwt, { cells: [SHEPHERD], verify: false })).json()) as SuggestBody
    expect(out.suggestions).toEqual([])
  })

  it("answers with no suggestions, not a 500, when the edit memory cannot be read", async () => {
    const jwt = await seedMember()
    await env.AQUILLA_PG.prepare("ALTER TABLE smart_edit_observations RENAME TO smart_edit_observations_gone").run()
    try {
      const res = await suggest(jwt, { cells: [SHEPHERD] })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ suggestions: [], unavailable: true })
    } finally {
      await env.AQUILLA_PG.prepare("ALTER TABLE smart_edit_observations_gone RENAME TO smart_edit_observations").run()
    }
  })

  it("honours the SMART_EDITS kill switch", async () => {
    const jwt = await seedMember()
    await seedTwoCorrections()
    const out = (await (await suggest(jwt, { cells: [SHEPHERD] }, testEnv({ SMART_EDITS: "off" }))).json()) as SuggestBody
    expect(out).toEqual({ suggestions: [], disabled: true })
  })
})

describe("POST /api/v1/ai/smart-edits/llm", () => {
  const llmEnv = () => testEnv({ OPENROUTER_BASE_URL: "http://127.0.0.1:9456/api/v1/", AI_BUDGET_ENFORCE: "false" })
  const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
    projectId: PROJECT_ID, fileId: FILE, cellId: "c3", source: `${YHWH} רֹעִי`, target: "the Lord is my shepherd", ...extra,
  })
  const reply = (content: unknown) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0004 },
  }), { status: 200 })

  it("is for contributors and up — it spends credits", async () => {
    await seedMember()
    await seedUser(9, "viewer")
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 9, 100)").bind(PROJECT_ID).run()
    const res = await app.request("/api/v1/ai/smart-edits/llm", { method: "POST", headers: authHeader(await jwtFor("viewer")), body: body() }, llmEnv())
    expect(res.status).toBe(403)
  })

  it("still asks the model, without team evidence, when the edit memory cannot be read", async () => {
    const jwt = await seedMember()
    await env.AQUILLA_PG.prepare("ALTER TABLE smart_edit_observations RENAME TO smart_edit_observations_gone").run()
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ edits: [{ old: "the Lord", new: "Yahweh", reason: "r" }] }))
      const res = await app.request("/api/v1/ai/smart-edits/llm", { method: "POST", headers: authHeader(jwt), body: body() }, llmEnv())
      expect(res.status).toBe(200)
      expect(((await res.json()) as { suggestions: unknown[] }).suggestions).toHaveLength(1)
    } finally {
      await env.AQUILLA_PG.prepare("ALTER TABLE smart_edit_observations_gone RENAME TO smart_edit_observations").run()
    }
  })

  it("gives the model the team's own corrections and returns only exact-span edits", async () => {
    const jwt = await seedMember()
    await seedTwoCorrections()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      edits: [
        { old: "the Lord", new: "Yahweh", reason: "The team renders the divine name as Yahweh." },
        { old: "not in the text", new: "x", reason: "invented" },
        { old: "the Lord is my shepherd", new: "Yahweh shepherds me", reason: "whole-segment rewrite" },
      ],
    }))
    const res = await app.request("/api/v1/ai/smart-edits/llm", { method: "POST", headers: authHeader(jwt), body: body() }, llmEnv())
    expect(res.status).toBe(200)
    const prompt = String(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).messages[1].content)
    expect(prompt).toContain("after: for Yahweh is good")
    const out = (await res.json()) as { suggestions: { old: string; new: string; start: number; end: number; tier: string }[] }
    expect(out.suggestions).toEqual([expect.objectContaining({ old: "the Lord", new: "Yahweh", start: 0, end: 8, tier: "llm" })])
  })
})

