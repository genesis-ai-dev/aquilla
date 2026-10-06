// AQU-1724: `terminology` is retired as a project-settings key. Key terms live
// in the Postgres `concepts` table, projected from term.* events; the editor
// reads the old blob only while that table is empty, and
// scripts/migrate-concepts.ts deletes the key once a project migrates. A
// settings write to it is therefore silently lost on a migrated project — so
// the route refuses one, for every role, and says where terms go instead.
//
// This file used to cover the AQU-822 carve-out that admitted a
// terminology-only write below maintainer at the org's termbaseEditMinRole
// floor. That carve-out is gone. What it guards now, in order of severity:
//   1. A write that CHANGES terminology — adds it, edits it, or drops a stored
//      value — is refused with a 400 that points to term.* events, and nothing
//      is stored. Dropping counts: on a project not yet migrated the blob is
//      the only copy of its terms.
//   2. A write that echoes the stored value UNCHANGED still lands. The SPA's
//      settings client is a whole-object read-modify-write and still carries
//      the key, so keying off presence would break every save on a project
//      that has the blob.
//   3. A write that changes NOTHING still lands for the sub-maintainers it
//      landed for before. The old `terminologyOnly` test was vacuously true
//      for an empty diff, and that is what admitted them.
//   4. Every other key keeps its floor — retiring the carve-out lends no key
//      to anyone.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const CONCEPT = [{ id: "c1", sourceTerm: "grace", renderings: [], status: "active" }]
const STORED_TERMS = [{ id: "c0", sourceTerm: "mercy", renderings: [], status: "active" }]
const WITH_TERMS = JSON.stringify({ sourceLanguage: "en", terminology: STORED_TERMS })

/**
 * Owner (700), maintainer (600), a contributor (400) and a project lead (500)
 * on one org project. The sub-maintainers get direct project_members rows —
 * sub-maintainer org membership is not a grant path (AQU-435).
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

async function storedRow(): Promise<{ settings: Record<string, unknown>; version: number }> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings, version FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string; version: number }>()
  return {
    settings: JSON.parse(row?.settings ?? "{}") as Record<string, unknown>,
    version: Number(row?.version),
  }
}

/** The refusal must name the key AND say where terms go now — a client told
 *  only "no" retries the same write; told "term.create / term.update" it can
 *  land the term where the editor actually reads it. */
async function expectRetiredPointer(res: Response): Promise<void> {
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain("terminology")
  expect(body.error).toContain("term.create")
  expect(body.error).toContain("term.update")
}

describe("project-settings: terminology is retired (AQU-1724)", () => {
  it("refuses a write that adds terminology for every role, pointing to term.* events", async () => {
    // The floor that used to admit the contributor, lowered as far as it went.
    await seed('{"termbaseEditMinRole":400}')
    for (const user of ["carla", "dan", "bob", "alice"]) {
      const res = await patchProjectSettings(user, {
        sourceLanguage: "en", // unchanged echo — the client always sends the whole object
        terminology: CONCEPT,
      })
      await expectRetiredPointer(res)
    }
    const stored = await storedRow()
    expect(stored.settings.terminology).toBeUndefined()
    expect(stored.version).toBe(1)
  })

  it("refuses a write that edits or drops a stored terminology value, keeping the blob", async () => {
    await seed("{}", WITH_TERMS)
    await expectRetiredPointer(
      await patchProjectSettings("bob", { sourceLanguage: "en", terminology: CONCEPT }),
    )
    // Dropped alongside a legitimate maintainer change: the change does not
    // land either, because one write is one blob.
    await expectRetiredPointer(await patchProjectSettings("bob", { sourceLanguage: "fr" }))
    const stored = await storedRow()
    expect(stored.settings.terminology).toEqual(STORED_TERMS)
    expect(stored.settings.sourceLanguage).toBe("en")
    expect(stored.version).toBe(1)
  })

  it("lets a write that echoes the stored terminology unchanged through", async () => {
    await seed("{}", WITH_TERMS)
    // A maintainer changing other keys...
    const maintainer = await patchProjectSettings("bob", {
      sourceLanguage: "fr",
      terminology: STORED_TERMS,
      validationCount: 2,
    })
    expect(maintainer.status).toBe(200)
    // ...and a contributor through their own single-key carve-out (AQU-1408):
    // the echoed key must not count against it.
    const contributor = await patchProjectSettings(
      "carla",
      {
        sourceLanguage: "fr",
        terminology: STORED_TERMS,
        validationCount: 2,
        alignmentSeeds: [{ source: "logos", target: "word", weight: 1 }],
      },
      2,
    )
    expect(contributor.status).toBe(200)
    const stored = await storedRow()
    expect(stored.settings.terminology).toEqual(STORED_TERMS)
    expect(stored.settings.sourceLanguage).toBe("fr")
    expect(stored.version).toBe(3)
  })

  it("still admits a no-op read-modify-write from the sub-maintainers it admitted before", async () => {
    // Default floors (termbase 500, languages 600): a project lead's no-op
    // save on a project that still carries the legacy blob lands. Routed to
    // the language scope instead, it would 403 at 600.
    await seed("{}", WITH_TERMS)
    const lead = await patchProjectSettings("dan", { sourceLanguage: "en", terminology: STORED_TERMS })
    expect(lead.status).toBe(200)
    expect((await storedRow()).settings.terminology).toEqual(STORED_TERMS)
  })

  it("still admits a contributor's no-op save in an org that lowered the termbase floor", async () => {
    await seed('{"termbaseEditMinRole":400}')
    const res = await patchProjectSettings("carla", { sourceLanguage: "en" })
    expect(res.status).toBe(200)
  })

  it("keeps every other key's floor — a lowered termbase floor lends nothing", async () => {
    await seed('{"termbaseEditMinRole":400}')
    // Contributor: no carve-out for validationCount.
    expect((await patchProjectSettings("carla", { sourceLanguage: "en", validationCount: 3 })).status).toBe(403)
    // Lead: languages default to the maintainer floor (AQU-1086).
    expect((await patchProjectSettings("dan", { sourceLanguage: "fr" })).status).toBe(403)
    // A below-maintainer write that DROPS another key is still a change.
    expect((await patchProjectSettings("carla", {})).status).toBe(403)
    expect((await storedRow()).settings).toEqual({ sourceLanguage: "en" })
    // Maintainer: unchanged.
    expect((await patchProjectSettings("bob", { sourceLanguage: "fr", validationCount: 2 })).status).toBe(200)
  })
})
