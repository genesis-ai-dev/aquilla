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

describe("project-settings language carve-out (AQU-1086)", () => {
  it("lets a project lead change the target language when the org floor is 500", async () => {
    await seed('{"languageEditMinRole":500}')
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en", // unchanged echo — the client sends the whole object
      targetLanguage: "de",
    })
    expect(res.status).toBe(200)
    expect((await storedSettings()).targetLanguage).toBe("de")
  })

  it("403s the same write at the default floor (600) — today's behaviour preserved", async () => {
    await seed() // org never configured a floor
    const res = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "de",
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).targetLanguage).toBe("fr")
  })

  it("covers the extra-lane registry, so Project Info and Languages agree", async () => {
    await seed('{"languageEditMinRole":500}')
    const added = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "fr",
      targetLanes: ["sw"],
    })
    expect(added.status).toBe(200)
    expect((await storedSettings()).targetLanes).toEqual(["sw"])

    const archived = await patchProjectSettings(
      "dan",
      {
        sourceLanguage: "en",
        targetLanguage: "fr",
        targetLanes: ["sw"],
        archivedLanes: ["sw"],
      },
      2,
    )
    expect(archived.status).toBe(200)
    expect((await storedSettings()).archivedLanes).toEqual(["sw"])
  })

  it("403s a contributor (400) either way — the floor only reaches project lead", async () => {
    await seed('{"languageEditMinRole":500}')
    const lowered = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      targetLanguage: "de",
    })
    expect(lowered.status).toBe(403)

    await env.AQUILLA_PG.prepare(
      "UPDATE org_settings SET settings = '{}' WHERE org_id = 1",
    ).run()
    const defaulted = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      targetLanguage: "de",
    })
    expect(defaulted.status).toBe(403)
    expect((await storedSettings()).targetLanguage).toBe("fr")
  })

  it("403s a below-maintainer write that changes any non-language key, even with the floor lowered", async () => {
    await seed('{"languageEditMinRole":500}')
    const bundled = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "de", // changed alongside a policy key
      validationCount: 3,
    })
    expect(bundled.status).toBe(403)

    const otherKeyOnly = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "fr",
      systemPrompt: "be terse",
    })
    expect(otherKeyOnly.status).toBe(403)

    const stored = await storedSettings()
    expect(stored.targetLanguage).toBe("fr")
    expect(stored.validationCount).toBeUndefined()
    expect(stored.systemPrompt).toBeUndefined()
  })

  it("403s a below-maintainer write that DROPS a non-language key", async () => {
    // A removed key is a change too — otherwise a lead could wipe the
    // project's AI config by omitting it from an otherwise language-only write.
    await seed('{"languageEditMinRole":500}', '{"sourceLanguage":"en","systemPrompt":"keep me"}')
    const res = await patchProjectSettings("dan", { sourceLanguage: "en", targetLanguage: "de" })
    expect(res.status).toBe(403)
    expect((await storedSettings()).systemPrompt).toBe("keep me")
  })

  it("leaves the maintainer path untouched", async () => {
    await seed()
    const res = await patchProjectSettings("bob", {
      sourceLanguage: "es",
      targetLanguage: "de",
      validationCount: 2,
    })
    expect(res.status).toBe(200)
    const stored = await storedSettings()
    expect(stored.sourceLanguage).toBe("es")
    expect(stored.validationCount).toBe(2)
  })

  it("does not widen the termbase carve-out (its floor still governs terminology)", async () => {
    // languageEditMinRole 500 must not let a contributor through on
    // terminology — that scope has its own floor, unchanged at its 500 default.
    await seed('{"languageEditMinRole":500}')
    const res = await patchProjectSettings("carla", {
      sourceLanguage: "en",
      targetLanguage: "fr",
      terminology: [{ id: "c1", sourceTerm: "grace", renderings: [], status: "active" }],
    })
    expect(res.status).toBe(403)
    expect((await storedSettings()).terminology).toBeUndefined()
  })

  it("preserves optimistic concurrency on a carve-out write", async () => {
    await seed('{"languageEditMinRole":500}')
    const first = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "de",
    })
    expect(first.status).toBe(200)

    // Same stale ifMatchVersion — must 409 with the current row, not clobber.
    const stale = await patchProjectSettings("dan", {
      sourceLanguage: "en",
      targetLanguage: "it",
    })
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as { current?: { version: number } }
    expect(body.current?.version).toBe(2)
    expect((await storedSettings()).targetLanguage).toBe("de")
  })
})
