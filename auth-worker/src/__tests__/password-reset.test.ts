import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"

// End-to-end coverage for the account-recovery path. The /reset-password PAGE
// (FRO-270) and the SPA edge fallback already make the email link reachable;
// these guard the verify + reset ENDPOINTS the page depends on — the audit's
// #1 risk ("account recovery") was previously untested at the API level.

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

const soon = () => new Date(Date.now() + 3600_000).toISOString()

describe("password reset — verify", () => {
  it("accepts a valid token", async () => {
    await register("ruser", "ruser@example.com", "old-password-1")
    await seedToken("ruser", "validtoken1234567890", soon())
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "validtoken1234567890",
      username: "ruser",
    })
    expect(res.status).toBe(200)
  })

  it("rejects an unknown token (400)", async () => {
    await register("ruser2", "ruser2@example.com", "old-password-1")
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "nopetoken1234567890",
      username: "ruser2",
    })
    expect(res.status).toBe(400)
  })

  it("rejects an expired token (400)", async () => {
    await register("ruser3", "ruser3@example.com", "old-password-1")
    await seedToken("ruser3", "expiredtoken1234567890", "2000-01-01T00:00:00Z")
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "expiredtoken1234567890",
      username: "ruser3",
    })
    expect(res.status).toBe(400)
  })
})

describe("password reset — reset (full recovery loop)", () => {
  it("changes the password, lets the user log in with the new one, and consumes the token", async () => {
    await register("ruser4", "ruser4@example.com", "old-password-1")
    await seedToken("ruser4", "resettoken1234567890", soon())

    const reset = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "resettoken1234567890",
      username: "ruser4",
      new_password: "brand-new-pw-9",
    })
    expect(reset.status).toBe(200)

    // The old password no longer authenticates...
    const oldLogin = await reqJson("/api/v2/auth/token", {
      username: "ruser4",
      password: "old-password-1",
    })
    expect(oldLogin.status).toBe(401)

    // ...and the new one does.
    const newLogin = await reqJson("/api/v2/auth/token", {
      username: "ruser4",
      password: "brand-new-pw-9",
    })
    expect(newLogin.status).toBe(200)

    // The token is single-use — a replay no longer verifies.
    const replay = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "resettoken1234567890",
      username: "ruser4",
    })
    expect(replay.status).toBe(400)
  })

  it("rejects a reset with an expired token (400)", async () => {
    await register("ruser5", "ruser5@example.com", "old-password-1")
    await seedToken("ruser5", "expiredreset1234567890", "2000-01-01T00:00:00Z")
    const res = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "expiredreset1234567890",
      username: "ruser5",
      new_password: "brand-new-pw-9",
    })
    expect(res.status).toBe(400)
  })
})
