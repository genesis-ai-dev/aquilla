// Contract tests for the AI budget + allowlist guard — AQU-265.
//
// Tests cover:
//   1. Non-allowlisted model → 400 (always enforced).
//   2. Allowlisted model, in-budget → 200 (happy path).
//   3. Per-user daily limit exceeded + AI_BUDGET_ENFORCE=true → 429.
//   4. Global daily ceiling exceeded + AI_BUDGET_ENFORCE=true → 429.
//   5. LOG-ONLY mode (AI_BUDGET_ENFORCE unset): over-budget → passes through
//      (200 from the mocked upstream, not 429).
//
// These tests run against the mock app request pipeline, not a live worker.
// Fetch to OpenRouter is mocked so no real HTTP calls are made.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { pg } from "./helpers/pg-test-env"

const ALLOWED_MODEL = "anthropic/claude-sonnet-4.5"
const DISALLOWED_MODEL = "openai/gpt-4o-ultra-max"

function chatBody(model: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...extra,
  })
}

/** Stub a successful OpenRouter response so chat.ts doesn't fail at the fetch. */
function mockUpstreamSuccess() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "OK", role: "assistant" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  )
}

/** Override env vars for a single test — reset in afterEach. */
function withEnvOverrides(overrides: Partial<typeof env>): typeof env {
  return Object.assign(Object.create(env), overrides)
}

afterEach(() => {
  vi.restoreAllMocks()
  // ai_usage_daily rows are truncated by setup-migrations.ts afterEach(resetTestDb).
})

describe("chat /api/v1/chat/completions — allowlist guard", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody(ALLOWED_MODEL),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it("returns 400 for a non-allowlisted model", async () => {
    await seedUser(1, "alice")
    const jwt = await jwtFor("alice")
    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      AI_BUDGET_ENFORCE: "true",
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(DISALLOWED_MODEL),
      },
      testEnv,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe("model_not_allowed")
    expect(body.message).toMatch(/not available on this platform/)
  })

  it("allows a non-allowlisted model when it appears in AI_ALLOWED_MODELS override", async () => {
    await seedUser(2, "bob")
    const jwt = await jwtFor("bob")
    mockUpstreamSuccess()
    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      AI_ALLOWED_MODELS: `${ALLOWED_MODEL},${DISALLOWED_MODEL}`,
      AI_BUDGET_ENFORCE: "false",
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(DISALLOWED_MODEL),
      },
      testEnv,
    )
    expect(res.status).toBe(200)
  })
})

describe("chat /api/v1/chat/completions — budget enforcement", () => {
  it("returns 200 for an in-budget request (happy path)", async () => {
    await seedUser(3, "carol")
    const jwt = await jwtFor("carol")
    mockUpstreamSuccess()
    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      AI_BUDGET_ENFORCE: "true",
      AI_USER_DAILY_REQUEST_LIMIT: "10",
      AI_GLOBAL_DAILY_REQUEST_LIMIT: "100",
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(ALLOWED_MODEL),
      },
      testEnv,
    )
    expect(res.status).toBe(200)
  })

  it("returns 429 when per-user limit exceeded and enforcement is on", async () => {
    await seedUser(4, "dave")
    const jwt = await jwtFor("dave")
    const today = new Date().toISOString().slice(0, 10)

    // Pre-seed the user's counter above the limit.
    await pg.exec(
      `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
       VALUES (4, '${today}', 5)
       ON CONFLICT (user_id, date_utc) DO UPDATE SET request_count = 5`,
    )

    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      AI_BUDGET_ENFORCE: "true",
      AI_USER_DAILY_REQUEST_LIMIT: "5", // limit = 5; next request → count=6 > 5
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(ALLOWED_MODEL),
      },
      testEnv,
    )
    expect(res.status).toBe(429)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe("daily_budget_exceeded")
    expect(body.message).toContain("Daily AI limit reached")
    expect(body.message).toContain("midnight UTC")
  })

  it("returns 429 when global ceiling exceeded and enforcement is on", async () => {
    await seedUser(5, "eve")
    const jwt = await jwtFor("eve")
    const today = new Date().toISOString().slice(0, 10)

    // Pre-seed the global counter (user_id=0) above the ceiling.
    await pg.exec(
      `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
       VALUES (0, '${today}', 3)
       ON CONFLICT (user_id, date_utc) DO UPDATE SET request_count = 3`,
    )

    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      AI_BUDGET_ENFORCE: "true",
      AI_GLOBAL_DAILY_REQUEST_LIMIT: "3", // ceiling = 3; next → count=4 > 3
      AI_USER_DAILY_REQUEST_LIMIT: "9999",
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(ALLOWED_MODEL),
      },
      testEnv,
    )
    expect(res.status).toBe(429)
    const body = await res.json() as { error: string; message: string }
    expect(body.error).toBe("global_budget_exceeded")
  })

  it("passes through when over-budget but LOG-ONLY mode (AI_BUDGET_ENFORCE unset)", async () => {
    await seedUser(6, "frank")
    const jwt = await jwtFor("frank")
    const today = new Date().toISOString().slice(0, 10)

    // Pre-seed the user's counter above the limit.
    await pg.exec(
      `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
       VALUES (6, '${today}', 2)
       ON CONFLICT (user_id, date_utc) DO UPDATE SET request_count = 2`,
    )

    mockUpstreamSuccess()

    const testEnv = withEnvOverrides({
      OPENROUTER_API_KEY: "test-key",
      // AI_BUDGET_ENFORCE is unset → log-only
      AI_USER_DAILY_REQUEST_LIMIT: "2", // limit = 2; counter will be 3 > 2
    })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: chatBody(ALLOWED_MODEL),
      },
      testEnv,
    )
    // Must pass through (upstream mocked to 200), not 429.
    expect(res.status).toBe(200)
  })
})

// ── AQU-414 follow-up: chat spend org attribution ────────────────────────────
//
// WHY: AQU-414's root cause was chat.ts hardcoding orgId=0 for every
// recordCredit call, making chat spend invisible in every real org's credits
// view (total degenerated to agent-only). The fix: a chat request invoked
// from a project-editing context carries `projectId`, and the route resolves
// the project's org (membership-gated) for both the credit guard and the
// ledger write. Attribution must be best-effort — it can change WHERE spend
// lands, but must never break chat itself.
describe("chat /api/v1/chat/completions — org credit attribution (AQU-414 follow-up)", () => {
  const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

  /** wendi (user 1) is a maintainer on org 1's project; mallory (user 2) is a stranger. */
  async function seedOrgProjectWorld() {
    await seedUser(1, "wendi")
    await seedUser(2, "mallory")
    await pg.exec(`INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)`)
    await pg.exec(`INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1)`)
    await pg.exec(
      `INSERT INTO projects (id, name, created_by, org_id) VALUES ('${PROJECT}', 'Test Project', 1, 1)`,
    )
    await pg.exec(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('${PROJECT}', 1, 600)`,
    )
  }

  async function llmLedger(): Promise<Array<{ org_id: number; user_id: number }>> {
    const res = await env.AQUILLA_PG
      .prepare(`SELECT org_id, user_id FROM org_credit_usage_daily WHERE rail = 'llm'`)
      .all<{ org_id: number; user_id: number }>()
    return res.results ?? []
  }

  const attributionEnv = () =>
    withEnvOverrides({ OPENROUTER_API_KEY: "test-key" })

  it("bills chat spend to the project's org when a member passes projectId", async () => {
    await seedOrgProjectWorld()
    const jwt = await jwtFor("wendi")
    mockUpstreamSuccess()
    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL, { projectId: PROJECT }) },
      attributionEnv(),
    )
    expect(res.status).toBe(200)
    // The llm row must land at org 1 — this is exactly what makes chat spend
    // visible in the org's Today/This week totals (the AQU-414 symptom).
    expect(await llmLedger()).toEqual([{ org_id: 1, user_id: 1 }])
  })

  it("falls back to org 0 when no projectId is present (legacy project-less chat)", async () => {
    await seedOrgProjectWorld()
    const jwt = await jwtFor("wendi")
    mockUpstreamSuccess()
    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL) },
      attributionEnv(),
    )
    expect(res.status).toBe(200)
    expect(await llmLedger()).toEqual([{ org_id: 0, user_id: 1 }])
  })

  it("falls back to org 0 when the caller has no access to the project — no cross-org billing injection", async () => {
    await seedOrgProjectWorld()
    const jwt = await jwtFor("mallory") // not a member of PROJECT or org 1
    mockUpstreamSuccess()
    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL, { projectId: PROJECT }) },
      attributionEnv(),
    )
    // Chat itself must not break (attribution is best-effort, never a gate) —
    // but mallory cannot burn org 1's caps by naming its project.
    expect(res.status).toBe(200)
    expect(await llmLedger()).toEqual([{ org_id: 0, user_id: 2 }])
  })

  it("falls back to org 0 for an unknown projectId (garbage in → legacy behavior out)", async () => {
    await seedOrgProjectWorld()
    const jwt = await jwtFor("wendi")
    mockUpstreamSuccess()
    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL, { projectId: "does-not-exist" }) },
      attributionEnv(),
    )
    expect(res.status).toBe(200)
    expect(await llmLedger()).toEqual([{ org_id: 0, user_id: 1 }])
  })

  it("enforces the org's caps for project-attributed chat when the org opts into enforce", async () => {
    await seedOrgProjectWorld()
    // Org 1 enforces a tiny daily cap and is already over it (100¢ × 4 = 400 credits ≥ 10).
    await pg.exec(
      `INSERT INTO org_settings (org_id, settings, version, updated_by)
       VALUES (1, '{"credits":{"enforce":true,"dailyCap":10}}', 1, 1)`,
    )
    const today = new Date().toISOString().slice(0, 10)
    await pg.exec(
      `INSERT INTO org_credit_usage_daily (org_id, user_id, date_utc, rail, raw_cost_cents, units)
       VALUES (1, 1, '${today}', 'llm', 100, 1)`,
    )
    const jwt = await jwtFor("wendi")
    mockUpstreamSuccess()

    // Project-attributed chat → blocked by org 1's cap.
    const blocked = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL, { projectId: PROJECT }) },
      attributionEnv(),
    )
    expect(blocked.status).toBe(429)
    const body = await blocked.json() as { error: string; reason: string }
    expect(body.error).toBe("credit_cap_exceeded")
    expect(body.reason).toBe("daily")

    // Control: the same user's project-less chat guards against org 0
    // (env-default caps, no spend) and passes — enforcement is scoped to the
    // org that opted in, not to the user.
    const passed = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody(ALLOWED_MODEL) },
      attributionEnv(),
    )
    expect(passed.status).toBe(200)
  })
})
