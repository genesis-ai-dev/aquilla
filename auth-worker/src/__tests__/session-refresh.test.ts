import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import { authHeader } from "./helpers/db"
import { isPastHalfLife, JWTService } from "../auth/jwt"

// AQU-995: sessions used to die on a fixed 30-day timer with no way to extend
// them — an active translator was dropped mid-edit, and stale tabs retry-looped
// against a dead token. These guard the sliding refresh: an in-use credential
// rolls forward, an idle one still ages out, and expiry is now distinguishable
// from a malformed token in the 401 body.

const LIFETIME_SECONDS = 30 * 24 * 60 * 60

/** Token with an explicit age, so half-life behaviour is asserted without waiting. */
function tokenAged(
  username: string,
  ageSeconds: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds
  return sign(
    { sub: username, iat, exp: iat + LIFETIME_SECONDS, ...extra },
    env.SECRET_KEY,
    "HS256",
  )
}

function register(username: string, email: string, password: string): Promise<Response> {
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

function refresh(token: string): Promise<Response> {
  return app.request(
    "/api/v2/auth/refresh",
    { method: "POST", headers: authHeader(token) },
    env,
  )
}

describe("isPastHalfLife", () => {
  const iat = 1_000_000

  it("is false for a token in the first half of its life", () => {
    expect(isPastHalfLife({ iat, exp: iat + 100 }, iat + 49)).toBe(false)
  })

  it("is true from the half-way point onward", () => {
    expect(isPastHalfLife({ iat, exp: iat + 100 }, iat + 50)).toBe(true)
    expect(isPastHalfLife({ iat, exp: iat + 100 }, iat + 99)).toBe(true)
  })

  it("treats a non-positive lifetime as refreshable rather than special-casing it", () => {
    expect(isPastHalfLife({ iat, exp: iat }, iat)).toBe(true)
  })
})

describe("POST /auth/refresh", () => {
  it("mints a new token once the caller's token is past its half-life", async () => {
    await register("ref1", "ref1@example.com", "some-password-1")
    const old = await tokenAged("ref1", LIFETIME_SECONDS * 0.75)

    const res = await refresh(old)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      access_token: string
      refreshed: boolean
      expires_at: number
    }
    expect(body.refreshed).toBe(true)
    expect(body.access_token).not.toBe(old)

    // The replacement is a working credential with a later expiry.
    const payload = await new JWTService(env).verifyToken(body.access_token)
    expect(payload?.sub).toBe("ref1")
    expect(body.expires_at).toBe(payload?.exp)
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + LIFETIME_SECONDS - 60)

    const me = await app.request("/api/v2/auth/me", { headers: authHeader(body.access_token) }, env)
    expect(me.status).toBe(200)
  })

  it("cannot churn: a token it just minted is immediately below the half-life again", async () => {
    // The producer/consumer loop that matters — a client that keeps calling
    // refresh must not keep getting new credentials. The gate is what stops it,
    // so assert it across a real round-trip rather than on the helper alone.
    await register("ref9", "ref9@example.com", "some-password-1")
    const old = await tokenAged("ref9", LIFETIME_SECONDS * 0.75)

    const first = (await (await refresh(old)).json()) as { access_token: string }
    const second = (await (await refresh(first.access_token)).json()) as {
      access_token: string
      refreshed: boolean
    }

    expect(second.refreshed).toBe(false)
    expect(second.access_token).toBe(first.access_token)
  })

  it("echoes the same token back below the half-life instead of minting churn", async () => {
    await register("ref2", "ref2@example.com", "some-password-1")
    const fresh = await tokenAged("ref2", 60)

    const res = await refresh(fresh)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ access_token: fresh, refreshed: false })
  })

  it("leaves the previous token working, so in-flight requests aren't 401'd", async () => {
    await register("ref3", "ref3@example.com", "some-password-1")
    const old = await tokenAged("ref3", LIFETIME_SECONDS * 0.75)

    const res = await refresh(old)
    expect(res.status).toBe(200)

    const stillWorks = await app.request("/api/v2/auth/me", { headers: authHeader(old) }, env)
    expect(stillWorks.status).toBe(200)
  })

  it("carries the original login time forward across refreshes", async () => {
    await register("ref4", "ref4@example.com", "some-password-1")
    const sessionStart = Math.floor(Date.now() / 1000) - LIFETIME_SECONDS * 2
    const old = await tokenAged("ref4", LIFETIME_SECONDS * 0.75, { sst: sessionStart })

    const res = await refresh(old)
    const { access_token: next } = (await res.json()) as { access_token: string }
    const payload = await new JWTService(env).verifyToken(next)

    // sst survives untouched while iat tracks the new token.
    expect(payload?.sst).toBe(sessionStart)
    expect(payload!.iat).toBeGreaterThan(sessionStart)
  })

  it("seeds sst from iat for a token minted before the claim existed", async () => {
    await register("ref5", "ref5@example.com", "some-password-1")
    const age = LIFETIME_SECONDS * 0.75
    const old = await tokenAged("ref5", age)
    const oldIat = Math.floor(Date.now() / 1000) - age

    const res = await refresh(old)
    const { access_token: next } = (await res.json()) as { access_token: string }
    const payload = await new JWTService(env).verifyToken(next)

    expect(payload?.sst).toBeCloseTo(oldIat, -1)
  })

  it("refuses an already-expired token — an idle session still has to log in", async () => {
    await register("ref6", "ref6@example.com", "some-password-1")
    const iat = Math.floor(Date.now() / 1000) - LIFETIME_SECONDS * 2
    const expired = await sign(
      { sub: "ref6", iat, exp: iat + LIFETIME_SECONDS },
      env.SECRET_KEY,
      "HS256",
    )

    const res = await refresh(expired)
    expect(res.status).toBe(401)
  })

  it("refuses a token invalidated by a password change", async () => {
    await register("ref7", "ref7@example.com", "some-password-1")
    const age = LIFETIME_SECONDS * 0.75
    const old = await tokenAged("ref7", age)
    await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at = ? WHERE username = ?")
      .bind(new Date((Math.floor(Date.now() / 1000) - age + 60) * 1000).toISOString(), "ref7")
      .run()

    const res = await refresh(old)
    expect(res.status).toBe(401)
  })

  it("requires authentication", async () => {
    const res = await app.request("/api/v2/auth/refresh", { method: "POST" }, env)
    expect(res.status).toBe(401)
  })
})

describe("401 bodies distinguish expiry from a bad token", () => {
  it("reports an expired token as token_expired", async () => {
    const iat = Math.floor(Date.now() / 1000) - LIFETIME_SECONDS * 2
    const expired = await sign(
      { sub: "nobody", iat, exp: iat + 60 },
      env.SECRET_KEY,
      "HS256",
    )

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(expired) }, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Token expired", code: "token_expired" })
  })

  it("reports a wrongly-signed token as invalid_token", async () => {
    const now = Math.floor(Date.now() / 1000)
    const forged = await sign({ sub: "nobody", iat: now, exp: now + 3600 }, "not-the-secret", "HS256")

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(forged) }, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "invalid_token" })
  })

  it("rejects a token with no exp claim rather than honouring it forever", async () => {
    await register("ref8", "ref8@example.com", "some-password-1")
    const noExp = await sign(
      { sub: "ref8", iat: Math.floor(Date.now() / 1000) },
      env.SECRET_KEY,
      "HS256",
    )

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(noExp) }, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "invalid_token" })
  })
})
