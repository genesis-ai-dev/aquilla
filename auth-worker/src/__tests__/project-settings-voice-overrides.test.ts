// AQU-1692 — maintainers' voice corrections (`bibleVoiceOverrides`) on the
// human settings path. Every voice chip, speech rail and "Show every line by …"
// filter reads them, so:
//   - only a maintainer may write them (the general settings floor; there is
//     deliberately no carve-out), because a contributor must not rewrite who
//     speaks for the whole project;
//   - a malformed map is refused rather than stored. This route checks no
//     other key's shape, and the SPA sends the whole blob, so a bad map stored
//     once would ride along on every later save.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "olive") // owner
  await seedUser(2, "mara") // maintainer
  await seedUser(4, "cora") // contributor
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1',4,400,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version) VALUES ('p1', '{}', 0)",
  ).run()
}

const patchProject = async (jwt: string, settings: Record<string, unknown>) =>
  app.request(
    "/api/v2/projects/p1/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify({ settings, ifMatchVersion: 0 }) },
    env,
  )

const stored = async () =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = 'p1'")
      .first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

const correction = {
  "sp:n43004007001-n43004007010": {
    speaker: "person:Jesus",
    note: "Our reading of the verse.",
    by: "mara",
    at: "2026-10-06T12:00:00Z",
  },
}

describe("bibleVoiceOverrides on the settings route", () => {
  it("stores a maintainer's correction", async () => {
    await seed()
    const res = await patchProject(await jwtFor("mara"), { bibleVoiceOverrides: correction })
    expect(res.status).toBe(200)
    expect((await stored()).bibleVoiceOverrides).toEqual(correction)
  })

  it("403s a contributor", async () => {
    await seed()
    const res = await patchProject(await jwtFor("cora"), { bibleVoiceOverrides: correction })
    expect(res.status).toBe(403)
    expect((await stored()).bibleVoiceOverrides).toBeUndefined()
  })

  it("400s a correction with no note, and stores nothing", async () => {
    await seed()
    const res = await patchProject(await jwtFor("mara"), {
      bibleVoiceOverrides: { "sp:a-b": { speaker: "person:Jesus", by: "mara", at: "2026-10-06T12:00:00Z" } },
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/bibleVoiceOverrides/)
    expect((await stored()).bibleVoiceOverrides).toBeUndefined()
  })
})
