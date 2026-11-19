// AQU-2685: the events route holds audio events (attach, choose, remove,
// rename, trim, level, place, cut, uncut, measure, approve, withdraw) to the
// same file and language limits as text: a caller limited to some files acts
// on takes only there (a cue file counts as part of the file it belongs to),
// and one limited to some languages only on takes in those languages. A new
// take's language is the one its attach names; an existing take's is its own.
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

const SECRET = 'audio-event-scopes-secret'
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

describe('AQU-2685: a caller limited to some files', () => {
  const elsewhere = { ...MALLORY, scopes: [{ kind: 'file', value: OTHER }] }

  it('G1: can\'t attach, trim or remove takes in another file', async () => {
    await approvedTake()
    expect(await send(elsewhere, [attachNew(elsewhere)])).toEqual(refused)
    expect(await send(elsewhere, [trimRita(elsewhere)])).toEqual(refused)
    expect(await send(elsewhere, [removeRita(elsewhere)])).toEqual(refused)
    expect(await vc('take-rita.webm')).toMatchObject({ deleted: 0 })
  })

  it('records on the heard lines of their own file (the cue file belongs to it)', async () => {
    await approvedTake()
    const here = { ...RITA, scopes: [{ kind: 'file', value: F }] }
    expect(await send(here, [attachNew(here, {}, CUES, 'cue-1')], { fileId: CUES })).toEqual([])
  })

  it('a Maintainer limited to another file is limited too, as for text', async () => {
    await approvedTake()
    const max = { ...MAX, scopes: [{ kind: 'file', value: OTHER }] }
    expect(await send(max, [removeRita(max)])).toEqual(refused)
  })

  it('G4: a reviewer limited to another file can\'t approve a take here', async () => {
    await approvedTake()
    const rev = { username: 'rev2', userId: 12, role: 500, scopes: [{ kind: 'file', value: OTHER }] }
    expect(await send(rev, [ev('cell.audio.validate', F, 'c1', 'rev2', { audioId: 'take-rita.webm' })])).toEqual(refused)
    expect(await vc('take-rita.webm')).toMatchObject({ validator_count: 1 })
  })
})

describe('AQU-2685: a caller limited to some languages (lane scopes, wall off)', () => {
  const arabicOnly = { ...MALLORY, scopes: [{ kind: 'lane', value: 'cc33dd44' }] }

  it('G2: can\'t attach a Spanish take, nor trim or remove one', async () => {
    await approvedTake({ lane: 'es' })
    expect(await send(arabicOnly, [attachNew(arabicOnly, { targetLang: 'es' })])).toEqual(refused)
    expect(await send(arabicOnly, [trimRita(arabicOnly, { targetLang: 'es' })])).toEqual(refused)
    expect(await send(arabicOnly, [removeRita(arabicOnly, { targetLang: 'es' })])).toEqual(refused)
    expect(await vc('take-rita.webm')).toMatchObject({ deleted: 0 })
  })

  it('an existing take\'s own language decides, even when the event names none', async () => {
    await approvedTake({ lane: 'es' })
    expect(await send(arabicOnly, [trimRita(arabicOnly)])).toEqual(refused)
    expect(await send(arabicOnly, [removeRita(arabicOnly, { targetLang: '' })])).toEqual(refused)
  })

  it('in their own language they record and work as before', async () => {
    await approvedTake()
    expect(await send(arabicOnly, [attachNew(arabicOnly)])).toEqual([])
    expect(await send(arabicOnly, [trimRita(arabicOnly)])).toEqual([])
  })

  it('an unlimited contributor is not affected', async () => {
    await approvedTake({ lane: 'es' })
    expect(await send(MALLORY, [trimRita(MALLORY)])).toEqual([])
  })
})

describe('AQU-2685: with the lane wall on (lane grants)', () => {
  const arabicGrant = { ...MALLORY, laneGrants: [{ lane: 'cc33dd44', level: 400 }] }

  it('G3: an Arabic grant can\'t attach, trim or remove a Spanish take; it can in Arabic', async () => {
    await approvedTake({ lane: 'es' })
    expect(await send(arabicGrant, [attachNew(arabicGrant, { targetLang: 'es' })], { wall: true })).toEqual(refused)
    expect(await send(arabicGrant, [trimRita(arabicGrant)], { wall: true })).toEqual(refused)
    expect(await send(arabicGrant, [removeRita(arabicGrant)], { wall: true })).toEqual(refused)
    expect(await send(arabicGrant, [attachNew(arabicGrant)], { wall: true })).toEqual([])
  })

  it('G4: an Arabic reviewer can\'t approve a Spanish take', async () => {
    await approvedTake({ lane: 'es' })
    const rev = { username: 'rev', userId: 11, role: 500, laneGrants: [{ lane: 'cc33dd44', level: 500 }] }
    expect(await send(rev, [ev('cell.audio.validate', F, 'c1', 'rev', { audioId: 'take-rita.webm', targetLang: 'es' })], { wall: true })).toEqual(refused)
    expect(await vc('take-rita.webm')).toMatchObject({ validator_count: 1 })
  })

  it('a Maintainer passes the wall, as for text', async () => {
    await approvedTake({ lane: 'es' })
    expect(await send(MAX, [trimRita(MAX)], { wall: true })).toEqual([])
  })
})
