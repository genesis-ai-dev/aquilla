import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { jwtFor, authHeader } from "./helpers/db"

// [Pen test] Auth & session mgmt (2026-07-20): a password reset previously
// did nothing to the access tokens already issued for the account — a
// stolen/leaked JWT kept authenticating for up to 30 more days (the default
// ACCESS_TOKEN_EXPIRE_MINUTES). These guard the fix: authMiddleware now
// rejects any token whose `iat` predates users.password_changed_at.

async function reqJson(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
}

function register(username: string, email: string, password: string): Promise<Response> {
  return reqJson("/api/v2/auth/register", { username, email, password })
}

async function setPasswordChangedAt(username: string, iso: string): Promise<void> {
  await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at = ? WHERE username = ?")
    .bind(iso, username)
    .run()
}

async function seedToken(username: string, token: string, expiresAt: string): Promise<void> {
  const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
  )
    .bind(u!.id, token, expiresAt)
    .run()
}

describe("password_changed_at floor on access-token validity", () => {
  it("rejects a token whose iat is before password_changed_at", async () => {
    await register("sess1", "sess1@example.com", "old-password-1")
    const iat = Math.floor(Date.now() / 1000) - 100
    const token = await jwtFor("sess1", iat)

    // No reset yet — token is valid.
    const before = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(before.status).toBe(200)

    // Reset stamped strictly after the token's iat (deterministic — no reliance
    // on wall-clock timing between minting the token and the assertion below).
    await setPasswordChangedAt("sess1", new Date((iat + 50) * 1000).toISOString())

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: expect.stringContaining("password change") })
  })

  it("accepts a token whose iat is after password_changed_at", async () => {
    await register("sess2", "sess2@example.com", "old-password-1")
    const iat = Math.floor(Date.now() / 1000)
    await setPasswordChangedAt("sess2", new Date((iat - 100) * 1000).toISOString())
    const token = await jwtFor("sess2", iat)

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
  })

  it("never having reset a password imposes no floor on token validity", async () => {
    await register("sess3", "sess3@example.com", "some-password-1")
    const token = await jwtFor("sess3")
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
  })
})

describe("password-reset/reset end to end", () => {
  it("a token issued before the reset stops authenticating once the reset completes", async () => {
    await register("sess4", "sess4@example.com", "old-password-1")
    // iat in the past relative to the reset stamped below (CURRENT_TIMESTAMP at
    // request time) — avoids any same-second race with the real endpoint call,
    // while staying well inside the token's 1-hour exp window.
    const staleToken = await jwtFor("sess4", Math.floor(Date.now() / 1000) - 300)

    const preCheck = await app.request("/api/v2/auth/me", { headers: authHeader(staleToken) }, env)
    expect(preCheck.status).toBe(200)

    await seedToken("sess4", "resettoken-sess4", new Date(Date.now() + 3600_000).toISOString())
    const reset = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "resettoken-sess4",
      username: "sess4",
      new_password: "brand-new-pw-9",
    })
    expect(reset.status).toBe(200)

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(staleToken) }, env)
    expect(after.status).toBe(401)

    const login = await reqJson("/api/v2/auth/token", { username: "sess4", password: "brand-new-pw-9" })
    expect(login.status).toBe(200)
    const { access_token: freshToken } = (await login.json()) as { access_token: string }
    const afterFresh = await app.request("/api/v2/auth/me", { headers: authHeader(freshToken) }, env)
    expect(afterFresh.status).toBe(200)
  })
})
