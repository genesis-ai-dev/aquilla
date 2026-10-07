// AQU-1086: the language-scoped carve-out in the project-settings write
// route. Below the maintainer settings floor a write whose only *changed* keys
// are language keys (`sourceLanguage`, `targetLanguage`, `targetLanes`,
// `archivedLanes`) is allowed — but only when the project's org has lowered
// `languageEditMinRole` far enough.
//
// Mirrors project-settings-termbase-scope.test.ts and guards the same two
// failure modes, in order of severity:
//   1. Lowering the language floor silently widening write access to the rest
//      of project settings (AI config, validation thresholds, health).
//   2. The carve-out never firing in practice, because the client patch is a
//      whole-object read-modify-write and every write echoes back every key —
//      so the gate must key off the DIFF, not off key presence.
//
// The default floor is MAINTAINER (600): with no org setting, everything here
// behaves exactly as it did before this issue.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/**
 * Owner (700), maintainer (600), a contributor (400) and a project lead (500)
 * on one org project. The sub-maintainer members get direct project_members
 * rows — sub-maintainer org membership is not a grant path (AQU-435).
 */
async function seed(orgSettings = "{}", projectSettings = '{"sourceLanguage":"en","targetLanguage":"fr"}') {
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
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  )
    .bind(orgSettings)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Languages', 1, 1)",
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

describe("project-settings language keys (AQU-1595)", () => {
  it("rejects a settings write that includes any of the four keys, and leaves the blob", async () => {
    await seed()
    const res = await patchProjectSettings("bob", {
      sourceLanguage: "es",
      targetLanguage: "de",
      targetLanes: ["sw"],
      archivedLanes: ["sw"],
      validationCount: 2,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/not settings/)
    expect(body.error).toMatch(/lane/i)
    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("en")
    expect(stored.targetLanguage).toBe("fr")
    expect(stored.validationCount).toBeUndefined()
  })

  it("rejects a lead the same way, including when the org lowered the language floor", async () => {
    await seed('{"languageEditMinRole":500}')
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "de",
    })
    expect(res.status).toBe(400)
    expect((await storedSettings()).targetLanguage).toBe("fr")
  })

  it("keeps stored language keys when a maintainer writes other settings without them", async () => {
    await seed()
    const res = await patchProjectSettings("bob", { validationCount: 2, systemPrompt: "be terse" })
    expect(res.status).toBe(200)
    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("en")
    expect(stored.targetLanguage).toBe("fr")
    expect(stored.validationCount).toBe(2)
    expect(stored.systemPrompt).toBe("be terse")
  })

  it("still 403s a lead who changes a non-language key", async () => {
    await seed('{"languageEditMinRole":500}', '{"sourceLanguage":"en","systemPrompt":"keep me"}')
    const res = await patchProjectSettings("dan", { systemPrompt: "be terse" })
    expect(res.status).toBe(403)
    expect((await storedSettings()).systemPrompt).toBe("keep me")
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })
})
