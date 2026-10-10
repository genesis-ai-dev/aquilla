// AQU-1870 — per-request ceilings on the chat proxy.
//
// CHAT_MAX_PER_USER_PER_WINDOW bounds how *often* a signed-in user may call
// this proxy; nothing bounded how expensive one call was. Message content was
// unbounded and `max_tokens` was whatever the client asked for on the legacy
// (unmetered) path — only the metered path clamped output — so one user could
// aim a 200k-token prompt at an allowlisted frontier model on the shared
// OPENROUTER_API_KEY. These tests pin the two ceilings and the fact that a
// normal suggestion request still reaches the provider unaltered.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import "./helpers/pg-test-env"

const ALLOWED_MODEL = "anthropic/claude-sonnet-4.5"
/** The legacy path's output ceiling in chat.ts — the SPA's shipped default. */
const CHAT_MAX_OUTPUT_TOKENS = 16_384
/** The prompt ceiling in chat.ts, in characters of summed message content. */
const CHAT_MAX_PROMPT_CHARS = 200_000

function testEnv(): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    AI_BUDGET_ENFORCE: "false",
  })
}

function mockUpstream() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  )
}

/** The JSON body chat.ts actually forwarded to the provider. */
function forwardedBody(upstream: ReturnType<typeof mockUpstream>): Record<string, unknown> {
  const call = upstream.mock.calls.find(([url]) => String(url).includes("/chat/completions"))
  expect(call).toBeDefined()
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>
}

async function send(
  body: Record<string, unknown>,
  user: { id: number; name: string },
): Promise<Response> {
  await seedUser(user.id, user.name)
  const jwt = await jwtFor(user.name)
  return app.request(
    "/api/v1/chat/completions",
    {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({
        model: ALLOWED_MODEL,
        messages: [{ role: "user", content: "Translate this verse." }],
        stream: false,
        ...body,
      }),
    },
    testEnv(),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("chat /api/v1/chat/completions — request ceilings (AQU-1870)", () => {
  it("rejects a prompt over the character ceiling with 413 and never calls the provider", async () => {
    const upstream = mockUpstream()
    const oversized = "x".repeat(CHAT_MAX_PROMPT_CHARS + 1)
    const res = await send({ messages: [{ role: "user", content: oversized }] }, { id: 1870, name: "floodhand" })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("prompt_too_large")
    expect(body.message).toContain(String(CHAT_MAX_PROMPT_CHARS))
    expect(upstream.mock.calls.filter(([url]) => String(url).includes("/chat/completions"))).toHaveLength(0)
  })

  it("sums message content, so the ceiling cannot be split across messages", async () => {
    const upstream = mockUpstream()
    const half = "x".repeat(CHAT_MAX_PROMPT_CHARS / 2 + 1)
    const res = await send(
      { messages: [{ role: "system", content: half }, { role: "user", content: half }] },
      { id: 1871, name: "splitprompt" },
    )

    expect(res.status).toBe(413)
    expect(upstream.mock.calls.filter(([url]) => String(url).includes("/chat/completions"))).toHaveLength(0)
  })

  it("clamps a client-chosen max_tokens on the legacy path", async () => {
    const upstream = mockUpstream()
    const res = await send({ max_tokens: 100_000 }, { id: 1872, name: "bigbudget" })

    expect(res.status).toBe(200)
    expect(forwardedBody(upstream).max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS)
  })

  it("passes a normal suggestion request through unaltered", async () => {
    const upstream = mockUpstream()
    // The SPA's shipped default (DEFAULT_COMPLETION_MAX_TOKENS) must survive.
    const res = await send({ max_tokens: CHAT_MAX_OUTPUT_TOKENS }, { id: 1873, name: "suggester" })

    expect(res.status).toBe(200)
    expect(forwardedBody(upstream).max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS)
  })

  it("leaves max_tokens absent when the client sent none, so the provider default applies", async () => {
    const upstream = mockUpstream()
    const res = await send({}, { id: 1874, name: "nobudget" })

    expect(res.status).toBe(200)
    expect("max_tokens" in forwardedBody(upstream)).toBe(false)
  })

  it("rejects a non-positive max_tokens rather than forwarding it", async () => {
    const upstream = mockUpstream()
    const res = await send({ max_tokens: 0 }, { id: 1875, name: "zerobudget" })

    expect(res.status).toBe(400)
    expect(upstream.mock.calls.filter(([url]) => String(url).includes("/chat/completions"))).toHaveLength(0)
  })

  it("rejects a message array over the sanity ceiling", async () => {
    const upstream = mockUpstream()
    const res = await send(
      { messages: Array.from({ length: 65 }, () => ({ role: "user", content: "hi" })) },
      { id: 1876, name: "arrayflood" },
    )

    expect(res.status).toBe(400)
    expect(upstream.mock.calls.filter(([url]) => String(url).includes("/chat/completions"))).toHaveLength(0)
  })
})
