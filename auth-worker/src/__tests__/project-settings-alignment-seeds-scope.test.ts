// AQU-1408: the `alignmentSeeds` carve-out in the project-settings write
// route. Confirming (✓) or rejecting (✕) a word-alignment suggestion in the BT
// tab writes a ± pseudo-count into this key; the panel shows those buttons to
// the whole project, so the floor has to be one the people looking at them can
// actually clear.
//
// What this guards, in order of severity:
//   1. The control being dead below maintainer. Under the flat 600 floor a
//      contributor's click updated the in-memory model and then vanished on
//      reload, with no error anywhere — the Biblica ETT report this fixes.
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
 * Owner (700), maintainer (600), a contributor (400) and a reviewer (300) on
 * one org project. The sub-maintainer members get direct project_members rows —
 * sub-maintainer org membership is not a grant path (AQU-435).
 */
async function seed(projectSettings = '{"sourceLanguage":"en"}') {
  await seedUser(1, "alice") // org owner
  await seedUser(2, "bob") // org maintainer
  await seedUser(3, "carla") // project contributor
  await seedUser(4, "dan") // project reviewer
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
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Alignment', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 3, 400, 1), ('p1', 4, 300, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(projectSettings)
    .run()
}

const CONFIRMED = [{ srcToken: "father", tgtToken: "père", weight: 1 }]
const REJECTED = [{ srcToken: "father", tgtToken: "papa", weight: -1 }]

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

describe("project-settings alignment-seeds carve-out (AQU-1408)", () => {
  it("lets a contributor confirm an alignment", async () => {
    await seed()
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en", // unchanged echo — the client sends the whole object
      alignmentSeeds: CONFIRMED,
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).alignmentSeeds).toEqual(CONFIRMED)
  })

  it("lets a contributor reject an alignment (the negative seed is the same permission)", async () => {
    await seed()
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      alignmentSeeds: REJECTED,
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).alignmentSeeds).toEqual(REJECTED)
  })

  it("lets a contributor revise a decision an admin already stored", async () => {
    // The seeds are one project-wide list, so a contributor's write replaces
    // the whole key. That is the same read-modify-write every other client
    // does; what matters is that it is admitted at all.
    await seed(`{"sourceLanguage":"en","alignmentSeeds":${JSON.stringify(CONFIRMED)}}`)
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      alignmentSeeds: [...CONFIRMED, ...REJECTED],
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).alignmentSeeds).toEqual([...CONFIRMED, ...REJECTED])
  })

  it("still lets a maintainer write them", async () => {
    await seed()
    const res = await patchProjectSettings("bob", {
      sourceLanguage: "en",
      alignmentSeeds: CONFIRMED,
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).alignmentSeeds).toEqual(CONFIRMED)
  })

  it("403s a reviewer (300) — contributor is the floor, not every member", async () => {
    await seed()
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      alignmentSeeds: CONFIRMED,
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).alignmentSeeds).toBeUndefined()
  })

  it("403s a below-maintainer write that changes any other key alongside the seeds", async () => {
    // The carve-out is scoped to a write that changes NOTHING ELSE. A
    // contributor bundling a language change with a confirmation gets the
    // maintainer 403 for the whole patch — admitting one key must never
    // smuggle in another.
    await seed()
    const bundled = await patchProjectSettings("carla", {
      sourceLanguage: "fr",
      alignmentSeeds: CONFIRMED,
    })
    expect(bundled.status).toBe(403)
    const stored = await storedSettings()
    expect(stored.alignmentSeeds).toBeUndefined()
    expect(stored.sourceLanguage).toBe("en")
  })

  it("403s a contributor's write that changes only a non-seed key", async () => {
    // Sanity: the carve-out did not lower the floor for everything else.
    await seed()
    const res = await patchProjectSettings("carla", { sourceLanguage: "fr" })
    expect(res.status).toBe(403)
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })

  it("keys off the DIFF — a contributor echoing unchanged seeds is still judged on the key that moved", async () => {
    await seed(`{"sourceLanguage":"en","alignmentSeeds":${JSON.stringify(CONFIRMED)}}`)
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "fr",
      alignmentSeeds: CONFIRMED, // echoed, unchanged
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).sourceLanguage).toBe("en")
  })
})
