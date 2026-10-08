/**
 * AQU-1072 — the access audit reports resolveProjectRoles, not a second
 * max-wins. Lane rows are the stored grants, named from the lanes table.
 */

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { resolveProjectRoles } from "../services/project-permissions"
import type { AuthUser } from "../types"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import type { AccessAuditReport } from "../services/access-audit"

function user(id: number, username: string): AuthUser {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "",
    preferences: {},
    created_at: "",
    updated_at: "",
    password_changed_at: null,
  }
}

async function seed() {
  await seedUser(1, "wendi") // owner, created pa
  await seedUser(2, "anna") // contributor via team, creator of pb
  await seedUser(3, "gio") // guest, direct grant only
  await seedUser(4, "mia") // maintainer, no other grant
  await seedUser(9, "tom") // below the floor
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 100, 1), (1, 4, 600, 1), (1, 9, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
       ('pa', 'John', 1, 1, NULL),
       ('pb', 'Mark', 1, 2, NULL),
       ('pz', 'Archived', 1, 2, '2026-01-01T00:00:00Z')`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('pa', 2, 300, 1),
       ('pa', 3, 200, 1),
       ('pz', 2, 700, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (5, 1, 'Translators', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, role_level) VALUES (5, 2, 500)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (5, 'pa', 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
       ('lane-fr', 'pa', 'target', 'French', 'fr', 'fr', 1),
       ('lane-es', 'pa', 'target', 'Spanish', 'es', 'es', 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES
       ('pa', 2, 'lane-fr', 300),
       ('pa', 2, 'lane-es', 100)`,
  ).run()
}

describe("GET /api/v2/orgs/:orgId/access-audit", () => {
  it("reports each person's org role, teams, and the resolver's project role and source", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/orgs/1/access-audit",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as AccessAuditReport
    expect(body.orgName).toBe("Come and See")
    expect(body.people.map((p) => p.username)).toEqual(["anna", "gio", "mia", "tom", "wendi"])

    const annaResolved = await resolveProjectRoles(env, user(2, "anna"), ["pa", "pb", "pz"])
    const anna = body.people.find((p) => p.username === "anna")!
    expect(anna.orgRole).toBe(100)
    expect(anna.teams).toEqual([{ teamId: "5", name: "Translators", roleLevel: 500 }])
    expect(anna.projects.map((p) => p.projectId)).toEqual(["pa", "pb"])
    expect(anna.projects.find((p) => p.projectId === "pa")!.role).toEqual(annaResolved.get("pa"))
    expect(anna.projects.find((p) => p.projectId === "pb")!.role).toEqual(annaResolved.get("pb"))
    expect(anna.projects.find((p) => p.projectId === "pa")!.lanes).toEqual([
      { laneId: "lane-fr", name: "French", roleLevel: 300 },
      { laneId: "lane-es", name: "Spanish", roleLevel: 100 },
    ])
    expect(anna.projects.find((p) => p.projectId === "pb")!.lanes).toEqual([])

    const miaResolved = await resolveProjectRoles(env, user(4, "mia"), ["pa", "pb"])
    const mia = body.people.find((p) => p.username === "mia")!
    expect(mia.orgRole).toBe(600)
    expect(mia.teams).toEqual([])
    expect(mia.projects.find((p) => p.projectId === "pa")!.role).toEqual(miaResolved.get("pa"))
    expect(mia.projects.find((p) => p.projectId === "pb")!.role).toEqual(miaResolved.get("pb"))

    const gio = body.people.find((p) => p.username === "gio")!
    expect(gio.orgRole).toBeNull()
    const gioResolved = await resolveProjectRoles(env, user(3, "gio"), ["pa"])
    expect(gio.projects).toEqual([
      expect.objectContaining({ projectId: "pa", role: gioResolved.get("pa"), lanes: [] }),
    ])

    const wendi = body.people.find((p) => p.username === "wendi")!
    const wendiResolved = await resolveProjectRoles(env, user(1, "wendi"), ["pa", "pb"])
    expect(wendi.projects.find((p) => p.projectId === "pa")!.role).toEqual(wendiResolved.get("pa"))
    expect(wendi.projects.find((p) => p.projectId === "pb")!.role).toEqual(wendiResolved.get("pb"))
  })

  it("403s a caller below maintainer and a bad org id", async () => {
    await seed()
    const low = await app.request(
      "/api/v2/orgs/1/access-audit",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    expect(low.status).toBe(403)
    const bad = await app.request(
      "/api/v2/orgs/nope/access-audit",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(bad.status).toBe(400)
  })
})
