import { describe, expect, it } from 'vitest'

import { handleBulkMorphImportRequest } from '../events/import-morph-route'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'
import { MAX_IMPORT_REQUEST_BODY_BYTES } from '../../../shared/import-contract'

const SECRET = 'morph-secret'
const PROJECT_ID = 'project-morph'
const FILE_ID = 'file-morph'

async function leadToken(): Promise<string> {
  return makeTestToken(SECRET, { projectId: PROJECT_ID, fileId: FILE_ID, role: 500 })
}

function env(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

// AQU-1882 — the sibling of AQU-1858's gate on POST /import. The route used to
// `await request.json()` before it looked at the token, so an unauthenticated
// caller could spend the isolate's shared ~128 MB on a body that was always
// going to be refused. These tests assert the refusal happens without the body
// stream ever being pulled.
describe('POST /import-morph — gated before the body is read (AQU-1882)', () => {
  /** A body stream that records whether anything was ever pulled from it. */
  function unreadableBody(): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }))
    return { body, pulled: () => pulled }
  }

  function streamingRequest(
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>,
  ): Request {
    return new Request('https://worker/import-morph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      // Node/workerd both require this for a streamed request body.
      duplex: 'half',
    } as RequestInit)
  }

  it('rejects a missing token with 401 without touching the body', async () => {
    const { db } = await makeTestDb()
    const { body, pulled } = unreadableBody()

    const res = await handleBulkMorphImportRequest(streamingRequest(body, {}), env(db))

    expect(res?.status).toBe(401)
    expect(pulled()).toBe(false)
  })

  it('rejects a too-low role with 403 without touching the body', async () => {
    const { db } = await makeTestDb()
    const contributor = await makeTestToken(SECRET, {
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      role: 400, // contributor — below PROJECT_LEAD
    })
    const { body, pulled } = unreadableBody()

    const res = await handleBulkMorphImportRequest(
      streamingRequest(body, { Authorization: `Bearer ${contributor}` }),
      env(db),
    )

    expect(res?.status).toBe(403)
    expect(pulled()).toBe(false)
  })

  it('rejects an oversize Content-Length with 413 without touching the body', async () => {
    const { db } = await makeTestDb()
    const token = await leadToken()
    const { body, pulled } = unreadableBody()

    const res = await handleBulkMorphImportRequest(
      streamingRequest(body, {
        Authorization: `Bearer ${token}`,
        'content-length': String(MAX_IMPORT_REQUEST_BODY_BYTES + 1),
      }),
      env(db),
    )

    expect(res?.status).toBe(413)
    expect(await res?.json()).toMatchObject({ maxBytes: MAX_IMPORT_REQUEST_BODY_BYTES })
    expect(pulled()).toBe(false)
  })

  it('reads a chunked body with no Content-Length under the same byte cap', async () => {
    const { db } = await makeTestDb()
    const token = await leadToken()
    // One chunk over the ceiling, streamed with no declared length: the header
    // check cannot catch it, so the streaming counter has to.
    const oversize = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_IMPORT_REQUEST_BODY_BYTES + 1))
        controller.close()
      },
    })

    const res = await handleBulkMorphImportRequest(
      streamingRequest(oversize, { Authorization: `Bearer ${token}` }),
      env(db),
    )

    expect(res?.status).toBe(413)
    expect(await res?.json()).toMatchObject({ maxBytes: MAX_IMPORT_REQUEST_BODY_BYTES })
  })

  it('rejects a token scoped to another file with 403, once the body names it', async () => {
    const { db } = await makeTestDb()
    const otherFile = await makeTestToken(SECRET, {
      projectId: PROJECT_ID,
      fileId: 'some-other-file',
      role: 500,
    })

    const res = await handleBulkMorphImportRequest(
      new Request('https://worker/import-morph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherFile}` },
        body: JSON.stringify({ projectId: PROJECT_ID, fileId: FILE_ID, rows: [] }),
      }),
      env(db),
    )

    expect(res?.status).toBe(403)
    expect(await res?.text()).toBe('token scoped to different file')
  })

  it('still upserts a normal morph import at a legitimate size', async () => {
    const { db, rows } = await makeTestDb()
    const token = await leadToken()

    const post = async (surface: string) => handleBulkMorphImportRequest(
      new Request('https://worker/import-morph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          rows: [
            { cell_id: 'cell-1', word_seq: 0, surface, lemma: 'בְּרֵאשִׁית', strongs_h: 'H7225' },
            { cell_id: 'cell-1', word_seq: 1, surface: 'בָּרָא' },
            { surface: 'not a row' },
          ],
        }),
      }),
      env(db),
    )

    const first = await post('בְּרֵאשִׁית')
    expect(first?.status).toBe(200)
    expect(await first?.json()).toEqual({ accepted: 2, rejected: 1 })

    // Idempotent: the same (project, file, cell, word_seq) upserts in place.
    const second = await post('corrected surface')
    expect(second?.status).toBe(200)

    const morph = await rows<{ cell_id: string; word_seq: number; surface: string }>('cell_word_morph')
    expect(morph).toHaveLength(2)
    expect(morph.find((row) => row.word_seq === 0)?.surface).toBe('corrected surface')
  })
})
