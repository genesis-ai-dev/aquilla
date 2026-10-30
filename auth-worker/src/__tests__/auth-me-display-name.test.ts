// AQU-2259: onboarding asks "What should we call you?" and used to save the
// answer to a browser key nothing read. It is the account's display name now:
// PATCH /api/v2/auth/me accepts a validated `display_name` (trimmed, at most
// 80 characters; empty clears it back to the username). Every place that
// already reads COALESCE(display_name, username) then shows it.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function patchMe(username: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/auth/me",
    { method: "PATCH", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) },
    env,
  )
}

async function storedDisplayName(id: number): Promise<string | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT display_name FROM users WHERE id = ?").bind(id).first<{ display_name: string | null }>()
  return row?.display_name ?? null
}

describe("PATCH /api/v2/auth/me — display_name (AQU-2259)", () => {
  it("saves a trimmed display name and returns it", async () => {
    await seedUser(1, "ana")
    const res = await patchMe("ana", { display_name: "  Ana Kim  " })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ username: "ana", display_name: "Ana Kim" })
    expect(await storedDisplayName(1)).toBe("Ana Kim")
  })

  it("is what COALESCE(display_name, username) readers show", async () => {
    await seedUser(1, "ana")
    await patchMe("ana", { display_name: "Ana Kim" })
    const row = await env.AQUILLA_PG.prepare(
      "SELECT COALESCE(display_name, username) AS name FROM users WHERE id = 1",
    ).first<{ name: string }>()
    expect(row?.name).toBe("Ana Kim")
  })

  it("clears it back to the username when empty", async () => {
    await seedUser(1, "ana")
    await patchMe("ana", { display_name: "Ana Kim" })
    const res = await patchMe("ana", { display_name: "   " })
    expect(res.status).toBe(200)
    expect(await storedDisplayName(1)).toBeNull()
  })

  it("refuses one longer than 80 characters, or with control characters", async () => {
    await seedUser(1, "ana")
    expect((await patchMe("ana", { display_name: "a".repeat(81) })).status).toBe(400)
    expect((await patchMe("ana", { display_name: "Ana\u0000Kim" })).status).toBe(400)
    expect((await patchMe("ana", { display_name: 42 })).status).toBe(400)
    expect(await storedDisplayName(1)).toBeNull()
  })

  it("leaves preferences alone when only the name changes", async () => {
    await seedUser(1, "ana")
    await patchMe("ana", { preferences: { theme: "dark" } })
    const res = await patchMe("ana", { display_name: "Ana" })
    expect(await res.json()).toMatchObject({ preferences: { theme: "dark" }, display_name: "Ana" })
  })
})
