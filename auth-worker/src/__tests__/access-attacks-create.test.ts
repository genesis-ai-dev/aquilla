/**
 * AQU-1352 attack suite — create-target fuzz (ticket "try to break it" #5).
 *
 * Why: GET /me/create-targets is the create dialog's source of truth. If POST
 * /projects accepts a combination the picker would never offer, a crafted
 * request creates into a place the user does not control; if it rejects one
 * the picker offers, the dialog is broken. So for every (caller × org × team
 * selection) the POST outcome must equal what create-targets predicts, and a
 * denied POST must leave no project row behind.
 *
 * The prediction, from me.ts + team-roles.ts: a selection is allowed when the
 * org is a listed target and every selected team is in that target's `teams`
 * list; below Maintainer (role < 600) at least one team is required. No orgId
 * means Personal, which takes no teams.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { seedAccessFixture } from "./helpers/access-fixture"
import { RESOLVER_MODES, TEAM_LEAD, count, req, seedTeamLead, sql } from "./helpers/attack"

interface Target {
  kind: "org" | "personal"
  orgId: number | null
  role: number
  teams: Array<{ teamId: number }>
}

const CALLERS = ["owner", "org_contrib", TEAM_LEAD.name, "personal"] as const
const ORGS: Array<{ label: string; orgId?: number }> = [
  { label: "no orgId" },
  { label: "fixture org", orgId: 1 },
  { label: "personal org 2", orgId: 2 },
  { label: "missing org", orgId: 999 },
]
// Team 1: led by maintainer (600). Team 3: team_lead's. Team 4: in org 2, led by `personal`.
const TEAMS: Array<{ label: string; teamIds?: unknown }> = [
  { label: "no teamIds" },
  { label: "own led team", teamIds: [3] },
  { label: "team led by someone else", teamIds: [1] },
  { label: "team from another org", teamIds: [4] },
  { label: "empty array", teamIds: [] },
  { label: "duplicate ids", teamIds: [3, 3] },
  { label: "non-integer", teamIds: ["3"] },
  { label: "fractional", teamIds: [3.5] },
  { label: "led + not led", teamIds: [3, 1] },
]

function predict(targets: Target[], orgId: number | undefined, teamIds: unknown): boolean {
  if (teamIds !== undefined) {
    if (!Array.isArray(teamIds) || !teamIds.every((t) => Number.isInteger(t))) return false
  }
  const teams = [...new Set((teamIds as number[] | undefined) ?? [])]
  if (orgId === undefined) return teams.length === 0
  const target = targets.find((t) => t.orgId === orgId)
  if (!target) return false
  const offered = new Set(target.teams.map((t) => t.teamId))
  if (!teams.every((t) => offered.has(t))) return false
  return target.role >= 600 || teams.length > 0
}

beforeEach(async () => {
  await seedAccessFixture()
  await seedTeamLead()
  await sql("UPDATE group_members SET role_level = 600 WHERE group_id = 1 AND user_id = 5")
  await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (1, 2, 1, 600)")
  await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (4, 2, 'personal/team', 11)")
  await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (4, 11, 11, 600)")
})

describe.each(RESOLVER_MODES)("AQU-1352 attack #5 create-target fuzz (resolver %s)", (mode) => {
  for (const caller of CALLERS) {
    it(`${caller}: POST /projects outcome equals the create-targets prediction; denials create nothing`, async () => {
      const targets = (await req(mode, caller, "/api/v2/me/create-targets")).json as Target[]
      const mismatches: string[] = []
      let n = 0
      for (const org of ORGS) {
        for (const team of TEAMS) {
          const id = `fz-${caller}-${n++}`
          const body: Record<string, unknown> = { id, name: "Fuzz" }
          if (org.orgId !== undefined) body.orgId = org.orgId
          if (team.teamIds !== undefined) body.teamIds = team.teamIds
          const before = await count("SELECT count(*) AS n FROM projects")
          const res = await req(mode, caller, "/api/v2/projects", { method: "POST", body })
          const allowed = res.status === 200
          const expected = predict(targets, org.orgId, team.teamIds)
          if (allowed !== expected) {
            mismatches.push(`${org.label} × ${team.label}: expected ${expected ? "allow" : "deny"}, got ${res.status}`)
          }
          const exists = await count("SELECT count(*) AS n FROM projects WHERE id = ?", id)
          if (!allowed) {
            expect(res.status, `${org.label} × ${team.label}`).toBeGreaterThanOrEqual(400)
            expect(res.status).toBeLessThan(500)
            expect(exists, `denied ${org.label} × ${team.label} left a row`).toBe(0)
            expect(await count("SELECT count(*) AS n FROM projects")).toBe(before)
          } else {
            expect(exists).toBe(1)
          }
        }
      }
      expect(mismatches).toEqual([])
    })
  }

  // AQU-1352 finding: POST /projects checks `leadsATeam = some(team role >= 500)`,
  // so one led team in teamIds unlocks the whole list. team_lead (org 300, leads
  // only team 3) creates into org 1 with teamIds [3, 1] and the new project is
  // attached to team 1 ("fixture/translators", led by someone else) — a
  // selection create-targets never offers, and an attach the attach route
  // (org >= 600) would refuse. Should be `every`, not `some`.
  it("team_lead cannot attach a new project to a team it does not lead by bundling it with its own", async () => {
    const res = await req(mode, TEAM_LEAD.name, "/api/v2/projects", {
      method: "POST",
      body: { id: "fz-mixed", name: "Mixed", orgId: 1, teamIds: [3, 1] },
    })
    expect(res.status).toBe(403)
    expect(await count("SELECT count(*) AS n FROM group_project_grants WHERE group_id = 1 AND project_id = 'fz-mixed'")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM projects WHERE id = 'fz-mixed'")).toBe(0)
  })

  it("create-targets never offers a team outside the org it is listed under", async () => {
    for (const caller of CALLERS) {
      const targets = (await req(mode, caller, "/api/v2/me/create-targets")).json as Target[]
      for (const t of targets) {
        for (const team of t.teams) {
          const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM groups WHERE id = ?")
            .bind(team.teamId)
            .first<{ org_id: number }>()
          expect(Number(row?.org_id)).toBe(t.orgId)
        }
      }
    }
  })
})
