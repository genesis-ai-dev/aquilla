// /api/v1/projects/:p/drive-links
//
// Why these tests: linking a folder hands the server a standing write path
// into the project's source text, so only a project lead may make one, a
// folder the service account cannot open must be refused with the email to
// share it with (the one fix a lead can make), and a saved link must start its
// poller — a link that never polls looks connected and silently does nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { handleDriveLinksRequest, type DriveLinksEnv } from '../drive/drive-links-route'
import { resetServiceAccountTokenCacheForTests } from '../drive/google-auth'

const SECRET = 'test-secret'
const PROJECT = 'p1'
const EMAIL = 'aquilla-sync@test.iam.gserviceaccount.com'
const FOLDER_URL = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing'

async function serviceAccountJson(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  return JSON.stringify({ client_email: EMAIL, private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n` })
}

function fakePoller() {
  const started: string[] = []
  const ns = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (url: string, init: RequestInit) => {
        if (new URL(url).pathname === '/start') started.push(JSON.parse(String(init.body)).linkId)
        return Response.json({ ok: true })
      },
    }),
  }
  return { ns: ns as unknown as DurableObjectNamespace, started }
}

async function setup() {
  const { db, rows } = await makeTestDb({
    users: [{ id: 1, username: 'lead', email: 'lead@x', password_hash: 'x' }],
    projects: [{ id: PROJECT, name: 'P', created_by: 1 }],
  })
  const poller = fakePoller()
  const env: DriveLinksEnv = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountJson(), DriveFolderPoller: poller.ns }
  const call = async (method: string, path: string, role: number, body?: unknown) => {
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: '', role, userId: 1, username: 'lead' })
    return handleDriveLinksRequest(
      new Request(`https://x/api/v1/projects/${PROJECT}/drive-links${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    )
  }
  return { db, rows, env, poller, call }
}

/** Google: the token endpoint, plus a folder lookup that answers `folderStatus`
 *  for a folder whose editors are `editors`. */
function stubGoogle(folderStatus: number, editors: string[] = ['lead@x']) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't', expires_in: 3600 })
    if (folderStatus !== 200) return new Response('File not found', { status: folderStatus })
    return Response.json({
      id: '1AbCdEfGhIjKlMnOp',
      name: 'Live chapters',
      mimeType: 'application/vnd.google-apps.folder',
      owners: [{ emailAddress: 'owner@x' }],
      permissions: editors.map((emailAddress) => ({ type: 'user', role: 'writer', emailAddress })),
    })
  })
}

describe('Drive links route', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetServiceAccountTokenCacheForTests()
  })

  it('refuses a link from anyone below project lead', async () => {
    const t = await setup()
    stubGoogle(200)
    const res = await t.call('POST', '', 400, { folder: FOLDER_URL })
    expect(res?.status).toBe(403)
    expect(await t.rows('drive_folder_links')).toEqual([])
  })

  it('refuses a folder the service account cannot open, naming the email to share it with', async () => {
    const t = await setup()
    stubGoogle(404)
    const res = await t.call('POST', '', 500, { folder: FOLDER_URL })
    expect(res?.status).toBe(422)
    expect(((await res!.json()) as { error: string }).error).toContain(EMAIL)
    expect(await t.rows('drive_folder_links')).toEqual([])
  })

  it("refuses a folder the lead does not own or edit in Drive, even though it is shared with the service account", async () => {
    // Every project shares one service account: a folder another team shared
    // with it must not be linkable by a lead who merely learned its id.
    const t = await setup()
    stubGoogle(200, ['someone-else@x'])
    const res = await t.call('POST', '', 500, { folder: FOLDER_URL })
    expect(res?.status).toBe(403)
    expect(await t.rows('drive_folder_links')).toEqual([])
    expect(t.poller.started).toEqual([])
  })

  it('saves a shared folder from its URL and starts its poller', async () => {
    const t = await setup()
    stubGoogle(200)
    const res = await t.call('POST', '', 500, { folder: FOLDER_URL })
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { id: string; folderName: string }
    expect(body.folderName).toBe('Live chapters')
    expect(t.poller.started).toEqual([body.id])

    const list = (await (await t.call('GET', '', 100))!.json()) as { serviceAccountEmail: string; links: Array<{ id: string; folderId: string; linkedBy: string }> }
    expect(list.serviceAccountEmail).toBe(EMAIL)
    expect(list.links).toEqual([expect.objectContaining({ id: body.id, folderId: '1AbCdEfGhIjKlMnOp', linkedBy: 'lead' })])

    // Linking the same folder again is the same link, not a second poller target.
    const again = await t.call('POST', '', 500, { folder: '1AbCdEfGhIjKlMnOp' })
    expect(again?.status).toBe(200)
    expect(await t.rows('drive_folder_links')).toHaveLength(1)

    const removed = await t.call('DELETE', `/${body.id}`, 500)
    expect(removed?.status).toBe(204)
    expect(await t.rows('drive_folder_links')).toEqual([])
  })
})
