// AQU-2195: the Agent API's view of the Rules page's Style rules section.
//
//   GET  .../projects/:projectId/style-rules        (read tier, VIEWER)
//   POST .../changesets  { ReviewStyleRules }       (receipt-only, PROJECT_LEAD)
//
// The contract under test: an agent reads the same rows the app lists (own and
// org-inherited, flagged), and a batch of approve / reject / update decisions
// lands atomically through the changeset flow: a stale version, a rule in the
// wrong state, a missing rule or an org-owned rule refuses the whole batch and
// changes nothing.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// changesets-route → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleExternalStyleRulesReadRequest } from '../external/style-rules-read-routes'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { STYLE_RULE_REVIEW_MAX_DECISIONS } from '../external/commands-style-rules'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { describeCommand } from '../../../db/shared/command-catalog'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-sr'
const ORG = 77

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 600
let nextCred = 700

interface Actor {
  token: string
  userId: number
  credentialId: string
}

async function actor(
  tdb: TestDb,
  level: number,
  opts: { mode?: 'ask' | 'act'; access?: 'read' | 'write' } = {},
): Promise<Actor> {
  const userId = nextUserId++
  const name = `u${userId}`
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
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, access, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, $6, NULL, $7)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, opts.mode ?? 'act', opts.access ?? 'write', PROJECT],
  )
  return { token, userId, credentialId }
}

const DOC_ID = '11111111-1111-4111-8111-111111111111'

async function insertRule(
  tdb: TestDb,
  id: string,
  opts: {
    status?: string
    version?: number
    org?: boolean
    instruction?: string
    enabled?: boolean
    docId?: string
  } = {},
) {
  await tdb.pg.query(
    `INSERT INTO style_rules (id, org_id, project_id, instruction, status, version, enabled, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      id,
      opts.org ? ORG : null,
      opts.org ? null : PROJECT,
      opts.instruction ?? `Instruction for ${id}`,
      opts.status ?? 'proposed',
      opts.version ?? 1,
      opts.enabled ?? true,
      JSON.stringify({ kind: 'knowledge-doc', docId: opts.docId ?? DOC_ID, quote: 'q' }),
    ],
  )
}

async function ruleRow(tdb: TestDb, id: string) {
  const { rows } = await tdb.pg.query<{
    status: string
    version: number
    reviewed_by: string | null
    human_edited: boolean
    severity: string
    instruction: string
  }>(`SELECT status, version, reviewed_by, human_edited, severity, instruction FROM style_rules WHERE id = $1`, [id])
  return rows[0]
}

interface Json {
  error?: { code: string; message: string; details?: { decisions?: { index: number; ruleId: string; code: string }[] } }
  changeset?: { id: string }
  digest?: string
  summary?: { styleRuleReviews?: { counts: Record<string, number> } }
  receipt?: { command: string; rules: { ruleId: string; action: string; status: string; version: number }[] }
  data?: {
    id: string
    status: string
    inherited: boolean
    version: number
    source?: { kind: string; docId?: string }
    sourceDocTitle?: string
    category: string
    scope: string
    severity: string
    enabled: boolean
    instruction: string
  }[]
  nextCursor?: string | null
}

async function listRules(tdb: TestDb, token: string | null, qs = '') {
  const res = (await handleExternalStyleRulesReadRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/style-rules${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as Json }
}

async function prepare(tdb: TestDb, token: string, command: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [command] }),
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as Json }
}

async function commit(tdb: TestDb, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  ))!
  return { res, body: (await res.json()) as Json }
}

async function confirm(tdb: TestDb, changesetId: string, credentialId: string, digest: string, approver: number) {
  await tdb.pg.query(
    `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
    [crypto.randomUUID(), changesetId, String(approver), credentialId, digest, new Date(Date.now() + 60_000).toISOString()],
  )
}

function review(decisions: unknown[]) {
  return { kind: 'ReviewStyleRules', projectId: PROJECT, decisions }
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 600
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
  })
  await tdb.pg.query(`INSERT INTO users (id, username, email, password_hash) VALUES (98, 'o', 'o@x.com', 'h')`)
  await tdb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, 'Org', 98)`, [ORG])
  await tdb.pg.query(`UPDATE projects SET org_id = $1 WHERE id = $2`, [ORG, PROJECT])
  await tdb.pg.query(
    `INSERT INTO knowledge_docs (id, project_id, name, size_bytes, sha256, r2_key, extracted_text, created_by)
     VALUES ($1, $2, 'Style guide.md', 1, 'x', 'k', 't', 'u')`,
    [DOC_ID, PROJECT],
  )
})

// ── read ────────────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/style-rules', () => {
  it('filters by status, flags org rules and carries the source and its doc title', async () => {
    const viewer = await actor(tdb, 100, { access: 'read' })
    await insertRule(tdb, 'r-prop', { status: 'proposed' })
    await insertRule(tdb, 'r-appr', { status: 'approved', version: 3 })
    await insertRule(tdb, 'r-org', { status: 'approved', org: true })

    const all = await listRules(tdb, viewer.token)
    expect(all.res.status).toBe(200)
    expect(all.body.data!.map((r) => r.id).sort()).toEqual(['r-appr', 'r-org', 'r-prop'])
    const org = all.body.data!.find((r) => r.id === 'r-org')!
    expect(org.inherited).toBe(true)
    const prop = all.body.data!.find((r) => r.id === 'r-prop')!
    expect(prop.inherited).toBe(false)
    expect(prop.source).toMatchObject({ kind: 'knowledge-doc', docId: DOC_ID })
    expect(prop.sourceDocTitle).toBe('Style guide.md')
    expect(Object.keys(prop)).toEqual(
      expect.arrayContaining(['instruction', 'category', 'scope', 'severity', 'enabled', 'status', 'version']),
    )
    expect(all.body.data!.find((r) => r.id === 'r-appr')!.version).toBe(3)

    const proposed = await listRules(tdb, viewer.token, '?status=proposed')
    expect(proposed.body.data!.map((r) => r.id)).toEqual(['r-prop'])
  })

  it('refuses an unknown status, an unknown credential, and pages with a cursor', async () => {
    const viewer = await actor(tdb, 100)
    for (let i = 0; i < 3; i++) await insertRule(tdb, `r-${i}`)

    const bad = await listRules(tdb, viewer.token, '?status=pending')
    expect(bad.res.status).toBe(400)
    expect(bad.body.error!.code).toBe('validation_failed')

    const unknown = await listRules(tdb, 'aqk_not-a-real-token')
    expect(unknown.res.status).toBe(401)

    const first = await listRules(tdb, viewer.token, '?limit=2')
    expect(first.body.data).toHaveLength(2)
    expect(first.body.nextCursor).toBeTruthy()
    const second = await listRules(tdb, viewer.token, `?limit=2&cursor=${first.body.nextCursor}`)
    expect(second.body.data).toHaveLength(1)
    expect(second.body.nextCursor).toBeNull()
  })
})

// ── command ─────────────────────────────────────────────────────────────────

describe('ReviewStyleRules', () => {
  it('approve + reject + update land in one changeset with new statuses and versions', async () => {
    const lead = await actor(tdb, 500)
    await insertRule(tdb, 'r-a')
    await insertRule(tdb, 'r-b')
    await insertRule(tdb, 'r-c', { version: 4 })

    const staged = await prepare(tdb, lead.token, review([
      { ruleId: 'r-a', action: 'approve', ifMatchVersion: 1 },
      { ruleId: 'r-b', action: 'reject', ifMatchVersion: 1 },
      { ruleId: 'r-c', action: 'update', ifMatchVersion: 4, patch: { severity: 'major', instruction: 'New wording' } },
    ]))
    expect(staged.res.status).toBe(200)
    expect(staged.body.summary!.styleRuleReviews!.counts).toEqual({ approve: 1, reject: 1, update: 1 })

    const done = await commit(tdb, lead.token, staged.body.changeset!.id)
    expect(done.res.status).toBe(200)
    expect(done.body.receipt!.command).toBe('ReviewStyleRules')
    expect(done.body.receipt!.rules).toEqual([
      { ruleId: 'r-a', action: 'approve', status: 'approved', version: 1 },
      { ruleId: 'r-b', action: 'reject', status: 'rejected', version: 1 },
      { ruleId: 'r-c', action: 'update', status: 'proposed', version: 5 },
    ])
    expect((await ruleRow(tdb, 'r-a')).reviewed_by).toBe(`u${lead.userId}`)
    const c = await ruleRow(tdb, 'r-c')
    expect(c).toMatchObject({ severity: 'major', instruction: 'New wording', human_edited: true, version: 5 })
  })

  it('refuses a contributor and a read-only credential at prepare', async () => {
    const contributor = await actor(tdb, 400)
    const readOnly = await actor(tdb, 500, { access: 'read' })
    await insertRule(tdb, 'r-a')
    const decisions = [{ ruleId: 'r-a', action: 'approve', ifMatchVersion: 1 }]

    const c = await prepare(tdb, contributor.token, review(decisions))
    expect(c.res.status).toBe(403)
    expect(c.body.error!.code).toBe('permission_denied')

    const r = await prepare(tdb, readOnly.token, review(decisions))
    expect(r.res.status).toBe(403)
    expect((await ruleRow(tdb, 'r-a')).status).toBe('proposed')
  })

  it('ask mode: a confirmation from a non-lead refuses the commit, a lead lets it land', async () => {
    const lead = await actor(tdb, 500, { mode: 'ask' })
    const contributor = await actor(tdb, 400)
    await insertRule(tdb, 'r-a')
    const decisions = [{ ruleId: 'r-a', action: 'approve', ifMatchVersion: 1 }]

    const bad = await prepare(tdb, lead.token, review(decisions))
    await confirm(tdb, bad.body.changeset!.id, lead.credentialId, bad.body.digest!, contributor.userId)
    const refused = await commit(tdb, lead.token, bad.body.changeset!.id)
    expect(refused.res.status).toBe(403)
    expect(refused.body.error!.code).toBe('permission_denied')
    expect((await ruleRow(tdb, 'r-a')).status).toBe('proposed')

    const good = await prepare(tdb, lead.token, review(decisions))
    await confirm(tdb, good.body.changeset!.id, lead.credentialId, good.body.digest!, lead.userId)
    const landed = await commit(tdb, lead.token, good.body.changeset!.id)
    expect(landed.res.status).toBe(200)
    expect((await ruleRow(tdb, 'r-a')).status).toBe('approved')
  })

  it('a stale ifMatchVersion refuses the whole batch and changes nothing', async () => {
    const lead = await actor(tdb, 500)
    await insertRule(tdb, 'r-a')
    await insertRule(tdb, 'r-b')
    const staged = await prepare(tdb, lead.token, review([
      { ruleId: 'r-a', action: 'approve', ifMatchVersion: 1 },
      { ruleId: 'r-b', action: 'approve', ifMatchVersion: 1 },
    ]))
    expect(staged.res.status).toBe(200)
    // A person edits r-b in the app between prepare and commit.
    await tdb.pg.query(`UPDATE style_rules SET version = 2 WHERE id = 'r-b'`)

    const done = await commit(tdb, lead.token, staged.body.changeset!.id)
    expect(done.res.status).toBe(409)
    expect(done.body.error!.code).toBe('plan_stale')
    expect(done.body.error!.details!.decisions).toEqual([
      expect.objectContaining({ index: 1, ruleId: 'r-b', code: 'stale_version' }),
    ])
    expect((await ruleRow(tdb, 'r-a')).status).toBe('proposed')
    expect((await ruleRow(tdb, 'r-b')).status).toBe('proposed')
  })

  it('names every bad decision: non-proposed, org-inherited and missing rules', async () => {
    const lead = await actor(tdb, 500)
    await insertRule(tdb, 'r-ok')
    await insertRule(tdb, 'r-done', { status: 'approved' })
    await insertRule(tdb, 'r-org', { org: true })

    const refused = await prepare(tdb, lead.token, review([
      { ruleId: 'r-ok', action: 'approve', ifMatchVersion: 1 },
      { ruleId: 'r-done', action: 'reject', ifMatchVersion: 1 },
      { ruleId: 'r-org', action: 'approve', ifMatchVersion: 1 },
      { ruleId: 'r-gone', action: 'approve', ifMatchVersion: 1 },
    ]))
    expect(refused.res.status).toBe(400)
    expect(refused.body.error!.details!.decisions!.map((d) => [d.ruleId, d.code])).toEqual([
      ['r-done', 'invalid_state'],
      ['r-org', 'org_inherited'],
      ['r-gone', 'not_found'],
    ])
    expect((await ruleRow(tdb, 'r-ok')).status).toBe('proposed')
  })

  it('refuses a batch over the maximum and duplicate rule ids', async () => {
    const lead = await actor(tdb, 500)
    const many = Array.from({ length: STYLE_RULE_REVIEW_MAX_DECISIONS + 1 }, (_, i) => ({
      ruleId: `r-${i}`,
      action: 'reject',
      ifMatchVersion: 1,
    }))
    const tooMany = await prepare(tdb, lead.token, review(many))
    expect(tooMany.res.status).toBe(400)
    expect(JSON.stringify(tooMany.body)).toContain(`more than the ${STYLE_RULE_REVIEW_MAX_DECISIONS} maximum`)

    const dupes = await prepare(tdb, lead.token, review([
      { ruleId: 'r-a', action: 'approve', ifMatchVersion: 1 },
      { ruleId: 'r-a', action: 'reject', ifMatchVersion: 1 },
    ]))
    expect(dupes.res.status).toBe(400)
    expect(JSON.stringify(dupes.body)).toContain('more than once')
  })

  it('requires patch on update, and only on update', async () => {
    const lead = await actor(tdb, 500)
    const noPatch = await prepare(tdb, lead.token, review([{ ruleId: 'r-a', action: 'update', ifMatchVersion: 1 }]))
    expect(noPatch.res.status).toBe(400)
    const stray = await prepare(tdb, lead.token, review([
      { ruleId: 'r-a', action: 'approve', ifMatchVersion: 1, patch: { enabled: false } },
    ]))
    expect(stray.res.status).toBe(400)
  })
})

// ── discovery / describe drift guards ───────────────────────────────────────

describe('discovery and describe_command', () => {
  it('the route is in the discovery map and ReviewStyleRules is described', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))!
    const text = JSON.stringify(await res.json())
    expect(text).toContain('/api/v1/external/projects/:projectId/style-rules')
    expect(text).toContain('ReviewStyleRules')

    const entry = describeCommand('ReviewStyleRules')!
    expect(entry.minRoleLevel).toBe(500)
    expect(entry.paramsDoc).toContain(String(STYLE_RULE_REVIEW_MAX_DECISIONS))
    expect(entry.paramsDoc).toContain('ALL OR NOTHING')
    expect(entry.paramsDoc).toContain('stale')
  })
})
