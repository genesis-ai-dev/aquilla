// Tests for the Agent API artifact upload + PlanImport pipeline (AQU-533 W2-B).
//
// Covers:
//   - artifact upload round-trips bytes + sha256; oversize rejected
//   - inspect detects usfm vs json
//   - PlanImport prepare summary (files_created / source_cells_added +
//     duplicate-name warning)
//   - PlanImport commit by a PROJECT_LEAD credential creates the file + source
//     cells (projection asserted) with server-stamped provenance
//   - a CONTRIBUTOR credential is permission_denied at commit (source.* needs
//     PROJECT_LEAD 500, enforced by the /events perimeter)
//   - the referenced artifact is linked to the created file after commit
//   - >5000 cells → validation_failed
//   - the changeset digest is stable for identical plans

import { describe, it, expect, beforeEach, vi } from 'vitest'

// commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import {
  handleExternalArtifactsRequest,
  INSPECT_SNIFF_BYTES,
  MAX_ARTIFACT_BYTES,
} from '../external/artifacts-route'
import { handleExternalChangesetsRequest } from '../external/changesets-route'
import { handleEventsWriteRequest } from '../events/route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const PROJECT = 'proj-a'
const CRED_LEAD = '00000000-0000-0000-0000-0000000000a1'
const CRED_CONTRIB = '00000000-0000-0000-0000-0000000000a2'

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  const getRanges: Array<{ offset: number; length: number } | undefined> = []
  return {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      getRanges.push(options?.range)
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
    _size() {
      return store.size
    },
    _allKeys() {
      return Array.from(store.keys())
    },
    _getRanges() {
      return getRanges
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

async function seedProject(extra: Parameters<typeof makeTestDb>[0] = {}): Promise<TestDb> {
  return makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 500 }, // lead
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // contributor
    ],
    ...extra,
  })
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── artifact routing helpers ─────────────────────────────────────────────────

function uploadReq(token: string, name: string, body: BodyInit, contentType?: string): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'x-artifact-name': name,
  }
  if (contentType) headers['content-type'] = contentType
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

function fakeZipMemberInventory(names: string[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks = names.map((name) => {
    const encoded = encoder.encode(name)
    const chunk = new Uint8Array(30 + encoded.length)
    chunk.set([0x50, 0x4b, 0x03, 0x04], 0)
    chunk[26] = encoded.length & 0xff
    chunk[27] = encoded.length >> 8
    chunk.set(encoded, 30)
    return chunk
  })
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function prepareReq(token: string, command: unknown): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/changesets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [command] }),
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

let tdb: TestDb
let bucket: ReturnType<typeof makeStubBucket>
let env: ReturnType<typeof makeEnv>

// ── artifact upload / inspect ────────────────────────────────────────────────

describe('artifacts — upload + retrieval', () => {
  beforeEach(async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
  })

  it('uploads bytes, stores metadata, and round-trips content + sha256', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const bytes = new TextEncoder().encode('\\id GEN\n\\c 1\n\\v 1 In the beginning')
    const expectedSha = await sha256Hex(bytes)

    const res = (await handleExternalArtifactsRequest(uploadReq(token, 'Genesis.usfm', bytes, 'text/plain'), env))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifactId: string; sha256: string; sizeBytes: number }
    expect(body.sha256).toBe(expectedSha)
    expect(body.sizeBytes).toBe(bytes.byteLength)

    // Metadata row landed.
    const rows = await tdb.rows<{ id: string; name: string; sha256: string; r2_key: string; file_id: string | null }>('artifacts')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Genesis.usfm')
    expect(rows[0].sha256).toBe(expectedSha)
    expect(rows[0].file_id).toBeNull()

    // Content round-trips byte-for-byte.
    const contentRes = (await handleExternalArtifactsRequest(getReq(token, `/${body.artifactId}/content`), env))!
    expect(contentRes.status).toBe(200)
    const roundTrip = new Uint8Array(await contentRes.arrayBuffer())
    expect(await sha256Hex(roundTrip)).toBe(expectedSha)

    // Metadata endpoint.
    const metaRes = (await handleExternalArtifactsRequest(getReq(token, `/${body.artifactId}`), env))!
    const meta = (await metaRes.json()) as { artifact: { name: string; sizeBytes: number } }
    expect(meta.artifact.name).toBe('Genesis.usfm')
    expect(meta.artifact.sizeBytes).toBe(bytes.byteLength)
  })

  it('rejects an oversize upload with validation_failed (exposing the limit) and stores nothing', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const big = new Uint8Array(MAX_ARTIFACT_BYTES + 1)
    const res = (await handleExternalArtifactsRequest(uploadReq(token, 'big.bin', big), env))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { maxBytes: number } } }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details.maxBytes).toBe(MAX_ARTIFACT_BYTES)
    expect(bucket._size()).toBe(0)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('rejects a declared oversize upload before buffering or writing it', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const req = uploadReq(token, 'huge.bin', new Uint8Array([1]))
    req.headers.set('content-length', String(MAX_ARTIFACT_BYTES + 1))

    const res = (await handleExternalArtifactsRequest(req, env))!

    expect(res.status).toBe(400)
    expect(bucket._size()).toBe(0)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('requires the x-artifact-name header', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const req = new Request(`https://w/api/v1/external/projects/${PROJECT}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3]),
    })
    const res = (await handleExternalArtifactsRequest(req, env))!
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('validation_failed')
  })

  it('detects usfm vs json on inspect', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    const usfm = new TextEncoder().encode('\\id GEN EN\n\\c 1\n\\v 1 hello')
    const up1 = (await handleExternalArtifactsRequest(uploadReq(token, 'a.usfm', usfm), env))!
    const id1 = ((await up1.json()) as { artifactId: string }).artifactId
    const insp1 = (await handleExternalArtifactsRequest(getReq(token, `/${id1}/inspect`), env))!
    const d1 = (await insp1.json()) as { detectedFormat: string; details: { lineCount: number; byteCount: number } }
    expect(d1.detectedFormat).toBe('usfm')
    expect(d1.details.byteCount).toBe(usfm.byteLength)
    expect(d1.details.lineCount).toBe(3)

    const json = new TextEncoder().encode(JSON.stringify([{ ref: 'GEN 1:1', text: 'hi' }, { ref: 'GEN 1:2', text: 'yo' }]))
    const up2 = (await handleExternalArtifactsRequest(uploadReq(token, 'b.json', json, 'application/json'), env))!
    const id2 = ((await up2.json()) as { artifactId: string }).artifactId
    const insp2 = (await handleExternalArtifactsRequest(getReq(token, `/${id2}/inspect`), env))!
    const d2 = (await insp2.json()) as { detectedFormat: string; details: { jsonShape: string; length: number } }
    expect(d2.detectedFormat).toBe('json')
    expect(d2.details.jsonShape).toBe('array')
    expect(d2.details.length).toBe(2)

    const artifacts = await tdb.rows<{ id: string; metadata: unknown }>('artifacts')
    const inspected = artifacts.find((artifact) => artifact.id === id2)
    const metadata = typeof inspected?.metadata === 'string'
      ? JSON.parse(inspected.metadata)
      : inspected?.metadata
    expect(metadata.inspection.detectedFormat).toBe('json')
    expect(bucket._getRanges()).toContainEqual({ offset: 0, length: INSPECT_SNIFF_BYTES })
  })

  it('classifies a Paratext ZIP from its member inventory without inflating it', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const zip = fakeZipMemberInventory(['Settings.xml', '01GENproject.SFM', '02EXOproject.SFM'])
    const upload = (await handleExternalArtifactsRequest(uploadReq(token, 'project.zip', zip, 'application/zip'), env))!
    const artifactId = ((await upload.json()) as { artifactId: string }).artifactId

    const response = (await handleExternalArtifactsRequest(getReq(token, `/${artifactId}/inspect`), env))!
    const inspection = (await response.json()) as {
      detectedFormat: string
      details: { confidence: number; scriptureMemberCount: number; scriptureMembers: string[] }
    }
    expect(inspection.detectedFormat).toBe('paratext-project')
    expect(inspection.details.confidence).toBeGreaterThan(0.95)
    expect(inspection.details.scriptureMemberCount).toBe(2)
    expect(inspection.details.scriptureMembers).toEqual(['01GENproject.SFM', '02EXOproject.SFM'])
  })
})

// ── PlanImport prepare ───────────────────────────────────────────────────────

describe('PlanImport — prepare', () => {
  it('computes a files_created / source_cells_added summary', async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'Genesis.usfm',
        fileType: 'usfm',
        sourceLanguage: 'grc',
        cells: [
          { id: 'c1', content: 'In the beginning', canonicalRef: 'GEN 1:1' },
          { content: 'And the earth', canonicalRef: 'GEN 1:2' },
        ],
      }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: { filesCreated: number; sourceCellsAdded: number; warnings: unknown[] }; digest: string }
    expect(body.summary.filesCreated).toBe(1)
    expect(body.summary.sourceCellsAdded).toBe(2)
    expect(body.summary.warnings).toHaveLength(0)
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('warns (does not error) when a same-named active file already exists', async () => {
    tdb = await seedProject({
      files: [{ id: 'file-dup', project_id: PROJECT, name: 'Dup.usfm' }],
    })
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'Dup.usfm',
        fileType: 'usfm',
        cells: [{ content: 'x' }],
      }),
      env,
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: { warnings: { code: string; fileId: string }[] } }
    const dup = body.summary.warnings.filter((w) => w.code === 'duplicate_file')
    expect(dup).toHaveLength(1)
    expect(dup[0].fileId).toBe('file-dup')
  })

  it('rejects a plan over the cell cap with validation_failed', async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    const cells = Array.from({ length: 5001 }, (_, i) => ({ content: `c${i}` }))
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, { kind: 'PlanImport', fileName: 'Big.usfm', fileType: 'usfm', cells }),
      env,
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: { maxCells: number } } }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details.maxCells).toBe(5000)
  })

  it('produces a stable digest for identical plans', async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const command = {
      kind: 'PlanImport',
      fileName: 'Genesis.usfm',
      fileType: 'usfm',
      cells: [{ id: 'c1', content: 'a' }, { id: 'c2', content: 'b' }],
    }
    const r1 = (await handleExternalChangesetsRequest(prepareReq(token, command), env))!
    const r2 = (await handleExternalChangesetsRequest(prepareReq(token, command), env))!
    const d1 = ((await r1.json()) as { digest: string }).digest
    const d2 = ((await r2.json()) as { digest: string }).digest
    expect(d1).toBe(d2)
  })

  it('rejects native fidelity without an inspected artifact and verified built-in profile', async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const command = {
      kind: 'PlanImport',
      fileName: 'Genesis.usfm',
      fileType: 'usfm',
      manifest: {
        version: 1,
        profileId: 'builtin:usfm-lossless',
        profileVersion: '1',
        deterministic: true,
        fidelity: 'native',
      },
      cells: [{ content: 'In the beginning', type: 'verse', canonicalRef: 'GEN 1:1' }],
    }

    const withoutArtifact = (await handleExternalChangesetsRequest(prepareReq(token, command), env))!
    expect(withoutArtifact.status).toBe(400)

    const upload = (await handleExternalArtifactsRequest(
      uploadReq(token, 'Genesis.usfm', new TextEncoder().encode('\\id GEN\n\\c 1\n\\v 1 In the beginning')),
      env,
    ))!
    const artifactId = ((await upload.json()) as { artifactId: string }).artifactId
    const beforeInspection = (await handleExternalChangesetsRequest(
      prepareReq(token, { ...command, artifactId }),
      env,
    ))!
    expect(beforeInspection.status).toBe(400)

    await handleExternalArtifactsRequest(getReq(token, `/${artifactId}/inspect`), env)
    const verified = (await handleExternalChangesetsRequest(
      prepareReq(token, { ...command, artifactId }),
      env,
    ))!
    expect(verified.status).toBe(200)
  })
})

// ── PlanImport commit ────────────────────────────────────────────────────────

describe('PlanImport — commit', () => {
  beforeEach(async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
  })

  it('a PROJECT_LEAD credential creates the file + source cells with provenance stamped', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const prepRes = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'Genesis.usfm',
        fileType: 'usfm',
        cells: [
          { id: 'gen-1-1', content: 'In the beginning', canonicalRef: 'GEN 1:1', section: 'ch1' },
          { id: 'gen-1-2', content: 'And the earth', canonicalRef: 'GEN 1:2' },
        ],
      }),
      env,
    ))!
    const prep = (await prepRes.json()) as { changeset: { id: string } }

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id, { model: 'claude' }), env))!
    expect(res.status).toBe(200)
    const commit = (await res.json()) as { receipt: { appliedCount: number; fileId: string; eventIds: string[] } }
    expect(commit.receipt.appliedCount).toBe(5) // create + hide + 2 cells + reveal
    const fileId = commit.receipt.fileId
    expect(fileId).toBeTruthy()

    // File projection.
    const files = await tdb.rows<{ id: string; name: string; deleted_at: number | null }>('files')
    expect(files.find((f) => f.id === fileId)?.name).toBe('Genesis.usfm')
    expect(files.find((f) => f.id === fileId)?.deleted_at).toBeNull()

    // Source cell projection.
    const cells = await tdb.rows<{ side: string; value: string; cell_id: string; file_id: string }>('cells')
    const source = cells.filter((c) => c.side === 'source' && c.file_id === fileId)
    expect(source).toHaveLength(2)
    expect(source.map((c) => c.value).sort()).toEqual(['And the earth', 'In the beginning'])

    // Provenance stamped on the file + cell events.
    const events = await tdb.rows<{ kind: string; provenance: unknown }>('events')
    expect(events).toHaveLength(5)
    for (const e of events) {
      const prov = typeof e.provenance === 'string' ? JSON.parse(e.provenance) : e.provenance
      expect(prov).not.toBeNull()
      expect(prov.origin).toBe('agent')
      expect(prov.channel).toBe('rest')
      expect(prov.changeset_id).toBe(prep.changeset.id)
      expect(prov.human_authority).toEqual({ user_id: '1', credential_id: CRED_LEAD })
      expect(prov.agent).toEqual({ model: 'claude' })
    }

    // Changeset committed with a receipt.
    const cs = await tdb.rows<{ status: string; receipt: unknown }>('changesets')
    expect(cs[0].status).toBe('committed')
  })

  it('a CONTRIBUTOR credential is permission_denied at prepare (PlanImport needs PROJECT_LEAD)', async () => {
    const token = await credToken(tdb, { credentialId: CRED_CONTRIB, userId: 2, username: 'contrib' })
    // PlanImport compiles to file.create / source.cell.create (PROJECT_LEAD 500).
    // A contributor (400) is now denied at PREPARE — staging a plan it could
    // never commit is pointless and leaks the effect summary, so the gate moved
    // to prepare rather than only firing at the /events perimeter on commit.
    const prepRes = (await handleExternalChangesetsRequest(
      prepareReq(token, { kind: 'PlanImport', fileName: 'Nope.usfm', fileType: 'usfm', cells: [{ content: 'x' }] }),
      env,
    ))!
    expect(prepRes.status).toBe(403)
    const prep = (await prepRes.json()) as { error: { code: string }; changeset?: unknown }
    expect(prep.error.code).toBe('permission_denied')
    expect(prep.changeset).toBeUndefined()

    // Nothing staged, nothing landed.
    expect(await tdb.rows('changesets')).toHaveLength(0)
    const files = await tdb.rows('files')
    expect(files).toHaveLength(0)
    const created = (await tdb.rows<{ kind: string }>('events')).filter(
      (e) => e.kind === 'file.create' || e.kind === 'source.cell.create',
    )
    expect(created).toHaveLength(0)
  })

  it('binds a normalized artifact manifest and writes explicit target lanes', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    // Upload an artifact first.
    const bytes = new TextEncoder().encode('\\id GEN\n\\v 1 x')
    const up = (await handleExternalArtifactsRequest(uploadReq(token, 'Genesis.usfm', bytes), env))!
    const artifactId = ((await up.json()) as { artifactId: string }).artifactId
    await tdb.pg.query(
      `INSERT INTO project_settings (project_id, settings, version)
       VALUES ($1, $2::jsonb, 1)`,
      [PROJECT, JSON.stringify({ targetLanes: ['fr', 'arq'] })],
    )

    const prepRes = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'Genesis.usfm',
        fileType: 'usfm',
        artifactId,
        manifest: {
          version: 1,
          profileId: 'agent:custom-scripture',
          profileVersion: '2026-07-20',
          deterministic: false,
          fidelity: 'content-only',
          memberPath: '01GENproject.SFM',
          warningCounts: {},
          recipe: {
            version: 1,
            name: 'Custom tagged Scripture',
            inputFormat: 'custom-sfm',
            id: 'ai-verse-prefix',
            strategy: 'records',
            config: { versePrefix: '@v' },
            proposedBy: 'ai',
          },
        },
        cells: [{
          content: 'In the beginning',
          canonicalRef: 'GEN 1:1',
          type: 'verse',
          unitKey: 'scripture:GEN 1:1',
          displayLabel: '1',
          address: { scheme: 'scripture', book: 'GEN', chapter: 1, verse: '1' },
          sourceLocator: { kind: 'recipe', recipeId: 'ai-verse-prefix', record: 3 },
          variants: [
            { laneId: 'fr', languageTag: 'fr', content: 'Au commencement' },
            { laneId: 'arq', languageTag: 'arq', content: 'فالبداية' },
          ],
        }],
      }),
      env,
    ))!
    const prep = (await prepRes.json()) as { summary: { artifactLinked: string }; changeset: { id: string } }
    expect(prep.summary.artifactLinked).toBe(artifactId)

    const res = (await handleExternalChangesetsRequest(commitReq(token, prep.changeset.id), env))!
    const commit = (await res.json()) as { receipt: { fileId: string } }

    const artifact = await tdb.rows<{ id: string; file_id: string | null }>('artifacts')
    expect(artifact[0].file_id).toBe(commit.receipt.fileId)

    const bindings = await tdb.rows<{
      artifact_id: string
      file_id: string
      member_path: string
      profile_id: string
      fidelity: string
      recipe: unknown
    }>('artifact_bindings')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({
      artifact_id: artifactId,
      file_id: commit.receipt.fileId,
      member_path: '01GENproject.SFM',
      profile_id: 'agent:custom-scripture',
      fidelity: 'content-only',
    })
    const recipe = typeof bindings[0].recipe === 'string' ? JSON.parse(bindings[0].recipe) : bindings[0].recipe
    expect(recipe).toMatchObject({ strategy: 'records', config: { versePrefix: '@v' } })

    const cells = await tdb.rows<{
      side: string
      target_lang: string
      value: string
      metadata: unknown
    }>('cells')
    const source = cells.find((cell) => cell.side === 'source')!
    const sourceMeta = typeof source.metadata === 'string' ? JSON.parse(source.metadata) : source.metadata
    expect(sourceMeta.aquillaImport).toMatchObject({
      unitKey: 'scripture:GEN 1:1',
      kind: 'verse',
      displayLabel: '1',
    })
    expect(cells.filter((cell) => cell.side === 'target').map((cell) => cell.target_lang).sort())
      .toEqual(['arq', 'fr'])

    const files = await tdb.rows<{ id: string; meta: unknown }>('files')
    const file = files.find((row) => row.id === commit.receipt.fileId)!
    const fileMeta = typeof file.meta === 'string' ? JSON.parse(file.meta) : file.meta
    expect(fileMeta.aquillaImport).toMatchObject({
      profileId: 'agent:custom-scripture',
      unitCount: 1,
      recipe: { strategy: 'records' },
    })
  })

  it('rejects target variants for lanes the workspace cannot select', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const response = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'pairs.xlf',
        fileType: 'xliff',
        targetLanguage: 'fr',
        cells: [{ content: 'Hello', variants: [{ laneId: 'de', languageTag: 'de', content: 'Hallo' }] }],
      }),
      env,
    ))!
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toMatch(/unregistered lane/)
    expect(await tdb.rows('changesets')).toHaveLength(0)
  })

  it('rejects a PlanImport whose artifactId does not exist in the project', async () => {
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalChangesetsRequest(
      prepareReq(token, {
        kind: 'PlanImport',
        fileName: 'X.usfm',
        fileType: 'usfm',
        artifactId: 'does-not-exist',
        cells: [{ content: 'x' }],
      }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('validation_failed')
  })
})

// ── PlanImport commit replay: crash-retry idempotency (W1-B §4/§9) ───────────
// The flagship idempotency test: a multi-chunk PlanImport crashes mid-commit
// after a PARTIAL apply, then retries. Pre-W1-B, commit minted the file id +
// event ids at commit time, so a retry produced a DUPLICATE file and duplicate
// source cells. Now those ids are minted at prepare and stored; the retry
// re-posts identical ids that the /events idempotency layer (INSERT OR IGNORE
// on event id) dedupes.

describe('PlanImport — commit replay (crash-retry idempotency)', () => {
  it('a mid-commit crash retry of a multi-chunk PlanImport produces zero duplicate events/files', async () => {
    tdb = await seedProject()
    bucket = makeStubBucket()
    env = makeEnv(tdb.db, bucket)
    const token = await credToken(tdb, { credentialId: CRED_LEAD, userId: 1, username: 'lead' })

    // 150 cells → create + hide + 150 source cells + reveal = 153 events,
    // spanning multiple PLAN_IMPORT_CHUNK (100) posts on commit.
    const cells = Array.from({ length: 150 }, (_, i) => ({ content: `c${i}` }))
    const prepRes = (await handleExternalChangesetsRequest(
      prepareReq(token, { kind: 'PlanImport', fileName: 'Big.usfm', fileType: 'usfm', cells }),
      env,
    ))!
    const prep = (await prepRes.json()) as { changeset: { id: string } }
    const csId = prep.changeset.id

    // Read the prepare-time id ledger — the crash simulation replays a slice of
    // it, and the retry must converge on exactly these ids.
    const storedRow = (await tdb.rows<{ id: string; summary: unknown }>('changesets')).find(
      (c) => c.id === csId,
    )!
    const summary =
      typeof storedRow.summary === 'string' ? JSON.parse(storedRow.summary) : storedRow.summary
    const planned = summary.plannedIds.planImport as {
      fileId: string
      fileEventId: string
      hideEventId: string
      cells: { cellId: string; eventId: string }[]
    }

    // Simulate a partial apply (worker evicted mid-commit): apply file.create +
    // the first 80 source cells using the EXACT stored ids, through the same
    // /events perimeter commit uses, chained by anchorCellId. Then leave the
    // changeset in the transient 'committing' state.
    const leadTok = await makeTestToken(SECRET, {
      projectId: PROJECT,
      fileId: planned.fileId,
      userId: 1,
      username: 'lead',
      role: 500,
    })
    const fileEvent: RawEvent<'file.create'> = {
      id: planned.fileEventId,
      schemaVersion: 1,
      kind: 'file.create',
      projectId: PROJECT,
      fileId: planned.fileId,
      parentId: null,
      author: 'lead',
      payload: { name: 'Big.usfm', fileType: 'usfm' },
      clientTs: 1,
    }
    const hideEvent: RawEvent<'file.delete'> = {
      id: planned.hideEventId,
      schemaVersion: 1,
      kind: 'file.delete',
      projectId: PROJECT,
      fileId: planned.fileId,
      parentId: null,
      author: 'lead',
      payload: {},
      clientTs: 1,
    }
    const partialCells: RawEvent<'source.cell.create'>[] = []
    let prev: string | null = null
    for (let i = 0; i < 80; i++) {
      const pc = planned.cells[i]
      partialCells.push({
        id: pc.eventId,
        schemaVersion: 1,
        kind: 'source.cell.create',
        projectId: PROJECT,
        fileId: planned.fileId,
        cellId: pc.cellId,
        parentId: null,
        author: 'lead',
        payload: { cellId: pc.cellId, anchorCellId: prev, value: `c${i}` },
        clientTs: 1,
      })
      prev = pc.cellId
    }
    const partial: RawEvent[] = [fileEvent, hideEvent, ...partialCells]
    const partialRes = await handleEventsWriteRequest(
      new Request('https://w/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${leadTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: partial }),
      }),
      env,
    )
    const partialBody = (await partialRes!.json()) as { accepted: unknown[] }
    expect(partialBody.accepted).toHaveLength(82) // file + hide + 80 cells landed

    const hiddenFile = await tdb.db
      .prepare(`SELECT deleted_at FROM files WHERE id = ? AND project_id = ?`)
      .bind(planned.fileId, PROJECT)
      .first<{ deleted_at: number | null }>()
    expect(hiddenFile?.deleted_at).not.toBeNull()

    await tdb.db
      .prepare(`UPDATE changesets SET status = 'committing' WHERE id = ?`)
      .bind(csId)
      .run()

    // Retry the commit: re-posts create + hide + all cells; the 82 already
    // applied dedupe by id, the remaining cells apply, then reveal publishes.
    const res = (await handleExternalChangesetsRequest(commitReq(token, csId), env))!
    expect(res.status).toBe(200)
    const commit = (await res.json()) as { receipt: { appliedCount: number; fileId: string } }
    expect(commit.receipt.fileId).toBe(planned.fileId) // stored id, not a fresh mint
    expect(commit.receipt.appliedCount).toBe(153)

    // Exactly one file — NOT a duplicate from a re-minted file id (the old bug).
    const files = await tdb.rows<{ id: string; deleted_at: number | null }>('files')
    expect(files).toHaveLength(1)
    expect(files[0].id).toBe(planned.fileId)
    expect(files[0].deleted_at).toBeNull()

    // All 150 source cells, no duplicates.
    const sourceCells = (await tdb.rows<{ side: string; file_id: string }>('cells')).filter(
      (c) => c.side === 'source' && c.file_id === planned.fileId,
    )
    expect(sourceCells).toHaveLength(150)

    // Create + 150 source cells remain unique; hide/reveal are also unique.
    const createEvents = (await tdb.rows<{ kind: string }>('events')).filter(
      (e) => e.kind === 'file.create' || e.kind === 'source.cell.create',
    )
    expect(createEvents).toHaveLength(151)
    expect(await tdb.rows('events')).toHaveLength(153)

    // Single changeset row, converged to committed.
    const cs = await tdb.rows<{ status: string }>('changesets')
    expect(cs).toHaveLength(1)
    expect(cs[0].status).toBe('committed')
  })
})
