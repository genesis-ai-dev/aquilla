import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import {
  LOGIN_MAX_FAILURES_PER_IDENTIFIER,
  PASSWORD_RESET_ATTEMPT_MAX_FAILURES,
  RESET_REQUEST_MAX_PER_IDENTIFIER,
} from "../utils/rate-limit"

// [Pen test] Auth & session mgmt (2026-07-20): POST /token and
// /password-reset/request previously had no attempt limiting at all —
// unthrottled credential stuffing / password guessing, and unthrottled
// password-reset email bombing of a victim's inbox. These guard the fix.

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

function login(username: string, password: string): Promise<Response> {
  return reqJson("/api/v2/auth/token", { username, password })
}

describe("login attempt throttling", () => {
  it("locks out further attempts after too many failures for the same account", async () => {
    await register("rl1", "rl1@example.com", "correct-password-1")

    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IDENTIFIER; i++) {
      const res = await login("rl1", "wrong-password")
      expect(res.status).toBe(401)
    }

    // The next attempt is throttled — even with the CORRECT password, proving
    // this is a hard lockout and not just "still guessing wrong".
    const throttled = await login("rl1", "correct-password-1")
    expect(throttled.status).toBe(429)
  })

  it("does not throttle a user who only fails a couple of times", async () => {
    await register("rl2", "rl2@example.com", "correct-password-1")
    await login("rl2", "wrong-password")
    await login("rl2", "wrong-password")

    const res = await login("rl2", "correct-password-1")
    expect(res.status).toBe(200)
  })

  it("throttling one account does not lock out a different account", async () => {
    await register("rl3", "rl3@example.com", "correct-password-1")
    await register("rl3b", "rl3b@example.com", "correct-password-1")

    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IDENTIFIER; i++) {
      await login("rl3", "wrong-password")
    }
    expect((await login("rl3", "correct-password-1")).status).toBe(429)

    // A different account, same test run — unaffected.
    expect((await login("rl3b", "correct-password-1")).status).toBe(200)
  })
})

describe("password-reset request throttling", () => {
  it("keeps returning the generic message past the per-address limit (no oracle)", async () => {
    await register("rl4", "rl4@example.com", "correct-password-1")

    for (let i = 0; i < RESET_REQUEST_MAX_PER_IDENTIFIER + 3; i++) {
      const res = await reqJson("/api/v2/auth/password-reset/request", { email: "rl4@example.com" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: "Password reset link sent to your email" })
    }

    // No reset token should exist beyond the allowed number of requests —
    // proves the throttle actually stopped minting new tokens, not just that
    // the response stayed generic.
    const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = 'rl4'")
      .first<{ id: number }>()
    const tokens = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = ?",
    )
      .bind(u!.id)
      .first<{ n: number }>()
    // ON CONFLICT(token) DO UPDATE means most iterations mint fresh distinct
    // tokens (crypto.randomUUID()) up to the throttle, then stop entirely.
    expect(tokens!.n).toBeLessThanOrEqual(RESET_REQUEST_MAX_PER_IDENTIFIER)
  })
})

// [Pen test] Auth & session mgmt (2026-08-10): /password-reset/verify and
// /password-reset/reset were the only two auth endpoints with no attempt
// limiting at all. Guard the throttle so a caller who repeatedly submits a
// wrong token for the same username gets locked out, and so a legitimate
// user's own successful reset is never affected by someone else's failures.
describe("password-reset verify/reset attempt throttling", () => {
  it("locks out further verify attempts after too many wrong tokens for the same username", async () => {
    await register("rl5", "rl5@example.com", "correct-password-1")

    for (let i = 0; i < PASSWORD_RESET_ATTEMPT_MAX_FAILURES; i++) {
      const res = await reqJson("/api/v2/auth/password-reset/verify", {
        username: "rl5",
        token: "not-a-real-token",
      })
      expect(res.status).toBe(400)
    }

    // Next attempt is throttled even with a real, valid token.
    await seedToken("rl5", "rl5-real-token", soon())
    const throttled = await reqJson("/api/v2/auth/password-reset/verify", {
      username: "rl5",
      token: "rl5-real-token",
    })
    expect(throttled.status).toBe(429)
  })

  it("locks out further reset attempts after too many wrong tokens for the same username", async () => {
    await register("rl6", "rl6@example.com", "correct-password-1")

    for (let i = 0; i < PASSWORD_RESET_ATTEMPT_MAX_FAILURES; i++) {
      const res = await reqJson("/api/v2/auth/password-reset/reset", {
        username: "rl6",
        token: "not-a-real-token",
        new_password: "new-password-1",
      })
      expect(res.status).toBe(400)
    }

    await seedToken("rl6", "rl6-real-token", soon())
    const throttled = await reqJson("/api/v2/auth/password-reset/reset", {
      username: "rl6",
      token: "rl6-real-token",
      new_password: "new-password-1",
    })
    expect(throttled.status).toBe(429)
  })

  it("does not throttle a user who only fails a couple of verify attempts", async () => {
    await register("rl7", "rl7@example.com", "correct-password-1")
    await reqJson("/api/v2/auth/password-reset/verify", { username: "rl7", token: "wrong" })
    await reqJson("/api/v2/auth/password-reset/verify", { username: "rl7", token: "wrong" })

    await seedToken("rl7", "rl7-real-token", soon())
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      username: "rl7",
      token: "rl7-real-token",
    })
    expect(res.status).toBe(200)
  })

  it("throttling one username does not lock out a different username", async () => {
    await register("rl8", "rl8@example.com", "correct-password-1")
    await register("rl8b", "rl8b@example.com", "correct-password-1")

    for (let i = 0; i < PASSWORD_RESET_ATTEMPT_MAX_FAILURES; i++) {
      await reqJson("/api/v2/auth/password-reset/verify", { username: "rl8", token: "wrong" })
    }
    const throttled = await reqJson("/api/v2/auth/password-reset/verify", {
      username: "rl8",
      token: "wrong",
    })
    expect(throttled.status).toBe(429)

    await seedToken("rl8b", "rl8b-real-token", soon())
    const other = await reqJson("/api/v2/auth/password-reset/verify", {
      username: "rl8b",
      token: "rl8b-real-token",
    })
    expect(other.status).toBe(200)
  })
})

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
