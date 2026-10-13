// AQU-1566 (option b): producer-to-consumer contract for captions that become a
// linked video's rows. The real client library drives the real sync-worker
// routes against real Postgres (PGlite), and the result is compared with a
// YouTube import made with "Import a caption export" of the same file.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCaptionRowsImporter,
  createTrackRowsPromoter,
  importTimelineTextTrack,
  isRowsAlreadyThereRefusal,
} from './timeline-text'
import { createYouTubeCaptionCommit } from './youtube-caption-commit'
import { prepareYouTubeCaptionImport, prepareYouTubePictureImport } from './youtube-captions'
import { extractSrtStrings } from '../parsers/subtitle'
import { deriveTracksForFile } from '../timeline/tracks'
import { handleBulkImportRequest } from '../../../sync-worker/src/events/import-route'
import { handleSourceUploadRequest } from '../../../sync-worker/src/events/source-upload-route'
import { handleOriginalDownloadRequest } from '../../../sync-worker/src/events/original-download-route'
import { makeTestDb } from '../../../sync-worker/src/__tests__/helpers/pg-test-db'
import { makeTestToken } from '../../../sync-worker/src/__tests__/helpers/auth'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const SECRET = 'caption-rows-contract'
const URL_ = 'https://youtu.be/aqz-KE-bpKQ'
// Out of time order on purpose: rows follow caption time, as an import does.
const SRT = '1\n00:00:02,000 --> 00:00:03,000\nLater caption\n\n'
  + '2\n00:00:00,500 --> 00:00:01,500\n<i>Earlier</i> caption'

async function harness(settings = '{}') {
  const store = await makeTestDb({
    project_settings: [{ project_id: 'p', settings }],
  })
  const objects = new Map()
  const env = { AQUILLA_PG: store.db, SYNC_SECRET_KEY: SECRET,
    SNAPSHOTS: {
      async put(key, body) {
        const bytes = await new Response(body).arrayBuffer()
        objects.set(key, bytes)
        return { key, size: bytes.byteLength }
      },
      async delete(key) { objects.delete(key) },
      async get(key) {
        const bytes = objects.get(key)
        return bytes ? { body: bytes, size: bytes.byteLength,
          async arrayBuffer() { return bytes } } : null
      },
    },
  }
  const promotions = []
  let loseNextPromotion = false
  const fetchImpl = vi.fn(async (url, init) => {
    const request = new Request(String(url), init)
    const response = await handleBulkImportRequest(request, env)
      ?? await handleSourceUploadRequest(request, env)
    if (!response) throw new Error(`Unhandled request: ${request.url}`)
    const body = init?.method === 'POST' && typeof init.body === 'string'
      ? JSON.parse(init.body) : null
    if (body?.captionPromotion) {
      promotions.push(body.captionPromotion)
      if (loseNextPromotion && response.ok) {
        loseNextPromotion = false
        // Committed on the server, but the browser never hears back.
        return new Response('Promotion response lost', { status: 400 })
      }
    }
    return response
  })
  vi.stubGlobal('fetch', fetchImpl)
  const getToken = fileId => makeTestToken(SECRET, { projectId: 'p', fileId, role: 600 })
  const ctx = { projectId: 'p', author: 'dev', getToken }
  const files = async () => (await store.pg.query(
    `SELECT id, name, role, kind, anchor_file_id, deleted_at, cell_count,
            meta::jsonb AS meta FROM files ORDER BY id`)).rows
  const rows = async fileId => (await store.pg.query(
    `SELECT value, value_html, type, start_ms, end_ms, sequence_index, medium, metadata
       FROM cells WHERE file_id = $1 AND side = 'source' ORDER BY start_ms`, [fileId])).rows
  const original = async fileId => {
    const token = await makeTestToken(SECRET, { projectId: 'p', fileId, role: 800 })
    return handleOriginalDownloadRequest(new Request(
      `https://sync.test/api/v1/projects/p/files/${fileId}/original`,
      { headers: { Authorization: `Bearer ${token}` } }), env)
  }
  return { store, env, fetchImpl, getToken, ctx, files, rows, original, promotions,
    loseNext() { loseNextPromotion = true } }
}

const srtSource = () => {
  const bytes = new TextEncoder().encode(SRT).buffer
  return { bytes, source: { cues: extractSrtStrings(SRT),
    artifact: { name: 'captions.srt', format: 'srt', bytes } } }
}

describe('captions attached to an empty linked video become its rows', () => {
  it('writes the rows an imported caption export would have, from one staged file', async () => {
    const h = await harness()
    try {
      const linked = await createYouTubeCaptionCommit(prepareYouTubePictureImport({
        url: URL_, name: 'Episode one' }), h.ctx)()
      const { bytes, source } = srtSource()
      const imported = await createYouTubeCaptionCommit(prepareYouTubeCaptionImport({
        url: URL_, captionName: 'captions.srt', captionText: SRT, rawBytes: bytes,
      }), h.ctx)()

      const commit = createCaptionRowsImporter({
        projectId: 'p', fileId: linked.ref.id, source, getToken: h.getToken,
        fetchImpl: h.fetchImpl,
      })
      h.loseNext()
      await expect(commit()).rejects.toThrow()
      const [first, concurrent] = await Promise.all([commit(), commit()])
      expect(concurrent).toEqual(first)
      expect(await commit()).toEqual(first)
      expect(first).toMatchObject({ fileId: linked.ref.id, cellCount: 2 })

      // One staged file and one receipt, however often the person retried.
      const staged = (await h.files()).filter(row => row.role === 'timeline-content')
      expect(staged).toEqual([expect.objectContaining({
        id: first.contentFileId, anchor_file_id: linked.ref.id, kind: 'srt',
      })])
      expect(staged[0].deleted_at).not.toBeNull()
      expect(new Set(h.promotions.map(p => p.genesisEventId)).size).toBe(1)
      expect(h.promotions[0]).toEqual({ contentFileId: first.contentFileId,
        genesisEventId: expect.any(String) })

      // The rows match an "Import a caption export" of the same file.
      const promotedRows = await h.rows(linked.ref.id)
      expect(promotedRows.map(row => row.value)).toEqual(['<i>Earlier</i> caption', 'Later caption'])
      expect(promotedRows).toEqual(await h.rows(imported.ref.id))
      const all = await h.files()
      const parent = all.find(row => row.id === linked.ref.id)
      const twin = all.find(row => row.id === imported.ref.id)
      expect(parent).toMatchObject({ role: 'source', kind: twin.kind, cell_count: 2,
        deleted_at: null })
      for (const key of ['orderedBy', 'importFormat', 'parserVersion', 'coreMediaUrl']) {
        expect(parent.meta[key], key).toEqual(twin.meta[key])
      }
      const { fileName: _a, ...parentManifest } = parent.meta.aquillaImport
      const { fileName: _b, ...twinManifest } = twin.meta.aquillaImport
      expect(parentManifest).toEqual(twinManifest)

      // Download original returns the caption file the rows came from.
      const download = await h.original(linked.ref.id)
      expect(download.status).toBe(200)
      expect(await download.arrayBuffer()).toEqual(bytes)
    } finally { await h.store.close() }
  }, 30_000)

  it('lets Cancel stop a retry: each press brings its own signal', async () => {
    const h = await harness()
    try {
      const linked = await createYouTubeCaptionCommit(prepareYouTubePictureImport({
        url: URL_, name: 'Episode one' }), h.ctx)()
      // Offline for the whole first press, through every retry it makes.
      let offline = true
      const fetchImpl = async (url, init) => {
        if (offline) throw new TypeError('Failed to fetch')
        return h.fetchImpl(url, init)
      }
      const commit = createCaptionRowsImporter({ projectId: 'p', fileId: linked.ref.id,
        source: srtSource().source, getToken: h.getToken, fetchImpl })
      // The first press fails; its controller is never aborted.
      await expect(commit({ signal: new AbortController().signal })).rejects.toThrow()
      offline = false
      // The retry is cancelled. It must not go on to promote under the first
      // press's live signal.
      const retry = new AbortController()
      retry.abort()
      await expect(commit({ signal: retry.signal })).rejects.toThrow()
      expect(h.promotions).toEqual([])
      expect(await h.rows(linked.ref.id)).toHaveLength(0)
      // A later press still finishes the same import.
      await expect(commit()).resolves.toMatchObject({ cellCount: 2 })
      expect(h.promotions).toHaveLength(1)
    } finally { await h.store.close() }
  }, 30_000)

  it('refuses a second set of captions once the file has rows', async () => {
    const h = await harness()
    try {
      const linked = await createYouTubeCaptionCommit(prepareYouTubePictureImport({
        url: URL_, name: 'Episode one' }), h.ctx)()
      await createCaptionRowsImporter({ projectId: 'p', fileId: linked.ref.id,
        source: srtSource().source, getToken: h.getToken, fetchImpl: h.fetchImpl })()
      const refusal = await createCaptionRowsImporter({ projectId: 'p', fileId: linked.ref.id,
        source: srtSource().source, getToken: h.getToken, fetchImpl: h.fetchImpl })()
        .then(() => null, error => error)
      expect(refusal?.message).toMatch(/409.*already has rows/)
      // The Text view turns exactly this refusal into "already has rows,
      // reload to see them"; anything else keeps its own message.
      expect(isRowsAlreadyThereRefusal(refusal)).toBe(true)
      expect(isRowsAlreadyThereRefusal(new Error('Import publication failed (HTTP 409): '
        + 'that caption track changed, reload and try again'))).toBe(false)
      expect(await h.rows(linked.ref.id)).toHaveLength(2)
    } finally { await h.store.close() }
  }, 30_000)

  it('refuses a non-caption original before writing anything', () => {
    expect(() => createCaptionRowsImporter({ projectId: 'p', fileId: 'video',
      source: { cues: extractSrtStrings(SRT), artifact: { name: 'script.txt',
        format: 'txt', bytes: new ArrayBuffer(1) } },
      getToken: async () => 'tok' })).toThrow('Choose a VTT, SRT or SBV caption file.')
  })
})

describe('a caption track already on an empty linked video becomes its rows', () => {
  it('moves the cues into rows, retires the track and keeps working without track editing', async () => {
    const h = await harness('{"allowTrackEditing":true}')
    try {
      const linked = await createYouTubeCaptionCommit(prepareYouTubePictureImport({
        url: URL_, name: 'Episode one' }), h.ctx)()
      // The old client's attach: a timeline-only track on a file with no rows.
      const track = await importTimelineTextTrack({
        projectId: 'p', anchorFileId: linked.ref.id, name: 'Episode captions',
        source: srtSource().source, getToken: h.getToken, fetchImpl: h.fetchImpl,
      })
      await h.store.pg.query(`UPDATE project_settings SET settings = '{}'`)

      const promote = createTrackRowsPromoter({ projectId: 'p', fileId: linked.ref.id,
        trackId: track.trackId, contentFileId: track.fileId, getToken: h.getToken,
        fetchImpl: h.fetchImpl })
      h.loseNext()
      await expect(promote()).rejects.toThrow()
      await promote()
      await promote()
      expect(new Set(h.promotions.map(p => p.genesisEventId)).size).toBe(1)
      expect(h.promotions[0]).toEqual({ contentFileId: track.fileId, trackId: track.trackId,
        genesisEventId: expect.any(String), retireEventId: expect.any(String),
        deleteEventId: expect.any(String) })

      expect((await h.rows(linked.ref.id)).map(row => row.value))
        .toEqual(['<i>Earlier</i> caption', 'Later caption'])
      const all = await h.files()
      const parent = all.find(row => row.id === linked.ref.id)
      expect(parent).toMatchObject({ kind: 'srt', cell_count: 2 })
      expect(deriveTracksForFile({ trackOverrides: parent.meta.trackOverrides })
        .some(row => row.id === track.trackId)).toBe(false)
      expect(all.find(row => row.id === track.fileId).deleted_at).not.toBeNull()
    } finally { await h.store.close() }
  }, 30_000)
})
