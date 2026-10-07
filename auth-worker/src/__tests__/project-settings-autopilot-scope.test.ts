// AQU-1246: the `autopilotEnabled` carve-out in the project-settings write
// route. Whether a project gets the experimental Autopilot surface at all is a
// project decision with a real floor — project_lead(500)+ — rather than the
// device-local, any-member, one-click switch it used to be.
//
// What this guards, in order of severity:
//   1. The gate being client-only. "Non-Owner/Lead cannot opt a project in" is
//      an acceptance criterion, and a hidden toggle is not a permission — a
//      contributor hitting the API directly must get a 403.
//   2. The carve-out widening anything else. Admitting one key below the
//      maintainer floor must not admit AI config, languages, or thresholds.
//   3. The carve-out never firing in practice, because the client patch is a
//      whole-object read-modify-write and every write echoes back every key —
//      so the gate must key off the DIFF, not off key presence.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/**
 * Owner (700), maintainer (600), a contributor (400) and a lead (500) on one
 * org project. The sub-maintainer members get direct project_members rows —
 * sub-maintainer org membership is not a grant path (AQU-435).
 */
async function seed(projectSettings = '{"sourceLanguage":"en"}') {
  await seedUser(1, "alice") // org owner
  await seedUser(2, "bob") // org maintainer
  await seedUser(3, "carla") // project contributor
  await seedUser(4, "dan") // project lead
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Autopilot', 1, 1)",
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

async function patchProjectSettings(
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 1,
): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion }),
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

describe("project-settings autopilot carve-out (AQU-1246)", () => {
  it("lets a project lead opt the project in", async () => {
    await seed()
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en", // unchanged echo — the client sends the whole object
      autopilotEnabled: true,
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).autopilotEnabled).toBe(true)
  })

  it("lets a maintainer opt the project in", async () => {
    await seed()
    const res = await patchProjectSettings("bob", { sourceLanguage: "en", autopilotEnabled: true })
    expect(res.status).toBe(200)
    expect((await storedSettings()).autopilotEnabled).toBe(true)
  })

  it("403s a contributor opting the project in — server-enforced, not just a hidden toggle", async () => {
    await seed()
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      autopilotEnabled: true,
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).autopilotEnabled).toBeUndefined()
  })

  it("403s a contributor opting the project back OUT of an enabled project", async () => {
    // Both directions are the same permission: a contributor must not be able
    // to yank a surface the team is mid-run on, any more than reveal one.
    await seed('{"sourceLanguage":"en","autopilotEnabled":true}')
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      autopilotEnabled: false,
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).autopilotEnabled).toBe(true)
  })

  it("403s a below-maintainer write that changes any other key alongside the opt-in", async () => {
    // The carve-out is scoped to a write that changes NOTHING ELSE. A lead
    // bundling a language change with the opt-in gets the maintainer 403 for
    // the whole patch — admitting one key must never smuggle in another.
    await seed()
    const bundled = await patchProjectSettings("dan", {
      sourceLanguage: "fr",
      autopilotEnabled: true,
    })
    expect(bundled.status).toBe(403)
    const stored = await storedSettings()
    expect(stored.autopilotEnabled).toBeUndefined()
    expect(stored.sourceLanguage).toBe("en")
  })

  it("403s a lead's write that changes only a non-autopilot key", async () => {
    // Sanity: the carve-out did not lower the floor for everything else.
    await seed()
    const res = await patchProjectSettings("dan", { sourceLanguage: "fr" })
    expect(res.status).toBe(403)
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })

  it("keys off the DIFF — a lead echoing an unchanged opt-in changes nothing and is not admitted extra access", async () => {
    // The echo case: the client re-sends autopilotEnabled on every patch. An
    // echo alone is not a change, so a patch that also moves another key is
    // still judged on that other key.
    await seed('{"sourceLanguage":"en","autopilotEnabled":true}')
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "fr",
      autopilotEnabled: true, // echoed, unchanged
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })
})
