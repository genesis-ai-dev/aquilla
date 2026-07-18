// Tests for the Agent API v1.1 audio-artifact upload + LinkMedia pipeline
// (design §3, W2-B).
//
// Covers:
//   - audio upload: bytes land in the existing audio R2 layout, row kind='audio'
//   - wrong content-type rejected; oversize rejected
//   - inspect returns size + content type only (no format sniffing)
//   - LinkMedia prepare: happy path + each precondition failure (missing cell,
//     missing artifact, non-audio artifact)
//   - LinkMedia commit: cell_audio projection reflects attach + select, bytes
//     copied under the target cell's file, provenance stamped
//   - crash-retry from status='committing' reuses stored event ids (no
//     duplicate cell.audio events / cell_audio rows)
//   - observer-role credential is permission_denied

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalArtifactsRequest, MAX_ARTIFACT_BYTES } from '../external/artifacts-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { audioObjectKey } from '../audio'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-a'
const FILE = 'file-x'
const CELL = 'cell-1'
const CRED_CONTRIB = '00000000-0000-0000-0000-0000000000b1'
const CRED_OBSERVER = '00000000-0000-0000-0000-0000000000b2'

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj.body, httpMetadata: obj.httpMetadata }
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
    _has(key: string) {
      return store.has(key)
    },
    _get(key: string) {
      return store.get(key)
    },
    _allKeys() {
      return Array.from(store.keys())
    },
  }
}

const SECRET = 'test-secret'
function makeEnv(db: AquillaDb, bucket: ReturnType<typeof makeStubBucket>) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    BASE_URL: 'https://aquilla.app',
    SNAPSHOTS: bucket as unknown as R2Bucket,
    R2_KEY_PREFIX: '' as string | undefined,
  }
}

interface CredSpec {
  credentialId: string
  userId: number
  username: string
  mode?: 'ask' | 'act'
}

async function credToken(tdb: TestDb, spec: CredSpec): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [spec.userId, spec.username, `${spec.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [spec.credentialId, String(spec.userId), tokenPrefix, tokenHash, spec.mode ?? 'act', PROJECT],
  )
  return token
}

async function seedProject(): Promise<TestDb> {
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 }, // alice: contributor
      { project_id: PROJECT, user_id: 2, role_level: 100 }, // obs: observer/viewer
    ],
    cells: [
      {
        project_id: PROJECT, file_id: FILE, cell_id: CELL, side: 'source',
        value: 'source one', event_id: 'src-evt-1', last_edit_at: 1,
      },
    ],
  })
}

// ── request helpers ──────────────────────────────────────────────────────────

function uploadReq(
  token: string,
  name: string,
  body: BodyInit,
  contentType: string | undefined,
  kind?: string,
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-artifact-name': name,
  }
  if (contentType) headers['content-type'] = contentType
  if (kind) headers['x-artifact-kind'] = kind
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
    method: 'POST',
    headers,
    body,
  })
}

function getReq(token: string, path: string): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

function prepareReq(token: string, commands: unknown[]): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  })
}

function commitReq(token: string, id: string, agentMeta?: unknown): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (agentMeta !== undefined) headers['x-agent-meta'] = JSON.stringify(agentMeta)
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets/${id}/commit`, {
    method: 'POST',
    headers,
  })
}

/** Upload an audio artifact; returns { artifactId, audioId }. */
async function uploadAudio(
  env: ReturnType<typeof makeEnv>,
  token: string,
  bytes = new Uint8Array([1, 2, 3, 4, 5]),
  contentType = 'audio/wav',
): Promise<{ artifactId: string; audioId: string }> {
  const res = (await handleExternalArtifactsRequest(
    uploadReq(token, 'take.wav', bytes, contentType, 'audio'),
    env,
  ))!
  expect(res.status).toBe(200)
  const body = (await res.json()) as { artifactId: string; audioId: string; kind: string }
  expect(body.kind).toBe('audio')
  return { artifactId: body.artifactId, audioId: body.audioId }
}

let tdb: TestDb
let bucket: ReturnType<typeof makeStubBucket>
let env: ReturnType<typeof makeEnv>

beforeEach(async () => {
  tdb = await seedProject()
  bucket = makeStubBucket()
  env = makeEnv(tdb.db, bucket)
})

// ── audio artifact upload / inspect ──────────────────────────────────────────

describe('audio artifacts — upload', () => {
  it('stores bytes in the audio R2 layout and records kind=audio', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4])
    const { artifactId, audioId } = await uploadAudio(env, token, bytes, 'audio/wav')

    expect(audioId).toBe(`${artifactId}.wav`)

    // Bytes live in the EXISTING audio R2 layout (artifactId in the file slot).
    const expectedKey = audioObjectKey(env, PROJECT, artifactId, audioId)
    expect(bucket._has(expectedKey)).toBe(true)
    expect(new Uint8Array(bucket._get(expectedKey)!.body)).toEqual(bytes)

    // Row records kind + audio_id + the audio-layout r2_key.
    const rows = await tdb.rows<{ id: string; kind: string; audio_id: string | null; r2_key: string }>('artifacts')
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('audio')
    expect(rows[0].audio_id).toBe(audioId)
    expect(rows[0].r2_key).toBe(expectedKey)
  })

  it('accepts each supported audio content type with the right extension', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const cases: [string, string][] = [
      ['audio/wav', 'wav'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp4', 'm4a'],
      ['audio/x-m4a', 'm4a'],
      ['audio/ogg', 'ogg'],
    ]
    for (const [ct, ext] of cases) {
      const { audioId } = await uploadAudio(env, token, new Uint8Array([1, 2, 3]), ct)
      expect(audioId.endsWith(`.${ext}`)).toBe(true)
    }
  })

  it('rejects a non-audio content type for an audio upload', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const res = (await handleExternalArtifactsRequest(
      uploadReq(token, 'bad.txt', new Uint8Array([1, 2, 3]), 'text/plain', 'audio'),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
    // Nothing persisted.
    expect(await tdb.rows('artifacts')).toHaveLength(0)
    expect(bucket._allKeys()).toHaveLength(0)
  })

  it('rejects an oversize audio upload', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const big = new Uint8Array(MAX_ARTIFACT_BYTES + 1)
    const res = (await handleExternalArtifactsRequest(
      uploadReq(token, 'big.wav', big, 'audio/wav', 'audio'),
      env,
    ))!
    expect(res.status).toBe(400)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('inspect returns size + content type only for an audio artifact', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const { artifactId, audioId } = await uploadAudio(env, token, bytes, 'audio/mpeg')

    const res = (await handleExternalArtifactsRequest(getReq(token, `/${artifactId}/inspect`), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      detectedFormat: string
      details: { contentType: string; sizeBytes: number; audioId: string }
    }
    expect(body.detectedFormat).toBe('audio')
    expect(body.details.contentType).toBe('audio/mpeg')
    expect(body.details.sizeBytes).toBe(bytes.byteLength)
    expect(body.details.audioId).toBe(audioId)
    // No format-sniffing fields (lineCount / detectedFormat=usfm etc.).
    expect('lineCount' in body.details).toBe(false)
  })

  it('metadata exposes kind + audioId', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId, audioId } = await uploadAudio(env, token)
    const res = (await handleExternalArtifactsRequest(getReq(token, `/${artifactId}`), env))!
    const body = (await res.json()) as { artifact: { kind: string; audioId: string } }
    expect(body.artifact.kind).toBe('audio')
    expect(body.artifact.audioId).toBe(audioId)
  })
})

// ── LinkMedia prepare ─────────────────────────────────────────────────────────

describe('LinkMedia — prepare preconditions', () => {
  it('happy path: stages a plan with mediaLinked summary', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, token)

    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId }]),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: { mediaLinked: number }; changeset: { status: string } }
    expect(body.summary.mediaLinked).toBe(1)
    expect(body.changeset.status).toBe('staged')
  })

  it('rejects when the target cell does not exist', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, token)
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: 'nope', artifactId }]),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects when the artifact does not exist', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId: 'missing-artifact' }]),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects when the artifact is not an audio artifact', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    // Upload a plain source artifact (no x-artifact-kind header).
    const up = (await handleExternalArtifactsRequest(
      uploadReq(token, 'Genesis.usfm', new TextEncoder().encode('\\id GEN'), 'text/plain'),
      env,
    ))!
    const sourceId = ((await up.json()) as { artifactId: string }).artifactId

    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId: sourceId }]),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_failed')
  })

  it('rejects mixing LinkMedia with another command kind', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, token)
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [
        { kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId },
        { kind: 'SetTranslation', fileId: FILE, cellId: CELL, value: 'x' },
      ]),
      env,
    ))!
    expect(res.status).toBe(400)
  })
})

// ── LinkMedia commit ──────────────────────────────────────────────────────────

async function prepareLinkMedia(token: string, artifactId: string): Promise<string> {
  const res = (await handleExternalChangesetsRequest(
    prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId }]),
    env,
  ))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { changeset: { id: string } }).changeset.id
}

describe('LinkMedia — commit', () => {
  it('attaches + selects the clip, projecting cell_audio and copying bytes under the cell file', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const audioBytes = new Uint8Array([5, 5, 5, 9, 9, 9])
    const { artifactId, audioId } = await uploadAudio(env, token, audioBytes, 'audio/wav')
    const csId = await prepareLinkMedia(token, artifactId)

    const res = (await handleExternalChangesetsRequest(commitReq(token, csId, { model: 'claude' }), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { receipt: { appliedCount: number; eventIds: string[] } }
    // attach + select.
    expect(body.receipt.appliedCount).toBe(2)
    expect(body.receipt.eventIds).toHaveLength(2)

    // cell_audio projection: one selected, live clip for the cell.
    const audio = await tdb.rows<{
      cell_id: string; audio_id: string; slot: string; url: string; selected: number; deleted: number
    }>('cell_audio')
    expect(audio).toHaveLength(1)
    expect(audio[0].cell_id).toBe(CELL)
    expect(audio[0].audio_id).toBe(audioId)
    expect(audio[0].slot).toBe('recording')
    expect(audio[0].url).toBe(`frontier-audio://${audioId}`)
    expect(Number(audio[0].selected)).toBe(1)
    expect(Number(audio[0].deleted)).toBe(0)

    // Bytes copied under the TARGET cell's file so /audio serves them natively.
    const playKey = audioObjectKey(env, PROJECT, FILE, audioId)
    expect(bucket._has(playKey)).toBe(true)
    expect(new Uint8Array(bucket._get(playKey)!.body)).toEqual(audioBytes)

    // Provenance stamped on both audio events.
    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    const audioEvents = events.filter((e) => e.kind.startsWith('cell.audio.'))
    expect(audioEvents).toHaveLength(2)
    for (const e of audioEvents) {
      const prov = typeof e.provenance === 'string' ? JSON.parse(e.provenance) : e.provenance
      expect(prov.origin).toBe('agent')
      expect(prov.channel).toBe('rest')
      expect(prov.changeset_id).toBe(csId)
      expect(prov.human_authority).toEqual({ user_id: '1', credential_id: CRED_CONTRIB })
    }

    // Changeset committed.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs[0].status).toBe('committed')
  })

  it('crash-retry from committing reuses stored ids — no duplicate events / cell_audio rows', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, token)
    const csId = await prepareLinkMedia(token, artifactId)

    // First commit.
    const res1 = (await handleExternalChangesetsRequest(commitReq(token, csId), env))!
    expect(res1.status).toBe(200)
    const eventsAfter1 = await tdb.rows<{ id: string; kind: string }>('events')
    const attachIds1 = eventsAfter1.filter((e) => e.kind === 'cell.audio.attach').map((e) => e.id)
    const selectIds1 = eventsAfter1.filter((e) => e.kind === 'cell.audio.select').map((e) => e.id)
    expect(attachIds1).toHaveLength(1)
    expect(selectIds1).toHaveLength(1)

    // Simulate a mid-commit crash: reset the changeset to 'committing'.
    await tdb.pg.query(
      `UPDATE changesets SET status = 'committing', receipt = NULL WHERE id = $1`,
      [csId],
    )

    // Re-commit (crash-retry path): re-posts identical ids → deduped.
    const res2 = (await handleExternalChangesetsRequest(commitReq(token, csId), env))!
    expect(res2.status).toBe(200)

    const eventsAfter2 = await tdb.rows<{ id: string; kind: string }>('events')
    const attachIds2 = eventsAfter2.filter((e) => e.kind === 'cell.audio.attach').map((e) => e.id)
    const selectIds2 = eventsAfter2.filter((e) => e.kind === 'cell.audio.select').map((e) => e.id)
    // Same single ids — no duplicate events.
    expect(attachIds2).toEqual(attachIds1)
    expect(selectIds2).toEqual(selectIds1)
    // No duplicate cell_audio rows.
    expect(await tdb.rows('cell_audio')).toHaveLength(1)
  })

  it('plan_stale when the artifact vanishes between prepare and commit', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, token)
    const csId = await prepareLinkMedia(token, artifactId)

    // Artifact deleted after staging.
    await tdb.pg.query(`DELETE FROM artifacts WHERE id::text = $1`, [artifactId])

    const res = (await handleExternalChangesetsRequest(commitReq(token, csId), env))!
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('plan_stale')
  })

  it('observer-role credential is permission_denied at prepare', async () => {
    const token = await credToken(tdb, { credentialId: CRED_OBSERVER, userId: 2, username: 'obs' })
    // Upload as the contributor so an audio artifact exists.
    const contribToken = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 1, username: 'alice' })
    const { artifactId } = await uploadAudio(env, contribToken)

    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, [{ kind: 'LinkMedia', fileId: FILE, cellId: CELL, artifactId }]),
      env,
    ))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('permission_denied')
  })
})
