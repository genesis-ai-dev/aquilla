// AQU-2682: the app asks the server whether the signed-in person's access
// covers every language of the project before it offers "Upload a recording
// to make lines" or attaching media by url. Both store the file's SOURCE
// audio, which the events route refuses from someone limited to some
// languages. The answer must be the events route's own rule, so every case
// here also sends the source attach itself and checks the two agree.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { handleEventsWriteRequest } from '../events/route'
import { handleSourceAudioAccessRequest } from '../events/source-audio-access-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import type { RawEvent } from '../events/types'

const SECRET = 'source-audio-access-secret'
const P = 'proj-access'
const F = 'file-access'
const AR = 'cc33dd44'
const ES = 'aa11bb22'

let h: TestDb
beforeEach(async () => {
  if (!h) h = await makeTestDb()
  else await h.reset()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${AR}', '${P}', 'target', 'Arabic', 'ar', ''),
    ('${ES}', '${P}', 'target', 'Spanish', 'es', 'es')`)
})
afterAll(async () => { await h?.close() })

interface Who { username: string; userId: number; role: number; scopes?: unknown; laneGrants?: unknown; src?: string; fileId?: string }
const OWNER: Who = { username: 'owner', userId: 1, role: 700 }
const LEAD: Who = { username: 'ravi', userId: 3, role: 500 }
const LEAD_ALL: Who = { ...LEAD, laneGrants: [{ lane: AR, level: 500 }, { lane: ES, level: 500 }] }
const LEAD_AR: Who = { ...LEAD, laneGrants: [{ lane: AR, level: 500 }] }
const MAINTAINER_AR: Who = { username: 'max', userId: 4, role: 600, laneGrants: [{ lane: AR, level: 600 }] }
const LEAD_SCOPED: Who = { ...LEAD, scopes: [{ kind: 'lane', value: 'es' }] }
const MAINTAINER_SCOPED: Who = { username: 'max', userId: 4, role: 600, scopes: [{ kind: 'lane', value: 'es' }] }
const PLATFORM_LEAD: Who = { username: 'ops', userId: 9, role: 500, src: 'platform' }
// The Agent API's write token (token-bridge.ts) carries no laneGrants.
const AGENT_LEAD: Who = { username: 'agent', userId: 5, role: 500, src: 'external' }
const AGENT_MAINTAINER: Who = { ...AGENT_LEAD, role: 600 }

const env = (wall: boolean) =>
  ({ AQUILLA_PG: h.db, SYNC_SECRET_KEY: SECRET, ...(wall ? { LANE_READ_WALL: '1' } : {}) }) as never

async function ask(who: Who, opts: { wall: boolean; projectId?: string; token?: string | null; query?: string }) {
  const tok = opts.token !== undefined ? opts.token : await makeTestToken(SECRET, { projectId: P, fileId: F, ...who } as never)
  const res = await handleSourceAudioAccessRequest(
    new Request(`https://worker/api/v1/projects/${opts.projectId ?? P}/source-audio-access${opts.query ?? ''}`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }),
    env(opts.wall),
  )
  return res!
}

let n = 0
async function attachSource(who: Who, wall: boolean) {
  const tok = await makeTestToken(SECRET, { projectId: P, fileId: F, ...who } as never)
  const id = `${who.username}-${++n}.webm`
  const event = {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`, schemaVersion: 1, kind: 'cell.audio.attach',
    projectId: P, fileId: F, cellId: 'c1', parentId: null, author: who.username,
    payload: { audioId: id, url: `frontier-audio://${id}`, slot: 'recording', role: 'source' }, clientTs: n,
  } as unknown as RawEvent
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ events: [event] }) }),
    env(wall),
  )
  return ((await res!.json()) as { rejected: unknown[] }).rejected.length === 0
}

async function fileReady() {
  const tok = await makeTestToken(SECRET, { projectId: P, fileId: F, ...OWNER } as never)
  const create = {
    id: '00000000-0000-7000-8000-ffffffffffff', schemaVersion: 1, kind: 'file.create', projectId: P, fileId: F,
    parentId: null, author: 'owner', payload: { name: 'Sermon', fileType: 'codex' }, clientTs: 0,
  }
  const res = await handleEventsWriteRequest(
    new Request('https://worker/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ events: [create] }) }),
    env(false),
  )
  expect(((await res!.json()) as { rejected: unknown[] }).rejected).toEqual([])
}

const answer = async (who: Who, wall: boolean) => {
  const res = await ask(who, { wall })
  expect(res.status).toBe(200)
  expect(res.headers.get('Cache-Control')).toBe('no-store')
  return ((await res.json()) as { coversEveryLanguage: boolean }).coversEveryLanguage
}

describe('GET /api/v1/projects/:id/source-audio-access', () => {
  it.each([
    ['a Project Lead with grants on every language, under the wall', LEAD_ALL, true, true],
    ['a Project Lead limited to Arabic, under the wall', LEAD_AR, true, false],
    ['a Project Lead with no grants, under the wall', LEAD, true, false],
    ['a Maintainer with one grant, under the wall', MAINTAINER_AR, true, true],
    ['the owner, under the wall', OWNER, true, true],
    ['an unscoped Project Lead, wall off', LEAD, false, true],
    ['a Project Lead with a language scope, wall off', LEAD_SCOPED, false, false],
    ['a Maintainer with a language scope, wall off', MAINTAINER_SCOPED, false, false],
    ['a platform token below Maintainer, under the wall', PLATFORM_LEAD, true, true],
    ['an Agent API token below Maintainer (no grants on the token), under the wall', AGENT_LEAD, true, false],
    ['an Agent API token at Maintainer, under the wall', AGENT_MAINTAINER, true, true],
  ] as const)('%s', async (_name, who, wall, expected) => {
    await fileReady()
    expect(await answer(who, wall)).toBe(expected)
    // The same answer the events route gives the source attach itself.
    expect(await attachSource(who, wall)).toBe(expected)
  })

  it('refuses a missing token and a token for another project', async () => {
    expect((await ask(LEAD_ALL, { wall: true, token: null })).status).toBe(401)
    expect((await ask(LEAD_ALL, { wall: true, projectId: 'other-project' })).status).toBe(403)
  })

  it('leaves other paths and methods to other routes', async () => {
    const res = await handleSourceAudioAccessRequest(new Request(`https://worker/api/v1/projects/${P}/source-audio`), env(true))
    expect(res).toBeNull()
    const post = await handleSourceAudioAccessRequest(
      new Request(`https://worker/api/v1/projects/${P}/source-audio-access`, { method: 'POST' }), env(true))
    expect(post).toBeNull()
  })

  it('counts an archived language too, as the events route does', async () => {
    await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, archived_at) VALUES
      ('ee55ff66', '${P}', 'target', 'French', 'fr', 'fr', now())`)
    await fileReady()
    expect(await answer(LEAD_ALL, true)).toBe(false)
    expect(await attachSource(LEAD_ALL, true)).toBe(false)
  })

  it('agrees in a project whose languages all carry their own tag (no former default lane)', async () => {
    // New projects' languages are tagged with the language, never ''; the
    // app's source attach names no language.
    await h.pg.exec(`UPDATE lanes SET legacy_tag = 'ar' WHERE id = '${AR}'`)
    await fileReady()
    expect(await answer(LEAD_ALL, true)).toBe(true)
    expect(await attachSource(LEAD_ALL, true)).toBe(true)
    expect(await answer(LEAD_AR, true)).toBe(false)
    expect(await attachSource(LEAD_AR, true)).toBe(false)
  })

  it('says yes to a Project Lead in a project with no languages yet, as the events route does', async () => {
    await h.pg.exec(`DELETE FROM lanes WHERE project_id = '${P}'`)
    await fileReady()
    expect(await answer(LEAD, true)).toBe(true)
    expect(await attachSource(LEAD, true)).toBe(true)
  })

  it('says no once the member is removed or his role is lowered, before the token expires', async () => {
    await fileReady()
    await h.pg.exec(`INSERT INTO projects (id, name, created_by) VALUES ('${P}', 'Access', 999)`)
    // Removed: no grant left.
    expect(await answer(LEAD_ALL, true)).toBe(false)
    expect(await attachSource(LEAD_ALL, true)).toBe(false)
    // Lowered below the token's Project Lead.
    await h.pg.exec(`INSERT INTO project_members (project_id, user_id, role_level) VALUES ('${P}', 3, 400)`)
    expect(await answer(LEAD_ALL, true)).toBe(false)
    expect(await attachSource(LEAD_ALL, true)).toBe(false)
    // Still a Project Lead: yes again.
    await h.pg.exec(`UPDATE project_members SET role_level = 500 WHERE project_id = '${P}' AND user_id = 3`)
    expect(await answer(LEAD_ALL, true)).toBe(true)
    expect(await attachSource(LEAD_ALL, true)).toBe(true)
  })

  it('says no to a token limited to other files, for its own file or the one asked about', async () => {
    await fileReady()
    const elsewhere: Who = { ...LEAD_ALL, scopes: [{ kind: 'file', value: 'file-other' }] }
    expect(await answer(elsewhere, true)).toBe(false)
    expect(await attachSource(elsewhere, true)).toBe(false)
    const here: Who = { ...LEAD_ALL, scopes: [{ kind: 'file', value: F }] }
    expect(await answer(here, true)).toBe(true)
    expect(await attachSource(here, true)).toBe(true)
    const res = await ask(here, { wall: true, query: '?fileId=file-other' })
    expect(((await res.json()) as { coversEveryLanguage: boolean }).coversEveryLanguage).toBe(false)
  })

  it('answers on the project token (no file open): yes when unscoped, no when limited to some files', async () => {
    const projectToken = (who: Who) => makeTestToken(SECRET, { projectId: P, ...who, fileId: '__project__' } as never)
    const read = async (who: Who) =>
      ((await (await ask(who, { wall: true, token: await projectToken(who) })).json()) as { coversEveryLanguage: boolean }).coversEveryLanguage
    expect(await read(LEAD_ALL)).toBe(true)
    expect(await read({ username: 'max', userId: 4, role: 600 })).toBe(true)
    // A new file (what Import makes) is outside a file-limited lead's scopes.
    expect(await read({ ...LEAD_ALL, scopes: [{ kind: 'file', value: F }] })).toBe(false)
  })
})

describe('worker routing', () => {
  it('dispatches the read from the worker entry, behind CORS', async () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8')
    expect(src).toMatch(/import \{ handleSourceAudioAccessRequest \} from "\.\/events\/source-audio-access-route"/)
    expect(src).toMatch(/const sourceAudioAccessResponse = await handleSourceAudioAccessRequest\(request, env\)\s*\n\s*if \(sourceAudioAccessResponse\) return withCors\(sourceAudioAccessResponse, request\)/)
  })
})
