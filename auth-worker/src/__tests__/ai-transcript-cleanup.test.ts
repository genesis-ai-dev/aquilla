// Contract tests for POST /api/v1/ai/transcript-cleanup.
//
// What matters: the call spends credits, so it is for contributors and up; the
// model is taught from the lane's own heard → corrected pairs and key terms;
// and a result that invents speech is reported, never returned as a cleanup.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "cleanup-project"

function cleanupEnv(): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9456/api/v1/",
    AI_BUDGET_ENFORCE: "false",
  })
}

async function seedLead(): Promise<string> {
  await seedUser(1, "lead")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Cleanup', 1)").bind(PROJECT_ID).run()
  return jwtFor("lead")
}

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
  projectId: PROJECT_ID,
  heard: "ni eema akaenda kwa mji kapernaumu",
  language: "Swahili",
  pairs: [{ heard: "eema akasema", corrected: "Yesu akasema" }],
  terms: [{ term: "Yesu" }],
  ...extra,
})

const reply = (content: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0004 },
}), { status: 200 })

type CleanupBody = { model: string; result: { kind: string; text?: string; changes?: number } }

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/ai/transcript-cleanup", () => {
  it("is for contributors and up — it spends credits", async () => {
    await seedLead()
    await seedUser(9, "viewer")
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 9, 100)").bind(PROJECT_ID).run()
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(await jwtFor("viewer")), body: body() }, cleanupEnv())
    expect(res.status).toBe(403)
  })

  it("teaches the model from the lane's own corrections and returns the cleaned transcript", async () => {
    const jwt = await seedLead()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      text: "ni Yesu akaenda mjini kapernaumu",
      notes: [{ heard: "eema", wrote: "Yesu", reason: "The team spells the name Yesu." }],
    }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(200)
    const prompt = String(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).messages[1].content)
    expect(prompt).toContain("heard: eema akasema\ncorrected: Yesu akasema")
    expect(prompt).toContain("<key-terms>\nYesu\n</key-terms>")
    const out = (await res.json()) as CleanupBody
    expect(out.result).toEqual(expect.objectContaining({ kind: "ok", text: "ni Yesu akaenda mjini kapernaumu", changes: 3 }))
  })

  it("reports a result that adds speech instead of returning it as a cleanup", async () => {
    const jwt = await seedLead()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      text: "ni Yesu akaenda mjini kapernaumu pamoja na wanafunzi wake wote siku ile",
    }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as CleanupBody).result.kind).toBe("too-different")
  })

  it("passes an upstream failure through as a 502, not a cleanup", async () => {
    const jwt = await seedLead()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(502)
  })
})
