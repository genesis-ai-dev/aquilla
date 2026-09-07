import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { sha256Hex } from "../../../db/shared/api-credentials"

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

async function rowFor(username: string): Promise<{ token_hash: string | null } | null> {
  return env.AQUILLA_PG.prepare(
    `SELECT t.token_hash FROM email_verification_tokens t
     JOIN users u ON u.id = t.user_id WHERE u.username = ?`,
  )
    .bind(username)
    .first<{ token_hash: string | null }>()
}

/** OPS-20: the plaintext is only ever in the emailed link, so a test that
 *  needs a usable token has to plant one rather than read one back. */
async function seedHashedToken(username: string, token: string, expiresAt: string): Promise<void> {
  const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
  )
    .bind(u!.id, await sha256Hex(token), expiresAt)
    .run()
}

const week = () => new Date(Date.now() + 7 * 24 * 3600_000).toISOString()

describe("email verification", () => {
  it("registration mints a verification token (without blocking signup)", async () => {
    const res = await register("vuser", "vuser@example.com")
    expect(res.status).toBe(200) // signup is never blocked on verification
    const row = await rowFor("vuser")
    expect(row?.token_hash).toBeTruthy()
  })

  // [Pen test] Auth & session mgmt (2026-08-24), OPS-20: the token minted at
  // registration must not be recoverable from the table — a read-only copy of
  // this row is not supposed to be a usable verification link. Since OPS-27
  // (migration 0087) the guarantee is structural: there is no column a
  // plaintext token could be written to, so assert the schema, not just the
  // value. A future change that re-added the column would fail here.
  it("stores the verification token as a digest, with no plaintext column to leak", async () => {
    await register("vuser-hash", "vuser-hash@example.com")
    const row = await rowFor("vuser-hash")
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/)

    const plaintextColumn = await env.AQUILLA_PG.prepare(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'email_verification_tokens' AND column_name = 'token'`,
    ).first<{ column_name: string }>()
    expect(plaintextColumn).toBeNull()
  })

  it("verifies the user with a valid token and consumes it", async () => {
    await register("vuser2", "vuser2@example.com")
    // Clear the registration-minted row and plant one whose plaintext we know.
    await env.AQUILLA_PG.prepare(
      "DELETE FROM email_verification_tokens WHERE user_id = (SELECT id FROM users WHERE username = 'vuser2')",
    ).run()
    const token = "known-verification-token-vuser2"
    await seedHashedToken("vuser2", token, week())

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

  // [Pen test] Auth & session mgmt (2026-09-07), OPS-27: this used to seed a
  // PLAINTEXT row to cover 0080's `token_hash IS NULL` fallback arm. The
  // 7-day window closed on 2026-08-31 and migration 0087 dropped the column,
  // so the row is now seeded in the shipping digest shape — the expiry
  // behaviour it asserts is worth keeping, the rollover shape is not.
  it("returns 410 for an expired token", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO users (id, username, email, password_hash) VALUES (50, 'expuser', 'exp@example.com', 'x')",
    ).run()
    await seedHashedToken("expuser", "expiredveriftoken1234567890", "2000-01-01T00:00:00Z")
    const res = await verify("expiredveriftoken1234567890")
    expect(res.status).toBe(410)
  })

  it("returns 404 for an unknown token", async () => {
    const res = await verify("doesnotexisttoken1234567890")
    expect(res.status).toBe(404)
  })
})
