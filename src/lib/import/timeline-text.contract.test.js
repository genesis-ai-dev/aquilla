import { afterEach, describe, expect, it, vi } from 'vitest'
import { importTimelineTextTrack } from './timeline-text'
import { extractSrtStrings } from '../parsers/subtitle'
import { deriveTracksForFile } from '../timeline/tracks'
import { handleBulkImportRequest } from '../../../sync-worker/src/events/import-route'
import { handleSourceUploadRequest } from '../../../sync-worker/src/events/source-upload-route'
import { makeTestDb } from '../../../sync-worker/src/__tests__/helpers/pg-test-db'
import { makeTestToken } from '../../../sync-worker/src/__tests__/helpers/auth'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('caption attachment producer and publication consumer', () => {
  it('preserves the caption bytes and creates a separate timed text track', async () => {
    const store = await makeTestDb({
      project_settings: [{ project_id: 'p', settings: '{"allowTrackEditing":true}' }],
      files: [{ id: 'media', project_id: 'p', role: 'source', name: 'Original media' }],
      cells: [{ project_id: 'p', file_id: 'media', cell_id: 'original',
        side: 'source', value: 'Existing wording', start_ms: 0, end_ms: 4000 }],
    })
    const objects = new Map()
    const env = { AQUILLA_PG: store.db, SYNC_SECRET_KEY: 'text-track-contract',
      SNAPSHOTS: {
        async put(key, body) {
          const bytes = await new Response(body).arrayBuffer()
          objects.set(key, bytes)
          return { key, size: bytes.byteLength }
        },
        async delete(key) { objects.delete(key) },
      },
    }
    const fetchImpl = vi.fn(async (url, init) => {
      const request = new Request(String(url), init)
      const response = await handleBulkImportRequest(request, env)
        ?? await handleSourceUploadRequest(request, env)
      if (!response) throw new Error(`Unhandled request: ${request.url}`)
      return response
    })
    const text = '1\n00:00:02,000 --> 00:00:03,000\nSecond phrase.\n\n' +
      '2\n00:00:00,500 --> 00:00:01,500\nFirst phrase.'
    const bytes = new TextEncoder().encode(text).buffer
    try {
      const uploaded = await importTimelineTextTrack({
        projectId: 'p', anchorFileId: 'media', name: 'New captions', durationMs: 4000,
        source: { cues: extractSrtStrings(text),
          artifact: { name: 'captions.srt', format: 'srt', bytes } },
        getToken: fileId => makeTestToken(env.SYNC_SECRET_KEY, {
          projectId: 'p', fileId, role: 600,
        }), fetchImpl,
      })
      const files = await store.rows('files')
      expect(files).toHaveLength(2)
      expect(files.find(file => file.id === uploaded.fileId))
        .toMatchObject({ role: 'timeline-content', anchor_file_id: 'media', deleted_at: null })
      const parent = files.find(file => file.id === 'media')
      const tracks = deriveTracksForFile({ trackOverrides: JSON.parse(parent.meta).trackOverrides })
      expect(tracks.find(track => track.id === uploaded.trackId))
        .toMatchObject({ name: 'New captions', kind: 'source-subtitles',
          contentFileId: uploaded.fileId })
      const cells = await store.rows('cells')
      expect(cells.filter(cell => cell.file_id === 'media'))
        .toEqual([expect.objectContaining({ cell_id: 'original', value: 'Existing wording' })])
      expect(cells.filter(cell => cell.file_id === uploaded.fileId)
        .sort((a, b) => a.sequence_index - b.sequence_index))
        .toEqual([
          expect.objectContaining({ value: 'First phrase.', start_ms: 500, end_ms: 1500 }),
          expect.objectContaining({ value: 'Second phrase.', start_ms: 2000, end_ms: 3000 }),
        ])
      const artifacts = await store.rows('artifacts')
      expect(artifacts).toHaveLength(1)
      expect(objects.get(artifacts[0].r2_key)).toEqual(bytes)
      expect(artifacts[0]).toMatchObject({ name: 'captions.srt', file_id: uploaded.fileId })
      expect(uploaded.cellCount).toBe(2)
      const replacementText = '1\n00:00:01,000 --> 00:00:02,500\nReviewed replacement.'
      let lostResponse = false
      const replaced = await importTimelineTextTrack({
        projectId: 'p', anchorFileId: 'media', name: 'Reviewed captions', durationMs: 4000,
        trackId: uploaded.trackId,
        overwrite: { contentFileId: uploaded.fileId, segmentCount: 2 },
        source: { cues: extractSrtStrings(replacementText), artifact: {
          name: 'replacement.srt', format: 'srt',
          bytes: new TextEncoder().encode(replacementText).buffer,
        } },
        getToken: fileId => makeTestToken(env.SYNC_SECRET_KEY, {
          projectId: 'p', fileId, role: 600,
        }),
        fetchImpl: async (url, init) => {
          const response = await fetchImpl(url, init)
          if (!lostResponse && init.method === 'POST'
            && JSON.parse(init.body).trackPublication && response.ok) {
            lostResponse = true
            await store.pg.query(`UPDATE files SET meta=jsonb_set(meta::jsonb,
              ARRAY['trackOverrides',$1,'name'], '"Later rename"') WHERE id='media'`,
            [uploaded.trackId])
            return new Response('Response lost after commit', { status: 503 })
          }
          return response
        },
      })
      expect(lostResponse).toBe(true)
      const currentFiles = await store.rows('files')
      const currentParent = currentFiles.find(file => file.id === 'media')
      expect(JSON.parse(currentParent.meta).trackOverrides[uploaded.trackId])
        .toMatchObject({ name: 'Later rename', contentFileId: replaced.fileId })
      const currentCells = await store.rows('cells')
      expect(currentCells.filter(cell => cell.file_id === uploaded.fileId)).toHaveLength(2)
      expect(currentCells.filter(cell => cell.file_id === 'media'))
        .toEqual([expect.objectContaining({ cell_id: 'original', value: 'Existing wording' })])
      expect(currentCells.filter(cell => cell.file_id === replaced.fileId))
        .toEqual([expect.objectContaining({ value: 'Reviewed replacement.',
          start_ms: 1000, end_ms: 2500 })])
      expect((await store.rows('events')).filter(event => event.kind === 'file.track.set'))
        .toHaveLength(2)
    } finally { await store.close() }
  }, 30_000)
})
