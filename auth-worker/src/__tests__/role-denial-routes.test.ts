/**
 * AQU-1352 §3.9 rule 2: role-gated 403s on project routes carry the
 * structured role_required body so the client can say which role is needed
 * and what the caller holds — while keeping the legacy `error` string that
 * older clients still read.
 */
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

interface Denial {
  error: string
  code?: string
  required?: { roleLevel: number }
  actual?: { roleLevel: number | null; source: string | null }
}

async function seed() {
  await seedUser(1, "owner")
  await seedUser(2, "maint")
  await seedUser(3, "lead")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 1)").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 1, 700, 1), ('p1', 2, 600, 1), ('p1', 3, 600, 1)`,
  ).run()
}

async function call(username: string, method: string, path: string): Promise<{ status: number; body: Denial }> {
  const res = await app.request(path, { method, headers: authHeader(await jwtFor(username)) }, env)
  return { status: res.status, body: (await res.json()) as Denial }
}

describe("AQU-1352 structured role denials on project routes", () => {
  it("archive by a maintainer: owner required, legacy error kept", async () => {
    await seed()
    const { status, body } = await call("maint", "POST", "/api/v2/projects/p1/archive")
    expect(status).toBe(403)
    expect(body.error).toBe("only owners can archive a project")
    expect(body.code).toBe("role_required")
    expect(body.required?.roleLevel).toBe(700)
    expect(body.actual?.roleLevel).toBe(600)
  })

  it("restore by a maintainer: owner required", async () => {
    await seed()
    const { status, body } = await call("maint", "DELETE", "/api/v2/projects/p1/archive")
    expect(status).toBe(403)
    expect(body.code).toBe("role_required")
    expect(body.required?.roleLevel).toBe(700)
  })

  it("removing a peer maintainer hits the target cap as role_required (owner)", async () => {
    await seed()
    const { status, body } = await call("maint", "DELETE", "/api/v2/projects/p1/members/3")
    expect(status).toBe(403)
    expect(body.error).toMatch(/cannot remove a member whose role/)
    expect(body.code).toBe("role_required")
    expect(body.required?.roleLevel).toBe(700)
    expect(body.actual?.roleLevel).toBe(600)
  })

  it("revoke-all on a peer maintainer hits the target cap as role_required (owner)", async () => {
    await seed()
    const { status, body } = await call("maint", "POST", "/api/v2/projects/p1/members/3/revoke-all")
    expect(status).toBe(403)
    expect(body.error).toMatch(/cannot revoke a member whose role/)
    expect(body.code).toBe("role_required")
    expect(body.required?.roleLevel).toBe(700)
  })
})
