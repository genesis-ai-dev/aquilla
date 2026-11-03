// AQU-2327, item 30: a version saved from the Station records what changed and
// the lines it went on, on its `cell.audio.attach` (`versionChanges`). The
// event log keeps it for the Station's History ("Version 2 saved: a part
// deleted · used on line 331"); the projection ignores it.
import { describe, it, expect } from 'vitest'
import { authorize } from '../events/authorize'
import { dispatchEvent } from '../events/dispatch'
import { buildEventProjectionStmts, type PersistedEvent } from '../events/event-projection'
import type { EventPayloads, RawEvent } from '../events/types'
import { makeTestToken } from './helpers/auth'

const SECRET = 'test-secret'
const ATTACH: EventPayloads['cell.audio.attach'] = {
  audioId: 'audio-c331-v2.wav',
  url: 'frontier-audio://audio-c331-v2.wav',
  slot: 'recording',
  referenceAudioId: 'audio-c331-t2.wav',
  label: 'Take 2',
}
const CHANGES = { kinds: ['deleted' as const, 'inserted' as const], usedOn: ['c331', 'c316'] }

function recordingDb() {
  const recorded: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
          return this
        },
        async first() { return null },
        async all() { return { results: [], success: true, meta: {} } },
        async run() { return { success: true, meta: {} } },
      }
      return stmt as unknown as AquillaStatement
    },
    async batch(ss: AquillaStatement[]) { return ss.map(() => ({ success: true, results: [], meta: {} })) },
  } as unknown as AquillaDb
  return { db, recorded }
}

function persisted(payload: EventPayloads['cell.audio.attach']): PersistedEvent<'cell.audio.attach'> {
  return {
    id: 'evt-1', schemaVersion: 1, projectId: 'proj-a', fileId: 'file-x', cellId: 'c331', parentId: null,
    kind: 'cell.audio.attach', author: 'ana', payload, clientTs: 1000, serverTs: 2000, serverSeq: 9,
  } as PersistedEvent<'cell.audio.attach'>
}

describe('cell.audio.attach with versionChanges', () => {
  it('projects exactly as an attach without them: the details are for History only', () => {
    const plain = recordingDb()
    const withChanges = recordingDb()
    buildEventProjectionStmts(plain.db, persisted(ATTACH), [])
    buildEventProjectionStmts(withChanges.db, persisted({ ...ATTACH, versionChanges: CHANGES }), [])
    expect(withChanges.recorded).toEqual(plain.recorded)
  })

  it('is accepted, and the event log keeps the details for History to read back', async () => {
    const raw = {
      id: 'evt-00000000-0000-7000-0000-000000000009',
      schemaVersion: 1,
      kind: 'cell.audio.attach',
      projectId: 'proj-a',
      fileId: 'file-x',
      cellId: 'c331',
      parentId: null,
      author: 'ana',
      payload: { ...ATTACH, versionChanges: CHANGES },
      clientTs: 1000,
    } as unknown as RawEvent<'cell.audio.attach'>
    const token = await makeTestToken(SECRET, { projectId: 'proj-a', fileId: 'file-x', role: 400 })
    const auth = await authorize(token, raw, SECRET)
    expect(auth.ok).toBe(true)
    if (!auth.ok) throw new Error('unreachable')
    const { db, recorded } = recordingDb()
    const outcome = dispatchEvent(db, auth.event, 9999, { serverSeq: 1, updateProjection: true })
    expect(outcome.ok).toBe(true)
    const insert = recorded.find((r) => /^INSERT INTO events/i.test(r.sql))
    expect(insert).toBeDefined()
    const payloadJson = insert!.args.find((a) => typeof a === 'string' && a.includes('versionChanges')) as string
    expect(JSON.parse(payloadJson).versionChanges).toEqual(CHANGES)
  })
})
