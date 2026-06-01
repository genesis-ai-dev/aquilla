import { describe, it, expect } from 'vitest'
import {
  serializeRealtimeMessage,
  parseRealtimeMessage,
  PROJECTION_TABLES,
} from '../events/realtime'
import type { RealtimeMessage, ProjectionTable } from '../events/realtime'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const eventMsg: RealtimeMessage = {
  v: 1,
  t: 'event',
  id: '01900000-0000-7000-0000-000000000001',
  kind: 'target.cell.commit',
  project: 'proj-a',
  file: 'file-x',
  cell: 'cell-1',
  ts: 1700000000000,
}

const eventMsgNoOptionals: RealtimeMessage = {
  v: 1,
  t: 'event',
  id: '01900000-0000-7000-0000-000000000002',
  kind: 'file.create',
  project: 'proj-b',
  ts: 1700000001000,
}

const dirtyMsg: RealtimeMessage = {
  v: 1,
  t: 'projection.dirty',
  project: 'proj-a',
  file: 'file-x',
  tables: ['cells', 'cell_validators'],
}

const dirtyMsgNoFile: RealtimeMessage = {
  v: 1,
  t: 'projection.dirty',
  project: 'proj-b',
  tables: ['events', 'files'],
}

// ---------------------------------------------------------------------------
// serializeRealtimeMessage
// ---------------------------------------------------------------------------

describe('serializeRealtimeMessage', () => {
  it('round-trips an event message through JSON.parse', () => {
    const raw = serializeRealtimeMessage(eventMsg)
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual(eventMsg)
  })

  it('round-trips a projection.dirty message through JSON.parse', () => {
    const raw = serializeRealtimeMessage(dirtyMsg)
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual(dirtyMsg)
  })

  it('omits undefined optional fields (file, cell) from wire format', () => {
    const raw = serializeRealtimeMessage(eventMsgNoOptionals)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect('file' in parsed).toBe(false)
    expect('cell' in parsed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseRealtimeMessage — happy paths
// ---------------------------------------------------------------------------

describe('parseRealtimeMessage — valid inputs', () => {
  it('round-trips an event message with all optional fields', () => {
    const raw = serializeRealtimeMessage(eventMsg)
    const result = parseRealtimeMessage(raw)
    expect(result).toEqual(eventMsg)
  })

  it('round-trips an event message without optional fields', () => {
    const raw = serializeRealtimeMessage(eventMsgNoOptionals)
    const result = parseRealtimeMessage(raw)
    expect(result).toEqual(eventMsgNoOptionals)
  })

  it('round-trips a projection.dirty message with file', () => {
    const raw = serializeRealtimeMessage(dirtyMsg)
    const result = parseRealtimeMessage(raw)
    expect(result).toEqual(dirtyMsg)
  })

  it('round-trips a projection.dirty message without file (project scope)', () => {
    const raw = serializeRealtimeMessage(dirtyMsgNoFile)
    const result = parseRealtimeMessage(raw)
    expect(result).toEqual(dirtyMsgNoFile)
  })

  it('returns the discriminated type t=event', () => {
    const result = parseRealtimeMessage(serializeRealtimeMessage(eventMsg))
    expect(result?.t).toBe('event')
  })

  it('returns the discriminated type t=projection.dirty', () => {
    const result = parseRealtimeMessage(serializeRealtimeMessage(dirtyMsg))
    expect(result?.t).toBe('projection.dirty')
  })

  it('coerces non-string file/cell fields to undefined for event', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 'x', kind: 'cell.commit', project: 'p', ts: 1, file: 42, cell: null })
    const result = parseRealtimeMessage(raw)
    expect(result).not.toBeNull()
    if (result && result.t === 'event') {
      expect(result.file).toBeUndefined()
      expect(result.cell).toBeUndefined()
    }
  })

  it('coerces non-string file field to undefined for projection.dirty', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: ['cells'], file: 99 })
    const result = parseRealtimeMessage(raw)
    expect(result).not.toBeNull()
    if (result && result.t === 'projection.dirty') {
      expect(result.file).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// parseRealtimeMessage — null cases
// ---------------------------------------------------------------------------

describe('parseRealtimeMessage — invalid inputs return null', () => {
  it('returns null for non-JSON input', () => {
    expect(parseRealtimeMessage('not json')).toBeNull()
  })

  it('returns null for a JSON string (not an object)', () => {
    expect(parseRealtimeMessage('"hello"')).toBeNull()
  })

  it('returns null for a JSON number', () => {
    expect(parseRealtimeMessage('42')).toBeNull()
  })

  it('returns null for JSON null', () => {
    expect(parseRealtimeMessage('null')).toBeNull()
  })

  it('returns null for a JSON array', () => {
    expect(parseRealtimeMessage('[]')).toBeNull()
  })

  it('returns null when v is missing', () => {
    const raw = JSON.stringify({ t: 'event', id: 'x', kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when v is wrong (v: 2)', () => {
    const raw = JSON.stringify({ v: 2, t: 'event', id: 'x', kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when v is a string "1" instead of number 1', () => {
    const raw = JSON.stringify({ v: '1', t: 'event', id: 'x', kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for unknown t value', () => {
    const raw = JSON.stringify({ v: 1, t: 'unknown.type', project: 'p' })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when t is missing entirely', () => {
    const raw = JSON.stringify({ v: 1, id: 'x', kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  // --- event-specific missing required fields ---

  it('returns null for event missing id', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for event missing kind', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 'x', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for event missing project', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 'x', kind: 'cell.commit', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for event missing ts', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 'x', kind: 'cell.commit', project: 'p' })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for event where ts is a string', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 'x', kind: 'cell.commit', project: 'p', ts: '1700000000000' })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for event where id is a number', () => {
    const raw = JSON.stringify({ v: 1, t: 'event', id: 123, kind: 'cell.commit', project: 'p', ts: 1 })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  // --- projection.dirty-specific missing required fields ---

  it('returns null for projection.dirty missing project', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', tables: ['cells'] })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null for projection.dirty missing tables', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p' })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when tables is not an array', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: 'cells' })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when tables contains non-string elements', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: ['cells', 42] })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when tables contains an object element', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: [{}] })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when tables is null', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: null })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })

  it('returns null when tables contains a string that is not a known ProjectionTable', () => {
    const raw = JSON.stringify({ v: 1, t: 'projection.dirty', project: 'p', tables: ['cells', 'fictional_table'] })
    expect(parseRealtimeMessage(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PROJECTION_TABLES sanity — Set size must match union arity
// ---------------------------------------------------------------------------

describe('PROJECTION_TABLES', () => {
  it('contains exactly 10 entries, matching the ProjectionTable union arity', () => {
    // If you add a new ProjectionTable variant, update PROJECTION_TABLES too.
    // This test catches the drift.
    const expectedArity = 10 // events | cells | files | cell_validators | cell_waivers | cell_audio | comments | cell_backtranslations | assignments | assignment_cells
    expect(PROJECTION_TABLES.size).toBe(expectedArity)
  })
})
