import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authorize } from '../events/authorize'
import { makeTestToken } from './helpers/auth'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { RawEvent } from '../events/types'

const SECRET = 'track-content-test-secret'
let testDb: TestDb

beforeAll(async () => {
  testDb = await makeTestDb({
    project_settings: [{ project_id: 'proj-a', settings: JSON.stringify({ allowTrackEditing: true }) }],
    files: [
      { id: 'file-x', project_id: 'proj-a', role: 'source' },
      { id: 'valid', project_id: 'proj-a', role: 'timeline-content', anchor_file_id: 'file-x' },
      { id: 'other-project', project_id: 'proj-b', role: 'timeline-content', anchor_file_id: 'file-x' },
      { id: 'other-timeline', project_id: 'proj-a', role: 'timeline-content', anchor_file_id: 'file-y' },
      { id: 'unanchored', project_id: 'proj-a', role: 'timeline-content' },
      { id: 'ordinary', project_id: 'proj-a', role: 'source', anchor_file_id: 'file-x' },
      { id: 'deleted', project_id: 'proj-a', role: 'timeline-content', anchor_file_id: 'file-x', deleted_at: 1 },
    ],
  })
})
afterAll(async () => { await testDb?.close() })

function event(contentFileId: string): RawEvent<'file.track.set'> {
  return {
    id: 'track-binding-event', schemaVersion: 1, kind: 'file.track.set',
    projectId: 'proj-a', fileId: 'file-x', parentId: null, author: 'alice',
    clientTs: 1,
    payload: { trackId: 'captions', patch: { kind: 'source-subtitles', contentFileId } },
  }
}

describe('text track content ownership', () => {
  it('accepts a live cue file anchored to this timeline', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: 600 })
    expect((await authorize(token, event('valid'), SECRET, testDb.db)).ok).toBe(true)
  })

  it.each(['other-project', 'other-timeline', 'unanchored', 'ordinary', 'deleted', 'missing'])(
    'refuses an unrelated or unavailable content file: %s', async contentFileId => {
      const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: 600 })
      const result = await authorize(token, event(contentFileId), SECRET, testDb.db)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Unrelated content must not be accepted')
      expect(result.status).toBe(403)
    },
  )

  it('fails closed without the database needed to verify ownership', async () => {
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: 600 })
    expect((await authorize(token, event('valid'), SECRET)).ok).toBe(false)
  })
})
