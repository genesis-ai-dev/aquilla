// Route-level contract tests for the platform AI spend ceiling — AQU-1869.
//
// db/shared/ai-spend-ceiling.test.ts covers the decision in isolation. What
// matters here is the composition the unit test cannot see: that a real route,
// reading the real ledger table through the production Postgres shim, refuses
// the request BEFORE the provider fetch. A guard that answers correctly but is
// consulted after the upstream call protects nothing.
//
// The chat proxy stands in for every paid path: it is the one surface where the
// guard sits ahead of both the legacy credit guard and the metered ledger, so
// it exercises the placement every other call site copies.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { __resetAiSpendCeilingStateForTests } from "../../../db/shared/ai-spend-ceiling"

const MODEL = "anthropic/claude-sonnet-4.5"

function chatBody() {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Translate this verse." }],
    stream: false,
  })
}

/** Stub OpenRouter so a request that gets through does not make real HTTP. */
function mockUpstream() {
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

function withEnvOverrides(overrides: Partial<typeof env>): typeof env {
  return Object.assign(Object.create(env), overrides)
}

/** Record raw provider spend for today, the way every paid path does. */
async function seedPlatformSpend(dollars: number, orgId = 7): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_credit_usage_daily (org_id, user_id, date_utc, rail, raw_cost_cents, units)
     VALUES (?, ?, (now() AT TIME ZONE 'utc')::date, 'llm', ?, 1)`,
  )
    .bind(orgId, 1869, dollars * 100)
    .run()
}

beforeEach(() => {
  __resetAiSpendCeilingStateForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("platform AI spend ceiling — chat proxy", () => {
  it("refuses the call with 503 and never reaches the provider once the ceiling is reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await seedUser(18690, "ceiling-blocked")
    await seedPlatformSpend(12)
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-blocked")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "10" }),
    )

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "ai_spend_ceiling_reached",
      message: expect.stringContaining("AI is temporarily unavailable") as unknown as string,
    })
    // The whole point: no money was spent answering the request that was
    // refused for spending money.
    expect(upstream).not.toHaveBeenCalled()
  })

  it("lets the call through while spend is below the ceiling", async () => {
    await seedUser(18691, "ceiling-open")
    await seedPlatformSpend(2)
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-open")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "10" }),
    )

    expect(res.status).toBe(200)
    expect(upstream).toHaveBeenCalled()
  })

  it("counts spend across every org, not just the caller's", async () => {
    // The ceiling protects one shared vendor key, so the sum that matters is
    // platform-wide. Summing per-org would be the org cap we already have, and
    // many small orgs could drain the key without any single one tripping.
    vi.spyOn(console, "error").mockImplementation(() => {})
    await seedUser(18692, "ceiling-multi-org")
    await seedPlatformSpend(4, 101)
    await seedPlatformSpend(4, 102)
    await seedPlatformSpend(4, 103)
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-multi-org")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "10" }),
    )

    expect(res.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("ignores yesterday's spend, so the ceiling resets at the UTC day boundary", async () => {
    await seedUser(18693, "ceiling-yesterday")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_credit_usage_daily (org_id, user_id, date_utc, rail, raw_cost_cents, units)
       VALUES (9, 1869, ((now() AT TIME ZONE 'utc')::date - 1), 'llm', 500000, 1)`,
    ).run()
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-yesterday")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "10" }),
    )

    expect(res.status).toBe(200)
    expect(upstream).toHaveBeenCalled()
  })

  it("is not gated on the per-org enforce flag the other guards default off", async () => {
    // CREDIT_ENFORCE and AI_BUDGET_ENFORCE are both unset here, exactly as in
    // every deployed environment. That is the condition under which the
    // platform had no dollar control at all before this ceiling existed.
    vi.spyOn(console, "error").mockImplementation(() => {})
    await seedUser(18694, "ceiling-no-enforce-flag")
    await seedPlatformSpend(50)
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-no-enforce-flag")), body: chatBody() },
      withEnvOverrides({
        OPENROUTER_API_KEY: "test-key",
        AI_DAILY_SPEND_CEILING_USD: "10",
        CREDIT_ENFORCE: undefined,
        AI_BUDGET_ENFORCE: undefined,
      }),
    )

    expect(res.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("can be switched off explicitly, leaving the previous behaviour intact", async () => {
    await seedUser(18695, "ceiling-off")
    await seedPlatformSpend(5000)
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-off")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "off" }),
    )

    expect(res.status).toBe(200)
    expect(upstream).toHaveBeenCalled()
  })

  it("obeys a ceiling an admin lowered in platform_settings over the env var", async () => {
    // The admin console writes this key; sync-worker's TTS/voice paths read it
    // from the same row, which is why the shared module parses it itself.
    vi.spyOn(console, "error").mockImplementation(() => {})
    await seedUser(18696, "ceiling-admin-set")
    await seedPlatformSpend(3)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO platform_settings (id, settings, version) VALUES (1, ?, 1)`,
    )
      .bind(JSON.stringify({ aiDailySpendCeilingUsd: 1 }))
      .run()
    const upstream = mockUpstream()

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(await jwtFor("ceiling-admin-set")), body: chatBody() },
      withEnvOverrides({ OPENROUTER_API_KEY: "test-key", AI_DAILY_SPEND_CEILING_USD: "500" }),
    )

    expect(res.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
})
