// AQU-1352 P1: resolveFromGrants must equal today's resolveProjectRoleShared
// for every scenario, because a later phase swaps callers onto it. The oracle is
// the real resolver run against a fake db that answers its per-table queries
// from the same grant list. If either rule drifts, these tests fail.
import { describe, expect, it } from "vitest"
import type { AquillaDb } from "../shim/postgres"
import { resolveFromGrants, type AccessGrant } from "./access-grants"
import { resolveProjectRoleShared } from "./project-roles"

const P = "proj-1"
const ORG = "10"
const USER = "42"
const ADMIN = "ops@example.com"

const g = (
  scopeType: AccessGrant["scopeType"],
  source: AccessGrant["source"],
  roleLevel: number,
  viaTeamId: string | null = null,
): AccessGrant => ({
  userId: USER,
  scopeType,
  scopeId: scopeType === "org" ? ORG : P,
  roleLevel,
  source,
  viaTeamId,
  grantedBy: null,
  grantedAt: null,
})

interface Scenario {
  name: string
  grants: AccessGrant[]
  email?: string
  archived?: boolean
  expected: { level: number; source: string } | null
}

/** Fake db that answers resolveProjectRoleShared's queries from `grants`. */
function fakeDb(s: Scenario): AquillaDb {
  const creator = s.grants.some((x) => x.source === "creator")
  const direct = s.grants.find((x) => x.scopeType === "project" && x.source === "direct")
  const teams = s.grants.filter((x) => x.source === "team")
  const org = s.grants.find((x) => x.scopeType === "org")
  const answer = (sql: string): unknown => {
    if (sql.includes("FROM projects"))
      return {
        id: P,
        org_id: Number(ORG),
        created_by: creator ? Number(USER) : 999,
        archived_at: s.archived ? "2026-01-01" : null,
      }
    if (sql.includes("FROM project_members")) return direct ? { role_level: direct.roleLevel } : null
    if (sql.includes("group_project_grants"))
      return { role_level: teams.length ? Math.max(...teams.map((t) => t.roleLevel)) : null }
    if (sql.includes("FROM org_members")) return org ? { role_level: org.roleLevel } : null
    throw new Error(`unexpected sql: ${sql}`)
  }
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    first: async () => answer(sql),
  })
  return { prepare: (sql: string) => stmt(sql) } as unknown as AquillaDb
}

const scenarios: Scenario[] = [
  {
    // Tim: org guest (100) who owns a team attached at 700 — the team path wins.
    name: "Tim: org guest + team owner -> team 700",
    grants: [g("org", "direct", 100), g("project", "team", 700, "7")],
    expected: { level: 700, source: "group" },
  },
  {
    // AQU-1274 (Biblica ETT Pattani Malay): the org role must not be demoted by
    // a Contributor team attachment.
    name: "Naladda: org 500 + team 400 -> org 500",
    grants: [g("org", "direct", 500), g("project", "team", 400, "7")],
    expected: { level: 500, source: "org" },
  },
  {
    // AQU-1274 rule 2: an explicit per-project row can restrict below org.
    name: "direct row restricts sub-floor org role",
    grants: [g("org", "direct", 500), g("project", "team", 400, "7"), g("project", "direct", 200)],
    expected: { level: 400, source: "group" },
  },
  {
    name: "direct row alone",
    grants: [g("project", "direct", 300)],
    expected: { level: 300, source: "override" },
  },
  {
    // AQU-435: a sub-maintainer org role opens nothing on its own.
    name: "sub-600 org alone -> null",
    grants: [g("org", "direct", 500)],
    expected: null,
  },
  {
    name: "org maintainer opens the project (AQU-435 floor)",
    grants: [g("org", "direct", 600)],
    expected: { level: 600, source: "org" },
  },
  {
    name: "org maintainer beats a lower direct row (max-wins)",
    grants: [g("org", "direct", 600), g("project", "direct", 200)],
    expected: { level: 600, source: "org" },
  },
  {
    name: "creator -> 700",
    grants: [g("project", "creator", 700)],
    expected: { level: 700, source: "creator" },
  },
  {
    name: "creator ties direct owner row -> override keeps attribution",
    grants: [g("project", "creator", 700), g("project", "direct", 700)],
    expected: { level: 700, source: "override" },
  },
  {
    name: "platform admin with no grant -> 700 platform",
    grants: [],
    email: ` ${ADMIN.toUpperCase()} `,
    expected: { level: 700, source: "platform" },
  },
  {
    name: "platform admin who is creator -> creator attribution",
    grants: [g("project", "creator", 700)],
    email: ADMIN,
    expected: { level: 700, source: "creator" },
  },
  {
    name: "two teams -> max team",
    grants: [g("project", "team", 200, "7"), g("project", "team", 500, "8")],
    expected: { level: 500, source: "group" },
  },
  {
    name: "archived project -> null even for creator",
    grants: [g("project", "creator", 700)],
    archived: true,
    expected: null,
  },
  { name: "no grants -> null", grants: [], expected: null },
]

describe("AQU-1352 resolveFromGrants equals resolveProjectRoleShared", () => {
  for (const s of scenarios) {
    it(s.name, async () => {
      const current = await resolveProjectRoleShared(fakeDb(s), { id: USER, email: s.email }, P, ADMIN)
      expect(current).toEqual(s.expected)

      const email = s.email?.trim().toLowerCase()
      const viaGrants = resolveFromGrants(s.grants, {
        projectId: P,
        orgId: ORG,
        archivedAt: s.archived ? "2026-01-01" : null,
        isPlatformAdmin: email === ADMIN,
      })
      expect(viaGrants && { level: viaGrants.level, source: viaGrants.source }).toEqual(current)
    })
  }

  it("chain lists every contributing path, winner first (member inspector)", () => {
    const r = resolveFromGrants(
      [g("org", "direct", 500), g("project", "team", 400, "7"), g("project", "creator", 700)],
      { projectId: P, orgId: ORG, archivedAt: null, isPlatformAdmin: false },
    )
    expect(r?.chain.map((c) => [c.source, c.level])).toEqual([
      ["creator", 700],
      ["org", 500],
      ["group", 400],
    ])
    expect(r?.chain[2].grant?.viaTeamId).toBe("7")
  })

  it("ignores grants on other projects and orgs", () => {
    const other = { ...g("project", "direct", 700), scopeId: "proj-2" }
    const otherOrg = { ...g("org", "direct", 700), scopeId: "11" }
    expect(
      resolveFromGrants([other, otherOrg], {
        projectId: P,
        orgId: ORG,
        archivedAt: null,
        isPlatformAdmin: false,
      }),
    ).toBeNull()
  })
})

// AQU-1352 P2 (spec §3.1, §3.5): team-scope roles (group_members.role_level).
describe("AQU-1352 P2 team-scope grants", () => {
  const teamRole = (teamId: string, roleLevel: number): AccessGrant => ({
    ...g("project", "direct", roleLevel),
    scopeType: "team",
    scopeId: teamId,
  })
  const ctx = (projectId: string, attachedTeamIds: string[]) => ({
    projectId,
    orgId: ORG,
    archivedAt: null,
    isPlatformAdmin: false,
    attachedTeamIds,
  })

  it("all role_level NULL (existing data): attached teams change nothing", () => {
    // Every existing member has NULL, so no team-scope row exists. Passing the
    // attached-team list must give the same answer as the P1 scenarios above.
    for (const s of scenarios.filter((x) => !x.email && !x.archived)) {
      const r = resolveFromGrants(s.grants, ctx(P, ["7", "8"]))
      expect(r && { level: r.level, source: r.source }).toEqual(s.expected)
    }
  })

  it("Tim: org 100 + team role 700 on a team with no projects -> no project access", () => {
    // Tim may create into the team (route gate), but owning an empty team opens
    // no project: the grant only flows to attached projects.
    const grants = [g("org", "direct", 100), teamRole("7", 700)]
    expect(resolveFromGrants(grants, ctx(P, []))).toBeNull()
  })

  it("team lead 500 on a team with 3 projects -> 500 on those 3, null elsewhere", () => {
    const grants = [teamRole("7", 500)]
    for (const pid of ["a", "b", "c"]) {
      const r = resolveFromGrants(grants, ctx(pid, ["7"]))
      expect(r?.level).toBe(500)
      expect(r?.source).toBe("group")
      expect(r?.chain[0].grant?.viaTeamId).toBe("7")
    }
    expect(resolveFromGrants(grants, ctx("elsewhere", ["9"]))).toBeNull()
  })

  it("team-scope role and per-project attachment: max wins", () => {
    // A Contributor attachment (400) must not cap a Project Lead team role (500).
    const grants = [{ ...g("project", "team", 400, "7") }, teamRole("7", 500)]
    expect(resolveFromGrants(grants, ctx(P, ["7"]))?.level).toBe(500)
  })

  it("a team-scope grant opens the project for the AQU-1274 org path", () => {
    // Same as a team path: org 500 lifts a team Viewer (100) to 500.
    const grants = [g("org", "direct", 500), teamRole("7", 100)]
    const r = resolveFromGrants(grants, ctx(P, ["7"]))
    expect(r && { level: r.level, source: r.source }).toEqual({ level: 500, source: "org" })
  })
})
