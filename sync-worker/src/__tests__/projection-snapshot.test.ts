// AQU-1833 — projection snapshots in R2, and the rebuild that starts from one.
//
// The three things that matter, in the order the acceptance criteria put them:
//
//  1. A seeded rebuild does far less work than a full replay (asserted on the
//     events it reads, not on elapsed time — machine speed must never decide a
//     test's outcome, AGENTS.md testing rule 15).
//  2. The projection it produces is IDENTICAL to a full replay's, across the
//     event shapes that make replay interesting: chained commits, a stale
//     sibling, a delete, a validate, a mirror.
//  3. Every doubtful snapshot — missing, corrupt, truncated, written against a
//     different column set, ahead of the log — falls back to a full replay
//     with no data lost.
//
// All of it runs against PGlite with the canonical schema, so the column-set
// guard is checked against a real `information_schema` and the restore INSERTs
// are real Postgres.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import {
  PROJECTION_SNAPSHOT_FORMAT,
  liveSnapshotColumns,
  projectionSnapshotManifestKey,
  readProjectionSnapshot,
  writeProjectionSnapshot,
} from '../events/projection-snapshot'
import {
  runProjectionSnapshotSweep,
  sweepProjectionSnapshots,
  readSnapshotCursor,
} from '../projection-snapshot-cron'
import { handleAdminRequest } from '../admin'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'shared-secret'
const PROJECT = 'proj-1'

interface StubObject {
  key: string
  body: string
  uploaded: Date
}

function makeStubBucket() {
  const store = new Map<string, StubObject>()
  return {
    store,
    async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort()
      const start = cursor ? keys.indexOf(cursor) + 1 : 0
      const page = keys.slice(start)
      return {
        objects: page.map((k) => ({ key: k, size: store.get(k)!.body.length, uploaded: store.get(k)!.uploaded })),
        truncated: false as const,
        cursor: undefined as string | undefined,
      }
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { text: async () => obj.body }
    },
    async put(key: string, body: string) {
      store.set(key, { key, body, uploaded: new Date() })
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

type StubBucket = ReturnType<typeof makeStubBucket>

function env(db: AquillaDb, bucket?: StubBucket) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    ...(bucket ? { SNAPSHOTS: bucket as unknown as R2Bucket } : {}),
  }
}

function snapshotEnv(bucket: StubBucket) {
  return { SNAPSHOTS: bucket as unknown as R2Bucket }
}

async function rebuild(
  db: AquillaDb,
  bucket?: StubBucket,
  query = '',
): Promise<Record<string, unknown>> {
  const res = (await handleRebuildProjectionRequest(
    new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    }),
    env(db, bucket),
  )) as Response
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

interface SeedEvent {
  id: string
  kind: string
  payload: Record<string, unknown>
  server_seq: number
  parent_id?: string | null
  cell_id?: string | null
  file_id?: string | null
}

function eventRow(e: SeedEvent) {
  return {
    id: e.id,
    schema_version: 1,
    project_id: PROJECT,
    file_id: e.file_id ?? 'file-a',
    cell_id: e.cell_id === undefined ? 'cell-1' : e.cell_id,
    parent_id: e.parent_id ?? null,
    kind: e.kind,
    author: 'alice',
    payload: JSON.stringify(e.payload),
    client_ts: e.server_seq * 10,
    server_ts: e.server_seq * 10,
    server_seq: e.server_seq,
  }
}

/**
 * The history every equivalence test replays. Deliberately not a straight line:
 * two cells, a chain of commits, a stale sibling that must stay lost, a
 * validate, and a deleted cell whose head must read as absent.
 */
const BASE_HISTORY: SeedEvent[] = [
  { id: 'e1', kind: 'source.cell.create', server_seq: 1, payload: { cellId: 'cell-1', value: 'In the beginning', valueHtml: '<p>In the beginning</p>' } },
  { id: 'e2', kind: 'source.cell.create', server_seq: 2, cell_id: 'cell-2', payload: { cellId: 'cell-2', value: 'and the earth', valueHtml: '<p>and the earth</p>' } },
  { id: 'e3', kind: 'source.cell.create', server_seq: 3, cell_id: 'cell-3', payload: { cellId: 'cell-3', value: 'doomed', valueHtml: '<p>doomed</p>' } },
  { id: 'e4', kind: 'target.cell.commit', server_seq: 4, payload: { value: 'au commencement', valueHtml: '<p>au commencement</p>', sourceEventId: 'e1' } },
  { id: 'e5', kind: 'target.cell.commit', server_seq: 5, parent_id: 'e4', payload: { value: 'Au commencement', valueHtml: '<p>Au commencement</p>', sourceEventId: 'e1' } },
  // Stale sibling of e5: same parent, lower claim. Must never project, on
  // either rebuild path.
  { id: 'e6', kind: 'target.cell.commit', server_seq: 6, parent_id: 'e4', payload: { value: 'LOSER', valueHtml: '<p>LOSER</p>', sourceEventId: 'e1' } },
  { id: 'e7', kind: 'cell.validate', server_seq: 7, payload: { editEventId: 'e5' } },
  { id: 'e8', kind: 'source.cell.delete', server_seq: 8, cell_id: 'cell-3', parent_id: 'e3', payload: { cellId: 'cell-3' } },
]

/**
 * A commit chained on e4 — which stopped being the head back at e5, BEFORE the
 * snapshot was taken. It is the one event shape that can tell a seeded head
 * state from an empty one: the head compare-and-swap rejects it against a head
 * of e5, and an unseeded replay (no head for the key at all) would let it
 * through and overwrite the cell.
 */
const STALE_AGAINST_SEEDED_HEAD: SeedEvent = {
  id: 'e12',
  kind: 'target.cell.commit',
  server_seq: 12,
  parent_id: 'e4',
  payload: { value: 'STALE AGAINST SEEDED HEAD', valueHtml: '<p>no</p>', sourceEventId: 'e1' },
}

/** Events appended after the snapshot is taken. */
const TAIL_HISTORY: SeedEvent[] = [
  { id: 'e9', kind: 'target.cell.commit', server_seq: 9, parent_id: 'e5', payload: { value: 'Au commencement était', valueHtml: '<p>Au commencement était</p>', sourceEventId: 'e1' } },
  // Second child of e5, so it loses to e9 whichever path replays it.
  { id: 'e10', kind: 'target.cell.commit', server_seq: 10, parent_id: 'e5', payload: { value: 'SECOND CHILD', valueHtml: '<p>no</p>', sourceEventId: 'e1' } },
  { id: 'e11', kind: 'target.cell.commit', server_seq: 11, cell_id: 'cell-2', payload: { value: 'et la terre', valueHtml: '<p>et la terre</p>', sourceEventId: 'e2' } },
  STALE_AGAINST_SEEDED_HEAD,
]

async function insertEvents(pg: TestDb['pg'], events: SeedEvent[]): Promise<void> {
  for (const e of events) {
    const row = eventRow(e)
    await pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id,
                           kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.id, row.schema_version, row.project_id, row.file_id, row.cell_id, row.parent_id,
        row.kind, row.author, row.payload, row.client_ts, row.server_ts, row.server_seq,
      ],
    )
  }
}

/**
 * A handle whose SECOND `MAX(server_seq)` read is preceded by a real write, so
 * the snapshot writer's before/after consistency check sees the project move
 * mid-read — the race it exists to catch, without having to actually race it.
 */
function dbThatMovesMidRead(real: AquillaDb, move: () => Promise<void>): AquillaDb {
  let seen = 0
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver)
      return (sql: string) => {
        const stmt = target.prepare(sql)
        if (!sql.includes('MAX(server_seq)')) return stmt
        seen += 1
        if (seen !== 2) return stmt
        return new Proxy(stmt, {
          get(sTarget, sProp, sReceiver) {
            if (sProp !== 'bind') return Reflect.get(sTarget, sProp, sReceiver)
            return (...binds: unknown[]) => {
              const bound = sTarget.bind(...binds)
              return new Proxy(bound, {
                get(bTarget, bProp, bReceiver) {
                  if (bProp !== 'first') return Reflect.get(bTarget, bProp, bReceiver)
                  return async (col?: string) => {
                    await move()
                    return col === undefined ? bTarget.first() : bTarget.first(col)
                  }
                },
              })
            }
          },
        })
      }
    },
  })
}

/** The two tables a rebuild replays, ordered so two runs compare directly. */
async function projection(test: TestDb) {
  const cells = await test.pg.query<Record<string, unknown>>(
    `SELECT * FROM cells WHERE project_id = $1 ORDER BY file_id, cell_id, side, lane_id`,
    [PROJECT],
  )
  const validators = await test.pg.query<Record<string, unknown>>(
    `SELECT * FROM cell_validators WHERE project_id = $1 ORDER BY file_id, cell_id, lane_id, username`,
    [PROJECT],
  )
  return { cells: cells.rows, validators: validators.rows }
}

describe('AQU-1833 projection snapshots', () => {
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

  describe('snapshot + tail == full replay', () => {
    it('replays only the tail and lands on the same projection as a full replay', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()

      // The projection the snapshot is taken from is the one a full replay
      // produces — exactly how a live projection reaches R2 in production.
      await rebuild(test.db, undefined)
      const written = await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, {
        minNewEvents: 0,
      })
      expect(written?.manifest.snapshotSeq).toBe(8)
      expect(written?.manifest.counts.cells).toBeGreaterThan(0)
      expect(written?.manifest.counts.cell_validators).toBe(1)

      await insertEvents(test.pg, TAIL_HISTORY)

      const seeded = await rebuild(test.db, bucket)
      expect(seeded.fromSnapshot).toBe(true)
      expect(seeded.snapshotSeq).toBe(8)
      expect(seeded.replayFromSeq).toBe(8)
      // Three tail events, not eleven: the work the snapshot saved.
      expect(seeded.eventsRead).toBe(TAIL_HISTORY.length)
      const afterSeeded = await projection(test)

      const full = await rebuild(test.db, bucket, '?fullReplay=1')
      expect(full.fromSnapshot).toBe(false)
      expect(full.replayFromSeq).toBe(0)
      expect(full.eventsRead).toBe(BASE_HISTORY.length + TAIL_HISTORY.length)
      const afterFull = await projection(test)

      expect(afterSeeded).toEqual(afterFull)
      // And it is the right projection, not two matching wrong ones.
      const head = afterSeeded.cells.find((c) => c.cell_id === 'cell-1' && c.side === 'target')
      expect(head?.value).toBe('Au commencement était')
      expect(head?.event_id).toBe('e9')
      expect(afterSeeded.cells.some((c) => c.value === 'LOSER')).toBe(false)
      expect(afterSeeded.cells.some((c) => c.value === 'SECOND CHILD')).toBe(false)
      expect(afterSeeded.cells.some((c) => c.value === 'STALE AGAINST SEEDED HEAD')).toBe(false)
      expect(afterSeeded.cells.some((c) => c.cell_id === 'cell-3')).toBe(false)
    })

    it('rejects a tail commit chained off a pre-snapshot head — the seed is real', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, { minNewEvents: 0 })
      // The ONLY event after the snapshot, and it is chained off a head that
      // moved before the snapshot was taken. An unseeded replay holds no head
      // for this key and would apply it.
      await insertEvents(test.pg, [STALE_AGAINST_SEEDED_HEAD])

      const seeded = await rebuild(test.db, bucket)
      expect(seeded.fromSnapshot).toBe(true)
      expect(seeded.eventsRead).toBe(1)
      const head = (await projection(test)).cells.find(
        (c) => c.cell_id === 'cell-1' && c.side === 'target',
      )
      expect(head?.event_id).toBe('e5')
      expect(head?.value).toBe('Au commencement')
    })

    it('restores rows across several chunks (keyset paging)', async () => {
      const many: SeedEvent[] = []
      for (let i = 0; i < 25; i += 1) {
        many.push({
          id: `m${i}`,
          kind: 'source.cell.create',
          server_seq: i + 1,
          cell_id: `cell-${String(i).padStart(3, '0')}`,
          payload: { cellId: `cell-${String(i).padStart(3, '0')}`, value: `v${i}`, valueHtml: `<p>v${i}</p>` },
        })
      }
      await insertEvents(test.pg, many)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      const written = await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, {
        minNewEvents: 0,
        chunkRows: 10,
      })
      const cellChunks = written!.manifest.chunks.filter((c) => c.table === 'cells')
      expect(cellChunks.length).toBe(3)
      expect(cellChunks.map((c) => c.rows)).toEqual([10, 10, 5])

      const seeded = await rebuild(test.db, bucket)
      expect(seeded.fromSnapshot).toBe(true)
      expect(seeded.snapshotRowsRestored).toEqual({ cells: 25, cell_validators: 0 })
      expect((await projection(test)).cells).toHaveLength(25)
    })
  })

  describe('every doubtful snapshot falls back to a full replay', () => {
    async function snapshotThen(mutate: (bucket: StubBucket) => Promise<void> | void) {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, { minNewEvents: 0 })
      await insertEvents(test.pg, TAIL_HISTORY)
      await mutate(bucket)
      return bucket
    }

    /** The projection a from-genesis replay produces for BASE + TAIL. */
    async function expectedFullProjection() {
      await rebuild(test.db, undefined, '?fullReplay=1')
      return projection(test)
    }

    it('no snapshot at all replays in full', async () => {
      await insertEvents(test.pg, [...BASE_HISTORY, ...TAIL_HISTORY])
      const body = await rebuild(test.db, makeStubBucket())
      expect(body.fromSnapshot).toBe(false)
      expect(body.snapshotNote).toBeUndefined()
      expect(body.eventsRead).toBe(BASE_HISTORY.length + TAIL_HISTORY.length)
    })

    it('an unparseable manifest replays in full', async () => {
      const bucket = await snapshotThen((b) =>
        b.put(projectionSnapshotManifestKey({}, PROJECT), 'not json at all'),
      )
      const body = await rebuild(test.db, bucket)
      expect(body.fromSnapshot).toBe(false)
      expect(body.replayFromSeq).toBe(0)
      expect(await projection(test)).toEqual(await expectedFullProjection())
    })

    it('an unknown format version replays in full', async () => {
      const bucket = await snapshotThen(async (b) => {
        const key = projectionSnapshotManifestKey({}, PROJECT)
        const manifest = JSON.parse(await (await b.get(key))!.text())
        await b.put(key, JSON.stringify({ ...manifest, format: PROJECTION_SNAPSHOT_FORMAT + 1 }))
      })
      expect(await readProjectionSnapshot(snapshotEnv(bucket), PROJECT)).toBeNull()
      const body = await rebuild(test.db, bucket)
      expect(body.fromSnapshot).toBe(false)
      expect(await projection(test)).toEqual(await expectedFullProjection())
    })

    it('a missing chunk replays in full, losing nothing', async () => {
      const bucket = await snapshotThen(async (b) => {
        const manifest = await readProjectionSnapshot(snapshotEnv(b), PROJECT)
        await b.delete(manifest!.chunks.find((c) => c.table === 'cells')!.key)
      })
      const body = await rebuild(test.db, bucket)
      expect(body.fromSnapshot).toBe(false)
      expect(body.replayFromSeq).toBe(0)
      expect(String(body.snapshotNote)).toContain('unreadable')
      // The restore had already inserted rows when it failed; the fallback must
      // have wiped them, so no row is duplicated or stale.
      expect(await projection(test)).toEqual(await expectedFullProjection())
    })

    it('a snapshot ahead of the log replays in full', async () => {
      const bucket = await snapshotThen(async (b) => {
        const key = projectionSnapshotManifestKey({}, PROJECT)
        const manifest = JSON.parse(await (await b.get(key))!.text())
        await b.put(key, JSON.stringify({ ...manifest, snapshotSeq: 9_999 }))
      })
      const body = await rebuild(test.db, bucket)
      expect(body.fromSnapshot).toBe(false)
      expect(String(body.snapshotNote)).toContain('ahead of the log')
      expect(await projection(test)).toEqual(await expectedFullProjection())
    })

    it('a snapshot written against a different column set replays in full', async () => {
      const bucket = await snapshotThen(async () => {
        // The exact drift the column guard exists for: a column added after the
        // snapshot was written. Restoring would leave it NULL on every
        // pre-snapshot row — silently wrong, which is worse than slow.
        await test.pg.exec('ALTER TABLE cells ADD COLUMN aqu1833_drift TEXT')
      })
      try {
        const body = await rebuild(test.db, bucket)
        expect(body.fromSnapshot).toBe(false)
        expect(String(body.snapshotNote)).toContain('predates the current cells columns')
        expect(await projection(test)).toEqual(await expectedFullProjection())
      } finally {
        await test.pg.exec('ALTER TABLE cells DROP COLUMN aqu1833_drift')
      }
    })

    it('?fullReplay=1 ignores a perfectly good snapshot', async () => {
      const bucket = await snapshotThen(() => {})
      const body = await rebuild(test.db, bucket, '?fullReplay=1')
      expect(body.fromSnapshot).toBe(false)
      expect(body.eventsRead).toBe(BASE_HISTORY.length + TAIL_HISTORY.length)
    })
  })

  describe('writeProjectionSnapshot', () => {
    it('excludes generated columns, which cannot be written back', async () => {
      const columns = await liveSnapshotColumns(test.db, 'cells')
      expect(columns).not.toContain('value_tsv')
      expect(columns).toContain('event_id')
    })

    it('writes nothing for a project with no events', async () => {
      const bucket = makeStubBucket()
      expect(
        await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, { minNewEvents: 0 }),
      ).toBeNull()
      expect(bucket.store.size).toBe(0)
    })

    it('skips a project that has not moved far enough since its last snapshot', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      expect(
        await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, { minNewEvents: 0 }),
      ).not.toBeNull()
      await insertEvents(test.pg, TAIL_HISTORY)
      expect(
        await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, {
          minNewEvents: 1_000,
        }),
      ).toBeNull()
      expect((await readProjectionSnapshot(snapshotEnv(bucket), PROJECT))!.snapshotSeq).toBe(8)
    })

    it('abandons the run when the project takes a write mid-read', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      const moving = dbThatMovesMidRead(test.db, async () => {
        await insertEvents(test.pg, [TAIL_HISTORY[0]!])
      })
      expect(
        await writeProjectionSnapshot(snapshotEnv(bucket), moving, PROJECT, { minNewEvents: 0 }),
      ).toBeNull()
      // No manifest, and the chunks it had already written are gone: a blended
      // snapshot must never become the one a rebuild reads.
      expect(await readProjectionSnapshot(snapshotEnv(bucket), PROJECT)).toBeNull()
      expect([...bucket.store.keys()]).toEqual([])
    })

    it('prunes the superseded snapshot chunks once the new manifest lands', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      const bucket = makeStubBucket()
      await rebuild(test.db)
      await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, { minNewEvents: 0 })
      await insertEvents(test.pg, TAIL_HISTORY)
      await rebuild(test.db, bucket)
      const second = await writeProjectionSnapshot(snapshotEnv(bucket), test.db, PROJECT, {
        minNewEvents: 0,
      })
      expect(second!.manifest.snapshotSeq).toBe(12)
      const keys = [...bucket.store.keys()]
      expect(keys.some((k) => k.includes('/12/'))).toBe(true)
      expect(keys.some((k) => k.includes('/8/'))).toBe(false)
      // Still readable end to end after the prune.
      const body = await rebuild(test.db, bucket)
      expect(body.fromSnapshot).toBe(true)
      expect(body.eventsRead).toBe(0)
    })
  })

  describe('the nightly sweep', () => {
    it('snapshots the projects that moved and skips the ones that did not', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      await test.pg.query(
        `INSERT INTO project_seq_counters (project_id, last_seq, project_epoch) VALUES ($1, $2, 1)`,
        [PROJECT, 8],
      )
      const bucket = makeStubBucket()
      await rebuild(test.db)

      const first = await sweepProjectionSnapshots(
        { ...snapshotEnv(bucket), AQUILLA_PG: test.db },
        { minNewEvents: 0 },
      )
      expect(first.snapshotsWritten).toBe(1)
      expect(first.written[0]!.projectId).toBe(PROJECT)
      expect(first.nextCursor).toBeUndefined() // walk wrapped

      const second = await sweepProjectionSnapshots(
        { ...snapshotEnv(bucket), AQUILLA_PG: test.db },
        { minNewEvents: 1_000 },
      )
      expect(second.snapshotsWritten).toBe(0)
      expect(second.skippedCurrent).toBe(1)
    })

    it('stops at the per-run write cap and resumes from the project it handled', async () => {
      for (const id of ['p-a', 'p-b', 'p-c']) {
        await test.pg.query(
          `INSERT INTO project_seq_counters (project_id, last_seq, project_epoch) VALUES ($1, 5, 1)`,
          [id],
        )
        await test.pg.query(
          `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id,
                               kind, author, payload, client_ts, server_ts, server_seq)
           VALUES ($1, 1, $2, 'file-a', 'cell-1', NULL, 'source.cell.create', 'alice',
                   $3, 1, 1, 5)`,
          [`${id}-e1`, id, JSON.stringify({ cellId: 'cell-1', value: 'x', valueHtml: '<p>x</p>' })],
        )
      }
      const bucket = makeStubBucket()
      const report = await sweepProjectionSnapshots(
        { ...snapshotEnv(bucket), AQUILLA_PG: test.db },
        { minNewEvents: 0, maxSnapshots: 2 },
      )
      expect(report.snapshotsWritten).toBe(2)
      // The cursor names the LAST project actually handled, so the third is
      // picked up next run rather than skipped.
      expect(report.nextCursor).toBe('p-b')
    })

    it('runs one project on demand without moving the nightly cursor', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      await test.pg.query(
        `INSERT INTO project_seq_counters (project_id, last_seq, project_epoch) VALUES ($1, 8, 1)`,
        [PROJECT],
      )
      const bucket = makeStubBucket()
      await rebuild(test.db)
      const report = await runProjectionSnapshotSweep(
        { ...snapshotEnv(bucket), AQUILLA_PG: test.db },
        { onlyProjectId: PROJECT, minNewEvents: 0 },
      )
      expect(report!.snapshotsWritten).toBe(1)
      expect(await readSnapshotCursor({ ...snapshotEnv(bucket) })).toBeUndefined()
    })

    it('PROJECTION_SNAPSHOT_MODE=off skips the sweep entirely', async () => {
      const bucket = makeStubBucket()
      expect(
        await runProjectionSnapshotSweep({
          ...snapshotEnv(bucket),
          AQUILLA_PG: test.db,
          PROJECTION_SNAPSHOT_MODE: 'off',
        }),
      ).toBeNull()
      expect(bucket.store.size).toBe(0)
    })
  })

  describe('POST /admin/projection-snapshot', () => {
    function adminRequest(method = 'POST', query = '', bearer = 'admin-secret') {
      return new Request(`https://worker/admin/projection-snapshot${query}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}` },
      })
    }

    function adminEnv(bucket: StubBucket) {
      return {
        SNAPSHOTS: bucket as unknown as R2Bucket,
        AQUILLA_PG: test.db,
        ADMIN_SECRET: 'admin-secret',
      }
    }

    it('rejects a wrong bearer', async () => {
      const res = (await handleAdminRequest(
        adminRequest('POST', '', 'nope'),
        adminEnv(makeStubBucket()),
      )) as Response
      expect(res.status).toBe(401)
    })

    it('rejects a non-POST', async () => {
      const res = (await handleAdminRequest(
        adminRequest('GET'),
        adminEnv(makeStubBucket()),
      )) as Response
      expect(res.status).toBe(405)
    })

    it('snapshots one project on demand', async () => {
      await insertEvents(test.pg, BASE_HISTORY)
      await test.pg.query(
        `INSERT INTO project_seq_counters (project_id, last_seq, project_epoch) VALUES ($1, 8, 1)`,
        [PROJECT],
      )
      const bucket = makeStubBucket()
      await rebuild(test.db)
      const res = (await handleAdminRequest(
        adminRequest('POST', `?projectId=${PROJECT}&minNewEvents=0`),
        adminEnv(bucket),
      )) as Response
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; report: { snapshotsWritten: number } }
      expect(body.ok).toBe(true)
      expect(body.report.snapshotsWritten).toBe(1)
      expect((await readProjectionSnapshot(snapshotEnv(bucket), PROJECT))!.snapshotSeq).toBe(8)
    })
  })
})
