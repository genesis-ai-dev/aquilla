// AQU-1184 — guardrails against validation-laundering AI content through the
// Agent API.
//
// `cell.validate` / `cell.unvalidate` reach the API as EmitEvents kinds
// (AQU-926). Validation is testimony: a reviewer putting their name on a
// translation. Three things therefore have to hold on this surface, and this
// file is the regression guard for each:
//
//   1. An unreviewed AI draft (cells.ai_drafted, AQU-292) cannot be validated
//      through the API at all — the in-app policy (AQU-983 deliberately skips
//      ai_drafted cells in bulk validate) is enforced server-side, with no
//      parameter to bypass it.
//   2. Only explicit (fileId, cellId) pairs are addressable — no wildcard,
//      glob, range, or "validate all" form exists or is inferred.
//   3. The project's own validation policy (role floor, validator allowlist,
//      allowSelfValidation) governs a commit identically to the in-app path,
//      because the compiled events go through the /events perimeter as the
//      credential's own user.
//
// Guardrail 2 in the summary — every staged validation itemized with the cell's
// current text — is asserted here too, since a bare count is not an approvable
// plan for testimony.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { describeCommand } from '../../../db/shared/command-catalog'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'test-secret'
const PROJECT = 'proj-g'
const FILE = 'file-x'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 400
let nextCred = 200

async function memberToken(
  tdb: TestDb,
  level: number,
  username?: string,
): Promise<{ token: string; userId: number; username: string }> {
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
  return { token, userId, username: name }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, events: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ kind: 'EmitEvents', events }] }),
    }),
    env,
  ))!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as any }
}

async function commit(env: ReturnType<typeof makeEnv>, token: string, id: string) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as any }
}

/** Write one target event through the real perimeter, so heads, chains and the
 *  ai_drafted projection are all honest. Pass `parentId` to emit a
 *  `target.cell.commit` chained on that head (the only kind that carries the
 *  AQU-292 `ai_suggestion` marker); omit it for a genesis
 *  `target.cell.create`. */
async function seedTargetCommit(
  tdb: TestDb,
  cellId: string,
  eventId: string,
  opts: { value?: string; author?: string; role?: number; parentId?: string; aiSuggestion?: boolean } = {},
) {
  const author = opts.author ?? 'seeder'
  const role = opts.role ?? 700
  const userId = author === 'seeder' ? 999 : undefined
  if (userId != null) {
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
       ON CONFLICT (id) DO NOTHING`,
      [userId, author, `${author}@x.com`],
    )
    await tdb.pg.query(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [PROJECT, userId, role],
    )
  }
  const resolvedUserId =
    userId ??
    (
      await tdb.pg.query<{ id: number }>(`SELECT id FROM users WHERE username = $1`, [author])
    ).rows[0].id
  const tok = await makeTestToken(SECRET, {
    projectId: PROJECT,
    fileId: FILE,
    userId: resolvedUserId,
    username: author,
    role,
  })
  const event = {
    id: eventId,
    schemaVersion: 1,
    kind: opts.parentId ? 'target.cell.commit' : 'target.cell.create',
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: opts.parentId ?? null,
    author,
    payload: {
      ...(opts.parentId ? {} : { cellId }),
      value: opts.value ?? 'existing',
      ...(opts.aiSuggestion ? { ai_suggestion: true } : {}),
    },
    clientTs: 1,
  } as unknown as RawEvent
  const res = await handleEventsWriteRequest(
    new Request('https://w/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
    }),
    { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET },
  )
  expect(res!.status).toBe(200)
  // The perimeter answers 200 with a `rejected` list, so a seed that was
  // refused would otherwise pass silently and make the real assertion vacuous.
  const out = (await res!.json()) as { accepted: { id: string }[]; rejected: unknown[] }
  expect(out.rejected).toEqual([])
  expect(out.accepted.map((a) => a.id)).toContain(eventId)
}

/** The source-side head each seeded cell chains from (see beforeEach). */
const SOURCE_HEAD: Record<string, string> = { 'cell-1': 'src-evt-1', 'cell-2': 'src-evt-2' }

/** Seed an UNREVIEWED machine draft: a `target.cell.commit` carrying
 *  `ai_suggestion`, chained on the cell's source head — the shape the in-app
 *  agent produces, which the AQU-292 projection marks `cells.ai_drafted = 1`. */
async function seedAiDraft(tdb: TestDb, cellId: string, eventId: string, value = 'machine text') {
  await seedTargetCommit(tdb, cellId, eventId, {
    value,
    parentId: SOURCE_HEAD[cellId],
    aiSuggestion: true,
  })
}

async function setProjectSettings(tdb: TestDb, settings: Record<string, unknown>): Promise<void> {
  await tdb.pg.query(
    `INSERT INTO project_settings (project_id, settings, version, updated_at)
     VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
     ON CONFLICT (project_id)
     DO UPDATE SET settings = excluded.settings, version = project_settings.version + 1`,
    [PROJECT, JSON.stringify(settings)],
  )
}

async function aiDraftedOf(tdb: TestDb, cellId: string): Promise<number | undefined> {
  const r = await tdb.pg.query<{ ai_drafted: number }>(
    `SELECT ai_drafted FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id=$3 AND side='target'`,
    [PROJECT, FILE, cellId],
  )
  return r.rows[0]?.ai_drafted
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 400
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

// ── Guardrail 1: no validation-laundering of AI drafts ────────────────────

describe('AQU-1184 — AI-drafted cells cannot be validated through the Agent API', () => {
  it('rejects a validate over an unreviewed AI draft, naming the cell', async () => {
    const env = makeEnv(tdb.db)
    await seedAiDraft(tdb, 'cell-1', 'tgt-ai-1')
    expect(await aiDraftedOf(tdb, 'cell-1')).toBe(1)

    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('cell-1')
    expect(body.error.message).toContain('unreviewed AI draft')
    // Nothing staged: the plan never existed, so no approval can burn on it.
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('one AI-drafted cell rejects the WHOLE batch — human-authored siblings are not laundered through with it', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-human-1', { value: 'human text' })
    await seedAiDraft(tdb, 'cell-2', 'tgt-ai-2')

    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-2' },
    ])

    expect(res.status).toBe(400)
    expect(body.error.message).toContain('events[1]')
    expect(body.error.message).toContain('cell-2')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('no request flag bypasses the block — unknown payload keys are dropped, not honored', async () => {
    const env = makeEnv(tdb.db)
    await seedAiDraft(tdb, 'cell-1', 'tgt-ai-3')
    const maintainer = await memberToken(tdb, 600)

    for (const payload of [
      { force: true },
      { allowAiDrafted: true },
      { skipAiDraftCheck: true },
      { override: 'ai_drafted' },
    ]) {
      const { res, body } = await prepare(env, maintainer.token, [
        { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1', payload },
      ])
      expect(res.status).toBe(400)
      expect(body.error.message).toContain('unreviewed AI draft')
    }
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('a human edit over the AI draft clears the marker and the same cell then validates', async () => {
    const env = makeEnv(tdb.db)
    await seedAiDraft(tdb, 'cell-1', 'tgt-ai-4')
    const editor = await memberToken(tdb, 400, 'human-editor')
    await seedTargetCommit(tdb, 'cell-1', 'tgt-human-4', {
      value: 'human-reviewed text',
      author: editor.username,
      role: 400,
      parentId: 'tgt-ai-4',
    })
    expect(await aiDraftedOf(tdb, 'cell-1')).toBe(0)

    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(res.status).toBe(200)

    const { res: committed } = await commit(env, reviewer.token, body.changeset.id)
    expect(committed.status).toBe(200)
    const validators = await tdb.rows<{ event_id: string; username: string }>('cell_validators')
    expect(validators).toHaveLength(1)
    expect(validators[0].event_id).toBe('tgt-human-4')
    expect(validators[0].username).toBe(reviewer.username)
  })

  it('unvalidate is NOT blocked on an AI-drafted cell — removing testimony is always allowed', async () => {
    const env = makeEnv(tdb.db)
    await seedAiDraft(tdb, 'cell-1', 'tgt-ai-5')
    const maintainer = await memberToken(tdb, 600)
    const { res } = await prepare(env, maintainer.token, [
      { kind: 'cell.unvalidate', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(res.status).toBe(200)
  })
})

// ── Guardrail 2: explicit cells only, itemized for the approver ───────────

describe('AQU-1184 — explicit cell lists only', () => {
  it.each([['*'], ['**'], ['cell-*'], ['cell-1..cell-2'], ['all']])(
    'rejects %s as a cell selector — it is just a cell id that does not exist',
    async (selector) => {
      const env = makeEnv(tdb.db)
      await seedTargetCommit(tdb, 'cell-1', `tgt-w-${selector.replace(/\W/g, '')}`, { value: 'human text' })
      const reviewer = await memberToken(tdb, 300)
      const { res, body } = await prepare(env, reviewer.token, [
        { kind: 'cell.validate', fileId: FILE, cellId: selector },
      ])
      expect(res.status).toBe(400)
      expect(body.error.code).toBe('validation_failed')
      expect(body.error.message).toContain('does not exist')
      expect(await tdb.rows('changesets')).toHaveLength(0)
    },
  )

  it('rejects a wildcard fileId', async () => {
    const env = makeEnv(tdb.db)
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: '*', cellId: 'cell-1' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects a validate that names no cell at all (no implicit "everything")', async () => {
    const env = makeEnv(tdb.db)
    const reviewer = await memberToken(tdb, 300)
    const { res, body } = await prepare(env, reviewer.token, [{ kind: 'cell.validate', fileId: FILE }])
    expect(res.status).toBe(400)
    expect(JSON.stringify(body.error.details)).toContain('requires fileId and cellId')
  })

  it('the effect summary names every staged validation with the cell text the approver is endorsing', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-s-1', { value: 'En el principio' })
    await seedTargetCommit(tdb, 'cell-2', 'tgt-s-2', { value: 'creó Dios' })
    const reviewer = await memberToken(tdb, 300)

    const { res, body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-2' },
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'looks good' } },
    ])

    expect(res.status).toBe(200)
    // Counts still there, and the validation line is still marked testimony…
    // AQU-1310: summary.events includes emitKindEffectLabel.
    expect(body.summary.events).toContainEqual({
      kind: 'cell.validate',
      count: 2,
      testimony: true,
      label: 'Mark 2 translations as validated — recorded under your name',
    })
    // …but a count alone is not an approvable plan: each cell is named with its text.
    expect(body.summary.testimony).toEqual([
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1', text: 'En el principio', truncated: false },
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-2', text: 'creó Dios', truncated: false },
    ])
    // Comments are not testimony — they do not appear in that section.
    expect(body.summary.testimony).toHaveLength(2)
  })

  it('truncates very long cell text and flags it, rather than dropping the entry', async () => {
    const env = makeEnv(tdb.db)
    const long = 'x'.repeat(500)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-long-1', { value: long })
    const reviewer = await memberToken(tdb, 300)
    const { body } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(body.summary.testimony).toHaveLength(1)
    expect(body.summary.testimony[0].text).toHaveLength(300)
    expect(body.summary.testimony[0].truncated).toBe(true)
  })

  it('a changeset with no validations carries no testimony section', async () => {
    const env = makeEnv(tdb.db)
    const commenter = await memberToken(tdb, 200)
    const { body } = await prepare(env, commenter.token, [
      { kind: 'comment.create', fileId: FILE, cellId: 'cell-1', payload: { body: 'note' } },
    ])
    expect(body.summary.testimony).toBeUndefined()
  })
})

// ── Guardrail 3: the project's validation policy governs the commit ───────

describe('AQU-1184 — project validation policy applies to the credential', () => {
  it('allowSelfValidation=false blocks a credential validating text its own owner wrote', async () => {
    const env = makeEnv(tdb.db)
    await setProjectSettings(tdb, { allowSelfValidation: false })
    const reviewer = await memberToken(tdb, 300, 'self-validator')
    // The credential's OWNER is the last editor of this cell.
    // `author` is what the FRO-189 self-validation check reads (cells.last_editor);
    // the token's role only has to clear the write floor for the seed itself.
    await seedTargetCommit(tdb, 'cell-1', 'tgt-self-1', {
      value: 'my own translation',
      author: reviewer.username,
      role: 700,
    })

    const { body: prep } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    const { res, body } = await commit(env, reviewer.token, prep.changeset.id)

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(JSON.stringify(body.error.details)).toMatch(/self-validation is not allowed/)
    expect(await tdb.rows('cell_validators')).toHaveLength(0)
  })

  it('a different reviewer validating the same cell is allowed under the same setting', async () => {
    const env = makeEnv(tdb.db)
    await setProjectSettings(tdb, { allowSelfValidation: false })
    const author = await memberToken(tdb, 300, 'the-author')
    await seedTargetCommit(tdb, 'cell-1', 'tgt-self-2', {
      value: 'their translation',
      author: author.username,
      role: 700,
    })
    const other = await memberToken(tdb, 300, 'other-reviewer')

    const { body: prep } = await prepare(env, other.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    const { res } = await commit(env, other.token, prep.changeset.id)
    expect(res.status).toBe(200)
    expect(await tdb.rows('cell_validators')).toHaveLength(1)
  })

  it("the project's validationRoleFloor applies to the credential's effective role", async () => {
    const env = makeEnv(tdb.db)
    await setProjectSettings(tdb, { validationRoleFloor: 'project_lead' })
    await seedTargetCommit(tdb, 'cell-1', 'tgt-floor-1', { value: 'human text' })
    const reviewer = await memberToken(tdb, 300)

    // Reviewer clears the static cell.validate floor, so the plan stages…
    const { body: prep } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    // …and the project's own floor rejects it at the perimeter, exactly as in-app.
    const { res, body } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(403)
    expect(JSON.stringify(body.error.details)).toMatch(/role too low to validate/)
    expect(await tdb.rows('cell_validators')).toHaveLength(0)
  })

  it('the validator allowlist applies to the credential owner', async () => {
    const env = makeEnv(tdb.db)
    await setProjectSettings(tdb, { validationNamedUsers: ['someone-else'] })
    await seedTargetCommit(tdb, 'cell-1', 'tgt-allow-1', { value: 'human text' })
    const reviewer = await memberToken(tdb, 300)

    const { body: prep } = await prepare(env, reviewer.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    const { res, body } = await commit(env, reviewer.token, prep.changeset.id)
    expect(res.status).toBe(403)
    expect(JSON.stringify(body.error.details)).toMatch(/validator allowlist/)
  })

  it('a credential below the reviewer floor cannot stage a validation at all', async () => {
    const env = makeEnv(tdb.db)
    await seedTargetCommit(tdb, 'cell-1', 'tgt-role-1', { value: 'human text' })
    const commenter = await memberToken(tdb, 200)
    const { res } = await prepare(env, commenter.token, [
      { kind: 'cell.validate', fileId: FILE, cellId: 'cell-1' },
    ])
    expect(res.status).toBe(403)
  })
})

// ── describe_command documents the guardrails ─────────────────────────────

describe('AQU-1184 — the guardrails are documented where an agent will read them', () => {
  it('describe_command("EmitEvents") states all three guardrails', () => {
    const doc = describeCommand('EmitEvents')?.paramsDoc ?? ''
    expect(doc).toContain('ai_drafted')
    expect(doc).toContain('cannot be validated')
    expect(doc).toMatch(/no wildcard|There is no wildcard/i)
    expect(doc).toContain('allowSelfValidation')
    expect(doc).toContain('itemized')
  })
})
