// Tests for the AQU-1228 Living Memory write commands: AddExample,
// AddDecision, AddNote, RetireExample.
//
// The contract under test: these are receipt-only changeset commands that write
// `agent_memories` rows (Living Memory is NOT event-sourced), the changeset's
// human confirmation stands in for the Memory-tab review only at the authority
// that review requires, retirement archives rather than deletes, and the
// approved set — which is exactly what buildMemoryContext feeds the copilot —
// moves accordingly.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// changesets-route → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { notePath, examplePath, decisionPath } from '../external/commands-memory'
import { buildMemoryContext } from '../../../db/shared/agent-memory'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { describeCommand } from '../../../db/shared/command-catalog'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-mem'
const FILE = 'file-mem'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 400
let nextCred = 500

async function memberToken(
  tdb: TestDb,
  level: number,
  mode: 'ask' | 'act' = 'act',
): Promise<{ token: string; userId: number; credentialId: string }> {
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
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, userId, credentialId }
}

interface JsonBody {
  error?: { code: string; message: string; details?: unknown }
  changeset?: { id: string }
  summary?: Record<string, unknown>
  digest?: string
  receipt?: { memoryPath: string; memoryStatus: string; command: string; note?: string }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, command: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [command] }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as JsonBody }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { res, body: (await res.json()) as JsonBody }
}

/** Stands in for a human clicking approve on /approve/:id. `approverUserId` is
 *  the human who approved — auth-worker admits any user meeting the plan's
 *  staged floor, so this is NOT necessarily the credential's owner. */
async function confirm(
  tdb: TestDb,
  changesetId: string,
  credentialId: string,
  digest: string,
  approverUserId: number,
) {
  await tdb.pg.query(
    `INSERT INTO changeset_confirmations
       (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
    [
      crypto.randomUUID(),
      changesetId,
      String(approverUserId),
      credentialId,
      digest,
      new Date(Date.now() + 60_000).toISOString(),
    ],
  )
}

/** Full prepare → (confirm) → commit round trip. */
async function run(
  tdb: TestDb,
  env: ReturnType<typeof makeEnv>,
  actor: { token: string; credentialId: string; userId: number },
  command: unknown,
  opts: { approve?: boolean; approverUserId?: number } = {},
) {
  const staged = await prepare(env, actor.token, command)
  if (staged.res.status !== 200) return { staged, committed: null }
  if (opts.approve) {
    await confirm(
      tdb,
      staged.body.changeset!.id,
      actor.credentialId,
      staged.body.digest!,
      opts.approverUserId ?? actor.userId,
    )
  }
  const committed = await commit(env, actor.token, staged.body.changeset!.id)
  return { staged, committed }
}

async function memoryRows(tdb: TestDb) {
  const { rows } = await tdb.pg.query<{ path: string; status: string; content: string; rationale: string | null }>(
    `SELECT path, status, content, rationale FROM agent_memories WHERE project_id = $1 ORDER BY path, status`,
    [PROJECT],
  )
  return rows
}

const EXAMPLE = {
  kind: 'AddExample',
  slug: 'lord-as-hospod',
  source: 'the LORD',
  target: 'Господь',
  rationale: 'Client style guide §4.',
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 400
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'File M', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT,
        file_id: FILE,
        cell_id: 'GEN 1:1',
        side: 'source',
        value: 'In the beginning',
        event_id: 'src-evt-1',
        last_edit_at: 1,
      },
    ],
  })
})

// ── validation ──────────────────────────────────────────────────────────────

describe('memory commands — validation', () => {
  it('rejects a slug that is not a lowercase dash slug', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, { ...EXAMPLE, slug: 'Lord As Hospod' })
    expect(res.status).toBe(400)
    expect(body.error!.code).toBe('validation_failed')
    expect(JSON.stringify(body.error!.details)).toContain('AddExample.slug')
  })

  it('rejects content carrying a secret pattern rather than storing it', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, {
      ...EXAMPLE,
      target: 'use api key sk-abcdef0123456789',
    })
    expect(res.status).toBe(400)
    expect(body.error!.code).toBe('validation_failed')
    expect(body.error!.message).toContain('secret pattern')
    expect(await memoryRows(tdb)).toHaveLength(0)
  })

  it('rejects an unknown command kind (the allowlist still holds)', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, { kind: 'AddSomethingElse', slug: 'x' })
    expect(res.status).toBe(400)
    expect(body.error!.code).toBe('validation_failed')
    expect(JSON.stringify(body.error!.details)).toContain('unsupported command kind: AddSomethingElse')
  })

  it('refuses to batch a memory command with another command', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const res = (await handleExternalChangesetsRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lead.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [EXAMPLE, { kind: 'SetTranslation', fileId: FILE, cellId: 'GEN 1:1', value: 'x' }],
        }),
      }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect(((await res.json()) as JsonBody).error!.message).toContain('must be the only command')
  })

  it('describe_command documents all four kinds', () => {
    for (const kind of ['AddExample', 'AddDecision', 'RetireExample', 'AddNote']) {
      const entry = describeCommand(kind)
      expect(entry, kind).not.toBeNull()
      expect(entry!.agentReachable).toBe(true)
      expect(entry!.paramsDoc).toContain(kind)
    }
    // Retiring is the review-tier act; adding is not.
    expect(describeCommand('RetireExample')!.minRoleLevel).toBe(500)
    expect(describeCommand('AddExample')!.minRoleLevel).toBe(400)
  })
})

// ── the approval gate ───────────────────────────────────────────────────────

describe('memory commands — approval gate', () => {
  it('an approved ask-mode changeset from a lead lands the example approved and in retrieval', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    const { committed } = await run(tdb, env, lead, EXAMPLE, { approve: true })

    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryPath).toBe(examplePath('lord-as-hospod'))
    expect(committed!.body.receipt!.memoryStatus).toBe('approved')

    const rows = await memoryRows(tdb)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('approved')
    expect(rows[0].content).toContain('Господь')
    expect(rows[0].rationale).toBe('Client style guide §4.')

    // Acceptance: it now reaches the copilot's prompt.
    const ctx = await buildMemoryContext(tdb.db, PROJECT)
    expect(ctx.memoryIndex.map((e) => e.path)).toContain(examplePath('lord-as-hospod'))
    expect(await ctx.readMemory(examplePath('lord-as-hospod'))).toContain('Господь')
  })

  it('an act-mode commit (no human confirmation) lands it proposed, NOT in retrieval', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'act')
    const { committed } = await run(tdb, env, lead, EXAMPLE)

    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryStatus).toBe('proposed')
    expect(committed!.body.receipt!.note).toContain('must approve it')

    expect((await memoryRows(tdb))[0].status).toBe('proposed')
    const ctx = await buildMemoryContext(tdb.db, PROJECT)
    expect(ctx.memoryIndex).toHaveLength(0)
  })

  it('a contributor cannot self-approve into retrieval even with a confirmation', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400, 'ask')
    const { committed } = await run(tdb, env, contributor, EXAMPLE, { approve: true })
    // (approver defaults to the credential owner — here, the contributor.)

    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryStatus).toBe('proposed')
    const ctx = await buildMemoryContext(tdb.db, PROJECT)
    expect(ctx.memoryIndex).toHaveLength(0)
  })

  it('a CONTRIBUTOR approver cannot publish a lead-owned credential\'s plan', async () => {
    // auth-worker admits any approver meeting the plan's staged floor, which for
    // AddExample is CONTRIBUTOR. The authority that counts is the APPROVER's, not
    // the credential owner's — otherwise a contributor's click rides a lead's
    // credential straight into the copilot.
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    const contributor = await memberToken(tdb, 400)
    const { committed } = await run(tdb, env, lead, EXAMPLE, {
      approve: true,
      approverUserId: contributor.userId,
    })

    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryStatus).toBe('proposed')
    expect((await buildMemoryContext(tdb.db, PROJECT)).memoryIndex).toHaveLength(0)
  })

  it('a PROJECT_LEAD approver publishes a contributor-owned credential\'s plan', async () => {
    // The mirror case: the credential owner is only a contributor, but a lead
    // approved, so the lead's authority is what lands it.
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400, 'ask')
    const lead = await memberToken(tdb, 500)
    const { committed } = await run(tdb, env, contributor, EXAMPLE, {
      approve: true,
      approverUserId: lead.userId,
    })

    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryStatus).toBe('approved')
    expect((await buildMemoryContext(tdb.db, PROJECT)).memoryIndex).toHaveLength(1)
  })

  it('a viewer cannot stage a memory write at all', async () => {
    const env = makeEnv(tdb.db)
    const viewer = await memberToken(tdb, 100)
    const { res, body } = await prepare(env, viewer.token, EXAMPLE)
    expect(res.status).toBe(403)
    expect(body.error!.code).toBe('permission_denied')
  })
})

// ── decisions and notes ─────────────────────────────────────────────────────

describe('AddDecision / AddNote', () => {
  it('a decision lands at decisions/<slug>.md and reaches the prompt', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    const { committed } = await run(
      tdb,
      env,
      lead,
      { kind: 'AddDecision', slug: 'divine-name', decision: 'Render Lord as Господь, never Пан.' },
      { approve: true },
    )
    expect(committed!.body.receipt!.memoryPath).toBe(decisionPath('divine-name'))
    const ctx = await buildMemoryContext(tdb.db, PROJECT)
    expect(await ctx.readMemory(decisionPath('divine-name'))).toContain('never Пан')
  })

  it('a note anchors to a real cell and carries its rationale', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    const { committed } = await run(
      tdb,
      env,
      lead,
      { kind: 'AddNote', fileId: FILE, cellId: 'GEN 1:1', note: 'Kept the plural per the style guide.' },
      { approve: true },
    )
    const expected = await notePath(FILE, 'GEN 1:1')
    expect(committed!.body.receipt!.memoryPath).toBe(expected)
    expect(await (await buildMemoryContext(tdb.db, PROJECT)).readMemory(expected)).toContain(
      'Kept the plural',
    )
  })

  it('a note naming a cell that does not exist is rejected, not stored free-floating', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, {
      kind: 'AddNote',
      fileId: FILE,
      cellId: 'GEN 99:99',
      note: 'why',
    })
    expect(res.status).toBe(404)
    expect(body.error!.code).toBe('not_found')
    expect(await memoryRows(tdb)).toHaveLength(0)
  })

  it('two cells whose ids slugify alike still get distinct note paths', async () => {
    // "GEN 1:1" and "GEN.1.1" both slugify to gen-1-1 — the digest keeps them apart,
    // so one cell's rationale can never silently supersede another's.
    expect(await notePath(FILE, 'GEN 1:1')).not.toBe(await notePath(FILE, 'GEN.1.1'))
  })
})

// ── retirement ──────────────────────────────────────────────────────────────

describe('RetireExample', () => {
  it('archives the approved example and drops it from retrieval, keeping its content', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    await run(tdb, env, lead, EXAMPLE, { approve: true })
    expect((await buildMemoryContext(tdb.db, PROJECT)).memoryIndex).toHaveLength(1)

    const { committed } = await run(
      tdb,
      env,
      lead,
      { kind: 'RetireExample', slug: 'lord-as-hospod', rationale: 'Superseded.' },
      { approve: true },
    )
    expect(committed!.res.status).toBe(200)
    expect(committed!.body.receipt!.memoryStatus).toBe('archived')

    // Gone from retrieval…
    expect((await buildMemoryContext(tdb.db, PROJECT)).memoryIndex).toHaveLength(0)
    // …but not erased: the row survives, archived, content intact.
    const rows = await memoryRows(tdb)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('archived')
    expect(rows[0].content).toContain('Господь')
  })

  it('rejects retiring a slug with nothing approved at it', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, { kind: 'RetireExample', slug: 'never-added' })
    expect(res.status).toBe(404)
    expect(body.error!.code).toBe('not_found')
  })

  it('a contributor may add but may not retire', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    await run(tdb, env, lead, EXAMPLE, { approve: true })

    const contributor = await memberToken(tdb, 400)
    const { res, body } = await prepare(env, contributor.token, {
      kind: 'RetireExample',
      slug: 'lord-as-hospod',
    })
    expect(res.status).toBe(403)
    expect(body.error!.code).toBe('permission_denied')
    expect((await buildMemoryContext(tdb.db, PROJECT)).memoryIndex).toHaveLength(1)
  })

  it('refuses to retire or overwrite a HUMAN-EDITED memory through the agent surface', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    await run(tdb, env, lead, EXAMPLE, { approve: true })
    await tdb.pg.query(
      `UPDATE agent_memories SET human_edited = true WHERE project_id = $1 AND status = 'approved'`,
      [PROJECT],
    )

    const retire = await prepare(env, lead.token, { kind: 'RetireExample', slug: 'lord-as-hospod' })
    expect(retire.res.status).toBe(403)
    expect(retire.body.error!.message).toContain('in-app Memory surface')

    const overwrite = await prepare(env, lead.token, { ...EXAMPLE, target: 'Пан' })
    expect(overwrite.res.status).toBe(403)
    expect(overwrite.body.error!.message).toContain('in-app Memory surface')

    // The human's entry is untouched and still the one the copilot reads.
    expect(await (await buildMemoryContext(tdb.db, PROJECT)).readMemory(examplePath('lord-as-hospod'))).toContain(
      'Господь',
    )
  })
})

// ── supersede ───────────────────────────────────────────────────────────────

describe('memory commands — supersede', () => {
  it('re-adding a slug archives the prior version and serves only the new one', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500, 'ask')
    await run(tdb, env, lead, EXAMPLE, { approve: true })
    await run(tdb, env, lead, { ...EXAMPLE, target: 'Ягве' }, { approve: true })

    const rows = await memoryRows(tdb)
    expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'archived'])

    const ctx = await buildMemoryContext(tdb.db, PROJECT)
    expect(ctx.memoryIndex).toHaveLength(1)
    const live = await ctx.readMemory(examplePath('lord-as-hospod'))
    expect(live).toContain('Ягве')
    expect(live).not.toContain('Господь')
  })
})
