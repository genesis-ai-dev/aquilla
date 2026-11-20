// AQU-1781: a target lane created on the write path is granted to the members
// who already read every lane.
//
// The lane read wall gives a member below Maintainer only the lanes they hold a
// `project_member_lane_roles` row for. The two writers here create a lane
// nobody has ever been granted:
//   * the blank bridge a default-lane target commit creates on a project that
//     has no target lane yet (`handleCellEvent`)
//   * `ensureTargetLaneStmt`, for a server-side writer about to put rows under
//     a tag the project does not have (the sibling fold)
// Without the grant the import or fold lands in a lane only Maintainers can
// read, which is the "progress isn't updating" report this ticket came from.
//
// Producer-through-consumer: the statements the real handler builds are the
// ones run, so the grant cannot be proved by a hand-built batch that the
// handler never emits.

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handleCellEvent } from '../events/handlers/cell-events'
import { ensureProjectLanes, ensureTargetLaneStmt } from '../../../db/shared/lanes'
import { grantNewLaneStmt } from '../../../db/shared/lane-grants'
import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const PROJECT = 'proj-lane-grant'
const FILE = 'file-1'

let t: TestDb
afterAll(async () => {
  if (t) await t.close()
})

/**
 * A bare project (source lane only) plus the members the wall applies to:
 *   2 = contributor (400), unscoped — gains every new lane
 *   3 = contributor (400), scoped to a lane elsewhere — gains none
 *   4 = maintainer (600) — above the wall
 */
async function seedBareProject(): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ($1, 'Grants', NULL, 1)`,
    [PROJECT],
  )
  await t.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ($1, 2, 400, 1), ($1, 3, 400, 1), ($1, 4, 600, 1)`,
    [PROJECT],
  )
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag)
     VALUES ('src00001', $1, 'source', 'en', NULL)`,
    [PROJECT],
  )
  await t.pg.query(
    `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
     VALUES ($1, 3, 'lane', 'some-other-lane', '1', 0)`,
    [PROJECT],
  )
}

async function grantedLanes(userId: number): Promise<string[]> {
  const r = await t.pg.query<{ lane: string }>(
    `SELECT lane FROM project_member_lane_roles
      WHERE project_id = $1 AND user_id = $2 ORDER BY lane`,
    [PROJECT, userId],
  )
  return r.rows.map((row) => row.lane)
}

async function targetLaneIdForTag(tag: string): Promise<string> {
  const r = await t.pg.query<{ id: string }>(
    `SELECT id FROM lanes WHERE project_id = $1 AND role = 'target' AND legacy_tag = $2`,
    [PROJECT, tag],
  )
  const id = r.rows[0]?.id
  if (!id) throw new Error(`no target lane for tag ${JSON.stringify(tag)}`)
  return id
}

let serverSeq = 0

/** A default-lane target commit — the write that creates the blank bridge. */
async function defaultCommit(id: string, parentId: string | null = null): Promise<void> {
  await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
  serverSeq += 1
  const authed = {
    event: {
      id,
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId: PROJECT,
      fileId: FILE,
      cellId: 'cell-1',
      parentId,
      payload: { value: 'Bonjour' },
      clientTs: 1,
    },
    claims: { username: 'alice', userId: 4, role: 600, projectId: PROJECT, fileId: FILE },
  } as never
  const result = handleCellEvent(t.db, authed, 5_000, {
    serverSeq,
    updateProjection: true,
    deferFileCounters: true,
  })
  await t.db.batch(result.stmts)
}

beforeEach(async () => {
  if (!t) t = await makeTestDb()
  await t.reset()
  serverSeq = 0
  await seedBareProject()
})

describe('AQU-1781 the blank bridge is granted to the members who can read every lane', () => {
  it('grants an unscoped member below Maintainer, and nobody else', async () => {
    await defaultCommit('tc-1')
    const bridge = await targetLaneIdForTag('')
    expect(await grantedLanes(2)).toEqual([bridge])
    expect(await grantedLanes(3)).toEqual([])
    expect(await grantedLanes(4)).toEqual([])
  })

  it('a second default commit adds no duplicate grant row', async () => {
    await defaultCommit('tc-1')
    const before = await grantedLanes(2)
    await defaultCommit('tc-2', 'tc-1')
    expect(await grantedLanes(2)).toEqual(before)
  })
})

describe('AQU-1781 ensure-lane-for-tag grants the lane it ensures', () => {
  it('grants the folded lane to an unscoped member, and re-running adds no rows', async () => {
    const run = () =>
      t.db.batch([
        ensureTargetLaneStmt(t.db, PROJECT, 'Tshangla'),
        grantNewLaneStmt(t.db, PROJECT, { legacyTag: 'Tshangla' }, null),
      ])
    await run()
    const lane = await targetLaneIdForTag('Tshangla')
    expect(await grantedLanes(2)).toEqual([lane])
    await run()
    expect(await grantedLanes(2)).toEqual([lane])
    expect(await grantedLanes(3)).toEqual([])
  })
})

// The grant is for a lane the write CREATES. Every tag-keyed writer also runs
// it when the lane is already there (each default-language commit, each import
// into the default lane, each Codex re-ingest), and the rule's "holds every
// OTHER lane" leaves out the lane being granted. So a member a lead narrowed to
// one language through grant rows alone (no scope row: what the member
// inspector and the AQU-730 backfill write) passed it for every lane they had
// been kept out of, and the next write to that lane handed it to them.
describe('a write to a lane the project already has grants nothing new', () => {
  /**
   * Adds target lanes to the bare project, plus member 5: a contributor a lead
   * narrowed by grant rows only. Member 2 holds every lane listed.
   *
   * The lanes are dated a day back. They already exist, and PGlite's clock
   * moves in whole milliseconds, so a lane seeded just before the write could
   * otherwise share the write's transaction timestamp and read as new.
   */
  async function seedLanes(lanes: Array<{ id: string; tag: string }>, member5Holds: string[]): Promise<void> {
    for (const [i, lane] of lanes.entries()) {
      await t.pg.query(
        `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position, created_at)
         VALUES ($1, $2, 'target', $3, $3, $4, now() - interval '1 day')`,
        [lane.id, PROJECT, lane.tag, i + 1],
      )
      await t.pg.query(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
         VALUES ($1, 2, $2, 400, 1)`,
        [PROJECT, lane.id],
      )
    }
    await t.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ($1, 5, 400, 1)`,
      [PROJECT],
    )
    for (const lane of member5Holds) {
      await t.pg.query(
        `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
         VALUES ($1, 5, $2, 400, 1)`,
        [PROJECT, lane],
      )
    }
  }

  it('a default-language translation does not give the default lane to a member narrowed to another language', async () => {
    await seedLanes([{ id: 'blank001', tag: '' }, { id: 'spanish1', tag: 'es' }], ['spanish1'])
    await defaultCommit('tc-1')
    expect(await grantedLanes(5)).toEqual(['spanish1'])
    expect(await grantedLanes(2)).toEqual(['blank001', 'spanish1'])
  })

  it('asking again for lanes the project has (a Codex re-ingest) gives none to a member narrowed to another', async () => {
    await seedLanes([{ id: 'spanish1', tag: 'es' }, { id: 'french01', tag: 'fr' }], ['spanish1'])
    await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    await ensureProjectLanes(t.db, PROJECT, { dataTargetTags: ['es', 'fr'] })
    expect(await grantedLanes(5)).toEqual(['spanish1'])
    expect(await grantedLanes(3)).toEqual([])
  })

  it('the grant re-run on an existing tagged lane grants nothing', async () => {
    await seedLanes([{ id: 'spanish1', tag: 'es' }, { id: 'french01', tag: 'fr' }], ['french01'])
    await t.db.batch([
      ensureTargetLaneStmt(t.db, PROJECT, 'es'),
      grantNewLaneStmt(t.db, PROJECT, { legacyTag: 'es' }, null),
    ])
    expect(await grantedLanes(5)).toEqual(['french01'])
  })

  it('a lane the write does create is still granted to the members who held every other lane', async () => {
    await seedLanes([{ id: 'spanish1', tag: 'es' }], ['spanish1'])
    await t.pg.query(`SELECT set_config('aquilla.test_lane_fill', 'off', false)`)
    await ensureProjectLanes(t.db, PROJECT, { dataTargetTags: ['es', 'fr'] })
    const fr = await targetLaneIdForTag('fr')
    expect(await grantedLanes(2)).toEqual([fr, 'spanish1'].sort())
    expect(await grantedLanes(5)).toEqual([fr, 'spanish1'].sort())
    expect(await grantedLanes(3)).toEqual([])
    expect(await grantedLanes(4)).toEqual([])
  })

  it('the grant has to ride the batch that creates the lane: run after it, it grants nothing', async () => {
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('swahili1', $1, 'target', 'sw', 'sw', 1)`,
      [PROJECT],
    )
    // A later transaction, at least a millisecond on (PGlite's clock step).
    await t.pg.query(`SELECT pg_sleep(0.005)`)
    await grantNewLaneStmt(t.db, PROJECT, { laneId: 'swahili1' }, null).run()
    await grantNewLaneStmt(t.db, PROJECT, { legacyTag: 'sw' }, null).run()
    expect(await grantedLanes(2)).toEqual([])
  })
})

// The bulk import route, end to end, with a member who reaches the project
// only through a team as well as a direct one. Both were narrowed to Spanish by
// grant rows alone; importing a translation into the default lane must not give
// either of them the default lane.
describe('a bulk import into the default lane grants nothing to members narrowed away from it', () => {
  const SECRET = 'lane-grant-secret'
  const IMPORT_PROJECT = 'proj-import-grant'

  async function importGrants(userId: number): Promise<string[]> {
    const r = await t.pg.query<{ lane: string }>(
      `SELECT lane FROM project_member_lane_roles WHERE project_id = $1 AND user_id = $2 ORDER BY lane`,
      [IMPORT_PROJECT, userId],
    )
    return r.rows.map((row) => row.lane)
  }

  it('leaves the direct and the team-only member on Spanish', async () => {
    const org = await t.pg.query<{ id: number }>(
      `INSERT INTO organizations (name, owner_user_id, legacy_uuid) VALUES ('Org', 1, 'org-lg') RETURNING id`,
    )
    const orgId = Number(org.rows[0].id)
    await t.pg.query(`INSERT INTO projects (id, name, org_id, created_by) VALUES ($1, 'P', $2, 1)`, [
      IMPORT_PROJECT,
      orgId,
    ])
    await t.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ($1, 2, 400, 1), ($1, 5, 400, 1)`,
      [IMPORT_PROJECT],
    )
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position, created_at) VALUES
         ('isrc0001', $1, 'source', 'en', NULL, 0, now() - interval '1 day'),
         ('iblank01', $1, 'target', '', '', 1, now() - interval '1 day'),
         ('ispan001', $1, 'target', 'es', 'es', 2, now() - interval '1 day')`,
      [IMPORT_PROJECT],
    )
    const team = await t.pg.query<{ id: number }>(
      `INSERT INTO groups (org_id, name, created_by, legacy_uuid) VALUES ($1, 'Team', 1, 'grp-lg') RETURNING id`,
      [orgId],
    )
    const teamId = Number(team.rows[0].id)
    await t.pg.query(
      `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES ($1, $2, 400, 1)`,
      [teamId, IMPORT_PROJECT],
    )
    await t.pg.query(`INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, 6, 1)`, [teamId])
    await t.pg.query(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by) VALUES
         ($1, 2, 'iblank01', 400, 1), ($1, 2, 'ispan001', 400, 1),
         ($1, 5, 'ispan001', 400, 1), ($1, 6, 'ispan001', 400, 1)`,
      [IMPORT_PROJECT],
    )

    const token = await makeTestToken(SECRET, { projectId: IMPORT_PROJECT, fileId: 'file-imp', role: 500 })
    const res = await handleBulkImportRequest(
      new Request('https://worker/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: IMPORT_PROJECT,
          fileId: 'file-imp',
          file: { id: 'file-evt-1', name: 'gen.usfm', fileType: 'usfm' },
          cells: [{ id: 'src-evt-1', cellId: 'cell-1', value: 'In the beginning' }],
          targets: [{ id: 'tgt-evt-1', cellId: 'cell-1', parentId: 'src-evt-1', value: 'Au commencement' }],
        }),
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET } as never,
    )
    expect(res?.status).toBe(200)
    const cells = await t.pg.query<{ lane_id: string }>(
      `SELECT lane_id FROM cells WHERE project_id = $1 AND side = 'target'`,
      [IMPORT_PROJECT],
    )
    expect(cells.rows.map((r) => r.lane_id)).toEqual(['iblank01'])
    expect(await importGrants(5)).toEqual(['ispan001'])
    expect(await importGrants(6)).toEqual(['ispan001'])
    expect(await importGrants(2)).toEqual(['iblank01', 'ispan001'])
  })
})
