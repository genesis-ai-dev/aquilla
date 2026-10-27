// AQU-2145 — the nightly sweep that re-projects files whose progress rows have
// fallen behind their own audio events.
//
// What these pin, in the order the acceptance criteria put them:
//
//  1. The SELECTOR. It picks a file whose newest counting audio event sits above
//     its row's revision, and a file with audio and no row at all, and nothing
//     else — not a text-only file, not an audio file whose row is current.
//  2. The REPAIR. A staled row reads the live audio figures afterwards, and a
//     second run picks nothing, so the sweep is safe to run every night.
//  3. The CAP. The run stops at it and reports the exact remainder rather than
//     running unbounded.
//  4. The DOOR. `?projectId=` scopes it, `PROGRESS_SELFHEAL_MODE=off` stops it,
//     and the admin route is behind the same bearer as its two sibling sweeps.
//
// All of it runs against PGlite with the canonical schema, so the selector is
// checked as real Postgres rather than as a string.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  AUDIO_COUNTING_EVENT_KINDS,
  fullProgressRecomputeStmts,
} from '../events/progress-projection'
import {
  DEFAULT_MAX_REPAIRS,
  PROGRESS_SELFHEAL_CRON,
  formatProgressSelfHealReport,
  runProgressSelfHealSweep,
  sweepStaleAudioProgress,
} from '../progress-selfheal-cron'
import { handleAdminRequest } from '../admin'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const P = 'proj-audio'
const TS = 1_700_000_000_000
const SECRET = 'admin-secret'

/** The lanes every real project has (ensureProjectLaneStmts makes both). */
async function seedLanes(test: TestDb, projectId: string): Promise<void> {
  await test.pg.query(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
     VALUES ($1, $2, 'source', 'Source', NULL, 0), ($3, $2, 'target', 'Default', '', 1)`,
    [`${projectId}-src`, projectId, `${projectId}-tgt`],
  )
}

/**
 * A Scripture file with `verses` source lines and, on the target lane, a dub
 * take per line — `validated` of which carry a validator vote.
 *
 * Seeded as rows rather than replayed as events because the sweep's subject is
 * the projection, not the write path: these tests must be able to put the
 * projection in the exact state a burst leaves it in, which is a state the write
 * path (as of AQU-2143) no longer produces.
 */
async function seedAudioFile(
  test: TestDb,
  projectId: string,
  fileId: string,
  opts: { verses: number; validated?: number } = { verses: 2 },
): Promise<void> {
  const validated = opts.validated ?? opts.verses
  await test.pg.query(
    `INSERT INTO files (project_id, id, name, event_id, created_at)
     VALUES ($1, $2, $2, 'ev-file', $3)`,
    [projectId, fileId, TS],
  )
  for (let i = 1; i <= opts.verses; i++) {
    await test.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, canonical_ref,
                          event_id, last_edit_at)
       VALUES ($1, $2, $3, 'source', $4, '', $5, $6, $7)`,
      [projectId, fileId, `c${i}`, `${projectId}-src`, `GEN 1:${i}`, `ev-s${i}`, TS],
    )
    await test.pg.query(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected,
                               deleted, event_id, created_ts, lane_id, role, validator_count)
       VALUES ($1, $2, $3, $4, 'recording', 'frontier-audio://a', 1, 0, $5, $6, $7, 'dub', $8)`,
      [projectId, fileId, `c${i}`, `a${i}`, `ev-a${i}`, TS, `${projectId}-tgt`, i <= validated ? 1 : 0],
    )
  }
}

/** One audio event for the file at `seq`, of a kind that moves the counts. */
async function seedAudioEvent(
  test: TestDb,
  projectId: string,
  fileId: string,
  seq: number,
  kind: string = 'cell.audio.validate',
): Promise<void> {
  await test.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id,
                         kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, 'c1', NULL, $4, 'alice', '{}', $5, $5, $6)`,
    [`ev-${projectId}-${fileId}-${seq}`, projectId, fileId, kind, TS, seq],
  )
}

/** Run the projection the way the live write path leaves it: fully current. */
async function recompute(test: TestDb, projectId: string, fileId: string): Promise<void> {
  for (const stmt of fullProgressRecomputeStmts(test.db, projectId, fileId, TS)) await stmt.run()
}

/**
 * Put a file's rows back to their pre-burst state — the defect AQU-2143 fixed,
 * reproduced directly: the audio events are in the log, and the rows carry the
 * revision and the counts they had before those events landed.
 */
async function staleRows(test: TestDb, projectId: string, fileId: string, revision: number): Promise<void> {
  await test.pg.query(
    `UPDATE file_section_progress
        SET revision = $3, audio_count = 0, audio_validated_count = 0,
            audio_validator_histogram = '{}'::jsonb
      WHERE project_id = $1 AND file_id = $2`,
    [projectId, fileId, revision],
  )
}

async function fileRow(test: TestDb, projectId: string, fileId: string) {
  const { rows } = await test.pg.query<{
    revision: string | number
    audio_count: number
    audio_validated_count: number
  }>(
    `SELECT p.revision, p.audio_count, p.audio_validated_count
       FROM file_section_progress p
       JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
      WHERE p.project_id = $1 AND p.file_id = $2 AND p.scope = 'file' AND l.role = 'target'`,
    [projectId, fileId],
  )
  return rows[0]
}

function sweepEnv(test: TestDb) {
  return { AQUILLA_PG: test.db }
}

describe('AQU-2145 progress self-heal sweep', () => {
  let test: TestDb

  beforeAll(async () => {
    test = await makeTestDb()
  })
  afterAll(async () => {
    await test.close()
  })
  beforeEach(async () => {
    await test.reset()
  })

  describe('the selector', () => {
    it('picks a file whose newest audio event is above its row revision, and one with no row at all', async () => {
      await seedLanes(test, P)
      // stale: rows exist but sit below the validation burst that followed them.
      await seedAudioFile(test, P, 'stale')
      await recompute(test, P, 'stale')
      await seedAudioEvent(test, P, 'stale', 90)
      await staleRows(test, P, 'stale', 10)
      // never projected: audio on disk, no progress row at all.
      await seedAudioFile(test, P, 'unprojected')
      await seedAudioEvent(test, P, 'unprojected', 91)
      // current: its row was written after its newest audio event.
      await seedAudioFile(test, P, 'current')
      await seedAudioEvent(test, P, 'current', 92)
      await recompute(test, P, 'current')

      const report = await sweepStaleAudioProgress(sweepEnv(test))
      expect(report.repaired.map((r) => r.fileId).sort()).toEqual(['stale', 'unprojected'])
      expect(report.filesRepaired).toBe(2)
      expect(report.remaining).toBe(0)
      expect(report.errors).toEqual([])
    })

    it('leaves a text-only project and an audio project with no new events untouched', async () => {
      await seedLanes(test, P)
      // Text only: source cells, no takes. Not a candidate at all.
      await test.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, canonical_ref,
                            event_id, last_edit_at)
         VALUES ($1, 'text', 'c1', 'source', $2, '', 'GEN 1:1', 'ev-t1', $3)`,
        [P, `${P}-src`, TS],
      )
      await recompute(test, P, 'text')
      await seedAudioFile(test, P, 'quiet')
      await seedAudioEvent(test, P, 'quiet', 5)
      await recompute(test, P, 'quiet')

      const before = await test.pg.query<Record<string, unknown>>(
        `SELECT * FROM file_section_progress ORDER BY file_id, scope, section_key, lane_id`,
      )
      const report = await sweepStaleAudioProgress(sweepEnv(test))
      expect(report.filesSelected).toBe(0)
      expect(report.filesRepaired).toBe(0)
      const after = await test.pg.query<Record<string, unknown>>(
        `SELECT * FROM file_section_progress ORDER BY file_id, scope, section_key, lane_id`,
      )
      expect(after.rows).toEqual(before.rows)
    })

    it('ignores an audio event that cannot move the counts', async () => {
      // `trim`/`place`/`measure` change a take's window or timing, not whether
      // the line is recorded or how many validators it has. A file whose newest
      // audio event is one of those has a row that is behind but not WRONG, and
      // re-projecting it nightly would be a full aggregate per clip drag.
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'trimmed')
      await recompute(test, P, 'trimmed')
      await seedAudioEvent(test, P, 'trimmed', 90, 'cell.audio.trim')
      await staleRows(test, P, 'trimmed', 10)

      const report = await sweepStaleAudioProgress(sweepEnv(test))
      expect(report.filesSelected).toBe(0)
      expect(AUDIO_COUNTING_EVENT_KINDS).not.toContain('cell.audio.trim')
    })

    it('skips a file whose takes outlive its cells, rather than repairing it every night', async () => {
      // A deleted file's cells are tombstoned while its takes stay on disk. The
      // recompute's file row comes from a summary over live source cells, so
      // such a file CANNOT be given a row — and without the selector's
      // live-cell clause it would be picked, "repaired", and picked again
      // forever, which is exactly the shape that hides a real repair in the log.
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'gone')
      await seedAudioEvent(test, P, 'gone', 90)
      await test.pg.query(
        `UPDATE cells SET tombstoned_at = $2 WHERE project_id = $1 AND file_id = 'gone'`,
        [P, TS],
      )

      const report = await sweepStaleAudioProgress(sweepEnv(test))
      expect(report.filesSelected).toBe(0)
    })
  })

  describe('the repair', () => {
    it('restores the live audio figures and is picked no second time', async () => {
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'burst', { verses: 4, validated: 3 })
      await recompute(test, P, 'burst')
      await seedAudioEvent(test, P, 'burst', 90)
      await staleRows(test, P, 'burst', 10)
      expect((await fileRow(test, P, 'burst'))?.audio_count).toBe(0)

      const first = await sweepStaleAudioProgress(sweepEnv(test))
      expect(first.filesRepaired).toBe(1)
      const row = await fileRow(test, P, 'burst')
      expect(row?.audio_count).toBe(4)
      expect(row?.audio_validated_count).toBe(3)
      // The repair's watermark covers every event of the file, so the file is
      // above its audio high-water mark and drops out of the selector.
      expect(Number(row?.revision)).toBeGreaterThanOrEqual(90)

      const second = await sweepStaleAudioProgress(sweepEnv(test))
      expect(second.filesSelected).toBe(0)
      expect(second.filesRepaired).toBe(0)
    })

    it('writes the section and book rows in the same pass', async () => {
      // The plan board reads book rows and the chapter list reads section rows.
      // A repair that fixed only the file row would leave the dashboard
      // disagreeing with itself.
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'scoped', { verses: 2 })
      await seedAudioEvent(test, P, 'scoped', 90)

      await sweepStaleAudioProgress(sweepEnv(test))
      const { rows } = await test.pg.query<{ scope: string; audio_count: number }>(
        `SELECT p.scope, p.audio_count
           FROM file_section_progress p
           JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
          WHERE p.project_id = $1 AND p.file_id = 'scoped' AND l.role = 'target'
          ORDER BY p.scope`,
        [P],
      )
      expect(rows.map((r) => r.scope)).toEqual(['book', 'file', 'section'])
      expect(rows.every((r) => r.audio_count === 2)).toBe(true)
    })
  })

  describe('the per-run cap', () => {
    it('stops at the cap and reports the exact remainder', async () => {
      await seedLanes(test, P)
      // Distinct server_seq per file: the log allocates one sequence per
      // PROJECT, and `idx_events_project_seq_id` enforces it.
      const ids = ['f-a', 'f-b', 'f-c']
      for (const [i, id] of ids.entries()) {
        await seedAudioFile(test, P, id)
        await seedAudioEvent(test, P, id, 90 + i)
      }

      const first = await sweepStaleAudioProgress(sweepEnv(test), { maxRepairs: 2 })
      expect(first.filesRepaired).toBe(2)
      // Counted after the repairs landed, so it is what the next run will take.
      expect(first.remaining).toBe(1)
      expect(first.repaired.map((r) => r.fileId)).toEqual(['f-a', 'f-b'])

      const second = await sweepStaleAudioProgress(sweepEnv(test), { maxRepairs: 2 })
      expect(second.repaired.map((r) => r.fileId)).toEqual(['f-c'])
      expect(second.remaining).toBe(0)

      const third = await sweepStaleAudioProgress(sweepEnv(test), { maxRepairs: 2 })
      expect(third.filesSelected).toBe(0)
    })

    it('reports a remainder of 0 when the run was not capped', async () => {
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'only')
      await seedAudioEvent(test, P, 'only', 90)
      const report = await sweepStaleAudioProgress(sweepEnv(test), { maxRepairs: 1 })
      expect(report.filesRepaired).toBe(1)
      expect(report.remaining).toBe(0)
    })
  })

  describe('scoping and the off switch', () => {
    it('sweeps one project on demand and leaves another project stale', async () => {
      const OTHER = 'proj-other'
      // `files.id` is the primary key on its own, so a file id is global.
      for (const project of [P, OTHER]) {
        await seedLanes(test, project)
        await seedAudioFile(test, project, `${project}-f1`)
        await seedAudioEvent(test, project, `${project}-f1`, 90)
      }

      const report = await sweepStaleAudioProgress(sweepEnv(test), { onlyProjectId: P })
      expect(report.repaired).toEqual([{ projectId: P, fileId: `${P}-f1` }])
      expect(await fileRow(test, OTHER, `${OTHER}-f1`)).toBeUndefined()
    })

    it('PROGRESS_SELFHEAL_MODE=off skips the sweep entirely', async () => {
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'f1')
      await seedAudioEvent(test, P, 'f1', 90)
      expect(
        await runProgressSelfHealSweep({ ...sweepEnv(test), PROGRESS_SELFHEAL_MODE: 'off' }),
      ).toBeNull()
      expect(await fileRow(test, P, 'f1')).toBeUndefined()
    })

    it('reports a healthy night as a zero count rather than silence', async () => {
      // The log line IS the regression alarm: a reader has to be able to tell
      // "nothing was wrong" from "the cron did not run", which is what the null
      // return above is for.
      const report = await runProgressSelfHealSweep(sweepEnv(test))
      expect(report).not.toBeNull()
      expect(formatProgressSelfHealReport(report!)).toBe(
        'selected=0 repaired=0 remaining=0',
      )
    })

    it('owns a cron expression distinct from its two sibling sweeps', async () => {
      expect(PROGRESS_SELFHEAL_CRON).toBe('29 5 * * *')
      expect(DEFAULT_MAX_REPAIRS).toBeGreaterThan(0)
    })
  })

  describe('POST /admin/progress-selfheal', () => {
    function adminEnv() {
      return {
        SNAPSHOTS: {} as unknown as R2Bucket,
        AQUILLA_PG: test.db,
        ADMIN_SECRET: SECRET,
      } as unknown as Parameters<typeof handleAdminRequest>[1]
    }

    function adminRequest(method = 'POST', query = '', bearer = SECRET) {
      return new Request(`https://worker/admin/progress-selfheal${query}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}` },
      })
    }

    it('repairs the named project and returns the report', async () => {
      await seedLanes(test, P)
      await seedAudioFile(test, P, 'f1', { verses: 3, validated: 2 })
      await seedAudioEvent(test, P, 'f1', 90)

      const res = (await handleAdminRequest(
        adminRequest('POST', `?projectId=${P}`),
        adminEnv(),
      ))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        report: { filesRepaired: number; repaired: Array<{ fileId: string }> }
        summary: string
      }
      expect(body.ok).toBe(true)
      expect(body.report.filesRepaired).toBe(1)
      expect(body.report.repaired[0]!.fileId).toBe('f1')
      expect(body.summary).toContain('repaired=1')
      const row = await fileRow(test, P, 'f1')
      expect(row?.audio_count).toBe(3)
      expect(row?.audio_validated_count).toBe(2)
    })

    it('rejects a wrong bearer and a GET', async () => {
      expect((await handleAdminRequest(adminRequest('POST', '', 'nope'), adminEnv()))!.status).toBe(401)
      expect((await handleAdminRequest(adminRequest('GET'), adminEnv()))!.status).toBe(405)
    })
  })
})
