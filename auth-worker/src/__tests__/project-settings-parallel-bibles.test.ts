// The `parallelBibleVersions` carve-out in the project-settings write route:
// the team's default Parallel Bibles versions. A project lead (500)+ may set
// them from the panel; a contributor gets a 403 from the server, not only a
// hidden button, and the carve-out never admits any other key.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** Owner (700), a contributor (400) and a lead (500) on one org project. */
async function seed(projectSettings = '{"systemPrompt":"keep"}') {
  await seedUser(1, "alice") // org owner
  await seedUser(3, "carla") // project contributor
  await seedUser(4, "dan") // project lead
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Bibles', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 3, 400, 1), ('p1', 4, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(projectSettings)
    .run()
}

async function putSettings(username: string, settings: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PUT",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion: 1 }),
    },
    env,
  )
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

const DEFAULTS = ["grc_sbl", "hbo_wlc", "BSB"]

describe("project-settings parallelBibleVersions carve-out", () => {
  it("lets a project lead set the project's default versions", async () => {
    await seed()
    const res = await putSettings("dan", { systemPrompt: "keep", parallelBibleVersions: DEFAULTS })
    expect(res.status).toBe(200)
    expect((await storedSettings()).parallelBibleVersions).toEqual(DEFAULTS)
  })

  it("403s a contributor setting the defaults, and stores nothing", async () => {
    await seed()
    const res = await putSettings("carla", { systemPrompt: "keep", parallelBibleVersions: DEFAULTS })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/project lead/)
    expect((await storedSettings()).parallelBibleVersions).toBeUndefined()
  })

  it("403s a lead who bundles another key with the defaults", async () => {
    await seed()
    const res = await putSettings("dan", { systemPrompt: "changed", parallelBibleVersions: DEFAULTS })
    expect(res.status).toBe(403)
    const stored = await storedSettings()
    expect(stored.systemPrompt).toBe("keep")
    expect(stored.parallelBibleVersions).toBeUndefined()
  })

  it.each([
    ["not a list", "BSB"],
    ["a duplicate", ["BSB", "BSB"]],
    ["an empty id", [""]],
    ["too many", Array.from({ length: 13 }, (_, i) => `V${i}`)],
  ])("400s %s", async (_label, value) => {
    await seed()
    const res = await putSettings("dan", { systemPrompt: "keep", parallelBibleVersions: value })
    expect(res.status).toBe(400)
    expect((await storedSettings()).parallelBibleVersions).toBeUndefined()
  })
})
