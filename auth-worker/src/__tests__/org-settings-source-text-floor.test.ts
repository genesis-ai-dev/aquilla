// AQU-2647: the org default for who may edit source text.
//
// The settings blob is replaced wholesale. A client that saved before this
// key existed must not wipe a stored tier — that is how "Biblica ETT" keeps
// Project Lead after the migration. A project member who is not in the org
// still receives the org's tier on the project settings response, which is
// what the project picker inherits.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed(initialSettings = "{}") {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  )
    .bind(initialSettings)
    .run()
}

async function patchSettings(jwt: string, settings: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(jwt),
      body: JSON.stringify({ settings, ifMatchVersion: 0 }),
    },
    env,
  )
}

describe("org-settings sourceTextFloor (AQU-2647)", () => {
  it("keeps a stored Project Lead when the save omits the key", async () => {
    await seed('{"sourceTextFloor":"project_lead"}')
    const kept = await patchSettings(await jwtFor("bob"), { rules: [] })
    expect(kept.status).toBe(200)
    const keptBody = (await kept.json()) as { settings: { sourceTextFloor?: string } }
    expect(keptBody.settings.sourceTextFloor).toBe("project_lead")
  })

  it("replaces the stored tier when a rung is sent", async () => {
    await seed('{"sourceTextFloor":"project_lead"}')
    const replaced = await patchSettings(await jwtFor("alice"), { sourceTextFloor: "maintainer" })
    expect(replaced.status).toBe(200)
    const replacedBody = (await replaced.json()) as { settings: { sourceTextFloor?: string } }
    expect(replacedBody.settings.sourceTextFloor).toBe("maintainer")
  })

  it("rejects a value that is not a rung", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("alice"), { sourceTextFloor: "owner" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/sourceTextFloor/)
  })
})

describe("project settings carries the org source-text floor (AQU-2647)", () => {
  async function seedProject(orgSettings: Record<string, unknown>) {
    await seed(JSON.stringify(orgSettings))
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Proj', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', '{}', 1, 1)",
    ).run()
    await seedUser(6, "pat")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 6, 500, 1)",
    ).run()
  }

  async function projectSettings() {
    const res = await app.request(
      "/api/v2/projects/proj1/settings",
      { headers: authHeader(await jwtFor("pat")) },
      env,
    )
    expect(res.status).toBe(200)
    return (await res.json()) as { orgSourceTextFloor?: string | null }
  }

  it("returns the org tier to a project member who cannot read the org", async () => {
    await seedProject({ sourceTextFloor: "project_lead" })
    const orgRes = await app.request(
      "/api/v2/orgs/1/settings",
      { headers: authHeader(await jwtFor("pat")) },
      env,
    )
    expect(orgRes.status).toBe(403)
    expect((await projectSettings()).orgSourceTextFloor).toBe("project_lead")
  })

  it("returns null when the org set none, so the project uses Maintainer", async () => {
    await seedProject({})
    expect((await projectSettings()).orgSourceTextFloor).toBeNull()
  })
})
