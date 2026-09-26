// Agent API cell comments (AQU-1233).
//
// Two halves of one contract:
//   READ  — GET /api/v1/external/projects/:projectId/comments lists the same
//           threads the in-app drawer shows, with author identity pseudonymous
//           by default.
//   REPLY — an EmitEvents changeset carrying comment.create + parentCommentId
//           posts AS the credential's minting user, marked "via agent", through
//           the /events perimeter (so the normal notification path fires).
//
// The write half runs through the real changeset engine and the real events
// route rather than inserting comment rows directly: the marker, the
// authorship and the notification all live on that path, and a test that
// short-circuits it would prove none of them.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalCommentsRequest } from '../external/comments-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleCommentsReadRequest } from '../events/comments-read-route'
import { AGENT_COMMENT_LABEL_SUFFIX } from '../events/comment-authorship'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT = 'proj-c'
const OTHER_PROJECT = 'proj-other'
const FILE = 'file-x'

interface Env {
  AQUILLA_PG: AquillaDb
  SYNC_SECRET_KEY: string
  BASE_URL: string
  EMAIL?: { send: (m: unknown) => Promise<{ messageId: string }> }
}

function makeEnv(db: AquillaDb, extra: Partial<Env> = {}): Env {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app', ...extra }
}

let nextUserId = 500
let nextCred = 200

interface Member {
  token: string
  userId: number
  username: string
  credentialId: string
}

async function memberToken(
  tdb: TestDb,
  level: number,
  opts: { projectId?: string; scopeProjectId?: string | null; pii?: boolean } = {},
): Promise<Member> {
  const userId = nextUserId++
  const username = `u${userId}`
  await tdb.pg.query(`INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`, [
    userId,
    username,
    `${username}@x.com`,
  ])
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [opts.projectId ?? PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, pii)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5, $6)`,
    [
      credentialId,
      String(userId),
      tokenPrefix,
      tokenHash,
      opts.scopeProjectId === undefined ? (opts.projectId ?? PROJECT) : opts.scopeProjectId,
      opts.pii === true,
    ],
  )
  return { token, userId, username, credentialId }
}

/** Set the project's `agentAuthorship` policy the same way AQU-1180's own
 *  tests do (external-pii.test.ts) — through project_settings, not a raw
 *  column, since that's what resolveAuthorshipPolicy actually reads. */
async function setAgentAuthorship(tdb: TestDb, projectId: string, value: string): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings) VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [projectId, JSON.stringify({ agentAuthorship: value })],
  )
}

/** Post a comment the way a person does: straight into the projection table,
 *  as the in-app write already projects it (no agent marker). */
async function seedHumanComment(
  tdb: TestDb,
  opts: {
    commentId: string
    author: string
    body: string
    cellId?: string | null
    parentCommentId?: string | null
    createdAt?: number
    projectId?: string
  },
): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO comments (comment_id, project_id, scope_kind, file_id, cell_id, parent_comment_id,
                           body, resolved, author_id, author_label, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $9, $9)`,
    [
      opts.commentId,
      opts.projectId ?? PROJECT,
      opts.cellId === null ? 'project' : 'cell',
      opts.cellId === null ? null : FILE,
      opts.cellId === null ? null : (opts.cellId ?? 'cell-1'),
      opts.parentCommentId ?? null,
      opts.body,
      opts.author,
      opts.createdAt ?? 1000,
    ],
  )
}

function externalReq(path: string, token: string): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

interface ExternalCommentBody {
  data: Array<{
    commentId: string
    body: string
    author: string
    viaAgent: boolean
    parentCommentId: string | null
    cellId: string | null
    cellRef: string | null
    resolved: boolean
  }>
  nextCursor: string | null
}

async function readComments(env: Env, token: string, query = ''): Promise<{ status: number; body: ExternalCommentBody }> {
  const res = (await handleExternalCommentsRequest(externalReq(`/comments${query}`, token), env))!
  return { status: res.status, body: (await res.json()) as ExternalCommentBody }
}

async function prepare(env: Env, token: string, events: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ kind: 'EmitEvents', events }] }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as Record<string, never> & { changeset: { id: string }; error: { code: string; message: string } } }
}

async function commit(env: Env, token: string, id: string, ctx?: { waitUntil: (p: Promise<unknown>) => void }) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    ctx,
  ))!
  return { res, body: (await res.json()) as { receipt?: { appliedCount: number } } }
}

let tdb: TestDb

beforeEach(async () => {
  nextUserId = 500
  tdb = await makeTestDb({
    projects: [
      { id: PROJECT, name: 'P', created_by: 98, org_id: null },
      { id: OTHER_PROJECT, name: 'Other', created_by: 98, org_id: null },
    ],
    files: [{ id: FILE, project_id: PROJECT, name: 'File X', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT,
        file_id: FILE,
        cell_id: 'cell-1',
        side: 'source',
        value: 'In the beginning',
        event_id: 'src-evt-1',
        last_edit_at: 1,
        canonical_ref: 'GEN 1:1',
      },
      {
        project_id: PROJECT,
        file_id: FILE,
        cell_id: 'cell-2',
        side: 'source',
        value: 'And the earth',
        event_id: 'src-evt-2',
        last_edit_at: 1,
      },
    ],
  })
})

describe('AQU-1233 — agent comment reads', () => {
  it("lists a cell's threads with the same content the in-app read returns", async () => {
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400)
    await seedHumanComment(tdb, { commentId: 'c-root', author: 'reviewer', body: 'use the 1984 wording', createdAt: 1000 })
    await seedHumanComment(tdb, {
      commentId: 'c-reply',
      author: 'translator',
      body: 'which verse?',
      parentCommentId: 'c-root',
      createdAt: 2000,
    })
    // A thread on a different cell must not leak into a cell-scoped read.
    await seedHumanComment(tdb, { commentId: 'c-other-cell', author: 'reviewer', body: 'unrelated', cellId: 'cell-2', createdAt: 3000 })

    const { status, body } = await readComments(env, agent.token, `?fileId=${FILE}&cellId=cell-1`)
    expect(status).toBe(200)
    expect(body.data.map((c) => c.commentId)).toEqual(['c-root', 'c-reply'])
    expect(body.data.map((c) => c.body)).toEqual(['use the 1984 wording', 'which verse?'])
    expect(body.data[0].parentCommentId).toBeNull()
    expect(body.data[1].parentCommentId).toBe('c-root')
    expect(body.data[0].cellRef).toBe('GEN 1:1')

    // Same threads, same order as the in-app drawer's own read.
    const syncToken = await makeTestToken(SECRET, {
      projectId: PROJECT,
      fileId: FILE,
      userId: agent.userId,
      username: agent.username,
      role: 400,
    })
    const inApp = (await handleCommentsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/comments?fileId=${FILE}&cellId=cell-1`, {
        headers: { Authorization: `Bearer ${syncToken}` },
      }),
      env,
    ))!
    const inAppBody = (await inApp.json()) as { comments: Array<{ commentId: string; body: string }> }
    expect(body.data.map((c) => c.commentId)).toEqual(inAppBody.comments.map((c) => c.commentId))
    expect(body.data.map((c) => c.body)).toEqual(inAppBody.comments.map((c) => c.body))
  })

  it('pseudonymizes authors by default: stable per project, unlinkable across projects, no username anywhere', async () => {
    const env = makeEnv(tdb.db)
    // Unscoped credential: it can reach both projects, which is exactly the
    // shape the cross-project unlinkability claim has to survive.
    const agent = await memberToken(tdb, 400, { scopeProjectId: null })
    await seedHumanComment(tdb, { commentId: 'c-1', author: 'reviewer', body: 'one', createdAt: 1000 })
    await seedHumanComment(tdb, { commentId: 'c-2', author: 'reviewer', body: 'two', createdAt: 2000 })
    await seedHumanComment(tdb, { commentId: 'c-3', author: 'translator', body: 'three', createdAt: 3000 })

    const res = (await handleExternalCommentsRequest(externalReq('/comments', agent.token), env))!
    const raw = await res.text()
    const body = JSON.parse(raw) as ExternalCommentBody

    for (const c of body.data) expect(c.author).toMatch(/^u_[0-9a-f]{8}$/)
    // Same human → same id; different humans → different ids.
    expect(body.data[0].author).toBe(body.data[1].author)
    expect(body.data[2].author).not.toBe(body.data[0].author)
    // Nothing identifying survives — not the username, not the raw label.
    expect(raw).not.toContain('reviewer')
    expect(raw).not.toContain('translator')
    expect(raw).not.toContain('authorLabel')

    // The same person in another project is a DIFFERENT id, so two agents
    // holding tokens for two projects cannot re-identify by intersection.
    await tdb.pg.query(`INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, 400)`, [
      OTHER_PROJECT,
      agent.userId,
    ])
    await seedHumanComment(tdb, { commentId: 'c-elsewhere', author: 'reviewer', body: 'over here', cellId: null, projectId: OTHER_PROJECT })
    const elsewhere = (await handleExternalCommentsRequest(
      new Request(`https://w/api/v1/external/projects/${OTHER_PROJECT}/comments`, {
        headers: { Authorization: `Bearer ${agent.token}` },
      }),
      makeEnv(tdb.db),
    ))!
    const elsewhereBody = (await elsewhere.json()) as ExternalCommentBody
    expect(elsewhereBody.data[0].author).not.toBe(body.data[0].author)
  })

  it('a credential minted with the pii grant reads real identities', async () => {
    // The `pii` grant itself is minted by AQU-1180 (owner-only, default off).
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400, { pii: true })
    await seedHumanComment(tdb, { commentId: 'c-1', author: 'reviewer', body: 'one' })

    const { status, body } = await readComments(env, agent.token, `?fileId=${FILE}&cellId=cell-1`)
    expect(status).toBe(200)
    expect(body.data[0].author).toBe('reviewer')
  })

  it("honors the project's agentAuthorship: 'none' opt-out — author is absent, not just pseudonymous", async () => {
    // Regression: this route used to key identity mode off the credential's
    // `pii` flag alone and never consulted the project's own opt-out, unlike
    // every other agent-facing read route (found in the 2026-09-17 pen test —
    // see external/pii.ts's resolveAuthorshipPolicy).
    const env = makeEnv(tdb.db)
    await setAgentAuthorship(tdb, PROJECT, 'none')
    const agent = await memberToken(tdb, 400)
    await seedHumanComment(tdb, { commentId: 'c-1', author: 'reviewer', body: 'one' })

    const res = (await handleExternalCommentsRequest(
      externalReq(`/comments?fileId=${FILE}&cellId=cell-1`, agent.token),
      env,
    ))!
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain('reviewer')
    const body = JSON.parse(raw) as { data: Array<Record<string, unknown>> }
    // `"author": null` would still say "someone wrote this and we are hiding
    // them" — the key has to be gone entirely.
    for (const comment of body.data) expect(comment).not.toHaveProperty('author')
  })

  it("agentAuthorship: 'none' overrides a pii credential — the project's opt-out wins", async () => {
    const env = makeEnv(tdb.db)
    await setAgentAuthorship(tdb, PROJECT, 'none')
    const agent = await memberToken(tdb, 400, { pii: true })
    await seedHumanComment(tdb, { commentId: 'c-1', author: 'reviewer', body: 'one' })

    const res = (await handleExternalCommentsRequest(
      externalReq(`/comments?fileId=${FILE}&cellId=cell-1`, agent.token),
      env,
    ))!
    const raw = await res.text()
    expect(raw).not.toContain('reviewer')
    const body = JSON.parse(raw) as { data: Array<Record<string, unknown>> }
    for (const comment of body.data) expect(comment).not.toHaveProperty('author')
  })

  it('pages with an opaque cursor', async () => {
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400)
    for (let i = 0; i < 5; i++) {
      await seedHumanComment(tdb, { commentId: `c-${i}`, author: 'reviewer', body: `note ${i}`, createdAt: 1000 + i })
    }
    const first = await readComments(env, agent.token, '?limit=2')
    expect(first.body.data.map((c) => c.commentId)).toEqual(['c-0', 'c-1'])
    expect(first.body.nextCursor).toBeTruthy()

    const second = await readComments(env, agent.token, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`)
    expect(second.body.data.map((c) => c.commentId)).toEqual(['c-2', 'c-3'])
  })

  it('rejects cellId without fileId', async () => {
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400)
    const res = (await handleExternalCommentsRequest(externalReq('/comments?cellId=cell-1', agent.token), env))!
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('a PAT scoped to another project gets 403 and reads nothing', async () => {
    const env = makeEnv(tdb.db)
    await seedHumanComment(tdb, { commentId: 'c-secret', author: 'reviewer', body: 'internal note' })
    const foreign = await memberToken(tdb, 400, { projectId: OTHER_PROJECT, scopeProjectId: OTHER_PROJECT })
    const res = (await handleExternalCommentsRequest(externalReq('/comments', foreign.token), env))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('scope_denied')
    expect(JSON.stringify(body)).not.toContain('internal note')
  })

  it('an unscoped PAT whose user is not a member gets 403', async () => {
    const env = makeEnv(tdb.db)
    const outsider = await memberToken(tdb, 400, { projectId: OTHER_PROJECT, scopeProjectId: null })
    const res = (await handleExternalCommentsRequest(externalReq('/comments', outsider.token), env))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('permission_denied')
  })

  it('ignores non-GET and unrelated paths', async () => {
    const env = makeEnv(tdb.db)
    expect(
      await handleExternalCommentsRequest(
        new Request(`https://w/api/v1/external/projects/${PROJECT}/comments`, { method: 'POST' }),
        env,
      ),
    ).toBeNull()
    expect(
      await handleExternalCommentsRequest(new Request('https://w/api/v1/external/projects/p/files'), env),
    ).toBeNull()
  })
})

describe('AQU-1233 — agent replies', () => {
  it('a reply lands in the right thread, authored by the minting user and marked via agent', async () => {
    const emailed: unknown[] = []
    const env = makeEnv(tdb.db, {
      EMAIL: {
        send: async (m) => {
          emailed.push(m)
          return { messageId: 'test-message-id' }
        },
      },
    })
    const agent = await memberToken(tdb, 400)
    await tdb.pg.query(`INSERT INTO users (id, username, email, password_hash) VALUES (901, 'reviewer', 'rev@x.com', 'h')`)
    await seedHumanComment(tdb, { commentId: 'c-root', author: 'reviewer', body: 'this rendering is wrong' })

    const { res: prepRes, body: prep } = await prepare(env, agent.token, [
      {
        kind: 'comment.create',
        fileId: FILE,
        cellId: 'cell-1',
        payload: { body: 'fixed — switched to the 1984 wording', parentCommentId: 'c-root' },
      },
    ])
    expect(prepRes.status).toBe(200)

    const pending: Promise<unknown>[] = []
    const { res, body } = await commit(env, agent.token, prep.changeset.id, {
      waitUntil: (p) => void pending.push(p),
    })
    expect(res.status).toBe(200)
    expect(body.receipt?.appliedCount).toBe(1)

    const rows = await tdb.rows<{
      comment_id: string
      parent_comment_id: string | null
      author_id: string
      author_label: string
      body: string
    }>('comments')
    const reply = rows.find((r) => r.parent_comment_id === 'c-root')!
    expect(reply).toBeDefined()
    expect(reply.body).toBe('fixed — switched to the 1984 wording')
    // Authored AS the human who minted the credential…
    expect(reply.author_id).toBe(agent.username)
    // …and visibly marked so a reviewer knows a tool wrote it.
    expect(reply.author_label).toBe(`${agent.username}${AGENT_COMMENT_LABEL_SUFFIX}`)

    // The normal comment notification path fires for the thread's participant.
    await Promise.all(pending)
    expect(emailed).toHaveLength(1)

    // And the agent reading back can tell its own reply from the human's root.
    const { body: read } = await readComments(env, agent.token, `?fileId=${FILE}&cellId=cell-1`)
    expect(read.data.map((c) => c.viaAgent)).toEqual([false, true])
  })

  it('a reply to a nonexistent thread fails cleanly at prepare', async () => {
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, agent.token, [
      {
        kind: 'comment.create',
        fileId: FILE,
        cellId: 'cell-1',
        payload: { body: 'answering nobody', parentCommentId: 'c-ghost' },
      },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('does not exist')
    expect(await tdb.rows('changesets')).toHaveLength(0)
    expect(await tdb.rows('comments')).toHaveLength(0)
  })

  it('a caller cannot forge or suppress the via-agent marker', async () => {
    const env = makeEnv(tdb.db)
    const agent = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, agent.token, [
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'sneaky', viaAgent: false } },
    ])
    expect(res.status).toBe(400)
    expect(JSON.stringify(body.error)).toContain('server-resolved')
  })
})
