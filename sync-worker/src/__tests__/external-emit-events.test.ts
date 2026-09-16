// Tests for EmitEvents (AQU-926, command registry §2): generalized event
// staging through the changeset engine. Asserts the §2 contract: floor =
// max(REQUIRED_ROLE) over the batch, testimony marking in the summary,
// disallowed-kind rejection, head-pin resolution + drift (plan_stale), the
// dynamic maintainer bumps (foreign unvalidate), file-lifecycle existence
// checks, and real perimeter routing (events + projections land, provenance
// stamped).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { ALLOWED_EMIT_KINDS, emitKindEffectLabel } from '../external/commands-emit-events'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-e'
const FILE = 'file-x'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 300
let nextCred = 100

async function memberToken(
  tdb: TestDb,
  level: number,
  username?: string,
): Promise<{ token: string; userId: number; username: string; credentialId: string }> {
  const userId = nextUserId++
  const name = username ?? `u${userId}`
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, name, `${name}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return { token, userId, username: name, credentialId }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, events: unknown[], extra: Record<string, unknown> = {}) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ kind: 'EmitEvents', events }], ...extra }),
    }), env,
  ))!
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }), env,
  ))!
  return { res, body: (await res.json()) as any }
}

/** Seed a target commit through the real perimeter so heads/chains are honest. */
async function seedTargetCommit(tdb: TestDb, cellId: string, eventId: string, value = 'existing') {
  const tok = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, userId: 999, username: 'seeder', role: 700 })
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (999, 'seeder', 's@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, 999, 700)
     ON CONFLICT DO NOTHING`,
    [PROJECT],
  )
  const create: RawEvent<'target.cell.create'> = {
    id: eventId, schemaVersion: 1, kind: 'target.cell.create',
    projectId: PROJECT, fileId: FILE, cellId, parentId: null,
    author: 'seeder', payload: { cellId, value }, clientTs: 1,
  }
  const res = await handleEventsWriteRequest(
    new Request('https://w/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [create] }),
    }),
    { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res!.status).toBe(200)
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 300
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'File X', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-2', side: 'source',
        value: 'source two', event_id: 'src-evt-2', last_edit_at: 1,
      },
    ],
  })
})

describe('EmitEvents — validation + floors', () => {
  it('rejects a kind outside ALLOWED_EMIT_KINDS with a teaching message', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, [
      { kind: 'target.cell.commit', fileId: FILE, cellId: 'cell-1', payload: { value: 'x' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    // AQU-1179: the rejection NAMES the kind — a caller must be able to tell
    // which of its events the door refused without diffing its own batch.
    expect(JSON.stringify(body.error.details)).toContain('target.cell.commit')
    expect(JSON.stringify(body.error.details)).toContain('not an allowed EmitEvents kind')
  })

  it('every allowlisted kind has a plain-language effect label (no raw kind reaches a reviewer)', () => {
    for (const kind of ALLOWED_EMIT_KINDS) {
      const one = emitKindEffectLabel(kind, 1)
      const many = emitKindEffectLabel(kind, 3)
      expect(one).not.toContain(kind)
      expect(many).toContain('3')
    }
    // An unknown kind degrades to the raw kind rather than an empty line.
    expect(emitKindEffectLabel('term.teleport', 2)).toBe('term.teleport × 2')
  })

  it('changeset floor is the max over event kinds: comment (200) + file.delete (500) needs 500', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const events = [
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'hi' } },
      { kind: 'file.delete', fileId: FILE },
    ]
    const { res: denied } = await prepare(env, contributor.token, events)
    expect(denied.status).toBe(403)

    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, events)
    expect(res.status).toBe(200)
    expect(body.changeset.status).toBe('staged')
  })

  it('uses the org assignment floor through agent prepare and commit', async () => {
    const env = makeEnv(tdb.db)
    const reviewer = await memberToken(tdb, 300)
    await tdb.pg.query(
      `INSERT INTO organizations (id, name, owner_user_id) VALUES (7, 'Test Org', $1)`,
      [reviewer.userId],
    )
    await tdb.pg.query(`UPDATE projects SET org_id = 7 WHERE id = $1`, [PROJECT])
    await tdb.pg.query(
      `INSERT INTO org_settings (org_id, settings, version, updated_by)
       VALUES (7, $1, 0, $2)`,
      [JSON.stringify({ assignmentMinRole: 300 }), reviewer.userId],
    )

    const { res: prepared, body } = await prepare(env, reviewer.token, [
      {
        kind: 'assignment.create',
        payload: {
          scopeKind: 'books',
          scope: [{ fileId: FILE }],
          scopeLabel: 'File X',
          assigneeUserId: reviewer.userId,
        },
      },
    ])
    expect(prepared.status).toBe(200)

    const { res: committed } = await commit(env, reviewer.token, body.changeset.id)
    expect(committed.status).toBe(200)
    expect(await tdb.rows('assignments')).toHaveLength(1)
  })

  it('rejects server-resolved pin fields supplied by the caller', async () => {
    const env = makeEnv(tdb.db)
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1', payload: { editEventId: 'evt-guess' } },
    ])
    expect(res.status).toBe(400)
    expect(JSON.stringify(body.error.details)).toContain('server-resolved')
  })

  it('summary marks testimony kinds and counts per kind', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-evt-1')
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'checked' } },
      { kind: 'comment.create', payload: { body: 'project-wide note' } },
    ])
    expect(res.status).toBe(200)
    expect(body.summary.events).toEqual([
      {
        kind: 'cell.validate',
        count: 1,
        testimony: true,
        label: 'Mark a translation as validated — recorded under your name',
      },
      { kind: 'comment.create', count: 2, testimony: false, label: 'Add 2 comments' },
    ])
  })

  it('a missing cell rejects the whole plan (no silent skip)', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, contributor.token, [
      { kind: 'cell.waive', fileId: FILE, cellId: 'cell-1', payload: { ruleId: 'r1' } },
      { kind: 'cell.waive', fileId: FILE, cellId: 'nope', payload: { ruleId: 'r1' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('events[1]')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('comment.create on a missing cell rejects at prepare (never burns an approval)', async () => {
    const env = makeEnv(tdb.db)
    const commenter = await memberToken(tdb, 200)
    const { res, body } = await prepare(env, commenter.token, [
      { kind: 'comment.create', fileId: FILE, cellId: 'nope', payload: { body: 'orphan note' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('events[0]')
    expect(body.error.message).toContain('does not exist')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('foreign unvalidate below maintainer is denied at prepare', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-evt-1')
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.unvalidate', fileId: FILE, cellId: 'cell-1', payload: { targetUsername: 'someone-else' } },
    ])
    expect(res.status).toBe(403)
    expect(body.error.message).toContain('maintainer')
  })

  it('file lifecycle existence: delete of a deleted file / restore of an active file are rejected', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res: badRestore } = await prepare(env, lead.token, [{ kind: 'file.restore', fileId: FILE }])
    expect(badRestore.status).toBe(400)

    await tdb.db.prepare(`UPDATE files SET deleted_at = 1 WHERE id = ?`).bind(FILE).run()
    const { res: badDelete } = await prepare(env, lead.token, [{ kind: 'file.delete', fileId: FILE }])
    expect(badDelete.status).toBe(400)
    const { res: okRestore } = await prepare(env, lead.token, [{ kind: 'file.restore', fileId: FILE }])
    expect(okRestore.status).toBe(200)
  })
})

describe('EmitEvents — commit', () => {
  it('comment + waive land through the perimeter with app-side projections and provenance', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const { body: prep } = await prepare(env, contributor.token, [
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'looks off' } },
      { kind: 'cell.waive', fileId: FILE, cellId: 'cell-2', payload: { ruleId: 'rule-9', reason: 'false positive' } },
    ])
    expect(prep.changeset.status).toBe('staged')

    const { res, body } = await commit(env, contributor.token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(body.receipt.appliedCount).toBe(2)

    const comments = await tdb.rows<{ body: string; author_id: string; scope_kind: string }>('comments')
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('looks off')
    expect(comments[0].author_id).toBe(contributor.username)
    expect(comments[0].scope_kind).toBe('cell')

    const waivers = await tdb.rows<{ rule_id: string; waived_by: string }>('cell_waivers')
    expect(waivers).toHaveLength(1)
    expect(waivers[0].rule_id).toBe('rule-9')

    // Provenance stamped on both events.
    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    for (const kind of ['comment.create', 'cell.waive']) {
      const ev = events.find((e) => e.kind === kind)!
      const prov = typeof ev.provenance === 'string' ? JSON.parse(ev.provenance) : ev.provenance as any
      expect(prov.origin).toBe('agent')
      expect(prov.changeset_id).toBe(prep.changeset.id)
      expect(prov.channel).toBe('rest')
    }

    // Idempotent re-commit.
    const { body: again } = await commit(env, contributor.token, prep.changeset.id)
    expect(again.receipt.eventIds).toEqual(body.receipt.eventIds)
  })

  it('cell.validate pins the live head; the validator row lands on it; head drift → plan_stale', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-evt-1')
    const reviewer = await memberToken(tdb, 300)

    // Happy path: pin + commit → cell_validators row on the pinned head.
    const { body: prep } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    const { res: ok } = await commit(env, reviewer.token, prep.changeset.id)
    expect(ok.status).toBe(200)
    const validators = await tdb.rows<{ event_id: string; username: string }>('cell_validators')
    expect(validators).toHaveLength(1)
    expect(validators[0].event_id).toBe('tgt-evt-1')
    expect(validators[0].username).toBe(reviewer.username)

    // Drift path: stage another validate, then move the head → plan_stale.
    const { body: prep2 } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    const editor = await memberToken(tdb, 400)
    const editorTok = await makeTestToken(SECRET, {
      projectId: PROJECT, fileId: FILE, userId: editor.userId, username: editor.username, role: 400,
    })
    const recommit: RawEvent<'target.cell.commit'> = {
      id: 'tgt-evt-2', schemaVersion: 1, kind: 'target.cell.commit',
      projectId: PROJECT, fileId: FILE, cellId: 'cell-1', parentId: 'tgt-evt-1',
      author: editor.username, payload: { value: 'revised', sourceEventId: 'src-evt-1' }, clientTs: 2,
    }
    await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${editorTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [recommit] }),
      }),
      { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
    )

    const { res: staleRes, body: staleBody } = await commit(env, reviewer.token, prep2.changeset.id)
    expect(staleRes.status).toBe(409)
    expect(staleBody.error.code).toBe('plan_stale')
  })

  it('target.cell.repin fills both pins and moves only source_event_id', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-evt-1')
    // The target starts pinned elsewhere (source moved since).
    await tdb.db
      .prepare(`UPDATE cells SET source_event_id = 'src-evt-0' WHERE cell_id = 'cell-1' AND side = 'target'`)
      .run()
    const reviewer = await memberToken(tdb, 300)

    const { body: prep } = await prepare(env, reviewer.token, [
      { kind: 'target.cell.repin', fileId: FILE, cellId: 'cell-1' },
    ])
    const { res } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(200)

    const cells = await tdb.rows<{ side: string; cell_id: string; source_event_id: string | null; event_id: string }>('cells')
    const target = cells.find((c) => c.side === 'target' && c.cell_id === 'cell-1')!
    expect(target.source_event_id).toBe('src-evt-1') // repinned to the live source
    expect(target.event_id).toBe('tgt-evt-1') // chain head untouched
  })

  it('cell.backtranslation.set pins targetEventId server-side', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-evt-1')
    const contributor = await memberToken(tdb, 400)
    const { body: prep } = await prepare(env, contributor.token, [
      { kind: 'cell.backtranslation.set', fileId: FILE, cellId: 'cell-1', payload: { btText: 'back' } },
    ])
    const { res } = await commit(env, contributor.token, prep.changeset.id)
    expect(res.status).toBe(200)
    const bts = await tdb.rows<{ bt_text: string; target_event_id: string; polished: number }>('cell_backtranslations')
    expect(bts).toHaveLength(1)
    expect(bts[0].bt_text).toBe('back')
    expect(bts[0].target_event_id).toBe('tgt-evt-1')
  })

  it('validate without a target translation is rejected at prepare', async () => {
    const env = makeEnv(tdb.db)
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('no target translation')
  })

  it('assignment.create routes under its first scope file and projects assignment rows', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const assignee = await memberToken(tdb, 400)
    const { body: prep } = await prepare(env, lead.token, [
      {
        kind: 'assignment.create',
        payload: {
          scopeKind: 'books',
          scope: [{ fileId: FILE }],
          scopeLabel: 'File X',
          assigneeUserId: assignee.userId,
        },
      },
    ])
    expect(prep.changeset.status).toBe('staged')
    const { res } = await commit(env, lead.token, prep.changeset.id)
    expect(res.status).toBe(200)

    const assignments = await tdb.rows<{ assignment_id: string; assignee_user_id: number; cells_total: number }>('assignments')
    expect(assignments).toHaveLength(1)
    expect(Number(assignments[0].assignee_user_id)).toBe(assignee.userId)
    expect(Number(assignments[0].cells_total)).toBe(2) // both source cells in FILE
    const acells = await tdb.rows('assignment_cells')
    expect(acells).toHaveLength(2)
  })

  it('the perimeter is the backstop: a mid-flight role revocation rejects the events', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const { body: prep } = await prepare(env, contributor.token, [
      { kind: 'cell.waive', fileId: FILE, cellId: 'cell-1', payload: { ruleId: 'r1' } },
    ])
    // Demote to viewer between prepare and commit — the commit core's own
    // precheck (or the perimeter) must refuse.
    await tdb.db
      .prepare(`UPDATE project_members SET role_level = 100 WHERE user_id = ?`)
      .bind(contributor.userId)
      .run()
    const { res, body } = await commit(env, contributor.token, prep.changeset.id)
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })
})

describe('EmitEvents — catalog coherence', () => {
  it('every allowed kind is a real event kind with a REQUIRED_ROLE floor', async () => {
    const { REQUIRED_ROLE } = await import('../events/role-policy')
    for (const kind of ALLOWED_EMIT_KINDS) {
      expect(REQUIRED_ROLE[kind as keyof typeof REQUIRED_ROLE]).toBeGreaterThan(0)
    }
  })
})

// ── AQU-999: foreign-comment floors on the external emit path ──────────────
//
// The Agent API prepare gate must read the same FOREIGN_COMMENT_ROLE table the
// /events perimeter does: a contributor-scoped credential can resolve/reopen a
// thread it did not author, but still cannot edit or delete one.

/** Seed a comment authored by `authorUsername` directly into the projection. */
async function seedForeignComment(
  tdb: TestDb,
  commentId: string,
  authorUsername: string,
  resolved = false,
): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO comments (
       comment_id, project_id, scope_kind, file_id, cell_id, parent_comment_id,
       body, resolved, author_id, author_label, created_at, updated_at, deleted_at
     ) VALUES ($1, $2, 'project', NULL, NULL, NULL, 'seeded body', $3, $4, $4, 1, 1, NULL)`,
    [commentId, PROJECT, resolved ? 1 : 0, authorUsername],
  )
}

describe('EmitEvents — AQU-999 foreign comment floors', () => {
  it('contributor credential CAN stage a foreign comment.resolve', async () => {
    const env = makeEnv(tdb.db)
    await seedForeignComment(tdb, 'cmt-ext-res', 'someone-else')
    const contributor = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, contributor.token, [
      { kind: 'comment.resolve', payload: { commentId: 'cmt-ext-res', resolved: true } },
    ])
    expect(res.status).toBe(200)
    expect(body.changeset.status).toBe('staged')
  })

  it('contributor credential CAN stage a foreign reopen (resolved: false)', async () => {
    const env = makeEnv(tdb.db)
    await seedForeignComment(tdb, 'cmt-ext-reopen', 'someone-else', true)
    const contributor = await memberToken(tdb, 400)
    const { res } = await prepare(env, contributor.token, [
      { kind: 'comment.resolve', payload: { commentId: 'cmt-ext-reopen', resolved: false } },
    ])
    expect(res.status).toBe(200)
  })

  it('reviewer credential is still denied a foreign comment.resolve', async () => {
    const env = makeEnv(tdb.db)
    await seedForeignComment(tdb, 'cmt-ext-rev', 'someone-else')
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'comment.resolve', payload: { commentId: 'cmt-ext-rev', resolved: true } },
    ])
    expect(res.status).toBe(403)
    expect(body.error.message).toContain('contributor')
  })

  it('contributor credential is still denied a foreign comment.edit / comment.delete', async () => {
    const env = makeEnv(tdb.db)
    await seedForeignComment(tdb, 'cmt-ext-edit', 'someone-else')
    await seedForeignComment(tdb, 'cmt-ext-del', 'someone-else')
    const contributor = await memberToken(tdb, 400)

    const { res: editRes, body: editBody } = await prepare(env, contributor.token, [
      { kind: 'comment.edit', payload: { commentId: 'cmt-ext-edit', body: 'rewritten' } },
    ])
    expect(editRes.status).toBe(403)
    expect(editBody.error.message).toContain('maintainer')

    const { res: delRes, body: delBody } = await prepare(env, contributor.token, [
      { kind: 'comment.delete', payload: { commentId: 'cmt-ext-del' } },
    ])
    expect(delRes.status).toBe(403)
    expect(delBody.error.message).toContain('maintainer')
  })
})

// ── AQU-1179: terminology through the generic door ─────────────────────────
// The ticket's widening: term.* is the only one of "term, rule, memory" that
// has event kinds (rules live in the settings blob, memory in auth-worker), so
// it is the whole of the v1 addition. What matters here is the SPLIT the
// termbase authority draws — suggesting is contributor work, binding is
// management work — surviving the trip through the changeset engine.

/** Seed a concept straight into the projection (the state a prior term.create
 *  would have left), so authority tests don't depend on the write path. */
async function seedConcept(
  tdb: TestDb,
  conceptId: string,
  status: 'draft' | 'active' = 'draft',
): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO concepts (
       concept_id, project_id, source_term, renderings, notes,
       status, case_sensitive, created_by, created_at, updated_at, deleted_at
     ) VALUES ($1, $2, 'covenant', '[]'::jsonb, NULL, $3, 0, 'seeder', 1, 1, NULL)`,
    [conceptId, PROJECT, status],
  )
}

const DRAFT_TERM = {
  kind: 'term.create',
  payload: {
    sourceTerm: 'covenant',
    renderings: [{ rendering: 'заповіт', status: 'preferred' }],
    status: 'draft',
  },
}

describe('EmitEvents — terminology (AQU-1179)', () => {
  it('a contributor suggests a draft term: prepare → commit → the concept lands', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    const { res, body: prep } = await prepare(env, contributor.token, [DRAFT_TERM])
    expect(res.status).toBe(200)
    expect(prep.summary.events).toEqual([
      { kind: 'term.create', count: 1, testimony: false, label: 'Add a glossary term' },
    ])

    const { res: ok, body } = await commit(env, contributor.token, prep.changeset.id)
    expect(ok.status).toBe(200)
    expect(body.receipt.appliedCount).toBe(1)

    const concepts = await tdb.rows<{
      concept_id: string
      source_term: string
      status: string
      created_by: string
      renderings: unknown
    }>('concepts')
    expect(concepts).toHaveLength(1)
    expect(concepts[0].source_term).toBe('covenant')
    expect(concepts[0].status).toBe('draft')
    expect(concepts[0].created_by).toBe(contributor.username)
    // Server-minted concept id (the caller omitted one) — a real uuid, and the
    // same one a crash-retry would re-post.
    expect(concepts[0].concept_id).toMatch(/^[0-9a-f-]{36}$/)

    // Project-scoped: the events row carries no file.
    const events = await tdb.rows<{ kind: string; file_id: string | null }>('events')
    const created = events.find((e) => e.kind === 'term.create')!
    expect(created.file_id).toBeNull()

    // Idempotent re-commit re-posts the same ids rather than a second concept.
    await commit(env, contributor.token, prep.changeset.id)
    expect(await tdb.rows('concepts')).toHaveLength(1)
  })

  it('binding term writes are denied below the org termbase floor; suggesting is not', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    await seedConcept(tdb, 'concept-1')

    // Creating an already-active term IS approving it in one step.
    const { res: activeRes, body: activeBody } = await prepare(env, contributor.token, [
      { ...DRAFT_TERM, payload: { ...DRAFT_TERM.payload, status: 'active' } },
    ])
    expect(activeRes.status).toBe(403)
    expect(activeBody.error.code).toBe('permission_denied')
    expect(activeBody.error.message).toContain('500')

    for (const event of [
      { kind: 'term.approve', payload: { conceptId: 'concept-1' } },
      { kind: 'term.update', payload: { conceptId: 'concept-1', sourceTerm: 'pact' } },
      { kind: 'term.delete', payload: { conceptId: 'concept-1' } },
      { kind: 'term.reject', payload: { conceptId: 'concept-1', mode: 'deprecate' } },
    ]) {
      const { res } = await prepare(env, contributor.token, [event])
      expect(res.status, `${event.kind} must be gated`).toBe(403)
    }
    expect(await tdb.rows('changesets')).toHaveLength(0)

    // The same approve at the floor stages and lands.
    const lead = await memberToken(tdb, 500)
    const { body: prep } = await prepare(env, lead.token, [
      { kind: 'term.approve', payload: { conceptId: 'concept-1' } },
    ])
    const { res: ok } = await commit(env, lead.token, prep.changeset.id)
    expect(ok.status).toBe(200)
    const concepts = await tdb.rows<{ status: string }>('concepts')
    expect(concepts[0].status).toBe('active')
  })

  it('approving a concept that is not a draft is refused, not applied as a silent no-op', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    await seedConcept(tdb, 'concept-1', 'active')
    const { res, body } = await prepare(env, lead.token, [
      { kind: 'term.approve', payload: { conceptId: 'concept-1' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('not a draft')
  })

  it('a term.create naming an existing concept is rejected rather than overwriting it', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)
    await seedConcept(tdb, 'concept-1')
    const { res, body } = await prepare(env, contributor.token, [
      { ...DRAFT_TERM, payload: { ...DRAFT_TERM.payload, conceptId: 'concept-1' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('already exists')
  })

  it('a term write against a missing concept rejects the whole plan at prepare', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, [
      DRAFT_TERM,
      { kind: 'term.approve', payload: { conceptId: 'ghost' } },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('events[1]')
    expect(body.error.message).toContain('does not exist')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('rejects a scoped envelope and a laundered status patch', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    await seedConcept(tdb, 'concept-1')

    const { res: scoped, body: scopedBody } = await prepare(env, lead.token, [
      { ...DRAFT_TERM, fileId: FILE },
    ])
    expect(scoped.status).toBe(400)
    expect(JSON.stringify(scopedBody.error.details)).toContain('project-level')

    const { res: laundered, body: launderedBody } = await prepare(env, lead.token, [
      { kind: 'term.update', payload: { conceptId: 'concept-1', status: 'active' } },
    ])
    expect(laundered.status).toBe(400)
    expect(JSON.stringify(launderedBody.error.details)).toContain('term.approve')
  })

  it('a concept deleted between prepare and commit makes the plan stale, not a silent no-op', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    await seedConcept(tdb, 'concept-1')
    const { body: prep } = await prepare(env, lead.token, [
      { kind: 'term.update', payload: { conceptId: 'concept-1', sourceTerm: 'pact' } },
    ])
    await tdb.db.prepare(`UPDATE concepts SET deleted_at = 2 WHERE concept_id = ?`).bind('concept-1').run()

    const { res, body } = await commit(env, lead.token, prep.changeset.id)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('plan_stale')
  })
})
