// Tests for AQU-1182: file + project lifecycle commands on the Agent API —
// RenameFile (sugar over a `file.rename` event) and the receipt-only
// RenameProject / ArchiveProject / UnarchiveProject row writes.
//
// The contract under test, per the issue's acceptance criteria:
//   - happy path per command: the plan stages, a human approval applies it, and
//     the live projection / project row reflects it (event log carries the
//     standard `file.rename` event for the file case)
//   - role gates mirror the UI floors for the same actions: rename file
//     CONTRIBUTOR 400, rename project MAINTAINER 600, archive/unarchive OWNER 700
//   - changeset-approval gating: an ask-mode plan applies NOTHING before a valid
//     human confirmation is consumed
//   - no delete of any kind is reachable through these commands

import { describe, it, expect, vi, beforeEach } from 'vitest'

// commit path → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { validateCommands } from '../external/commands'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-l'
const FILE = 'file-x'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let nextUserId = 400
let nextCred = 200

interface Member {
  token: string
  userId: number
  username: string
  credentialId: string
}

/** A project member at `level` holding a project-scoped PAT in `mode`. */
async function memberToken(tdb: TestDb, level: number, mode: 'ask' | 'act' = 'act'): Promise<Member> {
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
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const credentialId = `00000000-0000-0000-0000-${String(++nextCred).padStart(12, '0')}`
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [credentialId, String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return { token, userId, username, credentialId }
}

async function prepare(env: ReturnType<typeof makeEnv>, token: string, commands: unknown[]) {
  const res = (await handleExternalChangesetsRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    }),
    env,
  ))!
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
  return { res, body: (await res.json()) as any }
}

let nextConfirmation = 0

/** Seed the valid, unconsumed human approval an ask-mode commit consumes. */
async function seedConfirmation(tdb: TestDb, changesetId: string, digest: string, m: Member) {
  await tdb.db
    .prepare(
      `INSERT INTO changeset_confirmations (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      `conf-${++nextConfirmation}`,
      changesetId,
      String(m.userId),
      m.credentialId,
      digest,
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run()
}

async function projectRow(tdb: TestDb): Promise<{ name: string; archived_at: string | null; archived_by: number | null }> {
  const r = await tdb.pg.query<{ name: string; archived_at: string | null; archived_by: number | null }>(
    `SELECT name, archived_at, archived_by FROM projects WHERE id = $1`,
    [PROJECT],
  )
  return r.rows[0]
}

async function archiveProject(tdb: TestDb, byUserId: number): Promise<void> {
  await tdb.pg.query(
    `UPDATE projects SET archived_at = CURRENT_TIMESTAMP, archived_by = $1 WHERE id = $2`,
    [byUserId, PROJECT],
  )
}

let tdb: TestDb
beforeEach(async () => {
  nextUserId = 400
  nextConfirmation = 0
  tdb = await makeTestDb({
    // created_by is a non-participant, so the creator path never inflates a
    // member's resolved role past the level the test seeds.
    projects: [{ id: PROJECT, name: 'Original Name', created_by: 98, org_id: null }],
    files: [{ id: FILE, project_id: PROJECT, name: 'File X', event_id: 'f-evt-1' }],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: 'cell-1', side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
})

// ── RenameFile ───────────────────────────────────────────────────────────────

describe('RenameFile', () => {
  it('a contributor stages and commits a rename; the file row and event log both reflect it', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)

    const staged = await prepare(env, contributor.token, [
      { kind: 'RenameFile', fileId: FILE, name: 'Mark (draft 2)' },
    ])
    expect(staged.res.status).toBe(200)
    // Desugaring is visible in the stored plan: it holds the file.rename event.
    expect(staged.body.summary.events).toEqual([
      {
        kind: 'file.rename',
        count: 1,
        testimony: false,
        label: 'Rename a file',
      },
    ])

    const applied = await commit(env, contributor.token, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    expect(applied.body.receipt.appliedCount).toBe(1)

    const files = await tdb.pg.query<{ name: string }>(`SELECT name FROM files WHERE id = $1`, [FILE])
    expect(files.rows[0].name).toBe('Mark (draft 2)')

    const events = await tdb.pg.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM events WHERE project_id = $1 AND kind = 'file.rename'`,
      [PROJECT],
    )
    expect(events.rows).toHaveLength(1)
    expect(JSON.stringify(events.rows[0].payload)).toContain('Mark (draft 2)')
  })

  it('mirrors the UI floor: a viewer cannot stage a file rename', async () => {
    const env = makeEnv(tdb.db)
    const viewer = await memberToken(tdb, 100)
    const { res, body } = await prepare(env, viewer.token, [
      { kind: 'RenameFile', fileId: FILE, name: 'nope' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
  })

  it('an ask-mode rename applies nothing until a human approval is consumed', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400, 'ask')

    const staged = await prepare(env, contributor.token, [
      { kind: 'RenameFile', fileId: FILE, name: 'Approved Name' },
    ])
    expect(staged.res.status).toBe(200)
    expect(staged.body.changeset.autonomyMode).toBe('ask')

    const blocked = await commit(env, contributor.token, staged.body.changeset.id)
    expect(blocked.res.status).toBe(428)
    expect(blocked.body.error.code).toBe('confirmation_required')
    let files = await tdb.pg.query<{ name: string }>(`SELECT name FROM files WHERE id = $1`, [FILE])
    expect(files.rows[0].name).toBe('File X')

    await seedConfirmation(tdb, staged.body.changeset.id, staged.body.digest, contributor)
    const applied = await commit(env, contributor.token, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    files = await tdb.pg.query<{ name: string }>(`SELECT name FROM files WHERE id = $1`, [FILE])
    expect(files.rows[0].name).toBe('Approved Name')
  })

  it('rejects a whitespace-only name and a missing file, and cannot mix with other kinds', async () => {
    const env = makeEnv(tdb.db)
    const contributor = await memberToken(tdb, 400)

    const blank = await prepare(env, contributor.token, [{ kind: 'RenameFile', fileId: FILE, name: '   ' }])
    expect(blank.res.status).toBe(400)
    expect(JSON.stringify(blank.body.error.details)).toContain('whitespace-only')

    const missing = await prepare(env, contributor.token, [
      { kind: 'RenameFile', fileId: 'no-such-file', name: 'x' },
    ])
    expect(missing.res.status).toBe(400)
    expect(missing.body.error.code).toBe('validation_failed')

    const mixed = await prepare(env, contributor.token, [
      { kind: 'RenameFile', fileId: FILE, name: 'x' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'y' },
    ])
    expect(mixed.res.status).toBe(400)
    expect(mixed.body.error.message).toContain('cannot be mixed')
  })
})

// ── RenameProject ────────────────────────────────────────────────────────────

describe('RenameProject', () => {
  it('a maintainer stages and commits a rename; the projects row reflects it', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    const staged = await prepare(env, maintainer.token, [
      { kind: 'RenameProject', projectId: PROJECT, name: 'Renamed Project' },
    ])
    expect(staged.res.status).toBe(200)
    // The approval box names the op and reads as before → after.
    expect(staged.body.summary.command).toBe('RenameProject')
    expect(staged.body.summary.projectName).toBe('Renamed Project')
    expect(staged.body.summary.previousProjectName).toBe('Original Name')
    // Forced ask-mode: an act credential still gets an approval-gated plan.
    expect(staged.body.changeset.autonomyMode).toBe('ask')

    await seedConfirmation(tdb, staged.body.changeset.id, staged.body.digest, maintainer)
    const applied = await commit(env, maintainer.token, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    expect(applied.body.receipt.command).toBe('RenameProject')
    expect(applied.body.receipt.projectId).toBe(PROJECT)
    expect((await projectRow(tdb)).name).toBe('Renamed Project')
  })

  it('mirrors the UI floor: a project lead (500) cannot rename a project', async () => {
    const env = makeEnv(tdb.db)
    const lead = await memberToken(tdb, 500)
    const { res, body } = await prepare(env, lead.token, [
      { kind: 'RenameProject', projectId: PROJECT, name: 'nope' },
    ])
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect((await projectRow(tdb)).name).toBe('Original Name')
  })

  it('rejects a rename to the name the project already has', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)
    const { res, body } = await prepare(env, maintainer.token, [
      { kind: 'RenameProject', projectId: PROJECT, name: 'Original Name' },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('already named')
  })

  it('rejects a projectId that is not the changeset project, and a non-sole command', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    const wrongProject = await prepare(env, maintainer.token, [
      { kind: 'RenameProject', projectId: 'other-project', name: 'x' },
    ])
    expect(wrongProject.res.status).toBe(400)
    expect(wrongProject.body.error.message).toContain('must match the changeset project')

    const notSole = await prepare(env, maintainer.token, [
      { kind: 'RenameProject', projectId: PROJECT, name: 'x' },
      { kind: 'SetTranslation', fileId: FILE, cellId: 'cell-1', value: 'y' },
    ])
    expect(notSole.res.status).toBe(400)
    expect(notSole.body.error.message).toContain('must be the only command')
  })
})

// ── ArchiveProject / UnarchiveProject ────────────────────────────────────────

describe('ArchiveProject / UnarchiveProject', () => {
  it('an owner archives and then restores the project', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700)

    const stagedArchive = await prepare(env, owner.token, [
      { kind: 'ArchiveProject', projectId: PROJECT },
    ])
    expect(stagedArchive.res.status).toBe(200)
    expect(stagedArchive.body.summary.command).toBe('ArchiveProject')
    expect(stagedArchive.body.summary.projectName).toBe('Original Name')
    expect(stagedArchive.body.changeset.autonomyMode).toBe('ask')

    await seedConfirmation(tdb, stagedArchive.body.changeset.id, stagedArchive.body.digest, owner)
    const archived = await commit(env, owner.token, stagedArchive.body.changeset.id)
    expect(archived.res.status).toBe(200)
    expect(archived.body.receipt.command).toBe('ArchiveProject')
    let row = await projectRow(tdb)
    expect(row.archived_at).not.toBeNull()
    expect(String(row.archived_by)).toBe(String(owner.userId))

    // Unarchive must work ON an archived project — the ordinary role resolver
    // denies every archived row, so this is the archived-tolerant path.
    const stagedRestore = await prepare(env, owner.token, [
      { kind: 'UnarchiveProject', projectId: PROJECT },
    ])
    expect(stagedRestore.res.status).toBe(200)
    await seedConfirmation(tdb, stagedRestore.body.changeset.id, stagedRestore.body.digest, owner)
    const restored = await commit(env, owner.token, stagedRestore.body.changeset.id)
    expect(restored.res.status).toBe(200)
    expect(restored.body.receipt.command).toBe('UnarchiveProject')
    row = await projectRow(tdb)
    expect(row.archived_at).toBeNull()
    expect(row.archived_by).toBeNull()
  })

  it('mirrors the UI floor: a maintainer (600) cannot archive or restore', async () => {
    const env = makeEnv(tdb.db)
    const maintainer = await memberToken(tdb, 600)

    const denied = await prepare(env, maintainer.token, [{ kind: 'ArchiveProject', projectId: PROJECT }])
    expect(denied.res.status).toBe(403)
    expect(denied.body.error.code).toBe('permission_denied')
    expect((await projectRow(tdb)).archived_at).toBeNull()

    await archiveProject(tdb, 98)
    const deniedRestore = await prepare(env, maintainer.token, [
      { kind: 'UnarchiveProject', projectId: PROJECT },
    ])
    expect(deniedRestore.res.status).toBe(403)
    expect((await projectRow(tdb)).archived_at).not.toBeNull()
  })

  it('an ask-mode archive applies nothing until a human approval is consumed', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700, 'ask')

    const staged = await prepare(env, owner.token, [{ kind: 'ArchiveProject', projectId: PROJECT }])
    expect(staged.res.status).toBe(200)
    expect(staged.body.changeset.autonomyMode).toBe('ask')

    const blocked = await commit(env, owner.token, staged.body.changeset.id)
    expect(blocked.res.status).toBe(428)
    expect(blocked.body.error.code).toBe('confirmation_required')
    expect((await projectRow(tdb)).archived_at).toBeNull()

    await seedConfirmation(tdb, staged.body.changeset.id, staged.body.digest, owner)
    const applied = await commit(env, owner.token, staged.body.changeset.id)
    expect(applied.res.status).toBe(200)
    expect((await projectRow(tdb)).archived_at).not.toBeNull()
  })

  it('archiving an already-archived project is rejected at prepare', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700)
    await archiveProject(tdb, owner.userId)

    const { res, body } = await prepare(env, owner.token, [
      { kind: 'ArchiveProject', projectId: PROJECT },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('already archived')
  })

  it('restoring a project that is not archived is rejected at prepare', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700)
    const { res, body } = await prepare(env, owner.token, [
      { kind: 'UnarchiveProject', projectId: PROJECT },
    ])
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('not archived')
  })

  it('a human archiving first lands the staged plan as superseded, not applied twice', async () => {
    const env = makeEnv(tdb.db)
    const owner = await memberToken(tdb, 700)

    const staged = await prepare(env, owner.token, [{ kind: 'ArchiveProject', projectId: PROJECT }])
    expect(staged.res.status).toBe(200)

    await archiveProject(tdb, 98)

    const late = await commit(env, owner.token, staged.body.changeset.id)
    expect(late.res.status).toBe(409)
    expect(late.body.error.code).toBe('plan_stale')
    expect(late.body.error.details.status).toBe('superseded')
    // The human's archive attribution is untouched — nothing was re-applied.
    expect(String((await projectRow(tdb)).archived_by)).toBe('98')
    const rows = await tdb.pg.query<{ status: string }>(`SELECT status FROM changesets WHERE id = $1`, [
      staged.body.changeset.id,
    ])
    expect(rows.rows[0].status).toBe('superseded')
  })
})

// ── No delete, of any kind ───────────────────────────────────────────────────

describe('deletes are not exposed as commands', () => {
  it.each(['DeleteFile', 'DeleteProject', 'RemoveFile', 'ArchiveFile'])(
    '%s is not a recognized command kind',
    (kind) => {
      const result = validateCommands([{ kind, projectId: PROJECT, fileId: FILE }])
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.issues[0].message).toContain('unsupported command kind')
    },
  )
})
