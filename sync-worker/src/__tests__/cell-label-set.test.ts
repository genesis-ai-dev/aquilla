// Tests for the cell.label.set event (AQU-2408):
//   - Projection: merges `cellLabel` into cells.metadata JSONB on the SOURCE row,
//     exactly as cast.assign merges cast_name — one key, per-key merge.
//   - Does NOT touch cells.event_id, cells.value, validated, or target text.
//   - Non-chain-mutating: not in CHAIN_MUTATING_KINDS.
//   - Role gate: project lead (500) is the static floor; a contributor cannot.
//   - Null or blank label removes the key. Never writes cast_name.
// Decision record: docs/decisions/0007-cell-labels-are-metadata-never-cast.md.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { REQUIRED_ROLE, ROLE } from '../events/role-policy'

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

function makeEvent(label: string | null, overrides: Partial<PersistedEvent> = {}): PersistedEvent<'cell.label.set'> {
  return {
    id: 'evt-label-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-a',
    cellId: 'cell-1',
    parentId: null,
    kind: 'cell.label.set',
    author: 'lead-user',
    payload: { label },
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 99,
    ...overrides,
  } as PersistedEvent<'cell.label.set'>
}

describe('cell.label.set — is non-chain-mutating', () => {
  it('is NOT in CHAIN_MUTATING_KINDS', () => {
    expect(isChainMutatingKind('cell.label.set')).toBe(false)
  })
})

describe('cell.label.set — role gate', () => {
  it('has project lead (500) as its static floor — the lowest rung cellLabelFloor can admit', () => {
    expect(REQUIRED_ROLE['cell.label.set']).toBe(ROLE.PROJECT_LEAD)
    expect(REQUIRED_ROLE['cell.label.set']).toBeGreaterThan(ROLE.CONTRIBUTOR)
  })

  it('sits a rung below cast.assign — a label is not a character', () => {
    expect(REQUIRED_ROLE['cell.label.set']).toBeLessThan(REQUIRED_ROLE['cast.assign'])
  })
})

describe('cell.label.set — projection (label set)', () => {
  it('emits ONE JSONB merge of cellLabel on the source row, touching no other column', () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(db, makeEvent('Pericope'), stmts)

    expect(touches).toEqual(['cells'])
    expect(stmts).toHaveLength(1)
    const [stmt] = recorded
    expect(stmt.sql).toMatch(/UPDATE cells/)
    expect(stmt.sql).toMatch(/jsonb_build_object\('cellLabel'/)
    expect(stmt.sql).toMatch(/COALESCE\(metadata, '\{\}'::jsonb\) \|\|/)
    expect(stmt.sql).toMatch(/side = 'source'/)
    expect(stmt.sql).not.toMatch(/cast_name/)
    expect(stmt.sql).not.toMatch(/SET.*value\s*=/i)
    expect(stmt.sql).not.toMatch(/event_id\s*=/)
    expect(stmt.sql).not.toMatch(/validated/)
    expect(stmt.args).toEqual(['Pericope', 'proj-1', 'file-a', 'cell-1'])
  })

  it('trims the label before storing it', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('  Pericope  '), [])
    expect(recorded[0].args[0]).toBe('Pericope')
  })

  it('does NOT emit a file counter recompute', () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(db, makeEvent('Pericope'), [])
    expect(recorded.filter((s) => s.sql.toUpperCase().includes('UPDATE FILES'))).toHaveLength(0)
  })
})

describe('cell.label.set — projection (clear)', () => {
  it.each([null, '', '   '])('removes only the cellLabel key when the label is %j', (label) => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(db, makeEvent(label), stmts)

    expect(touches).toEqual(['cells'])
    expect(stmts).toHaveLength(1)
    const [stmt] = recorded
    expect(stmt.sql).toMatch(/metadata - 'cellLabel'/)
    expect(stmt.sql).toMatch(/WHEN metadata IS NULL THEN NULL/)
    expect(stmt.sql).toMatch(/side = 'source'/)
    expect(stmt.sql).not.toMatch(/cast_name/)
    expect(stmt.args).toEqual(['proj-1', 'file-a', 'cell-1'])
  })
})

describe('cell.label.set — missing required fields', () => {
  it('throws when fileId is absent', () => {
    const { db } = makeRecordingDb()
    expect(() => buildEventProjectionStmts(db, makeEvent('x', { fileId: null as unknown as string }), [])).toThrow(/missing fileId/)
  })

  it('throws when cellId is absent', () => {
    const { db } = makeRecordingDb()
    expect(() => buildEventProjectionStmts(db, makeEvent('x', { cellId: null as unknown as string }), [])).toThrow(/missing.*cellId/)
  })
})
