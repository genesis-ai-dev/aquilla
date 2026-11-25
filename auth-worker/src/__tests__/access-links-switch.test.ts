// AQU-2686: PIN access links sit behind ACCESS_LINKS_ENABLED. Deployed
// environments set it to "false"; the shared test env turns it on so the
// feature's own suites run, and this file covers the off state.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { accessLinksEnabled } from "../routes/access-links"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

type SwitchValue = string | undefined

function envWith(value: SwitchValue) {
  return { ...env, ACCESS_LINKS_ENABLED: value }
}

async function seedProject(projectId: string): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "translator")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(projectId, "Test", 1)
    .run()
  // AQU-2357: creation writes this Owner row. created_by grants alice nothing.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 700, 1)",
  )
    .bind(projectId)
    .run()
}

async function mint(value: SwitchValue): Promise<Response> {
  return app.request(
    "/api/v2/access-links",
    {
      method: "POST",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify({ projectId: "proj-switch", userId: 2, pin: "4821" }),
    },
    envWith(value),
  )
}

async function redeem(token: string, value: SwitchValue): Promise<Response> {
  return app.request(
    `/api/v2/access-links/${token}/redeem`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "4821" }) },
    envWith(value),
  )
}

async function revoke(token: string, value: SwitchValue): Promise<Response> {
  return app.request(
    `/api/v2/access-links/${token}/revoke`,
    { method: "POST", headers: authHeader(await jwtFor("alice")) },
    envWith(value),
  )
}

async function linkRow(token: string) {
  return env.AQUILLA_PG.prepare(
    "SELECT failed_attempts, last_used_at, revoked_at FROM project_access_links WHERE token = ?",
  )
    .bind(token)
    .first<{ failed_attempts: number; last_used_at: string | null; revoked_at: string | null }>()
}

describe("ACCESS_LINKS_ENABLED switch (AQU-2686)", () => {
  it("is on only for the exact string \"true\"", () => {
    expect(accessLinksEnabled({ ACCESS_LINKS_ENABLED: "true" })).toBe(true)
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(accessLinksEnabled({ ACCESS_LINKS_ENABLED: value })).toBe(false)
    }
  })

  it.each([undefined, "false"])("refuses to mint when the switch is %s, and writes nothing", async (value) => {
    await seedProject("proj-switch")

    const res = await mint(value)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "PIN access links are switched off." })

    const count = await env.AQUILLA_PG.prepare("SELECT COUNT(*) AS n FROM project_access_links")
      .first<{ n: number | string }>()
    expect(Number(count?.n)).toBe(0)
    const member = await env.AQUILLA_PG.prepare(
      "SELECT 1 AS hit FROM project_members WHERE project_id = ? AND user_id = ?",
    )
      .bind("proj-switch", 2)
      .first()
    expect(member).toBeNull()
  })

  it("stops a link made while the switch was on from signing anyone in, without touching it", async () => {
    await seedProject("proj-switch")
    const minted = await mint("true")
    expect(minted.status).toBe(200)
    const { token } = (await minted.json()) as { token: string }

    const res = await redeem(token, "false")
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.access_token).toBeUndefined()

    const row = await linkRow(token)
    expect(row?.failed_attempts).toBe(0)
    expect(row?.last_used_at).toBeNull()
  })

  it("refuses to revoke while switched off, and redeem works again once it is back on", async () => {
    await seedProject("proj-switch")
    const minted = await mint("true")
    const { token } = (await minted.json()) as { token: string }

    const off = await revoke(token, undefined)
    expect(off.status).toBe(404)
    expect((await linkRow(token))?.revoked_at).toBeNull()

    const on = await redeem(token, "true")
    expect(on.status).toBe(200)
  })
})
