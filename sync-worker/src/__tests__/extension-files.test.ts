// Smart Extensions apiRev 7, the server half: extension files and data files.
//
//   - a claimed extension identity (payload.tool_origin) on a file write must
//     carry a valid tool session for that tool/version/hash/project/author;
//   - an extension DATA file (role 'extension-data') is written only by a
//     verified extension, and a contributor may do it (the floor for its cells
//     is CONTRIBUTOR), while ordinary source writes stay project-lead;
//   - /import creates a data file for a contributor only with a verified
//     extension, and stamps provenance on the file and every cell;
//   - file.extension.set / file.create carry files.meta.extension and the files
//     read route returns it;
//   - GET /cells/by-ref reads cells by canonical ref across files.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sign } from 'hono/jwt'
import { authorize } from '../events/authorize'
import { handleBulkImportRequest } from '../events/import-route'
import { handleCellsByRefRequest, pgTextArray } from '../events/cells-by-ref-route'
import { handleFilesReadRequest } from '../events/files-read-route'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import { stampToolProvenance } from '../events/tool-provenance'
import { makeTestToken } from './helpers/auth'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { RawEvent } from '../events/types'
import { TOOL_SESSION_AUDIENCE } from '../../../shared/tools/tool-session'

const SECRET = 'extension-files-secret'
const P = 'proj-ext'
const HASH = 'c'.repeat(64)
const ORIGIN = { origin: 'tool' as const, toolId: 'tool-1', version: 2, codeHash: HASH }
let t: TestDb

async function session(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { aud: TOOL_SESSION_AUDIENCE, projectId: P, toolId: 'tool-1', version: 2, codeHash: HASH, userId: 1, username: 'alice', iat: now, exp: now + 600, ...overrides },
    SECRET,
    'HS256',
  )
}

async function token(fileId: string, role: number): Promise<string> {
  return makeTestToken(SECRET, { projectId: P, fileId, role, username: 'alice', userId: 1 })
}

function commit(fileId: string, payload: Record<string, unknown>): RawEvent<'source.cell.commit'> {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`, schemaVersion: 1, kind: 'source.cell.commit',
    projectId: P, fileId, cellId: 'c1', parentId: 'head-1', author: 'alice', clientTs: 1,
    payload: { value: 'x', ...payload },
  } as RawEvent<'source.cell.commit'>
}

beforeAll(async () => {
  t = await makeTestDb({
    files: [
      { id: 'data-file', project_id: P, role: 'extension-data' },
      { id: 'normal-file', project_id: P, role: 'source' },
    ],
  })
})
afterAll(async () => {
  await t?.close()
})

describe('authorize: extension identity and data files', () => {
  it('refuses a source write that claims an extension without a session', async () => {
    const r = await authorize(await token('normal-file', 500), commit('normal-file', { tool_origin: ORIGIN }), SECRET, t.db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/could not be verified/)
  })

  it('refuses a session minted for another tool, version or user', async () => {
    for (const bad of [{ toolId: 'tool-2' }, { version: 1 }, { username: 'mallory', userId: 9 }, { projectId: 'other' }]) {
      const tag = { ...ORIGIN, session: await session(bad) }
      const r = await authorize(await token('normal-file', 500), commit('normal-file', { tool_origin: tag }), SECRET, t.db)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('accepts a verified extension write at the normal floor', async () => {
    const tag = { ...ORIGIN, session: await session() }
    expect((await authorize(await token('normal-file', 500), commit('normal-file', { tool_origin: tag }), SECRET, t.db)).ok).toBe(true)
    // An ordinary source commit stays project-lead, extension or not.
    expect((await authorize(await token('normal-file', 400), commit('normal-file', { tool_origin: tag }), SECRET, t.db)).ok).toBe(false)
  })

  it('lets a contributor write a data file through a verified extension, and nobody without one', async () => {
    const tag = { ...ORIGIN, session: await session() }
    expect((await authorize(await token('data-file', 400), commit('data-file', { tool_origin: tag }), SECRET, t.db)).ok).toBe(true)
    const human = await authorize(await token('data-file', 700), commit('data-file', {}), SECRET, t.db)
    expect(human.ok).toBe(false)
    if (!human.ok) expect(human.reason).toMatch(/only be written by an extension/)
    // Below contributor, even a verified extension cannot write data.
    expect((await authorize(await token('data-file', 300), commit('data-file', { tool_origin: tag }), SECRET, t.db)).ok).toBe(false)
    // The user's own revert compensation is allowed.
    expect((await authorize(await token('data-file', 400), commit('data-file', { revert_of_tool: { toolId: 'tool-1', sinceMs: 1 } }), SECRET, t.db)).ok).toBe(true)
  })
})

describe('tool provenance with sessions', () => {
  it('is verified only with a matching session when the secret is given', async () => {
    await t.db.prepare(`INSERT INTO project_tools (id, project_id, name, created_by_user_id) VALUES ('tool-1', ?, 'Importer', 1)`).bind(P).run()
    await t.db.prepare(
      `INSERT INTO project_tool_versions (tool_id, project_id, version, source, manifest, code_hash, api_rev, origin, created_by_user_id)
       VALUES ('tool-1', ?, 2, '<script></script>', '{}'::jsonb, ?, 7, 'builder', 1)`,
    ).bind(P, HASH).run()
    for (const [i, id] of ['pv1', 'pv2', 'pv3'].entries()) {
      await t.db.prepare(
        `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
         VALUES (?, 1, ?, 'normal-file', 'c', 'source.cell.commit', 'alice', '{}', 1, 1, null, ?)`,
      ).bind(id, P, 900 + i).run()
    }
    await stampToolProvenance(t.db, [
      { id: 'pv1', projectId: P, author: 'alice', payload: { tool_origin: { ...ORIGIN, session: await session() } } },
      { id: 'pv2', projectId: P, author: 'alice', payload: { tool_origin: ORIGIN } },
      { id: 'pv3', projectId: P, author: 'alice', payload: { tool_origin: { ...ORIGIN, session: 'forged' } } },
    ], SECRET)
    const rows = await t.pg.query<{ id: string; provenance: Record<string, unknown> }>(`SELECT id, provenance FROM events WHERE id IN ('pv1','pv2','pv3') ORDER BY id`)
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.provenance]))
    expect(byId.pv1).toMatchObject({ verified: true, session: 'verified' })
    expect(byId.pv2).toMatchObject({ verified: false, session: 'missing' })
    expect(byId.pv3).toMatchObject({ verified: false, session: 'invalid' })
  })
})

function importRequest(tok: string, fileId: string, body: Record<string, unknown>, dataClaim = true): Request {
  return new Request('https://worker/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(dataClaim ? { 'X-Aquilla-Extension-Data': '1' } : {}) },
    body: JSON.stringify({ projectId: P, fileId, cells: [], ...body }),
  })
}

describe('/import for extension files', () => {
  it('creates a data file for a contributor through a verified extension, with extension meta and provenance', async () => {
    const tag = { ...ORIGIN, session: await session() }
    const res = await handleBulkImportRequest(
      importRequest(await token('data-new', 400), 'data-new', {
        file: { id: 'data-new-create', name: 'uw.alignment (extension data)', fileType: 'json', role: 'extension-data', extension: { kind: 'data', tags: ['data:uw.alignment'], owner: 'tool-1', meta: { ns: 'uw.alignment', coll: 'default' } } },
        cells: [{ id: 'data-new-c1-evt', cellId: 'data-new-c1', value: '{"v":1,"id":"a","doc":{},"anchor":null}' }],
        toolOrigin: tag,
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res?.status).toBe(200)
    const file = await t.db.prepare(`SELECT role, meta FROM files WHERE id = 'data-new'`).first<{ role: string; meta: string }>()
    expect(file?.role).toBe('extension-data')
    expect(JSON.parse(file?.meta ?? '{}').extension).toMatchObject({ kind: 'data', owner: 'tool-1' })
    const prov = await t.db.prepare(`SELECT provenance FROM events WHERE id = 'data-new-c1-evt'`).first<{ provenance: Record<string, unknown> | string }>()
    const envelope = typeof prov?.provenance === 'string' ? JSON.parse(prov.provenance) : prov?.provenance
    expect(envelope).toMatchObject({ origin: 'tool', toolId: 'tool-1', session: 'verified' })
  })

  it('refuses a contributor import into an ordinary file, and an unverifiable extension claim from anyone', async () => {
    const tag = { ...ORIGIN, session: await session() }
    // Without the data-file claim a contributor is refused before the body is read.
    const undeclared = await handleBulkImportRequest(
      importRequest(await token('data-new', 400), 'data-new', { toolOrigin: tag }, false),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(undeclared?.status).toBe(403)
    const contributor = await handleBulkImportRequest(
      importRequest(await token('plain-new', 400), 'plain-new', { file: { id: 'plain-new-create', name: 'x', fileType: 'custom' }, toolOrigin: tag }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(contributor?.status).toBe(403)
    const forged = await handleBulkImportRequest(
      importRequest(await token('plain-new', 600), 'plain-new', { file: { id: 'plain-new-create', name: 'x', fileType: 'custom' }, toolOrigin: { ...ORIGIN, session: 'nope' } }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(forged?.status).toBe(403)
  })
})

describe('files.meta.extension', () => {
  it('file.extension.set replaces it, null clears it, and the files read route returns it', async () => {
    const ev = (extension: unknown): PersistedEvent => ({
      id: `fx-${Math.random().toString(36).slice(2)}`, schemaVersion: 1, projectId: P, fileId: 'normal-file', cellId: null, parentId: null,
      kind: 'file.extension.set', author: 'alice', payload: { extension }, clientTs: 1, serverTs: 1,
    })
    const run = async (e: PersistedEvent) => {
      const stmts: AquillaStatement[] = []
      buildEventProjectionStmts(t.db, e, stmts)
      for (const s of stmts) await s.run()
    }
    await run(ev({ kind: 'reference', tags: ['uw', 'book:TIT'], group: 'uw:TIT', meta: { sha: 'abc' } }))
    const res = await handleFilesReadRequest(
      new Request(`https://worker/api/v1/projects/${P}/files/normal-file`, { headers: { Authorization: `Bearer ${await token('any', 100)}` } }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    const body = (await res?.json()) as { file?: { extension?: unknown }; extension?: unknown }
    const file = (body.file ?? body) as { extension?: unknown }
    expect(file.extension).toMatchObject({ kind: 'reference', tags: ['uw', 'book:TIT'], group: 'uw:TIT', meta: { sha: 'abc' } })
    await run(ev(null))
    const cleared = await t.db.prepare(`SELECT meta FROM files WHERE id = 'normal-file'`).first<{ meta: string }>()
    expect(JSON.parse(cleared?.meta ?? '{}').extension).toBeUndefined()
  })
})

describe('files listing and data files', () => {
  it('hides data files from the listing unless ?extensionData=1 (e2e found the host could not see its own)', async () => {
    const list = async (qs: string) => {
      const res = await handleFilesReadRequest(
        new Request(`https://worker/api/v1/projects/${P}/files${qs}`, { headers: { Authorization: `Bearer ${await token('any', 100)}` } }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
      )
      return ((await res?.json()) as { files: { fileId: string }[] }).files.map((f) => f.fileId)
    }
    expect(await list('')).not.toContain('data-file')
    expect(await list('?extensionData=1')).toContain('data-file')
  })
})

describe('GET /cells/by-ref', () => {
  it('reads cells by exact ref or prefix across files', async () => {
    const insert = async (fileId: string, cellId: string, ref: string, value: string) => {
      await t.db.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, lane_id)
         VALUES (?, ?, ?, 'source', ?, ?, ?, 1, COALESCE((SELECT id FROM lanes WHERE project_id = ? AND role = 'source' LIMIT 1), 'src'))`,
      ).bind(P, fileId, cellId, value, ref, `ev-${cellId}`, P).run()
    }
    await insert('ult-tit', 'u1', 'TIT 1:1', 'Paul, a servant of God')
    await insert('ult-tit', 'u2', 'TIT 1:2', 'in hope of eternal life')
    await insert('tn-tit', 'n1', 'TIT 1:1', 'a servant of God — a humble role')
    await insert('tn-tit', 'n9', 'TIT 2:1', 'later')
    const get = async (qs: string) => {
      const res = await handleCellsByRefRequest(
        new Request(`https://worker/api/v1/projects/${P}/cells/by-ref?${qs}`, { headers: { Authorization: `Bearer ${await token('any', 100)}` } }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
      )
      expect(res?.status).toBe(200)
      return ((await res?.json()) as { cells: { fileId: string; cellId: string; canonicalRef: string }[] }).cells
    }
    const exact = await get(`files=ult-tit,tn-tit&refs=${encodeURIComponent('TIT 1:1')}`)
    expect(exact.map((c) => `${c.fileId}/${c.cellId}`).sort()).toEqual(['tn-tit/n1', 'ult-tit/u1'])
    const chapter = await get(`files=ult-tit,tn-tit&prefix=${encodeURIComponent('TIT 1:')}`)
    expect(chapter.map((c) => c.cellId).sort()).toEqual(['n1', 'u1', 'u2'])
    // Refs and file ids are bound as escaped array LITERALS (postgres.js does not
    // infer array params: a JS array bound here broke the live worker, e2e found it).
    await insert('tn-tit', 'odd', 'X "q", {1}\\', 'odd ref')
    const odd = await get(`files=tn-tit&refs=${encodeURIComponent('X "q", {1}\\')}`)
    expect(odd.map((c) => c.cellId)).toEqual(['odd'])
    expect(pgTextArray(['a', 'b"c', 'd\\e'])).toBe('{"a","b\\"c","d\\\\e"}')
    const res = await handleCellsByRefRequest(
      new Request(`https://worker/api/v1/projects/${P}/cells/by-ref?refs=x`, { headers: { Authorization: `Bearer ${await token('any', 100)}` } }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res?.status).toBe(400)
  })
})
