// FRO-268 — Characterization tests: freeze the validated-flip semantics as they
// exist TODAY so future changes (FRO-279) flip them intentionally.
//
// Key finding (audit F-B1):
//   `project_settings.validationCount` is NEVER read by sync-worker.  The
//   `cells.validated` flag is set to 1 as soon as COUNT(*) > 0 in
//   `cell_validators` for the current chain head — i.e., a SINGLE endorsement
//   marks the cell validated regardless of the project threshold.
//
//   event-projection.ts:480-487:
//     SET validated = (
//       SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
//       FROM cell_validators WHERE ... AND event_id = cells.event_id
//     )
//
// These tests document that current (wrong) behavior so a grep on
// "CHARACTERIZATION (audit F-B1)" surfaces every place to flip when FRO-279
// lands.

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

const SECRET = 'char-test-secret'

async function token(role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: 'proj-char',
    fileId: 'file-char',
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

/** Seed a project_settings row with the given JSON blob. */
async function setSettings(db: AquillaDb, settings: Record<string, unknown>) {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (project_id)
       DO UPDATE SET settings = excluded.settings, version = project_settings.version + 1`,
    )
    .bind('proj-char', JSON.stringify(settings))
    .run()
}

/** Seed a file row + a committed target cell authored by `author`. */
async function seedFileAndCell(db: AquillaDb, author = 'alice') {
  // owner creates the file
  const ownerTok = await token(700, 'owner')
  const fileEvt: RawEvent<'file.create'> = {
    id: 'evt-char-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: 'proj-char',
    fileId: 'file-char',
    cellId: undefined,
    parentId: null,
    author: 'owner',
    payload: { name: 'Characterization File', fileType: 'codex' },
    clientTs: 0,
  }
  const r1 = await post(db, [fileEvt], ownerTok)
  expect(r1.rejected, 'file.create should be accepted').toHaveLength(0)

  // author commits a target cell
  const authorTok = await token(400, author)
  const commitEvt: RawEvent<'target.cell.commit'> = {
    id: 'evt-char-commit',
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: 'proj-char',
    fileId: 'file-char',
    cellId: 'cell-char-1',
    parentId: null,
    author,
    payload: { value: 'translation text', valueHtml: '<p>translation text</p>' },
    clientTs: 100,
  }
  const r2 = await post(db, [commitEvt], authorTok)
  expect(r2.rejected, 'target.cell.commit should be accepted').toHaveLength(0)
}

/** Send a cell.validate event and return the resulting `cells.validated` value. */
async function validateAndRead(db: AquillaDb, validator: string, evtId: string) {
  const tok = await token(300, validator)
  const valEvt: RawEvent<'cell.validate'> = {
    id: evtId,
    schemaVersion: 1,
    kind: 'cell.validate',
    projectId: 'proj-char',
    fileId: 'file-char',
    cellId: 'cell-char-1',
    parentId: 'evt-char-commit',
    author: validator,
    payload: { editEventId: 'evt-char-commit' },
    clientTs: 200,
  }
  const res = await post(db, [valEvt], tok)
  expect(res.rejected, `validate by ${validator} should succeed`).toHaveLength(0)

  const row = await db
    .prepare(
      `SELECT validated FROM cells
       WHERE project_id = 'proj-char' AND file_id = 'file-char'
         AND cell_id = 'cell-char-1' AND side = 'target'`,
    )
    .first<{ validated: number | boolean }>()
  return row
}

// ── Core characterization: COUNT(*) > 0 flip ────────────────────────────────

describe('CHARACTERIZATION (audit F-B1): cells.validated flips on first endorsement', () => {
  // CHARACTERIZATION (audit F-B1): intentionally frozen wrong behavior;
  // FRO-279 will flip this — validated should require COUNT >= validationCount.
  it('cell becomes validated=1 after exactly one endorsement (no settings)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    const row = await validateAndRead(db, 'bob', 'evt-char-val-1')
    // CHARACTERIZATION: 1 endorsement → validated=1 even though the spec
    // default (validationCount=1) would also pass.  The important thing is
    // this documents the raw COUNT(*) > 0 behavior at event-projection.ts:481.
    expect(Number(row?.validated)).toBe(1)
  })

  // CHARACTERIZATION (audit F-B1): intentionally frozen wrong behavior;
  // FRO-279 will flip this — with validationCount=2 the flip must NOT happen
  // after only 1 validator.
  it('cell becomes validated=1 after ONE endorsement even when validationCount=2', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    // Set validationCount=2 — the server MUST ignore this (today)
    await setSettings(db, { validationCount: 2 })

    // Only one validator endorses
    const row = await validateAndRead(db, 'bob', 'evt-char-val-count2-single')

    // CHARACTERIZATION: server ignores validationCount; 1 endorsement flips validated.
    // When FRO-279 lands this assertion must be inverted (1 should NOT be validated
    // until a second endorser sends cell.validate).
    expect(Number(row?.validated)).toBe(1)
  })

  // CHARACTERIZATION (audit F-B1): intentionally frozen wrong behavior;
  // FRO-279 will flip this — validationCount=5 should still be ignored today.
  it('cell becomes validated=1 after ONE endorsement even when validationCount=5', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')
    await setSettings(db, { validationCount: 5 })

    const row = await validateAndRead(db, 'carol', 'evt-char-val-count5-single')

    // CHARACTERIZATION: validationCount=5, only 1 endorser → still flips validated.
    expect(Number(row?.validated)).toBe(1)
  })

  it('cell returns to validated=0 after cell.validate is removed (unvalidate)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    // Validate first
    await validateAndRead(db, 'bob', 'evt-char-unval-v1')

    // Unvalidate
    const ownerTok = await token(700, 'owner')
    const unvalEvt: RawEvent<'cell.unvalidate'> = {
      id: 'evt-char-unval-u1',
      schemaVersion: 1,
      kind: 'cell.unvalidate',
      projectId: 'proj-char',
      fileId: 'file-char',
      cellId: 'cell-char-1',
      parentId: 'evt-char-commit',
      author: 'bob',
      payload: { editEventId: 'evt-char-commit', targetUsername: 'bob' },
      clientTs: 300,
    }
    const res = await post(db, [unvalEvt], ownerTok)
    expect(res.rejected).toHaveLength(0)

    const row = await db
      .prepare(
        `SELECT validated FROM cells
         WHERE project_id = 'proj-char' AND file_id = 'file-char'
           AND cell_id = 'cell-char-1' AND side = 'target'`,
      )
      .first<{ validated: number | boolean }>()
    expect(Number(row?.validated)).toBe(0)
  })

  it('a new cell.commit resets validated=0 (chain-head moves)', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    // Validate
    await validateAndRead(db, 'bob', 'evt-char-reset-v1')

    // Author edits the cell again — chain head moves
    const aliceTok = await token(400, 'alice')
    const commitEvt2: RawEvent<'target.cell.commit'> = {
      id: 'evt-char-reset-commit2',
      schemaVersion: 1,
      kind: 'target.cell.commit',
      projectId: 'proj-char',
      fileId: 'file-char',
      cellId: 'cell-char-1',
      parentId: 'evt-char-commit',
      author: 'alice',
      payload: { value: 'revised text', valueHtml: '<p>revised text</p>' },
      clientTs: 400,
    }
    const res = await post(db, [commitEvt2], aliceTok)
    expect(res.rejected).toHaveLength(0)

    const row = await db
      .prepare(
        `SELECT validated FROM cells
         WHERE project_id = 'proj-char' AND file_id = 'file-char'
           AND cell_id = 'cell-char-1' AND side = 'target'`,
      )
      .first<{ validated: number | boolean }>()
    // Chain head moved — old validators are on stale event_id, so validated resets
    expect(Number(row?.validated)).toBe(0)
  })
})

// ── files.approved_count tracks validated cells ───────────────────────────

describe('CHARACTERIZATION: files.approved_count follows cells.validated', () => {
  it('approved_count increments to 1 after the first cell is validated', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    await validateAndRead(db, 'bob', 'evt-char-ac-v1')

    const file = await db
      .prepare(
        `SELECT approved_count FROM files
         WHERE id = 'file-char' AND project_id = 'proj-char'`,
      )
      .first<{ approved_count: number }>()
    expect(Number(file?.approved_count)).toBe(1)
  })

  it('approved_count returns to 0 after unvalidate', async () => {
    const { db } = await makeTestDb()
    await seedFileAndCell(db, 'alice')

    await validateAndRead(db, 'bob', 'evt-char-ac-unval-v1')

    const ownerTok = await token(700, 'owner')
    const unvalEvt: RawEvent<'cell.unvalidate'> = {
      id: 'evt-char-ac-unval-u1',
      schemaVersion: 1,
      kind: 'cell.unvalidate',
      projectId: 'proj-char',
      fileId: 'file-char',
      cellId: 'cell-char-1',
      parentId: 'evt-char-commit',
      author: 'bob',
      payload: { targetUsername: 'bob' },
      clientTs: 300,
    }
    await post(db, [unvalEvt], ownerTok)

    const file = await db
      .prepare(
        `SELECT approved_count FROM files
         WHERE id = 'file-char' AND project_id = 'proj-char'`,
      )
      .first<{ approved_count: number }>()
    expect(Number(file?.approved_count)).toBe(0)
  })
})
