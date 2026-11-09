// Google Drive folder sync (drive/drive-folder-sync.ts)
//
// Why these tests: a linked folder must behave like a person re-importing the
// file by hand, minus the person. So: a new Drive doc becomes ONE visible
// Aquilla file written as a revision (not N cell events); an edit upstream
// becomes ONE more revision that keeps a translation on its paragraph; an
// unchanged doc costs no download and writes nothing; and the sync never
// writes as someone who is no longer a project lead, never resurrects a file
// deleted in Aquilla, and stops when the link is removed.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { makeTestDb } from './helpers/pg-test-db'
import { syncDriveFolderLink, type DriveSyncEnv } from '../drive/drive-folder-sync'
import { resetServiceAccountTokenCacheForTests } from '../drive/google-auth'
import { GOOGLE_DOC_MIME } from '../drive/drive-api'

const SECRET = 'test-secret'
const PROJECT = 'p1'
const LINK = 'link-1'
const FOLDER = 'folder-abcdefghij'
const DOC = 'doc-abcdefghij'

async function docx(paras: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}

function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  const toBuffer = async (value: unknown): Promise<ArrayBuffer> => {
    if (value instanceof ReadableStream) return new Response(value).arrayBuffer()
    if (typeof value === 'string') return new TextEncoder().encode(value).buffer as ArrayBuffer
    if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
    return value as ArrayBuffer
  }
  return {
    async put(key: string, value: unknown) {
      const body = await toBuffer(value)
      store.set(key, body)
      return { size: body.byteLength, key }
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj, text: async () => new TextDecoder().decode(obj) }
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
  }
}

let serviceAccountJson = ''
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`
  serviceAccountJson = JSON.stringify({ client_email: 'aquilla-sync@test.iam.gserviceaccount.com', private_key: pem })
})

/** A fake Google: token endpoint + one folder holding Google Docs. */
function fakeDrive() {
  const docs = new Map<string, { name: string; version: number; bytes: Uint8Array }>()
  const calls = { token: 0, list: 0, export: 0 }
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'oauth2.googleapis.com') {
      calls.token++
      return Response.json({ access_token: 'drive-token', expires_in: 3600 })
    }
    if (url.pathname === '/drive/v3/files') {
      calls.list++
      return Response.json({
        files: [...docs].map(([id, d]) => ({ id, name: d.name, mimeType: GOOGLE_DOC_MIME, version: String(d.version) })),
      })
    }
    const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname)
    if (exportMatch) {
      calls.export++
      const doc = docs.get(decodeURIComponent(exportMatch[1]))
      return doc ? new Response(doc.bytes) : new Response('not found', { status: 404 })
    }
    return new Response(`unexpected ${url.href}`, { status: 500 })
  }) as typeof fetch
  return {
    fetchFn,
    calls,
    async put(id: string, name: string, paras: string[]) {
      const prev = docs.get(id)
      docs.set(id, { name, version: (prev?.version ?? 0) + 1, bytes: await docx(paras) })
    },
    /** Drive bumps `version` on some metadata-only changes too. */
    touch(id: string) {
      const doc = docs.get(id)!
      doc.version++
    },
  }
}

async function setup(opts: { linkUserId?: number } = {}) {
  const { db, rows } = await makeTestDb({
    users: [
      { id: 1, username: 'lead', email: 'lead@x', password_hash: 'x' },
      { id: 2, username: 'ex-lead', email: 'ex@x', password_hash: 'x' },
    ],
    projects: [{ id: PROJECT, name: 'P', created_by: 1 }],
    drive_folder_links: [
      { id: LINK, project_id: PROJECT, folder_id: FOLDER, folder_name: 'Live', user_id: opts.linkUserId ?? 1, username: opts.linkUserId === 2 ? 'ex-lead' : 'lead', created_at: 1 },
    ],
  })
  const env = {
    SNAPSHOTS: makeStubBucket(),
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
  } as unknown as DriveSyncEnv
  const drive = fakeDrive()
  const sync = () => syncDriveFolderLink(env, LINK, { fetchFn: drive.fetchFn })
  const fileOf = async () =>
    (await db.prepare('SELECT file_id FROM drive_folder_files WHERE link_id = ? AND drive_file_id = ?').bind(LINK, DOC).first<{ file_id: string }>())?.file_id
  const sourceCells = async (fileId: string) =>
    (await rows<{ cell_id: string; file_id: string; side: string; value: string; hidden_at: number | null; sequence_index: number }>('cells'))
      .filter((c) => c.file_id === fileId && c.side === 'source')
  const revisions = async () => (await rows<{ revision_n: number; origin: string }>('file_revisions')).sort((a, b) => a.revision_n - b.revision_n)
  return { db, rows, env, drive, sync, fileOf, sourceCells, revisions }
}

describe('Drive folder sync', () => {
  beforeEach(() => resetServiceAccountTokenCacheForTests())

  it('turns a new Google Doc into one visible file written as a single revision', async () => {
    const t = await setup()
    await t.drive.put(DOC, 'Chapter 1', ['First paragraph.', 'Second paragraph.'])

    const result = await t.sync()

    expect(result.errors).toEqual([])
    expect(result.created).toEqual(['Chapter 1'])
    const fileId = await t.fileOf()
    expect(fileId).toBeTruthy()
    const file = await t.db.prepare('SELECT name, deleted_at, head_revision_n, meta FROM files WHERE id = ?').bind(fileId).first<{ name: string; deleted_at: number | null; head_revision_n: number; meta: string }>()
    // Published (not left staged-hidden) and named as a .docx, like an upload.
    expect(file).toMatchObject({ name: 'Chapter 1.docx', deleted_at: null, head_revision_n: 1 })
    expect(JSON.parse(file!.meta).aquillaImport.origin).toMatchObject({ provider: 'google-drive', driveFileId: DOC, folderLinkId: LINK })
    expect((await t.sourceCells(fileId!)).map((c) => c.value)).toEqual(['First paragraph.', 'Second paragraph.'])
    // One revision event, not one source.cell.create per paragraph.
    const kinds = (await t.rows<{ kind: string; file_id: string }>('events')).filter((e) => e.file_id === fileId).map((e) => e.kind)
    expect(kinds.filter((k) => k === 'source.cell.create')).toEqual([])
    expect(kinds.filter((k) => k === 'file.revision')).toHaveLength(1)
  })

  it('downloads nothing and writes nothing when the doc has not changed', async () => {
    const t = await setup()
    await t.drive.put(DOC, 'Chapter 1', ['First paragraph.'])
    await t.sync()
    const exportsBefore = t.drive.calls.export

    const again = await t.sync()

    expect(again).toMatchObject({ created: [], revised: [], unchanged: 1, errors: [] })
    expect(t.drive.calls.export).toBe(exportsBefore)
    expect(await t.revisions()).toHaveLength(1)
  })

  it('writes no revision when Drive bumps the version but the bytes are the same', async () => {
    const t = await setup()
    await t.drive.put(DOC, 'Chapter 1', ['First paragraph.'])
    await t.sync()
    t.drive.touch(DOC)

    const again = await t.sync()

    expect(again.revised).toEqual([])
    expect(await t.revisions()).toHaveLength(1)
  })

  it('applies an upstream edit as one revision that keeps each unchanged paragraph on its cell', async () => {
    const t = await setup()
    await t.drive.put(DOC, 'Chapter 1', ['Keep me.', 'Edit me.'])
    await t.sync()
    const fileId = (await t.fileOf())!
    const before = await t.sourceCells(fileId)
    const keepId = before.find((c) => c.value === 'Keep me.')!.cell_id
    // Upstream: a paragraph inserted at the top, the second one edited.
    await t.drive.put(DOC, 'Chapter 1', ['A new opening.', 'Keep me.', 'Edited text.'])
    const result = await t.sync()

    expect(result.errors).toEqual([])
    expect(result.revised).toEqual(['Chapter 1'])
    const revs = await t.revisions()
    expect(revs.map((r) => [r.revision_n, r.origin])).toEqual([[1, 'import'], [2, 'drive']])
    const after = (await t.sourceCells(fileId)).filter((c) => c.hidden_at == null)
    // The unchanged paragraph keeps its cell id — the id a translation hangs
    // on — although a paragraph was inserted above it.
    expect(after.find((c) => c.value === 'Keep me.')?.cell_id).toBe(keepId)
    expect(after.map((c) => c.value).sort()).toEqual(['A new opening.', 'Edited text.', 'Keep me.'])
  })

  it('stops writing when the person who linked the folder is no longer a project lead', async () => {
    const t = await setup({ linkUserId: 2 })
    await t.drive.put(DOC, 'Chapter 1', ['First paragraph.'])

    const result = await t.sync()

    expect(result.created).toEqual([])
    expect(result.errors.join(' ')).toMatch(/no longer a project lead/)
    expect(t.drive.calls.list).toBe(0)
    const link = await t.db.prepare('SELECT last_error FROM drive_folder_links WHERE id = ?').bind(LINK).first<{ last_error: string }>()
    expect(link?.last_error).toMatch(/no longer a project lead/)
  })

  it('does not bring back a file that was deleted in Aquilla', async () => {
    const t = await setup()
    await t.drive.put(DOC, 'Chapter 1', ['First paragraph.'])
    await t.sync()
    const fileId = (await t.fileOf())!
    await t.db.prepare('UPDATE files SET deleted_at = 123 WHERE id = ?').bind(fileId).run()

    await t.drive.put(DOC, 'Chapter 1', ['First paragraph, edited.'])
    const result = await t.sync()

    expect(result).toMatchObject({ created: [], revised: [] })
    expect(await t.revisions()).toHaveLength(1)
    const files = await t.rows<{ id: string }>('files')
    expect(files).toHaveLength(1)
  })

  it('reports the link as gone once it is removed, so the poller stops', async () => {
    const t = await setup()
    await t.db.prepare('DELETE FROM drive_folder_links WHERE id = ?').bind(LINK).run()

    const result = await t.sync()

    expect(result.linked).toBe(false)
    expect(t.drive.calls.list).toBe(0)
  })
})
