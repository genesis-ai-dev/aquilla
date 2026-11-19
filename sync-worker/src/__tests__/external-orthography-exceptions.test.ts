// PatchOrthographyExceptions (AQU-2642 §4) — the Agent API command that adds
// and removes the words a lane's spelling rules must leave alone.
//
// What these tests are actually defending, in the order the issue asks for it:
//
//   - the ROLE SPLIT: a contributor's add lands `pending` (and so changes no
//     text — only an approved exception reaches the converter), a maintainer's
//     lands `approved`, a maintainer's add over someone's pending entry IS the
//     approval and keeps the proposer's credit, and `remove` is refused below
//     MAINTAINER because dropping an approved exception rewrites text;
//   - the MERGE, which is the whole reason this is not
//     `PatchSettings { key: 'languageProfile' }`: an entry written by someone
//     else between prepare and commit SURVIVES the commit, and so does every
//     other profile slot and every orthography field this version does not
//     know about;
//   - the no-ops: adding an approved word or removing an absent one is a
//     normal outcome of a merge, not an error — the whole changeset must not
//     fail because a human got there first;
//   - the refusals: no orthography block, the op cap, a word named twice.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { validateCommands } from '../external/commands'
import {
  MAX_ORTHOGRAPHY_EXCEPTION_OPS,
  mergeOrthographyExceptions,
  orthographyExceptionsSatisfied,
  type OrthographyExceptionOp,
} from '../../../db/shared/orthography-exceptions'
import { mintApiToken } from '../../../db/shared/api-credentials'
import {
  findOldOrthography,
  readLanguageProfile,
  type OrthographyException,
} from '../../../db/shared/language-profile'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'
const PROJECT = 'proj-ortho'

function makeEnv(db: AquillaDb) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    AUTH_WORKER_URL: AUTH_URL,
    BASE_URL: 'https://aquilla.app',
  }
}

let nextUserId = 900
let nextCred = 0

async function memberToken(tdb: TestDb, level: number): Promise<{ token: string; userId: number }> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, `u${userId}`, `u${userId}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [`00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`, String(userId), tokenPrefix, tokenHash, PROJECT],
  )
  return { token, userId }
}

interface JsonBody {
  changeset?: { id: string; status: string; summary?: Record<string, unknown> }
  summary?: Record<string, unknown>
  receipt?: {
    command?: string
    version?: number
    orthographyExceptions?: {
      added: number
      approved: number
      removed: number
      unchanged: number
      total: number
      words: { word: string; action: string; effect: string }[]
    }
  }
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
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

function ops(...list: OrthographyExceptionOp[]) {
  return [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: list }]
}

/** The Uzbek 2026 alphabet, as AQU-2628's dev project records it. */
const UZBEK = {
  rules: [['sh', 'ş'], ['ch', 'ç'], ['oʻ', 'ö'], ['gʻ', 'ğ']] as [string, string][],
  apostrophe: 'ʼ',
}

const databases = new Set<TestDb>()
let tdb: TestDb

/** Seed the project with `languageProfile` as given (null = no profile at all). */
async function seed(languageProfile: Record<string, unknown> | null): Promise<TestDb> {
  const db = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    ...(languageProfile
      ? {
          project_settings: [{
            project_id: PROJECT,
            settings: JSON.stringify({ languageProfile }),
            version: 1,
            updated_by: 99,
            updated_at: new Date().toISOString(),
          }],
        }
      : {}),
  })
  databases.add(db)
  return db
}

async function liveExceptions(database: TestDb): Promise<OrthographyException[]> {
  const rows = await database.rows<{ settings: string }>('project_settings')
  const settings = JSON.parse(rows[0].settings) as Record<string, unknown>
  return [...(readLanguageProfile(settings.languageProfile).orthography?.exceptions ?? [])]
}

async function liveSettings(database: TestDb): Promise<Record<string, unknown>> {
  const rows = await database.rows<{ settings: string }>('project_settings')
  return JSON.parse(rows[0].settings) as Record<string, unknown>
}

beforeEach(() => {
  nextUserId = 900
  nextCred = 0
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const database of databases) await database.close()
  databases.clear()
})

// ── the pure merge: every rule, no database ─────────────────────────────────

describe('mergeOrthographyExceptions', () => {
  const proposer = { userId: '42', canApprove: false }
  const maintainer = { userId: '7', canApprove: true }

  it('lands a contributor’s add as pending and a maintainer’s as approved', () => {
    const pending = mergeOrthographyExceptions([], [{ action: 'add', word: 'asʼhob' }], proposer, 'ʼ')
    expect(pending.exceptions).toEqual([{ word: 'asʼhob', status: 'pending', by: '42' }])
    expect(pending.added).toBe(1)

    const approved = mergeOrthographyExceptions([], [{ action: 'add', word: 'asʼhob' }], maintainer, 'ʼ')
    expect(approved.exceptions).toEqual([{ word: 'asʼhob', status: 'approved', by: '7' }])
  })

  it('treats a maintainer’s add over a pending entry as the approval, keeping the proposer’s credit', () => {
    const live: OrthographyException[] = [{ word: 'Ishoq', status: 'pending', by: '42', ref: 'GEN 11:26' }]
    const merge = mergeOrthographyExceptions(live, [{ action: 'add', word: 'Ishoq' }], maintainer, 'ʼ')
    expect(merge.exceptions).toEqual([{ word: 'Ishoq', status: 'approved', by: '42', ref: 'GEN 11:26' }])
    expect(merge.approved).toBe(1)
    expect(merge.added).toBe(0)
    expect(merge.outcomes[0].line).toMatch(/proposed by 42/)
  })

  it('makes a contributor’s add over a pending entry a no-op, not a second entry', () => {
    const live: OrthographyException[] = [{ word: 'Ishoq', status: 'pending', by: '42' }]
    const merge = mergeOrthographyExceptions(live, [{ action: 'add', word: 'Ishoq' }], proposer, 'ʼ')
    expect(merge.exceptions).toEqual(live)
    expect(merge.changed).toBe(false)
    expect(merge.outcomes[0].effect).toBe('already-pending')
  })

  it('makes an add over an already-approved word a no-op', () => {
    const live: OrthographyException[] = [{ word: 'Isʼhoq', status: 'approved' }]
    const merge = mergeOrthographyExceptions(live, [{ action: 'add', word: 'Isʼhoq' }], maintainer, 'ʼ')
    expect(merge.changed).toBe(false)
    expect(merge.unchanged).toBe(1)
  })

  it('matches on the FOLD, so apostrophes and case never split one exception in two', () => {
    const live: OrthographyException[] = [{ word: 'Isʼhoq', status: 'approved' }]
    for (const spelling of ['Ishoq', "IS'HOQ", 'isʻhoq']) {
      const merge = mergeOrthographyExceptions(live, [{ action: 'add', word: spelling }], maintainer, 'ʼ')
      expect(merge.exceptions, spelling).toHaveLength(1)
      expect(merge.changed, spelling).toBe(false)
    }
  })

  it('stores a new word with the profile’s canonical apostrophe and the rules UNapplied', () => {
    const merge = mergeOrthographyExceptions([], [{ action: 'add', word: "as'hob" }], maintainer, 'ʼ')
    // The apostrophe variant is normalised…
    expect(merge.exceptions[0].word).toBe('asʼhob')
    // …and `sh` is still `sh`: converting the word would defeat the exception.
    expect(merge.exceptions[0].word).toContain('h')
    expect(merge.exceptions[0].word).not.toContain('ş')
  })

  it('removes a word, and treats removing an absent one as a no-op', () => {
    const live: OrthographyException[] = [{ word: 'Isʼhoq', status: 'approved' }]
    const removed = mergeOrthographyExceptions(live, [{ action: 'remove', word: 'ishoq' }], maintainer, 'ʼ')
    expect(removed.exceptions).toEqual([])
    expect(removed.removed).toBe(1)

    const absent = mergeOrthographyExceptions([], [{ action: 'remove', word: 'masʼhur' }], maintainer, 'ʼ')
    expect(absent.changed).toBe(false)
    expect(absent.outcomes[0].effect).toBe('not-present')
  })

  it('answers the supersede predicate only when every add is already APPROVED', () => {
    const pending: OrthographyException[] = [{ word: 'Ishoq', status: 'pending' }]
    const approved: OrthographyException[] = [{ word: 'Ishoq', status: 'approved' }]
    const plan: OrthographyExceptionOp[] = [{ action: 'add', word: 'Ishoq' }]
    expect(orthographyExceptionsSatisfied(pending, plan, { userId: '1', canApprove: true }, 'ʼ')).toBe(false)
    expect(orthographyExceptionsSatisfied(approved, plan, { userId: '1', canApprove: true }, 'ʼ')).toBe(true)
  })
})

// ── validation ──────────────────────────────────────────────────────────────

describe('PatchOrthographyExceptions — validation', () => {
  it('rejects an empty op list, a bad action and an unknown field', () => {
    for (const [command, pattern] of [
      [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [] }, /non-empty array/],
      [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'approve', word: 'x' }] }, /action must be one of/],
      [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: 'x', status: 'approved' }] }, /unknown field "status"/],
      [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: 'two words' }] }, /whitespace/],
      [{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: '' }] }, /non-empty string/],
    ] as const) {
      const result = validateCommands([command])
      expect(result.ok, JSON.stringify(command)).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.issues.some((i) => pattern.test(i.message)), result.issues.map((i) => i.message).join(' | ')).toBe(true)
    }
  })

  it('refuses a status an agent tries to assert for itself — the role decides it', () => {
    const result = validateCommands([
      { kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: 'asʼhob', status: 'approved' }] },
    ])
    expect(result.ok).toBe(false)
  })

  it('rejects the same word twice in one changeset, however it is spelled', () => {
    const result = validateCommands([
      {
        kind: 'PatchOrthographyExceptions',
        projectId: PROJECT,
        ops: [{ action: 'add', word: 'Isʼhoq' }, { action: 'remove', word: 'ishoq' }],
      },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.issues[0].message).toMatch(/named more than once/)
  })

  it('rejects an op list over the cap, naming it', () => {
    const list = Array.from({ length: MAX_ORTHOGRAPHY_EXCEPTION_OPS + 1 }, (_, i) => ({
      action: 'add' as const,
      word: `word${i}`,
    }))
    const result = validateCommands([{ kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: list }])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.issues[0].message).toContain(String(MAX_ORTHOGRAPHY_EXCEPTION_OPS))
  })
})

// ── end to end, through prepare and commit ──────────────────────────────────

describe('PatchOrthographyExceptions — prepare → commit', () => {
  it('stages a contributor’s add as a PENDING proposal that changes no text', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [] } })
    const env = makeEnv(tdb.db)
    const { token, userId } = await memberToken(tdb, 400)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob', ref: 'GEN 1:4' }))
    expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)
    // Nothing is applied at prepare.
    expect(await liveExceptions(tdb)).toEqual([])

    const applied = await commit(env, token, staged.body.changeset!.id)
    expect(applied.res.status, JSON.stringify(applied.body)).toBe(200)
    expect(applied.body.receipt?.command).toBe('PatchOrthographyExceptions')
    expect(applied.body.receipt?.orthographyExceptions).toMatchObject({ added: 1, approved: 0, removed: 0, total: 1 })

    expect(await liveExceptions(tdb)).toEqual([
      { word: 'asʼhob', status: 'pending', by: String(userId), ref: 'GEN 1:4' },
    ])

    // A pending exception is inert: `ashob` as a translator types it is still
    // flagged (and would still be converted), which is exactly why a
    // contributor may propose one without a maintainer's say.
    const profile = readLanguageProfile((await liveSettings(tdb)).languageProfile).orthography
    expect(findOldOrthography('ashob', profile).map((f) => f.suggestion)).toEqual(['aşob'])
  })

  it('lands a maintainer’s add as APPROVED, and the check then leaves the word alone', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob' }))
    const applied = await commit(env, token, staged.body.changeset!.id)
    expect(applied.res.status, JSON.stringify(applied.body)).toBe(200)
    expect((await liveExceptions(tdb))[0]).toMatchObject({ word: 'asʼhob', status: 'approved' })

    // The same text the pending case still flagged is now left alone — that is
    // what approving an exception buys.
    const profile = readLanguageProfile((await liveSettings(tdb)).languageProfile).orthography
    expect(findOldOrthography('ashob', profile)).toEqual([])
  })

  it('refuses a REMOVE below maintainer and stages nothing', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [{ word: 'Isʼhoq', status: 'approved' }] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 400)

    const staged = await prepare(env, token, ops({ action: 'remove', word: 'Isʼhoq' }))
    expect(staged.res.status).toBe(403)
    expect(staged.body.error?.code).toBe('permission_denied')
    expect(staged.body.error?.message).toMatch(/maintainer/i)
    expect(await tdb.rows('changesets')).toHaveLength(0)
    expect(await liveExceptions(tdb)).toHaveLength(1)
  })

  it('refuses every role below contributor', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 200)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob' }))
    expect(staged.res.status).toBe(403)
    expect(staged.body.error?.code).toBe('permission_denied')
  })

  it('refuses a project with no orthography block instead of inventing one', async () => {
    tdb = await seed({ quoteMarks: { levels: [{ open: '“', close: '”' }], continuation: 'none' } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob' }))
    expect(staged.res.status).toBe(400)
    expect(staged.body.error?.message).toMatch(/no languageProfile\.orthography block/)
    // And the untouched slot is still there.
    expect(readLanguageProfile((await liveSettings(tdb)).languageProfile).quoteMarks).toBeDefined()
  })

  it('MERGES at commit: an exception added by someone else between prepare and commit survives', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [{ word: 'Isʼhoq', status: 'approved' }] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob' }))
    expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)

    // A maintainer approves a different word in the app while the plan waits —
    // the exact race that would have cost one of the two entries if the command
    // carried a LIST instead of ops.
    await tdb.pg.query(
      `UPDATE project_settings SET settings = $1, version = version + 1 WHERE project_id = $2`,
      [
        JSON.stringify({
          languageProfile: {
            orthography: {
              ...UZBEK,
              exceptions: [
                { word: 'Isʼhoq', status: 'approved' },
                { word: 'masʼhur', status: 'approved', by: '12' },
              ],
            },
          },
        }),
        PROJECT,
      ],
    )

    const applied = await commit(env, token, staged.body.changeset!.id)
    expect(applied.res.status, JSON.stringify(applied.body)).toBe(200)
    expect((await liveExceptions(tdb)).map((e) => e.word).sort()).toEqual(['Isʼhoq', 'asʼhob', 'masʼhur'].sort())
  })

  it('keeps every other profile slot, including one this version does not know', async () => {
    tdb = await seed({
      quoteMarks: { levels: [{ open: '“', close: '”' }], continuation: 'none' },
      negators: ['emas'],
      orthography: { ...UZBEK, exceptions: [] },
      // A slot a later version adds. `readLanguageProfile` is a READER and
      // drops it, so a writer that round-tripped the reader's view would
      // delete it — this command merges over the STORED object instead
      // (db/shared/language-profile.ts header).
      transcription: { toneMarks: ['ˊ'] },
    } as unknown as Record<string, unknown>)

    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)
    const staged = await prepare(env, token, ops({ action: 'add', word: 'asʼhob' }))
    expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)
    const applied = await commit(env, token, staged.body.changeset!.id)
    expect(applied.res.status, JSON.stringify(applied.body)).toBe(200)

    const after = (await liveSettings(tdb)).languageProfile as Record<string, unknown>
    expect(after.quoteMarks).toBeDefined()
    expect(after.negators).toEqual(['emas'])
    expect(after.transcription).toEqual({ toneMarks: ['ˊ'] })
    const orthography = after.orthography as Record<string, unknown>
    expect(orthography.apostrophe).toBe('ʼ')
    expect(orthography.rules).toHaveLength(4)
    expect(orthography.exceptions).toHaveLength(1)
  })

  it('commits a plan whose every op is already satisfied as a no-op, without bumping the version', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [{ word: 'Isʼhoq', status: 'approved' }] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, ops({ action: 'add', word: 'Isʼhoq' }))
    expect(staged.res.status, JSON.stringify(staged.body)).toBe(200)
    const summary = (staged.body.changeset?.summary ?? staged.body.summary) as
      | { warnings?: { code: string }[] }
      | undefined
    expect(summary?.warnings?.some((w) => w.code === 'inert_write')).toBe(true)

    const before = await tdb.rows<{ version: number }>('project_settings')
    const applied = await commit(env, token, staged.body.changeset!.id)
    expect(applied.res.status, JSON.stringify(applied.body)).toBe(200)
    expect(applied.body.receipt?.orthographyExceptions).toMatchObject({ added: 0, approved: 0, removed: 0, unchanged: 1 })
    const after = await tdb.rows<{ version: number }>('project_settings')
    expect(after[0].version).toBe(before[0].version)
  })

  it('refuses to share a changeset with another command', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, [
      { kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: 'asʼhob' }] },
      { kind: 'PatchSettings', projectId: PROJECT, ops: [{ key: 'translationInstructions', value: 'x' }], ifMatchVersion: 1 },
    ])
    expect(staged.res.status).toBe(400)
    expect(staged.body.error?.message).toMatch(/only command in a changeset/)
  })

  it('honours an explicit ifMatchVersion pin at prepare', async () => {
    tdb = await seed({ orthography: { ...UZBEK, exceptions: [] } })
    const env = makeEnv(tdb.db)
    const { token } = await memberToken(tdb, 600)

    const staged = await prepare(env, token, [
      { kind: 'PatchOrthographyExceptions', projectId: PROJECT, ops: [{ action: 'add', word: 'asʼhob' }], ifMatchVersion: 99 },
    ])
    expect(staged.res.status).toBe(409)
    expect(staged.body.error?.code).toBe('plan_stale')
  })
})
