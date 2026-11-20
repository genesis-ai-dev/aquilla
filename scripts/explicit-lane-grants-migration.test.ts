// @vitest-environment node
// AQU-2355: migration 0208 writes exactly what the dry run plans, and the dry
// run's before/after access loses nobody a lane.
//
// The fixture has the shapes the dev copy has: a team attachment still at
// `lanes_explicit = false` on a two-lane project (one lane archived), an
// explicit one, a direct member who held every lane (AQU-1781 handed them each
// new lane), a lane-scoped member, an org Maintainer, and a lane-less project.
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { diffAccess } from "./lib/access-report"
import { AQU_1781_RULE, AQU_2355_RULE, computeAccess, loadRawAccessTables, type ReadQuery } from "./lib/access-snapshot"
import { applyPlanToRaw, ddCrossCheck, planExplicitLaneGrants, planGrantsAdded } from "./lib/explicit-lane-grants-plan"

const migration = readFileSync(
  new URL("../db/postgres/migrations/0208_team_attachments_list_their_lanes.sql", import.meta.url),
  "utf8",
)

let db: PGlite
const query: ReadQuery = { query: async (sql: string) => ({ rows: (await db.query(sql)).rows as Array<Record<string, unknown>> }) }

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE organizations (id BIGINT PRIMARY KEY, name TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, org_id BIGINT, created_by BIGINT NOT NULL, archived_at TIMESTAMPTZ);
    CREATE TABLE lanes (id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL, language TEXT, name TEXT,
      legacy_tag TEXT, position INTEGER NOT NULL DEFAULT 0, archived_at TIMESTAMPTZ, PRIMARY KEY (project_id, id));
    CREATE TABLE users (id BIGINT PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE project_members (project_id TEXT, user_id BIGINT, role_level INTEGER, PRIMARY KEY (project_id, user_id));
    CREATE TABLE org_members (org_id BIGINT, user_id BIGINT, role_level INTEGER, PRIMARY KEY (org_id, user_id));
    CREATE TABLE groups (id BIGINT PRIMARY KEY, org_id BIGINT NOT NULL, name TEXT NOT NULL, legacy_uuid TEXT);
    CREATE TABLE group_members (group_id BIGINT, user_id BIGINT, role_level INTEGER, PRIMARY KEY (group_id, user_id));
    CREATE TABLE group_project_grants (group_id BIGINT, project_id TEXT, role_level INTEGER NOT NULL,
      lanes_explicit BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (group_id, project_id));
    CREATE TABLE group_project_lanes (group_id BIGINT, project_id TEXT, lane_id TEXT, PRIMARY KEY (group_id, project_id, lane_id));
    CREATE TABLE project_member_lane_roles (project_id TEXT, user_id BIGINT, lane TEXT, role_level INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id, lane));
    CREATE TABLE project_member_scopes (project_id TEXT, user_id BIGINT, kind TEXT, value TEXT, PRIMARY KEY (project_id, user_id, kind, value));

    INSERT INTO organizations VALUES (1, 'Come and See'), (2, 'Living on the Edge');
    INSERT INTO users VALUES (1, 'owner'), (2, 'every-lane'), (3, 'scoped'), (4, 'org-maint'), (5, 'team-only'), (6, 'bare-member');
    INSERT INTO projects VALUES ('p-two', 'Two lanes', 2, 1, NULL), ('p-one', 'One lane', 1, 1, NULL), ('p-bare', 'No lanes', 1, 1, NULL);
    INSERT INTO lanes VALUES
      ('src-two', 'p-two', 'source', 'en', NULL, NULL, 0, NULL),
      ('fr', 'p-two', 'target', 'French', NULL, 'fr', 1, NULL),
      ('es', 'p-two', 'target', 'Spanish', NULL, 'es', 2, NULL),
      ('old', 'p-two', 'target', 'Dutch', NULL, 'nl', 3, now()),
      ('sw', 'p-one', 'target', NULL, NULL, '', 1, NULL);
    INSERT INTO project_members VALUES ('p-two', 2, 400), ('p-two', 3, 400), ('p-one', 2, 100), ('p-bare', 6, 400);
    INSERT INTO org_members VALUES (2, 4, 600), (2, 5, 400);
    INSERT INTO project_member_lane_roles VALUES
      ('p-two', 2, 'fr', 400), ('p-two', 2, 'es', 400), ('p-two', 2, 'old', 400),
      ('p-two', 3, 'fr', 400),
      ('p-two', 5, 'fr', 100), ('p-two', 5, 'es', 100), ('p-two', 5, 'old', 100),
      ('p-one', 2, 'sw', 100);
    INSERT INTO project_member_scopes VALUES ('p-two', 3, 'lane', 'fr');
    INSERT INTO groups VALUES (10, 2, 'Spanish Team', NULL), (11, 1, 'the-chosen/swahili', 'uuid');
    INSERT INTO group_members VALUES (10, 5, NULL), (11, 2, NULL);
    INSERT INTO group_project_grants VALUES (10, 'p-two', 100, false), (11, 'p-one', 400, true);
    INSERT INTO group_project_lanes VALUES (11, 'p-one', 'sw');
  `)
}, 30_000)
afterEach(async () => {
  await db.close()
})

describe("AQU-2355 dry run and migration 0208", () => {
  it("the migration's result is exactly the dry run's plan, and a second run changes nothing", async () => {
    const raw = await loadRawAccessTables(query)
    const plan = planExplicitLaneGrants(raw)
    expect(plan.teamLinks).toEqual([
      { groupId: 10, projectId: "p-two", laneIds: ["fr", "es"], roleLevel: 100, projectArchived: false },
    ])
    const expected = applyPlanToRaw(raw, plan)

    await db.exec(migration)
    const after = await loadRawAccessTables(query)
    const sortLanes = (rows: typeof after.groupProjectLanes) =>
      [...rows].sort((a, b) => `${a.group_id}${a.project_id}${a.lane_id}`.localeCompare(`${b.group_id}${b.project_id}${b.lane_id}`))
    expect(sortLanes(after.groupProjectLanes)).toEqual(sortLanes(expected.groupProjectLanes))
    const byKey = (rows: typeof after.groupProjectGrants) =>
      [...rows].sort((a, b) => a.group_id - b.group_id || a.project_id.localeCompare(b.project_id))
    expect(byKey(after.groupProjectGrants)).toEqual(byKey(expected.groupProjectGrants))
    expect(after.laneGrants).toEqual(raw.laneGrants)

    await db.exec(migration)
    expect(sortLanes((await loadRawAccessTables(query)).groupProjectLanes)).toEqual(sortLanes(expected.groupProjectLanes))
    const inserted = await db.query<{ lanes_explicit: boolean }>(
      "INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (12, 'p-one', 400) RETURNING lanes_explicit",
    )
    expect(inserted.rows[0]?.lanes_explicit).toBe(true)
  })

  it("loses nobody a lane, and lists who stops receiving later lanes", async () => {
    const raw = await loadRawAccessTables(query)
    const plan = planExplicitLaneGrants(raw)
    const before = computeAccess(raw, AQU_1781_RULE)
    const after = computeAccess(applyPlanToRaw(raw, plan), AQU_2355_RULE)
    const report = diffAccess({ title: "t", before, after, grantsAdded: planGrantsAdded(raw, plan) })

    expect(report.totals.unintendedLosses).toBe(0)
    expect(report.totals.gains).toBe(0)
    expect(report.totals.grantsAdded).toBe(1)
    const future = report.orgs
      .flatMap((o) => o.futureChanges)
      .map((p) => [p.userId, p.projectId, p.futureBefore, p.futureAfter])
      .sort()
    expect(future).toEqual(
      [
        // Held every lane, archived included, no scope: AQU-1781 gave them each new lane.
        [2, "p-two", "every", "none"],
        [2, "p-one", "every", "none"],
        // Team-only (Viewer team), held every lane: the same rule, via the team.
        [5, "p-two", "every", "none"],
        // A lane-less project: still gets its first lane.
        [6, "p-bare", "every", "first-only"],
      ].sort(),
    )
    // The lane-scoped member and the org Maintainer are unchanged.
    const pair = (userId: number, projectId: string) =>
      report.orgs.flatMap((o) => o.pairs).find((p) => p.userId === userId && p.projectId === projectId)
    expect(pair(3, "p-two")?.futureBefore).toBe("none")
    expect(pair(4, "p-two")).toMatchObject({ roleAfter: 600, futureAfter: "every", lanesAfter: ["es", "fr"] })
    // The team-only member's org Contributor role lifts the Viewer team path (AQU-1274).
    expect(pair(5, "p-two")).toMatchObject({ roleBefore: 400, lanesBefore: ["es", "fr"], lanesAfter: ["es", "fr"] })
  })

  it("counts direct grants the way AQU-2351 D-d does", async () => {
    const dd = ddCrossCheck(await loadRawAccessTables(query))
    expect(dd.byBucket.map((b) => [b.bucket, b.grants, b.everyLaneForever, b.walled, b.oneLaneProjects, b.multiLaneProjects, b.noLaneProjects])).toEqual([
      ["Viewer 100", 1, 1, 0, 1, 0, 0],
      ["200–500", 3, 2, 1, 0, 1, 1],
    ])
  })
})
