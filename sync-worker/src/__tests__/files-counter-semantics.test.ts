// AQU-268 — Characterization tests: freeze files.filled_count / approved_count
// counter semantics as of today so later counter changes are intentional.
//
// Covers (audit F-B1 / §3.5 §3.6):
//   - files.filled_count tracks target cells with non-empty trimmed content
//   - files.approved_count tracks target cells where validated=1
//   - Both are full recomputes (not incremental deltas) on each commit / validate
//   - cell_count is the number of distinct cell_ids across source + target
//
// Source: event-projection.ts fileCountersRecomputeStmt

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import {
  fileCountersRecomputeStmt,
  projectFileCountersRecomputeStmt,
} from '../events/event-projection'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'counter-char-secret'
const PROJECT = 'proj-ctr'
const FILE = 'file-ctr'

async function token(role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    role,
    username,
  } as any)
}

function env(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function post(db: AquillaDb, events: RawEvent[], tok: string) {
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ events }),
    }),
    env(db),
  )
  return res!.json() as Promise<{ accepted: unknown[]; rejected: unknown[] }>
}

async function readFileCounts(db: AquillaDb) {
  const row = await db
    .prepare(
      `SELECT cell_count, filled_count, approved_count, word_count
       FROM files WHERE id = ? AND project_id = ?`,
    )
    .bind(FILE, PROJECT)
    .first<{
      cell_count: number
      filled_count: number
      approved_count: number
      word_count: number
    }>()
  return row
}

async function seedFile(db: AquillaDb) {
  const ownerTok = await token(700, 'owner')
  const fileEvt: RawEvent<'file.create'> = {
    id: 'evt-ctr-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: undefined,
    parentId: null,
    author: 'owner',
    payload: { name: 'Counter Test File', fileType: 'codex' },
    clientTs: 0,
  }
  const r = await post(db, [fileEvt], ownerTok)
  expect(r.rejected).toHaveLength(0)
}

async function commitCell(
  db: AquillaDb,
  cellId: string,
  evtId: string,
  value: string,
  author = 'alice',
  parentId: string | null = null,
) {
  const tok = await token(400, author)
  const evt: RawEvent<'target.cell.commit'> = {
    id: evtId,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId,
    author,
    payload: { value, valueHtml: `<p>${value}</p>` },
    clientTs: 100,
  }
  const r = await post(db, [evt], tok)
  expect(r.rejected, `commit ${evtId} should succeed`).toHaveLength(0)
}

async function validateCell(
  db: AquillaDb,
  cellId: string,
  evtId: string,
  parentId: string,
  validator: string,
) {
  const tok = await token(300, validator)
  const evt: RawEvent<'cell.validate'> = {
    id: evtId,
    schemaVersion: 1,
    kind: 'cell.validate',
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId,
    author: validator,
    payload: { editEventId: parentId },
    clientTs: 200,
  }
  const r = await post(db, [evt], tok)
  expect(r.rejected, `validate ${evtId} should succeed`).toHaveLength(0)
}

// ── filled_count ──────────────────────────────────────────────────────────

describe('files.filled_count — target cells with non-empty trimmed content', () => {
  it('is 0 after file creation (no cells yet)', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(0)
  })

  it('increments to 1 after a target.cell.commit with non-empty value', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-a', 'evt-ctr-commit-a', 'translation text')
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(1)
  })

  it('does NOT count whitespace-only cells as filled', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-ws', 'evt-ctr-commit-ws', '   ')
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(0)
  })

  it('counts multiple filled target cells independently', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-1', 'evt-ctr-c1', 'first')
    await commitCell(db, 'cell-2', 'evt-ctr-c2', 'second')
    await commitCell(db, 'cell-3', 'evt-ctr-c3', 'third')
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(3)
  })

  it('overwriting a cell with empty content reduces filled_count', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-a', 'evt-ctr-fill', 'has text')
    // Overwrite with empty — parentId must be the prior commit to win the AD-2 chain slot
    await commitCell(db, 'cell-a', 'evt-ctr-empty', '', 'alice', 'evt-ctr-fill')
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(0)
  })

  it('is a full recompute — overwriting nonempty→nonempty keeps count=1', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-a', 'evt-ctr-fill-v1', 'version one')
    // parentId = v1 to win the AD-2 chain slot
    await commitCell(db, 'cell-a', 'evt-ctr-fill-v2', 'version two', 'alice', 'evt-ctr-fill-v1')
    const counts = await readFileCounts(db)
    // full recompute, not double-increment
    expect(Number(counts?.filled_count)).toBe(1)
  })
})

// ── approved_count ────────────────────────────────────────────────────────

describe('files.approved_count — target cells with validated=1', () => {
  it('is 0 after file creation', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    const counts = await readFileCounts(db)
    expect(Number(counts?.approved_count)).toBe(0)
  })

  it('increments to 1 after a single cell.validate', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-v1', 'evt-ctr-cv1', 'text to validate')
    await validateCell(db, 'cell-v1', 'evt-ctr-vv1', 'evt-ctr-cv1', 'bob')
    const counts = await readFileCounts(db)
    expect(Number(counts?.approved_count)).toBe(1)
  })

  it('counts validated cells across different cellIds', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-m1', 'evt-ctr-cm1', 'cell one')
    await commitCell(db, 'cell-m2', 'evt-ctr-cm2', 'cell two')
    await validateCell(db, 'cell-m1', 'evt-ctr-vm1', 'evt-ctr-cm1', 'bob')
    await validateCell(db, 'cell-m2', 'evt-ctr-vm2', 'evt-ctr-cm2', 'carol')
    const counts = await readFileCounts(db)
    expect(Number(counts?.approved_count)).toBe(2)
  })

  it('drops approved_count when cell is edited (chain head advances, old validators stale)', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-e1', 'evt-ctr-ce1', 'original text')
    await validateCell(db, 'cell-e1', 'evt-ctr-ve1', 'evt-ctr-ce1', 'bob')

    // Verify it is 1 after validation
    const before = await readFileCounts(db)
    expect(Number(before?.approved_count)).toBe(1)

    // Author edits → chain head moves, old validator is stale
    // parentId = prior commit to win the AD-2 chain slot
    await commitCell(db, 'cell-e1', 'evt-ctr-ce1-v2', 'revised text', 'alice', 'evt-ctr-ce1')

    const after = await readFileCounts(db)
    expect(Number(after?.approved_count)).toBe(0)
  })
})

// ── cell_count ────────────────────────────────────────────────────────────

describe('files.cell_count — COUNT(DISTINCT cell_id) across source + target', () => {
  it('increments to 1 after a target cell commit', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-cnt-1', 'evt-ctr-cnt-c1', 'text')
    const counts = await readFileCounts(db)
    expect(Number(counts?.cell_count)).toBe(1)
  })

  it('is not double-counted for the same cell_id across multiple commits', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-cnt-same', 'evt-ctr-cnt-s1', 'v1')
    // parentId = s1 to win the AD-2 chain slot
    await commitCell(db, 'cell-cnt-same', 'evt-ctr-cnt-s2', 'v2', 'alice', 'evt-ctr-cnt-s1')
    const counts = await readFileCounts(db)
    // DISTINCT cell_id — still 1, not 2
    expect(Number(counts?.cell_count)).toBe(1)
  })
})

// AQU-1083 — the structural subset of the same three counters. Seeded straight
// into `cells` and run through the builder, because what is under test is the
// SQL, not the event route above it.
describe('files.structural_* — the heading/paratext subset (AQU-1083)', () => {
  const P = 'proj-struct'
  const F = 'file-struct'

  const source = (cellId: string, type: string | null) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'source',
    value: `s ${cellId}`, type, event_id: `s-${cellId}`, last_edit_at: 1,
    validated: 0, endorsement_count: 0, word_count: 2,
  })
  const target = (cellId: string, value: string, validated = 0) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'target',
    value, type: null, event_id: `t-${cellId}`, last_edit_at: 2,
    validated, endorsement_count: validated, word_count: value ? 1 : 0,
  })

  /** Two verses (one filled+validated, one empty) and two structural cells
   *  (one filled+validated, one empty), plus a typeless media row. */
  async function fixture() {
    return makeTestDb({
      files: [{ id: F, project_id: P, name: 'GEN', event_id: 'f-evt' }],
      cells: [
        source('v1', 'verse'), target('v1', 'uno', 1),
        source('v2', 'verse'), target('v2', ''),
        source('h1', 'heading'), target('h1', 'titulo', 1),
        source('h2', 'paratext'), target('h2', ''),
        source('m1', null), target('m1', 'media'),
      ],
    })
  }

  async function counts(db: AquillaDb) {
    return db
      .prepare(
        `SELECT cell_count, filled_count, approved_count,
                structural_cell_count, structural_filled_count, structural_approved_count
           FROM files WHERE id = ? AND project_id = ?`,
      )
      .bind(F, P)
      .first<Record<string, number>>()
  }

  it('counts the structural subset without disturbing the totals', async () => {
    const { db } = await fixture()
    await fileCountersRecomputeStmt(db, P, F, 99).run()
    const c = await counts(db)
    // Totals are unchanged by AQU-1083: five cells, three filled, two validated.
    expect(Number(c?.cell_count)).toBe(5)
    expect(Number(c?.filled_count)).toBe(3)
    expect(Number(c?.approved_count)).toBe(2)
    // Of those, the heading and the paratext row.
    expect(Number(c?.structural_cell_count)).toBe(2)
    expect(Number(c?.structural_filled_count)).toBe(1)
    expect(Number(c?.structural_approved_count)).toBe(1)
  })

  it('reads a cell\'s type from its SOURCE row, never its target', async () => {
    // Target rows carry no type at all, so a naive filter would find nothing
    // filled or approved — the whole point of resolving through the pair.
    const { db } = await fixture()
    await fileCountersRecomputeStmt(db, P, F, 99).run()
    const c = await counts(db)
    expect(Number(c?.structural_filled_count)).toBeGreaterThan(0)
  })

  it('leaves an untyped media cell out of the structural subset', async () => {
    // Media and cue imports write no type at all. They are content, and a
    // null-blind predicate would quietly drop them from the denominator.
    const { db } = await fixture()
    await fileCountersRecomputeStmt(db, P, F, 99).run()
    const c = await counts(db)
    expect(Number(c?.cell_count) - Number(c?.structural_cell_count)).toBe(3)
  })

  it('agrees with the per-project form the rebuild uses', async () => {
    // Three copies of this SQL used to exist and one had already drifted. A
    // rebuild that disagreed would silently restore headings to the totals of
    // a project that had excluded them.
    const { db } = await fixture()
    await fileCountersRecomputeStmt(db, P, F, 99).run()
    const perFile = await counts(db)
    await db.prepare(`UPDATE files SET structural_cell_count = 0, cell_count = 0`).run()
    await projectFileCountersRecomputeStmt(db, P, 99).run()
    expect(await counts(db)).toEqual(perFile)
  })

  it('zeroes a file whose cells have all gone', async () => {
    // Driven FROM files rather than from cells, so an emptied file is reset
    // rather than left holding its last known numbers — which is what the
    // rebuild depends on after it wipes the projection.
    const { db } = await fixture()
    await fileCountersRecomputeStmt(db, P, F, 99).run()
    await db.prepare(`DELETE FROM cells WHERE project_id = ?`).bind(P).run()
    await projectFileCountersRecomputeStmt(db, P, 99).run()
    const c = await counts(db)
    expect(Number(c?.cell_count)).toBe(0)
    expect(Number(c?.structural_cell_count)).toBe(0)
  })
})
