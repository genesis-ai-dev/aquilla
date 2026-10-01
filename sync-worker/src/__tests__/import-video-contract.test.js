// The browser producer and worker consumer run together here. Keeping this
// composition suite in JS lets each package retain its own TypeScript runtime
// libraries (DOM for the browser; Workers for the server).
import { describe, it, expect, vi } from 'vitest'
import { bulkUploadSource, publishStagedImport } from '../../../src/lib/sync/bulk-import'

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
const PROJECT_ID = 'proj-race'
const FILE_ID = 'file-race'
const makeEnv = (db) => ({ AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
const leadToken = () => makeTestToken(SECRET, {
  projectId: PROJECT_ID, fileId: FILE_ID, role: 500,
})

describe('video publication producer/consumer contract', () => {
  it('accepts the real client video publication and projects its picture', async () => {
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
      await bulkUploadSource({
        projectId: PROJECT_ID, fileId: FILE_ID,
        file: { id: 'client-video-create', name: 'clip.mp4', fileType: 'video', orderedBy: 'time' },
        cells: [{ id: 'client-cell-create', cellId: 'client-cell', anchorCellId: null, value: 'clip.mp4', medium: 'media' }],
        deferPublication: true, getToken: async () => token, fetchImpl,
      })
      await db.prepare(`INSERT INTO artifacts (
        id, project_id, uploaded_by_user_id, name, content_type,
        size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
      ) VALUES (?::uuid, ?, '1', 'clip.mp4', 'video/mp4', 4, ?, ?, ?, 'audio', 'clip.mp4', '{}'::jsonb)`)
        .bind('01900000-0000-7000-8000-000000000102', PROJECT_ID,
          'a'.repeat(64), 'clip.mp4', FILE_ID).run()
      await publishStagedImport({
        projectId: PROJECT_ID, fileId: FILE_ID,
        coreMediaUrl: 'frontier-audio://clip.mp4',
        attachments: [{ cellId: 'client-cell', audioId: 'clip.mp4',
          url: 'frontier-audio://clip.mp4', slot: 'recording', mimeType: 'video/mp4' }],
        getToken: async () => token, fetchImpl,
      })
      const [file] = await rows('files')
      expect(file.deleted_at).toBeNull()
      expect(JSON.parse(file.meta).coreMediaUrl).toBe('frontier-audio://clip.mp4')
      expect(await rows('cell_audio')).toHaveLength(1)
    } finally {
      await testDb.close()
    }
  })

})
