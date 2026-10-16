// AQU-1612: events carry `laneId`; replay prefers it and falls back to the tag.
//
// The load-bearing property is the duplicate-commit guard. An old client names
// a lane by its `targetLang` tag, a new one by the lane row's `laneId`. Both
// must compose the SAME `chain_claims.parent_key` for that lane, or two
// commits on one cell each claim their own slot and both win.

import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { handleRebuildProjectionRequest } from '../events/rebuild'
import { laneOfEvent } from '../events/event-projection'
import {
  eventLaneIdOf,
  eventLaneRef,
  eventLaneTag,
  resolveEventLane,
} from '../../../src/lib/lanes/event-lane'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-laneid'
const FILE = 'file-laneid'
const CELL = 'cell-laneid'
const PARENT = 'evt-src-laneid'
const TAG = 'en'
const LANE_ID = 'enlane01'

const LANES = [
  { id: LANE_ID, name: 'English', legacyTag: TAG },
  { id: 'defaultlane01', name: 'Spanish', legacyTag: '' },
]

interface EventsResponse {
  accepted: Array<{ id: string }>
  rejected: Array<{ id: string; status: number; reason: string }>
  stale: Array<{ id: string; fileId: string | null; cellId: string | null }>
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

async function chainClaimKeys(t: TestDb): Promise<string[]> {
  const r = await t.pg.query<{ parent_key: string }>(
    `SELECT parent_key FROM chain_claims
     WHERE project_id = $1 AND file_id = $2 AND cell_id = $3
     ORDER BY parent_key`,
    [PROJECT, FILE, CELL],
  )
  return r.rows.map((row) => row.parent_key)
}

async function targetHeads(
  t: TestDb,
): Promise<Array<{ target_lang: string; lane_id: string | null; event_id: string; value: string }>> {
  const r = await t.pg.query<{
    target_lang: string
    lane_id: string | null
    event_id: string
    value: string
  }>(
    `SELECT COALESCE(l.legacy_tag, '') AS target_lang, c.lane_id, c.event_id, c.value
       FROM cells c
       JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
      WHERE c.project_id = $1 AND c.file_id = $2 AND c.cell_id = $3 AND c.side = 'target'
      ORDER BY target_lang`,
    [PROJECT, FILE, CELL],
  )
  return r.rows
}

async function storedPayload(t: TestDb, eventId: string): Promise<Record<string, unknown>> {
  const r = await t.pg.query<{ payload: unknown }>(`SELECT payload FROM events WHERE id = $1`, [
    eventId,
  ])
  const raw = r.rows[0]!.payload
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
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

function commit(
  id: string,
  value: string,
  lane: { targetLang?: string; laneId?: string },
  clientTs = 1001,
): RawEvent<'target.cell.commit'> {
  return {
    id,
    schemaVersion: 1,
    kind: 'target.cell.commit',
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: PARENT,
    author: 'alice',
    payload: { value, ...lane },
    clientTs,
  }
}

describe('AQU-1612 lane resolver', () => {
  it('reads both lane references off a payload', () => {
    expect(eventLaneRef({ targetLang: TAG, laneId: LANE_ID })).toEqual({
      laneId: LANE_ID,
      tag: TAG,
      tagPresent: true,
    })
    expect(eventLaneRef({ laneId: LANE_ID })).toEqual({
      laneId: LANE_ID,
      tag: '',
      tagPresent: false,
    })
    // An empty-string id is not an id — the default lane is '' as a TAG.
    expect(eventLaneIdOf({ laneId: '' })).toBeNull()
    expect(eventLaneIdOf({})).toBeNull()
    expect(eventLaneIdOf({ laneId: 42 })).toBeNull()
  })

  it('tag-only events resolve exactly as laneOfEvent always did', () => {
    for (const payload of [{}, { targetLang: '' }, { targetLang: TAG }, { targetLang: 7 }]) {
      expect(eventLaneTag('target.cell.commit', payload)).toBe(
        laneOfEvent('target.cell.commit', payload),
      )
    }
    // Source rows are shared by every lane and never carry one.
    expect(eventLaneTag('source.cell.create', { targetLang: TAG })).toBe('')
  })

  it('prefers laneId over the tag and falls back to the tag without lane rows', () => {
    expect(resolveEventLane({ laneId: LANE_ID }, LANES)).toEqual({ ok: true, tag: TAG, laneId: LANE_ID })
    expect(resolveEventLane({ laneId: LANE_ID, targetLang: TAG }, LANES)).toEqual({
      ok: true,
      tag: TAG,
      laneId: LANE_ID,
    })
    // No lane rows in hand: the tag is taken as sent, which is why every
    // writer that stamps an id stamps the tag too.
    expect(resolveEventLane({ laneId: LANE_ID, targetLang: TAG }, null)).toEqual({
      ok: true,
      tag: TAG,
      laneId: LANE_ID,
    })
    // A lane whose legacy tag is '' is the former default lane.
    expect(resolveEventLane({ laneId: 'defaultlane01' }, LANES)).toEqual({
      ok: true,
      tag: '',
      laneId: 'defaultlane01',
    })
  })

  it('refuses an event whose two lane forms disagree, or whose id is unknown', () => {
    const disagree = resolveEventLane({ laneId: LANE_ID, targetLang: 'fr' }, LANES)
    expect(disagree.ok).toBe(false)
    expect(disagree.ok === false && disagree.reason).toContain(LANE_ID)

    const unknown = resolveEventLane({ laneId: 'nosuchlane' }, LANES)
    expect(unknown.ok).toBe(false)
    expect(unknown.ok === false && unknown.reason).toContain('unknown lane id')

    // A lane's display NAME is not an event key, so it never satisfies the tag.
    expect(resolveEventLane({ laneId: LANE_ID, targetLang: 'English' }, LANES).ok).toBe(false)
  })
})

let t: TestDb

beforeEach(async () => {
  t = await makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Lane id', event_id: 'evt-file', meta: '{}' }],
    lanes: [
      { id: LANE_ID, project_id: PROJECT, role: 'target', name: 'English', legacy_tag: TAG },
    ],
  })
})

describe('AQU-1612 events carrying laneId', () => {
  it('an id-only commit and a tag-only commit on one cell arbitrate as ONE chain', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    const r = await postEvents(t.db, [
      commit('evt-old-client', 'typed by an old client', { targetLang: TAG }, 1001),
      commit('evt-new-client', 'typed by a new client', { laneId: LANE_ID }, 1002),
    ])

    expect(r.rejected).toEqual([])
    // Both are accepted and logged — losing the chain never drops history.
    expect(r.accepted.map((a) => a.id).sort()).toEqual(['evt-new-client', 'evt-old-client'])
    // One slot, so exactly one of them is stale. Before AQU-1612 the id-only
    // commit would have claimed the DEFAULT lane's slot and both would have won.
    expect(r.stale.map((s) => s.id)).toEqual(['evt-new-client'])
    // One target slot, lane-qualified by the lane both forms name — plus the
    // genesis source create's own side-qualified slot.
    expect(await chainClaimKeys(t)).toEqual(['<null>@side:source', `${PARENT}@lane:${TAG}`])

    const heads = await targetHeads(t)
    expect(heads).toHaveLength(1)
    expect(heads[0]!.target_lang).toBe(TAG)
    expect(heads[0]!.lane_id).toBe(LANE_ID)
    expect(heads[0]!.event_id).toBe('evt-old-client')
  })

  it('stores the resolved tag alongside the id so every tag-shaped key keeps working', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    await postEvents(t.db, [commit('evt-id-only', 'drafted', { laneId: LANE_ID })])

    const stored = await storedPayload(t, 'evt-id-only')
    expect(stored.laneId).toBe(LANE_ID)
    expect(stored.targetLang).toBe(TAG)
    expect(laneOfEvent('target.cell.commit', stored)).toBe(TAG)
  })

  it('replays an id-bearing event onto the same lane as the live projection', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    await postEvents(t.db, [commit('evt-id-only', 'drafted', { laneId: LANE_ID })])

    const live = await targetHeads(t)
    await rebuild(t)
    expect(await targetHeads(t)).toEqual(live)
    expect(live[0]!.target_lang).toBe(TAG)
    expect(live[0]!.lane_id).toBe(LANE_ID)
  })

  it('refuses a commit whose laneId and targetLang name different lanes', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    const r = await postEvents(t.db, [
      commit('evt-mismatch', 'wrong', { laneId: LANE_ID, targetLang: 'fr' }),
    ])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.status).toBe(422)
    expect(r.rejected[0]!.reason).toContain(LANE_ID)
    expect(await targetHeads(t)).toEqual([])
  })

  it('refuses a commit naming a lane id this project does not have', async () => {
    await postEvents(t.db, [sourceCreate(PARENT)])
    const r = await postEvents(t.db, [commit('evt-ghost', 'ghost', { laneId: 'nosuchlane' })])

    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.status).toBe(422)
    expect(r.rejected[0]!.reason).toContain('unknown lane id')
  })
})
