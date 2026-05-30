import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { verify } from "hono/jwt"
import { authHeader, jwtFor } from "./helpers/d1"

const SECRET = "frontier-test-secret"

async function seedAliceWithPassword(password: string): Promise<void> {
  const hash = await hashPasswordWerkzeugScrypt(password)
  await env.AQUILLA_DB.prepare(
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
})
