// Tests for handleAssignmentEvent — the assignment.* projection (Phase C).
//
// 1. assignment.create (books)    : inserts the assignments row + resolves ALL
//    source cells in the assigned file into assignment_cells; cells_total set.
// 2. assignment.create (chapters) : resolves the cells the plan board counts in
//    the chapter (AQU-1493): its verses, its headings (which count with the
//    verse below them) and lines added in it (with the line above them),
//    excluding other chapters / books; one statement per file.
// 3. assignment.reassign          : updates assignee_user_id.
// 4. assignment.unassign          : sets unassigned_at (soft close; row kept).
// 5. Role gate                    : a reviewer (300) token is rejected — the
//    family requires project_lead (500).

import { describe, it, expect } from 'vitest'
import { handleAssignmentEvent } from '../events/handlers/assignment-events'
import { fullProgressRecomputeStmts } from '../events/progress-projection'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { type CellRow } from './helpers/in-memory-db'
import { makeTestDb } from './helpers/pg-test-db'
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
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-1',
      scopeKind: 'books',
      scope: [{ fileId: 'file-gen' }],
      scopeLabel: 'Genesis',
      assigneeUserId: 42,
      deadline: '2026-06-30',
      note: 'Please start here',
    })

    const result = handleAssignmentEvent(db, authed, 2000, 1)
    await db.batch(result.stmts)

    const t = await snapshot()
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

describe('assignment.create — cells scope (AQU-1628)', () => {
  it('resolves exactly the named source cells, not the whole file', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-sel',
      scopeKind: 'cells',
      scope: [{ fileId: 'file-gen', cellIds: ['g-1-2', 'g-2-1'] }],
      scopeLabel: '2 verse(s)',
      assigneeUserId: 42,
    })

    const result = handleAssignmentEvent(db, authed, 2000, 1)
    await db.batch(result.stmts)

    const t = await snapshot()
    const cells = t.assignment_cells.filter((c) => c.assignment_id === 'as-sel')
    // g-1-1 is in the file but was NOT selected; the file-exo cell and the
    // same-cell target row are excluded as in every other scope.
    expect(cells.map((c) => c.cell_id).sort()).toEqual(['g-1-2', 'g-2-1'])
    const row = t.assignments.find((a) => a.assignment_id === 'as-sel')
    expect(row!.scope_kind).toBe('cells')
    expect(row!.cells_total).toBe(2)
  })

  it('counts only the ids that still exist, so cells_total matches what was assigned', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-gone',
      scopeKind: 'cells',
      scope: [{ fileId: 'file-gen', cellIds: ['g-1-1', 'deleted-since'] }],
      scopeLabel: '2 verse(s)',
      assigneeUserId: 42,
    })

    await db.batch(handleAssignmentEvent(db, authed, 2000, 1).stmts)

    const t = await snapshot()
    expect(
      t.assignment_cells.filter((c) => c.assignment_id === 'as-gone').map((c) => c.cell_id),
    ).toEqual(['g-1-1'])
    expect(t.assignments.find((a) => a.assignment_id === 'as-gone')!.cells_total).toBe(1)
  })

  it('ignores a cell id from another file, since the entry names its own file', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-xfile',
      scopeKind: 'cells',
      scope: [{ fileId: 'file-gen', cellIds: ['g-1-1', 'e-1-1'] }],
      scopeLabel: '2 verse(s)',
      assigneeUserId: 42,
    })

    await db.batch(handleAssignmentEvent(db, authed, 2000, 1).stmts)

    const t = await snapshot()
    expect(
      t.assignment_cells.filter((c) => c.assignment_id === 'as-xfile').map((c) => c.cell_id),
    ).toEqual(['g-1-1'])
  })
})

describe('assignment.create — lane (AQU-538 §3.5)', () => {
  it('writes targetLang to assignments.target_lang', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-lane',
      scopeKind: 'books',
      scope: [{ fileId: 'file-gen' }],
      scopeLabel: 'Genesis',
      assigneeUserId: 42,
      targetLang: 'es',
    })

    const result = handleAssignmentEvent(db, authed, 2100, 2)
    await db.batch(result.stmts)

    const row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-lane')
    expect(row!.target_lang).toBe('es')
  })

  it('writes lane_id from the matching target lane when lanes exist', async () => {
    const { db, snapshot } = await makeTestDb({
      cells: seededCells(),
      lanes: [
        { id: 'lane-es', project_id: 'proj-1', role: 'target', name: 'Spanish', lang_code: 'es', legacy_tag: 'es' },
      ],
    })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-lane-id',
      scopeKind: 'books',
      scope: [{ fileId: 'file-gen' }],
      scopeLabel: 'Genesis',
      assigneeUserId: 42,
      targetLang: 'es',
    })

    await db.batch(handleAssignmentEvent(db, authed, 2100, 2).stmts)

    const row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-lane-id')
    expect(row!.target_lang).toBe('es')
    expect(row!.lane_id).toBe('lane-es')
  })

  it('defaults target_lang to the empty string when the lane is absent', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-nolane',
      scopeKind: 'books',
      scope: [{ fileId: 'file-gen' }],
      scopeLabel: 'Genesis',
      assigneeUserId: 42,
    })

    const result = handleAssignmentEvent(db, authed, 2200, 3)
    await db.batch(result.stmts)

    const row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-nolane')
    expect(row!.target_lang).toBe('')
  })

  it('assignment.reassign re-pins the lane when targetLang is provided, and leaves it when absent', async () => {
    const { db, snapshot } = await makeTestDb({
      assignments: [{ ...seededAssignment({ assignment_id: 'as-re', assignee_user_id: 1 }), target_lang: 'es' }],
    })

    // Plain reassign (no targetLang) leaves the stored lane untouched.
    const plain = await authorizeAssignment('assignment.reassign', {
      assignmentId: 'as-re',
      assigneeUserId: 55,
    })
    await db.batch(handleAssignmentEvent(db, plain, 4100, 4).stmts)
    let row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-re')
    expect(row!.assignee_user_id).toBe(55)
    expect(row!.target_lang).toBe('es')

    // A reassign carrying a lane re-pins it.
    const repin = await authorizeAssignment('assignment.reassign', {
      assignmentId: 'as-re',
      assigneeUserId: 55,
      targetLang: 'fr',
    })
    await db.batch(handleAssignmentEvent(db, repin, 4200, 5).stmts)
    row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-re')
    expect(row!.target_lang).toBe('fr')
  })
})

describe('assignment.create — chapter scope', () => {
  it('resolves only the cells whose canonical_ref matches the chapter', async () => {
    const { db, snapshot } = await makeTestDb({ cells: seededCells() })
    const authed = await authorizeAssignment('assignment.create', {
      assignmentId: 'as-2',
      scopeKind: 'chapters',
      scope: [{ fileId: 'file-gen', chapter: 'GEN 1' }],
      scopeLabel: 'Genesis 1',
      assigneeUserId: 42,
    })

    const result = handleAssignmentEvent(db, authed, 3000, 6)
    await db.batch(result.stmts)

    const t = await snapshot()
    const cells = t.assignment_cells.filter((c) => c.assignment_id === 'as-2')
    // GEN 1:1 and GEN 1:2 only — NOT GEN 2:1 (the ':' anchors the boundary).
    expect(cells.map((c) => c.cell_id).sort()).toEqual(['g-1-1', 'g-1-2'])
    expect(t.assignments.find((a) => a.assignment_id === 'as-2')!.cells_total).toBe(2)
  })
})

// AQU-1493: Jonah 1-3 as the editor orders it (each line anchored on the one
// above), the way a helloao import lands: a heading with no reference opens
// every chapter, and one line was added by hand under JON 2:1.
function jonahChain(): CellRow[] {
  const lines: Array<{ id: string; ref?: string; type?: string }> = [
    { id: 'h1', type: 'heading' }, // "Jonah Flees from the LORD" -> JON 1
    { id: 'j11', ref: 'JON 1:1' },
    { id: 'j12', ref: 'JON 1:2' },
    { id: 'h2', type: 'heading' }, // "Jonah's Prayer" -> JON 2
    { id: 'j21', ref: 'JON 2:1' },
    { id: 'x1' }, // added in the editor -> the line above: JON 2
    { id: 'j22', ref: 'JON 2:2' },
    { id: 'h3', type: 'heading' }, // "Jonah Goes to Nineveh" -> JON 3
    { id: 'j31', ref: 'JON 3:1' },
  ]
  return lines.map((l, i) => ({
    project_id: 'proj-1',
    file_id: 'file-gen',
    cell_id: l.id,
    side: 'source',
    target_lang: '',
    canonical_ref: l.ref ?? null,
    type: l.type ?? null,
    anchor_cell_id: i === 0 ? null : lines[i - 1].id,
    value: `source ${l.id}`,
    event_id: `ev-${l.id}`,
    last_editor: 'importer',
    last_edit_at: 1,
    validated: 0,
    word_count: 1,
  })) as unknown as CellRow[]
}

async function assignedCells(scope: Array<{ fileId: string; chapter?: string }>, cells: CellRow[]) {
  const { db, snapshot } = await makeTestDb({ cells })
  const authed = await authorizeAssignment('assignment.create', {
    assignmentId: 'as-ch',
    scopeKind: 'chapters',
    scope,
    scopeLabel: 'Jonah',
    assigneeUserId: 42,
  })
  const result = handleAssignmentEvent(db, authed, 3000, 6)
  await db.batch(result.stmts)
  const t = await snapshot()
  return {
    result,
    ids: t.assignment_cells.filter((c) => c.assignment_id === 'as-ch').map((c) => c.cell_id).sort(),
    total: t.assignments.find((a) => a.assignment_id === 'as-ch')!.cells_total,
  }
}

describe('assignment.create — chapter scope follows the board (AQU-1493)', () => {
  it("gives the chapter's opening heading and the line added in it, not the next chapter's heading", async () => {
    const { ids, total } = await assignedCells([{ fileId: 'file-gen', chapter: 'JON 2' }], jonahChain())
    // h2 opens JON 2 (the verse below it); x1 sits under 2:1 (the line above).
    // h3, right after 2:2, opens JON 3 and is not Carol's.
    expect(ids).toEqual(['h2', 'j21', 'j22', 'x1'])
    expect(total).toBe(4)
  })

  it("gives the first chapter the heading at the top of the file", async () => {
    const { ids } = await assignedCells([{ fileId: 'file-gen', chapter: 'JON 1' }], jonahChain())
    expect(ids).toEqual(['h1', 'j11', 'j12'])
  })

  it('resolves several chapters of one file in a single statement', async () => {
    const { result, ids, total } = await assignedCells(
      [
        { fileId: 'file-gen', chapter: 'JON 1' },
        { fileId: 'file-gen', chapter: 'JON 3' },
      ],
      jonahChain(),
    )
    expect(ids).toEqual(['h1', 'h3', 'j11', 'j12', 'j31'])
    expect(total).toBe(5)
    // events row, assignments row, ONE resolution for file-gen, cells_total.
    expect(result.stmts).toHaveLength(4)
  })

  it("gives each chapter exactly the cells the board counts in it", async () => {
    const { db } = await makeTestDb({ cells: jonahChain() })
    for (const stmt of fullProgressRecomputeStmts(db, 'proj-1', 'file-gen', 1)) await stmt.run()
    const board = await db
      .prepare(
        `SELECT section_key, total_count FROM file_section_progress
          WHERE project_id = 'proj-1' AND file_id = 'file-gen' AND scope = 'section' AND target_lang = ''
          ORDER BY section_key`,
      )
      .all<{ section_key: string; total_count: number }>()
    const rows = board.results ?? []
    expect(rows.map((r) => r.section_key)).toEqual(['JON 1', 'JON 2', 'JON 3'])
    for (const r of rows) {
      const { total } = await assignedCells([{ fileId: 'file-gen', chapter: r.section_key }], jonahChain())
      expect([r.section_key, total]).toEqual([r.section_key, r.total_count])
    }
  })

  it('keeps "GEN 1" out of "GEN 11"', async () => {
    const base = seededCells()[0]
    const { ids } = await assignedCells([{ fileId: 'file-gen', chapter: 'GEN 1' }], [
      ...seededCells(),
      { ...base, cell_id: 'g-11-1', canonical_ref: 'GEN 11:1' },
    ] as CellRow[])
    expect(ids).toEqual(['g-1-1', 'g-1-2'])
  })

  it('resolves chapters of two files with one statement each', async () => {
    const { result, ids } = await assignedCells(
      [
        { fileId: 'file-gen', chapter: 'GEN 2' },
        { fileId: 'file-exo', chapter: 'EXO 1' },
        { fileId: 'file-gen', chapter: 'GEN 1' },
      ],
      seededCells(),
    )
    expect(ids).toEqual(['e-1-1', 'g-1-1', 'g-1-2', 'g-2-1'])
    expect(result.stmts).toHaveLength(5)
  })
})

describe('assignment.reassign', () => {
  it('updates assignee_user_id', async () => {
    const { db, snapshot } = await makeTestDb({ assignments: [seededAssignment({ assignment_id: 'as-3', assignee_user_id: 1 })] })
    const authed = await authorizeAssignment('assignment.reassign', {
      assignmentId: 'as-3',
      assigneeUserId: 99,
    })

    const result = handleAssignmentEvent(db, authed, 4000, 7)
    await db.batch(result.stmts)

    expect((await snapshot()).assignments.find((a) => a.assignment_id === 'as-3')!.assignee_user_id).toBe(99)
  })
})

describe('assignment.unassign', () => {
  it('sets unassigned_at (soft close, row kept)', async () => {
    const { db, snapshot } = await makeTestDb({ assignments: [seededAssignment({ assignment_id: 'as-4' })] })
    const authed = await authorizeAssignment('assignment.unassign', { assignmentId: 'as-4' })

    const result = handleAssignmentEvent(db, authed, 5000, 8)
    await db.batch(result.stmts)

    const row = (await snapshot()).assignments.find((a) => a.assignment_id === 'as-4')
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
