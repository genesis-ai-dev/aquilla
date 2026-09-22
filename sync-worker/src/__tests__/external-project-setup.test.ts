// Tests for ProjectSetup (AQU-1294 §2.1 / §2.4): one composite plan, one human
// approval, one commit that expands into settings → policy → brief → members →
// imports and finishes with the server-computed verification receipt.
//
// Driven entirely through the HTTP boundary with a real USFM artifact uploaded
// through the artifact route (the R2 stub is the one from
// external-import-parse.test.ts), so what the plan commits is what the parse
// route would have previewed. Covers: the happy path receipt, every prepare
// rejection naming its field, forced ask-mode even for an act credential,
// mid-plan failure → resume, and a policy key a human loosened in between.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalArtifactsRequest } from '../external/artifacts-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { patchProjectSettingsShared } from '../../../db/shared/projects'
import { BRIEF_SETTINGS_KEY, type TranslationBriefRecord } from '../../../db/shared/brief'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-setup'
const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'

// ── R2 stub ──────────────────────────────────────────────────────────────────

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    store,
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const obj = store.get(key)
      if (!obj) return null
      const body = options?.range
        ? obj.body.slice(options.range.offset, options.range.offset + options.range.length)
        : obj.body
      return { arrayBuffer: async () => body, httpMetadata: obj.httpMetadata }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, { key, body: body as ArrayBuffer, httpMetadata: opts?.httpMetadata })
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
  }
}

type StubBucket = ReturnType<typeof makeStubBucket>

function makeEnv(db: AquillaDb, bucket: StubBucket, opts: { briefBackend?: boolean } = {}) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    SNAPSHOTS: bucket as unknown as R2Bucket,
    ...(opts.briefBackend ? { AUTH_WORKER_URL: AUTH_URL } : {}),
  }
}

/** Stub the auth-worker brief-summary bridge so the L1 render succeeds. */
function stubBriefBackend(summary = 'A meaning-based translation for rural youth.') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ summary, model: 'model-x' })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── fixtures ─────────────────────────────────────────────────────────────────

/** USFM with a footnote, a character marker and a non-breaking space — the
 *  markers AQU-1283 strips. `cellsWithMarkup` must come back 0. */
const USFM_ACTS = [
  '\\id ACT Test Bible',
  '\\h Acts',
  '\\mt1 The Acts of the Apostles',
  '\\c 1',
  '\\s1 The promise',
  '\\p',
  '\\v 1 The former account I made\\f + \\fr 1:1 \\ft Or: \\fqa the first book\\ft .\\f*, O Theophilus.',
  '\\v 2 until the day in which He was \\add taken up\\add*.',
  '\\v 3 To whom~He also showed Himself alive.',
].join('\n')

// ── request helpers ──────────────────────────────────────────────────────────

let tdb: TestDb
let bucket: StubBucket
let nextUserId = 900
let nextCred = 0

async function memberToken(
  level: number,
  mode: 'ask' | 'act' = 'act',
): Promise<{ token: string; userId: number; username: string; credentialId: string }> {
  const userId = nextUserId++
  const username = `u${userId}`
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, username, `${username}@x.com`],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3)`,
    [PROJECT, userId, level],
  )
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, userId, username, credentialId }
}

/** A person who exists but holds no role — a valid membership target. */
async function outsider(name: string): Promise<number> {
  const userId = nextUserId++
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
    [userId, name, `${name}@x.com`],
  )
  return userId
}

async function upload(env: ReturnType<typeof makeEnv>, token: string, name: string, content: string): Promise<string> {
  const res = (await handleExternalArtifactsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-artifact-name': name },
      body: new TextEncoder().encode(content),
    }),
    env,
  ))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { artifactId: string }).artifactId
}

interface Envelope {
  changeset: { id: string; status: string; autonomyMode: string }
  summary: Record<string, unknown>
  digest: string
  approvalUrl: string
  error?: { code: string; message: string; details?: Record<string, unknown> }
  receipt?: Record<string, unknown>
}

async function prepare(
  env: ReturnType<typeof makeEnv>,
  token: string,
  command: Record<string, unknown>,
): Promise<{ res: Response; body: Envelope }> {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [command] }),
    }),
    env,
  ))!
  return { res, body: (await res.json()) as Envelope }
}

async function commit(
  env: ReturnType<typeof makeEnv>,
  token: string,
  id: string,
): Promise<{ res: Response; body: Envelope }> {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  ))!
  return { res, body: (await res.json()) as Envelope }
}

/** Seed the human approval a ProjectSetup always needs (forced ask-mode). */
async function approve(changesetId: string, digest: string, userId: number, credentialId: string): Promise<void> {
  await tdb.db
    .prepare(
      `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      `conf-${changesetId.slice(0, 8)}`,
      changesetId,
      String(userId),
      credentialId,
      digest,
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run()
}

function setupCommand(patch: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'ProjectSetup', projectId: PROJECT, ...patch }
}

async function storedSettings(): Promise<{ settings: Record<string, unknown>; version: number }> {
  const rows = await tdb.rows<{ settings: string; version: number }>('project_settings')
  return { settings: JSON.parse(rows[0].settings) as Record<string, unknown>, version: Number(rows[0].version) }
}

beforeEach(async () => {
  nextUserId = 900
  nextCred = 0
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_settings: [
      {
        project_id: PROJECT,
        settings: JSON.stringify({}),
        version: 1,
        updated_by: 99,
        updated_at: new Date().toISOString(),
      },
    ],
  })
  bucket = makeStubBucket()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('ProjectSetup — one plan, one approval', () => {
  it('applies settings, a tightening policy key, the brief, members and a USFM import in one commit', async () => {
    const env = makeEnv(tdb.db, bucket, { briefBackend: true })
    stubBriefBackend()
    const caller = await memberToken(700)
    await outsider('gulsifa')
    await outsider('terciman')
    const artifactId = await upload(env, caller.token, 'Acts.usfm', USFM_ACTS)

    const { res, body } = await prepare(
      env,
      caller.token,
      setupCommand({
        settings: { sourceLanguage: 'ru', targetLanguage: 'sty', contributeToGlobalTm: false },
        brief: { parameters: { audience: 'Rural youth, 15–25' }, freeformNotes: 'Keep verse numbers.' },
        members: [
          { username: 'gulsifa', role: 600 },
          { username: 'terciman', role: 400 },
        ],
        imports: [{ artifactId, fileName: 'Acts', fileType: 'usfm' }],
      }),
    )
    expect(res.status).toBe(200)

    // The approval page reads these four; none may be empty for a real plan.
    expect(body.summary.command).toBe('ProjectSetup')
    expect(body.summary.settingsChanges).toMatchObject({
      sourceLanguage: 'ru',
      targetLanguage: 'sty',
      contributeToGlobalTm: 'false',
      'translationBrief.audience': 'Rural youth, 15–25',
    })
    expect(body.summary.membershipChanges).toEqual([
      `Add gulsifa to ${PROJECT} as maintainer (600)`,
      `Add terciman to ${PROJECT} as contributor (400)`,
    ])
    expect(body.summary.filesCreated).toBe(1)
    expect(body.summary.sourceCellsAdded).toBeGreaterThan(0)

    await approve(body.changeset.id, body.digest, caller.userId, caller.credentialId)
    const { res: commitRes, body: committed } = await commit(env, caller.token, body.changeset.id)
    expect(commitRes.status).toBe(200)

    const receipt = committed.receipt as {
      command: string
      completedSteps: { kind: string; status: string }[]
      failedStep: unknown
      verification: {
        settingsVersion: number
        members: { username: string; role: number }[]
        files: { fileId: string; name: string; cellCount: number; cellsWithMarkup: number }[]
        briefReachesCopilot: boolean
        policyKeysNotApplied: string[]
      }
    }
    expect(receipt.command).toBe('ProjectSetup')
    expect(receipt.failedStep).toBeNull()
    expect(receipt.completedSteps.map((s) => s.kind)).toEqual([
      'settings', 'policy', 'brief', 'members', 'import',
    ])
    expect(receipt.completedSteps.every((s) => s.status === 'applied')).toBe(true)

    // Verification receipt (spec §2.4) — the facts an operator reads instead of
    // re-querying five endpoints.
    expect(receipt.verification.members).toEqual([
      { username: 'gulsifa', role: 600 },
      { username: 'terciman', role: 400 },
    ])
    expect(receipt.verification.files).toHaveLength(1)
    expect(receipt.verification.files[0].name).toBe('Acts')
    expect(receipt.verification.files[0].cellCount).toBeGreaterThan(0)
    // AQU-1283: no USFM marker may survive into a committed source cell.
    expect(receipt.verification.files[0].cellsWithMarkup).toBe(0)
    expect(receipt.verification.briefReachesCopilot).toBe(true)
    expect(receipt.verification.policyKeysNotApplied).toEqual([])

    // …and the world actually moved.
    const { settings } = await storedSettings()
    expect(settings.sourceLanguage).toBe('ru')
    expect(settings.contributeToGlobalTm).toBe(false)
    const brief = settings[BRIEF_SETTINGS_KEY] as TranslationBriefRecord
    expect(brief.parameters.audience).toBe('Rural youth, 15–25')
    expect(brief.l1Summary).toContain('meaning-based')

    const members = await tdb.rows<{ user_id: string; role_level: number }>('project_members')
    expect(members).toHaveLength(3) // caller + the two invited
    const files = await tdb.rows<{ name: string; deleted_at: number | null }>('files')
    expect(files).toHaveLength(1)
    expect(files[0].deleted_at).toBeNull() // revealed, not left soft-hidden
  })

  it('forces ask-mode even for an act credential', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700, 'act')

    const { body } = await prepare(env, caller.token, setupCommand({ settings: { targetLanguage: 'fr' } }))
    expect(body.changeset.autonomyMode).toBe('ask')

    // …and an unapproved commit is refused.
    const { res, body: denied } = await commit(env, caller.token, body.changeset.id)
    expect(res.status).toBe(428)
    expect(denied.error?.code).toBe('confirmation_required')
  })
})

describe('ProjectSetup — prepare rejections name the field', () => {
  it('refuses the spec’s create-in-plan `project` block', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    const { res, body } = await prepare(
      env,
      caller.token,
      setupCommand({ project: { id: 'new-proj', name: 'New' }, settings: { targetLanguage: 'fr' } }),
    )
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe('validation_failed')
    expect(body.error?.details?.field).toBe('project')
    expect(body.error?.message).toContain('CreateProject')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses an unknown settings key', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    const { res, body } = await prepare(env, caller.token, setupCommand({ settings: { notAKey: 1 } }))
    expect(res.status).toBe(400)
    expect(body.error?.details?.field).toBe('settings.notAKey')
  })

  it('refuses a policy write that would LOOSEN, naming the key', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    await patchProjectSettingsShared(tdb.db, {
      projectId: PROJECT,
      ops: [{ key: 'validationCount', value: 5 }],
      ifMatchVersion: 1,
      updatedBy: 99,
    })
    // 5 → 2 lets work be validated by fewer people: a loosening write.
    const { res, body } = await prepare(env, caller.token, setupCommand({ settings: { validationCount: 2 } }))
    expect(res.status).toBe(403)
    expect(body.error?.code).toBe('permission_denied')
    expect(body.error?.details?.field).toBe('settings.validationCount')
    expect((body.error?.details?.loosening as { key: string }[])[0].key).toBe('validationCount')
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('refuses an unknown brief section', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    const { res, body } = await prepare(
      env,
      caller.token,
      setupCommand({ brief: { parameters: { notASection: 'x' } } }),
    )
    expect(res.status).toBe(400)
    expect(body.error?.details?.field).toBe('brief.parameters.notASection')
  })

  it('refuses two imports that would create the same file name', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    const a = await upload(env, caller.token, 'Acts.usfm', USFM_ACTS)
    const b = await upload(env, caller.token, 'Acts2.usfm', USFM_ACTS)
    const { res, body } = await prepare(
      env,
      caller.token,
      setupCommand({
        imports: [
          { artifactId: a, fileName: 'Acts', fileType: 'usfm' },
          { artifactId: b, fileName: 'Acts', fileType: 'usfm' },
        ],
      }),
    )
    expect(res.status).toBe(400)
    expect(body.error?.details?.field).toBe('imports[1].fileName')
  })

  it('refuses an import whose file name already exists in the project', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    await tdb.pg.query(
      `INSERT INTO files (project_id, id, name, event_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, 1)`,
      [PROJECT, 'file-existing', 'Acts', 'evt-existing'],
    )
    const artifactId = await upload(env, caller.token, 'Acts.usfm', USFM_ACTS)
    const { res, body } = await prepare(
      env,
      caller.token,
      setupCommand({ imports: [{ artifactId, fileName: 'Acts', fileType: 'usfm' }] }),
    )
    expect(res.status).toBe(400)
    expect(body.error?.details?.field).toBe('imports[0].fileName')
    expect(body.error?.details?.fileId).toBe('file-existing')
  })

  it('refuses a caller below the plan floor', async () => {
    const env = makeEnv(tdb.db, bucket)
    const lead = await memberToken(500)
    const { res, body } = await prepare(env, lead.token, setupCommand({ settings: { targetLanguage: 'fr' } }))
    expect(res.status).toBe(403)
    expect(body.error?.code).toBe('permission_denied')
    expect(body.error?.details?.requiredRole).toBe(600)
  })
})

describe('ProjectSetup — failure, resume and live policy re-check', () => {
  it('stops at the failing import step and resumes there on the next commit', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    await outsider('gulsifa')
    const artifactId = await upload(env, caller.token, 'Acts.usfm', USFM_ACTS)

    const { body } = await prepare(
      env,
      caller.token,
      setupCommand({
        settings: { targetLanguage: 'sty' },
        brief: { parameters: { audience: 'Rural youth' } },
        members: [{ username: 'gulsifa', role: 600 }],
        imports: [{ artifactId, fileName: 'Acts', fileType: 'usfm' }],
      }),
    )
    await approve(body.changeset.id, body.digest, caller.userId, caller.credentialId)

    // The artifact's bytes vanish between prepare and commit: the import step
    // cannot re-parse, so it fails — and nothing after it runs.
    const keys = [...bucket.store.keys()]
    const saved = bucket.store.get(keys[0])!
    bucket.store.delete(keys[0])

    const { res: failedRes, body: failed } = await commit(env, caller.token, body.changeset.id)
    expect(failedRes.status).toBe(500)
    expect(failed.error?.code).toBe('job_failed')
    const partial = failed.error?.details?.receipt as {
      completedSteps: { kind: string; status: string }[]
      failedStep: { kind: string; index: number; error: string }
    }
    expect(partial.failedStep.kind).toBe('import')
    expect(
      partial.completedSteps.filter((s) => s.status === 'applied').map((s) => s.kind),
    ).toEqual(['settings', 'brief', 'members'])
    // The earlier steps STAY applied — rolling them back is worse than leaving them.
    const afterFailure = await storedSettings()
    expect(afterFailure.settings.targetLanguage).toBe('sty')
    expect(await tdb.rows('files')).toHaveLength(0)

    // Fix the cause, commit again: the plan resumes at the import.
    bucket.store.set(keys[0], saved)
    const { res: retryRes, body: retried } = await commit(env, caller.token, body.changeset.id)
    expect(retryRes.status).toBe(200)
    const receipt = retried.receipt as {
      failedStep: unknown
      completedSteps: { kind: string; status: string }[]
      verification: { files: { name: string }[] }
    }
    expect(receipt.failedStep).toBeNull()
    expect(receipt.completedSteps.every((s) => s.status === 'applied')).toBe(true)
    expect(receipt.verification.files.map((f) => f.name)).toEqual(['Acts'])

    // The settings step did NOT run twice: one write, one version bump.
    expect((await storedSettings()).version).toBe(afterFailure.version)
    expect(await tdb.rows('files')).toHaveLength(1)
  })

  it('drops a policy key a human loosened between prepare and commit, and applies the rest', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)

    // Plan: tighten validationCount 1 → 3, and set the (non-policy) language.
    const { body } = await prepare(
      env,
      caller.token,
      setupCommand({ settings: { targetLanguage: 'sty', validationCount: 3 } }),
    )
    await approve(body.changeset.id, body.digest, caller.userId, caller.credentialId)

    // A human raises it to 5 in the app. The approved write is now a LOOSENING.
    const live = await storedSettings()
    await patchProjectSettingsShared(tdb.db, {
      projectId: PROJECT,
      ops: [{ key: 'validationCount', value: 5 }],
      ifMatchVersion: live.version,
      updatedBy: 99,
    })

    const { res, body: committed } = await commit(env, caller.token, body.changeset.id)
    expect(res.status).toBe(200)
    const receipt = committed.receipt as {
      verification: { policyKeysNotApplied: string[] }
    }
    expect(receipt.verification.policyKeysNotApplied).toEqual(['validationCount'])

    const after = await storedSettings()
    expect(after.settings.validationCount).toBe(5) // the human's value survives
    expect(after.settings.targetLanguage).toBe('sty') // the rest of the plan applied
  })

  it('marks a step whose end-state already exists as superseded and skips it', async () => {
    const env = makeEnv(tdb.db, bucket)
    const caller = await memberToken(700)
    await patchProjectSettingsShared(tdb.db, {
      projectId: PROJECT,
      ops: [{ key: 'targetLanguage', value: 'sty' }],
      ifMatchVersion: 1,
      updatedBy: 99,
    })

    const { body } = await prepare(
      env,
      caller.token,
      setupCommand({ settings: { targetLanguage: 'sty' }, brief: { parameters: { audience: 'Youth' } } }),
    )
    const warnings = body.summary.warnings as { code: string; message: string }[]
    expect(warnings.some((w) => w.code === 'superseded_step' && w.message.includes('settings'))).toBe(true)

    await approve(body.changeset.id, body.digest, caller.userId, caller.credentialId)
    const { res, body: committed } = await commit(env, caller.token, body.changeset.id)
    expect(res.status).toBe(200)
    const receipt = committed.receipt as { completedSteps: { kind: string; status: string }[] }
    expect(receipt.completedSteps).toEqual([
      { index: 0, kind: 'settings', status: 'superseded' },
      { index: 1, kind: 'brief', status: 'applied' },
    ])
  })
})
