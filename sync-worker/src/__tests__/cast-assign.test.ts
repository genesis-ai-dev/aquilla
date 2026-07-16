// Tests for the cast.assign event (AQU-438):
//   - Projection: merges cast_name into cells.metadata JSONB on the source row.
//   - Does NOT touch cells.event_id, cells.value, or target text.
//   - Non-chain-mutating: not in CHAIN_MUTATING_KINDS.
//   - Role gate: contributor (400) CAN assign; viewer (100) CANNOT.
//   - Null castName clears the label.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { REQUIRED_ROLE } from '../events/role-policy'
import type { EventKind } from '../events/types'

// ── Recording DB stub ─────────────────────────────────────────────────────

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function makeCastAssignEvent(
  castName: string | null,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<'cast.assign'> {
  return {
    id: 'evt-cast-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-a',
    cellId: 'cell-1',
    parentId: null,
    kind: 'cast.assign',
    author: 'pm-user',
    payload: { castName },
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 99,
    ...overrides,
  } as PersistedEvent<'cast.assign'>
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('cast.assign — is non-chain-mutating', () => {
  it('is NOT in CHAIN_MUTATING_KINDS', () => {
    expect(isChainMutatingKind('cast.assign')).toBe(false)
  })
})

describe('cast.assign — role gate', () => {
  it('requires at most CONTRIBUTOR (400)', () => {
    // Contributor (400) must be able to emit cast.assign.
    expect(REQUIRED_ROLE['cast.assign']).toBeLessThanOrEqual(400)
  })

  it('is above VIEWER (100)', () => {
    expect(REQUIRED_ROLE['cast.assign']).toBeGreaterThan(100)
  })
})

describe('cast.assign — projection (non-null castName)', () => {
  it('emits a JSONB merge UPDATE targeting the source row', () => {
    const { db, recorded } = makeRecordingDb()
    const event = makeCastAssignEvent('Narrator')
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(db, event, stmts)

    expect(touches).toContain('cells')
    expect(stmts).toHaveLength(1)

    const [stmt] = recorded
    // SQL should be a metadata merge (JSONB ||), not a value update.
    expect(stmt.sql).toMatch(/UPDATE cells/)
    expect(stmt.sql).toMatch(/metadata.*jsonb_build_object/i)
    expect(stmt.sql).toMatch(/cast_name/i)
    // Must target source side only.
    expect(stmt.sql).toMatch(/side = 'source'/)
    // Must NOT reference 'value' or 'event_id' column updates.
    expect(stmt.sql).not.toMatch(/SET.*value\s*=/i)
    expect(stmt.sql).not.toMatch(/event_id\s*=/)
    // Binds: castName, projectId, fileId, cellId
    expect(stmt.args).toContain('Narrator')
    expect(stmt.args).toContain('proj-1')
    expect(stmt.args).toContain('file-a')
    expect(stmt.args).toContain('cell-1')
  })

  it('does NOT emit file counter recompute (non-chain-mutating)', () => {
    const { db, recorded } = makeRecordingDb()
    const event = makeCastAssignEvent('Anna')
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, event, stmts)

    // No UPDATE files statement should appear.
    const filesUpdates = recorded.filter((s) => s.sql.toUpperCase().includes('UPDATE FILES'))
    expect(filesUpdates).toHaveLength(0)
  })
})

describe('cast.assign — projection (null castName = clear)', () => {
  it('emits a JSONB key-removal UPDATE when castName is null', () => {
    const { db, recorded } = makeRecordingDb()
    const event = makeCastAssignEvent(null)
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(db, event, stmts)

    expect(touches).toContain('cells')
    expect(stmts).toHaveLength(1)

    const [stmt] = recorded
    expect(stmt.sql).toMatch(/UPDATE cells/)
    // The clear path uses the `- 'cast_name'` JSONB operator.
    expect(stmt.sql).toMatch(/cast_name/)
    expect(stmt.sql).toMatch(/side = 'source'/)
    // Binds: projectId, fileId, cellId (no castName value)
    expect(stmt.args).toContain('proj-1')
    expect(stmt.args).toContain('file-a')
    expect(stmt.args).toContain('cell-1')
    // null should NOT appear in args (the clear path does not bind the cast name)
    expect(stmt.args).not.toContain('Narrator')
  })
})

describe('cast.assign — missing required fields', () => {
  it('throws when fileId is absent', () => {
    const { db } = makeRecordingDb()
    const event = makeCastAssignEvent('Narrator', { fileId: null as unknown as string })
    expect(() => buildEventProjectionStmts(db, event, [])).toThrow(/missing fileId/)
  })

  it('throws when cellId is absent', () => {
    const { db } = makeRecordingDb()
    const event = makeCastAssignEvent('Narrator', { cellId: null as unknown as string })
    expect(() => buildEventProjectionStmts(db, event, [])).toThrow(/missing.*cellId/)
  })
})
