// PRE-AQU-1240 characterization baseline — pins link-sync.ts loadUpstreamTargetDelta
// (§1.2): v1 target-consumption consumes ONLY the upstream DEFAULT lane (`''` /
// absent targetLang); non-default lanes are skipped. UPDATE (do not silently
// delete) when `''` is eliminated for target rows (AQU-1240 slice 0).

import { describe, it, expect } from 'vitest'
import { mirrorSync, deterministicDownstreamFileId } from '../events/link-sync'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const UPSTREAM = 'proj-upstream-fold-baseline'
const DOWNSTREAM = 'proj-downstream-fold-baseline'
const FILE = 'file-ep-1'
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)
const CELL = 'cell-1'

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-fold-${_seq}`
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
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown>; author?: string },
): Promise<{ id: string; seq: number }> {
  const id = nextId()
  const seq = await nextUpstreamSeq(t)
  const ts = seq
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, $8, $9)`,
    [
      id,
      UPSTREAM,
      args.fileId ?? null,
      args.cellId ?? null,
      kind,
      args.author ?? 'translator',
      JSON.stringify(args.payload),
      ts,
      seq,
    ],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: args.author ?? 'translator',
    payload: args.payload,
    clientTs: ts,
    serverTs: ts,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return { id, seq }
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', 'target', 'head', 0)`,
    [DOWNSTREAM, UPSTREAM],
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

describe('link-sync fold — PRE-AQU-1240 default-lane consumption baseline', () => {
  it("consumes a target commit with payload.targetLang === '' (explicit default lane)", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await emitUpstream(t, 'file.create', { fileId: FILE, payload: { name: 'Ep 1', fileType: 'codex' } })
      await emitUpstream(t, 'source.cell.create', {
        fileId: FILE,
        cellId: CELL,
        payload: { cellId: CELL, value: 'Source text', anchorCellId: null },
      })
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        payload: { value: 'default-lane translation', targetLang: '' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamSourceValue(t)).toBe('default-lane translation')
    } finally {
      await t.close()
    }
  })

  it('consumes a target commit with targetLang absent (legacy omit-on-wire)', async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await emitUpstream(t, 'file.create', { fileId: FILE, payload: { name: 'Ep 1', fileType: 'codex' } })
      await emitUpstream(t, 'source.cell.create', {
        fileId: FILE,
        cellId: CELL,
        payload: { cellId: CELL, value: 'Source text', anchorCellId: null },
      })
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        payload: { value: 'legacy omit-on-wire translation' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(1)
      expect(await downstreamSourceValue(t)).toBe('legacy omit-on-wire translation')
    } finally {
      await t.close()
    }
  })

  it("SKIPS a target commit with targetLang === 'es' — downstream keeps prior default-lane text", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await emitUpstream(t, 'file.create', { fileId: FILE, payload: { name: 'Ep 1', fileType: 'codex' } })
      await emitUpstream(t, 'source.cell.create', {
        fileId: FILE,
        cellId: CELL,
        payload: { cellId: CELL, value: 'Source text', anchorCellId: null },
      })
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        payload: { value: 'default lane text' },
      })
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamSourceValue(t)).toBe('default lane text')

      // Non-default lane commit is invisible to the fold — does not touch the cell.
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        payload: { value: 'spanish lane text', targetLang: 'es' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)
      expect(await downstreamSourceValue(t)).toBe('default lane text')
    } finally {
      await t.close()
    }
  })

  it("a lone targetLang === 'es' commit with no default-lane row mirrors nothing", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await emitUpstream(t, 'file.create', { fileId: FILE, payload: { name: 'Ep 1', fileType: 'codex' } })
      await emitUpstream(t, 'source.cell.create', {
        fileId: FILE,
        cellId: CELL,
        payload: { cellId: CELL, value: 'Source text', anchorCellId: null },
      })
      await emitUpstream(t, 'target.cell.commit', {
        fileId: FILE,
        cellId: CELL,
        payload: { value: 'only spanish', targetLang: 'es' },
      })

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)
      const row = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3`,
        [DOWNSTREAM, DOWNSTREAM_FILE, CELL],
      )
      expect(row.rows).toHaveLength(0)
    } finally {
      await t.close()
    }
  })
})
