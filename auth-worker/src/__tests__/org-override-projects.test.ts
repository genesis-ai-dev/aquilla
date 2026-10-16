// AQU-1938 — the org settings pages say WHICH projects, not only how many.
//
// "N projects set their own number" (Project defaults) and "N projects are
// stricter than this" (Security) were bare counts: nobody could act on them.
// The same reads now return the projects behind each count — id and name,
// ordered by name, capped, with the exact total still there.
//
// Who may read the counts is unchanged (any org member). Who may read a
// project's NAME is not widened: below Maintainer a member sees only the
// projects the org dashboard would show them (AQU-745), and the rest are left
// to the total.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import type { MediaDefaultKey } from "../../../db/shared/media-setting-defaults"

interface ProjectList { total: number; projects: Array<{ id: string; name: string }> }

interface SettingsBody {
  version: number
  countStructuralOverrides: number
  validationCountOverrides: number
  validationCountAudioOverrides: number
  overrideProjects: Record<
    "countStructuralCells" | "validationCount" | "validationCountAudio" | MediaDefaultKey,
    ProjectList
  >
}

interface VisibilityBody {
  rosterViewMinRole: number
  memberProgressViewMinRole: number
  overrideProjects: Record<"rosterViewMinRole" | "memberProgressViewMinRole", ProjectList>
}

async function project(
  id: string,
  name: string,
  settings: Record<string, unknown>,
  { orgId = 1, archived = false }: { orgId?: number; archived?: boolean } = {},
) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at)
     VALUES (?, ?, ?, 1, ${archived ? "now()" : "NULL"})`,
  ).bind(id, name, orgId).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)",
  ).bind(id, JSON.stringify(settings)).run()
}

async function seed() {
  await seedUser(1, "olive")    // org owner, created every project
  await seedUser(2, "mara")     // org maintainer: sees every project's name
  await seedUser(3, "tom")      // org contributor, on one project only
  await seedUser(4, "stranger") // not in the org
  await seedUser(5, "otto")     // owner of another org
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1), (2, 'Elsewhere', 5)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1), (2, 5, 700, 5)`,
  ).run()
  // The org leaves both visibility floors at their default (Maintainer).
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()

  await project("p-b", "Bravo", { validationCount: 2, countStructuralCells: false, rosterViewMinRole: 700 })
  // Lower-case on purpose: the list is in name order, not code-point order.
  await project("p-a", "alpha", {
    validationCount: 3,
    validationCountAudio: 2,
    memberProgressViewMinRole: 700,
    timingLocked: false,
  })
  await project("p-tom", "Charlie", { validationCount: 2, rosterViewMinRole: 700 })
  await project("p-follow", "Delta", { sourceLanguage: "en" })
  // At the org's own floor: inert, so not "stricter".
  await project("p-inert", "Echo", { rosterViewMinRole: 600 })
  await project("p-arch", "Archived", { validationCount: 2, rosterViewMinRole: 700 }, { archived: true })
  await project("q-1", "Other org", { validationCount: 2, rosterViewMinRole: 700 }, { orgId: 2 })

  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p-tom', 3, 400, 1)",
  ).run()
}

const getSettings = async (who: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)

const getVisibility = async (who: string) =>
  app.request("/api/v2/orgs/1/settings/visibility-overrides", { headers: authHeader(await jwtFor(who)) }, env)

const patchOrg = async (who: string, settings: Record<string, unknown>, ifMatchVersion: number) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(who)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )

const alpha = { id: "p-a", name: "alpha" }
const bravo = { id: "p-b", name: "Bravo" }
const charlie = { id: "p-tom", name: "Charlie" }

describe("AQU-1938: the projects behind the Project defaults counts", () => {
  it("names this org's live projects that set their own value, in name order, beside the unchanged counts", async () => {
    await seed()
    const res = await getSettings("mara")
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsBody
    expect(body.validationCountOverrides).toBe(3)
    expect(body.validationCountAudioOverrides).toBe(1)
    expect(body.countStructuralOverrides).toBe(1)
    expect(body.overrideProjects).toEqual({
      // Not the archived project, not the other org's, not the one that follows.
      validationCount: { total: 3, projects: [alpha, bravo, charlie] },
      validationCountAudio: { total: 1, projects: [alpha] },
      countStructuralCells: { total: 1, projects: [bravo] },
      // AQU-1768: and one list per media default.
      timingLocked: { total: 1, projects: [alpha] },
      allowTrackEditing: { total: 0, projects: [] },
      cellEditingFloor: { total: 0, projects: [] },
      allowSelfValidationAudio: { total: 0, projects: [] },
      validationRoleFloorAudio: { total: 0, projects: [] },
    })
  })

  it("below Maintainer, the counts are the same but only the caller's own projects are named", async () => {
    await seed()
    const res = await getSettings("tom")
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsBody
    expect(body.validationCountOverrides).toBe(3)
    expect(body.overrideProjects.validationCount).toEqual({ total: 3, projects: [charlie] })
    expect(body.overrideProjects.validationCountAudio).toEqual({ total: 1, projects: [] })
    expect(body.overrideProjects.countStructuralCells).toEqual({ total: 1, projects: [] })
    expect(body.overrideProjects.timingLocked).toEqual({ total: 1, projects: [] })
  })

  it("is still refused to someone outside the org", async () => {
    await seed()
    expect((await getSettings("stranger")).status).toBe(403)
    expect((await getSettings("otto")).status).toBe(403)
  })

  it("a save and a version clash carry the lists too, as they carry the counts", async () => {
    await seed()
    const saved = await patchOrg("mara", { validationCount: 2 }, 0)
    expect(saved.status).toBe(200)
    const body = (await saved.json()) as SettingsBody
    expect(body.overrideProjects.validationCount).toEqual({ total: 3, projects: [alpha, bravo, charlie] })

    const clash = await patchOrg("mara", { validationCount: 3 }, 0)
    expect(clash.status).toBe(409)
    const current = ((await clash.json()) as { current: SettingsBody }).current
    expect(current.overrideProjects.countStructuralCells).toEqual({ total: 1, projects: [bravo] })
  })
})

describe("AQU-1938: the projects behind the Security page's stricter counts", () => {
  it("names this org's live projects that are stricter, in name order, beside the unchanged counts", async () => {
    await seed()
    const res = await getVisibility("mara")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rosterViewMinRole: 2,
      memberProgressViewMinRole: 1,
      overrideProjects: {
        // Not Echo (at the org's floor), not the archived one, not the other org's.
        rosterViewMinRole: { total: 2, projects: [bravo, charlie] },
        memberProgressViewMinRole: { total: 1, projects: [alpha] },
      },
    })
  })

  it("below Maintainer, the counts are the same but only the caller's own projects are named", async () => {
    await seed()
    const res = await getVisibility("tom")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rosterViewMinRole: 2,
      memberProgressViewMinRole: 1,
      overrideProjects: {
        rosterViewMinRole: { total: 2, projects: [charlie] },
        memberProgressViewMinRole: { total: 1, projects: [] },
      },
    })
  })

  it("is still refused to someone outside the org", async () => {
    await seed()
    expect((await getVisibility("stranger")).status).toBe(403)
    expect((await getVisibility("otto")).status).toBe(403)
  })
})

describe("AQU-1938: a long list is capped, and the total stays exact", () => {
  async function seedMany() {
    await seedUser(1, "olive")
    await seedUser(2, "mara")
    await seedUser(3, "tom")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)",
    ).run()
    // Book 01 … Book 55, each with its own number and a stricter member list.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by)
       SELECT 'b-' || lpad(g::text, 2, '0'), 'Book ' || lpad(g::text, 2, '0'), 1, 1
         FROM generate_series(1, 55) g`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by)
       SELECT 'b-' || lpad(g::text, 2, '0'), '{"validationCount": 2, "rosterViewMinRole": 700}', 1, 1
         FROM generate_series(1, 55) g`,
    ).run()
    // Tom is on the LAST book only — past the cap in name order.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('b-55', 3, 400, 1)",
    ).run()
  }

  const names = (list: ProjectList) => list.projects.map((p) => p.name)
  const first50 = Array.from({ length: 50 }, (_, i) => `Book ${String(i + 1).padStart(2, "0")}`)

  it("Project defaults: 50 names, the first 50 by name, and a total of 55", async () => {
    await seedMany()
    const body = (await (await getSettings("mara")).json()) as SettingsBody
    expect(body.validationCountOverrides).toBe(55)
    expect(body.overrideProjects.validationCount.total).toBe(55)
    expect(names(body.overrideProjects.validationCount)).toEqual(first50)
  })

  it("Security: 50 names, the first 50 by name, and a total of 55", async () => {
    await seedMany()
    const body = (await (await getVisibility("mara")).json()) as VisibilityBody
    expect(body.rosterViewMinRole).toBe(55)
    expect(body.overrideProjects.rosterViewMinRole.total).toBe(55)
    expect(names(body.overrideProjects.rosterViewMinRole)).toEqual(first50)
  })

  it("the cap never hides a project the caller could have been shown", async () => {
    await seedMany()
    const settings = (await (await getSettings("tom")).json()) as SettingsBody
    expect(settings.overrideProjects.validationCount).toEqual({
      total: 55,
      projects: [{ id: "b-55", name: "Book 55" }],
    })
    const visibility = (await (await getVisibility("tom")).json()) as VisibilityBody
    expect(visibility.overrideProjects.rosterViewMinRole).toEqual({
      total: 55,
      projects: [{ id: "b-55", name: "Book 55" }],
    })
  })
})
