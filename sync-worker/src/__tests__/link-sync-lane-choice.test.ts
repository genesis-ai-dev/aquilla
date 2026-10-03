// AQU-1605: a target-consumption link consumes the UPSTREAM LANE it was pointed
// at — `projects.source_link_lane_id` — not whichever of the upstream's lanes
// happens to carry the empty legacy tag.
//
// The sibling file link-sync-fold.default-lane-baseline.test.ts pins the other
// half of the same contract: a link that names no lane still consumes the former
// default lane, which is what every link made before this slice does and what
// every row does until AQU-1616's backfill names its lane. Both must hold at
// once — that is the "works before and after the backfill" delivery rule on
// AQU-1419.

import { describe, it, expect } from 'vitest'
import { mirrorSync, deterministicDownstreamFileId, resolveConsumedLaneTag } from '../events/link-sync'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { AquillaStatement } from '../../../db/shim/postgres'

const UPSTREAM = 'proj-upstream-lane-choice'
const DOWNSTREAM = 'proj-downstream-lane-choice'
const OTHER = 'proj-other-lane-choice'
const FILE = 'file-lc-1'
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)
const CELL = 'cell-lc-1'

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-lc-${_seq}`
}

async function nextUpstreamSeq(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  return Number(row.rows[0]?.next_seq ?? 1)
}

async function emitUpstream(
  t: TestDb,
  kind: 'file.create' | 'source.cell.create' | 'target.cell.commit',
  args: {
    fileId?: string
    cellId?: string
    payload: Record<string, unknown>
    /** The prior winning event on this cell's chain FOR THIS LANE. A commit that
     *  does not chain on the lane's current head loses the head
     *  compare-and-swap and is skipped by the fold as a stale sibling
     *  (AQU-1154 / AQU-1574) — which would make a lane assertion below pass for
     *  the wrong reason. */
    parentId?: string
  },
): Promise<string> {
  const id = nextId()
  const seq = await nextUpstreamSeq(t)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $9, $5, 'translator', $6, $7, $7, $8)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), seq, seq, args.parentId ?? null],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: args.parentId ?? null,
    kind,
    author: 'translator',
    payload: args.payload,
    clientTs: seq,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return id
}

/** Upstream holding one file, one source cell and a translation in each of two
 *  lanes: the former default lane and a second lane tagged `French`. */
interface UpstreamHeads {
  /** Current commit on the former default lane's chain for CELL. */
  defaultLane: string
  /** Current commit on the `French` lane's chain for CELL. */
  french: string
}

async function seedUpstreamWithTwoLanes(t: TestDb): Promise<UpstreamHeads> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Other', 1)`, [OTHER])
  await emitUpstream(t, 'file.create', { fileId: FILE, payload: { name: 'Ep 1', fileType: 'codex' } })
  await emitUpstream(t, 'source.cell.create', {
    fileId: FILE,
    cellId: CELL,
    payload: { cellId: CELL, value: 'Source text', anchorCellId: null },
  })
  const defaultLane = await emitUpstream(t, 'target.cell.commit', {
    fileId: FILE,
    cellId: CELL,
    payload: { value: 'default lane text', targetLang: '' },
  })
  const french = await emitUpstream(t, 'target.cell.commit', {
    fileId: FILE,
    cellId: CELL,
    payload: { value: 'french lane text', targetLang: 'French' },
  })
  return { defaultLane, french }
}

/** The lane row the projection minted for `tag` on the upstream. */
async function upstreamLaneId(t: TestDb, tag: string, projectId = UPSTREAM): Promise<string> {
  const row = await t.pg.query<{ id: string }>(
    `SELECT id FROM lanes WHERE project_id = $1 AND role = 'target' AND legacy_tag = $2`,
    [projectId, tag],
  )
  const id = row.rows[0]?.id
  if (!id) throw new Error(`no lane row for tag ${JSON.stringify(tag)}`)
  return id
}

async function linkDownstream(t: TestDb, laneId: string | null): Promise<void> {
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode,
                           source_link_consumes, source_link_gate, source_link_cursor, source_link_lane_id)
     VALUES ($1, 'Downstream', 1, $2, 'live', 'target', 'head', 0, $3)`,
    [DOWNSTREAM, UPSTREAM, laneId],
  )
}

async function downstreamSourceValue(t: TestDb): Promise<string | undefined> {
  const row = await t.pg.query<{ value: string }>(
    `SELECT value FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [DOWNSTREAM, DOWNSTREAM_FILE, CELL],
  )
  return row.rows[0]?.value
}

describe('link-sync — the link consumes the upstream lane it names (AQU-1605)', () => {
  it("mirrors the NAMED lane's translation, not the former default lane's", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamWithTwoLanes(t)
      await linkDownstream(t, await upstreamLaneId(t, 'French'))

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamSourceValue(t)).toBe('french lane text')
    } finally {
      await t.close()
    }
  })

  it('a later edit in another lane does not reach a link pinned to this one', async () => {
    const t = await makeTestDb()
    try {
      const heads = await seedUpstreamWithTwoLanes(t)
      await linkDownstream(t, await upstreamLaneId(t, 'French'))
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamSourceValue(t)).toBe('french lane text')

      // The default lane moves on, chained on its own head so the commit WINS
      // upstream. The link follows French, so nothing here changes — and the
      // cursor still advances, so this is a true no-op rather than a change that
      // keeps being re-folded.
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        parentId: heads.defaultLane,
        payload: { value: 'default lane text, revised', targetLang: '' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.cellsMirrored).toBe(0)
      expect(await downstreamSourceValue(t)).toBe('french lane text')
    } finally {
      await t.close()
    }
  })

  it('an edit in the named lane reaches it, after a default-lane edit did not', async () => {
    const t = await makeTestDb()
    try {
      const heads = await seedUpstreamWithTwoLanes(t)
      await linkDownstream(t, await upstreamLaneId(t, 'French'))
      await mirrorSync(t.db, DOWNSTREAM)

      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        parentId: heads.defaultLane,
        payload: { value: 'default lane text, revised', targetLang: '' },
      })
      expect((await mirrorSync(t.db, DOWNSTREAM)).cellsMirrored).toBe(0)

      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        parentId: heads.french,
        payload: { value: 'french lane text, revised', targetLang: 'French' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamSourceValue(t)).toBe('french lane text, revised')
    } finally {
      await t.close()
    }
  })

  it('names no lane → the former default lane, exactly as before this slice', async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamWithTwoLanes(t)
      await linkDownstream(t, null)

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamSourceValue(t)).toBe('default lane text')
    } finally {
      await t.close()
    }
  })

  it("a lane id that is not this upstream's mirrors NOTHING rather than the default lane", async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamWithTwoLanes(t)
      // A real lane row, on another project. Lane ids are globally unique
      // (AQU-1606), so this resolves to a row — and must still be refused:
      // falling back to the default lane here would pour another language's
      // text into the downstream's source.
      await t.pg.query(
        `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
         VALUES ('lane-elsewhere', $1, 'target', 'Spanish', 'Spanish', 0)`,
        [OTHER],
      )
      await linkDownstream(t, 'lane-elsewhere')

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(false)
      expect(await downstreamSourceValue(t)).toBeUndefined()
      // The cursor has not moved, so the window is still there to fold once the
      // link names a lane this upstream actually has.
      const row = await t.pg.query<{ source_link_cursor: string }>(
        `SELECT source_link_cursor FROM projects WHERE id = $1`,
        [DOWNSTREAM],
      )
      expect(Number(row.rows[0]?.source_link_cursor)).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('resolveConsumedLaneTag: id → legacy tag, absent → default lane, foreign → null', async () => {
    const t = await makeTestDb()
    try {
      await seedUpstreamWithTwoLanes(t)
      const french = await upstreamLaneId(t, 'French')
      expect(await resolveConsumedLaneTag(t.db, UPSTREAM, french)).toBe('French')
      expect(await resolveConsumedLaneTag(t.db, UPSTREAM, await upstreamLaneId(t, ''))).toBe('')
      expect(await resolveConsumedLaneTag(t.db, UPSTREAM, null)).toBe('')
      expect(await resolveConsumedLaneTag(t.db, UPSTREAM, 'lane-that-does-not-exist')).toBeNull()
      // The upstream's own SOURCE lane is not something a target link consumes.
      const source = await t.pg.query<{ id: string }>(
        `SELECT id FROM lanes WHERE project_id = $1 AND role = 'source'`,
        [UPSTREAM],
      )
      if (source.rows[0]) {
        expect(await resolveConsumedLaneTag(t.db, UPSTREAM, source.rows[0].id)).toBeNull()
      }
    } finally {
      await t.close()
    }
  })
})
