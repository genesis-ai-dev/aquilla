// Model A/B experiment — assignment on the chat hot path, outcome feedback,
// admin validation + results aggregation.
//
// Determinism: trafficPct=100 forces every roll to the challenger and
// trafficPct=0 forces the champion, so no Math.random stubbing is needed.
// "root" is the platform admin (ADMIN_EMAILS in pg-test-env); elevation is
// unset here so admin routes are exercised directly.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const CHAMPION = "anthropic/claude-sonnet-4.5" // env DEFAULT_LLM_MODEL fallback
const CHALLENGER = "anthropic/claude-haiku-4-5"

const patchSettings = (jwt: string, body: Record<string, unknown>) =>
  app.request(
    "/api/v2/admin/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify(body) },
    env,
  )

/** Mock OpenRouter, capturing each forwarded model. */
function mockUpstream(models: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    models.push(JSON.parse(String(init?.body)).model as string)
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "OK", role: "assistant" } }], usage: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  })
}

const chatEnv = () => Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" })

const defaultChat = (jwt: string) =>
  app.request(
    "/api/v1/chat/completions",
    {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "hi" }], stream: false }),
    },
    chatEnv(),
  )

async function enableAb(trafficPct: number): Promise<void> {
  await seedUser(7, "root")
  const res = await patchSettings(await jwtFor("root"), {
    abTest: { enabled: true, challengerModel: CHALLENGER, trafficPct },
    ifMatchVersion: 0,
  })
  expect(res.status).toBe(200)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("chat A/B assignment", () => {
  it("trafficPct=100 serves the challenger, sets headers, and logs the event", async () => {
    await seedUser(1, "wendi")
    await enableAb(100)
    const forwarded: string[] = []
    mockUpstream(forwarded)

    const res = await defaultChat(await jwtFor("wendi"))
    expect(res.status).toBe(200)
    expect(forwarded).toEqual([CHALLENGER])
    expect(res.headers.get("X-AB-Arm")).toBe("challenger")
    expect(res.headers.get("X-AB-Model")).toBe(CHALLENGER)
    const requestId = res.headers.get("X-AB-Request-Id")
    expect(requestId).toBeTruthy()

    const row = await env.AQUILLA_PG
      .prepare(`SELECT arm, model, user_id, error FROM model_ab_events WHERE id = ?`)
      .bind(requestId)
      .first<{ arm: string; model: string; user_id: number; error: number }>()
    expect(row).toMatchObject({ arm: "challenger", model: CHALLENGER, user_id: 1, error: 0 })
  })

  it("trafficPct=0 serves the champion and logs a champion row", async () => {
    await seedUser(1, "wendi")
    await enableAb(0)
    const forwarded: string[] = []
    mockUpstream(forwarded)

    const res = await defaultChat(await jwtFor("wendi"))
    expect(res.status).toBe(200)
    expect(forwarded).toEqual([CHAMPION])
    expect(res.headers.get("X-AB-Arm")).toBe("champion")
    expect(res.headers.get("X-AB-Model")).toBe(CHAMPION)
  })

  it("an explicit model request is never reassigned or logged", async () => {
    await seedUser(1, "wendi")
    await enableAb(100)
    const forwarded: string[] = []
    mockUpstream(forwarded)

    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ model: CHAMPION, messages: [{ role: "user", content: "hi" }], stream: false }),
      },
      chatEnv(),
    )
    expect(res.status).toBe(200)
    expect(forwarded).toEqual([CHAMPION])
    expect(res.headers.get("X-AB-Request-Id")).toBeNull()
    const count = await env.AQUILLA_PG
      .prepare(`SELECT COUNT(*)::int AS n FROM model_ab_events`)
      .first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("no experiment → no headers, no rows", async () => {
    await seedUser(1, "wendi")
    mockUpstream([])
    const res = await defaultChat(await jwtFor("wendi"))
    expect(res.status).toBe(200)
    expect(res.headers.get("X-AB-Request-Id")).toBeNull()
    const count = await env.AQUILLA_PG
      .prepare(`SELECT COUNT(*)::int AS n FROM model_ab_events`)
      .first<{ n: number }>()
    expect(count?.n).toBe(0)
  })
})

describe("POST /api/v1/chat/ab-feedback", () => {
  const feedback = (jwt: string, requestId: string, outcome: string, editDistance?: number) =>
    app.request(
      "/api/v1/chat/ab-feedback",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({ requestId, outcome, ...(editDistance !== undefined ? { editDistance } : {}) }),
      },
      env,
    )

  async function assignedRequestId(jwt: string): Promise<string> {
    mockUpstream([])
    const res = await defaultChat(jwt)
    vi.restoreAllMocks()
    return res.headers.get("X-AB-Request-Id")!
  }

  it("keeps the first outcome but lets the edit distance refine", async () => {
    await seedUser(1, "wendi")
    await enableAb(100)
    const jwt = await jwtFor("wendi")
    const requestId = await assignedRequestId(jwt)

    // First gesture: a human commit rewrote 40% of the draft.
    const first = await feedback(jwt, requestId, "edited", 0.4)
    expect(await first.json()).toMatchObject({ ok: true, recorded: true })

    // They kept polishing (distance refines), then validated — outcome must
    // stay 'edited' (first write wins) while the distance takes the latest.
    await feedback(jwt, requestId, "edited", 0.55)
    await feedback(jwt, requestId, "accepted", 0.55)

    const row = await env.AQUILLA_PG
      .prepare(`SELECT outcome, edit_distance FROM model_ab_events WHERE id = ?`)
      .bind(requestId)
      .first<{ outcome: string; edit_distance: number }>()
    expect(row?.outcome).toBe("edited")
    expect(Number(row?.edit_distance)).toBeCloseTo(0.55)
  })

  it("a validate-first draft records accepted with distance 0", async () => {
    await seedUser(1, "wendi")
    await enableAb(100)
    const jwt = await jwtFor("wendi")
    const requestId = await assignedRequestId(jwt)

    await feedback(jwt, requestId, "accepted", 0)
    const row = await env.AQUILLA_PG
      .prepare(`SELECT outcome, edit_distance FROM model_ab_events WHERE id = ?`)
      .bind(requestId)
      .first<{ outcome: string; edit_distance: number }>()
    expect(row?.outcome).toBe("accepted")
    expect(Number(row?.edit_distance)).toBe(0)
  })

  it("another user cannot report on someone else's request", async () => {
    await seedUser(1, "wendi")
    await seedUser(2, "mallory")
    await enableAb(100)
    const requestId = await assignedRequestId(await jwtFor("wendi"))

    const res = await feedback(await jwtFor("mallory"), requestId, "accepted")
    expect(await res.json()).toMatchObject({ ok: true, recorded: false })
  })

  it("rejects a malformed outcome", async () => {
    await seedUser(1, "wendi")
    const res = await feedback(await jwtFor("wendi"), crypto.randomUUID(), "loved-it")
    expect(res.status).toBe(400)
  })
})

describe("PATCH /api/v2/admin/settings — abTest validation", () => {
  it("rejects a challenger that is not allowlisted", async () => {
    await seedUser(7, "root")
    const res = await patchSettings(await jwtFor("root"), {
      abTest: { enabled: true, challengerModel: "evil/unlisted-model", trafficPct: 50 },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("model_not_allowed")
  })

  it("rejects a challenger equal to the champion", async () => {
    await seedUser(7, "root")
    const res = await patchSettings(await jwtFor("root"), {
      abTest: { enabled: true, challengerModel: CHAMPION, trafficPct: 50 },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("ab_challenger_is_champion")
  })

  it("rejects an out-of-range trafficPct", async () => {
    await seedUser(7, "root")
    const res = await patchSettings(await jwtFor("root"), {
      abTest: { enabled: true, challengerModel: CHALLENGER, trafficPct: 150 },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(400)
  })

  it("a disabled config saves without challenger checks", async () => {
    await seedUser(7, "root")
    const res = await patchSettings(await jwtFor("root"), {
      abTest: { enabled: false, challengerModel: "", trafficPct: 0 },
      ifMatchVersion: 0,
    })
    expect(res.status).toBe(200)
  })
})

describe("GET /api/v2/admin/ab-results", () => {
  it("aggregates per model/arm with recorded outcomes", async () => {
    await seedUser(1, "wendi")
    await enableAb(100)
    const jwt = await jwtFor("wendi")

    mockUpstream([])
    const r1 = await defaultChat(jwt)
    const r2 = await defaultChat(jwt)
    vi.restoreAllMocks()

    await app.request(
      "/api/v1/chat/ab-feedback",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          requestId: r1.headers.get("X-AB-Request-Id"),
          outcome: "accepted",
          editDistance: 0.2,
        }),
      },
      env,
    )
    void r2

    const res = await app.request(
      "/api/v2/admin/ab-results?days=30",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      days: number
      results: Array<{ model: string; arm: string; requests: number; accepted: number; avgEditDistance: number | null }>
    }
    expect(body.days).toBe(30)
    const challengerRow = body.results.find((r) => r.arm === "challenger")
    expect(challengerRow).toMatchObject({ model: CHALLENGER, requests: 2, accepted: 1 })
    expect(challengerRow?.avgEditDistance).toBeCloseTo(0.2)
  })

  it("is admin-gated", async () => {
    await seedUser(1, "wendi")
    const res = await app.request(
      "/api/v2/admin/ab-results",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})
