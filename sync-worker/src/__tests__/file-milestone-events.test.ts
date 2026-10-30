// Handler-level tests for the hand-set milestone pair (AQU-2308), driven
// through dispatchEvent so the role floor, the dispatcher wiring and the
// handlers' own validation are exercised together.
//
// What matters here, and why each case exists:
//
//   * the MAINTAINER floor, because a division relayouts the navigator for
//     every collaborator who opens the file;
//   * blank-name refusal, because the acceptance criteria require the server
//     to refuse one and not only the dialog;
//   * that a refusal is RETURNED rather than thrown, because a throw would
//     500 the whole POST and wedge the client's outbox on one bad event;
//   * that neither kind touches `cells`, which is what makes setting a
//     division free of staleness in every lane.

import { describe, it, expect } from 'vitest'
import { dispatchEvent } from '../events/dispatch'
import { authorize, type AuthorizedEvent } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'test-secret'

const VALID_SET = {
  milestoneId: 'ms-0199b0c4',
  name: 'The storm',
  startCellId: 'cell-50',
  endCellId: 'cell-70',
}

async function authorizeRaw<K extends EventKind>(kind: K, payload: unknown, role: number) {
  const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role })
  const raw = {
    id: 'evt-00000000-0000-7000-0000-000000000001',
    schemaVersion: 1,
    kind,
    projectId: 'proj-a',
    fileId: 'file-x',
    parentId: null,
    author: 'alice',
    payload,
    clientTs: 1000,
  } as unknown as RawEvent<K>
  return await authorize(token, raw, SECRET)
}

async function authorized<K extends EventKind>(
  kind: K,
  payload: unknown,
  role = 600,
): Promise<AuthorizedEvent<K>> {
  const result = await authorizeRaw(kind, payload, role)
  if (!result.ok) throw new Error(`authorize unexpectedly failed: ${result.reason}`)
  return result.event as AuthorizedEvent<K>
}

/** Records the SQL and the bound values, so a test can assert on both. */
function makeRecordingDb(): { db: AquillaDb; sql: string[]; binds: unknown[][] } {
  const sql: string[] = []
  const binds: unknown[][] = []
  function makePrepared(statement: string) {
    sql.push(statement)
    const stmt = {
      bind(...args: unknown[]) { binds.push(args); return this },
      async first() { return null },
      async all() { return { results: [], success: true, meta: {} } },
      async run() { return { success: true, meta: {} } },
      raw: async () => [],
    } as unknown as AquillaStatement
    return stmt
  }
  const db = {
    prepare: makePrepared,
    async batch(ss: AquillaStatement[]) {
      return ss.map(() => ({ success: true, results: [], meta: {} }))
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as AquillaDb
  return { db, sql, binds }
}

function dispatch<K extends EventKind>(authed: AuthorizedEvent<K>) {
  const { db, sql, binds } = makeRecordingDb()
  const outcome = dispatchEvent(db, authed, 9999, { serverSeq: 7, updateProjection: true })
  return { outcome, sql, binds }
}

/** The values bound to the first statement matching `pattern`. */
function bindsFor(
  result: ReturnType<typeof dispatch>,
  pattern: RegExp,
): unknown[] {
  const index = result.sql.findIndex((statement) => pattern.test(statement))
  if (index < 0) throw new Error(`no statement matched ${pattern}`)
  return result.binds[index]
}

function expectRejected(
  outcome: ReturnType<typeof dispatch>['outcome'],
  message: RegExp,
) {
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('unreachable')
  expect(outcome.status).toBe(400)
  expect(outcome.reason).toMatch(message)
}

describe('file.milestone.* — role floor', () => {
  it.each([
    ['an owner (700)', 700, true],
    ['a maintainer (600)', 600, true],
    ['a project lead (500)', 500, false],
    ['a contributor (400)', 400, false],
    ['a viewer (100)', 100, false],
  ])('%s may set a milestone: %o', async (_label, role, allowed) => {
    const result = await authorizeRaw('file.milestone.set', VALID_SET, role)
    expect(result.ok).toBe(allowed)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('holds the same floor for removing one', async () => {
    const lead = await authorizeRaw('file.milestone.remove', { milestoneId: 'ms-1' }, 500)
    expect(lead.ok).toBe(false)
    const maintainer = await authorizeRaw('file.milestone.remove', { milestoneId: 'ms-1' }, 600)
    expect(maintainer.ok).toBe(true)
  })
})

describe('file.milestone.set — accepted writes', () => {
  it('writes the event row and the milestone row, and nothing else', async () => {
    const { outcome, sql } = dispatch(await authorized('file.milestone.set', VALID_SET))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')

    expect(outcome.result.dirtyTables).toEqual(['events', 'file_milestones'])
    expect(outcome.result.stmts).toHaveLength(2)
    // The guarantee the whole design rests on: no cell row is touched, so no
    // lane's translation goes stale and no cell's chain head advances.
    expect(sql.some((statement) => /\bcells\b/.test(statement))).toBe(false)
    expect(sql.some((statement) => /INSERT INTO file_milestones/.test(statement))).toBe(true)
    // Non-chain-mutating: the route only arbitrates events that claim a slot.
    expect(outcome.result.chainSlot).toBeUndefined()
  })

  it('upserts on the record id, so re-setting one is an edit', async () => {
    const { sql } = dispatch(await authorized('file.milestone.set', VALID_SET))
    const upsert = sql.find((statement) => statement.includes('INSERT INTO file_milestones'))
    expect(upsert).toMatch(/ON CONFLICT\(project_id, file_id, milestone_id\) DO UPDATE/)
    // created_at is NOT in the update list: a record's identity does not
    // restart because someone fixed a typo in its name.
    expect(upsert).not.toMatch(/created_at\s*=\s*EXCLUDED/)
    // Last writer wins on a race rather than whoever lands second.
    expect(upsert).toMatch(/WHERE COALESCE\(file_milestones\.server_seq, 0\) <= COALESCE\(EXCLUDED\.server_seq, 0\)/)
  })

  it('stores the name trimmed, by the shared rule', async () => {
    const result = dispatch(await authorized('file.milestone.set', {
      ...VALID_SET, name: '  The storm  ',
    }))
    expect(result.outcome.ok).toBe(true)
    // What is STORED is the normalized name, not the client's raw string:
    // trailing whitespace in a navigator row is invisible and would make two
    // milestones look identical.
    const bound = bindsFor(result, /INSERT INTO file_milestones/)
    expect(bound).toContain('The storm')
    expect(bound).not.toContain('  The storm  ')
  })

  it('stores the anchors, and no span — the covered cells are resolved on read', async () => {
    const result = dispatch(await authorized('file.milestone.set', VALID_SET))
    const bound = bindsFor(result, /INSERT INTO file_milestones/)
    expect(bound).toContain('cell-50')
    expect(bound).toContain('cell-70')
    // The columns are exactly the record: no cell list, no count, nothing that
    // could fall out of step with the file.
    const columns = result.sql.find((s) => s.includes('INSERT INTO file_milestones')) ?? ''
    expect(columns).not.toMatch(/cell_ids|cell_count|span/)
  })

  it('carries a file-scoped frame with no cell', async () => {
    const { outcome } = dispatch(await authorized('file.milestone.set', VALID_SET))
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.eventFrame).toMatchObject({
      t: 'event', kind: 'file.milestone.set', project: 'proj-a', file: 'file-x',
    })
    expect(outcome.result.eventFrame).not.toHaveProperty('cell')
  })
})

describe('file.milestone.set — returned refusals', () => {
  it.each([
    ['a blank name', { ...VALID_SET, name: '' }, /blank or whitespace-only/],
    ['a whitespace-only name', { ...VALID_SET, name: '   \t' }, /blank or whitespace-only/],
    ['a non-string name', { ...VALID_SET, name: 42 }, /blank or whitespace-only/],
    ['an over-long name', { ...VALID_SET, name: 'x'.repeat(201) }, /blank or whitespace-only/],
    ['an unusable id', { ...VALID_SET, milestoneId: 'has space' }, /unusable milestoneId/],
    ['an empty id', { ...VALID_SET, milestoneId: '' }, /unusable milestoneId/],
    ['no start cell', { ...VALID_SET, startCellId: '' }, /start cell and an end cell/],
    ['no end cell', { ...VALID_SET, endCellId: '' }, /start cell and an end cell/],
  ])('refuses %s without throwing', async (_label, payload, message) => {
    const { outcome } = dispatch(await authorized('file.milestone.set', payload))
    expectRejected(outcome, message)
  })
})

describe('file.milestone.remove', () => {
  it('deletes the row by id and touches no cell', async () => {
    const { outcome, sql } = dispatch(
      await authorized('file.milestone.remove', { milestoneId: 'ms-0199b0c4' }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.dirtyTables).toEqual(['events', 'file_milestones'])
    expect(sql.some((s) => /DELETE FROM file_milestones/.test(s))).toBe(true)
    expect(sql.some((s) => /\bcells\b/.test(s))).toBe(false)
  })

  it('refuses an unusable id', async () => {
    const { outcome } = dispatch(
      await authorized('file.milestone.remove', { milestoneId: 'has space' }),
    )
    expectRejected(outcome, /unusable milestoneId/)
  })
})
