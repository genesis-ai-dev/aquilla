// AQU-2305: a project's own import floor — the half auth-worker owns.
//
// sync-worker enforces the floor on `file.create`; this route decides who may
// SET it and what the project's settings response says about it. Two things
// have to hold, and both are about the stricter-only rule rather than the
// picker:
//
//   1. The server REFUSES a project value below the org's floor, naming the
//      org's floor — so writing it through the settings API (a stale client, a
//      script, an agent) cannot loosen an owner-only policy.
//   2. The response carries the floor split org / project own / effective, and
//      a stored value that is NOT stricter reports as following the org — so
//      the Project Settings row and every import affordance read the same
//      answer the perimeter will give.
//
// The ordinary MAINTAINER gate on shared project settings is what stops a
// project lead writing the key at all; that gate is not this ticket's and is
// covered where it lives, but the lead's 403 is pinned here because the
// acceptance criteria name it.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

interface FloorView { org: number; project: number | null; effective: number }

/** One org, one project, and the three people the criteria exercise. */
async function seed(options: {
  orgSettings?: Record<string, unknown>
  projectSettings?: Record<string, unknown>
} = {}) {
  const { orgSettings = {}, projectSettings = {} } = options
  await seedUser(1, "alice") // org owner
  await seedUser(2, "mo") // project maintainer
  await seedUser(3, "lee") // project lead
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  ).bind(JSON.stringify(orgSettings)).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Proj', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', ?, 1, 1)",
  ).bind(JSON.stringify(projectSettings)).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 2, 600, 1), ('proj1', 3, 500, 1)",
  ).run()
}

const getSettings = async (username: string) =>
  app.request("/api/v2/projects/proj1/settings", { headers: authHeader(await jwtFor(username)) }, env)

async function putSettings(
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 1,
): Promise<Response> {
  return app.request(
    "/api/v2/projects/proj1/settings",
    {
      method: "PUT",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

describe("project settings response carries the import floor (AQU-2305)", () => {
  it("reports a project that never set its own as following the organization", async () => {
    await seed({ orgSettings: { importMinRole: 500 } })
    const body = (await (await getSettings("mo")).json()) as { importFloor: FloorView }
    expect(body.importFloor).toEqual({ org: 500, project: null, effective: 500 })
  })

  it("reports the project's own value where stricter, and enforces it", async () => {
    await seed({ orgSettings: { importMinRole: 500 }, projectSettings: { importMinRole: 600 } })
    const body = (await (await getSettings("mo")).json()) as { importFloor: FloorView }
    expect(body.importFloor).toEqual({ org: 500, project: 600, effective: 600 })
  })

  it("reports a NON-stricter stored value as following the organization", async () => {
    // Inert: a 500 written before the org raised its floor to 600 must not
    // read as "this project set its own", and must not lower anything.
    await seed({ orgSettings: { importMinRole: 600 }, projectSettings: { importMinRole: 500 } })
    const body = (await (await getSettings("mo")).json()) as { importFloor: FloorView }
    expect(body.importFloor).toEqual({ org: 600, project: null, effective: 600 })
  })

  it("defaults the org side to project lead when the org never set the key", async () => {
    await seed({ projectSettings: { importMinRole: 600 } })
    const body = (await (await getSettings("mo")).json()) as { importFloor: FloorView }
    expect(body.importFloor).toEqual({ org: 500, project: 600, effective: 600 })
  })
})

describe("writing a project's own import floor (AQU-2305)", () => {
  it("lets a maintainer set a value stricter than the organization's", async () => {
    await seed({ orgSettings: { importMinRole: 500 } })
    const res = await putSettings("mo", { importMinRole: 600 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { importMinRole?: number }; importFloor: FloorView }
    expect(body.settings.importMinRole).toBe(600)
    expect(body.importFloor.effective).toBe(600)
  })

  it("refuses a value below the organization's floor, naming that floor", async () => {
    // The UI never offers this; the refusal is for everything that is not the
    // UI. A project maintainer must not be able to undo an owner-only policy.
    await seed({ orgSettings: { importMinRole: 600 } })
    const res = await putSettings("mo", { importMinRole: 500 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/importMinRole/)
    expect(body.error).toMatch(/600/)
  })

  it("400s a value that is not a role-ladder level", async () => {
    await seed({ orgSettings: { importMinRole: 500 } })
    const res = await putSettings("mo", { importMinRole: 550 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/role level/)
  })

  it("clears the project's value on a save that omits the key", async () => {
    // "Organization default" is the absence of the key, and the lead imports
    // again with the org at project lead.
    await seed({ orgSettings: { importMinRole: 500 }, projectSettings: { importMinRole: 600 } })
    const res = await putSettings("mo", {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: { importMinRole?: number }; importFloor: FloorView }
    expect(body.settings.importMinRole).toBeUndefined()
    expect(body.importFloor).toEqual({ org: 500, project: null, effective: 500 })
  })

  it("lets an unrelated save ride past a stored value unchanged", async () => {
    // Judged on the CHANGE: a project already stricter than its org must still
    // be able to save the rest of its settings.
    await seed({ orgSettings: { importMinRole: 500 }, projectSettings: { importMinRole: 600 } })
    const res = await putSettings("mo", { importMinRole: 600, smartQuotes: true })
    expect(res.status).toBe(200)
  })

  it("403s a project lead, who cannot write shared project settings at all", async () => {
    await seed({ orgSettings: { importMinRole: 500 } })
    const res = await putSettings("lee", { importMinRole: 600 })
    expect(res.status).toBe(403)
  })
})
