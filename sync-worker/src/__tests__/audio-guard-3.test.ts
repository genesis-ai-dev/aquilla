// AQU-2682 / AQU-2685, third round: the remaining ways round the limits.
//   - A new piece of a take is in its take's language, and checked as such.
//   - Choosing the shared source clip in a language is an act in that language.
//   - A voice's WAV belongs to the voice itself, never to a take that only
//     plays the voice's recording.
//   - A `.peaks` never goes up as a large upload, and storage without its
//     database refuses rather than weakens.
//   - A batch of hundreds of takes costs a bounded number of lookups.
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

const SECRET = 'audio-guard-3-secret'
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

async function send(who: Who, events: RawEvent[], opts: { wall?: boolean; fileId?: string } = {}) {
  const tok = await makeTestToken(SECRET, { projectId: P, fileId: opts.fileId ?? F, ...who } as never)
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ events }) }),
    { AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET, ...(opts.wall ? { LANE_READ_WALL: '1' } : {}) } as never,
  )
  return ((await res!.json()) as { rejected: Array<{ status: number }> }).rejected
}
const attachNew = (who: Who, lane: Record<string, string> = {}, fileId = F, cell = 'c9') =>
  ev('cell.audio.attach', fileId, cell, who.username, { audioId: `${who.username}-new.webm`, url: `frontier-audio://${who.username}-new.webm`, slot: 'recording', ...lane })
const trimRita = (who: Who, lane: Record<string, string> = {}) =>
  ev('cell.audio.trim', F, 'c1', who.username, { audioId: 'take-rita.webm', trimStartMs: 500, trimEndMs: 600, ...lane })
const removeRita = (who: Who, lane: Record<string, string> = {}) =>
  ev('cell.audio.remove', F, 'c1', who.username, { audioId: 'take-rita.webm', ...lane })
const refused = [expect.objectContaining({ status: 403 })]

const ARABIC = { ...MALLORY, laneGrants: [{ lane: 'cc33dd44', level: 400 }] }
const row = async (audioId: string) =>
  (await h.pg.query<{ selected: number; deleted: number; lane_id: string | null; piece_of: string | null }>(
    `SELECT selected, deleted, lane_id, piece_of FROM cell_audio WHERE audio_id = $1`, [audioId],
  )).rows[0]

describe('a new piece is in its take\'s language', () => {
  it('RC1: an Arabic-only contributor can\'t add a piece to a Spanish take', async () => {
    await approvedTake({ lane: 'es' })
    const rej = await send(ARABIC, [ev('cell.audio.attach', F, 'c1', 'mallory', {
      audioId: 'mal-piece.webm', url: 'frontier-audio://mal-piece.webm', slot: 'recording', pieceOf: 'take-rita.webm',
    })], { wall: true })
    expect(rej).toEqual(refused)
    expect(await row('mal-piece.webm')).toBeUndefined()
  })

  it('someone working in Spanish still can', async () => {
    await approvedTake({ lane: 'es' })
    const spanish = { ...RITA, laneGrants: [{ lane: ES, level: 400 }] }
    expect(await send(spanish, [ev('cell.audio.attach', F, 'c1', 'rita', {
      audioId: 'rita-piece.webm', url: 'frontier-audio://rita-piece.webm', slot: 'recording', pieceOf: 'take-rita.webm',
    })], { wall: true })).toEqual([])
  })
})

describe('choosing the source clip is an act in the language named', () => {
  async function withSourceClip() {
    await approvedTake({ lane: 'es' })
    expect(await send(OWNER, [ev('cell.audio.attach', F, 'c1', 'owner', { audioId: 'src.webm', url: 'frontier-audio://src.webm', slot: 'recording', role: 'source' })])).toEqual([])
    expect(await send(RITA, [ev('cell.audio.select', F, 'c1', 'rita', { audioId: 'take-rita.webm', slot: 'recording', targetLang: 'es' })])).toEqual([])
  }

  it('RC2: an Arabic-only contributor can\'t choose it in Spanish, and Rita\'s take stays chosen', async () => {
    await withSourceClip()
    expect(await send(ARABIC, [ev('cell.audio.select', F, 'c1', 'mallory', { audioId: 'src.webm', slot: 'recording', targetLang: 'es' })], { wall: true })).toEqual(refused)
    expect((await row('take-rita.webm')).selected).toBe(1)
  })

  it('in their own language they can', async () => {
    await withSourceClip()
    expect(await send(ARABIC, [ev('cell.audio.select', F, 'c1', 'mallory', { audioId: 'src.webm', slot: 'recording' })], { wall: true })).toEqual([])
  })
})

describe('a voice\'s WAV belongs to the voice itself', () => {
  it('RC4: a take that only plays the voice\'s recording makes nobody its owner', async () => {
    await approvedTake()
    expect((await audio(RITA, 'PUT', 'gen-rita.webm', { body: 'VOICE' })).status).toBe(200)
    expect(await send(RITA, [ev('cell.audio.attach', F, 'c2', 'rita', { audioId: 'gen-rita.webm', url: 'frontier-audio://gen-rita.webm', slot: 'generatedVoice' })])).toEqual([])
    expect(await send(MALLORY, [ev('cell.audio.attach', F, 'a0', 'mallory', { audioId: '0.webm', url: 'frontier-audio://gen-rita.webm', slot: 'recording' })])).toEqual([])
    expect((await audio(MALLORY, 'PUT', 'gen-rita.wav', { body: 'MALLORY-LOUD' })).status).toBe(403)
    expect((await audio(RITA, 'PUT', 'gen-rita.wav', { body: 'RITA-WAV' })).status).toBe(200)
  })

  it('takes that ARE the voice but disagree about who made it: only a Maintainer writes the WAV', async () => {
    await approvedTake()
    await audio(RITA, 'PUT', 'gen-two.webm', { body: 'VOICE' })
    await send(RITA, [ev('cell.audio.attach', F, 'c2', 'rita', { audioId: 'gen-two.webm', url: 'frontier-audio://gen-two.webm', slot: 'generatedVoice' })])
    await send(MALLORY, [ev('cell.audio.attach', F, 'c3', 'mallory', { audioId: 'gen-two.webm', url: 'frontier-audio://gen-two.webm', slot: 'generatedVoice' })])
    expect((await audio(RITA, 'PUT', 'gen-two.wav', { body: 'W' })).status).toBe(403)
    expect((await audio(MALLORY, 'PUT', 'gen-two.wav', { body: 'W' })).status).toBe(403)
    expect((await audio(MAX, 'PUT', 'gen-two.wav', { body: 'W' })).status).toBe(200)
  })
})

describe('storage edges', () => {
  it('RC5: a .peaks never goes up as a large upload', async () => {
    await approvedTake()
    expect((await audio(MALLORY, 'POST', 'take-rita.webm.peaks', { query: '?multipart=create' })).status).toBe(400)
  })

  it('a take\'s peaks are not removed through storage either', async () => {
    await approvedTake()
    b.objects.set(KEY(F, 'take-rita.webm.peaks'), { bytes: new Uint8Array([0x41, 0x51, 0x50, 0x4b, 2, 0, 0, 0, 0, 0, 0, 0]) })
    expect((await audio(MALLORY, 'DELETE', 'take-rita.webm.peaks')).status).toBe(403)
  })

  it('RC9: storage without its database refuses an upload rather than weakening', async () => {
    await approvedTake()
    const tok = await makeTestToken(SECRET, { projectId: P, fileId: F, ...MALLORY } as never)
    const res = (await handleAudioRequest(new Request(`https://worker/audio/${P}/${F}/gen-rita.wav`, {
      method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'audio/wav' }, body: 'MALLORY',
    }), { SNAPSHOTS: b.r2, SYNC_SECRET_KEY: SECRET } as never))!
    expect(res.status).toBe(500)
  })
})

describe('the cost of a big batch is bounded', () => {
  /** The test database, counting what it is asked. */
  function counting() {
    const asked: string[] = []
    const db = new Proxy(h.db as object, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver)
        if (prop === 'prepare') return (sql: string) => { asked.push(sql); return (v as (s: string) => unknown).call(target, sql) }
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as unknown as AquillaDb
    return { db, asked }
  }
  async function batch(who: Who, n: number) {
    const { db, asked } = counting()
    const events = Array.from({ length: n }, (_, i) =>
      ev('cell.audio.trim', F, `c${i}`, who.username, { audioId: `t${i}.webm`, trimStartMs: 0, trimEndMs: 100 }))
    const tok = await makeTestToken(SECRET, { projectId: P, fileId: F, ...who } as never)
    await handleEventsWriteRequest(
      new Request('https://worker/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ events }) }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, LANE_READ_WALL: '1' } as never,
    )
    return {
      laneLists: asked.filter((s) => /legacy_tag FROM lanes/.test(s)).length,
      takeLanes: asked.filter((s) => /COALESCE\(l\.legacy_tag, ''\) AS tag/.test(s)).length,
    }
  }

  it('300 takes by a contributor: the lanes read once, one lookup per take', async () => {
    await approvedTake()
    const cost = await batch(ARABIC, 300)
    expect(cost.laneLists).toBeLessThanOrEqual(2)
    expect(cost.takeLanes).toBeLessThanOrEqual(300)
  })

  it('300 takes by a Maintainer under the wall: no lane lookups at all', async () => {
    await approvedTake()
    const cost = await batch(MAX, 300)
    expect(cost).toEqual({ laneLists: 0, takeLanes: 0 })
  })
})
