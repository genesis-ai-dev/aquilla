import { describe, expect, it } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
} from '../events/progress-projection'
import {
  handleProgressReadRequest,
  type FileProgressResponse,
  type SectionProgressDetailResponse,
} from '../events/progress-read-route'

const SECRET = 'progress-secret'
const PROJECT = 'project-progress'
const FILE = 'file-progress'

function source(cellId: string, canonicalRef: string) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
    value: `source ${cellId}`, canonical_ref: canonicalRef, event_id: `source-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
  }
}

function target(cellId: string, value: string, endorsements: number) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'target',
    value, canonical_ref: null, event_id: `target-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: endorsements >= 2 ? 1 : 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
  }
}

async function fixture() {
  return makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
    project_settings: [{
      project_id: PROJECT,
      settings: JSON.stringify({ validationCount: 2 }),
      version: 1,
    }],
    events: [{
      id: 'event-7', schema_version: 1, project_id: PROJECT, file_id: FILE,
      cell_id: 'c3', parent_id: null, kind: 'target.cell.commit', author: 'alice',
      payload: '{}', client_ts: 7, server_ts: 7, server_seq: 7,
    }],
    cells: [
      source('c1', 'GEN 1:1'), target('c1', 'uno', 2),
      source('c2', 'GEN 1:2'), target('c2', '', 0),
      source('c3', 'GEN 2:1'), target('c3', 'tres', 1),
      // Target-only rows preserve the old section denominator semantics: ignored.
      target('target-only', 'ignored', 15),
    ],
  })
}

describe('file_section_progress projection', () => {
  it('stores one file row and one compact histogram per canonical section', async () => {
    const { db, rows } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))

    const projected = await rows<{
      scope: string
      section_key: string
      total_count: number
      filled_count: number
      validator_histogram: Record<string, number>
      revision: number
    }>('file_section_progress')
    expect(projected).toHaveLength(3)
    expect(projected.find((row) => row.scope === 'file')).toMatchObject({
      total_count: 3,
      filled_count: 2,
      revision: 7,
    })
    expect(projected.find((row) => row.section_key === 'GEN 1')).toMatchObject({
      total_count: 2,
      filled_count: 1,
      validator_histogram: { 0: 1, 2: 1 },
    })
  })

  it('recomputes only a touched target section plus the file rollup', async () => {
    const { db, pg, rows } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    await pg.query(
      `UPDATE cells SET value = 'dos', endorsement_count = 2
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'c2' AND side = 'target'`,
      [PROJECT, FILE],
    )
    await db.batch([
      fileProgressRecomputeStmt(db, PROJECT, FILE, 101),
      sectionsProgressRecomputeStmt(db, PROJECT, FILE, 101, ['c2']),
    ])
    const projected = await rows<{ scope: string; section_key: string; filled_count: number }>('file_section_progress')
    expect(projected.find((row) => row.scope === 'file')?.filled_count).toBe(3)
    expect(projected.find((row) => row.section_key === 'GEN 1')?.filled_count).toBe(2)
    expect(projected.find((row) => row.section_key === 'GEN 2')?.filled_count).toBe(1)
  })

  it('full rebuild removes section rows that no longer exist', async () => {
    const { db, pg, rows } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    expect(await rows('file_section_progress')).toHaveLength(3)

    await pg.query(
      `UPDATE cells SET canonical_ref = NULL
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'c3' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 101))

    const projected = await rows<{ scope: string; section_key: string }>('file_section_progress')
    expect(projected).toHaveLength(2)
    expect(projected.some((row) => row.section_key === 'GEN 2')).toBe(false)
    expect(projected.some((row) => row.scope === 'file')).toBe(true)
  })
})

describe('GET file progress', () => {
  it('returns sorted sections, threshold-derived levels, and honors ETags', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`
    const response = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(200)
    expect(response.headers.get('ETag')).toBe('"progress:file-progress:7:v2:p"')
    const body = await response.json() as FileProgressResponse
    expect(body.file).toMatchObject({ totalCount: 3, filledCount: 2, validatedCount: 1 })
    expect(body.sections.map((section) => section.key)).toEqual(['GEN 1', 'GEN 2'])
    expect(body.sections[0].validationLevels).toEqual([1, 1])

    const conditional = (await handleProgressReadRequest(new Request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': response.headers.get('ETag')!,
      },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(conditional.status).toBe(304)
  })

  it('rejects a token scoped to another project', async () => {
    const { db } = await fixture()
    const token = await makeTestToken(SECRET, { projectId: 'other', fileId: FILE })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(403)
  })

  it('invalidates a cached fallback when backfill rows appear at the same revision', async () => {
    const { db } = await fixture()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`
    const fallback = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(fallback.headers.get('ETag')).toBe('"progress:file-progress:7:v2:f"')
    expect((await fallback.json() as FileProgressResponse).source).toBe('file-counter-fallback')

    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const projected = (await handleProgressReadRequest(new Request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': '"progress:file-progress:7:v2:f"',
      },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(projected.status).toBe(200)
    expect(projected.headers.get('ETag')).toBe('"progress:file-progress:7:v2:p"')
    expect((await projected.json() as FileProgressResponse).sections).toHaveLength(2)
  })

  it('returns compact verse state only when a chapter is explicitly requested', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress/sections/${encodeURIComponent('GEN 1')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(200)
    const body = await response.json() as SectionProgressDetailResponse
    expect(body.verses).toEqual([
      { ref: 'GEN 1:1', filled: true, validated: true },
      { ref: 'GEN 1:2', filled: false, validated: false },
    ])
    expect(JSON.stringify(body)).not.toContain('source c1')
    expect(JSON.stringify(body)).not.toContain('cellId')
  })
})

// AQU-805: media / timeline files carry start_ms but no canonical_ref. The
// projection buckets them into ~5-minute time sections so the project-overview
// file breakdown mirrors the in-app jump navigation instead of showing a flat
// cell count only.
const MEDIA_FILE = 'file-media'

function mediaSource(cellId: string, startMs: number) {
  return {
    project_id: PROJECT, file_id: MEDIA_FILE, cell_id: cellId, side: 'source',
    value: `source ${cellId}`, canonical_ref: null, start_ms: startMs,
    event_id: `source-${cellId}`, last_editor: 'alice', last_edit_at: 1,
    validated: 0, endorsement_count: 0, word_count: 2,
  }
}

function mediaTarget(cellId: string, value: string, endorsements: number) {
  return {
    project_id: PROJECT, file_id: MEDIA_FILE, cell_id: cellId, side: 'target',
    value, canonical_ref: null, event_id: `target-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: endorsements >= 2 ? 1 : 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
  }
}

async function mediaFixture() {
  return makeTestDb({
    files: [{ id: MEDIA_FILE, project_id: PROJECT, name: 'Episode', event_id: 'file-event-media' }],
    project_settings: [{
      project_id: PROJECT,
      settings: JSON.stringify({ validationCount: 2 }),
      version: 1,
    }],
    cells: [
      // Two cells inside the first 5-minute bucket, one filled+validated.
      mediaSource('m1', 0), mediaTarget('m1', 'uno', 2),
      mediaSource('m2', 60_000), mediaTarget('m2', '', 0),
      // 10-minute bucket, filled but not yet validated.
      mediaSource('m3', 600_000), mediaTarget('m3', 'tres', 1),
      // 20-minute bucket — proves the zero-padded key sorts past "10".
      mediaSource('m4', 1_200_000), mediaTarget('m4', '', 0),
    ],
  })
}

describe('file_section_progress time buckets (AQU-805)', () => {
  it('groups media source cells into 5-minute time sections', async () => {
    const { db, rows } = await mediaFixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, MEDIA_FILE, 100))

    const projected = await rows<{ scope: string; section_key: string; total_count: number; filled_count: number }>(
      'file_section_progress',
    )
    const sections = projected.filter((row) => row.scope === 'section')
    // Buckets: 0ms (m1,m2), 600000ms (m3), 1200000ms (m4).
    expect(sections.map((row) => row.section_key).sort()).toEqual([
      't:000000000000',
      't:000000600000',
      't:000001200000',
    ])
    expect(sections.find((row) => row.section_key === 't:000000000000')).toMatchObject({
      total_count: 2,
      filled_count: 1,
    })
    expect(projected.find((row) => row.scope === 'file')).toMatchObject({ total_count: 4, filled_count: 2 })
  })

  it('recomputes only the touched time section plus the file rollup', async () => {
    const { db, pg, rows } = await mediaFixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, MEDIA_FILE, 100))
    await pg.query(
      `UPDATE cells SET value = 'cuatro' WHERE project_id = $1 AND file_id = $2 AND cell_id = 'm4' AND side = 'target'`,
      [PROJECT, MEDIA_FILE],
    )
    await db.batch([
      fileProgressRecomputeStmt(db, PROJECT, MEDIA_FILE, 101),
      sectionsProgressRecomputeStmt(db, PROJECT, MEDIA_FILE, 101, ['m4']),
    ])
    const projected = await rows<{ scope: string; section_key: string; filled_count: number }>('file_section_progress')
    expect(projected.find((row) => row.section_key === 't:000001200000')?.filled_count).toBe(1)
    expect(projected.find((row) => row.scope === 'file')?.filled_count).toBe(3)
  })

  it('serves time sections sorted in chronological (not lexical-broken) order', async () => {
    const { db } = await mediaFixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, MEDIA_FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: MEDIA_FILE })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${PROJECT}/files/${MEDIA_FILE}/progress`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(200)
    const body = await response.json() as FileProgressResponse
    // 10-minute bucket must precede the 20-minute bucket despite the "10 < 5"
    // lexical trap the zero-padding is there to avoid.
    expect(body.sections.map((section) => section.key)).toEqual([
      't:000000000000',
      't:000000600000',
      't:000001200000',
    ])
  })
})
