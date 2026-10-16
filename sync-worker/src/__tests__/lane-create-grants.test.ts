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
import { ensureTargetLaneStmt } from '../../../db/shared/lanes'
import { grantNewLaneStmt } from '../../../db/shared/lane-grants'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

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
