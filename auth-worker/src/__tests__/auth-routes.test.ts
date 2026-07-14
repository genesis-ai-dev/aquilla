import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { verify } from "hono/jwt"
import { authHeader, jwtFor } from "./helpers/db"

const SECRET = "frontier-test-secret"

async function seedAliceWithPassword(password: string): Promise<void> {
  const hash = await hashPasswordWerkzeugScrypt(password)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'alice', 'alice@example.com', ?, '{\"theme\":\"dark\"}')",
  )
    .bind(hash)
    .run()
}

describe("POST /api/v2/auth/token", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = global.fetch
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("returns an access token for the right password", async () => {
    await seedAliceWithPassword("correct-password")
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          password: "correct-password",
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      access_token: string
      token_type: string
    }
    expect(body.token_type).toBe("bearer")
    const payload = (await verify(body.access_token, SECRET, "HS256")) as {
      sub: string
    }
    expect(payload.sub).toBe("alice")
  })

  it("returns 401 on a wrong password", async () => {
    await seedAliceWithPassword("correct-password")
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "wrong" }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it("returns 401 for unknown users (no enumeration)", async () => {
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "ghost", password: "anything-1234" }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })

  it("accepts login by email as well as username", async () => {
    await seedAliceWithPassword("correct-password")
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice@example.com",
          password: "correct-password",
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })

  it("is mounted at /api/v1/auth/token too for legacy clients", async () => {
    await seedAliceWithPassword("correct-password")
    const res = await app.request(
      "/api/v1/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          password: "correct-password",
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe("GET /api/v2/auth/me", () => {
  it("returns the hydrated user from the JWT", async () => {
    await seedAliceWithPassword("correct-password")
    // Mint a token via /token
    const tokenRes = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          password: "correct-password",
        }),
      },
      env,
    )
    const { access_token } = (await tokenRes.json()) as {
      access_token: string
    }

    const res = await app.request(
      "/api/v2/auth/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${access_token}` },
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      username: string
      email: string
      preferences: Record<string, unknown>
    }
    expect(body.username).toBe("alice")
    expect(body.email).toBe("alice@example.com")
    expect(body.preferences).toEqual({ theme: "dark" })
  })

  it("returns 401 without an Authorization header", async () => {
    const res = await app.request(
      "/api/v2/auth/me",
      { method: "GET" },
      env,
    )
    expect(res.status).toBe(401)
  })
})

describe("POST /api/v2/auth/register", () => {
  it("registers a new user and returns a bearer token (no GitLab provisioning)", async () => {
    const res = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "newbie",
          email: "new@example.com",
          password: "very-secure",
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { access_token: string; token_type: string; gitlab_token?: unknown }
    expect(body.token_type).toBe("bearer")
    expect(body.access_token).toMatch(/^eyJ/)
    // GitLab fields were dropped from the response shape — the frontend
    // session type no longer carries them.
    expect(body.gitlab_token).toBeUndefined()
  })

  it("sends a welcome email on successful registration", async () => {
    const send = vi.fn(
      async (_message: {
        from: string
        to: string[]
        subject: string
        html?: string
        text?: string
      }) => ({ messageId: "msg-1" }),
    )
    const envWithEmail = { ...env, EMAIL: { send } }
    const res = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "welcomed",
          email: "welcomed@example.com",
          password: "very-secure",
        }),
      },
      envWithEmail,
    )
    expect(res.status).toBe(200)
    // The send is invoked synchronously up to its first await inside the
    // handler, so by the time the response resolves it has been called.
    expect(send).toHaveBeenCalledOnce()
    const message = send.mock.calls[0][0]
    expect(message.to).toEqual(["welcomed@example.com"])
    expect(message.subject).toMatch(/welcome/i)
  })

  it("registers successfully even when the welcome email throws", async () => {
    const send = vi.fn(async () => {
      throw new Error("mail provider down")
    })
    const envWithEmail = { ...env, EMAIL: { send } }
    const res = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "resilient",
          email: "resilient@example.com",
          password: "very-secure",
        }),
      },
      envWithEmail,
    )
    // Registration must not depend on email delivery.
    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
  })

  it("returns 409 when the username already exists", async () => {
    const first = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          email: "alice@example.com",
          password: "pw1abcdef",
        }),
      },
      env,
    )
    expect(first.status).toBe(200)
    const dup = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "alice",
          email: "alice2@example.com",
          password: "pw2abcdef",
        }),
      },
      env,
    )
    expect(dup.status).toBe(409)
  })

  it("rejects a username whose lowercased form already exists (AQU-340)", async () => {
    const first = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Ryan",
          email: "ryan@example.com",
          password: "pw1abcdef",
        }),
      },
      env,
    )
    expect(first.status).toBe(200)

    // A different casing of the same name must be treated as a duplicate.
    for (const twin of ["ryan", "RYAN", "RYaN"]) {
      const dup = await app.request(
        "/api/v2/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: twin,
            email: `${twin}-alt@example.com`,
            password: "pw2abcdef",
          }),
        },
        env,
      )
      expect(dup.status).toBe(409)
    }

    // Exactly one row exists, and it preserves the casing the user first typed.
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT username FROM users WHERE LOWER(username) = 'ryan'",
    ).all<{ username: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].username).toBe("Ryan")
  })

  it("rejects an email whose lowercased form already exists (AQU-340)", async () => {
    const first = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "casey",
          email: "Casey@Example.com",
          password: "pw1abcdef",
        }),
      },
      env,
    )
    expect(first.status).toBe(200)

    const dup = await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "casey2",
          email: "casey@example.com",
          password: "pw2abcdef",
        }),
      },
      env,
    )
    expect(dup.status).toBe(409)
  })
})
