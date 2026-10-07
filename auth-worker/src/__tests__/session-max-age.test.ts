import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import { authHeader } from "./helpers/db"

// [Pen test] Auth & session mgmt (2026-09-14): the sliding refresh (AQU-995,
// POST /auth/refresh) re-mints a token past its half-life with no ceiling on
// the session's total age — `sst` was carried forward across every refresh
// but never checked. A token kept alive by a script calling /auth/refresh
// every ~15 days never had to die, defeating the 30-day bound on a leaked
// credential's blast radius. These guard the fix: resolveSession now caps
// total session age (from `sst`, falling back to `iat`) at
// MAX_SESSION_AGE_DAYS regardless of how many times the token was refreshed.

const DAY = 24 * 60 * 60
const TOKEN_LIFETIME = 30 * DAY

async function register(username: string, email: string, password: string): Promise<Response> {
  return app.request(
    "/api/v2/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password }),
    },
    env,
  )
}

/** A live (unexpired) token whose *session* started `sessionAgeSeconds` ago,
 *  minted (`iat`) just now — models a token that has been refreshed forward
 *  many times, the way POST /auth/refresh does via `sst`. */
function tokenWithSessionAge(username: string, sessionAgeSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { sub: username, iat: now, exp: now + TOKEN_LIFETIME, sst: now - sessionAgeSeconds },
    env.SECRET_KEY,
    "HS256",
  )
}

async function me(token: string): Promise<Response> {
  return app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
}

async function refresh(token: string): Promise<Response> {
  return app.request("/api/v2/auth/refresh", { method: "POST", headers: authHeader(token) }, env)
}

afterEach(() => {
  env.MAX_SESSION_AGE_DAYS = undefined
})

describe("absolute session-age ceiling (MAX_SESSION_AGE_DAYS)", () => {
  it("accepts a fresh-token, long-running session under the default 90-day cap", async () => {
    await register("age1", "age1@example.com", "some-password-1")
    const token = await tokenWithSessionAge("age1", 60 * DAY)

    const res = await me(token)
    expect(res.status).toBe(200)
  })

  it("rejects a session past the default 90-day cap even though the token itself hasn't expired", async () => {
    await register("age2", "age2@example.com", "some-password-1")
    const token = await tokenWithSessionAge("age2", 91 * DAY)

    const res = await me(token)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "session_expired" })
  })

  it("a stolen token cannot be kept alive forever via repeated /auth/refresh", async () => {
    await register("age3", "age3@example.com", "some-password-1")
    // Just past half-life so refresh mints a new token, and just past the cap.
    const token = await tokenWithSessionAge("age3", 91 * DAY)

    const res = await refresh(token)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "session_expired" })
  })

  it("honours MAX_SESSION_AGE_DAYS when explicitly configured", async () => {
    await register("age4", "age4@example.com", "some-password-1")
    env.MAX_SESSION_AGE_DAYS = "7"
    const token = await tokenWithSessionAge("age4", 8 * DAY)

    const res = await me(token)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "session_expired" })
  })

  it("falls back to iat for a token minted before the sst claim existed", async () => {
    // A token's own lifetime (30d) caps how old `iat` can be while still
    // unexpired, so this needs a tighter ceiling than the 90-day default to
    // isolate the fallback from ordinary exp-based rejection.
    await register("age5", "age5@example.com", "some-password-1")
    env.MAX_SESSION_AGE_DAYS = "7"
    const now = Math.floor(Date.now() / 1000)
    const iat = now - 8 * DAY
    const noSst = await sign({ sub: "age5", iat, exp: iat + TOKEN_LIFETIME }, env.SECRET_KEY, "HS256")

    const res = await me(noSst)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "session_expired" })
  })
})
