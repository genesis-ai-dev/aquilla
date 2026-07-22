import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import {
  LOGIN_MAX_FAILURES_PER_IDENTIFIER,
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
