// Tests for handleAssignmentEvent — the assignment.* projection (Phase C).
//
// 1. assignment.create (books)    : inserts the assignments row + resolves ALL
//    source cells in the assigned file into assignment_cells; cells_total set.
// 2. assignment.create (chapters) : resolves only the cells whose canonical_ref
//    matches the chapter (LIKE 'GEN 1:%'), excluding other chapters / books.
// 3. assignment.reassign          : updates assignee_user_id.
// 4. assignment.unassign          : sets unassigned_at (soft close; row kept).
// 5. Role gate                    : a reviewer (300) token is rejected — the
//    family requires project_lead (500).

import { describe, it, expect } from 'vitest'
import { handleAssignmentEvent } from '../events/handlers/assignment-events'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { makeInMemoryD1, type CellRow } from './helpers/d1-fake'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'test-secret'

// Build an AuthorizedEvent the same way the route does (authorize() under a
// file-scoped sync token). Assignment events carry a fileId on the envelope
// for auth/routing; the assigned scope lives in the payload.
async function authorizeAssignment<K extends EventKind>(
  kind: K,
  payload: unknown,
  { role = 500, userId = 7 }: { role?: number; userId?: number } = {},
) {
  const raw = {
    id: 'evt-00000000-0000-7000-0000-0000000000aa',
    schemaVersion: 1,
    kind,
    projectId: 'proj-1',
    fileId: 'file-gen',
    parentId: null,
    author: 'manager',
    payload,
    clientTs: 1000,
  } as unknown as RawEvent<K>
  const token = await makeTestToken(SECRET, {
    userId,
    username: 'manager',
    projectId: 'proj-1',
    fileId: 'file-gen',
    role,
  })
  const res = await authorize(token, raw, SECRET)
  if (!res.ok) throw new Error(`authorize failed: ${res.status} ${res.reason}`)
  return res.event
}

// 3 source cells across 2 chapters in file-gen, plus a same-cell target row and
// a cell in a different file — both must be excluded by the resolver.
function seededCells(): CellRow[] {
  const base = {
    project_id: 'proj-1',
    value: 'x',
    event_id: 'e',
    last_editor: 'importer',
    last_edit_at: 1,
    validated: 0,
    word_count: 1,
  }
  return [
    { ...base, file_id: 'file-gen', cell_id: 'g-1-1', side: 'source', canonical_ref: 'GEN 1:1' },
    { ...base, file_id: 'file-gen', cell_id: 'g-1-2', side: 'source', canonical_ref: 'GEN 1:2' },
    { ...base, file_id: 'file-gen', cell_id: 'g-2-1', side: 'source', canonical_ref: 'GEN 2:1' },
    { ...base, file_id: 'file-gen', cell_id: 'g-1-1', side: 'target', canonical_ref: null },
    { ...base, file_id: 'file-exo', cell_id: 'e-1-1', side: 'source', canonical_ref: 'EXO 1:1' },
  ] as CellRow[]
}

function seededAssignment(over: { assignment_id: string; assignee_user_id?: number }) {
  return {
    assignment_id: over.assignment_id,
    project_id: 'proj-1',
    assignee_user_id: over.assignee_user_id ?? 1,
    scope_kind: 'books',
    scope_label: 'Genesis',
    cells_total: 3,
    deadline: null,
    note: null,
    created_by: 7,
    created_at: 1000,
    unassigned_at: null,
    completed_at: null,
  }
}

describe('assignment.create — book scope', () => {
  it('inserts the assignments row and resolves every source cell in the file', async () => {
    const db = makeInMemoryD1({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-1',
      scopeKind: 'books',
      scope: [{ fileId: 'file-gen' }],
      scopeLabel: 'Genesis',
      assigneeUserId: 42,
      deadline: '2026-06-30',
      note: 'Please start here',
    })

    const result = handleAssignmentEvent(db, authed, 2000)
    await db.batch(result.stmts)

    const t = db._tables()
    const row = t.assignments.find((a) => a.assignment_id === 'as-1')
    expect(row).toBeDefined()
    expect(row!.project_id).toBe('proj-1')
    expect(row!.assignee_user_id).toBe(42)
    expect(row!.scope_kind).toBe('books')
    expect(row!.scope_label).toBe('Genesis')
    expect(row!.deadline).toBe('2026-06-30')
    expect(row!.note).toBe('Please start here')
    expect(row!.created_by).toBe(7)
    expect(row!.created_at).toBe(2000)
    expect(row!.unassigned_at).toBeNull()

    // 3 source cells in file-gen; the target row + the file-exo row excluded.
    const cells = t.assignment_cells.filter((c) => c.assignment_id === 'as-1')
    expect(cells.map((c) => c.cell_id).sort()).toEqual(['g-1-1', 'g-1-2', 'g-2-1'])
    expect(row!.cells_total).toBe(3)

    expect(result.dirtyTables).toEqual(
      expect.arrayContaining(['events', 'assignments', 'assignment_cells']),
    )
  })
})

describe('assignment.create — chapter scope', () => {
  it('resolves only the cells whose canonical_ref matches the chapter', async () => {
    const db = makeInMemoryD1({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-2',
      scopeKind: 'chapters',
      scope: [{ fileId: 'file-gen', chapter: 'GEN 1' }],
      scopeLabel: 'Genesis 1',
      assigneeUserId: 42,
    })

    const result = handleAssignmentEvent(db, authed, 3000)
    await db.batch(result.stmts)

    const t = db._tables()
    const cells = t.assignment_cells.filter((c) => c.assignment_id === 'as-2')
    // GEN 1:1 and GEN 1:2 only — NOT GEN 2:1 (the ':' anchors the boundary).
    expect(cells.map((c) => c.cell_id).sort()).toEqual(['g-1-1', 'g-1-2'])
    expect(t.assignments.find((a) => a.assignment_id === 'as-2')!.cells_total).toBe(2)
  })
})

describe('assignment.reassign', () => {
  it('updates assignee_user_id', async () => {
    const db = makeInMemoryD1({ assignments: [seededAssignment({ assignment_id: 'as-3', assignee_user_id: 1 })] })
    const authed = await authorizeAssignment('assignment.reassign', {
      assignmentId: 'as-3',
      assigneeUserId: 99,
    })

    const result = handleAssignmentEvent(db, authed, 4000)
    await db.batch(result.stmts)

    expect(db._tables().assignments.find((a) => a.assignment_id === 'as-3')!.assignee_user_id).toBe(99)
  })
})

describe('assignment.unassign', () => {
  it('sets unassigned_at (soft close, row kept)', async () => {
    const db = makeInMemoryD1({ assignments: [seededAssignment({ assignment_id: 'as-4' })] })
    const authed = await authorizeAssignment('assignment.unassign', { assignmentId: 'as-4' })

    const result = handleAssignmentEvent(db, authed, 5000)
    await db.batch(result.stmts)

    const row = db._tables().assignments.find((a) => a.assignment_id === 'as-4')
    expect(row).toBeDefined() // row kept
    expect(row!.unassigned_at).toBe(5000)
  })
})

describe('assignment role gate', () => {
  it('rejects a reviewer (300) — assignment.create requires project_lead (500)', async () => {
    const raw = {
      id: 'evt-00000000-0000-7000-0000-0000000000bb',
      schemaVersion: 1,
      kind: 'assignment.create',
      projectId: 'proj-1',
      fileId: 'file-gen',
      parentId: null,
      author: 'reviewer',
      payload: {
        assignmentId: 'as-x',
        scopeKind: 'books',
        scope: [{ fileId: 'file-gen' }],
        scopeLabel: 'Genesis',
        assigneeUserId: 42,
      },
      clientTs: 1000,
    } as unknown as RawEvent<'assignment.create'>
    const token = await makeTestToken(SECRET, { projectId: 'proj-1', fileId: 'file-gen', role: 300 })
    const res = await authorize(token, raw, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })
})
