// AQU-2306 — the Security page's "Who can import files" row says how many of
// the org's projects require MORE than the org does, and which ones.
//
// The org floor is AQU-2304's `importMinRole` (Project lead when unset); a
// project may store the same key to make the floor stricter, never looser
// (AQU-2305). Being stricter is a COMPARISON, so the same project stops
// counting the moment the ORG rises past it — nothing is written to the
// project — and starts counting again if the org drops back.
//
// Who may read the count is the roster rows' rule: any org member. Who may
// read a project's NAME is not widened — below Maintainer a member sees only
// the projects the org dashboard would show them (AQU-745) — so a stricter
// project the caller cannot see is counted and left unnamed.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT_LEAD = 500
const MAINTAINER = 600
const OWNER = 700

interface ProjectList { total: number; projects: Array<{ id: string; name: string }> }

interface VisibilityBody {
  rosterViewMinRole: number
  memberProgressViewMinRole: number
  importMinRole: number
  overrideProjects: Record<
    "rosterViewMinRole" | "memberProgressViewMinRole" | "importMinRole",
    ProjectList
  >
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

/** The org leaves its import floor unset, so it sits at the Project lead default. */
async function seedOrg() {
  await seedUser(1, "olive")    // org owner, created every project
  await seedUser(2, "mara")     // org maintainer: sees every project's name
  await seedUser(3, "tom")      // org contributor, on one project only
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1), (2, 'Elsewhere', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

const getVisibility = async (who: string) =>
  app.request("/api/v2/orgs/1/settings/visibility-overrides", { headers: authHeader(await jwtFor(who)) }, env)

const body = async (who: string) => {
  const res = await getVisibility(who)
  expect(res.status).toBe(200)
  return (await res.json()) as VisibilityBody
}

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

describe("AQU-2306: the projects stricter than the org's import floor", () => {
  it("is the zero state when every project follows the org", async () => {
    await seedOrg()
    await project("p-follow", "Delta", { sourceLanguage: "en" })
    // At the org's own floor: inert, so not "stricter".
    await project("p-inert", "Echo", { importMinRole: PROJECT_LEAD })

    const read = await body("olive")
    expect(read.importMinRole).toBe(0)
    expect(read.overrideProjects.importMinRole).toEqual({ total: 0, projects: [] })
  })

  it("counts and names this org's live, stricter projects in name order, beside the roster counts", async () => {
    await seedOrg()
    await project("p-b", "Bravo", { importMinRole: MAINTAINER })
    // Lower-case on purpose: the list is in name order, not code-point order.
    await project("p-a", "alpha", { importMinRole: OWNER, rosterViewMinRole: OWNER })
    await project("p-follow", "Delta", { sourceLanguage: "en" })
    await project("p-arch", "Archived", { importMinRole: MAINTAINER }, { archived: true })
    await project("q-1", "Other org", { importMinRole: MAINTAINER }, { orgId: 2 })

    const read = await body("mara")
    expect(read.importMinRole).toBe(2)
    expect(read.overrideProjects.importMinRole).toEqual({
      total: 2,
      projects: [{ id: "p-a", name: "alpha" }, { id: "p-b", name: "Bravo" }],
    })
    // The roster counts this route already carried are untouched.
    expect(read.rosterViewMinRole).toBe(1)
    expect(read.overrideProjects.rosterViewMinRole.projects).toEqual([{ id: "p-a", name: "alpha" }])
  })

  it("ignores a stored value that is not a role-ladder number", async () => {
    await seedOrg()
    // The generated column is number-typed (0192): `->>` cannot tell the number
    // 600 from the string "600", and an import floor decided by a typo'd
    // settings write would be a permission nobody chose.
    await project("p-str", "String", { importMinRole: "600" })
    await project("p-bool", "Boolean", { importMinRole: true })
    await project("p-off", "Offladder", { importMinRole: 650 })

    expect((await body("olive")).importMinRole).toBe(0)
  })

  it("counts a stricter project the caller may not see, without naming it", async () => {
    await seedOrg()
    await project("p-tom", "Charlie", { importMinRole: MAINTAINER })
    await project("p-hidden", "Hidden", { importMinRole: MAINTAINER })
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p-tom', 3, 400, 1)",
    ).run()

    const read = await body("tom")
    // Both count; only the one an org contributor may see is named, and the
    // page turns the difference into "and 1 more".
    expect(read.importMinRole).toBe(2)
    expect(read.overrideProjects.importMinRole).toEqual({
      total: 2,
      projects: [{ id: "p-tom", name: "Charlie" }],
    })
  })

  it("names at most 50 projects while the count stays exact", async () => {
    await seedOrg()
    for (let i = 0; i < 51; i++) {
      await project(`p-${i}`, `Project ${String(i).padStart(2, "0")}`, { importMinRole: MAINTAINER })
    }

    const read = await body("mara")
    expect(read.importMinRole).toBe(51)
    expect(read.overrideProjects.importMinRole.total).toBe(51)
    expect(read.overrideProjects.importMinRole.projects).toHaveLength(50)
  })

  it("drops a project out of the count when the ORG rises to it, with no write to the project", async () => {
    await seedOrg()
    await project("p-a", "alpha", { importMinRole: MAINTAINER })
    expect((await body("olive")).importMinRole).toBe(1)

    const raised = await patchOrg("olive", { importMinRole: MAINTAINER }, 0)
    expect(raised.status).toBe(200)
    expect((await body("olive")).importMinRole).toBe(0)

    // The project kept its own answer the whole time — the count is a
    // comparison, not a stored flag — so dropping the org back restores it.
    const stored = await env.AQUILLA_PG
      .prepare("SELECT import_min_role AS floor FROM project_settings WHERE project_id = 'p-a'")
      .first<{ floor: string | null }>()
    expect(Number(stored?.floor)).toBe(MAINTAINER)

    const lowered = await patchOrg("olive", { importMinRole: PROJECT_LEAD }, 1)
    expect(lowered.status).toBe(200)
    expect((await body("olive")).importMinRole).toBe(1)
  })
})
