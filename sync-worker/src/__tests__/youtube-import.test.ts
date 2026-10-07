// Tests for handleBulkImportRequest (POST /import) — source-caption staged import with video.
//
// Focus: staged imports with video metadata. The file is created tombstoned,
// cells are staged, and the finalize applies file.restore with video attachment.
// Video URLs are validated; invalid URLs and missing publishEventId return 400
// and keep the file deleted with no file.video.set event.

import { describe, it, expect, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn(),
}))

import { handleEventsWriteRequest } from '../events/route'

import { handleBulkImportRequest } from '../events/import-route'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'

type FileRow = { deleted_at: number | null; meta: string }
type CellRow = { cell_id: string; value: string }
type EventRow = { kind: string; server_seq: number }

const SECRET = 'test-secret'
const PROJECT_ID = 'p1'
const FILE_ID = 'f1'

async function leadToken(): Promise<string> {
  return makeTestToken(SECRET, {
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    role: 500,
  })
}

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

async function stageFile(db: AquillaDb, token: string) {
  const stageReq = new Request('https://worker/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      fileId: FILE_ID,
      file: {
        id: 'file-create-evt',
        name: 'captions.srt',
        fileType: 'srt',
      },
      stageEventId: 'stage-evt-1',
      cells: [
        {
          id: 'cue1',
          cellId: 'cue1',
          value: 'Hello world',
          startMs: 0,
          endMs: 5000,
        },
      ],
    }),
  })
  return handleBulkImportRequest(stageReq, makeEnv(db))
}

async function finalizeWithVideo(
  db: AquillaDb,
  token: string,
  coreMediaUrl: string,
  publishEventId?: string,
) {
  const body = {
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    cells: [],
    complete: true,
    ...(publishEventId !== undefined ? { publishEventId } : {}),
    video: {
      id: 'picture',
      coreMediaUrl,
    },
  }
  const finalReq = new Request('https://worker/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return handleBulkImportRequest(finalReq, makeEnv(db))
}

describe('POST /import — source-caption staged import with video', () => {
  it.each([
    { video: null, name: 'null video' },
    { video: {}, name: 'empty object video' },
    { video: [], name: 'array video' },
    { video: { id: 'picture', coreMediaUrl: 'frontier-audio://missing.mp4' }, name: 'unowned uploaded clip' },
    { video: { id: 'picture', coreMediaUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      name: 'mixed picture and text track', mixed: true },
  ])('rejects invalid video input $name with 400 and keeps file deleted', async ({ video, mixed }) => {
    const token = await leadToken()
    const { db, rows, close } = await makeTestDb()
    try {
      const stageRes = await stageFile(db, token)
      expect(stageRes?.status).toBe(200)

      const body = {
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        cells: [],
        complete: true,
        publishEventId: 'reveal',
        video,
        ...(mixed ? { trackPublication: { contentFileId: 'staged-captions',
          trackId: 'source-subtitles', eventId: 'binding', name: 'Mixed' } } : {}),
      }
      const finalReq = new Request('https://worker/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const response = await handleBulkImportRequest(finalReq, makeEnv(db))
      expect(response?.status).toBe(400)

      const files = await rows<FileRow>('files')
      expect(files[0].deleted_at).not.toBeNull()

      const events = await rows<EventRow>('events')
      const videoSetEvents = events.filter((e) => e.kind === 'file.video.set')
      expect(videoSetEvents).toHaveLength(0)
    } finally {
      await close()
    }
  })
  it('creates staged file with timed cue, then reveals with valid video URL', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()
    try {
      const stageRes = await stageFile(db, token)
      expect(stageRes?.status).toBe(200)

      const filesAfterStage = await rows<FileRow>('files')
      expect(filesAfterStage).toHaveLength(1)
      expect(filesAfterStage[0].deleted_at).not.toBeNull()

      const cellsAfterStage = await rows<CellRow>('cells')
      expect(cellsAfterStage).toHaveLength(1)
      expect(cellsAfterStage[0].cell_id).toBe('cue1')
      expect(cellsAfterStage[0].value).toBe('Hello world')

      const finalRes = await finalizeWithVideo(
        db,
        token,
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'reveal',
      )
      expect(finalRes?.status).toBe(200)

      const filesAfterFinal = await rows<FileRow>('files')
      expect(filesAfterFinal[0].deleted_at).toBeNull()

      const fileMeta = typeof filesAfterFinal[0].meta === 'string'
        ? JSON.parse(filesAfterFinal[0].meta)
        : filesAfterFinal[0].meta
      expect(fileMeta.coreMediaUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')

      const events = await rows<EventRow>('events')
      const videoSetEvent = events.find((e) => e.kind === 'file.video.set')
      const restoreEvent = events.find((e) => e.kind === 'file.restore')
      expect(videoSetEvent).toBeDefined()
      expect(restoreEvent).toBeDefined()
      expect(videoSetEvent!.server_seq).toBeLessThan(restoreEvent!.server_seq)
    } finally {
      await db.close()
    }
  })

  it('idempotent finalize with same video does not duplicate picture events', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()
    try {
      await stageFile(db, token)

      const finalRes1 = await finalizeWithVideo(
        db,
        token,
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'reveal',
      )
      expect(finalRes1?.status).toBe(200)

      const eventsAfterFirst = await rows<EventRow>('events')
      const videoSetCount1 = eventsAfterFirst.filter((e) => e.kind === 'file.video.set').length
      expect(videoSetCount1).toBe(1)

      const finalRes2 = await finalizeWithVideo(
        db,
        token,
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'reveal',
      )
      expect(finalRes2?.status).toBe(200)

      const eventsAfterSecond = await rows<EventRow>('events')
      const videoSetCount2 = eventsAfterSecond.filter((e) => e.kind === 'file.video.set').length
      expect(videoSetCount2).toBe(1)
    } finally {
      await db.close()
    }
  })

  describe('invalid video URL cases', () => {
    const invalidCases = [
      { url: 'https://example.com/video', name: 'non-YouTube domain' },
      { url: 'https://www.youtube.com/watch?v=bad', name: 'invalid YouTube id' },
    ]

    invalidCases.forEach(({ url, name }) => {
      it(`rejects ${name} with 400`, async () => {
        const token = await leadToken()
        const { db, rows } = await makeTestDb()
        try {
          await stageFile(db, token)

          const finalRes = await finalizeWithVideo(db, token, url, 'reveal')
          expect(finalRes?.status).toBe(400)

          const files = await rows<FileRow>('files')
          expect(files[0].deleted_at).not.toBeNull()

          const events = await rows<EventRow>('events')
          const videoSetEvent = events.find((e) => e.kind === 'file.video.set')
          expect(videoSetEvent).toBeUndefined()
        } finally {
          await db.close()
        }
      })
    })
  })

  it('rejects finalize missing publishEventId with 400', async () => {
    const token = await leadToken()
    const { db, rows } = await makeTestDb()
    try {
      await stageFile(db, token)

      const finalRes = await finalizeWithVideo(
        db,
        token,
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      )
      expect(finalRes?.status).toBe(400)

      const files = await rows<FileRow>('files')
      expect(files[0].deleted_at).not.toBeNull()

      const events = await rows<EventRow>('events')
      const videoSetEvent = events.find((e) => e.kind === 'file.video.set')
      expect(videoSetEvent).toBeUndefined()
    } finally {
      await db.close()
    }
  })
it('retrying import publication after a later user picture edit must preserve the later edit', async () => {
  const token = await leadToken()
  const { db, rows } = await makeTestDb()
  try {
    const stageRes = await stageFile(db, token)
    expect(stageRes?.status).toBe(200)

    const finalRes1 = await finalizeWithVideo(
      db,
      token,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'reveal',
    )
    expect(finalRes1?.status).toBe(200)

    const filesAfterFirst = await rows<FileRow>('files')
    const firstMeta = typeof filesAfterFirst[0].meta === 'string'
      ? JSON.parse(filesAfterFirst[0].meta)
      : filesAfterFirst[0].meta
    expect(firstMeta.coreMediaUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    // Simulate a later user picture edit
    const laterPictureReq = new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            id: 'later-picture',
            schemaVersion: 1,
            kind: 'file.video.set',
            projectId: PROJECT_ID,
            fileId: FILE_ID,
            cellId: null,
            parentId: 'picture',
            author: 'alice',
            payload: { coreMediaUrl: 'https://www.youtube.com/watch?v=abcdefghijk' },
            clientTs: 2000,
          },
        ],
      }),
    })
    const laterRes = await handleEventsWriteRequest(laterPictureReq, makeEnv(db))
    expect(laterRes?.status).toBe(200)
    const laterBody = await laterRes!.json() as { rejected?: unknown[] }
    expect(laterBody.rejected).toEqual([])

    const filesAfterLater = await rows<FileRow>('files')
    const laterMeta = typeof filesAfterLater[0].meta === 'string'
      ? JSON.parse(filesAfterLater[0].meta)
      : filesAfterLater[0].meta
    expect(laterMeta.coreMediaUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk')

    // Retry the original finalize
    const finalRes2 = await finalizeWithVideo(
      db,
      token,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'reveal',
    )
    expect(finalRes2?.status).toBe(200)

    const filesAfterRetry = await rows<FileRow>('files')
    const retryMeta = typeof filesAfterRetry[0].meta === 'string'
      ? JSON.parse(filesAfterRetry[0].meta)
      : filesAfterRetry[0].meta
    expect(retryMeta.coreMediaUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk')
  } finally {
    await db.close()
  }
})

it('retry after later explicit file deletion does not restore the file', async () => {
  const token = await leadToken()
  const { db, rows } = await makeTestDb()
  try {
    const stageRes = await stageFile(db, token)
    expect(stageRes?.status).toBe(200)

    const finalRes1 = await finalizeWithVideo(
      db,
      token,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'reveal',
    )
    expect(finalRes1?.status).toBe(200)

    const filesAfterFirst = await rows<FileRow>('files')
    const deletedAtBefore = filesAfterFirst[0].deleted_at
    expect(deletedAtBefore).toBeNull()

    const deleteReq = new Request('https://worker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            id: 'later-delete',
            schemaVersion: 1,
            kind: 'file.delete',
            projectId: PROJECT_ID,
            fileId: FILE_ID,
            cellId: null,
            parentId: 'picture',
            author: 'alice',
            payload: {},
            clientTs: 3000,
          },
        ],
      }),
    })
    const deleteRes = await handleEventsWriteRequest(deleteReq, makeEnv(db))
    expect(deleteRes?.status).toBe(200)
    const deleteBody = await deleteRes!.json() as { rejected?: unknown[] }
    expect(deleteBody.rejected).toEqual([])

    const filesAfterDelete = await rows<FileRow>('files')
    const deletedAtAfter = filesAfterDelete[0].deleted_at
    expect(deletedAtAfter).not.toBeNull()

    const finalRes2 = await finalizeWithVideo(
      db,
      token,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'reveal',
    )
    expect(finalRes2?.status).toBe(200)

    const filesAfterRetry = await rows<FileRow>('files')
    expect(filesAfterRetry[0].deleted_at).toBe(deletedAtAfter)
  } finally {
    await db.close()
  }
})

})
