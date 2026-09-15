// Perf (2026-09): authMiddleware's revoked_tokens + users lookups are cached
// per isolate for SESSION_CACHE_TTL_MS. These pin the contract that makes the
// cache safe to ship: a hit skips both queries, an entry ages out at the TTL,
// and a same-isolate logout evicts immediately (the cross-isolate window is
// documented in lib/session-cache.ts and is NOT something a test can widen).
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import { authHeader, seedUser } from "./helpers/db"
import { evictUserSessions, SESSION_CACHE_TTL_MS } from "../lib/session-cache"

/** Wraps AQUILLA_PG so every prepared SQL text is recorded. */
function countingDb(): { db: typeof env.AQUILLA_PG; sql: string[] } {
  const sql: string[] = []
  const real = env.AQUILLA_PG
  const db = {
    prepare: (text: string) => {
      sql.push(text)
      return real.prepare(text)
    },
  } as unknown as typeof env.AQUILLA_PG
  return { db, sql }
}

const sessionQueries = (sql: string[]): string[] =>
  sql.filter((s) => s.includes("FROM revoked_tokens") || s.includes("FROM users WHERE LOWER(username)"))

async function jwtWithJti(username: string, jti: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600, jti }, env.SECRET_KEY, "HS256")
}

afterEach(() => vi.useRealTimers())

describe("session cache", () => {
  it("skips the revoked_tokens and users queries on a hit within the TTL", async () => {
    await seedUser(1, "cached-one")
    const token = await jwtWithJti("cached-one", "jti-hit")
    const { db, sql } = countingDb()
    const reqEnv = { ...env, AQUILLA_PG: db }

    const first = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    expect(first.status).toBe(200)
    expect(sessionQueries(sql)).toHaveLength(2)

    const second = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    expect(second.status).toBe(200)
    expect(sessionQueries(sql)).toHaveLength(2)
    expect(((await second.json()) as { username: string }).username).toBe("cached-one")
  })

  it("re-queries once the TTL has elapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    await seedUser(2, "cached-two")
    const token = await jwtWithJti("cached-two", "jti-ttl")
    const { db, sql } = countingDb()
    const reqEnv = { ...env, AQUILLA_PG: db }

    await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    vi.advanceTimersByTime(SESSION_CACHE_TTL_MS - 1)
    await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    expect(sessionQueries(sql)).toHaveLength(2)

    vi.advanceTimersByTime(2)
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    expect(res.status).toBe(200)
    expect(sessionQueries(sql)).toHaveLength(4)
  })

  it("logout evicts the cached session on this isolate immediately", async () => {
    await seedUser(3, "cached-three")
    const token = await jwtWithJti("cached-three", "jti-logout")

    expect(
      (await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)).status,
    ).toBe(200)
    const logout = await app.request(
      "/api/v2/auth/logout",
      { method: "POST", headers: authHeader(token) },
      env,
    )
    expect(logout.status).toBe(200)

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: expect.stringContaining("revoked") })
  })

  it("a password change on this isolate evicts the user's sessions so the iat cutoff bites at once", async () => {
    await seedUser(5, "cached-five")
    const token = await jwtWithJti("cached-five", "jti-pw")
    expect((await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)).status).toBe(200)

    // What routes/auth.ts's reset handler does: stamp the cutoff, then evict.
    await env.AQUILLA_PG.prepare(
      "UPDATE users SET password_changed_at = to_timestamp(?) WHERE id = 5",
    )
      .bind(Math.floor(Date.now() / 1000) + 60)
      .run()
    evictUserSessions(5)

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: expect.stringContaining("password change") })
  })

  it("caches pre-jti tokens by token hash and never exposes password_hash", async () => {
    await seedUser(4, "cached-four")
    const now = Math.floor(Date.now() / 1000)
    const token = await sign({ sub: "cached-four", iat: now, exp: now + 3600 }, env.SECRET_KEY, "HS256")
    const { db, sql } = countingDb()
    const reqEnv = { ...env, AQUILLA_PG: db }

    await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, reqEnv)
    expect(res.status).toBe(200)
    expect(sessionQueries(sql)).toHaveLength(1) // users only: no jti → no revocation lookup
    expect(JSON.stringify(await res.json())).not.toContain("scrypt:fake")
  })
})
