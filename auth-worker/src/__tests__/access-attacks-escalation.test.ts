/**
 * AQU-1352 attack suite — escalation (ticket "try to break it" #2).
 *
 * Why: team-scope roles and create-into-team hand real management power to
 * people below org Maintainer (the Tim case). Each of those gates is a place
 * a Project Lead could climb: raise their own team role, mint a link above the
 * cap, grant a member above themselves, create into a team they don't lead,
 * or keep approving agent changesets after losing access. Every attack must be
 * denied AND the database must be unchanged. A structured role_required body
 * must describe only the caller's own role, never someone else's.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { FIXTURE_USERS, seedAccessFixture } from "./helpers/access-fixture"
import { RESOLVER_MODES, TEAM_LEAD, count, req, seedTeamLead, sql } from "./helpers/attack"

const teamRole = async (groupId: number, userId: number): Promise<number | null | undefined> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM group_members WHERE group_id = ? AND user_id = ?",
  )
    .bind(groupId, userId)
    .first<{ role_level: number | null }>()
  return row === null ? undefined : row.role_level
}

const orgRole = async (userId: number): Promise<number | null> =>
  (
    await env.AQUILLA_PG.prepare("SELECT role_level FROM org_members WHERE org_id = 1 AND user_id = ?")
      .bind(userId)
      .first<{ role_level: number }>()
  )?.role_level ?? null

/** A role_required body may only describe the caller's own role at this scope. */
function assertRoleBodyHonest(json: unknown, callerLevelHere: number | null): void {
  const b = json as { code?: string; actual?: { roleLevel: number | null; scopePath?: string[] } } | null
  if (b?.code !== "role_required") return
  expect(b.actual?.roleLevel ?? null).toBe(callerLevelHere)
  for (const s of b.actual?.scopePath ?? []) {
    for (const hidden of ["Beta", "Gamma", "fixture/leads", "fixture/translators"]) expect(s).not.toContain(hidden)
  }
}

beforeEach(async () => {
  await seedAccessFixture()
  await seedTeamLead()
})

describe.each(RESOLVER_MODES)("AQU-1352 attack #2 escalation (resolver %s)", (mode) => {
  it("a team Project Lead cannot raise its own team role, nor anyone else's", async () => {
    for (const level of [500, 600, 700]) {
      const self = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/3/members/12`, {
        method: "PATCH",
        body: { roleLevel: level },
      })
      expect([400, 403], `self → ${level}: ${self.status}`).toContain(self.status)
    }
    // Team 1 (translators): team_lead is not even a member.
    const other = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/1/members/5`, {
      method: "PATCH",
      body: { roleLevel: 600 },
    })
    expect(other.status).toBe(403)
    expect(await teamRole(3, 12)).toBe(500)
    expect(await teamRole(1, 5)).toBeNull()
  })

  it("a team Maintainer cannot grant above 600, cannot touch another team, cannot promote themselves to org", async () => {
    await sql("UPDATE group_members SET role_level = 600 WHERE group_id = 3 AND user_id = 12")
    const owner = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/3/members/12`, {
      method: "PATCH",
      body: { roleLevel: 700 },
    })
    expect(owner.status).toBe(400)
    const cross = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/1/members/5`, {
      method: "PATCH",
      body: { roleLevel: 600 },
    })
    expect(cross.status).toBe(403)
    expect(await teamRole(1, 5)).toBeNull()

    // Org-role writes are owner-only.
    const orgGrant = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/members`, {
      method: "POST",
      body: { username: "team_lead", role: 600 },
    })
    expect(orgGrant.status).toBe(403)
    const orgInvite = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/invites`, { method: "POST", body: { role: 600 } })
    expect(orgInvite.status).toBe(403)
    expect(await orgRole(12)).toBe(300)

    // Adding self to a team they do not lead needs org >= 600.
    const join = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/2/members`, {
      method: "POST",
      body: { username: "team_lead" },
    })
    expect(join.status).toBe(403)
    expect(await teamRole(2, 12)).toBeUndefined()
    // Re-pointing team 3 at p2 / raising its project grant needs org >= 600 too.
    const attach = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/3/projects`, {
      method: "POST",
      body: { projectId: "p2", roleLevel: 600 },
    })
    expect(attach.status).toBe(403)
    const raise = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/groups/3/projects/p1`, {
      method: "PATCH",
      body: { roleLevel: 700 },
    })
    expect(raise.status).toBe(403)
    expect(await count("SELECT count(*) AS n FROM group_project_grants WHERE group_id = 3 AND project_id = 'p2'")).toBe(0)
    expect(await count("SELECT count(*) AS n FROM group_project_grants WHERE group_id = 3 AND role_level = 500")).toBe(1)
  })

  it("an invite link above the cap is clamped to Contributor, never above the minter", async () => {
    for (const role of [500, 600, 700]) {
      const res = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1/invites`, { method: "POST", body: { role } })
      expect([200, 201, 403], `invite ${role}: ${res.status}`).toContain(res.status)
    }
    expect(
      await count("SELECT count(*) AS n FROM project_invites WHERE project_id = 'p1' AND role_level > 400"),
    ).toBe(0)
  })

  it("a Project Lead cannot add a member above its own level (single and batch)", async () => {
    const single = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1/members`, {
      method: "POST",
      body: { username: "org_contrib", role: 600 },
    })
    expect(single.status).toBe(403)
    assertRoleBodyHonest(single.json, 500)
    const batch = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1/members`, {
      method: "POST",
      body: { members: [{ username: "org_contrib", role: 700 }, { username: "tim", role: 600 }] },
    })
    expect(batch.status).toBe(200)
    const results = (batch.json as { results: Array<{ ok: boolean }> }).results
    expect(results.every((r) => !r.ok)).toBe(true)
    expect(
      await count("SELECT count(*) AS n FROM project_members WHERE project_id = 'p1' AND user_id IN (4, 10)"),
    ).toBe(0)
  })

  it("a Project Lead cannot demote someone above it on the project", async () => {
    // direct_above holds a direct 600 on p1.
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1/members`, {
      method: "POST",
      body: { username: "direct_above", role: 300 },
    })
    expect(res.status).toBe(403)
    const del = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1/members/${FIXTURE_USERS.direct_above}`, {
      method: "DELETE",
    })
    expect(del.status).toBe(403)
    expect(
      await count("SELECT count(*) AS n FROM project_members WHERE project_id = 'p1' AND user_id = 7 AND role_level = 600"),
    ).toBe(1)
  })

  it("POST /projects into a team it does not lead, or another org, is denied and creates nothing", async () => {
    const before = await count("SELECT count(*) AS n FROM projects")
    const attempts: unknown[] = [
      { id: "x1", name: "X", orgId: 1 },
      { id: "x2", name: "X", orgId: 1, teamIds: [1] },
      { id: "x3", name: "X", orgId: 1, teamIds: [2] },
      { id: "x4", name: "X", orgId: 2 },
      { id: "x5", name: "X", orgId: 2, teamIds: [3] },
    ]
    for (const body of attempts) {
      const res = await req(mode, TEAM_LEAD.name, `/api/v2/projects`, { method: "POST", body })
      expect([400, 403], `${JSON.stringify(body)} → ${res.status}`).toContain(res.status)
      assertRoleBodyHonest(res.json, (body as { orgId: number }).orgId === 1 ? 300 : null)
      expect(res.text).not.toContain("personal's workspace")
    }
    expect(await count("SELECT count(*) AS n FROM projects")).toBe(before)
  })

  it("role_required bodies on project gates report only the caller's own level", async () => {
    const rename = await req(mode, TEAM_LEAD.name, `/api/v2/projects/p1`, { method: "PATCH", body: { name: "Z" } })
    expect(rename.status).toBe(403)
    assertRoleBodyHonest(rename.json, 500)
    expect(rename.text).not.toContain("fixture/translators")
  })
})

// ── Changeset approval after removal ─────────────────────────────────────────
describe.each(RESOLVER_MODES)("AQU-1352 attack #2 changeset approve after removal (resolver %s)", (mode) => {
  async function seedChangeset(): Promise<void> {
    const cred = crypto.randomUUID()
    await sql(
      `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode)
       VALUES (?, '1', 'c', 'aqk_test', ?, 'ask')`,
      cred,
      `hash-${cred}`,
    )
    await sql(
      `INSERT INTO changesets
         (id, project_id, created_by_user_id, credential_id, autonomy_mode, status,
          commands, preconditions, summary, digest, expires_at)
       VALUES ('cs1', 'p1', '1', ?, 'ask', 'staged', ?::jsonb, '[]'::jsonb, '{}'::jsonb, 'sha256:d', ?)`,
      cred,
      JSON.stringify([{ kind: "SetTranslation", fileId: "f", cellId: "c", value: "v" }]),
      new Date(Date.now() + 3600_000).toISOString(),
    )
  }

  it("a team lead removed from the team can no longer approve a p1 changeset", async () => {
    await seedChangeset()
    // Sanity: while on the team the lead clears the SetTranslation floor.
    const ok = await req(mode, TEAM_LEAD.name, `/api/v2/changesets/cs1/approval`)
    expect(ok.status).toBe(200)
    await sql("DELETE FROM group_members WHERE group_id = 3 AND user_id = 12")
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/changesets/cs1/approve`, {
      method: "POST",
      body: { digest: "sha256:d" },
    })
    expect(res.status).toBe(403)
    expect(await count("SELECT count(*) AS n FROM changeset_confirmations WHERE changeset_id = 'cs1'")).toBe(0)
  })
})
