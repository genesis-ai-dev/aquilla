import { describe, it, expect, vi } from 'vitest'
import { bulkUploadSource, publishStagedImport } from '../../../src/lib/sync/bulk-import'
import { prepareYouTubeCaptionImport } from '../../../src/lib/import/youtube-captions'
import { uploadSourceOriginal } from '../../../src/lib/sync/source-upload'

vi.mock('../../../src/lib/sync/sync-worker-url', () => ({
  syncWorkerHttpOrigin: () => 'https://worker',
}))
vi.mock('../../../src/lib/sync/outbox', () => ({
  enqueueOutboxEvents: vi.fn(),
}))
vi.mock('../../../src/lib/sync/source-upload', () => ({
  assertSourceUploadSize: vi.fn(),
  uploadSourceOriginal: vi.fn(),
}))

import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const PROJECT_ID = 'proj-caption'
const FILE_ID = 'file-caption'
const makeEnv = (db) => ({ AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
const leadToken = () => makeTestToken(SECRET, {
  projectId: PROJECT_ID, fileId: FILE_ID, role: 500,
})

const exports = [
  ['srt', '1\n00:00:01,000 --> 00:00:02,000\nHello world\n'],
  ['vtt', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHello world\n'],
  ['sbv', '0:00:01.000,0:00:02.000\nHello world\n'],
]
const representations = exports.flatMap(([format, text]) =>
  [false, true].map(originalBytes => ({ format, text, originalBytes })),
)

describe('youtube caption publication producer/consumer contract', () => {
  it.each(representations)('publishes $format with originalBytes=$originalBytes', async ({ format, text, originalBytes }) => {
    vi.mocked(uploadSourceOriginal).mockClear()
    const token = await leadToken()
    const testDb = await makeTestDb()
    const { db, rows } = testDb
    const fetchImpl = async (input, init) => {
      const response = await handleBulkImportRequest(
        new Request(input, init), makeEnv(db),
      )
      if (!response) throw new Error('import route did not handle client request')
      return response
    }
    try {
      const expectedBytes = new TextEncoder().encode((originalBytes ? '\uFEFF' : '') + text)
      const prepared = prepareYouTubeCaptionImport({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        captionName: `test.${format}`,
        captionText: text,
        ...(originalBytes ? { rawBytes: expectedBytes.buffer } : {}),
      })
      const cells = prepared.strings.map((str) => ({
        id: `cell-${str.start}`,
        cellId: `cell-${str.start}`,
        anchorCellId: null,
        value: str.original,
        startMs: Math.round(str.start * 1000),
        endMs: Math.round(str.end * 1000),
      }))
      await bulkUploadSource({
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        file: {
          id: 'file-create-event',
          name: prepared.name,
          fileType: prepared.rawSourceFormat,
          orderedBy: 'time',
        },
        cells,
        rawSource: prepared.rawSource,
        rawSourceFormat: prepared.rawSourceFormat,
        rawBytes: prepared.rawBytes,
        deferPublication: true,
        getToken: async () => token,
        fetchImpl,
      })
      const publication = {
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        coreMediaUrl: prepared.videoUrl,
        publishEventId: "reveal-1", videoEventId: "picture-1",
        getToken: async () => token,
        fetchImpl,
      }
      await publishStagedImport(publication)
      await publishStagedImport(publication)
      const events = await rows("events")
      expect(events.filter(event => event.kind === "file.video.set"))
        .toMatchObject([{ id: publication.videoEventId }])
      expect(events.filter(event => event.kind === "file.restore"))
        .toMatchObject([{ id: publication.publishEventId }])
      const [file] = await rows('files')
      expect(file.deleted_at).toBeNull()
      const meta = JSON.parse(file.meta)
      expect(meta.coreMediaUrl).toBe(prepared.videoUrl)
      expect(meta.orderedBy).toBe('time')
      const cues = await rows('cells')
      expect(cues).toHaveLength(1)
      expect(cues[0].start_ms).toBe(1000)
      expect(cues[0].end_ms).toBe(2000)
      expect(cues[0].value).toBe('Hello world')
      const audioRows = await rows('cell_audio')
      expect(audioRows).toHaveLength(0)
      expect(uploadSourceOriginal).toHaveBeenCalledTimes(1)
      const original = vi.mocked(uploadSourceOriginal).mock.calls[0][0]
      expect(original).toMatchObject({ projectId: PROJECT_ID, fileId: FILE_ID, format })
      expect(new TextDecoder().decode(original.bytes)).toBe(text)
      expect(new Uint8Array(original.bytes)).toEqual(expectedBytes)
    } finally {
      await testDb.close()
    }
  })
})
