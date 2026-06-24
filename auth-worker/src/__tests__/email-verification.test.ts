import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"

async function register(username: string, email: string): Promise<Response> {
  return app.request(
    "/api/v2/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password: "very-secure" }),
    },
    env,
  )
}

async function verify(token: string): Promise<Response> {
  return app.request(
    "/api/v2/auth/verify-email",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    },
    env,
  )
}

async function tokenFor(username: string): Promise<string | undefined> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT t.token FROM email_verification_tokens t
     JOIN users u ON u.id = t.user_id WHERE u.username = ?`,
  )
    .bind(username)
    .first<{ token: string }>()
  return row?.token
}

describe("email verification", () => {
  it("registration mints a verification token (without blocking signup)", async () => {
    const res = await register("vuser", "vuser@example.com")
    expect(res.status).toBe(200) // signup is never blocked on verification
    expect(await tokenFor("vuser")).toBeTruthy()
  })

  it("verifies the user with a valid token and consumes it", async () => {
    await register("vuser2", "vuser2@example.com")
    const token = await tokenFor("vuser2")
    expect(token).toBeTruthy()

    const res = await verify(token as string)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verified: true })

    const user = await env.AQUILLA_PG.prepare(
      "SELECT email_verified_at FROM users WHERE username = 'vuser2'",
    ).first<{ email_verified_at: string | null }>()
    expect(user?.email_verified_at).toBeTruthy()

    // Single-use: a second click finds no token.
    const again = await verify(token as string)
    expect(again.status).toBe(404)
  })

  it("returns 410 for an expired token", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO users (id, username, email, password_hash) VALUES (50, 'expuser', 'exp@example.com', 'x')",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES (50, 'expiredveriftoken1234567890', '2000-01-01T00:00:00Z')`,
    ).run()
    const res = await verify("expiredveriftoken1234567890")
    expect(res.status).toBe(410)
  })

  it("returns 404 for an unknown token", async () => {
    const res = await verify("doesnotexisttoken1234567890")
    expect(res.status).toBe(404)
  })
})
