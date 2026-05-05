import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProjectionDirtyCoalescer } from '../events/coalescer'
import type { RealtimeMessage, ProjectionTable } from '../events/realtime'

type DirtyMsg = Extract<RealtimeMessage, { t: 'projection.dirty' }>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCoalescer(
  emitFn: (msg: DirtyMsg) => void,
  windowMs = 100,
): ProjectionDirtyCoalescer {
  return new ProjectionDirtyCoalescer({
    windowMs,
    emit: emitFn,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProjectionDirtyCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // Basic timer behavior
  // -------------------------------------------------------------------------

  it('fires emit once after windowMs for a single signal', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    expect(emitted).toHaveLength(0) // not yet

    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      v: 1,
      t: 'projection.dirty',
      project: 'proj-a',
      file: 'file-x',
      tables: ['cells'],
    })
  })

  it('does not fire before the window elapses', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m), 200)

    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(199)
    expect(emitted).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(emitted).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Merging within the same scope
  // -------------------------------------------------------------------------

  it('coalesces multiple signals to the same (project, file) scope into one emit', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.signalDirty('proj-a', 'file-x', ['cell_validators'])
    c.signalDirty('proj-a', 'file-x', ['cells']) // duplicate — should not double-add

    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(1)
  })

  it('merges tables from multiple signals to the same scope', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.signalDirty('proj-a', 'file-x', ['cell_validators'])

    vi.advanceTimersByTime(100)
    const tables = emitted[0].tables.slice().sort()
    expect(tables).toEqual(['cell_validators', 'cells'].sort())
  })

  it('does not start a second timer while one is already pending', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(50)
    c.signalDirty('proj-a', 'file-x', ['files']) // mid-window — no new timer

    vi.advanceTimersByTime(50) // completes the original 100ms window
    expect(emitted).toHaveLength(1)
    // Both tables merged
    expect(emitted[0].tables.sort()).toEqual(['cells', 'files'].sort())
  })

  // -------------------------------------------------------------------------
  // Multiple scopes
  // -------------------------------------------------------------------------

  it('emits once per scope when multiple scopes dirty within same window', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.signalDirty('proj-a', 'file-y', ['events'])
    c.signalDirty('proj-b', 'file-z', ['files'])

    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(3)
  })

  it('emits correct tables for each scope independently', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.signalDirty('proj-a', 'file-y', ['events'])

    vi.advanceTimersByTime(100)

    const byFile = Object.fromEntries(
      emitted.map((m) => [m.file, m.tables]),
    )
    expect(byFile['file-x']).toEqual(['cells'])
    expect(byFile['file-y']).toEqual(['events'])
  })

  // -------------------------------------------------------------------------
  // Project-level scope (file === undefined)
  // -------------------------------------------------------------------------

  it('project-level scope (file undefined) is separate from file-specific scopes', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', undefined, ['events'])   // project-level
    c.signalDirty('proj-a', 'file-x', ['cells'])     // file-specific

    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(2)

    const projectLevel = emitted.find((m) => m.file === undefined)
    const fileLevel = emitted.find((m) => m.file === 'file-x')
    expect(projectLevel).toBeDefined()
    expect(fileLevel).toBeDefined()
  })

  it('project-level scope omits the file key from the emitted message', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', undefined, ['events'])
    vi.advanceTimersByTime(100)

    expect(emitted).toHaveLength(1)
    expect('file' in emitted[0]).toBe(false)
  })

  it('file="*" and file=undefined produce distinct scopes (null-byte separator invariant)', () => {
    // scopeKey uses \0 as separator. undefined → `${project}\0`, file "*" →
    // `${project}\0*`. These are distinct keys, so the two signals produce
    // two separate emits. (With the old "|" separator, "|*" was ambiguous.)
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', undefined, ['events'])
    c.signalDirty('proj-a', '*', ['cells']) // different scope from undefined

    vi.advanceTimersByTime(100)
    // Two distinct scopes — two separate emits
    expect(emitted).toHaveLength(2)
    const projectLevel = emitted.find((m) => m.file === undefined)
    const starLevel = emitted.find((m) => m.file === '*')
    expect(projectLevel?.tables).toEqual(['events'])
    expect(starLevel?.tables).toEqual(['cells'])
  })

  // -------------------------------------------------------------------------
  // Manual flush()
  // -------------------------------------------------------------------------

  it('manual flush() emits immediately without waiting for the timer', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    expect(emitted).toHaveLength(0)

    c.flush()
    expect(emitted).toHaveLength(1)
  })

  it('manual flush() clears the pending timer so it does not double-emit', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.flush()                      // should cancel the timer
    vi.advanceTimersByTime(100)    // timer would have fired here if not cancelled
    expect(emitted).toHaveLength(1) // exactly one emit total
  })

  it('flush() on an empty coalescer does not emit', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.flush()
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Signal after flush starts a fresh cycle
  // -------------------------------------------------------------------------

  it('new signal after flush starts a new timer and emits again on schedule', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(100)   // first flush via timer
    expect(emitted).toHaveLength(1)

    c.signalDirty('proj-a', 'file-x', ['files'])
    expect(emitted).toHaveLength(1) // not yet
    vi.advanceTimersByTime(100)   // second window
    expect(emitted).toHaveLength(2)
    expect(emitted[1].tables).toEqual(['files'])
  })

  it('new signal after manual flush starts a new timer', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.flush()
    expect(emitted).toHaveLength(1)

    c.signalDirty('proj-a', 'file-x', ['events'])
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(2)
    expect(emitted[1].tables).toEqual(['events'])
  })

  // -------------------------------------------------------------------------
  // hasPending()
  // -------------------------------------------------------------------------

  it('hasPending() returns false when buffer is empty', () => {
    const c = makeCoalescer(() => {})
    expect(c.hasPending()).toBe(false)
  })

  it('hasPending() returns true after a signal before flush', () => {
    const c = makeCoalescer(() => {})
    c.signalDirty('proj-a', 'file-x', ['cells'])
    expect(c.hasPending()).toBe(true)
  })

  it('hasPending() returns false after timer-triggered flush', () => {
    const c = makeCoalescer(() => {})
    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(100)
    expect(c.hasPending()).toBe(false)
  })

  it('hasPending() returns false after manual flush()', () => {
    const c = makeCoalescer(() => {})
    c.signalDirty('proj-a', 'file-x', ['cells'])
    c.flush()
    expect(c.hasPending()).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Emitted message shape
  // -------------------------------------------------------------------------

  it('emitted message always has v: 1', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(100)

    expect(emitted[0].v).toBe(1)
  })

  it('emitted message always has t: projection.dirty', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    c.signalDirty('proj-a', 'file-x', ['cells'])
    vi.advanceTimersByTime(100)

    expect(emitted[0].t).toBe('projection.dirty')
  })

  it('tables in emitted message contain all unique tables from merged signals', () => {
    const emitted: DirtyMsg[] = []
    const c = makeCoalescer((m) => emitted.push(m))

    const allTables: ProjectionTable[] = ['events', 'cells', 'files', 'cell_validators']
    for (const t of allTables) {
      c.signalDirty('proj-a', 'file-x', [t])
    }

    vi.advanceTimersByTime(100)
    expect(emitted[0].tables.sort()).toEqual(allTables.slice().sort())
  })

  // -------------------------------------------------------------------------
  // Re-entrancy safety
  // -------------------------------------------------------------------------

  it('re-entrant signalDirty from within emit starts a fresh window, not lost', () => {
    // If emit() calls signalDirty() back into the coalescer, the snapshot-
    // then-clear pattern in flush() ensures the new signal lands in a fresh
    // window rather than being silently discarded by the buffer.clear().
    const emitted: DirtyMsg[] = []
    let reentered = false

    const c = makeCoalescer((m) => {
      emitted.push(m)
      if (!reentered) {
        reentered = true
        // Re-enter signalDirty during the flush emit call
        c.signalDirty('proj-a', 'file-x', ['files'])
      }
    })

    c.signalDirty('proj-a', 'file-x', ['cells'])

    // Fire the first window — emit runs, re-enters signalDirty
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].tables).toEqual(['cells'])

    // The re-entrant signal must have started a fresh timer
    expect(c.hasPending()).toBe(true)

    // Advance into the fresh window — second emit should fire
    vi.advanceTimersByTime(100)
    expect(emitted).toHaveLength(2)
    expect(emitted[1].tables).toEqual(['files'])
  })
})
