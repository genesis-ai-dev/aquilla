/**
 * AQU-1352 attack suite — inheritance demotion (#3), multi-team ambiguity
 * (#4) and direct-grant removal (#8).
 *
 * Why: the spec's promise is max-wins — adding a LOWER grant somewhere can
 * never take away a capability the user already had, and the member inspector
 * / People & access / roster dry-run must explain the same answer the
 * resolver enforces. A lower row that silently demotes an Owner, or a
 * "what survives removal" preview that disagrees with what actually happens,
 * is a lockout or a lie in the UI.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { FIXTURE_USERS, seedAccessFixture } from "./helpers/access-fixture"
import { RESOLVER_MODES, envFor, req, sql, type ResolverMode } from "./helpers/attack"
import { seedUser } from "./helpers/db"
import { resolveProjectRole } from "../services/project-permissions"
import type { AuthUser } from "../types"

async function loadUser(id: number): Promise<AuthUser> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email, password_hash, preferences, created_at, updated_at,
            password_changed_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<AuthUser>()
  if (!row) throw new Error(`user ${id} missing`)
  return row
}

async function effective(mode: ResolverMode, userId: number, pid: string): Promise<{ level: number; source: string } | null> {
  const r = await resolveProjectRole(envFor(mode), await loadUser(userId), pid)
  return r ? { level: r.level, source: r.source } : null
}

beforeEach(async () => {
  await seedAccessFixture()
})

// ── #3 lower grants never remove capability ───────────────────────────────────
describe.each(RESOLVER_MODES)("AQU-1352 attack #3 inheritance demotion (resolver %s)", (mode) => {
  it("org Owner keeps Owner on p1 after a lower team grant and a lower direct row are added", async () => {
    const before = await effective(mode, FIXTURE_USERS.owner, "p1")
    await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (1, 1, 1, 100)")
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 1, 100, 1)")
    const after = await effective(mode, FIXTURE_USERS.owner, "p1")
    expect(after?.level).toBe(before?.level)
    expect(after?.level).toBe(700)
    // Every gated action still works.
    expect((await req(mode, "owner", "/api/v2/projects/p1", { method: "PATCH", body: { name: "Alpha2" } })).status).toBe(200)
    expect((await req(mode, "owner", "/api/v2/projects/p1/invites", { method: "POST", body: { role: 300 } })).status).toBe(200)
    expect(
      (await req(mode, "owner", "/api/v2/projects/p1/members", { method: "POST", body: { username: "org_contrib", role: 700 } }))
        .status,
    ).toBe(200)
    expect((await req(mode, "owner", "/api/v2/projects/p1/archive", { method: "POST" })).status).toBe(200)
    // Org-level create is untouched by the lower project/team rows.
    expect((await req(mode, "owner", "/api/v2/projects", { method: "POST", body: { id: "own-new", name: "N", orgId: 1 } })).status).toBe(200)
  })

  it("team 600 is not demoted by a direct project 300 row", async () => {
    await seedUser(13, "t600")
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 13, 300, 1)")
    await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (5, 1, 'maint-team', 1)")
    await sql("INSERT INTO group_members (group_id, user_id, added_by) VALUES (5, 13, 1)")
    await sql("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (5, 'p1', 600, 1)")
    expect((await effective(mode, 13, "p1"))?.level).toBe(600)
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 13, 300, 1)")
    expect((await effective(mode, 13, "p1"))?.level).toBe(600)
    expect((await req(mode, "t600", "/api/v2/projects/p1", { method: "PATCH", body: { name: "Renamed" } })).status).toBe(200)
  })

  // AQU-1352 finding: a LOWER direct row removes capability. org 500 (sub-600)
  // + team 400 on p1 resolves to 500 via the org path (AQU-1274: the org role
  // counts once a team opens the project and there is no direct row). Adding a
  // direct 300 row suppresses the org path, so the user drops to 400 and loses
  // Project Lead actions (invites, member adds). Spec: lower grants never
  // remove capability; max-wins across all paths.
  // Deferred policy switch (pure max-over-ancestors), see ORCHESTRATION-AQU-1352 §1;
  // today's AQU-1274 rule lets an explicit direct row restrict the org path.
  it.fails("org 500 + team 400: adding a direct 300 row does not drop the user below 500", async () => {
    await sql("UPDATE org_members SET role_level = 500 WHERE org_id = 1 AND user_id = 5") // team_only
    const before = await effective(mode, FIXTURE_USERS.team_only, "p1")
    expect(before?.level).toBe(500)
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 5, 300, 1)")
    expect((await effective(mode, FIXTURE_USERS.team_only, "p1"))?.level).toBe(500)
    expect((await req(mode, "team_only", "/api/v2/projects/p1/invites", { method: "POST", body: { role: 300 } })).status).toBe(200)
  })
})

// ── #4 multi-team ambiguity ────────────────────────────────────────────────────
describe("AQU-1352 attack #4 multi-team ambiguity", () => {
  const TEAMS = [
    { id: 11, name: "mt/viewer", role: 100 },
    { id: 12, name: "mt/lead", role: 500 },
    { id: 13, name: "mt/maint", role: 600 },
    { id: 14, name: "mt/legacy", role: null },
  ]
  beforeEach(async () => {
    await seedUser(20, "multi")
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 20, 300, 1)")
    for (const t of TEAMS) {
      await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (?, 1, ?, 1)", t.id, t.name)
      await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (?, 20, 1, ?)", t.id, t.role)
      await sql("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, 'p2', 400, 1)", t.id)
    }
  })

  it("resolver 'on': effective is the highest team role (600)", async () => {
    expect((await effective("on", 20, "p2"))?.level).toBe(600)
  })

  // AQU-1352 finding: with team-scope roles, the inspector's effectiveHere
  // chain for p2 is [{scopePath: [], roleLevel: 600, origin: {kind: "direct"}},
  // org 300]. The 600 comes from the mt/maint TEAM role (0118 team-scope row),
  // but it is shipped as a DIRECT grant with an empty scope path, and none of
  // the four attached teams appear in the chain (they sit in `elsewhere`). The
  // user has no project_members row at all, so the UI would tell an admin to
  // "remove the direct grant" that does not exist.
  it("resolver 'on': inspector chain lists every contributing team", async () => {
    const res = await req("on", "owner", `/api/v2/users/20/access?from=project:p2`)
    expect(res.status).toBe(200)
    const body = res.json as { effectiveHere: { roleLevel: number; chain: unknown[] } }
    expect(body.effectiveHere.roleLevel).toBe(600)
    const top = body.effectiveHere.chain[0] as { origin: { kind: string } }
    expect(top.origin.kind, "no project_members row exists; winner cannot be direct").not.toBe("direct")
    const chain = JSON.stringify(body.effectiveHere.chain)
    for (const t of TEAMS) expect(chain, `chain misses ${t.name}`).toContain(t.name)
  })

  it.each(RESOLVER_MODES)("People & access (%s) shows p2 under every attached team", async (mode) => {
    interface Node { scope: { type: string; id: string; name: string }; children: Node[] }
    const res = await req(mode, "owner", "/api/v2/orgs/1/access")
    expect(res.status).toBe(200)
    const tree = (res.json as { tree: Node[] }).tree
    const teams = tree[0].children.filter((n) => n.scope.type === "team")
    for (const t of TEAMS) {
      const node = teams.find((n) => n.scope.name === t.name)
      expect(node, `team ${t.name} missing`).toBeDefined()
      expect(node?.children.some((c) => c.scope.id === "p2"), `p2 missing under ${t.name}`).toBe(true)
    }
  })

  it("resolver 'off' is unchanged by team roles (legacy reads attach level only)", async () => {
    expect(await effective("off", 20, "p2")).toEqual({ level: 400, source: "group" })
  })
})

// ── #8 removal dry-run matches reality ─────────────────────────────────────────
describe.each(RESOLVER_MODES)("AQU-1352 attack #8 afterDirectRemoval (resolver %s)", (mode) => {
  interface RosterRow {
    userId: number
    afterDirectRemoval?: { roleLevel: number; source: string } | null
  }
  const CASES: Array<{ label: string; userId: number; setup?: string }> = [
    { label: "direct 300 below team 400", userId: FIXTURE_USERS.direct_below },
    { label: "direct 600 above team 400", userId: FIXTURE_USERS.direct_above },
    {
      label: "direct 600 + team 400 + org 500 (org path reappears)",
      userId: FIXTURE_USERS.direct_above,
      setup: "UPDATE org_members SET role_level = 500 WHERE org_id = 1 AND user_id = 7",
    },
    { label: "direct only, no inheritance (access ends)", userId: FIXTURE_USERS.external },
  ]
  for (const c of CASES) {
    it(c.label, async () => {
      if (c.setup) await sql(c.setup)
      const pid = c.userId === FIXTURE_USERS.external ? "p2" : "p1"
      const roster = await req(mode, "owner", `/api/v2/projects/${pid}/members`)
      expect(roster.status).toBe(200)
      const row = (roster.json as { members: RosterRow[] }).members.find((m) => Number(m.userId) === c.userId)
      expect(row).toBeDefined()
      const predicted = row?.afterDirectRemoval ?? null
      const del = await req(mode, "owner", `/api/v2/projects/${pid}/members/${c.userId}`, { method: "DELETE" })
      expect(del.status).toBe(200)
      const actual = await effective(mode, c.userId, pid)
      expect(predicted ? { level: predicted.roleLevel, source: predicted.source } : null).toEqual(actual)
    })
  }
})
