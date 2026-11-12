/**
 * AQU-1352 P1 safety net — the shared access fixture + expected matrix.
 *
 * One fixture org that covers every membership shape the redesign spec
 * (docs/superpowers/specs/2026-09-21-membership-permissions-redesign.md §0/§3)
 * says the new resolver must answer identically to today's. The matrix below
 * is TODAY's behavior, pinned — not the desired behavior. The next wave swaps
 * the resolver under test (see `AccessResolver` in
 * access-characterization.test.ts) and reruns this exact table: any cell that
 * changes is either a deliberate, spec-cited behavior change or a regression.
 *
 * Seed (org 1 "Fixture Org", owner user 1):
 *   users   1 owner        org 700 · creator of p1, p2, p_archived
 *           2 maintainer   org 600
 *           3 org_lead     org 500, no other path
 *           4 org_contrib  org 400, no other path (sub-600: AQU-435 opens nothing)
 *           5 team_only    org 300 + team 1
 *           6 direct_below org 300 + team 1 + direct p1 row at 300 (BELOW team 400)
 *           7 direct_above org 300 + team 1 + direct p1 row at 600 (ABOVE team 400)
 *           8 creator      org 400 · created p3
 *           9 external     NO org row · direct p2 row at 300
 *          10 tim          org 100 (guest) + team 2 (attached at 700 on p3)
 *          11 personal     owns personal org 2 and its project p_personal
 *   teams   1 "fixture/translators" → p1, p2 at 400 (Contributor default); not p3
 *           2 "fixture/leads"       → p3 at 700
 *   projects p1, p2, p3 (org 1) · p_archived (org 1, archived) · p_personal (org 2)
 *
 * Platform admin: pg-test-env's ADMIN_EMAILS is root@example.com; no fixture
 * user matches, so the `platform` path never fires here.
 */

import { env } from "cloudflare:test"
import { seedUser } from "./db"

export const FIXTURE_ORG_ID = 1
export const PERSONAL_ORG_ID = 2

export const FIXTURE_USERS = {
  owner: 1,
  maintainer: 2,
  org_lead: 3,
  org_contrib: 4,
  team_only: 5,
  direct_below: 6,
  direct_above: 7,
  creator: 8,
  external: 9,
  tim: 10,
  personal: 11,
} as const

export type FixtureUser = keyof typeof FIXTURE_USERS

export const FIXTURE_PROJECTS = ["p1", "p2", "p3", "p_archived", "p_personal"] as const
export type FixtureProject = (typeof FIXTURE_PROJECTS)[number]

export const FIXTURE_PROJECT_ORG: Record<FixtureProject, number> = {
  p1: FIXTURE_ORG_ID,
  p2: FIXTURE_ORG_ID,
  p3: FIXTURE_ORG_ID,
  p_archived: FIXTURE_ORG_ID,
  p_personal: PERSONAL_ORG_ID,
}

export type RoleSource = "override" | "group" | "org" | "creator" | "platform"

/** Expected effective role, or null = no access (resolver null / HTTP 403). */
export type ExpectedRole = { level: number; source: RoleSource } | null

const r = (level: number, source: RoleSource): ExpectedRole => ({ level, source })

/**
 * TODAY's effective-role answer for every (user × project) pair. Archived
 * projects resolve to null for everyone via resolveProjectRole (the Trash
 * path uses resolveProjectRoleIncludingArchived and is out of scope here).
 * Why each non-obvious cell is what it is:
 *   - owner p1/p2: org 700 ties creator 700; attribution priority says org.
 *   - org_lead / org_contrib: sub-600 org role with no team/direct → null (AQU-435).
 *   - team_only p1/p2: team 400 beats org 300 (org contributes only because a
 *     team opens the project and there is no direct row — AQU-1274).
 *   - direct_below p1: direct 300 suppresses the org path but does NOT beat
 *     team 400 (AD-12 max-wins between explicit paths).
 *   - direct_above p1: direct 600 wins outright.
 *   - creator p3: creator 700; org 400 opens nothing without a team.
 *   - tim p3: team 700 on a guest-org user → owner via group (the "Tim" case
 *     the spec calls out: a 100 org role reaches 700 through a team).
 *   - personal p_personal: personal-org owner (org 700) ties creator; org wins.
 */
export const EXPECTED_ROLES: Record<FixtureUser, Record<FixtureProject, ExpectedRole>> = {
  owner:        { p1: r(700, "org"), p2: r(700, "org"), p3: r(700, "org"), p_archived: null, p_personal: null },
  maintainer:   { p1: r(600, "org"), p2: r(600, "org"), p3: r(600, "org"), p_archived: null, p_personal: null },
  org_lead:     { p1: null, p2: null, p3: null, p_archived: null, p_personal: null },
  org_contrib:  { p1: null, p2: null, p3: null, p_archived: null, p_personal: null },
  team_only:    { p1: r(400, "group"), p2: r(400, "group"), p3: null, p_archived: null, p_personal: null },
  direct_below: { p1: r(400, "group"), p2: r(400, "group"), p3: null, p_archived: null, p_personal: null },
  direct_above: { p1: r(600, "override"), p2: r(400, "group"), p3: null, p_archived: null, p_personal: null },
  creator:      { p1: null, p2: null, p3: r(700, "creator"), p_archived: null, p_personal: null },
  external:     { p1: null, p2: r(300, "override"), p3: null, p_archived: null, p_personal: null },
  tim:          { p1: null, p2: null, p3: r(700, "group"), p_archived: null, p_personal: null },
  personal:     { p1: null, p2: null, p3: null, p_archived: null, p_personal: r(700, "org") },
}

/**
 * TODAY's answer to "may this user POST /api/v2/projects with orgId=X?"
 * Org role >= Maintainer (600) is required (routes/projects.ts, spec Risk 3).
 * A team grant, however high, confers no create right — Tim (team 700) is 403.
 */
export const EXPECTED_CAN_CREATE: Record<FixtureUser, Record<number, boolean>> = {
  owner:        { [FIXTURE_ORG_ID]: true,  [PERSONAL_ORG_ID]: false },
  maintainer:   { [FIXTURE_ORG_ID]: true,  [PERSONAL_ORG_ID]: false },
  org_lead:     { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  org_contrib:  { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  team_only:    { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  direct_below: { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  direct_above: { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  creator:      { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  external:     { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  tim:          { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: false },
  personal:     { [FIXTURE_ORG_ID]: false, [PERSONAL_ORG_ID]: true },
}

async function run(sql: string): Promise<void> {
  await env.AQUILLA_PG.prepare(sql).run()
}

/** Seed the whole fixture. Tables are truncated after each test by setup-migrations. */
export async function seedAccessFixture(): Promise<void> {
  for (const [name, id] of Object.entries(FIXTURE_USERS)) await seedUser(id, name)

  await run(
    `INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES
       (1, 'Fixture Org', 1, 'team'),
       (2, 'personal''s workspace', 11, 'personal')`,
  )
  await run(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 500, 1), (1, 4, 400, 1),
       (1, 5, 300, 1), (1, 6, 300, 1), (1, 7, 300, 1), (1, 8, 400, 1),
       (1, 10, 100, 1),
       (2, 11, 700, 11)`,
  )
  await run(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
       ('p1', 'Alpha', 1, 1, NULL),
       ('p2', 'Beta', 1, 1, NULL),
       ('p3', 'Gamma', 1, 8, NULL),
       ('p_archived', 'Delta (archived)', 1, 1, now()),
       ('p_personal', 'Personal', 2, 11, NULL)`,
  )
  await run(
    `INSERT INTO groups (id, org_id, name, created_by) VALUES
       (1, 1, 'fixture/translators', 1),
       (2, 1, 'fixture/leads', 1)`,
  )
  await run(
    `INSERT INTO group_members (group_id, user_id, added_by) VALUES
       (1, 5, 1), (1, 6, 1), (1, 7, 1), (2, 10, 1)`,
  )
  await run(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES
       (1, 'p1', 400, 1), (1, 'p2', 400, 1), (2, 'p3', 700, 1)`,
  )
  await run(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('p1', 6, 300, 1), ('p1', 7, 600, 1), ('p2', 9, 300, 1)`,
  )
}
