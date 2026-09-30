// POST /api/v1/ai/agent/internal/brief-summary (AQU-1282 §2) — the
// server-to-server L1 render the external Agent API's RegenerateBriefSummary
// command (and the SetBrief auto-render) calls.
//
// WHY these behaviours are pinned: an agent-written brief is invisible to the
// copilot until its L1 summary exists, and this endpoint is the only way to
// produce that summary without a human clicking "Regenerate" in the app. Its
// rails are the same cost contract as draft-cells: a shared-secret door, a live
// MAINTAINER role check, a credit pre-flight BEFORE the paid call, the same
// prompt + cap the in-app builder uses, and a render-never-write shape (the
// caller owns the settings write).

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser } from "./helpers/db"
import { BRIEF_L1_MAX_CHARS, BRIEF_L1_SYSTEM_PROMPT } from "../../../db/shared/brief"

const PROJECT = "proj-brief-1"

const denv = {
  ...env,
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_BASE_URL: "https://mock-openrouter",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockModel(content: string | null) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
    return Response.json({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
    })
  }))
  return calls
}

async function seedProject(roleLevel: number, orgId: number | null = null) {
  await seedUser(1, "alice")
  // The creator holds OWNER regardless of membership, so the acting user (1)
  // must NOT be the creator or the role floor cannot be tested.
  await seedUser(9, "creator")
  if (orgId !== null) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO organizations (id, name, owner_user_id) VALUES (?, 'Org', 9)`,
    ).bind(orgId).run()
  }
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', ?, 9)`)
    .bind(PROJECT, orgId)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, ?)`,
  )
    .bind(PROJECT, roleLevel)
    .run()
}

function briefReq(auth: string, body: unknown) {
  return app.request(
    "/api/v1/ai/agent/internal/brief-summary",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    },
    denv,
  )
}

const L2 = "# Translation Brief\n\n## Purpose & audience\n\n### Audience / addressees\nRural youth, 15–25"
const baseBody = { projectId: PROJECT, userId: 1, l2Markdown: L2 }

describe("POST /api/v1/ai/agent/internal/brief-summary", () => {
  it("rejects a wrong bearer before doing anything", async () => {
    const calls = mockModel("never")
    const res = await briefReq("Bearer wrong", baseBody)
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it("denies a caller below the MAINTAINER floor without spending", async () => {
    await seedProject(500)
    const calls = mockModel("never")
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("permission_denied")
    expect(calls).toHaveLength(0)
  })

  it("renders the L1 with the in-app prompt and returns it without writing", async () => {
    await seedProject(600)
    const calls = mockModel("  Translate for rural youth aged 15–25. Prefer plain speech.  ")

    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: string; model: string }
    expect(body.summary).toBe("Translate for rural youth aged 15–25. Prefer plain speech.")
    expect(typeof body.model).toBe("string")
    expect(body.model.length).toBeGreaterThan(0)

    // One non-streaming call carrying the SAME system prompt the in-app
    // builder uses, the L2 as the user turn, and the builder's sampling.
    expect(calls).toHaveLength(1)
    const sent = calls[0].body as {
      messages: { role: string; content: string }[]
      stream: boolean
      temperature: number
      max_tokens: number
    }
    expect(sent.stream).toBe(false)
    expect(sent.temperature).toBe(0.2)
    expect(sent.max_tokens).toBe(1024)
    expect(sent.messages[0]).toEqual({ role: "system", content: BRIEF_L1_SYSTEM_PROMPT })
    expect(sent.messages[1].role).toBe("user")
    expect(sent.messages[1].content).toContain(L2)

    // Render-only: the settings row is untouched (there is none to begin with).
    const settings = await env.AQUILLA_PG.prepare(
      `SELECT count(*)::int AS n FROM project_settings WHERE project_id = ?`,
    ).bind(PROJECT).first<{ n: number }>()
    expect(settings?.n).toBe(0)
  })

  it("truncates an over-long summary to the L1 cap and SAYS it truncated", async () => {
    await seedProject(600)
    mockModel("x".repeat(BRIEF_L1_MAX_CHARS + 500))
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: string; truncated: boolean }
    expect(body.summary).toHaveLength(BRIEF_L1_MAX_CHARS)
    // AQU-1323: the caller cannot infer this from the length — the clip is
    // trimEnd'd, so a truncated summary can come back under the cap. Without
    // the flag a receipt would present a clipped brief as a clean render.
    expect(body.truncated).toBe(true)
  })

  it("reports truncated=false for a summary that fits", async () => {
    await seedProject(600)
    mockModel("Translate for rural youth. Prefer natural, contemporary phrasing.")
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { truncated: boolean }).truncated).toBe(false)
  })

  it("reports an empty model reply as job_failed rather than blanking the brief", async () => {
    await seedProject(600)
    mockModel("   ")
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe("job_failed")
  })

  it("rejects an empty l2Markdown (nothing to summarize is the caller's check)", async () => {
    await seedProject(600)
    const calls = mockModel("never")
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, { ...baseBody, l2Markdown: "" })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("meters the render against the org's credit ledger on the agent rail", async () => {
    await seedProject(600, 42)
    mockModel("Short summary.")
    const res = await briefReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(200)
    const ledger = await env.AQUILLA_PG.prepare(
      `SELECT rail, raw_cost_cents FROM org_credit_usage_daily WHERE org_id = 42`,
    ).first<{ rail: string; raw_cost_cents: number }>()
    expect(ledger?.rail).toBe("agent")
    expect(Number(ledger?.raw_cost_cents)).toBeCloseTo(0.01, 4)
  })
})
