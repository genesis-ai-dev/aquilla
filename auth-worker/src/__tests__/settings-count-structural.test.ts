// AQU-1083 — who may say whether headings count toward progress, at both
// levels. Mirrors org-settings-allow-self-assignment.test.ts and
// project-settings-termbase-scope.test.ts, because this key is deliberately
// unlike the first and exactly like the second:
//
//   - At the ORG it is NOT a permission policy. Every key in
//     PERMISSION_POLICY_KEYS decides who may see or do something and is
//     owner-only; this one decides how a number is calculated, so it rides the
//     general maintainer gate. Getting that wrong in either direction is the
//     thing these tests exist to catch.
//   - At the PROJECT it is a key-exact carve-out below the maintainer floor,
//     with the same fail-safe as terminology: bundle any other key into the
//     write and the whole thing falls back to the maintainer 403.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrg() {
  await seedUser(1, "olive") // owner
  await seedUser(2, "mara")  // maintainer
  await seedUser(3, "leo")   // project lead
  await seedUser(4, "cora")  // contributor
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

async function seedProject(settings = "{}") {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Genesis', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1',3,500,1), ('p1',4,400,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version) VALUES ('p1', ?, 0)",
  ).bind(settings).run()
}

const patchOrg = async (jwt: string, settings: Record<string, unknown>) =>
  app.request(
    "/api/v2/orgs/1/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify({ settings, ifMatchVersion: 0 }) },
    env,
  )

const patchProject = async (jwt: string, settings: Record<string, unknown>) =>
  app.request(
    "/api/v2/projects/p1/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify({ settings, ifMatchVersion: 0 }) },
    env,
  )

const storedOrg = async () =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM org_settings WHERE org_id = 1")
      .first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

const storedProject = async () =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = 'p1'")
      .first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("org: countStructuralCells is a maintainer setting, not a permission policy", () => {
  it("lets a maintainer turn it off", async () => {
    // The distinction that matters: a maintainer cannot touch allowSelfAssignment
    // or any other key in PERMISSION_POLICY_KEYS, but this one is theirs.
    await seedOrg()
    const res = await patchOrg(await jwtFor("mara"), { countStructuralCells: false })
    expect(res.status).toBe(200)
    expect((await storedOrg()).countStructuralCells).toBe(false)
  })

  it("lets an owner turn it off too", async () => {
    await seedOrg()
    const res = await patchOrg(await jwtFor("olive"), { countStructuralCells: false })
    expect(res.status).toBe(200)
  })

  it("400s a non-boolean rather than storing it", async () => {
    // A mistyped value reads as "unset" downstream, which silently moves every
    // percentage in the org with nothing on screen to explain it.
    await seedOrg()
    const res = await patchOrg(await jwtFor("mara"), { countStructuralCells: "false" })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/boolean/)
  })

  it("does not drag the owner-only keys along with it", async () => {
    // The regression this guards: adding the key to PERMISSION_POLICY_KEYS
    // would have made it owner-only, and dropping the owner gate to let
    // maintainers write it would have opened every key in that table.
    await seedOrg()
    const res = await patchOrg(await jwtFor("mara"), { allowSelfAssignment: true })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toMatch(/owner/)
  })
})

describe("project: countStructuralCells is a lead-level, key-exact carve-out", () => {
  it("lets a project lead set the override", async () => {
    await seedOrg()
    await seedProject()
    const res = await patchProject(await jwtFor("leo"), { countStructuralCells: false })
    expect(res.status).toBe(200)
    expect((await storedProject()).countStructuralCells).toBe(false)
  })

  it("403s a contributor", async () => {
    await seedOrg()
    await seedProject()
    const res = await patchProject(await jwtFor("cora"), { countStructuralCells: false })
    expect(res.status).toBe(403)
  })

  it("403s a lead who bundles any other key into the same write", async () => {
    // The fail-safe the terminology carve-out established: a permitted key
    // must never become a vehicle for an unpermitted one.
    await seedOrg()
    await seedProject()
    const res = await patchProject(await jwtFor("leo"), {
      countStructuralCells: false,
      sourceLanguage: "fr",
    })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toMatch(/maintainer/)
    expect((await storedProject()).countStructuralCells).toBeUndefined()
  })

  it("lets a lead echo the unchanged value back without tripping the gate", async () => {
    // The client patch is a whole-object read-modify-write, so every save
    // resends every key. If an unchanged echo counted as a change, a lead
    // could never save anything once the key existed.
    await seedOrg()
    await seedProject(JSON.stringify({ countStructuralCells: false, sourceLanguage: "en" }))
    const res = await patchProject(await jwtFor("leo"), {
      countStructuralCells: false,
      sourceLanguage: "en",
    })
    expect(res.status).toBe(200)
  })

  it("400s a non-boolean override", async () => {
    await seedOrg()
    await seedProject()
    const res = await patchProject(await jwtFor("leo"), { countStructuralCells: null })
    expect(res.status).toBe(400)
  })

  it("treats deleting the key as a real change a lead may make", async () => {
    // "Use the organization default" is the ABSENCE of the key, not a third
    // stored value — so choosing it has to be a permitted write.
    await seedOrg()
    await seedProject(JSON.stringify({ countStructuralCells: false }))
    const res = await patchProject(await jwtFor("leo"), {})
    expect(res.status).toBe(200)
    expect((await storedProject()).countStructuralCells).toBeUndefined()
  })
})

// The carve-out lowers WHO may write this key. It must not also lower the
// concurrency guard that protects every other key in the same blob — a lead
// writing on a stale version would otherwise silently clobber a maintainer's
// concurrent edit to a setting the lead cannot even see.
describe("optimistic concurrency still applies to this key", () => {
  it("409s a project lead writing on a stale version, and stores nothing", async () => {
    await seedOrg()
    await seedProject()
    expect((await patchProject(await jwtFor("leo"), { countStructuralCells: false })).status).toBe(200)

    // patchProject always sends ifMatchVersion: 0, which the write above made stale.
    const stale = await patchProject(await jwtFor("leo"), { countStructuralCells: true })
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as { current?: { version: number } }
    expect(body.current?.version).toBe(1)
    expect((await storedProject()).countStructuralCells).toBe(false)
  })

  it("409s a maintainer writing the org key on a stale version", async () => {
    await seedOrg()
    expect((await patchOrg(await jwtFor("mara"), { countStructuralCells: false })).status).toBe(200)
    const stale = await patchOrg(await jwtFor("mara"), { countStructuralCells: true })
    expect(stale.status).toBe(409)
    expect((await storedOrg()).countStructuralCells).toBe(false)
  })
})

// AQU-1083: the org default rides on the project SETTINGS response.
//
// It used to ride on the project RECORD, which an open editor never re-reads —
// so an org-level flip could not reach a workspace that was already open. This
// response is the one the editor re-reads on a remote change frame and on
// window focus, which is the whole reason it moved here.
describe("the settings response carries the org default", () => {
  const getProjectSettings = async (jwt: string) =>
    app.request("/api/v2/projects/p1/settings", { headers: authHeader(jwt) }, env)

  it("reports the org's answer to a project that has none of its own", async () => {
    await seedOrg()
    await seedProject()
    await patchOrg(await jwtFor("mara"), { countStructuralCells: false })
    const body = (await (await getProjectSettings(await jwtFor("leo"))).json()) as {
      orgCountStructuralCells: boolean | null
      settings: Record<string, unknown>
    }
    expect(body.orgCountStructuralCells).toBe(false)
    // And the project's own answer is still absent — this is the fallback, not
    // a value that has been stamped into the project.
    expect(body.settings.countStructuralCells).toBeUndefined()
  })

  it("follows the org switch", async () => {
    await seedOrg()
    await seedProject()
    const read = async () =>
      ((await (await getProjectSettings(await jwtFor("leo"))).json()) as
        { orgCountStructuralCells: boolean | null }).orgCountStructuralCells
    // Unset at the org reads as the built-in default: count them.
    expect(await read()).toBe(true)
    await patchOrg(await jwtFor("mara"), { countStructuralCells: false })
    expect(await read()).toBe(false)
  })

  it("is null for a project with no organization", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, created_by) VALUES ('solo', 'Solo', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('solo',3,500,1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/solo/settings",
      { headers: authHeader(await jwtFor("leo")) },
      env,
    )
    expect(res.status).toBe(200)
    // No org means no default to inherit. The client reads that as "count
    // them", the same as every project did before this setting existed.
    expect((await res.json() as { orgCountStructuralCells: boolean | null })
      .orgCountStructuralCells).toBeNull()
  })

  it("carries it on the 409 body too, which is what a conflicted client snaps to", async () => {
    await seedOrg()
    await seedProject()
    await patchOrg(await jwtFor("mara"), { countStructuralCells: false })
    expect((await patchProject(await jwtFor("leo"), { countStructuralCells: true })).status).toBe(200)

    const stale = await patchProject(await jwtFor("leo"), { countStructuralCells: false })
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as {
      current?: { orgCountStructuralCells: boolean | null }
    }
    // Without this the project control would lose what "Organization default"
    // means at exactly the moment it redraws from the conflict winner.
    expect(body.current?.orgCountStructuralCells).toBe(false)
  })
})
