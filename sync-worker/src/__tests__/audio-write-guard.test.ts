// AQU-2682: audio storage refuses to replace or remove a take's recording it
// shouldn't. A stored recording is written once: a second write with other
// bytes under the same name is refused (the same bytes again are a retry and
// succeed), a large upload may not start over an existing one, and removing
// a recording that a live take plays is for whoever recorded it or a
// Maintainer, within the files and languages their access covers.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { handleAudioRequest } from '../audio'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'audio-write-guard-secret'
const P = 'proj-guard'
const F = 'file-guard'
const CUES = 'file-guard-cues'
const OTHER = 'file-guard-other'
const ES = 'aa11bb22'
const KEY = (file: string, name: string) => `projects/${P}/files/${file}/audio/${name}`

let h: TestDb
beforeEach(async () => {
  if (!h) h = await makeTestDb()
  else await h.reset()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('cc33dd44', '${P}', 'target', 'Arabic', 'ar', ''),
    ('${ES}', '${P}', 'target', 'Spanish', 'es', 'es')`)
})
afterAll(async () => { await h?.close() })

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex')

/** A stand-in R2: single-part etags are the bytes' MD5, as R2's are. */
function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>()
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>()
  let u = 0
  const toBytes = async (body: unknown) =>
    typeof body === 'string' ? new TextEncoder().encode(body)
      : body instanceof ArrayBuffer ? new Uint8Array(body)
      : new Uint8Array(await new Response(body as BodyInit).arrayBuffer())
  const r2 = {
    async head(k: string) {
      const o = objects.get(k)
      return o ? { key: k, size: o.bytes.byteLength, etag: md5(o.bytes), httpEtag: `"${md5(o.bytes)}"`, customMetadata: o.meta ?? {} } : null
    },
    async get(k: string) {
      const o = objects.get(k)
      return o ? { size: o.bytes.byteLength, body: new Response(o.bytes).body, httpMetadata: {}, etag: md5(o.bytes) } : null
    },
    async put(k: string, body: unknown, opts?: { customMetadata?: Record<string, string> }) {
      objects.set(k, { bytes: await toBytes(body), meta: opts?.customMetadata })
      return { key: k }
    },
    async delete(k: string) { objects.delete(k) },
    async createMultipartUpload(key: string) { const id = `up-${++u}`; uploads.set(id, { key, parts: new Map() }); return { uploadId: id, key } },
    resumeMultipartUpload(key: string, id: string) {
      return {
        async uploadPart(n: number, body: ArrayBuffer) { uploads.get(id)!.parts.set(n, new Uint8Array(body)); return { partNumber: n, etag: `e${n}` } },
        async complete(parts: Array<{ partNumber: number }>) {
          const up = uploads.get(id)!
          const all = parts.map((p) => up.parts.get(p.partNumber)!)
          const out = new Uint8Array(all.reduce((s, a) => s + a.byteLength, 0)); let o = 0
          for (const a of all) { out.set(a, o); o += a.byteLength }
          objects.set(key, { bytes: out }); return { key, size: out.byteLength, httpMetadata: {} }
        },
        async abort() { uploads.delete(id) },
      }
    },
  }
  return { r2: r2 as unknown as R2Bucket, objects }
}
const text = (o?: { bytes: Uint8Array }) => (o ? new TextDecoder().decode(o.bytes) : undefined)

interface Who { username: string; userId: number; role: number; scopes?: unknown; laneGrants?: unknown }
const OWNER: Who = { username: 'owner', userId: 1, role: 700 }
const RITA: Who = { username: 'rita', userId: 2, role: 400 }
const RAVI: Who = { username: 'ravi', userId: 3, role: 500 }
const MAX: Who = { username: 'max', userId: 4, role: 600 }
const MALLORY: Who = { username: 'mallory', userId: 9, role: 400 }

async function post(events: RawEvent[], who: Who, fileId = F) {
  const tok = await makeTestToken(SECRET, { projectId: P, fileId, ...who } as never)
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ events }) }),
    { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET },
  )
  return (await res!.json()) as { rejected: unknown[] }
}
let n = 0
const ev = (kind: string, fileId: string, cellId: string | undefined, author: string, payload: Record<string, unknown>) => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`, schemaVersion: 1, kind, projectId: P, fileId, cellId, parentId: null, author, payload, clientTs: n,
}) as unknown as RawEvent

let b = bucket()
async function audio(who: Who, method: string, name: string, opts: { fileId?: string; query?: string; body?: BodyInit } = {}) {
  const fileId = opts.fileId ?? F
  const tok = await makeTestToken(SECRET, { projectId: P, fileId, ...who } as never)
  return (await handleAudioRequest(new Request(`https://worker/audio/${P}/${fileId}/${name}${opts.query ?? ''}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'audio/webm' }, ...(opts.body !== undefined ? { body: opts.body } : {}),
  }), { SNAPSHOTS: b.r2, SYNC_SECRET_KEY: SECRET, AQUILLA_PG: h.db } as never))!
}

/** Rita's take, approved by Ravi, its bytes in storage. Optionally in Spanish. */
async function approvedTake(opts: { lane?: string } = {}) {
  b = bucket()
  expect((await post([ev('file.create', F, undefined, 'owner', { name: 'Sermon', fileType: 'codex' })], OWNER)).rejected).toEqual([])
  expect((await post([ev('file.create', CUES, undefined, 'owner', { name: 'Sermon · audio cues', fileType: 'vtt', role: 'audio-cues', anchorFileId: F })], OWNER, CUES)).rejected).toEqual([])
  b.objects.set(KEY(F, 'take-rita.webm'), { bytes: new TextEncoder().encode('RITA-ORIGINAL') })
  const lane = opts.lane ? { targetLang: opts.lane } : {}
  expect((await post([ev('cell.audio.attach', F, 'c1', 'rita', { audioId: 'take-rita.webm', url: 'frontier-audio://take-rita.webm', slot: 'recording', ...lane })], RITA)).rejected).toEqual([])
  expect((await post([ev('cell.audio.validate', F, 'c1', 'ravi', { audioId: 'take-rita.webm', ...lane })], RAVI)).rejected).toEqual([])
}

describe('AQU-2682: a stored recording is written once', () => {
  it('other bytes over a take\'s recording are refused; the recording is unchanged', async () => {
    await approvedTake()
    const res = await audio(MALLORY, 'PUT', 'take-rita.webm', { body: 'MALLORY-AUDIO' })
    expect(res.status).toBe(409)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('the same bytes again are a retry: 200, nothing changed', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'take-rita.webm', { body: 'RITA-ORIGINAL' })).status).toBe(200)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('a new recording under a new name is stored, and its own retry with other bytes is refused', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'take-2.webm', { body: 'TAKE-2' })).status).toBe(200)
    expect((await audio(RITA, 'PUT', 'take-2.webm', { body: 'TAKE-2' })).status).toBe(200)
    expect((await audio(RITA, 'PUT', 'take-2.webm', { body: 'TAKE-2-EDITED' })).status).toBe(409)
  })

  it('a peaks sidecar is derived and may be rewritten', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'take-rita.webm.peaks', { body: 'P1' })).status).toBe(200)
    expect((await audio(RITA, 'PUT', 'take-rita.webm.peaks', { body: 'P2' })).status).toBe(200)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm.peaks')))).toBe('P2')
  })

  it('a large upload may not start over an existing recording', async () => {
    await approvedTake()
    expect((await audio(MALLORY, 'POST', 'take-rita.webm', { query: '?multipart=create' })).status).toBe(409)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('a large upload whose name was taken meanwhile is refused at completion, and the recording kept', async () => {
    await approvedTake()
    const c = await audio(RITA, 'POST', 'big.webm', { query: '?multipart=create' })
    expect(c.status).toBe(200)
    const { uploadId } = await c.json() as { uploadId: string }
    expect((await audio(RITA, 'PUT', 'big.webm', { query: `?multipart=part&uploadId=${uploadId}&partNumber=1`, body: 'MP' })).status).toBe(200)
    b.objects.set(KEY(F, 'big.webm'), { bytes: new TextEncoder().encode('ALREADY-HERE') })
    const done = await audio(RITA, 'POST', 'big.webm', { query: `?multipart=complete&uploadId=${uploadId}`, body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'e1' }] }) })
    expect(done.status).toBe(409)
    expect(text(b.objects.get(KEY(F, 'big.webm')))).toBe('ALREADY-HERE')
  })

  it('a large upload of a fresh recording still works end to end', async () => {
    await approvedTake()
    const c = await audio(RITA, 'POST', 'big.webm', { query: '?multipart=create' })
    const { uploadId } = await c.json() as { uploadId: string }
    await audio(RITA, 'PUT', 'big.webm', { query: `?multipart=part&uploadId=${uploadId}&partNumber=1`, body: 'MP' })
    const done = await audio(RITA, 'POST', 'big.webm', { query: `?multipart=complete&uploadId=${uploadId}`, body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'e1' }] }) })
    expect(done.status).toBe(200)
    expect(text(b.objects.get(KEY(F, 'big.webm')))).toBe('MP')
  })
})

describe('AQU-2682: who may write and remove recordings', () => {
  it('a viewer is refused', async () => {
    await approvedTake()
    const viewer = { username: 'v', userId: 10, role: 300 }
    expect((await audio(viewer, 'PUT', 'new.webm', { body: 'X' })).status).toBe(403)
    expect((await audio(viewer, 'DELETE', 'new.webm')).status).toBe(403)
  })

  it('a contributor limited to another file is refused there, for writes and removals', async () => {
    await approvedTake()
    const scoped = { ...MALLORY, scopes: [{ kind: 'file', value: OTHER }] }
    expect((await audio(scoped, 'PUT', 'new.webm', { body: 'X' })).status).toBe(403)
    expect((await audio(scoped, 'POST', 'new.webm', { query: '?multipart=create' })).status).toBe(403)
    expect((await audio(scoped, 'DELETE', 'new.webm')).status).toBe(403)
  })

  it('a contributor limited to the file records on its heard lines too (the cue file belongs to it)', async () => {
    await approvedTake()
    const scoped = { ...RITA, scopes: [{ kind: 'file', value: F }] }
    expect((await audio(scoped, 'PUT', 'heard.webm', { fileId: CUES, body: 'H' })).status).toBe(200)
  })

  it('removing a recording no live take plays (an upload whose attach failed) is allowed', async () => {
    await approvedTake()
    b.objects.set(KEY(F, 'orphan.webm'), { bytes: new TextEncoder().encode('O') })
    expect((await audio(MALLORY, 'DELETE', 'orphan.webm')).status).toBe(200)
    expect(b.objects.has(KEY(F, 'orphan.webm'))).toBe(false)
  })

  it('removing another person\'s live take\'s recording is refused', async () => {
    await approvedTake()
    expect((await audio(MALLORY, 'DELETE', 'take-rita.webm')).status).toBe(403)
    expect(b.objects.has(KEY(F, 'take-rita.webm'))).toBe(true)
  })

  it('whoever recorded it, or a Maintainer, may remove it', async () => {
    await approvedTake()
    expect((await audio(RITA, 'DELETE', 'take-rita.webm')).status).toBe(200)
    await approvedTake()
    expect((await audio(MAX, 'DELETE', 'take-rita.webm')).status).toBe(200)
  })

  it('a contributor limited to one language may not remove a take\'s recording in another', async () => {
    await approvedTake({ lane: 'es' })
    const arabicOnly = { ...RITA, scopes: [{ kind: 'lane', value: 'cc33dd44' }] }
    expect((await audio(arabicOnly, 'DELETE', 'take-rita.webm')).status).toBe(403)
    const spanish = { ...RITA, scopes: [{ kind: 'lane', value: ES }] }
    expect((await audio(spanish, 'DELETE', 'take-rita.webm')).status).toBe(200)
  })
})
