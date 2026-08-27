// AQU-994: a transient DB failure during user hydration must NOT masquerade
// as an auth failure. During the 2026-08-25 Postgres/Hyperdrive blip,
// authMiddleware answered 401 "User not found" for every authenticated
// request (getUserByUsername swallowed the connection error into null), and
// the SPA responded by force-logging active editors out — and revoking their
// still-valid tokens server-side. These pin the fix: lookup failure → 503
// (retryable), while a genuinely missing user row still → 401.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { jwtFor, authHeader, seedUser } from "./helpers/db"

/** An AQUILLA_PG whose every statement rejects — a full connection outage. */
function outageDb(): typeof env.AQUILLA_PG {
  const fail = async (): Promise<never> => {
    throw new Error("simulated Hyperdrive connection failure")
  }
  const stmt = { bind: () => stmt, first: fail, run: fail, all: fail, raw: fail }
  return { prepare: () => stmt } as unknown as typeof env.AQUILLA_PG
}

describe("authMiddleware under DB outage (AQU-994)", () => {
  it("answers 503 (not 401) when the user lookup query fails", async () => {
    // Valid signature, no jti (so the fail-open revocation check is skipped
    // and the first DB touch is the user hydration itself).
    const token = await jwtFor("outage-victim")
    const res = await app.request(
      "/api/v2/auth/me",
      { headers: authHeader(token) },
      { ...env, AQUILLA_PG: outageDb() },
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    // Must not carry the auth-failure wording the SPA reacts to.
    expect(body.error).not.toContain("not found")
    expect(body.error).toContain("retry")
  })

  it("still answers 401 User not found for a genuinely missing user row", async () => {
    const token = await jwtFor("no-such-user")
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "User not found" })
  })

  it("still authenticates a real user against a healthy DB", async () => {
    await seedUser(4711, "outage-sanity")
    const token = await jwtFor("outage-sanity")
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
  })
})
