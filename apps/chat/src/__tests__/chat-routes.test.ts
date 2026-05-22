import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, seedUser, type FakeD1 } from "./helpers/d1-fake"

const SECRET = "frontier-test-secret"
const OPENROUTER_KEY = "test-openrouter-key"

function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    AUTH_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    DEFAULT_LLM_MODEL: "anthropic/claude-sonnet-4.5",
    ENVIRONMENT: "test",
    ...overrides,
  }
}

async function makeBearer(username = "alice"): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    { sub: username, iat: now, exp: now + 60 },
    SECRET,
    "HS256",
  )
  return `Bearer ${token}`
}

describe("POST /api/v1/chat/completions — auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns 401 without an Authorization header", async () => {
    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "default", messages: [] }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })

  it("returns 401 for a token signed with the wrong secret", async () => {
    const db = makeFakeD1({ users: [seedUser()] })
    const now = Math.floor(Date.now() / 1000)
    const badToken = await sign(
      { sub: "alice", iat: now, exp: now + 60 },
      "different-secret",
      "HS256",
    )
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${badToken}`,
        },
        body: JSON.stringify({ model: "default", messages: [] }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })

  it("accepts a valid JWT even when the bearer has no row in AUTH_DB", async () => {
    // The chat worker trusts the JWT signature; a directory lookup would
    // lock out the half of the user population that lives only in
    // aquilla-db (new aquilla-identity signups). OpenRouter still needs a
    // working OPENROUTER_API_KEY, so we stub fetch to keep the test pure.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )
    const originalFetch = global.fetch
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const db = makeFakeD1() // no users
      const res = await app.request(
        "/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await makeBearer("ghost"),
          },
          body: JSON.stringify({ model: "default", messages: [] }),
        },
        makeEnv(db),
      )
      expect(res.status).toBe(200)
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe("POST /api/v1/chat/completions — non-streaming", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("forwards the request to OpenRouter and returns the JSON verbatim", async () => {
    const upstreamBody = {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hola" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0 },
    }
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await makeBearer(),
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4.5",
          messages: [{ role: "user", content: "Translate: hello" }],
          temperature: 0.4,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof upstreamBody
    expect(body).toEqual(upstreamBody)

    // Verify outbound call shape: correct URL, Authorization, model, and the
    // OpenRouter-specific knobs we always set.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    const url = call[0] as string
    const init = call[1] as RequestInit
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${OPENROUTER_KEY}`)
    const sent = JSON.parse(init.body as string) as Record<string, unknown>
    expect(sent.model).toBe("anthropic/claude-sonnet-4.5")
    expect(sent.temperature).toBe(0.4)
    expect(sent.stream).toBe(false)
    expect(sent.usage).toEqual({ include: true })
    expect(sent.reasoning).toEqual({ effort: "none" })
  })

  it("substitutes DEFAULT_LLM_MODEL for 'default', 'free-tier', and empty strings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"choices":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch
    const db = makeFakeD1({ users: [seedUser()] })

    for (const requested of ["default", "free-tier", ""]) {
      await app.request(
        "/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await makeBearer(),
          },
          body: JSON.stringify({
            model: requested,
            messages: [{ role: "user", content: "x" }],
          }),
        },
        makeEnv(db),
      )
    }

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      const sent = JSON.parse(init.body as string) as { model: string }
      expect(sent.model).toBe("anthropic/claude-sonnet-4.5")
    }
  })

  it("passes through OpenRouter error status and body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Content-Type": "text/plain" },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await makeBearer(),
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "x" }],
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(429)
    const body = (await res.json()) as {
      error: string
      status: number
      message: string
    }
    expect(body.error).toBe("openrouter_error")
    expect(body.status).toBe(429)
    expect(body.message).toBe("rate limited")
  })

  it("returns 500 when OPENROUTER_API_KEY is unset", async () => {
    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await makeBearer(),
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "x" }],
        }),
      },
      makeEnv(db, { OPENROUTER_API_KEY: "" }),
    )
    expect(res.status).toBe(500)
  })

  it("rejects malformed bodies with a 400 from the validator", async () => {
    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await makeBearer(),
        },
        body: JSON.stringify({ messages: "not-an-array" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/v1/chat/completions — streaming", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("pipes the OpenRouter SSE body straight through with SSE headers", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hola"}}]}\n\n' +
      "data: [DONE]\n\n"
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const db = makeFakeD1({ users: [seedUser()] })
    const res = await app.request(
      "/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await makeBearer(),
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "x" }],
          stream: true,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"delta":{"content":"hola"}')
    expect(text).toContain("data: [DONE]")

    // Verify we asked OpenRouter to stream.
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
    if (!init) throw new Error("expected fetch init")
    const sent = JSON.parse(init.body as string) as { stream: boolean }
    expect(sent.stream).toBe(true)
  })
})

describe("GET / and /healthz", () => {
  it("describes the worker on /", async () => {
    const db = makeFakeD1()
    const res = await app.request("/", { method: "GET" }, makeEnv(db))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; routes: string[] }
    expect(body.name).toBe("aquilla-chat-worker")
    expect(body.routes).toContain("/api/v1/chat/completions")
  })

  it("responds 200 on /healthz", async () => {
    const db = makeFakeD1()
    const res = await app.request("/healthz", { method: "GET" }, makeEnv(db))
    expect(res.status).toBe(200)
  })
})

describe("CORS", () => {
  it("answers preflight with permissive headers", async () => {
    const db = makeFakeD1()
    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "OPTIONS" },
      makeEnv(db),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    )
  })
})
