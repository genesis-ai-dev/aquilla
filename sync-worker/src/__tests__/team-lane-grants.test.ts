// AQU-1800: the Codex sync's team writes have to write lane access too.
//
// Project access arrives by two paths — a direct `project_members` row, and a
// team attached through `group_project_grants` — and every lane-grant writer
// knew only the first. So under the lane read wall the nightly sync produced
// people who reached a project and saw source text only: it adds the members
// of each GitLab subgroup to the matching team (`POST /migrate/groups`) and
// attaches each migrated project to its team at Contributor
// (`POST /migrate/project`).
//
// Producer-through-consumer: the two real route handlers are what run here,
// against real Postgres, and the assertions read the table the wall reads
// (`project_member_lane_roles`) — not a DB-free planner, which is the level the
// bug escaped at.

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handleMigrateGroupsRequest } from '../events/migrate-groups-route'
import { handleMigrateProjectRequest } from '../events/migrate-project-route'
import { grantNewLaneStmt } from '../../../db/shared/lane-grants'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'team-grants-secret'
const PROJECT = 'proj-team-grants'

/** Role levels, as db/shared/project-roles.ts names them. */
const VIEWER = 100
const CONTRIBUTOR = 400
const MAINTAINER = 600

let t: TestDb
afterAll(async () => {
  await t?.close()
})

function groupsRequest(body: unknown): Request {
  return new Request('https://sync.example/migrate/groups', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function projectRequest(body: unknown): Request {
  return new Request('https://sync.example/migrate/project', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const env = () => ({ AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })

/** One org + one team, both carrying the legacy_uuids the plan names. */
async function seedOrgAndTeam(): Promise<{ orgId: number; teamId: number }> {
  const org = await t.pg.query<{ id: number }>(
    `INSERT INTO organizations (name, owner_user_id, legacy_uuid) VALUES ('Org', 1, 'org-a') RETURNING id`,
  )
  const orgId = Number(org.rows[0].id)
  const team = await t.pg.query<{ id: number }>(
    `INSERT INTO groups (org_id, name, created_by, legacy_uuid) VALUES ($1, 'Team T', 1, 'grp-t') RETURNING id`,
    [orgId],
  )
  return { orgId, teamId: Number(team.rows[0].id) }
}

/** A project the team reaches at `roleLevel`, with `lanes` target lanes. */
async function seedAttachedProject(
  teamId: number,
  orgId: number,
  opts: { roleLevel?: number; lanes?: string[]; archivedLanes?: string[] } = {},
): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, org_id, created_by) VALUES ($1, 'P', $2, 1)`, [
    PROJECT,
    orgId,
  ])
  await t.pg.query(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES ($1, $2, $3, 1)`,
    [teamId, PROJECT, opts.roleLevel ?? CONTRIBUTOR],
  )
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag) VALUES ('src00001', $1, 'source', 'en', NULL)`,
    [PROJECT],
  )
  for (const [i, id] of (opts.lanes ?? []).entries()) {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ($1, $2, 'target', $3, $3, $4)`,
      [id, PROJECT, `lang-${id}`, i],
    )
  }
  for (const id of opts.archivedLanes ?? []) {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position, archived_at)
       VALUES ($1, $2, 'target', $3, $3, 9, now())`,
      [id, PROJECT, `lang-${id}`],
    )
  }
}

async function addTeamMember(teamId: number, userId: number, roleLevel: number | null = null): Promise<void> {
  await t.pg.query(
    `INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES ($1, $2, 1, $3)`,
    [teamId, userId, roleLevel],
  )
}

async function grantedLanes(userId: number): Promise<Array<{ lane: string; level: number }>> {
  const r = await t.pg.query<{ lane: string; role_level: number }>(
    `SELECT lane, role_level FROM project_member_lane_roles
      WHERE project_id = $1 AND user_id = $2 ORDER BY lane`,
    [PROJECT, userId],
  )
  return r.rows.map((row) => ({ lane: row.lane, level: Number(row.role_level) }))
}

/** The plan `/migrate/groups` receives for "team T gains these users". */
function planFor(userIds: number[]) {
  return {
    orgs: [],
    orgMembers: [],
    teams: [],
    teamMembers: userIds.map((userId) => ({ teamUuid: 'grp-t', userId })),
    conflicts: [],
  }
}

beforeEach(async () => {
  t = t ?? (await makeTestDb())
  await t.reset()
})

describe('POST /migrate/groups — team membership writes lane access (AQU-1800)', () => {
  it('grants every current target lane of each attached project, at the team role', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001', 'tgt00002'] })

    const res = await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([7]) }), env())
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { created: { laneGrants: number } }
    expect(body.created.laneGrants).toBe(2)
    expect(await grantedLanes(7)).toEqual([
      { lane: 'tgt00001', level: CONTRIBUTOR },
      { lane: 'tgt00002', level: CONTRIBUTOR },
    ])
  })

  it('writes nothing for a Maintainer team-scope role, and still writes for a Contributor', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001'] })
    // The team's role on the project is Contributor; user 9's own team-scope
    // role raises them above the wall, so a grant row would be meaningless.
    await addTeamMember(teamId, 9, MAINTAINER)

    await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([8, 9]) }), env())

    expect(await grantedLanes(8)).toEqual([{ lane: 'tgt00001', level: CONTRIBUTOR }])
    expect(await grantedLanes(9)).toEqual([])
  })

  it('seeds the archived lanes too, so a lane added later still reaches the member', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001'], archivedLanes: ['tgt00099'] })

    await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([7]) }), env())

    // An archived lane reveals nothing on its own, but AQU-1781 hands a new
    // lane only to a member who already reads every OTHER target lane,
    // archived ones included — so leaving it out would silently stop this
    // member receiving the project's future lanes (AQU-1783).
    expect(await grantedLanes(7)).toEqual([
      { lane: 'tgt00001', level: CONTRIBUTOR },
      { lane: 'tgt00099', level: CONTRIBUTOR },
    ])

    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('tgt00002', $1, 'target', 'sw', 'sw', 1)`,
      [PROJECT],
    )
    await grantNewLaneStmt(t.db, PROJECT, { laneId: 'tgt00002' }, 1).run()

    expect((await grantedLanes(7)).map((g) => g.lane)).toEqual(['tgt00001', 'tgt00002', 'tgt00099'])
  })

  it('leaves a member a lead narrowed to one lane exactly as narrow', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001', 'tgt00002'] })
    await addTeamMember(teamId, 7)
    // Narrowed on the grant table (the leveled model) and on the legacy scope
    // table — both have to mean "these lanes and no others".
    await t.pg.query(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES ($1, 7, 'tgt00001', $2, 1)`,
      [PROJECT, CONTRIBUTOR],
    )
    await t.pg.query(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES ($1, 8, 'lane', 'tgt00002', '1', 0)`,
      [PROJECT],
    )

    await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([7, 8]) }), env())

    expect(await grantedLanes(7)).toEqual([{ lane: 'tgt00001', level: CONTRIBUTOR }])
    expect(await grantedLanes(8)).toEqual([])
  })

  it('is a no-op on the second run', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001', 'tgt00002'] })

    await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([7]) }), env())
    const again = await handleMigrateGroupsRequest(groupsRequest({ plan: planFor([7]) }), env())
    const body = (await again!.json()) as { created: { laneGrants: number } }

    expect(body.created.laneGrants).toBe(0)
    expect((await grantedLanes(7)).length).toBe(2)
  })

  it('reports the rows an apply would add, and writes none, on a dry run', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await seedAttachedProject(teamId, orgId, { lanes: ['tgt00001', 'tgt00002'] })
    await addTeamMember(teamId, 7)

    const res = await handleMigrateGroupsRequest(
      groupsRequest({ plan: planFor([7, 8]), dryRun: true }),
      env(),
    )
    const body = (await res!.json()) as { dryRun: boolean; would: { laneGrants: number } }

    // Two lanes × the member already on the team + the member it would add.
    expect(body.dryRun).toBe(true)
    expect(body.would.laneGrants).toBe(4)
    expect(await t.rows('project_member_lane_roles')).toEqual([])
    // User 8 is still not on the team: a dry run adds no membership either.
    expect((await t.rows('group_members')).length).toBe(1)
  })
})

describe('POST /migrate/project — attaching a project to a team writes lane access (AQU-1800)', () => {
  it('grants the project lanes to the team members below Maintainer', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await addTeamMember(teamId, 7)
    await addTeamMember(teamId, 9, MAINTAINER)
    // The project exists with its lanes (a re-migration, or a project whose
    // content was swept before the attach) and is now attached to the team.
    await t.pg.query(`INSERT INTO projects (id, name, org_id, created_by) VALUES ($1, 'P', $2, 1)`, [
      PROJECT,
      orgId,
    ])
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('tgt00001', $1, 'target', 'sw', 'sw', 0)`,
      [PROJECT],
    )

    const res = await handleMigrateProjectRequest(
      projectRequest({ projectId: PROJECT, name: 'P', orgId, ownerUserId: 1, teamId }),
      env(),
    )
    expect(res?.status).toBe(200)

    expect(await grantedLanes(7)).toEqual([{ lane: 'tgt00001', level: CONTRIBUTOR }])
    expect(await grantedLanes(9)).toEqual([])
  })

  it('grants at Viewer when that is the team role on the project', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    await addTeamMember(teamId, 7)
    await t.pg.query(`INSERT INTO projects (id, name, org_id, created_by) VALUES ($1, 'P', $2, 1)`, [
      PROJECT,
      orgId,
    ])
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('tgt00001', $1, 'target', 'sw', 'sw', 0)`,
      [PROJECT],
    )

    await handleMigrateProjectRequest(
      projectRequest({
        projectId: PROJECT,
        name: 'P',
        orgId,
        ownerUserId: 1,
        teamId,
        roleLevel: VIEWER,
      }),
      env(),
    )

    expect(await grantedLanes(7)).toEqual([{ lane: 'tgt00001', level: VIEWER }])
  })
})

describe('lane creation reaches team members too (AQU-1800)', () => {
  it('grants a lane created after the attach to the team members, not only direct members', async () => {
    const { orgId, teamId } = await seedOrgAndTeam()
    // The newly migrated case: project attached to its team, no direct member
    // at all, and the content sweep creates the first target lane afterwards.
    await seedAttachedProject(teamId, orgId)
    await addTeamMember(teamId, 7)
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('tgt00001', $1, 'target', 'sw', 'sw', 0)`,
      [PROJECT],
    )

    await grantNewLaneStmt(t.db, PROJECT, { laneId: 'tgt00001' }, 1).run()

    expect(await grantedLanes(7)).toEqual([{ lane: 'tgt00001', level: CONTRIBUTOR }])
  })
})
