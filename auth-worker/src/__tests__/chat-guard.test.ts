// Contract tests for the AI budget + allowlist guard — FRO-265.
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

function chatBody(model: string) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
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
