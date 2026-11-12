/**
 * AQU-1352 P2 (spec §3.1, §3.4, §3.5, D4): team-scope roles.
 *
 * Tim is an org Guest (100) who runs a team. He must be able to create a
 * project INTO his team (and only there), and a team maintainer must be able
 * to manage roles on their team without climbing above their own level.
 */
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { resolveProjectRoleViaGrants } from "../../../db/shared/access-grants"

const ORG = 10
const TEAM_A = 1 // Tim leads this one (after the test sets his role)
const TEAM_B = 2 // Tim is a legacy member (role_level NULL)

async function seed(timTeamRole: number | null = 500) {
  await seedUser(1, "owner")
  await seedUser(2, "maint")
  await seedUser(3, "tim")
  await seedUser(4, "carol")
  await seedUser(5, "lead")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, 'Biblica ETT', 1, 'team')",
  ).bind(ORG).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (10, 1, 700, 1), (10, 2, 600, 1), (10, 3, 100, 1), (10, 4, 400, 1), (10, 5, 100, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 10, 'Pattani Malay', 1), (2, 10, 'Thai', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO group_members (group_id, user_id, role_level)
     VALUES (1, 3, ?), (2, 3, NULL), (1, 4, NULL), (1, 5, 500)`,
  ).bind(timTeamRole).run()
}

async function as(username: string, path: string, init: RequestInit = {}) {
  const headers = { ...authHeader(await jwtFor(username)), "Content-Type": "application/json" }
  return app.request(path, { ...init, headers }, env)
}

const patchRole = (who: string, userId: number, roleLevel: number | null, team = TEAM_A) =>
  as(who, `/api/v2/orgs/${ORG}/groups/${team}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ roleLevel }),
  })

const teamRole = async (groupId: number, userId: number) =>
  (
    await env.AQUILLA_PG.prepare("SELECT role_level FROM group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, userId)
      .first<{ role_level: number | null }>()
  )?.role_level ?? null

describe("AQU-1352 PATCH team member role", () => {
  it("org maintainer sets a team role; GET detail reports it", async () => {
    await seed()
    expect((await patchRole("maint", 4, 500)).status).toBe(200)
    const res = await as("maint", `/api/v2/orgs/${ORG}/groups/${TEAM_A}`)
    const detail = (await res.json()) as { members: Array<{ userId: number; teamRoleLevel: number | null }> }
    expect(detail.members.find((m) => m.userId === 4)?.teamRoleLevel).toBe(500)
  })

  it("a team maintainer can manage roles on their own team", async () => {
    await seed(600)
    expect((await patchRole("tim", 4, 100)).status).toBe(200)
    expect(await teamRole(TEAM_A, 4)).toBe(100)
  })

  it("no self-escalation: a team maintainer cannot grant owner or anything above 600", async () => {
    await seed(600)
    // 700 is not a team-scope role at all (spec §3.4).
    expect((await patchRole("tim", 3, 700)).status).toBe(400)
    expect(await teamRole(TEAM_A, 3)).toBe(600)
  })

  it("a team project lead cannot change team roles (needs >= maintainer)", async () => {
    await seed(500)
    const res = await patchRole("tim", 4, 100)
    expect(res.status).toBe(403)
    expect(await teamRole(TEAM_A, 4)).toBeNull()
  })

  it("level cap: an org maintainer cannot demote a team member above their level", async () => {
    // Unreachable via valid team roles today (max 600), so seed directly: a
    // team row at 700 must be protected from a 600 caller.
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE group_members SET role_level = 700 WHERE group_id = 1 AND user_id = 5").run()
    expect((await patchRole("maint", 5, null)).status).toBe(403)
  })

  it("rejects non-team-scope levels (contributor) and non-members", async () => {
    await seed()
    expect((await patchRole("maint", 4, 400)).status).toBe(400)
    expect((await patchRole("maint", 2, 100)).status).toBe(404)
  })

  // Review finding: with `current > callerLevel`, two team maintainers could
  // demote each other (and mint more peers). Team-derived authority must stay
  // strictly below the caller's own level; org maintainers keep <= rights.
  it("team-only authority: a team maintainer cannot demote a peer team maintainer", async () => {
    await seed(600)
    await env.AQUILLA_PG.prepare("UPDATE group_members SET role_level = 600 WHERE group_id = 1 AND user_id = 5").run()
    expect((await patchRole("tim", 5, 100)).status).toBe(403)
    expect(await teamRole(TEAM_A, 5)).toBe(600)
  })

  it("team-only authority: a team maintainer cannot grant maintainer (their own level)", async () => {
    await seed(600)
    expect((await patchRole("tim", 4, 600)).status).toBe(403)
    expect(await teamRole(TEAM_A, 4)).toBeNull()
  })

  it("org maintainer is unaffected: may grant 600 and demote a 600 team member", async () => {
    await seed(600)
    expect((await patchRole("maint", 4, 600)).status).toBe(200)
    expect((await patchRole("maint", 3, 100)).status).toBe(200)
    expect(await teamRole(TEAM_A, 3)).toBe(100)
  })

  it("a team role on another team grants nothing here", async () => {
    await seed(600)
    expect((await patchRole("tim", 3, 600, TEAM_B)).status).toBe(403)
  })
})

describe("AQU-1352 POST /projects into teams (spec D4)", () => {
  const create = (who: string, id: string, teamIds?: number[]) =>
    as(who, "/api/v2/projects", {
      method: "POST",
      body: JSON.stringify({ id, name: id, orgId: ORG, ...(teamIds ? { teamIds } : {}) }),
    })

  it("Tim (org guest, team lead) creates into his team; the team is attached", async () => {
    await seed(500)
    const res = await create("tim", "p-tim", [TEAM_A])
    expect(res.status).toBe(200)
    const grant = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM group_project_grants WHERE group_id = 1 AND project_id = 'p-tim'",
    ).first<{ role_level: number }>()
    expect(grant?.role_level).toBe(100)
  })

  it("Tim cannot create into the org with no team, or only a team he does not lead", async () => {
    await seed(500)
    const bare = await create("tim", "p-1")
    expect(bare.status).toBe(403)
    expect(((await bare.json()) as { error: string }).error).toMatch(/team role >= project lead/)
    expect((await create("tim", "p-2", [TEAM_B])).status).toBe(403)
  })

  it("a legacy (NULL) member or team viewer cannot create into the team", async () => {
    await seed(100)
    expect((await create("tim", "p-3", [TEAM_A])).status).toBe(403)
    expect((await create("carol", "p-4", [TEAM_A])).status).toBe(403)
  })

  it("an org maintainer may attach any team in the org", async () => {
    await seed()
    expect((await create("maint", "p-5", [TEAM_A, TEAM_B])).status).toBe(200)
  })

  it("teams outside the org are rejected", async () => {
    await seed()
    expect((await create("maint", "p-6", [999])).status).toBe(400)
  })
})

describe("AQU-1352 create-targets lists teams", () => {
  it("Tim sees the org with only the team he leads", async () => {
    await seed(500)
    const res = await as("tim", "/api/v2/me/create-targets")
    const targets = (await res.json()) as Array<{ orgId: number | null; role: number; teams: Array<{ teamId: number }> }>
    const org = targets.find((t) => t.orgId === ORG)
    expect(org?.role).toBe(100)
    expect(org?.teams.map((t) => t.teamId)).toEqual([TEAM_A])
  })

  it("an org maintainer sees every team; a plain member sees no org", async () => {
    await seed(null)
    const m = (await (await as("maint", "/api/v2/me/create-targets")).json()) as Array<{
      orgId: number | null
      teams: Array<{ teamId: number }>
    }>
    expect(m.find((t) => t.orgId === ORG)?.teams.map((t) => t.teamId).sort()).toEqual([1, 2])
    const tim = (await (await as("tim", "/api/v2/me/create-targets")).json()) as Array<{ orgId: number | null }>
    expect(tim.some((t) => t.orgId === ORG)).toBe(false)
  })
})

describe("AQU-1352 access_grants view: team-scope rows reach the resolver", () => {
  it("a team lead's role flows to a project attached to the team, via the real view", async () => {
    await seed(500)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p-att', 'p', 10, 1), ('p-other', 'q', 10, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (1, 'p-att', 100)",
    ).run()
    const tim = { id: "3" }
    const attached = await resolveProjectRoleViaGrants(env.AQUILLA_PG, tim, "p-att")
    expect(attached && { level: attached.level, source: attached.source }).toEqual({ level: 500, source: "group" })
    expect(await resolveProjectRoleViaGrants(env.AQUILLA_PG, tim, "p-other")).toBeNull()
  })
})
