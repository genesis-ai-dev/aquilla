// FRO-268 — Characterization tests: freeze files.filled_count / approved_count
// counter semantics as of today so later counter changes are intentional.
//
// Covers (audit F-B1 / §3.5 §3.6):
//   - files.filled_count tracks target cells with non-empty trimmed content
//   - files.approved_count tracks target cells where validated=1
//   - Both are full recomputes (not incremental deltas) on each commit / validate
//   - cell_count is COUNT(DISTINCT cell_id) across source + target
//
// Source: event-projection.ts fileCountersRecomputeStmt (lines 96-122)

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
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
) {
  const tok = await token(400, author)
  const evt: RawEvent<'target.cell.commit'> = {
    id: evtId,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
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
    // Overwrite with empty
    await commitCell(db, 'cell-a', 'evt-ctr-empty', '', 'alice')
    const counts = await readFileCounts(db)
    expect(Number(counts?.filled_count)).toBe(0)
  })

  it('is a full recompute — overwriting nonempty→nonempty keeps count=1', async () => {
    const { db } = await makeTestDb()
    await seedFile(db)
    await commitCell(db, 'cell-a', 'evt-ctr-fill-v1', 'version one')
    await commitCell(db, 'cell-a', 'evt-ctr-fill-v2', 'version two', 'alice')
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
    await commitCell(db, 'cell-e1', 'evt-ctr-ce1-v2', 'revised text', 'alice')

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
    await commitCell(db, 'cell-cnt-same', 'evt-ctr-cnt-s2', 'v2', 'alice')
    const counts = await readFileCounts(db)
    // DISTINCT cell_id — still 1, not 2
    expect(Number(counts?.cell_count)).toBe(1)
  })
})
