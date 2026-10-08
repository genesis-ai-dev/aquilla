// Agent API knowledge-base upload / list (AQU-1762) — the sync-worker half.
//
// The bytes are bridged to auth-worker, so what this file proves is the gate and
// the seam, not the extraction: the credential's role floor and access ceiling,
// the local validation that stops a 25 MB body from crossing the seam just to be
// refused for its filename, the acting-user and doc-name headers the far side
// relies on, and that an upstream refusal reaches the agent with its own message
// intact rather than as a generic failure. Plus a drift guard keeping the
// discovery map's endpoint list honest.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// knowledge-route → artifacts-route (the shared credential gate) → import-parse
// → commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalKnowledgeRequest } from '../external/knowledge-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { MAX_KB_ORIGINAL_BYTES } from '../../../db/shared/knowledge'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const PROJECT = 'proj-kb'
const CRED_LEAD = '00000000-0000-0000-0000-0000000000c1'
const CRED_CONTRIB = '00000000-0000-0000-0000-0000000000c2'
const CRED_VIEWER = '00000000-0000-0000-0000-0000000000c3'
const CRED_READONLY = '00000000-0000-0000-0000-0000000000c4'
const SECRET = 'test-secret'
const AUTH_URL = 'https://identity.test'

let tdb: TestDb
let fetchMock: ReturnType<typeof vi.fn>

function makeEnv() {
  return {
    AQUILLA_PG: tdb.db,
    SYNC_SECRET_KEY: SECRET,
    AUTH_WORKER_URL: AUTH_URL,
    BASE_URL: 'https://aquilla.app',
  }
}

async function credToken(spec: {
  credentialId: string
  userId: number
  username: string
  access?: 'read' | 'write'
}): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')
     ON CONFLICT (id) DO NOTHING`,
    [spec.userId, spec.username, `${spec.username}@x.com`],
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, access, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, NULL, $6)`,
    [spec.credentialId, String(spec.userId), tokenPrefix, tokenHash, spec.access ?? 'write', PROJECT],
  )
  return token
}

function uploadReq(token: string, docName: string | null, body: BodyInit): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (docName !== null) headers['x-doc-name'] = docName
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/knowledge`, {
    method: 'POST',
    headers,
    body,
  })
}

function listReq(token: string): Request {
  return new Request(`https://w/api/v1/external/projects/${PROJECT}/knowledge`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** Stand in for auth-worker. Default: the happy 201 its real route returns. */
function stubAuthWorker(
  responder: (req: Request) => Response | Promise<Response> = () =>
    Response.json({ doc: { id: 'doc-1', name: 'guide.md' } }, { status: 201 }),
): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    return responder(req)
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 500 }, // lead
      { project_id: PROJECT, user_id: 2, role_level: 400 }, // contributor
      { project_id: PROJECT, user_id: 3, role_level: 100 }, // viewer
    ],
  })
  stubAuthWorker()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/v1/external/projects/:projectId/knowledge', () => {
  it('uploads at the in-app PROJECT_LEAD floor and passes the receipt through', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new TextEncoder().encode('# Style guide\n')),
      makeEnv(),
    ))!

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ doc: { id: 'doc-1', name: 'guide.md' } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = fetchMock.mock.calls[0]
    const url = String(sent[0])
    const init = sent[1] as RequestInit & { headers: Record<string, string> }
    expect(url).toBe(`${AUTH_URL}/api/v2/internal/projects/${PROJECT}/knowledge`)
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    // The far side resolves the role from this id, so it must be the credential
    // owner — never the credential id and never a client-supplied value.
    expect(init.headers['x-acting-user-id']).toBe('1')
    expect(init.headers['x-doc-name']).toBe('guide.md')
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('# Style guide\n')
  })

  // Headers are ByteString-only, so a non-ASCII name — the common case for this
  // feature — can only arrive percent-encoded. It must round-trip intact.
  it('round-trips a percent-encoded non-ASCII document name', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const name = 'فان دايك.txt'
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, encodeURIComponent(name), new TextEncoder().encode('في البدء')),
      makeEnv(),
    ))!
    expect(res.status).toBe(201)
    const header = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['x-doc-name']
    expect(decodeURIComponent(header)).toBe(name)
  })

  it('accepts a plain ASCII name that was not encoded', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'van-dyck-nt.txt', new TextEncoder().encode('In the beginning')),
      makeEnv(),
    ))!
    expect(res.status).toBe(201)
    const header = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['x-doc-name']
    expect(decodeURIComponent(header)).toBe('van-dyck-nt.txt')
  })

  it('refuses an encoded name whose real extension is unsupported', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, encodeURIComponent('كتاب.usfm'), new TextEncoder().encode('\\id GEN')),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a contributor — the floor is the in-app upload floor', async () => {
    const token = await credToken({ credentialId: CRED_CONTRIB, userId: 2, username: 'contrib' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new TextEncoder().encode('x')),
      makeEnv(),
    ))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('permission_denied')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a read-only credential (AQU-1242) before any bytes cross the seam', async () => {
    const token = await credToken({
      credentialId: CRED_READONLY,
      userId: 1,
      username: 'lead-ro',
      access: 'read',
    })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new TextEncoder().encode('x')),
      makeEnv(),
    ))!
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('scope_denied')
    // The refusal names THIS operation, not the artifact upload it shares a gate with.
    expect(body.error.message).toContain('knowledge-base document')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires x-doc-name', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, null, new TextEncoder().encode('x')),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('x-doc-name')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an unsupported extension locally and names the allowlist', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'bible.usfm', new TextEncoder().encode('\\id GEN')),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; details: { supported: string[] } }
    }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.details.supported).toContain('.txt')
    // The point of validating here: nothing was proxied.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an empty body', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new Uint8Array(0)),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an oversize declared length without reading the body', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const req = new Request(`https://w/api/v1/external/projects/${PROJECT}/knowledge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-doc-name': 'big.txt',
        'content-length': String(MAX_KB_ORIGINAL_BYTES + 1),
      },
      body: new TextEncoder().encode('x'),
    })
    const res = (await handleExternalKnowledgeRequest(req, makeEnv()))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { message: string; details: { maxBytes: number } }
    }
    expect(body.error.details.maxBytes).toBe(MAX_KB_ORIGINAL_BYTES)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("carries an upstream extraction refusal through with its own message (AQU-1499)", async () => {
    stubAuthWorker(() =>
      Response.json(
        {
          error: {
            code: 'validation_failed',
            message: 'could not extract text: this .docx has a bloated run table',
          },
        },
        { status: 422 },
      ),
    )
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'brief.docx', new TextEncoder().encode('PK\u0003\u0004')),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.message).toContain('bloated run table')
  })

  it('names an auth-worker that is behind sync-worker rather than reporting a flat failure', async () => {
    stubAuthWorker(() => new Response('not found', { status: 404 }))
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new TextEncoder().encode('x')),
      makeEnv(),
    ))!
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('job_failed')
    expect(body.error.message).toContain('auth-worker is behind sync-worker')
  })

  it('reports a missing backend as job_failed, not as the caller’s fault', async () => {
    const token = await credToken({ credentialId: CRED_LEAD, userId: 1, username: 'lead' })
    const env = { ...makeEnv(), AUTH_WORKER_URL: undefined }
    const res = (await handleExternalKnowledgeRequest(
      uploadReq(token, 'guide.md', new TextEncoder().encode('x')),
      env,
    ))!
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('job_failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/external/projects/:projectId/knowledge', () => {
  it('lists at the VIEWER floor, including the index status an agent verifies with', async () => {
    stubAuthWorker(() =>
      Response.json({
        docs: [
          { id: 'doc-1', name: 'van-dyck-nt.txt', sizeBytes: 1_900_000, indexStatus: 'ready', nodeCount: 42 },
        ],
      }),
    )
    const token = await credToken({ credentialId: CRED_VIEWER, userId: 3, username: 'viewer' })
    const res = (await handleExternalKnowledgeRequest(listReq(token), makeEnv()))!

    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: { indexStatus: string; nodeCount: number }[] }
    expect(body.docs[0].indexStatus).toBe('ready')
    expect(body.docs[0].nodeCount).toBe(42)

    const init = fetchMock.mock.calls[0][1] as { method?: string; headers: Record<string, string> }
    expect(init.method).toBe('GET')
    expect(init.headers['x-acting-user-id']).toBe('3')
  })

  it('lets a read-only credential list — the ceiling only blocks writes', async () => {
    stubAuthWorker(() => Response.json({ docs: [] }))
    const token = await credToken({
      credentialId: CRED_READONLY,
      userId: 3,
      username: 'viewer-ro',
      access: 'read',
    })
    const res = (await handleExternalKnowledgeRequest(listReq(token), makeEnv()))!
    expect(res.status).toBe(200)
  })

  it('refuses an unknown credential', async () => {
    const res = (await handleExternalKnowledgeRequest(listReq('aqk_nope'), makeEnv()))!
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects other methods', async () => {
    const res = (await handleExternalKnowledgeRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/knowledge`, { method: 'DELETE' }),
      makeEnv(),
    ))!
    expect(res.status).toBe(400)
  })

  it('claims only the collection path', async () => {
    const res = await handleExternalKnowledgeRequest(
      new Request(`https://w/api/v1/external/projects/${PROJECT}/knowledge/doc-1`, { method: 'GET' }),
      makeEnv(),
    )
    expect(res).toBeNull()
  })
})

describe('discovery map', () => {
  it('publishes both knowledge endpoints so an agent can find them', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))!
    const map = (await res.json()) as { endpoints: Record<string, string> }
    expect(
      Object.keys(map.endpoints),
    ).toEqual(
      expect.arrayContaining([
        'POST /api/v1/external/projects/:projectId/knowledge',
        'GET /api/v1/external/projects/:projectId/knowledge',
      ]),
    )
  })
})
