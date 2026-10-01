import { describe, it, expect } from 'vitest'
import { handleEventsReadRequest } from '../events/read-route'
import { handleValidatorsReadRequest } from '../events/validators-read-route'
import { handleCellsAuditReadRequest } from '../events/cells-audit-read-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'read-route-secret'

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

describe('GET /events', () => {
  it('returns rows newest-first by server_seq with filters', async () => {
    const { db } = await makeTestDb({
      events: [
        {
          id: 'e1', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c1', parent_id: null, kind: 'target.cell.create',
          author: 'alice', payload: '{"value":"a"}',
          client_ts: 1, server_ts: 100, server_seq: 1,
        },
        {
          id: 'e2', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c1', parent_id: 'e1', kind: 'target.cell.commit',
          author: 'bob', payload: '{"value":"b"}',
          client_ts: 2, server_ts: 200, server_seq: 2,
        },
        {
          id: 'e3', schema_version: 1, project_id: 'proj-a', file_id: 'file-x',
          cell_id: 'c2', parent_id: null, kind: 'target.cell.create',
          author: 'alice', payload: '{"value":"c"}',
          client_ts: 3, server_ts: 150, server_seq: 3,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: 'proj-a',
      fileId: 'file-x',
    })
    const req = new Request('https://w/events?fileId=file-x&cellId=c1&limit=10', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleEventsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: { id: string; serverSeq: number; parentId: string | null }[] }
    expect(body.events).toHaveLength(2)
    expect(body.events[0].id).toBe('e2')
    expect(body.events[0].serverSeq).toBe(2)
    expect(body.events[0].parentId).toBe('e1')
    expect(body.events[1].id).toBe('e1')
    expect(body.events[1].parentId).toBe(null)
  })
})

describe('GET /cell-validators', () => {
  it('returns validator rows newest-first', async () => {
    // DELETE-on-unvalidate: each row = one active validator. Two rows from
    // different timestamps; newest-first ordering checked below.
    const { db } = await makeTestDb({
      cell_validators: [
        {
          project_id: 'proj-a', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev1', username: 'bob',
          decided_ts: 50,
        },
        {
          project_id: 'proj-a', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev2', username: 'alice',
          decided_ts: 100,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x' })
    const req = new Request(
      'https://w/cell-validators?fileId=file-x&cellId=c1',
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleValidatorsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      validators: { editEventId: string; decidedTs: number }[]
    }
    expect(body.validators).toHaveLength(2)
    expect(body.validators[0].decidedTs).toBe(100)
  })
})

describe('GET /cells/audit-stats', () => {
  it('returns side, event_id (chain head), source_event_id (AD-9 pin), and active validators', async () => {
    const { db } = await makeTestDb({
      cells: [
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          side: 'target', value: 'hello world', content_hash: 'abcd1234',
          event_id: 'ev-current', source_event_id: 'src-current-1',
          last_editor: 'a', last_edit_at: 1700, validated: 1, word_count: 2,
        },
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c2',
          side: 'source', value: 'hola', content_hash: 'beef9999',
          event_id: 'src-1', source_event_id: null,
          last_editor: 'b', last_edit_at: 1800, validated: 0, word_count: 1,
        },
      ],
      cell_validators: [
        // Active validators tied to the current chain head on c1.
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-current', username: 'alice',
          decided_ts: 1750,
        },
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-current', username: 'bob',
          decided_ts: 1751,
        },
        // Validator on a prior edit — does not count for the current head.
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-old', username: 'carol',
          decided_ts: 1600,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { fileId: 'file-x', projectId: 'proj-x' })
    const req = new Request('https://w/cells/audit-stats?fileId=file-x', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsAuditReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: {
        cellId: string
        side: string
        contentHash: string | null
        lastEditAt: number | null
        lastEditEventId: string
        sourceEventId: string | null
        activeValidators: string[]
      }[]
    }
    const c1 = body.cells.find((c) => c.cellId === 'c1')!
    expect(c1.side).toBe('target')
    expect(c1.lastEditEventId).toBe('ev-current')
    expect(c1.sourceEventId).toBe('src-current-1')
    expect(new Set(c1.activeValidators)).toEqual(new Set(['alice', 'bob']))

    const c2 = body.cells.find((c) => c.cellId === 'c2')!
    expect(c2.side).toBe('source')
    expect(c2.sourceEventId).toBe(null)
    expect(c2.activeValidators).toEqual([])
  })

  it('scopes to a single cell when cellId is passed, so a single-cell commit does not have to pull the whole file', async () => {
    // Perf regression guard: revalidateCellStats (useCellsAuditStats.ts) relies
    // on this filter existing so a single-cell commit on a 30k-cell file only
    // ever fetches one row back, not the whole file's stats.
    const { db } = await makeTestDb({
      cells: [
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          side: 'target', value: 'hello world', content_hash: 'abcd1234',
          event_id: 'ev-current', source_event_id: 'src-current-1',
          last_editor: 'a', last_edit_at: 1700, validated: 1, word_count: 2,
        },
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c2',
          side: 'source', value: 'hola', content_hash: 'beef9999',
          event_id: 'src-1', source_event_id: null,
          last_editor: 'b', last_edit_at: 1800, validated: 0, word_count: 1,
        },
      ],
      cell_validators: [
        { project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1', event_id: 'ev-current', username: 'alice', decided_ts: 1750 },
      ],
    })
    const token = await makeTestToken(SECRET, { fileId: 'file-x', projectId: 'proj-x' })
    const req = new Request('https://w/cells/audit-stats?fileId=file-x&cellId=c1', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsAuditReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cells: { cellId: string }[] }
    expect(body.cells).toHaveLength(1)
    expect(body.cells[0].cellId).toBe('c1')
  })
})

// ── AQU-1506 ────────────────────────────────────────────────────────────────
// An N-lane file has one target row per lane for the same cell. Before this the
// response marked none of them, so the client kept whichever row Postgres
// returned first — heap order, which a validate or commit rewrites — and showed
// one lane's validators on another's page.
describe('GET /cells/audit-stats — lane marker (AQU-1506)', () => {
  const TWO_LANE_SEED = {
    lanes: [
      { id: 'lane-src', project_id: 'proj-x', role: 'source', legacy_tag: '' },
      { id: 'lane-def', project_id: 'proj-x', role: 'target', legacy_tag: '' },
      { id: 'lane-fr', project_id: 'proj-x', role: 'target', legacy_tag: 'fr' },
    ],
    cells: [
      {
        project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
        side: 'source', value: 'in the beginning', content_hash: 'src-hash',
        event_id: 'ev-src', source_event_id: null,
        last_editor: 'importer', last_edit_at: 1000, validated: 0, word_count: 3,
        target_lang: '', lane_id: 'lane-src',
      },
      // The fr row is seeded FIRST so heap order puts it ahead of the default
      // lane's — the arrangement that made the default-lane page wrong.
      {
        project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
        side: 'target', value: 'au commencement', content_hash: 'fr-hash',
        event_id: 'ev-fr-head', source_event_id: 'ev-src',
        last_editor: 'dev', last_edit_at: 1700, validated: 1, word_count: 2,
        target_lang: 'fr', lane_id: 'lane-fr',
      },
      {
        project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
        side: 'target', value: 'al principio', content_hash: 'def-hash',
        event_id: 'ev-def-head', source_event_id: 'ev-src',
        last_editor: 'dev', last_edit_at: 1800, validated: 0, word_count: 2,
        target_lang: '', lane_id: 'lane-def',
      },
    ],
    cell_validators: [
      // Only the fr lane is validated, and only by `dev`.
      {
        project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
        target_lang: 'fr', lane_id: 'lane-fr',
        event_id: 'ev-fr-head', username: 'dev', decided_ts: 1750,
      },
    ],
  }

  interface AuditRow {
    cellId: string
    side: string
    targetLang: string
    laneId: string | null
    lastEditEventId: string
    activeValidators: string[]
  }

  async function readStats(seed: object, query = 'fileId=file-x'): Promise<AuditRow[]> {
    const { db } = await makeTestDb(seed)
    const token = await makeTestToken(SECRET, { fileId: 'file-x', projectId: 'proj-x' })
    const req = new Request(`https://w/cells/audit-stats?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsAuditReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    return ((await res.json()) as { cells: AuditRow[] }).cells
  }

  it("marks every row with its lane, so two lanes' target rows are tellable apart", async () => {
    const cells = await readStats(TWO_LANE_SEED)
    const targets = cells.filter((c) => c.side === 'target')
    expect(targets).toHaveLength(2)
    // The regression this guards: two `side: "target"` rows for one cell with no
    // lane marker on either.
    expect(targets.every((t) => typeof t.targetLang === 'string')).toBe(true)
    expect(new Set(targets.map((t) => t.targetLang))).toEqual(new Set(['', 'fr']))
    expect(targets.find((t) => t.targetLang === 'fr')!.laneId).toBe('lane-fr')
    expect(targets.find((t) => t.targetLang === '')!.laneId).toBe('lane-def')
  })

  it('attributes validators to the lane that earned them, not to the first row', async () => {
    const cells = await readStats(TWO_LANE_SEED)
    const fr = cells.find((c) => c.side === 'target' && c.targetLang === 'fr')!
    const def = cells.find((c) => c.side === 'target' && c.targetLang === '')!
    expect(fr.lastEditEventId).toBe('ev-fr-head')
    expect(fr.activeValidators).toEqual(['dev'])
    // The default lane is untouched by the fr validate.
    expect(def.lastEditEventId).toBe('ev-def-head')
    expect(def.activeValidators).toEqual([])
  })

  it('still gives the shared source row no validators, and marks it as lane-less', async () => {
    const cells = await readStats(TWO_LANE_SEED)
    const source = cells.find((c) => c.side === 'source')!
    expect(source.targetLang).toBe('')
    expect(source.activeValidators).toEqual([])
  })

  it('carries the lane on the single-cell (?cellId=) scope too', async () => {
    const cells = await readStats(TWO_LANE_SEED, 'fileId=file-x&cellId=c1')
    expect(cells).toHaveLength(3)
    const fr = cells.find((c) => c.side === 'target' && c.targetLang === 'fr')!
    expect(fr.activeValidators).toEqual(['dev'])
  })

  it('returns the same shape as before on a single-lane file', async () => {
    const cells = await readStats({
      cells: [
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          side: 'target', value: 'hello world', content_hash: 'abcd1234',
          event_id: 'ev-current', source_event_id: 'src-1',
          last_editor: 'a', last_edit_at: 1700, validated: 1, word_count: 2,
        },
      ],
      cell_validators: [
        {
          project_id: 'proj-x', file_id: 'file-x', cell_id: 'c1',
          event_id: 'ev-current', username: 'alice', decided_ts: 1750,
        },
      ],
    })
    expect(cells).toHaveLength(1)
    expect(cells[0].targetLang).toBe('')
    expect(cells[0].activeValidators).toEqual(['alice'])
  })
})
