// @vitest-environment node
// AQU-2352: migration 0210 writes exactly what the dry run plans, and after it
// nobody has lost a lane, a lane role or a project role.
//
// The fixture has the shapes the dev copy has: the Biblica ETT Pattani Malay
// case (org Project Lead on a team attached at Contributor, lane grant at
// Project Lead), an org Project Lead whose lane grant is only Contributor and
// is a team's row (0209), the testGroup case (org Contributor over a Viewer
// team), an org Contributor with a direct row (no lift), an org Contributor on
// no team (no lift), an org Maintainer, an archived project, the org Members
// page floor at Project Lead, and pending org invites.
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadRawAccessTables, type ReadQuery } from "./lib/access-snapshot"
import { applyPlanToRaw, loadOrgRoleExtras, planOrgRoles } from "./lib/org-roles-plan"
import { buildOrgRolesReport } from "./lib/org-roles-report"

const migration = readFileSync(
  new URL("../db/postgres/migrations/0210_org_roles_member_maintainer_owner.sql", import.meta.url),
  "utf8",
)

let db: PGlite
const query: ReadQuery = { query: async (sql: string) => ({ rows: (await db.query(sql)).rows as Array<Record<string, unknown>> }) }

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE organizations (id BIGINT PRIMARY KEY, name TEXT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE org_settings (org_id BIGINT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE org_invites (token TEXT PRIMARY KEY, org_id BIGINT NOT NULL, role_level INTEGER NOT NULL,
      created_by BIGINT NOT NULL, expires_at TIMESTAMPTZ, used_by BIGINT, used_at TIMESTAMPTZ, email TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, org_id BIGINT, created_by BIGINT NOT NULL, archived_at TIMESTAMPTZ);
    CREATE TABLE lanes (id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL, language TEXT, name TEXT,
      legacy_tag TEXT, position INTEGER NOT NULL DEFAULT 0, archived_at TIMESTAMPTZ, PRIMARY KEY (project_id, id));
    CREATE TABLE users (id BIGINT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE project_members (project_id TEXT, user_id BIGINT, role_level INTEGER, granted_by BIGINT,
      granted_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (project_id, user_id));
    CREATE TABLE org_members (org_id BIGINT, user_id BIGINT, role_level INTEGER, granted_by BIGINT,
      granted_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (org_id, user_id));
    CREATE TABLE groups (id BIGINT PRIMARY KEY, org_id BIGINT NOT NULL, name TEXT NOT NULL, legacy_uuid TEXT);
    CREATE TABLE group_members (group_id BIGINT, user_id BIGINT, role_level INTEGER, PRIMARY KEY (group_id, user_id));
    CREATE TABLE group_project_grants (group_id BIGINT, project_id TEXT, role_level INTEGER NOT NULL,
      lanes_explicit BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (group_id, project_id));
    CREATE TABLE group_project_lanes (group_id BIGINT, project_id TEXT, lane_id TEXT, PRIMARY KEY (group_id, project_id, lane_id));
    CREATE TABLE project_member_lane_roles (project_id TEXT, user_id BIGINT, lane TEXT, role_level INTEGER NOT NULL,
      granted_by BIGINT, team_group_id BIGINT, PRIMARY KEY (project_id, user_id, lane));
    CREATE TABLE project_member_scopes (project_id TEXT, user_id BIGINT, kind TEXT, value TEXT, PRIMARY KEY (project_id, user_id, kind, value));

    INSERT INTO organizations (id, name) VALUES (1, 'Biblica ETT'), (2, 'testGroup');
    INSERT INTO org_settings VALUES (1, '{"rosterViewMinRole":500}');
    INSERT INTO users VALUES (1, 'owner'), (2, 'jmaves'), (3, 'mentor'), (4, 'tester'), (5, 'direct-contrib'),
      (6, 'no-team'), (7, 'org-maint');
    INSERT INTO projects VALUES
      ('p-pattani', 'Pattani Malay Bible', 1, 1, NULL),
      ('p-algerian', 'Algerian Arabic Bible', 1, 1, NULL),
      ('p-old', 'pattani-malay-rep', 1, 1, now()),
      ('p-test', 'gitOld-Algerian', 2, 1, NULL);
    INSERT INTO lanes VALUES
      ('src', 'p-pattani', 'source', 'ms', NULL, NULL, 0, NULL),
      ('pat', 'p-pattani', 'target', 'Pattani Malay', NULL, '', 1, NULL),
      ('pat-old', 'p-pattani', 'target', 'Pattani (old)', NULL, 'x', 2, now()),
      ('alg', 'p-algerian', 'target', 'Algerian', NULL, '', 1, NULL),
      ('alg2', 'p-algerian', 'target', 'Kabyle', NULL, 'kab', 2, NULL),
      ('old', 'p-old', 'target', 'Pattani', NULL, '', 1, NULL),
      ('tst', 'p-test', 'target', 'Algerian', NULL, '', 1, NULL);
    INSERT INTO org_members (org_id, user_id, role_level) VALUES
      (1, 1, 700), (1, 2, 500), (1, 3, 500), (1, 5, 400), (1, 6, 400), (1, 7, 600), (2, 4, 400), (2, 1, 700);
    INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p-algerian', 5, 400);
    INSERT INTO groups VALUES (10, 1, 'biblica/pattani', 'u1'), (11, 1, 'biblica/algerian', 'u2'), (12, 2, 'test', NULL);
    INSERT INTO group_members VALUES (10, 2, NULL), (11, 2, NULL), (11, 3, NULL), (11, 5, NULL), (12, 4, NULL);
    INSERT INTO group_project_grants VALUES (10, 'p-pattani', 400, true), (10, 'p-old', 400, true),
      (11, 'p-algerian', 400, true), (12, 'p-test', 100, true);
    INSERT INTO group_project_lanes VALUES (10, 'p-pattani', 'pat'), (10, 'p-old', 'old'), (11, 'p-algerian', 'alg'),
      (11, 'p-algerian', 'alg2'), (12, 'p-test', 'tst');
    INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, team_group_id) VALUES
      ('p-pattani', 2, 'pat', 500, NULL),
      ('p-pattani', 2, 'pat-old', 400, NULL),
      ('p-pattani', 2, 'src', 400, NULL),
      ('p-old', 2, 'old', 500, NULL),
      ('p-algerian', 3, 'alg', 400, 11),
      ('p-algerian', 5, 'alg', 400, NULL),
      ('p-test', 4, 'tst', 400, NULL);
    INSERT INTO org_invites (token, org_id, role_level, created_by, email) VALUES
      ('t-contrib', 1, 400, 1, 'a@example.org'), ('t-maint', 1, 600, 1, NULL);
    INSERT INTO org_invites (token, org_id, role_level, created_by, used_by, used_at) VALUES ('t-used', 1, 400, 1, 6, now());
  `)
}, 30_000)
afterEach(async () => {
  await db.close()
})

const sorted = <T>(rows: T[], key: (r: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b)))

describe("AQU-2352 dry run and migration 0210", () => {
  it("the migration's result is exactly the dry run's plan, and a second run changes nothing", async () => {
    const raw = await loadRawAccessTables(query)
    const extras = await loadOrgRoleExtras(query)
    const plan = planOrgRoles(raw, extras)
    expect(plan.lifted.map((p) => [p.userId, p.projectId, p.orgLevel, p.teamLevel]).sort()).toEqual(
      [
        [2, "p-pattani", 500, 400],
        [2, "p-old", 500, 400],
        // On the Algerian team too, but holds no lane there: a direct row only.
        [2, "p-algerian", 500, 400],
        [3, "p-algerian", 500, 400],
        [4, "p-test", 400, 100],
      ].sort(),
    )
    const expected = applyPlanToRaw(raw, plan)

    await db.exec(migration)
    const after = await loadRawAccessTables(query)
    const om = (r: { org_id: number; user_id: number }) => `${r.org_id}:${r.user_id}`
    const pm = (r: { project_id: string; user_id: number }) => `${r.project_id}:${r.user_id}`
    const lg = (r: { project_id: string; user_id: number; lane: string }) => `${r.project_id}:${r.user_id}:${r.lane}`
    expect(sorted(after.orgMembers, om)).toEqual(sorted(expected.orgMembers, om))
    expect(sorted(after.projectMembers, pm)).toEqual(sorted(expected.projectMembers, pm))
    expect(sorted(after.laneGrants, lg)).toEqual(sorted(expected.laneGrants, lg))
    // Every lane row of a lifted pair is direct now; the source-lane row was not touched.
    const teams = (await db.query<{ k: string; team_group_id: number | null; role_level: number }>(
      "SELECT project_id || ':' || user_id || ':' || lane AS k, team_group_id, role_level FROM project_member_lane_roles ORDER BY 1",
    )).rows
    expect(teams.find((r) => r.k === "p-algerian:3:alg")).toMatchObject({ team_group_id: null, role_level: 500 })
    expect(teams.find((r) => r.k === "p-pattani:2:src")?.role_level).toBe(400)
    const invites = (await db.query<{ token: string; role_level: number }>("SELECT token, role_level FROM org_invites ORDER BY token")).rows
    expect(invites).toEqual([
      { token: "t-contrib", role_level: 100 },
      { token: "t-maint", role_level: 600 },
      { token: "t-used", role_level: 400 },
    ])
    expect(plan.inviteChanges.map((i) => i.token)).toEqual(["t-contrib"])

    await db.exec(migration)
    const again = await loadRawAccessTables(query)
    expect(sorted(again.projectMembers, pm)).toEqual(sorted(expected.projectMembers, pm))
    expect(sorted(again.laneGrants, lg)).toEqual(sorted(expected.laneGrants, lg))
    expect(planOrgRoles(again, await loadOrgRoleExtras(query)).orgRowChanges).toEqual([])
  })

  it("loses nobody a lane, a lane role or a project role, and lists what the lift did", async () => {
    const raw = await loadRawAccessTables(query)
    const report = buildOrgRolesReport(raw, await loadOrgRoleExtras(query), { mode: "test", generatedAt: "t" })
    expect(report.unintendedLosses).toBe(0)
    expect(report.laneRoleDropsAfter).toBe(0)
    expect(report.plan.orgRowChanges.map((c) => [c.userId, c.from])).toEqual([[2, 500], [3, 500], [5, 400], [6, 400], [4, 400]])

    const pair = (userId: number, projectId: string) => report.plan.lifted.find((p) => p.userId === userId && p.projectId === projectId)!
    // Pattani Malay: org Project Lead + team Contributor keeps Project Lead on the lane.
    expect(pair(2, "p-pattani")).toMatchObject({ roleBefore: 500, roleWithoutFix: 400 })
    expect(pair(2, "p-pattani").lanes.find((l) => l.laneId === "pat")).toMatchObject({
      grantBefore: 500, laneRoleBefore: 500, laneRoleWithoutFix: 500, grantAfter: 500,
    })
    // A team's Contributor row under an org Project Lead: the lane role would drop.
    expect(pair(3, "p-algerian").lanes).toEqual([
      { laneId: "alg", archived: false, grantBefore: 400, laneRoleBefore: 500, laneRoleWithoutFix: 400, grantAfter: 500, becomesDirect: true },
    ])
    // testGroup: org Contributor over a Viewer team. The lane grant already says Contributor.
    expect(pair(4, "p-test")).toMatchObject({ roleBefore: 400, roleWithoutFix: 100 })
    expect(pair(2, "p-algerian").lanes).toEqual([])
    // Not lifted: a direct row, and no team at all.
    expect(report.plan.lifted.some((p) => p.userId === 5 || p.userId === 6)).toBe(false)
    // Biblica ETT's floor is Project Lead: its two org Project Leads lose the org Members page.
    expect(report.plan.membersPageLosses.map((l) => [l.userId, l.floor])).toEqual([[2, 500], [3, 500]])
    expect(report.markdown).toContain("Pattani Malay Bible")
  })
})
