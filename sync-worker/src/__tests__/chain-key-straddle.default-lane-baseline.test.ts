// PRE-AQU-1240 characterization baseline — §2.6 chain-key straddle test.
// A legacy unqualified default-lane commit (no targetLang) and a new explicit-
// tagged commit (`@lane:<tag>`) share one parent. Asserts live == replay on
// projection heads. UPDATE (do not silently delete) when `''` is eliminated
// (AQU-1240 slice 0). PASS ⇒ option A (leave chain keys raw) viable;
// FAIL ⇒ option B (backfill parent_key) mandatory.

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import {
  eventQualifiedParentKey,
  qualifyParentKeyBase,
} from '../events/chain-claims'
import { laneOfEvent } from '../events/event-projection'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-straddle'
const FILE = 'file-straddle'
const CELL = 'cell-straddle'
const PARENT = 'evt-src'
const TAG = 'en'

interface EventsResponse {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
}

interface TargetHead {
  target_lang: string
  event_id: string
  value: string
}

async function postEvents(db: AquillaDb, events: unknown[]): Promise<EventsResponse> {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 400 })
  const req = new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  })
  const res = await handleEventsWriteRequest(req, { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return (await res!.json()) as EventsResponse
}

async function targetHeads(t: TestDb): Promise<TargetHead[]> {
  const r = await t.pg.query<TargetHead>(
    `SELECT target_lang, event_id, value FROM cells
     WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'
     ORDER BY target_lang`,
    [PROJECT, FILE, CELL],
  )
  return r.rows
}

async function chainClaimKeys(t: TestDb): Promise<string[]> {
  const r = await t.pg.query<{ parent_key: string }>(
    `SELECT parent_key FROM chain_claims
     WHERE project_id = $1 AND file_id = $2 AND cell_id = $3
     ORDER BY parent_key`,
    [PROJECT, FILE, CELL],
  )
  return r.rows.map((row) => row.parent_key)
}

async function rebuild(t: TestDb): Promise<void> {
  const req = new Request(`https://worker/admin/projects/${PROJECT}/rebuild-projection`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  })
  const res = await handleRebuildProjectionRequest(req, {
    AQUILLA_PG: t.db,
    SYNC_SECRET_KEY: SECRET,
  })
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
}

function sourceCreate(id: string): RawEvent<'source.cell.create'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'source.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    author: 'alice',
    payload: { cellId: CELL, value: 'Source', anchorCellId: null },
    clientTs: 1000,
  }
}

function legacyCommit(id: string, value: string): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: PARENT,
    author: 'alice',
    payload: { value },
    clientTs: 1001,
  }
}

function taggedCommit(id: string, value: string, targetLang: string): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: PARENT,
    author: 'bob',
    payload: { value, targetLang },
    clientTs: 1002,
  }
}

let t: TestDb

beforeEach(async () => {
  t = await makeTestDb({
    files: [
      {
        id: FILE,
        project_id: PROJECT,
        name: 'Straddle',
        event_id: 'evt-file',
        meta: '{}',
      },
    ],
  })
})

describe('§2.6 chain-key straddle — legacy unqualified + explicit @lane tag on one parent', () => {
  it('chain keys differ: unqualified base vs @lane:<tag> (option A shape)', () => {
    const legacyKey = eventQualifiedParentKey(PARENT, 'target.cell.commit', { value: 'legacy' })
    const taggedKey = eventQualifiedParentKey(PARENT, 'target.cell.commit', {
      value: 'tagged',
      targetLang: TAG,
    })
    expect(legacyKey).toBe(PARENT)
    expect(taggedKey).toBe(`${PARENT}@lane:${TAG}`)
    expect(legacyKey).not.toBe(taggedKey)
    expect(qualifyParentKeyBase(PARENT, 'target.cell.commit', {})).toBe(PARENT)
    expect(qualifyParentKeyBase(PARENT, 'target.cell.commit', { targetLang: TAG })).toBe(
      `${PARENT}@lane:${TAG}`,
    )
    expect(laneOfEvent('target.cell.commit', {})).toBe('')
    expect(laneOfEvent('target.cell.commit', { targetLang: TAG })).toBe(TAG)
  })

  it('live path: both siblings win distinct chain slots and project to separate lanes', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    const r = await postEvents(t.db, [
      legacyCommit('evt-legacy', 'legacy text'),
      taggedCommit('evt-tagged', 'tagged text', TAG),
    ])
    expect(r.accepted.map((a) => a.id).sort()).toEqual(['evt-legacy', 'evt-tagged'])
    expect(r.stale).toEqual([])

    const liveHeads = await targetHeads(t)
    expect(liveHeads).toEqual([
      { target_lang: '', event_id: 'evt-legacy', value: 'legacy text' },
      { target_lang: TAG, event_id: 'evt-tagged', value: 'tagged text' },
    ])
    expect(await chainClaimKeys(t)).toEqual([PARENT, `${PARENT}@lane:${TAG}`])
  })

  it('rebuild replay reproduces the same projection heads as live (replay == live)', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    await postEvents(t.db, [
      legacyCommit('evt-legacy', 'legacy text'),
      taggedCommit('evt-tagged', 'tagged text', TAG),
    ])

    const liveHeads = await targetHeads(t)
    await rebuild(t)
    const rebuiltHeads = await targetHeads(t)

    expect(rebuiltHeads).toEqual(liveHeads)
  })

  it('same-batch siblings: live and rebuild still agree', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    await postEvents(t.db, [
      legacyCommit('evt-legacy-batch', 'legacy batch'),
      taggedCommit('evt-tagged-batch', 'tagged batch', TAG),
    ])

    const liveHeads = await targetHeads(t)
    await rebuild(t)
    expect(await targetHeads(t)).toEqual(liveHeads)
  })

  it('follow-up commits on each branch: live and rebuild still agree', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    await postEvents(t.db, [legacyCommit('evt-legacy-1', 'legacy v1')])
    await postEvents(t.db, [taggedCommit('evt-tagged-1', 'tagged v1', TAG)])
    await postEvents(t.db, [
      {
        ...legacyCommit('evt-legacy-2', 'legacy v2'),
        parentId: 'evt-legacy-1',
      },
      {
        ...taggedCommit('evt-tagged-2', 'tagged v2', TAG),
        parentId: 'evt-tagged-1',
      },
    ])

    const liveHeads = await targetHeads(t)
    expect(liveHeads).toEqual([
      { target_lang: '', event_id: 'evt-legacy-2', value: 'legacy v2' },
      { target_lang: TAG, event_id: 'evt-tagged-2', value: 'tagged v2' },
    ])

    await rebuild(t)
    expect(await targetHeads(t)).toEqual(liveHeads)
  })
})
