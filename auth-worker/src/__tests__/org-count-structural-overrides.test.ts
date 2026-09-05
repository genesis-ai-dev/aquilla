// AQU-1083 — the org default reaching projects that opted out of it.
//
// A project with its own countStructuralCells is deliberately deaf to the org
// switch. That is correct, and it is also how the switch becomes a change
// nobody can see: an owner flips it and the projects that most needed it do
// not move. So the org settings GET reports how many projects have their own
// answer, and this endpoint clears those overrides on request.
//
// It CLEARS rather than stamping the new value in. Writing the value into each
// project would leave them all holding an explicit answer and deaf to the NEXT
// change — the same silent miss, deferred. These tests pin that.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const RESET = "/api/v2/orgs/1/settings/count-structural/reset-project-overrides"

async function seed() {
  await seedUser(1, "olive") // org owner
  await seedUser(2, "mara")  // org maintainer
  await seedUser(3, "cora")  // contributor, no org role
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

/** `overriding` carries its own answer; `inheriting` does not. */
async function seedProjects() {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-over','Genesis',1,1), ('p-inherit','Exodus',1,1), ('p-archived','Old',1,1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "UPDATE projects SET archived_at = now() WHERE id = 'p-archived'",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-over', ?, 3),
       ('p-inherit', ?, 1),
       ('p-archived', ?, 1)`,
  ).bind(
    JSON.stringify({ countStructuralCells: false, sourceLanguage: "en" }),
    JSON.stringify({ sourceLanguage: "en" }),
    JSON.stringify({ countStructuralCells: false }),
  ).run()
}

const getSettings = async (who: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)

const reset = async (who: string) =>
  app.request(RESET, { method: "POST", headers: authHeader(await jwtFor(who)) }, env)

const storedFor = async (projectId: string) =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = ?")
      .bind(projectId).first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("org settings reports how many projects override the structural default", () => {
  it("counts only the projects that carry their own answer", async () => {
    await seed()
    await seedProjects()
    const body = (await (await getSettings("mara")).json()) as { countStructuralOverrides: number }
    // p-over counts. p-inherit has no key. p-archived is archived, and
    // prompting about a project nobody can open would be noise.
    expect(body.countStructuralOverrides).toBe(1)
  })

  it("reports zero when every project inherits", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1','Genesis',1,1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version) VALUES ('p1', '{}', 0)",
    ).run()
    const body = (await (await getSettings("mara")).json()) as { countStructuralOverrides: number }
    // Zero is what suppresses the prompt entirely — a dialog that reports
    // nothing affected is worse than no dialog.
    expect(body.countStructuralOverrides).toBe(0)
  })
})

describe("clearing the per-project overrides", () => {
  it("removes the key so the project inherits again", async () => {
    await seed()
    await seedProjects()
    const res = await reset("mara")
    expect(res.status).toBe(200)
    expect((await res.json() as { cleared: number }).cleared).toBe(1)

    const stored = await storedFor("p-over")
    // The key is GONE, not set to the org's current value. That is what keeps
    // the project following the next change too.
    expect("countStructuralCells" in stored).toBe(false)
  })

  it("leaves every other setting on that project alone", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    expect((await storedFor("p-over")).sourceLanguage).toBe("en")
  })

  it("bumps the version so an editor holding the old one is told", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    const row = await env.AQUILLA_PG
      .prepare("SELECT version FROM project_settings WHERE project_id = 'p-over'")
      .first<{ version: number }>()
    expect(Number(row?.version)).toBe(4)
  })

  it("does not touch a project that was already inheriting", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    const row = await env.AQUILLA_PG
      .prepare("SELECT version FROM project_settings WHERE project_id = 'p-inherit'")
      .first<{ version: number }>()
    expect(Number(row?.version)).toBe(1)
  })

  it("leaves archived projects out of it", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    expect((await storedFor("p-archived")).countStructuralCells).toBe(false)
  })

  it("reports nothing to do rather than failing", async () => {
    await seed()
    const res = await reset("mara")
    expect(res.status).toBe(200)
    expect((await res.json() as { cleared: number }).cleared).toBe(0)
  })

  it("403s anyone below the gate that sets the default itself", async () => {
    await seed()
    await seedProjects()
    const res = await reset("cora")
    expect(res.status).toBe(403)
    // And the override survives.
    expect((await storedFor("p-over")).countStructuralCells).toBe(false)
  })

  it("lets an owner do it too", async () => {
    await seed()
    await seedProjects()
    expect((await reset("olive")).status).toBe(200)
  })
})
