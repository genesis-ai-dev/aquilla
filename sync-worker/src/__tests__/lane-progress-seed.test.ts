// A language added to a project with files gets its progress rows at once
// (db/shared/lane-progress.ts), so no reader counts it short until every file
// is next edited. The rows it copies must be exactly what a full recompute
// would write for that language, and a file where the language already has
// text or audio must be left to a real recompute.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { fullProgressRecomputeStmts } from '../events/progress-projection'
import { seedLaneProgressStmt } from '../../../db/shared/lane-progress'
import { insertTargetLane, setTargetLaneArchived } from '../../../db/shared/lanes'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const P = 'proj-lanes'
const TS = 1_700_000_000_000

describe('progress rows for a language added later', () => {
  let test: TestDb

  beforeAll(async () => {
    test = await makeTestDb()
  })
  afterAll(async () => {
    await test.close()
  })
  beforeEach(async () => {
    await test.reset()
    await test.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
       VALUES ('src', $1, 'source', 'Source', NULL, 0), ('base', $1, 'target', 'Default', '', 1)`,
      [P],
    )
  })

  /** A two-chapter file, translated and voted on in the default lane only. */
  async function seedFile(fileId: string): Promise<void> {
    await test.pg.query(
      `INSERT INTO files (project_id, id, name, event_id, created_at) VALUES ($1, $2, $2, 'ev-file', $3)`,
      [P, fileId, TS],
    )
    const refs = ['GEN 1:1', 'GEN 1:2', 'GEN 2:1']
    for (const [i, ref] of refs.entries()) {
      await test.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, canonical_ref, event_id, last_edit_at)
         VALUES ($1, $2, $3, 'source', 'src', 'Source line', $4, $5, $6)`,
        [P, fileId, `c${i}`, ref, `ev-${fileId}-s${i}`, TS + i],
      )
    }
    await test.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, endorsement_count, event_id, last_edit_at)
       VALUES ($1, $2, 'c0', 'target', 'base', 'Au commencement', 2, $3, $4)`,
      [P, fileId, `ev-${fileId}-t0`, TS + 10],
    )
    await recompute(fileId)
  }

  async function recompute(fileId: string): Promise<void> {
    for (const stmt of fullProgressRecomputeStmts(test.db, P, fileId, TS)) await stmt.run()
  }

  async function laneRows(laneId: string, fileId?: string) {
    const { rows } = await test.pg.query<Record<string, unknown>>(
      `SELECT * FROM file_section_progress
        WHERE project_id = $1 AND lane_id = $2 ${fileId ? 'AND file_id = $3' : ''}
        ORDER BY file_id, scope, section_key`,
      fileId ? [P, laneId, fileId] : [P, laneId],
    )
    return rows
  }

  it('writes, for "Add language", exactly the rows a full recompute would', async () => {
    await seedFile('gen')
    await insertTargetLane(test.db, P, {
      id: 'fr', language: 'French', name: null, langCode: null, legacyTag: 'fr',
    })
    const seeded = await laneRows('fr')
    // file + 2 chapters + 1 book
    expect(seeded.map((r) => `${r.scope}:${r.section_key}`)).toEqual(['book:GEN', 'file:', 'section:GEN 1', 'section:GEN 2'])
    expect(seeded.find((r) => r.scope === 'file')).toMatchObject({ total_count: 3, filled_count: 0 })

    await test.pg.query(`DELETE FROM file_section_progress WHERE lane_id = 'fr'`)
    await recompute('gen')
    expect(await laneRows('fr')).toEqual(seeded)
  })

  it('leaves a file where the language already has text, or the default lane a recording, to a recompute', async () => {
    await seedFile('text')
    await seedFile('voiced')
    await test.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES ('de', $1, 'target', 'German', 'de', 2)`,
      [P],
    )
    // German has a line in 'text' already (written before its row could be).
    await test.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at)
       VALUES ($1, 'text', 'c1', 'target', 'de', 'Im Anfang', 'ev-de', $2)`,
      [P, TS],
    )
    // The default lane lost its rows for 'voiced', which holds a take with no lane.
    await test.pg.query(`DELETE FROM file_section_progress WHERE file_id = 'voiced' AND lane_id = 'base'`)
    await test.pg.query(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected, deleted, event_id, created_ts, lane_id, role, validator_count)
       VALUES ($1, 'voiced', 'c0', 'a0', 'recording', 'frontier-audio://a', 1, 0, 'ev-a0', $2, NULL, 'dub', 0)`,
      [P, TS],
    )

    await seedLaneProgressStmt(test.db, P).run()

    expect(await laneRows('de', 'text')).toEqual([])
    expect((await laneRows('de', 'voiced')).length).toBe(4)
    expect(await laneRows('base', 'voiced')).toEqual([])
  })

  it('gives a language coming back from the archive the rows of files added while it was away', async () => {
    await test.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, archived_at)
       VALUES ('old', $1, 'target', 'Old', 'old', 2, now())`,
      [P],
    )
    await seedFile('new-file')
    await test.pg.query(`DELETE FROM file_section_progress WHERE lane_id = 'old'`)

    await setTargetLaneArchived(test.db, P, 'old', false)
    expect((await laneRows('old', 'new-file')).find((r) => r.scope === 'file')).toMatchObject({ total_count: 3 })
  })

  it('is idempotent and never overwrites a row a lane has', async () => {
    await seedFile('gen')
    const before = await laneRows('base')
    await seedLaneProgressStmt(test.db, P).run()
    await seedLaneProgressStmt(test.db, P).run()
    expect(await laneRows('base')).toEqual(before)
    expect(before.find((r) => r.scope === 'file')).toMatchObject({ filled_count: 1 })
  })
})
