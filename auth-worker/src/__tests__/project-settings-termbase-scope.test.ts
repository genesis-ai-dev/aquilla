// AQU-822: the terminology-scoped carve-out in the project-settings write
// route. Below the maintainer settings floor, exactly ONE write is allowed —
// one whose only *changed* key is `terminology` — and only when the project's
// org has lowered `termbaseEditMinRole` far enough.
//
// The two failure modes this guards against, in order of severity:
//   1. Lowering the termbase floor silently widening write access to the rest
//      of project settings (AI config, languages, validation thresholds).
//   2. The carve-out never firing in practice, because the client patch is a
//      whole-object read-modify-write and every write echoes back every key —
//      so the gate must key off the DIFF, not off key presence.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const CONCEPT = [{ id: "c1", sourceTerm: "grace", renderings: [], status: "active" }]

/**
 * Owner (700), maintainer (600) and a contributor (400) on one org project.
 * The contributor gets a direct project_members row — sub-maintainer org
 * membership is not a grant path (AQU-435).
 */
async function seed(orgSettings = "{}", projectSettings = '{"sourceLanguage":"en"}') {
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
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Termbase', 1, 1)",
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

describe("project-settings terminology carve-out (AQU-822)", () => {
  it("lets a contributor write terminology when the org floor is 400", async () => {
    await seed('{"termbaseEditMinRole":400}')
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en", // unchanged echo — the client always sends the whole object
      terminology: CONCEPT,
    })
    expect(res.status).toBe(200)
    const stored = await storedSettings()
    expect(stored.terminology).toEqual(CONCEPT)
  })

  it("403s a contributor's terminology write at the default floor (500)", async () => {
    await seed() // org never configured a floor
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      terminology: CONCEPT,
    })
    expect(res.status).toBe(403)
    const stored = await storedSettings()
    expect(stored.terminology).toBeUndefined()
  })

  it("lets a project lead write terminology at the default floor (500)", async () => {
    // Pre-AQU-822 the client showed a lead the termbase editor while the
    // server required maintainer — the save 403'd. The default floor of 500
    // closes that divergence.
    await seed()
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      terminology: CONCEPT,
    })
    expect(res.status).toBe(200)
  })

  it("403s a below-maintainer write that changes any non-terminology key, even with the floor lowered", async () => {
    await seed('{"termbaseEditMinRole":400}')
    const bundled = await patchProjectSettings("carla", {
      sourceLanguage: "fr", // changed alongside terminology
      terminology: CONCEPT,
    })
    expect(bundled.status).toBe(403)

    const otherKeyOnly = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      validationCount: 3,
    })
    expect(otherKeyOnly.status).toBe(403)

    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("en")
    expect(stored.terminology).toBeUndefined()
    expect(stored.validationCount).toBeUndefined()
  })

  it("403s a below-maintainer write that DROPS a non-terminology key", async () => {
    // A removed key is a change too — otherwise a contributor could wipe the
    // project's languages by omitting them from an otherwise terminology-only
    // write.
    await seed('{"termbaseEditMinRole":400}')
    const res = await patchProjectSettings("carla", { terminology: CONCEPT })
    expect(res.status).toBe(403)
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })

  it("leaves the maintainer path untouched", async () => {
    await seed()
    const res = await patchProjectSettings("bob", {
      sourceLanguage: "fr",
      terminology: CONCEPT,
      validationCount: 2,
    })
    expect(res.status).toBe(200)
    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("fr")
    expect(stored.terminology).toEqual(CONCEPT)
  })

  it("preserves optimistic concurrency on a carve-out write", async () => {
    await seed('{"termbaseEditMinRole":400}')
    const first = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      terminology: CONCEPT,
    })
    expect(first.status).toBe(200)

    // Same stale ifMatchVersion — must 409 with the current row, not clobber.
    const stale = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      terminology: [],
    })
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as { current?: { version: number } }
    expect(body.current?.version).toBe(2)
    expect((await storedSettings()).terminology).toEqual(CONCEPT)
  })
})
