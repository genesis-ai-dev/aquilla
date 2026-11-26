// AQU-2682, second round: the ways around "written once" are closed.
//   - Storage creates or removes only recordings no take, live or removed,
//     has ever named: no deleting a take's bytes to write new ones under it.
//   - A WAV beside an AI voice belongs to that voice's take: only its
//     recorder (or a Maintainer) writes it, once, within their languages.
//   - A `.peaks` sidecar must be a real one, and no take is a `.peaks`.
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

const SECRET = 'audio-write-guard-2-secret'
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
const vc = async (audioId: string) => (await h.pg.query(`SELECT validator_count, deleted, url FROM cell_audio WHERE audio_id = $1`, [audioId])).rows[0]

const peaks = () => new Uint8Array([0x41, 0x51, 0x50, 0x4b, 2, 0, 0, 0, 0, 0, 0, 0, 7, 7])
const voice = (who: Who, name: string, cell = 'c2', lane: Record<string, string> = {}) =>
  post([ev('cell.audio.attach', F, cell, who.username, { audioId: name, url: `frontier-audio://${name}`, slot: 'generatedVoice', ...lane })], who)

describe('one rule: storage never creates or removes a recording a take has named', () => {
  it('B1: the recorder can no longer delete their approved take\'s bytes and write others', async () => {
    await approvedTake()
    expect((await audio(RITA, 'DELETE', 'take-rita.webm')).status).toBe(403)
    expect((await audio(RITA, 'PUT', 'take-rita.webm', { body: 'RITA-SWAPPED' })).status).toBe(409)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('B9: a removed take\'s bytes are still its own: not deleted, not written over', async () => {
    await approvedTake()
    expect((await post([ev('cell.audio.remove', F, 'c1', 'rita', { audioId: 'take-rita.webm' })], RITA)).rejected).toEqual([])
    expect((await audio(MALLORY, 'DELETE', 'take-rita.webm')).status).toBe(403)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('B10: remove, delete, write, re-attach: every storage step is refused, the approved bytes stay', async () => {
    await approvedTake()
    expect((await post([ev('cell.audio.remove', F, 'c1', 'mallory', { audioId: 'take-rita.webm' })], MALLORY)).rejected).toEqual([])
    expect((await audio(MALLORY, 'DELETE', 'take-rita.webm')).status).toBe(403)
    expect((await audio(MALLORY, 'PUT', 'take-rita.webm', { body: 'MALLORY' })).status).toBe(409)
    expect(text(b.objects.get(KEY(F, 'take-rita.webm')))).toBe('RITA-ORIGINAL')
  })

  it('bytes the sweep took from a removed take can\'t be written again under its name', async () => {
    await approvedTake()
    await post([ev('cell.audio.remove', F, 'c1', 'rita', { audioId: 'take-rita.webm' })], RITA)
    b.objects.delete(KEY(F, 'take-rita.webm')) // the nightly sweep
    expect((await audio(MALLORY, 'PUT', 'take-rita.webm', { body: 'MALLORY' })).status).toBe(409)
  })

  it('a cut take\'s pieces name their recording too', async () => {
    await approvedTake()
    expect((await post([ev('cell.audio.attach', F, 'c4', 'rita', { audioId: 'long.webm', url: 'frontier-audio://long.webm', slot: 'recording', durationMs: 6_000 })], RITA)).rejected).toEqual([])
    expect((await post([ev('cell.audio.cut', F, 'c4', 'rita', { audioId: 'long.webm', atMs: 3_000, newAudioId: 'piece-2.webm' })], RITA)).rejected).toEqual([])
    expect((await h.pg.query(`SELECT piece_of FROM cell_audio WHERE audio_id = 'piece-2.webm'`)).rows).toEqual([{ piece_of: 'long.webm' }])
    expect((await audio(MALLORY, 'DELETE', 'piece-2.webm')).status).toBe(403)
  })

  it('the app\'s cleanup after a failed attach still works: bytes no take names are removable', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'never-attached.webm', { body: 'R' })).status).toBe(200)
    expect((await audio(RITA, 'DELETE', 'never-attached.webm')).status).toBe(200)
    expect(b.objects.has(KEY(F, 'never-attached.webm'))).toBe(false)
  })
})

describe('the WAV beside an AI voice belongs to that voice\'s take', () => {
  it('B2: another contributor can\'t write it', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'gen-rita.webm', { body: 'GEN' })).status).toBe(200)
    expect((await voice(RITA, 'gen-rita.webm')).rejected).toEqual([])
    expect((await audio(MALLORY, 'PUT', 'gen-rita.wav', { body: 'MALLORY-WAV' })).status).toBe(403)
    expect(b.objects.has(KEY(F, 'gen-rita.wav'))).toBe(false)
  })

  it('…nor before the take is attached: the voice\'s uploader is its owner', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'gen-rita.webm', { body: 'GEN' })).status).toBe(200)
    expect((await audio(MALLORY, 'PUT', 'gen-rita.wav', { body: 'MALLORY-WAV' })).status).toBe(403)
  })

  it('B3: an existing one can\'t be deleted and replaced', async () => {
    await approvedTake()
    await audio(RITA, 'PUT', 'gen-rita.webm', { body: 'GEN' })
    await voice(RITA, 'gen-rita.webm')
    expect((await audio(RITA, 'PUT', 'gen-rita.wav', { body: 'RITA-WAV' })).status).toBe(200)
    expect((await audio(MALLORY, 'PUT', 'gen-rita.wav', { body: 'MALLORY-WAV' })).status).toBe(403)
    expect((await audio(MALLORY, 'DELETE', 'gen-rita.wav')).status).toBe(403)
    expect((await audio(RITA, 'DELETE', 'gen-rita.wav')).status).toBe(403)
    expect(text(b.objects.get(KEY(F, 'gen-rita.wav')))).toBe('RITA-WAV')
  })

  it('B4: a contributor limited to Arabic can\'t write a Spanish voice\'s WAV, even their own', async () => {
    await approvedTake({ lane: 'es' })
    await audio(RITA, 'PUT', 'gen-rita.webm', { body: 'GEN' })
    await voice(RITA, 'gen-rita.webm', 'c2', { targetLang: 'es' })
    const arabicOnly = { ...RITA, scopes: [{ kind: 'lane', value: 'cc33dd44' }] }
    expect((await audio(arabicOnly, 'PUT', 'gen-rita.wav', { body: 'AR-WAV' })).status).toBe(403)
  })

  it('the real background upload works, fast (before the attach lands) or slow (after), and only once', async () => {
    await approvedTake()
    // Fast: the WAV goes up before the take is attached.
    await audio(RITA, 'PUT', 'gen-fast.webm', { body: 'GEN' })
    expect((await audio(RITA, 'PUT', 'gen-fast.wav', { body: 'FAST-WAV' })).status).toBe(200)
    await voice(RITA, 'gen-fast.webm')
    // Slow: the take is attached first, the WAV comes after.
    await audio(RITA, 'PUT', 'gen-slow.webm', { body: 'GEN2' })
    await voice(RITA, 'gen-slow.webm', 'c3')
    expect((await audio(RITA, 'PUT', 'gen-slow.wav', { body: 'SLOW-WAV' })).status).toBe(200)
    // A retry of the same bytes is fine; other bytes are not.
    expect((await audio(RITA, 'PUT', 'gen-slow.wav', { body: 'SLOW-WAV' })).status).toBe(200)
    expect((await audio(RITA, 'PUT', 'gen-slow.wav', { body: 'OTHER' })).status).toBe(409)
  })
})

describe('.peaks is a waveform and nothing else', () => {
  it('B5: an upload that is not a real sidecar is refused', async () => {
    await approvedTake()
    expect((await audio(MALLORY, 'PUT', 'mal.webm.peaks', { body: 'MAL-CLEAN' })).status).toBe(400)
    expect((await audio(MALLORY, 'PUT', 'mal.webm.peaks', { body: new Uint8Array(16 * 1024 + 1).fill(0x41) })).status).toBe(400)
    const big = new Uint8Array(16 * 1024 + 1); big.set([0x41, 0x51, 0x50, 0x4b])
    expect((await audio(MALLORY, 'PUT', 'mal.webm.peaks', { body: big })).status).toBe(400)
    expect((await audio(RITA, 'PUT', 'take-rita.webm.peaks', { body: peaks() })).status).toBe(200)
  })

  it('no take can be attached under a .peaks name', async () => {
    await approvedTake()
    const byId = await post([ev('cell.audio.attach', F, 'c3', 'mallory', { audioId: 'mal.webm.peaks', url: 'frontier-audio://mal.webm', slot: 'recording' })], MALLORY)
    const byUrl = await post([ev('cell.audio.attach', F, 'c3', 'mallory', { audioId: 'mal.webm', url: 'frontier-audio://mal.webm.peaks', slot: 'recording' })], MALLORY)
    expect(byId.rejected).toEqual([expect.objectContaining({ status: 422 })])
    expect(byUrl.rejected).toEqual([expect.objectContaining({ status: 422 })])
  })
})
