// Signed upload URLs (create_upload_url → PUT /api/v1/external/uploads/:ticket).
//
// Why these tests exist: an agent with a 40 MB source file could not get it
// into Aquilla over MCP, because upload_artifact carries bytes inline and caps
// them at 512 KiB. The URL is a bearer capability, so most of these pin that it
// grants no more than the credential that minted it, for no longer:
//   - a file bigger than the inline cap lands byte-for-byte, attributed to the
//     minting credential, under the name/kind the ticket fixed
//   - a URL works once, for its whole life (no limiter window boundary
//     resets it) and also when the spent-marker table is missing
//   - revoking the credential or losing the project role kills the URL
//   - a tampered ticket, or a sync JWT signed with the raw SYNC_SECRET_KEY,
//     is not accepted (the ticket key is derived, so tokens cannot cross)
//   - a credential that may not upload cannot mint one
//   - a stored file too big to parse in a 128 MB isolate is refused before
//     the parser reads it (storing allows 64 MiB, parsing keeps 25 MB)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mcp-route → commit.ts → events/route.ts → broadcast.ts → partyserver (cloudflare:*).
vi.mock('partyserver', () => ({ getServerByName: vi.fn() }))
import { sign } from 'hono/jwt'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { handleUploadTicketRequest } from '../external/upload-tickets'
import { MCP_ARTIFACT_MAX_BYTES } from '../external/mcp-artifact-upload'
import { parseArtifactToCells, MAX_PARSE_BYTES } from '../external/import-parse-core'
import type { ExternalEnv } from '../external/types'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { AquillaDb } from '../../../db/shim/postgres'

const PROJECT = 'proj-a'
const CRED = '00000000-0000-0000-0000-0000000000c1'
const MCP_RESOURCE = 'https://w/api/v1/external/mcp'
const SECRET = 'test-secret'

function makeBucket() {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>()
  return {
    store,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body: new Uint8Array(value), contentType: opts?.httpMetadata?.contentType })
    },
    async get(key: string) {
      const obj = store.get(key)
      return obj ? { arrayBuffer: async () => obj.body.buffer } : null
    },
    async delete(key: string) { store.delete(key) },
  }
}

let tdb: TestDb
let bucket: ReturnType<typeof makeBucket>
let env: { AQUILLA_PG: AquillaDb; SYNC_SECRET_KEY: string; BASE_URL: string; SNAPSHOTS: R2Bucket; R2_KEY_PREFIX: string }
let token: string

beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'P', created_by: 99, org_id: null }],
    project_members: [
      { project_id: PROJECT, user_id: 1, role_level: 400 }, // contributor
      { project_id: PROJECT, user_id: 2, role_level: 100 }, // viewer
    ],
  })
  bucket = makeBucket()
  env = {
    AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app',
    SNAPSHOTS: bucket as unknown as R2Bucket, R2_KEY_PREFIX: '',
  }
  token = await credToken(1, 'alice', CRED)
})
afterEach(async () => { await tdb?.close() })

async function credToken(userId: number, username: string, credentialId: string): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h') ON CONFLICT (id) DO NOTHING`,
    [userId, username, `${username}@x.com`],
  )
  const minted = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, oauth_resource)
     VALUES ($1, $2, 'mcp', $3, $4, 'act', NULL, $5, $6)`,
    [credentialId, String(userId), minted.tokenPrefix, minted.tokenHash, PROJECT, MCP_RESOURCE],
  )
  return minted.token
}

async function callMcp(bearer: string, name: string, args: Record<string, unknown>) {
  const response = await handleExternalMcpRequest(new Request(MCP_RESOURCE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env)
  const body = await response!.json() as { result: { content: { text: string }[]; isError?: boolean } }
  return { isError: body.result.isError === true, payload: JSON.parse(body.result.content[0].text) }
}

async function mintUrl(bearer = token, args: Record<string, unknown> = {}): Promise<string> {
  const { isError, payload } = await callMcp(bearer, 'create_upload_url', {
    projectId: PROJECT, name: 'lexicon.xml', kind: 'source', contentType: 'application/xml', ...args,
  })
  expect(isError, JSON.stringify(payload)).toBe(false)
  return payload.uploadUrl as string
}

function put(url: string, body: Uint8Array): Promise<Response | null> {
  return handleUploadTicketRequest(new Request(url, { method: 'PUT', body }), env)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

describe('create_upload_url', () => {
  it('stores a file larger than the inline MCP cap, byte-for-byte, as the minting credential', async () => {
    const bytes = new Uint8Array(MCP_ARTIFACT_MAX_BYTES * 4 + 7).map((_, i) => (i * 31) % 251)
    const url = await mintUrl()
    expect(url.startsWith('https://w/api/v1/external/uploads/')).toBe(true)

    const res = (await put(url, bytes))!
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.json() as { artifactId: string; sha256: string; sizeBytes: number; kind: string }
    expect(body.sizeBytes).toBe(bytes.byteLength)
    expect(body.sha256).toBe(await sha256Hex(bytes))
    expect(body.kind).toBe('source')

    const rows = await tdb.rows<{ id: string; name: string; content_type: string; credential_id: string; uploaded_by_user_id: string; r2_key: string }>('artifacts')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: body.artifactId, name: 'lexicon.xml', content_type: 'application/xml', credential_id: CRED, uploaded_by_user_id: '1' })
    expect(bucket.store.get(rows[0].r2_key)!.body).toEqual(bytes)
  })

  it('takes name and type from the ticket, not from headers on the PUT', async () => {
    const url = await mintUrl()
    const res = (await handleUploadTicketRequest(new Request(url, {
      method: 'PUT', body: new Uint8Array([1, 2, 3]),
      headers: { 'x-artifact-name': 'other.exe', 'content-type': 'audio/wav', 'x-artifact-kind': 'audio' },
    }), env))!
    expect(res.status).toBe(200)
    const [row] = await tdb.rows<{ name: string; kind: string; content_type: string }>('artifacts')
    expect(row).toMatchObject({ name: 'lexicon.xml', kind: 'source', content_type: 'application/xml' })
  })

  it('works once', async () => {
    const url = await mintUrl()
    expect((await put(url, new Uint8Array([1])))!.status).toBe(200)
    const again = (await put(url, new Uint8Array([2])))!
    expect(again.status).toBe(409)
    expect(await tdb.rows('artifacts')).toHaveLength(1)
  })

  it('stays spent for the ticket\'s whole life, not until a window boundary', async () => {
    const url = await mintUrl()
    const claims = JSON.parse(atob(url.split('/uploads/')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    expect((await put(url, new Uint8Array([1])))!.status).toBe(200)
    // The marker is keyed on the ticket's own exp. An epoch-aligned limiter
    // window would let a ticket spent at 23:59 UTC be replayed at 00:01.
    const { rows } = await tdb.pg.query<{ until: number }>(
      `SELECT extract(epoch FROM window_start)::int AS until FROM rate_limit_counters
       WHERE kind = 'artifact_upload_ticket' AND identifier = $1`, [claims.jti])
    expect(rows).toEqual([{ until: claims.exp }])
  })

  it('refuses when the spent marker cannot be written, even if the table is missing', async () => {
    const url = await mintUrl()
    await tdb.pg.query('DROP TABLE rate_limit_counters')
    const res = (await put(url, new Uint8Array([1])))!
    expect(res.status).toBe(409)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('dies with the credential: revoked after minting → refused', async () => {
    const url = await mintUrl()
    await tdb.pg.query('UPDATE api_credentials SET revoked_at = now() WHERE id = $1', [CRED])
    const res = (await put(url, new Uint8Array([1])))!
    expect(res.status).toBe(403)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('re-checks the live role: demoted to viewer after minting → refused', async () => {
    const url = await mintUrl()
    await tdb.pg.query('UPDATE project_members SET role_level = 100 WHERE user_id = 1')
    const res = (await put(url, new Uint8Array([1])))!
    expect(res.status).toBe(403)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('refuses a tampered ticket and a sync JWT signed with the raw secret', async () => {
    const url = await mintUrl()
    const [head, payload, sig] = url.split('/uploads/')[1].split('.')
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    const forgedPayload = btoa(JSON.stringify({ ...claims, projectId: 'proj-b' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    expect((await put(`https://w/api/v1/external/uploads/${head}.${forgedPayload}.${sig}`, new Uint8Array([1])))!.status).toBe(403)

    // Same claims, signed with SYNC_SECRET_KEY itself (what every other
    // verifier in this worker uses) instead of the derived ticket key.
    const rawSigned = await sign(claims, SECRET, 'HS256')
    expect((await put(`https://w/api/v1/external/uploads/${rawSigned}`, new Uint8Array([1])))!.status).toBe(403)
    const syncJwt = await makeTestToken(SECRET, { projectId: PROJECT })
    expect((await put(`https://w/api/v1/external/uploads/${syncJwt}`, new Uint8Array([1])))!.status).toBe(403)
    expect(await tdb.rows('artifacts')).toHaveLength(0)
  })

  it('will not mint for a credential that may not upload', async () => {
    const viewer = await credToken(2, 'vera', '00000000-0000-0000-0000-0000000000c2')
    const { isError, payload } = await callMcp(viewer, 'create_upload_url', {
      projectId: PROJECT, name: 'x.xml', kind: 'source', contentType: 'application/xml',
    })
    expect(isError).toBe(true)
    expect(JSON.stringify(payload)).toMatch(/permission_denied/)
  })

  it('stores a file too big to parse, but the parser refuses it before reading', async () => {
    const res = (await put(await mintUrl(), new Uint8Array([1, 2, 3])))!
    const { artifactId } = await res.json() as { artifactId: string }
    await tdb.pg.query('UPDATE artifacts SET size_bytes = $1', [MAX_PARSE_BYTES + 1])
    const get = vi.spyOn(bucket, 'get')
    const parsed = await parseArtifactToCells(env as unknown as ExternalEnv, PROJECT, artifactId)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(await parsed.response.text()).toMatch(/too large to parse/)
    expect(get).not.toHaveBeenCalled()
  })
})
