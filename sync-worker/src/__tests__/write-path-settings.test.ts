// AQU-1840: POST /events answers its authority questions from the `wp_*`
// generated columns (migration 0159), never from the multi-MB `settings` blob.
//
// The regression this pins is a performance one that only shows at scale, so it
// is pinned as a SHAPE: the statements the route sends. A reviewer who reverts
// the projection, or a later authority helper that reaches for the blob
// "just this once", turns this red. The behaviour the projection must not
// change (an archived lane still refuses a write, the validation threshold
// still applies) is covered where it already was — authorize.test.ts and
// authorize-timing-lock.test.ts, whose stubs now answer with the projected
// columns.

import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleEventsWriteRequest } from '../events/route'
import { makeRequestCache } from '../events/request-cache'
import { writePathSettingsFromRow, WRITE_PATH_COLUMN_LIST } from '../events/write-path-settings'
import { ROLE } from '../events/role-policy'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import { projectSettingsRow, writePathRow } from './helpers/project-settings-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'

/** A blob with a write-path key of every shape, plus bulk the projection drops. */
const SETTINGS = {
  archivedLanes: ['de'],
  timingLocked: false,
  allowTrackEditing: true,
  validationCount: 2,
  validationRoleFloor: 'reviewer',
  validationNamedUsers: ['ana'],
  allowSelfValidation: true,
  harmonize_min_role: 'maintainer',
  // Not projected: the keys that make the blob multi-MB in the first place.
  rules: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, text: 'x'.repeat(200) })),
}

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

/** Does this statement load the blob column out of project_settings? */
const readsBlob = (sql: string): boolean =>
  sql.includes('project_settings') && /\bsettings\b/.test(sql.replace(/project_settings/g, ''))

const readsProjection = (sql: string): boolean =>
  sql.includes('project_settings') && sql.includes('wp_archived_lanes')

describe('POST /events — the write path reads the projection, not the blob', () => {
  async function postCommit(): Promise<{ statements: string[]; accepted: number }> {
    const statements: string[] = []
    const td = (t = await makeTestDb(
      { files: [{ id: FILE, project_id: PROJECT, name: 'x' }] },
      { onStatement: (sql) => statements.push(sql) },
    ))
    await td.db
      .prepare(`INSERT INTO project_settings (project_id, settings, version) VALUES (?, ?, 1)`)
      .bind(PROJECT, JSON.stringify(SETTINGS))
      .run()
    statements.length = 0

    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: ROLE.CONTRIBUTOR })
    const res = await handleEventsWriteRequest(
      new Request('https://worker/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          events: [
            {
              id: 'evt-1',
              schemaVersion: 1,
              kind: 'target.cell.commit',
              projectId: PROJECT,
              fileId: FILE,
              cellId: 'cell-1',
              parentId: null,
              author: 'alice',
              payload: { value: 'hola' },
              clientTs: 1000,
            },
          ],
        }),
      }),
      { AQUILLA_PG: td.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { accepted: unknown[]; rejected: unknown[] }
    expect(body.rejected).toEqual([])
    return { statements, accepted: body.accepted.length }
  }

  it('answers the archived-lane check from the projected columns', async () => {
    const { statements, accepted } = await postCommit()
    expect(accepted).toBe(1)
    expect(statements.filter(readsProjection).length).toBe(1)
  })

  it('sends no statement that loads the settings blob', async () => {
    const { statements } = await postCommit()
    expect(statements.filter(readsBlob)).toEqual([])
  })
})

describe('writePathSettingsFromRow', () => {
  it('omits a column that is NULL — an absent key, or a JSON null', () => {
    const row = Object.fromEntries(WRITE_PATH_COLUMN_LIST.map((c) => [c, null]))
    expect(writePathSettingsFromRow(row)).toEqual({})
  })

  it('keeps the value the driver handed over, with no re-parsing', () => {
    // The whole lock turns on boolean false vs the STRING "false": re-parsing a
    // string to "recover" a JSONB document would unlock a locked timeline.
    expect(writePathSettingsFromRow({ wp_timing_locked: false })).toEqual({ timingLocked: false })
    expect(writePathSettingsFromRow({ wp_timing_locked: 'false' })).toEqual({ timingLocked: 'false' })
    expect(writePathSettingsFromRow({ wp_validation_count: 2 })).toEqual({ validationCount: 2 })
    expect(writePathSettingsFromRow({ wp_archived_lanes: ['de'] })).toEqual({ archivedLanes: ['de'] })
  })

  it('maps the snake_cased column back to its settings key', () => {
    expect(writePathSettingsFromRow({ wp_harmonize_min_role: 'maintainer' })).toEqual({
      harmonize_min_role: 'maintainer',
    })
    expect(writePathSettingsFromRow(writePathRow(JSON.stringify(SETTINGS))!)).toEqual({
      archivedLanes: ['de'],
      timingLocked: false,
      allowTrackEditing: true,
      validationCount: 2,
      validationRoleFloor: 'reviewer',
      validationNamedUsers: ['ana'],
      allowSelfValidation: true,
      harmonize_min_role: 'maintainer',
    })
  })
})

describe('a database without migration 0159', () => {
  /** Answers the blob read and errors on the projected one. */
  function blobOnlyDb(settings: string | null, opts: { blobFails?: boolean } = {}) {
    let blobReads = 0
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (!sql.includes('project_settings')) return null
                if (!sql.includes('wp_archived_lanes')) {
                  blobReads++
                  if (opts.blobFails) throw new Error('connection lost')
                }
                return projectSettingsRow(sql, settings, 'blob-only')
              },
              async all() {
                return { results: [] }
              },
            }
          },
        }
      },
    } as unknown as Parameters<typeof makeRequestCache>[0]
    return { db, reads: () => blobReads }
  }

  it('falls back to the blob and narrows it to the same keys', async () => {
    const { db } = blobOnlyDb(JSON.stringify(SETTINGS))
    const settings = await makeRequestCache(db).writePathSettings(PROJECT)
    expect(settings).toEqual({
      archivedLanes: ['de'],
      timingLocked: false,
      allowTrackEditing: true,
      validationCount: 2,
      validationRoleFloor: 'reviewer',
      validationNamedUsers: ['ana'],
      allowSelfValidation: true,
      harmonize_min_role: 'maintainer',
    })
  })

  it('memoizes the fallback too — one blob read per request, not one per event', async () => {
    const { db, reads } = blobOnlyDb(JSON.stringify(SETTINGS))
    const cache = makeRequestCache(db)
    await Promise.all([1, 2, 3].map(() => cache.writePathSettings(PROJECT)))
    await cache.writePathSettings(PROJECT)
    expect(reads()).toBe(1)
  })

  it('resolves null for a project with no settings row', async () => {
    const { db } = blobOnlyDb(null)
    expect(await makeRequestCache(db).writePathSettings(PROJECT)).toBeNull()
  })

  it('still REJECTS when the fallback read fails too', async () => {
    const { db } = blobOnlyDb(JSON.stringify(SETTINGS), { blobFails: true })
    await expect(makeRequestCache(db).writePathSettings(PROJECT)).rejects.toThrow('connection lost')
  })
})
