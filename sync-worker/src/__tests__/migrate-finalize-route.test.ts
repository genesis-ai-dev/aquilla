// Tests for handleMigrateFinalizeRequest (POST /migrate/finalize).
//
// AQU-557: the migrate daemon calls finalize once per push. Finalize used to
// recompute EVERY file in the project and to await one round trip per file, so
// a push that landed one event in one book rebuilt every book's counters and
// section progress serially — measured in production at a 14.7 s median and a
// 50.9 s max, the third-largest source of >=5 s sync-worker requests.
//
// The guards below are the regression bar for both halves of the fix:
//   - an optional `fileIds` scope recomputes only the named files, and an
//     omitted scope still recomputes the whole project (migrate-all's shape);
//   - the per-file progress recompute is pipelined, so round trips stay
//     bounded instead of growing one per file.
//
// Runs on PGlite (real Postgres) so the correlated-subquery UPDATE and the
// progress SQL are exercised for real, not pattern-matched by a fake.

import { describe, it, expect } from 'vitest'

import { handleMigrateFinalizeRequest } from '../events/migrate-finalize-route'
import { makeTestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT_ID = 'proj-finalize'
const OTHER_PROJECT_ID = 'proj-other'

interface FileRow {
  id: string
  cell_count: number
  filled_count: number
  word_count: number
}

/** A file plus one source cell and one filled target cell, with the derived
 *  counters left deliberately stale (0) — exactly the state a
 *  `deferFileCounters` ingest leaves behind for finalize to repair. */
function seedFor(fileId: string, projectId = PROJECT_ID) {
  const cellId = `${fileId}-c1`
  return {
    file: {
      id: fileId,
      project_id: projectId,
      name: `${fileId}.usfm`,
      event_id: `${fileId}-ev`,
      cell_count: 0,
      approved_count: 0,
      filled_count: 0,
      word_count: 0,
      created_at: 1,
      updated_at: 1,
    },
    cells: [
      {
        project_id: projectId,
        file_id: fileId,
        cell_id: cellId,
        side: 'source',
        value: 'In the beginning',
        canonical_ref: 'GEN 1:1',
        event_id: `${fileId}-src`,
        last_edit_at: 10,
        word_count: 3,
      },
      {
        project_id: projectId,
        file_id: fileId,
        cell_id: cellId,
        side: 'target',
        value: 'Au commencement',
        canonical_ref: 'GEN 1:1',
        event_id: `${fileId}-tgt`,
        last_edit_at: 20,
        word_count: 2,
      },
    ],
  }
}

async function seededDb(fileIds: string[], extra: { projectId?: string; fileId?: string } = {}) {
  const seeds = fileIds.map((id) => seedFor(id))
  const foreign = extra.fileId ? seedFor(extra.fileId, extra.projectId) : null
  return makeTestDb({
    files: [...seeds.map((s) => s.file), ...(foreign ? [foreign.file] : [])],
    cells: [...seeds.flatMap((s) => s.cells), ...(foreign ? foreign.cells : [])],
  })
}

function finalizeRequest(body: Record<string, unknown>): Request {
  return new Request('https://worker/migrate/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

/** Wraps a db so the test can count how many batch round trips finalize makes.
 *  `batchPipelined` is left in place — counting it is the point. */
function countingDb(db: AquillaDb): { db: AquillaDb; batches: () => number } {
  let batches = 0
  const wrapped: AquillaDb = {
    ...db,
    prepare: (query: string) => db.prepare(query),
    batch: (stmts) => {
      batches++
      return db.batch(stmts)
    },
    batchPipelined: db.batchPipelined
      ? (stmts) => {
          batches++
          return db.batchPipelined!(stmts)
        }
      : undefined,
  }
  return { db: wrapped, batches: () => batches }
}

async function filesById(rows: () => Promise<FileRow[]>): Promise<Map<string, FileRow>> {
  return new Map((await rows()).map((row) => [row.id, row]))
}

describe('handleMigrateFinalizeRequest', () => {
  it('recomputes only the files named in fileIds', async () => {
    const { db, rows } = await seededDb(['file-a', 'file-b'])

    const response = await handleMigrateFinalizeRequest(
      finalizeRequest({ projectId: PROJECT_ID, fileIds: ['file-a'] }),
      makeEnv(db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ ok: true, progressUpdated: 1, scoped: true })

    const files = await filesById(() => rows<FileRow>('files'))
    // file-a is repaired from its cells …
    expect(files.get('file-a')).toMatchObject({ cell_count: 1, filled_count: 1, word_count: 2 })
    // … and file-b, which this push never touched, is not scanned or rewritten.
    expect(files.get('file-b')).toMatchObject({ cell_count: 0, filled_count: 0, word_count: 0 })

    const progress = await rows<{ file_id: string }>('file_section_progress')
    expect([...new Set(progress.map((row) => row.file_id))]).toEqual(['file-a'])
  })

  it('recomputes every file in the project when fileIds is omitted', async () => {
    const { db, rows } = await seededDb(['file-a', 'file-b'])

    const response = await handleMigrateFinalizeRequest(
      finalizeRequest({ projectId: PROJECT_ID }),
      makeEnv(db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ ok: true, progressUpdated: 2, scoped: false })

    const files = await filesById(() => rows<FileRow>('files'))
    expect(files.get('file-a')).toMatchObject({ cell_count: 1, filled_count: 1 })
    expect(files.get('file-b')).toMatchObject({ cell_count: 1, filled_count: 1 })
  })

  it('treats an empty fileIds list as the whole project rather than a no-op', async () => {
    // A caller that computed an empty scope must never silently skip the
    // repair — falling back to the unscoped recompute is always a superset.
    const { db, rows } = await seededDb(['file-a', 'file-b'])

    const response = await handleMigrateFinalizeRequest(
      finalizeRequest({ projectId: PROJECT_ID, fileIds: [] }),
      makeEnv(db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ progressUpdated: 2, scoped: false })
    const files = await filesById(() => rows<FileRow>('files'))
    expect(files.get('file-b')).toMatchObject({ cell_count: 1 })
  })

  it('ignores a fileId belonging to another project', async () => {
    const { db, rows } = await seededDb(['file-a'], {
      projectId: OTHER_PROJECT_ID,
      fileId: 'file-foreign',
    })

    const response = await handleMigrateFinalizeRequest(
      finalizeRequest({ projectId: PROJECT_ID, fileIds: ['file-a', 'file-foreign'] }),
      makeEnv(db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ progressUpdated: 1 })
    const files = await filesById(() => rows<FileRow>('files'))
    expect(files.get('file-a')).toMatchObject({ cell_count: 1 })
    // The scope is applied by re-reading `files`, so a foreign id matches
    // nothing — it cannot reach across the project boundary.
    expect(files.get('file-foreign')).toMatchObject({ cell_count: 0 })
  })

  it('rejects a malformed fileIds field instead of widening to the whole project', async () => {
    const { db } = await seededDb(['file-a'])
    for (const fileIds of [['file-a', 7], 'file-a', ['']]) {
      const response = await handleMigrateFinalizeRequest(
        finalizeRequest({ projectId: PROJECT_ID, fileIds }),
        makeEnv(db),
      )
      expect(response?.status).toBe(400)
    }
  })

  it('pipelines the per-file progress recompute instead of one round trip per file', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `file-${i}`)
    const { db, rows } = await seededDb(ids)
    const counting = countingDb(db)

    const response = await handleMigrateFinalizeRequest(
      finalizeRequest({ projectId: PROJECT_ID }),
      makeEnv(counting.db),
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ progressUpdated: 12 })
    // The old shape was one awaited batch per file. Statements are pipelined
    // 100 at a time and each file contributes 2, so 12 files is a single
    // round trip — the assertion is on the *shape*, not on 12 exactly.
    expect(counting.batches()).toBeLessThan(ids.length)

    // Bounding the round trips must not cost correctness: every file is still
    // repaired, and each gets its progress rows.
    const files = await filesById(() => rows<FileRow>('files'))
    for (const id of ids) expect(files.get(id)).toMatchObject({ cell_count: 1, filled_count: 1 })
    const progress = await rows<{ file_id: string }>('file_section_progress')
    expect(new Set(progress.map((row) => row.file_id)).size).toBe(12)
  })

  it('is idempotent — a repeated finalize lands the same derived rows', async () => {
    const { db, rows } = await seededDb(['file-a'])
    const env = makeEnv(db)
    const body = { projectId: PROJECT_ID, fileIds: ['file-a'] }

    expect((await handleMigrateFinalizeRequest(finalizeRequest(body), env))?.status).toBe(200)
    const first = await rows<FileRow>('files')
    const firstProgress = await rows('file_section_progress')

    expect((await handleMigrateFinalizeRequest(finalizeRequest(body), env))?.status).toBe(200)
    expect((await rows<FileRow>('files')).map((f) => f.cell_count)).toEqual(
      first.map((f) => f.cell_count),
    )
    expect(await rows('file_section_progress')).toHaveLength(firstProgress.length)
  })

  it('still rejects an unauthorized caller', async () => {
    const { db } = await seededDb(['file-a'])
    const request = new Request('https://worker/migrate/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ projectId: PROJECT_ID, fileIds: ['file-a'] }),
    })
    expect((await handleMigrateFinalizeRequest(request, makeEnv(db)))?.status).toBe(401)
  })
})
