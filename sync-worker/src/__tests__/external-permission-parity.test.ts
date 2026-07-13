// Permission-parity matrix for the Agent API (AQU-533 §6 gate 7):
//   "for every exposed command, an API caller can do exactly what the same
//    user can do in-app, and nothing more."
//
// This is NOT a re-test of the changeset engine's mechanics (external-changesets
// .test.ts) or the read surface's shape (external-reads.test.ts) — both already
// exist and pass. This file cross-checks EVERY exposed operation against ONE
// source of truth for role requirements: sync-worker/src/events/role-policy.ts's
// REQUIRED_ROLE map (target.cell.commit → CONTRIBUTOR, source.cell.create /
// file.create → PROJECT_LEAD) plus the two hand-rolled role gates in
// read-routes.ts (ROLE.VIEWER) and artifacts-route.ts (ROLE.CONTRIBUTOR upload /
// ROLE.VIEWER read). The matrix is generated with it.each, not copy-pasted.
//
// Two cross-cutting invariants are asserted at multiple role levels:
//   1. an ask-mode credential can never commit without a consumed confirmation;
//   2. a credential scoped to project A can never touch project B, including
//      through the MCP tools/call adapter.
//
// PARITY VIOLATION FOUND (see the dedicated `describe` block below): prepare
// (POST .../changesets) has NO role/membership gate — only credential
// project/org SCOPE is checked (assertCredentialScope in token-bridge.ts).
// A credential whose owning user is not a project member at all (no
// project_members / group / org / creator path — role resolves to null) can
// still stage a changeset and receive the server-computed effect summary
// (cell existence, added/modified counts). In-app, a non-member has zero
// access to a project. That test is marked `it.fails` with the SPEC-CORRECT
// assertion (403 permission_denied) — it documents the bug rather than
// encoding the current (wrong) 200 as the expectation. Production code is
// untouched by this file.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit.ts -> events/route.ts -> broadcast.ts -> partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalReadRequest } from '../external/read-routes'
import { handleExternalArtifactsRequest } from '../external/artifacts-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { ROLE } from '../events/role-policy'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const OTHER_PROJECT = 'proj-b'
const FILE = 'file-x'

function env(tdb: TestDb) {
  return { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

// ── role matrix ──────────────────────────────────────────────────────────────

interface RoleSpec {
  name: string
  level: number | null // null = not a project member at all ("none")
}

const ROLES: RoleSpec[] = [
  { name: 'none', level: null },
  { name: 'viewer', level: ROLE.VIEWER },
  { name: 'commenter', level: ROLE.COMMENTER },
  { name: 'reviewer', level: ROLE.REVIEWER },
  { name: 'contributor', level: ROLE.CONTRIBUTOR },
  { name: 'project_lead', level: ROLE.PROJECT_LEAD },
]

let nextUserId = 1000

/** Seed both projects, one fresh user per call, an optional project_members
 *  row at `level`, and mint an act-mode (unless overridden) credential scoped
 *  to PROJECT. Returns the token + userId so callers can assert ownership. */
async function seedRoleCredential(
  tdb: TestDb,
  level: number | null,
  mode: 'ask' | 'act' = 'act',
): Promise<{ token: string; userId: number }> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, `u${userId}`, `u${userId}@x.com`],
  )
  if (level !== null) {
    await tdb.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
      [PROJECT, userId, level],
    )
  }
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES (gen_random_uuid(), $1, 'test', $2, $3, $4, NULL, $5)`,
    [String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, userId }
}

async function seedBaseProjects(): Promise<TestDb> {
  const tdb = await makeTestDb({
    projects: [
      { id: PROJECT, name: 'Project A', created_by: 99999, org_id: null },
      { id: OTHER_PROJECT, name: 'Project B', created_by: 99999, org_id: null },
    ],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
  // A creator distinct from every test user (99999 never collides with
  // nextUserId's 1000+ range), and a file row so read/commit routes resolve.
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (99999, 'owner', 'owner@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  await tdb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, 'Genesis', 'evt-file-1')
     ON CONFLICT (id) DO NOTHING`,
    [FILE, PROJECT],
  )
  await tdb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ('src-evt-1', 1, $1, $2, 'cell-1', 'source.cell.create', 'importer', '{"value":"source one"}', 100, 100, NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT, FILE],
  )
  return tdb
}

function req(url: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(url, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

async function prepareChangeset(
  tdb: TestDb,
  token: string,
  commands: unknown,
): Promise<{ status: number; body: any }> {
  const res = (await handleExternalChangesetsRequest(
    req(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST', token, body: { commands },
    }),
    env(tdb),
  ))!
  return { status: res.status, body: await res.json() }
}

async function commitChangeset(
  tdb: TestDb,
  token: string,
  id: string,
): Promise<{ status: number; body: any }> {
  const res = (await handleExternalChangesetsRequest(
    req(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, { method: 'POST', token }),
    env(tdb),
  ))!
  return { status: res.status, body: await res.json() }
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await seedBaseProjects()
  nextUserId = 1000 + Math.floor(Math.random() * 100000) // avoid cross-test id collisions
})

// ── 1. reads (search / files / cells / history) → VIEWER floor ─────────────

describe('permission parity — reads require VIEWER (100)+', () => {
  it.each(ROLES)('role=$name (level=$level)', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level)
    const res = await handleExternalReadRequest(
      req(`https://w/api/v1/external/projects/${PROJECT}/files`, { token }),
      env(tdb),
    )
    const body = (await res!.json()) as any
    if (level !== null && level >= ROLE.VIEWER) {
      expect(res!.status).toBe(200)
    } else {
      expect(res!.status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }
  })
})

// ── 2. commit SetTranslation → CONTRIBUTOR floor ────────────────────────────
// (per REQUIRED_ROLE['target.cell.commit'] = ROLE.CONTRIBUTOR, enforced by the
// /events perimeter that commit.ts routes through — role-policy.ts is the
// single source of truth this test is checked against.)

describe('permission parity — commit SetTranslation requires CONTRIBUTOR (400)+', () => {
  it.each(ROLES)('role=$name (level=$level)', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level)

    // Prepare always succeeds today regardless of role (see the dedicated
    // violation block below) — used here only to obtain a changeset to commit.
    const { body: prep } = await prepareChangeset(tdb, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'hello' },
    ])

    const { status, body } = await commitChangeset(tdb, token, prep.changeset.id)
    if (level !== null && level >= ROLE.CONTRIBUTOR) {
      expect(status).toBe(200)
      expect(body.receipt.appliedCount).toBe(1)
    } else {
      expect(status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }
  })
})

// ── 3. commit PlanImport → PROJECT_LEAD floor ───────────────────────────────
// (per REQUIRED_ROLE['file.create'] / ['source.cell.create'] = ROLE.PROJECT_LEAD)

describe('permission parity — commit PlanImport requires PROJECT_LEAD (500)+', () => {
  it.each(ROLES)('role=$name (level=$level)', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level)

    const { body: prep } = await prepareChangeset(tdb, token, [
      {
        kind: 'PlanImport',
        fileName: `Import-${level ?? 'none'}.usfm`,
        fileType: 'usfm',
        cells: [{ content: 'In the beginning' }],
      },
    ])

    const { status, body } = await commitChangeset(tdb, token, prep.changeset.id)
    if (level !== null && level >= ROLE.PROJECT_LEAD) {
      expect(status).toBe(200)
      expect(body.receipt.appliedCount).toBeGreaterThan(0)
    } else {
      expect(status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }
  })
})

// ── 4. artifact upload → CONTRIBUTOR floor ──────────────────────────────────

describe('permission parity — artifact upload requires CONTRIBUTOR (400)+', () => {
  it.each(ROLES)('role=$name (level=$level)', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level)
    const res = await handleExternalArtifactsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-artifact-name': 'genesis.usfm' },
        body: new TextEncoder().encode('\\id GEN'),
      }),
      { ...env(tdb), SNAPSHOTS: fakeR2() } as any,
    )
    const body = (await res!.json()) as any
    if (level !== null && level >= ROLE.CONTRIBUTOR) {
      expect(res!.status).toBe(200)
      expect(body.artifactId).toBeDefined()
    } else {
      expect(res!.status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }
  })
})

/** Minimal in-memory R2Bucket stand-in — only `.put` is exercised by upload. */
function fakeR2() {
  const store = new Map<string, unknown>()
  return {
    put: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    get: async (key: string) => (store.has(key) ? { arrayBuffer: async () => new ArrayBuffer(0) } : null),
    delete: async (key: string) => {
      store.delete(key)
    },
  }
}

// ── 5. non-member: every operation denied ───────────────────────────────────
// Explicit, non-matrix assertions (beyond the it.each rows above) for the
// operations that a non-member should never be able to complete, per the
// task brief. Prepare is the one exception — see the violation block below.

describe('permission parity — non-member is denied every operation (except the documented prepare gap)', () => {
  it('search / read_content / read_history all 403 permission_denied', async () => {
    const { token } = await seedRoleCredential(tdb, null)
    for (const path of [
      `/api/v1/external/projects/${PROJECT}/search?q=source`,
      `/api/v1/external/projects/${PROJECT}/files`,
      `/api/v1/external/projects/${PROJECT}/files/${FILE}/cells`,
      `/api/v1/external/projects/${PROJECT}/cells/cell-1/history`,
    ]) {
      const res = await handleExternalReadRequest(req(`https://w${path}`, { token }), env(tdb))
      const body = (await res!.json()) as any
      expect(res!.status).toBe(403)
      expect(body.error.code).toBe('permission_denied')
    }
  })

  it('commit (any command kind) is 403 permission_denied', async () => {
    const { token } = await seedRoleCredential(tdb, null)
    const { body: prep } = await prepareChangeset(tdb, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])
    const { status, body } = await commitChangeset(tdb, token, prep.changeset.id)
    expect(status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })

  it('artifact upload is 403 permission_denied', async () => {
    const { token } = await seedRoleCredential(tdb, null)
    const res = await handleExternalArtifactsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-artifact-name': 'x.usfm' },
        body: new TextEncoder().encode('data'),
      }),
      { ...env(tdb), SNAPSHOTS: fakeR2() } as any,
    )
    const body = (await res!.json()) as any
    expect(res!.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })
})

// ── PARITY VIOLATION: prepare has no role/membership gate ──────────────────
//
// handlePrepare (sync-worker/src/external/prepare.ts) authenticates the
// credential and calls assertCredentialScope (token-bridge.ts) — which only
// compares cred.projectId/orgId against the target project's id/org, NOT
// membership. It never calls resolveProjectRoleShared. A credential minted
// for a user who is not a project member by ANY path (no project_members row,
// no group grant, no org membership, not the creator) can still POST
// .../changesets and receive a 200 with the server-computed effect summary
// (which cell exists, added-vs-modified counts) for a project they have zero
// in-app visibility into. Every other exposed operation in this file (reads,
// commit, artifact upload) correctly resolves the LIVE role and denies
// non-members. This is the one gap in this matrix.
//
// Marked `it.fails` with the SPEC-CORRECT assertion so this documents the bug
// rather than encoding the current (wrong) 200 as expected behavior. No
// production code is changed by this test file.
describe('PARITY VIOLATION — prepare lacks a role/membership gate (documented, not fixed)', () => {
  it.fails('non-member credential should NOT be able to prepare a changeset (currently succeeds)', async () => {
    const { token } = await seedRoleCredential(tdb, null)
    const { status, body } = await prepareChangeset(tdb, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' },
    ])
    // SPEC-CORRECT expectation (currently false — actual is 200/staged):
    expect(status).toBe(403)
    expect(body.error?.code).toBe('permission_denied')
  })
})

// ── cross-cutting invariant 1: ask-mode can never commit without a consumed
//    confirmation, at CONTRIBUTOR and PROJECT_LEAD ──────────────────────────

describe('invariant — ask-mode credential can never commit without a consumed confirmation', () => {
  it.each([
    { name: 'contributor', level: ROLE.CONTRIBUTOR },
    { name: 'project_lead', level: ROLE.PROJECT_LEAD },
  ])('role=$name (level=$level)', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level, 'ask')
    const { body: prep } = await prepareChangeset(tdb, token, [
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'ask-mode-value' },
    ])
    expect(prep.changeset.autonomyMode).toBe('ask')

    const { status, body } = await commitChangeset(tdb, token, prep.changeset.id)
    expect(status).toBe(428)
    expect(body.error.code).toBe('confirmation_required')

    // Nothing applied — no target.cell.commit landed for either role.
    const events = await tdb.rows<{ kind: string }>('events')
    expect(events.filter((e) => e.kind === 'target.cell.commit')).toHaveLength(0)
  })
})

// ── cross-cutting invariant 2: a credential scoped to project A can never
//    touch project B, at any role, including via MCP tools/call ───────────

describe('invariant — credential scoped to project A cannot touch project B', () => {
  it.each(ROLES.filter((r) => r.level !== null))('REST: role=$name cannot read project B', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level) // scoped to PROJECT (A)
    const res = await handleExternalReadRequest(
      req(`https://w/api/v1/external/projects/${OTHER_PROJECT}/files`, { token }),
      env(tdb),
    )
    const body = (await res!.json()) as any
    expect(res!.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })

  it.each(ROLES.filter((r) => r.level !== null))('REST: role=$name cannot prepare in project B', async ({ level }) => {
    const { token } = await seedRoleCredential(tdb, level)
    const res = (await handleExternalChangesetsRequest(
      req(`https://w/api/v1/external/projects/${OTHER_PROJECT}/changesets`, {
        method: 'POST', token,
        body: { commands: [{ kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'x' }] },
      }),
      env(tdb),
    ))!
    const body = (await res.json()) as any
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('scope_denied')
  })

  it('MCP: search_project against project B with a project-A-scoped credential -> scope_denied', async () => {
    const { token } = await seedRoleCredential(tdb, ROLE.CONTRIBUTOR)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'search_project', arguments: { projectId: OTHER_PROJECT, q: 'source' } },
        }),
      }),
      env(tdb),
    )
    const rpc = (await res!.json()) as any
    expect(rpc.result.isError).toBe(true)
    const payload = JSON.parse(rpc.result.content[0].text)
    expect(payload.error.code).toBe('scope_denied')
  })

  it('MCP: prepare_translations against project B with a project-A-scoped credential -> scope_denied', async () => {
    const { token } = await seedRoleCredential(tdb, ROLE.PROJECT_LEAD)
    const res = await handleExternalMcpRequest(
      new Request('https://w/api/v1/external/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            name: 'prepare_translations',
            arguments: { projectId: OTHER_PROJECT, translations: [{ fileId: FILE, cellId: 'cell-1', value: 'x' }] },
          },
        }),
      }),
      env(tdb),
    )
    const rpc = (await res!.json()) as any
    expect(rpc.result.isError).toBe(true)
    const payload = JSON.parse(rpc.result.content[0].text)
    expect(payload.error.code).toBe('scope_denied')
  })
})
