// AQU-1595: the four project-language keys (`sourceLanguage`, `targetLanguage`,
// `targetLanes`, `archivedLanes`) are lane rows, not settings. The settings
// write route refuses a body that includes any of them, whoever the caller is,
// and a body that omits them keeps the stored copies (history is not
// rewritten). The AQU-1086 language-only carve-out therefore never fires: a
// lead's language edit goes through the lane routes, which carry the org's
// `languageEditMinRole` floor. Absence of that key is Project lead (AQU-984);
// a stored floor, including an explicit Maintainer (600), is kept.
//
// Guards, in order of severity:
//   1. A language key can never ride a settings write past the maintainer
//      floor, bundled with other keys or alone.
//   2. The language floor must not widen write access to the rest of project
//      settings (AI config, validation thresholds, health).
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
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES
      ('ln-src', 'p1', 'source', 'English', NULL, 0),
      ('ln-main', 'p1', 'target', 'French', '', 1)`,
  ).run()
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

async function patchLane(username: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/lanes/ln-main",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify(body),
    },
    env,
  )
}

async function storedLaneLanguage(): Promise<string | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT language FROM lanes WHERE id = 'ln-main'",
  ).first<{ language: string | null }>()
  return row?.language ?? null
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

// The floor the settings carve-out used to apply now guards the lane routes
// (`denyLanguageWrite`). The claims are AQU-1086's and AQU-984's, unchanged.
describe("lane writes carry the language-edit floor (AQU-1086 / AQU-984)", () => {
  it("lets a project lead change a lane's language when the org floor is 500", async () => {
    await seed('{"languageEditMinRole":500}')
    const res = await patchLane("dan", { language: "German" })
    expect(res.status).toBe(200)
    expect(await storedLaneLanguage()).toBe("German")
  })

  it("lets a project lead change a lane's language when the org has not set a floor (AQU-984)", async () => {
    await seed() // key absent — never set, so the default is project lead
    const res = await patchLane("dan", { language: "German" })
    expect(res.status).toBe(200)
    expect(await storedLaneLanguage()).toBe("German")
  })

  it("403s a project lead when the org explicitly stored maintainer, and names that role", async () => {
    await seed('{"languageEditMinRole":600}')
    const res = await patchLane("dan", { language: "German" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      error: string
      code: string
      required: { roleLevel: number }
    }
    expect(body.code).toBe("role_required")
    expect(body.required.roleLevel).toBe(600)
    expect(body.error).toMatch(/maintainer/i)
    expect(await storedLaneLanguage()).toBe("French")
  })

  it("403s a contributor (400) either way — the floor only reaches project lead", async () => {
    await seed('{"languageEditMinRole":500}')
    const lowered = await patchLane("carla", { language: "German" })
    expect(lowered.status).toBe(403)

    await env.AQUILLA_PG.prepare(
      "UPDATE org_settings SET settings = '{}' WHERE org_id = 1",
    ).run()
    const defaulted = await patchLane("carla", { language: "German" })
    expect(defaulted.status).toBe(403)
    const body = (await defaulted.json()) as {
      error: string
      code: string
      required: { roleLevel: number }
    }
    expect(body.code).toBe("role_required")
    expect(body.required.roleLevel).toBe(500)
    expect(body.error).toMatch(/project lead/i)
    expect(await storedLaneLanguage()).toBe("French")
  })

  it("leaves the maintainer path untouched", async () => {
    await seed('{"languageEditMinRole":600}')
    const res = await patchLane("bob", { language: "German" })
    expect(res.status).toBe(200)
    expect(await storedLaneLanguage()).toBe("German")
  })
})
