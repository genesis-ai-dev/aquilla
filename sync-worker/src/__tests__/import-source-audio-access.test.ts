// AQU-2682: an import that stores source audio is held to the same rule as the
// source attach on the events route (coversEveryLanguage). The Import dialog's
// media import finishes with POST /import { complete, attachments }, which
// writes `cell.audio.attach` events with role 'source' straight to the
// database. Before this, a Project Lead granted only Arabic could import a
// recording under the lane wall and store it as the source every language
// hears.
import { describe, it, expect } from 'vitest'

import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'import-source-access-secret'
const P = 'proj-imp-access'
const F = 'file-imp-access'
const AR = 'cc33dd44'
const ES = 'aa11bb22'

interface Who { username: string; userId: number; role: number; scopes?: unknown; laneGrants?: unknown; src?: string }
const LEAD: Who = { username: 'ravi', userId: 3, role: 500 }
const LEAD_ALL: Who = { ...LEAD, laneGrants: [{ lane: AR, level: 500 }, { lane: ES, level: 500 }] }
const LEAD_AR: Who = { ...LEAD, laneGrants: [{ lane: AR, level: 500 }] }
const MAINTAINER_AR: Who = { username: 'max', userId: 4, role: 600, laneGrants: [{ lane: AR, level: 600 }] }
const LEAD_SCOPED: Who = { ...LEAD, scopes: [{ kind: 'lane', value: 'es' }] }

const env = (db: AquillaDb, wall: boolean) =>
  ({ AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, ...(wall ? { LANE_READ_WALL: '1' } : {}) }) as never

function post(token: string, body: Record<string, unknown>) {
  return new Request('https://worker/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId: P, fileId: F, ...body }),
  })
}

/** Stage a media file the way the Import dialog does, then finish it. */
async function importMedia(who: Who, wall: boolean, role?: 'source' | 'dub') {
  const h = await makeTestDb()
  await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
    ('${AR}', '${P}', 'target', 'Arabic', 'ar', ''),
    ('${ES}', '${P}', 'target', 'Spanish', 'es', 'es')`)
  const token = await makeTestToken(SECRET, { projectId: P, fileId: F, ...who } as never)
  const first = await handleBulkImportRequest(post(token, {
    file: { id: 'file-evt-1', name: 'sermon.wav', fileType: 'audio' },
    stageEventId: 'file-stage-1',
    cells: [{ id: 'src-evt-1', cellId: 'cell-1', value: 'sermon.wav', medium: 'media' }],
  }), env(h.db, wall))
  expect(first?.status).toBe(200)
  await h.db.prepare(
    `INSERT INTO artifacts (
       id, project_id, uploaded_by_user_id, credential_id, name, content_type,
       size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
     ) VALUES (?::uuid, ?, '3', NULL, 'sermon.wav', 'audio/wav', 3, ?, ?, ?, 'audio', 'sermon-1.wav', '{}'::jsonb)`,
  ).bind('01900000-0000-7000-8000-000000000201', P, 'b'.repeat(64), `projects/${P}/files/${F}/audio/sermon-1.wav`, F).run()
  const done = await handleBulkImportRequest(post(token, {
    cells: [],
    complete: true,
    publishEventId: 'file-publish-1',
    attachments: [{
      id: 'attach-1', cellId: 'cell-1', audioId: 'sermon-1.wav', url: 'frontier-audio://sermon-1.wav',
      slot: 'recording', mimeType: 'audio/wav', durationMs: 1000,
      ...(role ? { role } : {}),
    }],
  }), env(h.db, wall))
  const events = await h.rows<{ id: string }>('events')
  return {
    status: done!.status,
    text: await done!.text(),
    audioRows: (await h.rows('cell_audio')).length,
    attachEvents: events.filter((e) => e.id === 'attach-1').length,
    publishEvents: events.filter((e) => e.id === 'file-publish-1').length,
    staged: (await h.rows<{ deleted_at: unknown }>('files'))[0]?.deleted_at != null,
  }
}

describe('POST /import: source audio needs every language', () => {
  it('refuses a Project Lead granted only Arabic, under the wall, and writes nothing', async () => {
    const r = await importMedia(LEAD_AR, true)
    expect(r.status).toBe(403)
    expect(r.text).toMatch(/every language/)
    expect(r.audioRows).toBe(0)
    expect(r.attachEvents).toBe(0)
    // The file stays staged (hidden); the reveal did not run either.
    expect(r.publishEvents).toBe(0)
    expect(r.staged).toBe(true)
  })

  it('refuses an attachment with no role (the default is source)', async () => {
    expect((await importMedia(LEAD_AR, true, undefined)).status).toBe(403)
    expect((await importMedia(LEAD_AR, true, 'source')).status).toBe(403)
  })

  it.each([
    ['a Project Lead with every language, under the wall', LEAD_ALL, true],
    ['a Maintainer with one grant, under the wall', MAINTAINER_AR, true],
    ['an unscoped Project Lead, wall off', LEAD, false],
    ['a platform token below Maintainer, under the wall', { ...LEAD, src: 'platform' }, true],
  ] as const)('accepts %s', async (_name, who, wall) => {
    const r = await importMedia(who, wall)
    expect(r.status).toBe(200)
    expect(r.audioRows).toBe(1)
    expect(r.staged).toBe(false)
  })

  it('refuses a Project Lead with a language scope, wall off', async () => {
    const r = await importMedia(LEAD_SCOPED, false)
    expect(r.status).toBe(403)
    expect(r.audioRows).toBe(0)
  })

  it('leaves a text-only finish alone for a lead limited to Arabic', async () => {
    const h = await makeTestDb()
    await h.pg.exec(`INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag) VALUES
      ('${AR}', '${P}', 'target', 'Arabic', 'ar', '')`)
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F, ...LEAD_AR, laneGrants: [] } as never)
    const res = await handleBulkImportRequest(post(token, { cells: [], complete: true }), env(h.db, true))
    expect(res?.status).toBe(200)
  })
})
