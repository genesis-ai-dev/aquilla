// AQU-2143: the post-commit counter / progress recompute under a BURST.
//
// A bulk recording upload or a bulk audio validation posts thousands of events
// in a few minutes, and on production roughly a third of those POSTs ended at
// the client outbox's 15 s abort. The events were durable — every take carried
// its vote — but the files' `file_section_progress` rows kept their pre-burst
// values indefinitely, so the dashboard's "Audio Validated" tile read 0% over
// thousands of validated takes while the editor's own per-line control said
// every one of them was validated.
//
// The write-path half of that is the replay: an event whose id already exists
// takes the "already accepted" fast path, which contributed nothing to the
// recompute. The batch it retries may well have committed its events and then
// died before its own recompute ran, so a retried batch could never repair
// itself — and once a burst is over, no further event lands on the file to
// repair it either.
//
// (The other half — a pass dying with the one request whose connection it ran
// on — is pinned in counter-recompute-coalescer.test.ts, where a torn-down
// connection can be simulated deterministically.)
import { describe, it, expect, vi } from 'vitest'

// route.ts imports broadcast.ts → partyserver (cloudflare:* imports).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { progressRowsForLane } from './helpers/progress-rows'
import type { RawEvent } from '../events/types'

const SECRET = 'burst-recompute-secret'
const PROJECT = 'proj-burst'
const FILE = 'file-burst'
const CELL = 'cell-burst-1'
const TAKE = 'take-burst-1'

interface ProgressRow {
  scope: string
  audio_count: number
  audio_validated_count: number
  updated_at: number
}

async function token(role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role, username } as never)
}

async function post(db: AquillaDb, events: RawEvent[], tok: string) {
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ events }),
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res).not.toBeNull()
  return (await res!.json()) as {
    accepted: Array<{ id: string }>
    rejected: Array<{ id: string; status: number; reason: string }>
  }
}

/** The file's own progress row for the default target lane. */
async function fileRow(t: TestDb): Promise<ProgressRow> {
  const rows = await progressRowsForLane<ProgressRow>(t.pg, PROJECT, 'target', {
    fileId: FILE,
    tag: '',
  })
  const row = rows.find((r) => r.scope === 'file')
  expect(row, 'the file-scope progress row should exist').toBeDefined()
  return row!
}

/** A file, a target cell and one take on it — the state a burst validates. */
async function seedRecordedCell(db: AquillaDb): Promise<void> {
  const file: RawEvent<'file.create'> = {
    id: 'evt-burst-file',
    schemaVersion: 1,
    kind: 'file.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: undefined,
    parentId: null,
    author: 'owner',
    payload: { name: 'Genesis', fileType: 'codex' },
    clientTs: 0,
  }
  expect((await post(db, [file], await token(700, 'owner'))).rejected).toHaveLength(0)

  // A source cell and a translation of it: the progress rows are built from the
  // source denominator paired with each target lane, so a target-only fixture
  // produces no rows at all.
  const source: RawEvent<'source.cell.create'> = {
    id: 'evt-burst-source',
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'owner',
    payload: { cellId: CELL, value: 'In the beginning', anchorCellId: null },
    clientTs: 50,
  }
  expect((await post(db, [source], await token(700, 'owner'))).rejected).toHaveLength(0)

  const cell: RawEvent<'target.cell.commit'> = {
    id: 'evt-burst-cell',
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: 'evt-burst-source',
    author: 'alice',
    payload: { value: 'translated line' },
    clientTs: 100,
  }
  expect((await post(db, [cell], await token(400, 'alice'))).rejected).toHaveLength(0)

  const attach: RawEvent<'cell.audio.attach'> = {
    id: 'evt-burst-attach',
    schemaVersion: 1,
    kind: 'cell.audio.attach',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: { audioId: TAKE, url: `frontier-audio://${TAKE}.webm`, slot: 'recording' },
    clientTs: 150,
  }
  expect((await post(db, [attach], await token(400, 'alice'))).rejected).toHaveLength(0)
}

function validateTake(id: string, author: string): RawEvent<'cell.audio.validate'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'cell.audio.validate',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author,
    payload: { audioId: TAKE },
    clientTs: 200,
  }
}

/**
 * Put the file's progress rows back to a pre-burst state, the way a burst whose
 * recompute never ran leaves them: the takes and their votes stay, only the
 * derived rows (and their stamp) are behind.
 */
async function rewindProgressRows(t: TestDb): Promise<number> {
  const stale = 1_600_000_000_000
  await t.pg.query(
    `UPDATE file_section_progress
        SET audio_count = 0, audio_validated_count = 0,
            audio_validator_histogram = '{}'::jsonb, updated_at = $1
      WHERE project_id = $2 AND file_id = $3`,
    [stale, PROJECT, FILE],
  )
  return stale
}

describe('AQU-2143 burst audio recompute', () => {
  // Today's behaviour, pinned: the ordinary path was never the problem, and a
  // fix for the burst must not buy itself room by weakening this.
  it('recomputes a file\'s audio progress for a standalone validate batch', async () => {
    const t = await makeTestDb()
    await seedRecordedCell(t.db)

    const before = await fileRow(t)
    expect(before.audio_count).toBe(1)
    expect(before.audio_validated_count).toBe(0)

    const r = await post(t.db, [validateTake('evt-burst-v1', 'bob')], await token(300, 'bob'))
    expect(r.rejected).toHaveLength(0)

    const after = await fileRow(t)
    expect(after.audio_validated_count).toBe(1)
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
    await t.close()
  })

  it('re-runs the recompute for a batch whose event ids were already accepted', async () => {
    const t = await makeTestDb()
    await seedRecordedCell(t.db)

    const batch = [validateTake('evt-burst-v1', 'bob')]
    const first = await post(t.db, batch, await token(300, 'bob'))
    expect(first.rejected).toHaveLength(0)

    // The shape an aborted-then-retried batch leaves behind: the vote is
    // stored, the derived rows are not.
    const stale = await rewindProgressRows(t)
    expect((await fileRow(t)).audio_validated_count).toBe(0)

    // The retry. Every id already exists, so nothing new commits — and before
    // AQU-2143 nothing was recomputed either, which is why such a file stayed
    // at 0% forever.
    const retry = await post(t.db, batch, await token(300, 'bob'))
    expect(retry.rejected).toHaveLength(0)
    expect(retry.accepted.map((a) => a.id)).toEqual(['evt-burst-v1'])

    const healed = await fileRow(t)
    expect(healed.audio_validated_count).toBe(1)
    expect(healed.audio_count).toBe(1)
    expect(healed.updated_at).toBeGreaterThan(stale)
    await t.close()
  })

  // The repair reads the live takes, so it cannot invent validation: a project
  // whose takes are recorded but genuinely unvalidated still reads zero.
  it('does not report audio validated when the replayed batch never validated anything', async () => {
    const t = await makeTestDb()
    await seedRecordedCell(t.db)

    const stale = await rewindProgressRows(t)
    // A replay of the ATTACH — recorded, never validated.
    const attach: RawEvent<'cell.audio.attach'> = {
      id: 'evt-burst-attach',
      schemaVersion: 1,
      kind: 'cell.audio.attach',
      projectId: PROJECT,
      fileId: FILE,
      cellId: CELL,
      parentId: null,
      author: 'alice',
      payload: { audioId: TAKE, url: `frontier-audio://${TAKE}.webm`, slot: 'recording' },
      clientTs: 150,
    }
    expect((await post(t.db, [attach], await token(400, 'alice'))).rejected).toHaveLength(0)

    const healed = await fileRow(t)
    expect(healed.audio_count).toBe(1)
    expect(healed.audio_validated_count).toBe(0)
    expect(healed.updated_at).toBeGreaterThan(stale)
    await t.close()
  })
})
