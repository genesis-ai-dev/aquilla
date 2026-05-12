import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { verify } from "hono/jwt"

const SECRET = "frontier-test-secret"

async function makeUserRow(): Promise<UserRow> {
  return {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    password_hash: await hashPasswordWerkzeugScrypt("correct-password"),
    gitlab_user_id: 1001,
    gitlab_username: "alice",
    gitlab_token: "glpat-fake",
    stripe_customer_id: null,
    subscription_tier: "free",
    preferences: '{"theme":"dark"}',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    AUTH_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    // Leave GitLab unconfigured so /token doesn't try to refresh PATs against
    // a real GitLab instance during the test. The route handles this by
    // returning the stored token instead.
  }
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
    const db = makeFakeD1({ users: [await makeUserRow()] })
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
      makeEnv(db),
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
    const db = makeFakeD1({ users: [await makeUserRow()] })
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "wrong" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })

  it("returns 401 for unknown users (no enumeration)", async () => {
    const db = makeFakeD1()
    const res = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "ghost", password: "anything-1234" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })

  it("accepts login by email as well as username", async () => {
    const db = makeFakeD1({ users: [await makeUserRow()] })
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
      makeEnv(db),
    )
    expect(res.status).toBe(200)
  })

  it("is mounted at /api/v1/auth/token too for legacy clients", async () => {
    const db = makeFakeD1({ users: [await makeUserRow()] })
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
      makeEnv(db),
    )
    expect(res.status).toBe(200)
  })
})

describe("GET /api/v2/auth/me", () => {
  it("returns the hydrated user from the JWT", async () => {
    const db = makeFakeD1({ users: [await makeUserRow()] })
    // First mint a token via /token so we don't have to duplicate the
    // signing logic.
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
      makeEnv(db),
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
      makeEnv(db),
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
    const db = makeFakeD1({ users: [await makeUserRow()] })
    const res = await app.request(
      "/api/v2/auth/me",
      { method: "GET" },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })
})

describe("POST /api/v2/auth/register", () => {
  it("returns 503 when GITLAB_URL isn't configured (fast-fail)", async () => {
    const db = makeFakeD1()
    const env = makeEnv(db)
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
    expect(res.status).toBe(503)
  })
})
