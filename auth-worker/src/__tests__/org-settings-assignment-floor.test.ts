// AQU-1037: assignmentMinRole is an OWNER-only role-ladder policy key.
import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

async function seed(): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

async function patch(
  actor: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 0,
): Promise<Response> {
  return app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(actor)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

describe("org-settings PATCH assignmentMinRole", () => {
  it("lets an owner configure a valid assignment floor", async () => {
    await seed()
    const res = await patch("alice", { assignmentMinRole: 400 })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { settings: Record<string, unknown> }).settings.assignmentMinRole)
      .toBe(400)
  })

  it("rejects a maintainer changing the assignment policy", async () => {
    await seed()
    const res = await patch("bob", { assignmentMinRole: 400 })
    expect(res.status).toBe(403)
  })

  it("rejects values outside the role ladder", async () => {
    await seed()
    const res = await patch("alice", { assignmentMinRole: 350 })
    expect(res.status).toBe(400)
  })

  it("allows a maintainer to echo an unchanged floor", async () => {
    await seed()
    const first = await patch("alice", { assignmentMinRole: 400 })
    const version = ((await first.json()) as { version: number }).version
    const res = await patch("bob", { assignmentMinRole: 400, rules: [] }, version)
    expect(res.status).toBe(200)
  })
})
