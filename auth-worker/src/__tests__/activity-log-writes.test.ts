import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { jwtFor, authHeader } from "./helpers/db"

// [Pen test] Auth & session mgmt (2026-07-20): activity_logs existed (and
// GET /activity-log read from it) but nothing ever wrote to it — no audit
// trail for logins, failed logins, or password-reset events. These guard
// the new writes.

async function reqJson(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
}

async function activityTypes(username: string): Promise<string[]> {
  const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT activity_type FROM activity_logs WHERE user_id = ? ORDER BY id",
  )
    .bind(u!.id)
    .all<{ activity_type: string }>()
  return rows.results.map((r) => r.activity_type)
}

describe("auth events populate activity_logs", () => {
  it("logs register, successful login, and failed login", async () => {
    await reqJson("/api/v2/auth/register", {
      username: "act1",
      email: "act1@example.com",
      password: "correct-password-1",
    })
    await reqJson("/api/v2/auth/token", { username: "act1", password: "wrong" })
    await reqJson("/api/v2/auth/token", { username: "act1", password: "correct-password-1" })

    expect(await activityTypes("act1")).toEqual(["register", "login_failed", "login"])
  })

  it("logs password-reset request and completion, and both are visible via GET /activity-log", async () => {
    await reqJson("/api/v2/auth/register", {
      username: "act2",
      email: "act2@example.com",
      password: "correct-password-1",
    })
    await reqJson("/api/v2/auth/password-reset/request", { email: "act2@example.com" })

    const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = 'act2'")
      .first<{ id: number }>()
    const tokenRow = await env.AQUILLA_PG.prepare(
      "SELECT token FROM password_reset_tokens WHERE user_id = ?",
    )
      .bind(u!.id)
      .first<{ token: string }>()
    await reqJson("/api/v2/auth/password-reset/reset", {
      token: tokenRow!.token,
      username: "act2",
      new_password: "brand-new-pw-9",
    })

    expect(await activityTypes("act2")).toEqual([
      "register",
      "password_reset_requested",
      "password_reset_completed",
    ])

    const token = await jwtFor("act2")
    const res = await app.request("/api/v2/auth/activity-log", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ activity_type: string }>
    expect(body.map((b) => b.activity_type)).toEqual([
      "password_reset_completed",
      "password_reset_requested",
      "register",
    ])
  })
})
