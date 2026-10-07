// AQU-1686: the settings route checks `bibleEnrichments` the way the Agent API
// does. Before this, the Save path stored any value ({voices: "off"} went in
// with 200) and the settings card showed a stored string as a switch that is
// on. Readers ignore bad values, so this is about what gets stored and shown.
//
// The client sends the whole settings object on every save, so a bad value
// already stored must not block saving everything else.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed(projectSettings: Record<string, unknown> = { sourceLanguage: "en" }) {
  await seedUser(1, "alice") // org owner
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
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Bible data', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(projectSettings))
    .run()
}

async function save(settings: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("alice")),
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

describe("project settings: bibleEnrichments (AQU-1686)", () => {
  it("stores known ids with boolean values", async () => {
    await seed()
    const res = await save({ sourceLanguage: "en", bibleEnrichments: { voices: false, autopilot: true } })
    expect(res.status).toBe(200)
    expect((await storedSettings()).bibleEnrichments).toEqual({ voices: false, autopilot: true })
  })

  it("refuses a value that is not a boolean, and stores nothing", async () => {
    await seed()
    const res = await save({ sourceLanguage: "en", bibleEnrichments: { voices: "off" } })
    expect(res.status).toBe(400)
    expect((await storedSettings()).bibleEnrichments).toBeUndefined()
  })

  it("refuses an unknown enrichment id", async () => {
    await seed()
    const res = await save({ sourceLanguage: "en", bibleEnrichments: { nope: true } })
    expect(res.status).toBe(400)
  })

  it("accepts null, which clears the key", async () => {
    await seed({ sourceLanguage: "en", bibleEnrichments: { voices: false } })
    const res = await save({ sourceLanguage: "en", bibleEnrichments: null })
    expect(res.status).toBe(200)
  })

  it("lets an older bad value through unchanged, so the rest still saves", async () => {
    await seed({ sourceLanguage: "en", bibleEnrichments: { voices: "off" } })
    const res = await save({ sourceLanguage: "fr", bibleEnrichments: { voices: "off" } })
    expect(res.status).toBe(200)
    expect((await storedSettings()).sourceLanguage).toBe("fr")
  })
})
