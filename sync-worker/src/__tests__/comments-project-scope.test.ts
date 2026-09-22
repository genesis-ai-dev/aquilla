// AQU-1296 — comment identity is PROJECT-SCOPED.
//
// `comments.comment_id` used to be a global primary key while comment ids are
// only unique within a project (the Codex importer namespaces the event id and
// the file id per project but leaves `payload.commentId` as the raw legacy id).
// Two projects importing the same source therefore emitted identical comment
// ids, and `ON CONFLICT(comment_id) DO NOTHING` silently swallowed the second
// project's every insert — 3,348 rows across ~20 production projects were
// invisible for three months with nothing logged anywhere.
//
// The same missing scope made the mutating projections and the ownership
// lookup that backs comment authorization match on `comment_id` alone, so an
// action in project A could read or write project B's row.
//
// These tests pin the corrected behavior at both levels: the projection (does
// the right row change?) and the route (is the authorization decision made
// against the right row?). They run against real Postgres (PGlite) using the
// canonical db/postgres/schema.sql, so the composite key itself is under test.

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { handleEventsWriteRequest } from '../events/route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { EventKind, RawEvent } from '../events/types'

const SECRET = 'comments-project-scope-secret'

/** The id both projects reuse — the collision this ticket is about. */
const SHARED_ID = 'shared-id-1'

// ── Projection-level helpers ───────────────────────────────────────────────

let evtSeq = 0

function makeEvent<K extends EventKind>(
  kind: K,
  projectId: string,
  payload: unknown,
  overrides: Partial<PersistedEvent> = {},
): PersistedEvent<K> {
  evtSeq += 1
  return {
    id: `evt-${evtSeq}`,
    schemaVersion: 1,
    projectId,
    fileId: null,
    cellId: null,
    parentId: null,
    kind,
    author: 'alice',
    payload,
    clientTs: 1000 + evtSeq,
    serverTs: 2000 + evtSeq,
    serverSeq: evtSeq,
    ...overrides,
  } as PersistedEvent<K>
}

/** Build + run one event's projection statements. */
async function project<K extends EventKind>(
  db: AquillaDb,
  event: PersistedEvent<K>,
): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(db, event, stmts)
  await db.batch(stmts)
}

interface CommentRow {
  comment_id: string
  project_id: string
  body: string
  resolved: number
  deleted_at: number | null
  author_id: string
  scope_kind: string
  cell_id: string | null
}

/** The single comments row for (projectId, commentId), or undefined. */
async function readComment(
  t: TestDb,
  projectId: string,
  commentId: string,
): Promise<CommentRow | undefined> {
  const rows = await t.rows<CommentRow>('comments')
  return rows.find((r) => r.project_id === projectId && r.comment_id === commentId)
}

/** A comment.create for `projectId` reusing SHARED_ID. */
function sharedCreate(
  projectId: string,
  body: string,
  extra: { author?: string; scope?: unknown; commentId?: string } = {},
) {
  return makeEvent(
    'comment.create',
    projectId,
    {
      commentId: extra.commentId ?? SHARED_ID,
      scope: extra.scope ?? { kind: 'project' },
      body,
      parentCommentId: null,
    },
    { author: extra.author ?? 'alice' },
  )
}

// ── Projection ─────────────────────────────────────────────────────────────

describe('comment.create — project-scoped identity', () => {
  it('lets two projects each hold their own row for the same comment id', async () => {
    const t = await makeTestDb()
    await project(t.db, sharedCreate('proj-a', 'Project A comment'))
    await project(t.db, sharedCreate('proj-b', 'Project B comment'))

    // Before AQU-1296 the second insert was swallowed by
    // ON CONFLICT(comment_id) and only project A's row existed.
    const a = await readComment(t, 'proj-a', SHARED_ID)
    const b = await readComment(t, 'proj-b', SHARED_ID)
    expect(a?.body).toBe('Project A comment')
    expect(b?.body).toBe('Project B comment')

    const all = await t.rows<CommentRow>('comments')
    expect(all.filter((r) => r.comment_id === SHARED_ID)).toHaveLength(2)
  })

  it('keeps each project row on its own scope', async () => {
    const t = await makeTestDb()
    await project(
      t.db,
      sharedCreate('proj-a', 'On a cell', {
        scope: { kind: 'cell', fileId: 'file-a', cellId: 'cell-1' },
      }),
    )
    await project(t.db, sharedCreate('proj-b', 'On the project', { scope: { kind: 'project' } }))

    expect((await readComment(t, 'proj-a', SHARED_ID))?.scope_kind).toBe('cell')
    expect((await readComment(t, 'proj-a', SHARED_ID))?.cell_id).toBe('cell-1')
    expect((await readComment(t, 'proj-b', SHARED_ID))?.scope_kind).toBe('project')
    expect((await readComment(t, 'proj-b', SHARED_ID))?.cell_id).toBeNull()
  })

  // The deterministic commentCreateEventId design depends on this: an import
  // replayed into the SAME project must converge, not duplicate or error.
  it('is still a no-op when the identical create replays into the same project', async () => {
    const t = await makeTestDb()
    await project(t.db, sharedCreate('proj-a', 'First write wins'))
    await project(t.db, sharedCreate('proj-a', 'Second write must not clobber'))

    const rows = (await t.rows<CommentRow>('comments')).filter((r) => r.project_id === 'proj-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe('First write wins')
  })
})

describe('comment mutations stay inside their own project', () => {
  /** Seed the same comment id into both projects, authored by alice. */
  async function seedBoth(t: TestDb): Promise<void> {
    await project(t.db, sharedCreate('proj-a', 'A body'))
    await project(t.db, sharedCreate('proj-b', 'B body'))
  }

  it('comment.edit in project B leaves project A untouched', async () => {
    const t = await makeTestDb()
    await seedBoth(t)
    await project(
      t.db,
      makeEvent('comment.edit', 'proj-b', { commentId: SHARED_ID, body: 'B edited' }),
    )

    expect((await readComment(t, 'proj-a', SHARED_ID))?.body).toBe('A body')
    expect((await readComment(t, 'proj-b', SHARED_ID))?.body).toBe('B edited')
  })

  // The maintainer path drops the author_id predicate, so it is the widest
  // UPDATE in the file and the one most exposed to a missing project scope.
  it('comment.edit on the maintainer path in B leaves project A untouched', async () => {
    const t = await makeTestDb()
    await seedBoth(t)
    await project(
      t.db,
      makeEvent(
        'comment.edit',
        'proj-b',
        { commentId: SHARED_ID, body: 'B edited by maintainer' },
        { author: 'carol', callerRole: 600 },
      ),
    )

    expect((await readComment(t, 'proj-a', SHARED_ID))?.body).toBe('A body')
    expect((await readComment(t, 'proj-b', SHARED_ID))?.body).toBe('B edited by maintainer')
  })

  it('comment.delete in project B leaves project A undeleted', async () => {
    const t = await makeTestDb()
    await seedBoth(t)
    await project(t.db, makeEvent('comment.delete', 'proj-b', { commentId: SHARED_ID }))

    const a = await readComment(t, 'proj-a', SHARED_ID)
    const b = await readComment(t, 'proj-b', SHARED_ID)
    expect(a?.deleted_at).toBeNull()
    expect(a?.body).toBe('A body')
    expect(b?.deleted_at).not.toBeNull()
    expect(b?.body).toBe('')
  })

  it('comment.delete on the maintainer path in B leaves project A undeleted', async () => {
    const t = await makeTestDb()
    await seedBoth(t)
    await project(
      t.db,
      makeEvent(
        'comment.delete',
        'proj-b',
        { commentId: SHARED_ID },
        { author: 'carol', callerRole: 600 },
      ),
    )

    expect((await readComment(t, 'proj-a', SHARED_ID))?.deleted_at).toBeNull()
    expect((await readComment(t, 'proj-b', SHARED_ID))?.deleted_at).not.toBeNull()
  })

  // Step 4 of the ticket's repro: resolving in B used to flip A's row.
  it('comment.resolve in project B leaves project A unresolved', async () => {
    const t = await makeTestDb()
    await seedBoth(t)
    await project(
      t.db,
      makeEvent('comment.resolve', 'proj-b', { commentId: SHARED_ID, resolved: true }),
    )

    expect((await readComment(t, 'proj-a', SHARED_ID))?.resolved).toBe(0)
    expect((await readComment(t, 'proj-b', SHARED_ID))?.resolved).toBe(1)
  })

  // Already project-scoped before this ticket — pinned so the cascade is not
  // "simplified" to match the (previously unscoped) comment.delete projection.
  it('the cell-delete cascade soft-deletes only its own project threads', async () => {
    const t = await makeTestDb()
    const cellScope = { kind: 'cell', fileId: 'file-x', cellId: 'cell-1' }
    await project(t.db, sharedCreate('proj-a', 'A thread on the cell', { scope: cellScope }))
    await project(t.db, sharedCreate('proj-b', 'B thread on the cell', { scope: cellScope }))

    await project(
      t.db,
      makeEvent(
        'source.cell.delete',
        'proj-b',
        { cellId: 'cell-1' },
        { fileId: 'file-x', cellId: 'cell-1' },
      ),
    )

    expect((await readComment(t, 'proj-a', SHARED_ID))?.deleted_at).toBeNull()
    expect((await readComment(t, 'proj-b', SHARED_ID))?.deleted_at).not.toBeNull()
  })
})

// ── Authorization (full route layer) ───────────────────────────────────────
//
// prefetchCommentAuthors backs the foreign-comment-ownership check. When it
// matched on comment_id alone it could answer "who owns this?" with ANOTHER
// project's author_id — an authorization decision made against a row the
// event never touches.

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function makeToken(projectId: string, role: number, username: string): Promise<string> {
  return makeTestToken(SECRET, { projectId, fileId: 'file-x', role, username } as never)
}

async function post(db: AquillaDb, event: RawEvent, token: string) {
  const request = new Request('https://worker/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [event] }),
  })
  const res = await handleEventsWriteRequest(request, makeEnv(db))
  return (await res!.json()) as { accepted: unknown[]; rejected: Array<{ status: number }> }
}

let routeSeq = 0

function rawEvent<K extends EventKind>(
  kind: K,
  projectId: string,
  author: string,
  payload: unknown,
): RawEvent<K> {
  routeSeq += 1
  return {
    id: `route-evt-${routeSeq}`,
    schemaVersion: 1,
    kind,
    projectId,
    fileId: 'file-x',
    cellId: undefined,
    parentId: null,
    author,
    payload,
    clientTs: 100 + routeSeq,
  } as RawEvent<K>
}

/** Post a comment.create for `projectId` authored by `author`. */
async function seedCommentVia(
  db: AquillaDb,
  projectId: string,
  author: string,
  commentId = SHARED_ID,
): Promise<void> {
  const token = await makeToken(projectId, 200, author)
  const body = await post(
    db,
    rawEvent('comment.create', projectId, author, {
      commentId,
      scope: { kind: 'project' },
      body: `seeded in ${projectId}`,
      parentCommentId: null,
    }),
    token,
  )
  expect(body.rejected).toHaveLength(0)
}

describe('comment ownership is resolved within the acting project', () => {
  it('authoring a same-id comment in project A does not grant edit rights in project B', async () => {
    const t = await makeTestDb()
    // bob owns SHARED_ID in project A; alice owns SHARED_ID in project B.
    await seedCommentVia(t.db, 'proj-a', 'bob')
    await seedCommentVia(t.db, 'proj-b', 'alice')

    // bob, a mere commenter(200) in project B, tries to edit project B's row.
    // The old global lookup would have found HIS project-A row, read him as
    // the author, and waved the foreign-comment maintainer floor through.
    const bobInB = await makeToken('proj-b', 200, 'bob')
    const body = await post(
      t.db,
      rawEvent('comment.edit', 'proj-b', 'bob', { commentId: SHARED_ID, body: 'hijacked' }),
      bobInB,
    )

    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].status).toBe(403)
    expect((await readComment(t, 'proj-b', SHARED_ID))?.body).toBe('seeded in proj-b')
  })

  it('a real author is still recognised in their own project (self-edit)', async () => {
    const t = await makeTestDb()
    // A same-id comment by a DIFFERENT author exists in project A — the old
    // lookup could have returned it and held alice to the maintainer floor on
    // her own comment.
    await seedCommentVia(t.db, 'proj-a', 'bob')
    await seedCommentVia(t.db, 'proj-b', 'alice')

    const aliceInB = await makeToken('proj-b', 200, 'alice')
    const body = await post(
      t.db,
      rawEvent('comment.edit', 'proj-b', 'alice', { commentId: SHARED_ID, body: 'alice edited' }),
      aliceInB,
    )

    expect(body.rejected).toHaveLength(0)
    expect(body.accepted).toHaveLength(1)
    expect((await readComment(t, 'proj-b', SHARED_ID))?.body).toBe('alice edited')
  })

  it('the maintainer override still works on a foreign comment', async () => {
    const t = await makeTestDb()
    await seedCommentVia(t.db, 'proj-a', 'bob')
    await seedCommentVia(t.db, 'proj-b', 'alice')

    const carolInB = await makeToken('proj-b', 600, 'carol')
    const body = await post(
      t.db,
      rawEvent('comment.delete', 'proj-b', 'carol', { commentId: SHARED_ID }),
      carolInB,
    )

    expect(body.rejected).toHaveLength(0)
    expect((await readComment(t, 'proj-b', SHARED_ID))?.deleted_at).not.toBeNull()
    // …and project A's same-id row is untouched.
    expect((await readComment(t, 'proj-a', SHARED_ID))?.deleted_at).toBeNull()
  })
})

// ── Reconciliation invariant ───────────────────────────────────────────────

describe('reconciliation invariant', () => {
  // The exact query from AQU-1296 and scripts/check-comment-projection.ts.
  // Its silence was the failure mode: no error, no log, just missing rows.
  const INVARIANT_SQL = `
    SELECT project_id, count(*)::int AS invisible
      FROM events e
     WHERE e.kind = 'comment.create'
       AND NOT EXISTS (SELECT 1 FROM comments c
                        WHERE c.comment_id = e.payload::json->>'commentId'
                          AND c.project_id = e.project_id)
     GROUP BY 1 HAVING count(*) > 0`

  it('returns zero rows when the same comment id is imported into two projects', async () => {
    const t = await makeTestDb()
    await seedCommentVia(t.db, 'proj-a', 'alice')
    await seedCommentVia(t.db, 'proj-b', 'alice')

    // Both creates are in the event log…
    const events = await t.rows<{ kind: string }>('events')
    expect(events.filter((e) => e.kind === 'comment.create')).toHaveLength(2)

    // …and each has a row in its OWN project. Pre-fix, project B's create
    // showed up here as one invisible row.
    const { rows } = await t.pg.query(INVARIANT_SQL)
    expect(rows).toEqual([])
  })
})
