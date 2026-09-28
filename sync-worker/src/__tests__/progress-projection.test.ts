import { describe, expect, it } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import { makeTestToken } from './helpers/auth'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
} from '../events/progress-projection'
import {
  counts,
  handleProgressReadRequest,
  type FileProgressResponse,
  type SectionProgressDetailResponse, readFirstOpenCell
} from '../events/progress-read-route'

const SECRET = 'progress-secret'
const PROJECT = 'project-progress'
const FILE = 'file-progress'

function source(cellId: string, canonicalRef: string, type: string | null = 'verse') {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source', type,
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
    // file + GEN 1 + GEN 2 + the AQU-1093 book row for GEN.
    expect(projected).toHaveLength(4)
    expect(projected.find((row) => row.scope === 'file')).toMatchObject({
      total_count: 3,
      filled_count: 2,
      revision: 7,
    })
    // The book row sums its chapters: GEN 1 (2 cells) + GEN 2 (1).
    expect(projected.find((row) => row.scope === 'book')).toMatchObject({
      section_key: 'GEN',
      total_count: 3,
      filled_count: 2,
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
    expect(await rows('file_section_progress')).toHaveLength(4)

    await pg.query(
      `UPDATE cells SET canonical_ref = NULL
        WHERE project_id = $1 AND file_id = $2 AND cell_id = 'c3' AND side = 'source'`,
      [PROJECT, FILE],
    )
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 101))

    // GEN 2 goes; the GEN book row survives because GEN 1 still has verses.
    const projected = await rows<{ scope: string; section_key: string }>('file_section_progress')
    expect(projected).toHaveLength(3)
    expect(projected.some((row) => row.section_key === 'GEN 2')).toBe(false)
    expect(projected.some((row) => row.scope === 'file')).toBe(true)
    expect(projected.some((row) => row.scope === 'book' && row.section_key === 'GEN')).toBe(true)
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
    expect(response.headers.get('ETag')).toBe('"progress:file-progress:7:u100:v2:va1:p:s4"')
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

  it('carries per-chapter audio counts, so the inspector need not fetch twice', async () => {
    // AQU-1098: the projection has written audio_count since 0088, but this
    // route never selected it, so a chapter list could only ever show text.
    const { db, pg } = await fixture()
    await pg.query(
      `INSERT INTO cell_audio
         (project_id, file_id, cell_id, audio_id, slot, url, event_id, created_ts,
          selected, deleted, validator_count, duration_ms)
       VALUES ($1,$2,'c1','a1','take','u1','e1',1, 1,0,1,1000),
              ($1,$2,'c3','a2','take','u2','e2',1, 1,0,0,1000)`,
      [PROJECT, FILE],
    )
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    const body = await response.json() as FileProgressResponse
    expect(body.file).toMatchObject({ audioCount: 2, audioValidatedCount: 1 })
    const gen1 = body.sections.find((section) => section.key === 'GEN 1')!
    const gen2 = body.sections.find((section) => section.key === 'GEN 2')!
    // GEN 1 holds the validated take, GEN 2 the unvalidated one.
    expect(gen1).toMatchObject({ audioCount: 1, audioValidatedCount: 1 })
    expect(gen2).toMatchObject({ audioCount: 1, audioValidatedCount: 0 })
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

  // AQU-490, found on the live board: a chapter grid read 0 recorded and 0
  // validated for a whole book whose rows were correct in the database. The
  // client cache behind that grid is DURABLE and per account, so a false 304
  // is not a stale second — it lasts until someone clears IndexedDB. Every
  // recompute that fills in a column without emitting an event looks like
  // this: a rebuild, a rollout backfill, a manual repair.
  it('busts the cache when a backfill rewrites the rows without moving the revision', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`
    const read = async (ifNoneMatch?: string) => (await handleProgressReadRequest(new Request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
      },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!

    const first = await read()
    const cached = first.headers.get('ETag')!
    // Nothing has changed: the cache is honoured, which is the whole point of
    // the key and must keep working.
    expect((await read(cached)).status).toBe(304)

    // The backfill. No event is written, so `revision` cannot move — only the
    // projection's own clock does.
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 20_000))
    const after = await read(cached)
    expect(after.status).toBe(200)
    expect(after.headers.get('ETag')).not.toBe(cached)
    expect(after.headers.get('ETag')).toContain(':u20000:')
    // And the revision really did stay put — otherwise this test would pass
    // for the wrong reason and prove nothing about the clock.
    expect(cached).toContain(':7:')
    expect(after.headers.get('ETag')).toContain(':7:')
  })

  it('invalidates a cached fallback when backfill rows appear at the same revision', async () => {
    const { db } = await fixture()
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress`
    const fallback = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(fallback.headers.get('ETag')).toBe('"progress:file-progress:7:u0:v2:va1:f:s4"')
    expect((await fallback.json() as FileProgressResponse).source).toBe('file-counter-fallback')

    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const projected = (await handleProgressReadRequest(new Request(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'If-None-Match': '"progress:file-progress:7:u0:v2:va1:f:s4"',
      },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(projected.status).toBe(200)
    expect(projected.headers.get('ETag')).toBe('"progress:file-progress:7:u100:v2:va1:p:s4"')
    expect((await projected.json() as FileProgressResponse).sections).toHaveLength(2)
  })

  it('returns compact verse state, with the cell id, only when a chapter is explicitly requested', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress/sections/${encodeURIComponent('GEN 1')}`
    const response = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(200)
    const body = await response.json() as SectionProgressDetailResponse
    // AQU-1278 deliberately reversed this payload's old "and no cell ids" rule.
    // The plan board deep-links the editor at a unit's first outstanding cell
    // (?cellId=<id>), and this is the only endpoint that knows which cell that
    // is; without the id there is nothing to build the link out of. The id is
    // the SOURCE row's, so an untranslated verse has one too — c2 below has no
    // target text at all and still carries its id.
    expect(body.verses).toEqual([
      { cellId: 'c1', ref: 'GEN 1:1', filled: true, validated: true, recorded: false, audioValidated: false },
      { cellId: 'c2', ref: 'GEN 1:2', filled: false, validated: false, recorded: false, audioValidated: false },
    ])
    // What the payload must still never grow is cell CONTENT. A chapter is
    // fetched on demand while a reader browses the overview, and the whole
    // reason it is affordable is that a verse costs an id, a ref and two
    // booleans. Source or target text here would multiply that by the length of
    // a chapter, for a caller that only ever draws squares.
    expect(JSON.stringify(body)).not.toContain('source c1')
    expect(JSON.stringify(body)).not.toContain('uno')
  })

  it('does not honor a section ETag minted before verses carried cell ids', async () => {
    // The shape changed without the revision, the validation count, the policy
    // or the lane changing with it, so only the `s2` shape marker separates the
    // two bodies. Without it this request would 304 and the reader would keep a
    // cellId-less chapter — and a dead deep link — until something unrelated
    // moved the revision.
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, 100))
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const url = `https://worker/api/v1/projects/${PROJECT}/files/${FILE}/progress/sections/${encodeURIComponent('GEN 1')}`
    const fresh = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    const etag = fresh.headers.get('ETag')!
    expect(etag).toBe('"progress:file-progress:GEN%201:7:u100:v2:va1:s4"')

    const notHonoured = async (candidate: string) => (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}`, 'If-None-Match': candidate },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!.status

    // A client from before shape markers existed at all.
    expect(await notHonoured(etag.replace(':s4', ''))).toBe(200)
    // AQU-490: and one from the shape immediately before this, which is the
    // live case at deploy. `take_signed` kept its name and its type and
    // changed its question — nothing else in the key moves for that.
    expect(await notHonoured('"progress:file-progress:GEN%201:7:v2:s3"')).toBe(200)

    const current = (await handleProgressReadRequest(new Request(url, {
      headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(current.status).toBe(304)
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

// AQU-1083 — the structural subset, recorded alongside every existing number so
// a reader that excludes headings subtracts rather than reprojects.
describe('structural aggregates (AQU-1083)', () => {
  const P = 'proj-struct-prog'
  const F = 'file-struct-prog'

  const src = (cellId: string, ref: string, type: string | null) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'source', type,
    value: `s ${cellId}`, canonical_ref: ref, event_id: `s-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
  })
  const tgt = (cellId: string, value: string, endorsements: number) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'target', type: null,
    value, canonical_ref: null, event_id: `t-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: endorsements >= 2 ? 1 : 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
  })

  /** A live dub take. AQU-490: a SELECTED dub with at least one vote is what
      the projection calls validated, counted against the threshold on read. */
  const take = (cellId: string, validated: boolean) => ({
    project_id: P, file_id: F, cell_id: cellId, audio_id: `a-${cellId}`,
    slot: 'take', url: `local://${cellId}.webm`, selected: 1, deleted: 0,
    validator_count: validated ? 1 : 0, event_id: `au-${cellId}`, created_ts: 3,
  })

  /** GEN 1: two verses (one filled at 2 endorsements, one empty) plus a chapter
   *  heading and a book title — one filled at 3 endorsements, one empty.
   *
   *  Two of the four are RECORDED, one content and one structural, and the
   *  structural one is signed off while the content one is not — so every
   *  audio number below differs from every other and a subtraction that took
   *  the wrong column could not pass by coincidence. */
  async function fixture() {
    return makeTestDb({
      files: [{ id: F, project_id: P, name: 'GEN', event_id: 'f-evt' }],
      cells: [
        src('v1', 'GEN 1:1', 'verse'), tgt('v1', 'uno', 2),
        src('v2', 'GEN 1:2', 'verse'), tgt('v2', '', 0),
        src('h1', 'GEN 1:h:1', 'heading'), tgt('h1', 'titulo', 3),
        src('h2', 'GEN 1:h:2', 'paratext'), tgt('h2', '', 0),
      ],
      cell_audio: [take('v1', false), take('h1', true)],
    })
  }

  const read = async (db: AquillaDb, scope: string) =>
    db.prepare(
      `SELECT total_count, filled_count, validator_histogram,
              structural_count, structural_filled_count, structural_validator_histogram,
              audio_count, audio_validated_count,
              structural_audio_count, structural_audio_validated_count
         FROM file_section_progress
        WHERE project_id = ? AND file_id = ? AND scope = ? AND target_lang = ''`,
    ).bind(P, F, scope).first<Record<string, unknown>>()

  // The predicate that EXCLUDES structural cells on read is the negation of the
  // one that counts them, and the two do not behave alike on a null type. A
  // bare `NOT (type IN (...))` is NULL for a null type, and WHERE drops a NULL
  // row exactly as it drops a false one — so every untyped cell in the file
  // disappeared the moment a team turned headings off, and the chapter came
  // back EMPTY rather than merely short. `structuralPredicateSql` coalesces for
  // this reason; without it this test returns no verses at all.
  it('keeps untyped cells when the policy excludes structural ones', async () => {
    const { db } = await makeTestDb({
      files: [{ id: F, project_id: P, name: 'GEN', event_id: 'f-evt' }],
      cells: [
        // A spreadsheet import the classifier could not type: null, not 'verse'.
        src('u1', 'GEN 1:1', null), tgt('u1', 'uno', 0),
        src('h1', 'GEN 1:h:1', 'heading'), tgt('h1', 'titulo', 0),
      ],
      // The policy resolver drives FROM projects, so the project row is what
      // makes its settings reachable at all — a settings row alone is invisible.
      projects: [{ id: P, name: 'Struct', created_by: 1 }],
      project_settings: [{ project_id: P, settings: '{"countStructuralCells":false}' }],
    })
    await db.batch(fullProgressRecomputeStmts(db, P, F, 100))
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${P}/files/${F}/progress/sections/${encodeURIComponent('GEN 1')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(response.status).toBe(200)
    const body = await response.json() as SectionProgressDetailResponse
    expect(body.verses.map((v) => v.ref)).toEqual(['GEN 1:1'])
  })

  it('records the structural subset on the file rollup', async () => {
    const { db } = await fixture()
    await fileProgressRecomputeStmt(db, P, F, 10).run()
    const row = await read(db, 'file')
    // The totals still count everything — that is what makes the policy a
    // read-time subtraction rather than a reprojection.
    expect(Number(row?.total_count)).toBe(4)
    expect(Number(row?.filled_count)).toBe(2)
    expect(Number(row?.structural_count)).toBe(2)
    expect(Number(row?.structural_filled_count)).toBe(1)
  })

  it('keeps a structural histogram that subtracts from the real one bucket-wise', async () => {
    const { db } = await fixture()
    await fileProgressRecomputeStmt(db, P, F, 10).run()
    const row = await read(db, 'file')
    // Every cell: two empty at 0, one verse at 2, one heading at 3.
    expect(row?.validator_histogram).toEqual({ '0': 2, '2': 1, '3': 1 })
    // Structural only: one empty heading at 0, one filled title at 3.
    expect(row?.structural_validator_histogram).toEqual({ '0': 1, '3': 1 })
  })

  // AQU-1278. The text counters got a structural twin in 0092 and the audio
  // pair did not, so a policy that excluded headings shrank the denominator and
  // left the recordings alone — a book whose headings were voiced came back
  // with more audio than it had cells. These two record the missing share.
  it('records the structural share of the audio pair on the file rollup', async () => {
    const { db } = await fixture()
    await fileProgressRecomputeStmt(db, P, F, 10).run()
    const row = await read(db, 'file')
    // Raw totals still count every take, the same way total_count still counts
    // every cell: the policy is a subtraction on read, never a reprojection.
    expect(Number(row?.audio_count)).toBe(2)
    expect(Number(row?.audio_validated_count)).toBe(1)
    // …and the heading's take is recorded separately so a reader can drop it.
    expect(Number(row?.structural_audio_count)).toBe(1)
    expect(Number(row?.structural_audio_validated_count)).toBe(1)
  })

  it('records the structural audio share per section and per book', async () => {
    const { db } = await fixture()
    await sectionsProgressRecomputeStmt(db, P, F, 10).run()
    const scoped = async (scope: string, key: string) =>
      db.prepare(
        `SELECT audio_count, audio_validated_count,
                structural_audio_count, structural_audio_validated_count
           FROM file_section_progress
          WHERE project_id = ? AND scope = ? AND section_key = ? AND target_lang = ''`,
      ).bind(P, scope, key).first<Record<string, unknown>>()
    // The book branch is a POSITIONAL UNION arm with no column aliases, so it
    // is the one that silently shifts if the new columns land anywhere but the
    // tail of every branch. Asserting both scopes is what catches that.
    for (const row of [await scoped('section', 'GEN 1'), await scoped('book', 'GEN')]) {
      expect(Number(row?.audio_count)).toBe(2)
      expect(Number(row?.audio_validated_count)).toBe(1)
      expect(Number(row?.structural_audio_count)).toBe(1)
      expect(Number(row?.structural_audio_validated_count)).toBe(1)
    }
  })

  it('records it per section too', async () => {
    const { db } = await fixture()
    await sectionsProgressRecomputeStmt(db, P, F, 10).run()
    const row = await db.prepare(
      `SELECT structural_count, structural_filled_count, structural_validator_histogram
         FROM file_section_progress
        WHERE project_id = ? AND scope = 'section' AND section_key = 'GEN 1'`,
    ).bind(P).first<Record<string, unknown>>()
    // Heading refs split to the same chapter prefix as verses, so they land in
    // GEN 1's bucket — which is exactly why the chapter never read 100%.
    expect(Number(row?.structural_count)).toBe(2)
    expect(Number(row?.structural_filled_count)).toBe(1)
    expect(row?.structural_validator_histogram).toEqual({ '0': 1, '3': 1 })
  })

  it('agrees with the full rebuild', async () => {
    const { db } = await fixture()
    await fileProgressRecomputeStmt(db, P, F, 10).run()
    await sectionsProgressRecomputeStmt(db, P, F, 10).run()
    const incremental = await read(db, 'file')
    for (const stmt of fullProgressRecomputeStmts(db, P, F, 11)) await stmt.run()
    expect(await read(db, 'file')).toEqual({ ...incremental })
  })

  it('treats an untyped cell as content, not structure', async () => {
    // Media and cue imports write no type at all. A null-blind predicate would
    // count them as structural and quietly drop them from the denominator.
    const { db } = await makeTestDb({
      files: [{ id: F, project_id: P, name: 'AUDIO', event_id: 'f-evt' }],
      cells: [src('m1', 'CUE 1', null), tgt('m1', 'hola', 0)],
    })
    await fileProgressRecomputeStmt(db, P, F, 10).run()
    const row = await read(db, 'file')
    expect(Number(row?.total_count)).toBe(1)
    expect(Number(row?.structural_count)).toBe(0)
  })
})

// The projection above records the subset; this is the half that spends it —
// the same stored rows read once under each policy. Proved against a real
// imported Genesis (1540 cells, 7 of them USFM front matter) before it was
// written down here.
describe('GET file progress under the structural policy (AQU-1083)', () => {
  const P = 'proj-struct-read'
  const F = 'file-struct-read'

  const src = (cellId: string, ref: string, type: string | null) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'source', type,
    value: `s ${cellId}`, canonical_ref: ref, event_id: `s-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0, word_count: 2,
  })
  const tgt = (cellId: string, value: string) => ({
    project_id: P, file_id: F, cell_id: cellId, side: 'target', type: null,
    value, canonical_ref: null, event_id: `t-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: 0,
    endorsement_count: value ? 2 : 0, word_count: value ? 1 : 0,
  })

  /** A book shaped like the real thing: front matter in its own section, then
   *  one chapter of verses. The title is translated and no verse is. */
  async function fixture(countStructural: boolean | undefined) {
    const db = await makeTestDb({
      // Seeded in dependency order — org_settings is keyed to organizations.
      organizations: [{ id: 1, name: 'Org', owner_user_id: 1 }],
      projects: [{ id: P, name: 'Genesis', org_id: 1 }],
      org_settings: [{ org_id: 1, settings: '{}', version: 1 }],
      project_settings: [{
        project_id: P,
        settings: JSON.stringify(
          countStructural === undefined ? {} : { countStructuralCells: countStructural },
        ),
        version: 1,
      }],
      files: [{ id: F, project_id: P, name: 'GEN', event_id: 'f-evt' }],
      cells: [
        src('t1', 'GEN:mt1:1', 'paratext'), tgt('t1', 'Génesis'),
        src('t2', 'GEN:toc1:1', 'paratext'), tgt('t2', ''),
        src('v1', 'GEN 1:1', 'verse'), tgt('v1', ''),
        src('v2', 'GEN 1:2', 'verse'), tgt('v2', ''),
      ],
      // AQU-1278: the book is being dubbed, and whoever recorded it read the
      // title out too. Both verses and one of the two front-matter cells carry
      // a live take, so excluding structure must take the audio down to 2 —
      // not leave it at 3 over a denominator of 2.
      cell_audio: [
        { project_id: P, file_id: F, cell_id: 't1', audio_id: 'a-t1', slot: 'take',
          url: 'local://t1.webm', selected: 1, deleted: 0, validator_count: 1, event_id: 'au-t1', created_ts: 3 },
        { project_id: P, file_id: F, cell_id: 'v1', audio_id: 'a-v1', slot: 'take',
          url: 'local://v1.webm', selected: 1, deleted: 0, validator_count: 0, event_id: 'au-v1', created_ts: 3 },
        { project_id: P, file_id: F, cell_id: 'v2', audio_id: 'a-v2', slot: 'take',
          url: 'local://v2.webm', selected: 1, deleted: 0, validator_count: 0, event_id: 'au-v2', created_ts: 3 },
      ],
    })
    await db.db.batch(fullProgressRecomputeStmts(db.db, P, F, 100))
    return db.db
  }

  const get = async (db: AquillaDb) => {
    const token = await makeTestToken(SECRET, { projectId: P, fileId: F })
    const response = (await handleProgressReadRequest(new Request(
      `https://worker/api/v1/projects/${P}/files/${F}/progress`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    return { response, body: await response.json() as FileProgressResponse }
  }

  it('counts the front matter when nothing has opted out', async () => {
    const { body } = await get(await fixture(undefined))
    expect(body.file).toMatchObject({ totalCount: 4, filledCount: 1 })
    // Order is compareSections' business, not this test's — a chapterless key
    // sorts after the numbered ones. What matters is that both are present.
    expect([...body.sections.map((s) => s.key)].sort()).toEqual(['GEN', 'GEN 1'])
  })

  it('drops it from both halves of the ratio when the project opts out', async () => {
    const { body } = await get(await fixture(false))
    // Not just the denominator: the translated title has to leave the numerator
    // too, or excluding headings makes the percentage climb.
    expect(body.file).toMatchObject({ totalCount: 2, filledCount: 0 })
  })

  // AQU-1278. Sam: "when headings are recorded and the org excludes headings
  // from progress, exclude the recorded headings from the count of recordings
  // — they don't count towards or against anything."
  it('counts a recorded heading while the policy counts headings', async () => {
    const { body } = await get(await fixture(undefined))
    expect(body.file).toMatchObject({ totalCount: 4, audioCount: 3, audioValidatedCount: 1 })
  })

  it('drops the recorded heading from the audio when the project opts out', async () => {
    const { body } = await get(await fixture(false))
    // Three takes, one of them on the title. Excluding structure takes the
    // denominator to 2, so leaving audio at 3 would read 150% recorded — the
    // bar clamps, the number does not, and the row calls it nearly complete
    // for having been over-recorded. The title's sign-off leaves with it.
    expect(body.file).toMatchObject({ totalCount: 2, audioCount: 2, audioValidatedCount: 0 })
  })

  it('never reports negative audio on a row the backfill has not reached', async () => {
    // 0094 defaults both columns to 0, so a row written before it applied still
    // reports its recorded headings against a shrunken denominator. That is the
    // pre-0094 reading and it is allowed; going NEGATIVE is not.
    expect(counts(
      { scope: 'file', section_key: '', total_count: 2, filled_count: 0,
        validator_histogram: null, structural_count: 2, revision: 1,
        audio_count: 0, audio_validated_count: 0,
        structural_audio_count: 3, structural_audio_validated_count: 3 },
      1,
      false,
      1,
    )).toMatchObject({ totalCount: 0, audioCount: 0, audioValidatedCount: 0 })
  })

  it('drops a section the exclusion empties rather than showing it at 0%', async () => {
    // Front matter is its own section, so excluding it leaves that section with
    // nothing in it. A tile reading 0% would be a section that no longer exists
    // reporting that no work has been done on it.
    const { body } = await get(await fixture(false))
    expect(body.sections.map((s) => s.key)).toEqual(['GEN 1'])
  })

  it('gives the two policies different ETags', async () => {
    // Same file, same revision. Without the policy in the tag, a client that
    // cached one answer keeps painting it after the switch is flipped.
    const counting = await get(await fixture(true))
    const excluding = await get(await fixture(false))
    expect(counting.response.headers.get('ETag')).not.toBe(
      excluding.response.headers.get('ETag'),
    )
    expect(excluding.response.headers.get('ETag')).toContain(':nostruct')
  })

  it('falls back to the organization when the project has no answer', async () => {
    const db = await fixture(undefined)
    await db.prepare("UPDATE org_settings SET settings = ? WHERE org_id = 1")
      .bind(JSON.stringify({ countStructuralCells: false })).run()
    const { body } = await get(db)
    expect(body.file).toMatchObject({ totalCount: 2, filledCount: 0 })
  })
})

// AQU-1278, round 5: where "Go to first …" lands, answered by the server for
// every shape of file — which is the only place it can be answered for all of
// them, since a document has no chapters to walk and a dubbing project's takes
// are not even on the file being asked about.
describe('the first outstanding cell of a unit (readFirstOpenCell)', () => {
  const src = (fileId: string, cellId: string, over: Record<string, unknown> = {}) => ({
    project_id: PROJECT, file_id: fileId, cell_id: cellId, side: 'source', type: 'verse',
    value: `source ${cellId}`, canonical_ref: null, anchor_cell_id: null, start_ms: null,
    event_id: `ev-${cellId}`, last_editor: 'alice', last_edit_at: 1,
    validated: 0, endorsement_count: 0, word_count: 2, ...over,
  })
  const tgt = (fileId: string, cellId: string, value: string, endorsements = 0) => ({
    project_id: PROJECT, file_id: fileId, cell_id: cellId, side: 'target', target_lang: '',
    value, canonical_ref: null, event_id: `tev-${cellId}`, last_editor: 'alice',
    last_edit_at: 2, validated: endorsements >= 1 ? 1 : 0, endorsement_count: endorsements,
    word_count: value ? 1 : 0,
  })
  const take = (fileId: string, cellId: string, over: Record<string, unknown> = {}) => ({
    project_id: PROJECT, file_id: fileId, cell_id: cellId, audio_id: `take-${cellId}`,
    slot: 'take', url: `local://${cellId}.webm`, selected: 1, deleted: 0, validator_count: 0,
    event_id: `aev-${cellId}`, created_ts: 3, ...over,
  })
  const file = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, project_id: PROJECT, name: id, event_id: `fev-${id}`, ...over })
  const settings = (extra: Record<string, unknown> = {}) => [{
    project_id: PROJECT, settings: JSON.stringify({ validationCount: 1, ...extra }), version: 1,
  }]

  it('walks a book in canonical order and answers each text queue', async () => {
    // GEN 1 finished; GEN 2:2 and GEN 10:1 untranslated; GEN 2:1 unvalidated.
    // Inserted out of order on purpose — canonical order is the claim.
    const { db } = await makeTestDb({
      files: [file('bible')],
      project_settings: settings(),
      cells: [
        src('bible', 'g10', { canonical_ref: 'GEN 10:1' }),
        src('bible', 'g1', { canonical_ref: 'GEN 1:1' }), tgt('bible', 'g1', 'done', 1),
        src('bible', 'g2b', { canonical_ref: 'GEN 2:2' }),
        src('bible', 'g2a', { canonical_ref: 'GEN 2:1' }), tgt('bible', 'g2a', 'written', 0),
        src('bible', 'e1', { canonical_ref: 'EXO 1:1' }),
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'untranslated', '')).toBe('g2b')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'unvalidated', '')).toBe('g2a')
    // Scoped to the book: Exodus's blank is not Genesis's.
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'EXO', 'untranslated', '')).toBe('e1')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'EXO', 'unvalidated', '')).toBeNull()
    // `first` is the book's first cell whatever its state — GEN 1:1 is
    // finished and is still the answer — and Exodus's first, not Genesis's,
    // which is the whole point: "open Exodus" cannot land on Genesis 1.
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'first', '')).toBe('g1')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'EXO', 'first', '')).toBe('e1')
  })

  it("answers the audio queues from the cells' own takes", async () => {
    const { db } = await makeTestDb({
      files: [file('bible')],
      project_settings: settings(),
      cells: [
        src('bible', 'v1', { canonical_ref: 'GEN 1:1' }), tgt('bible', 'v1', 'a', 1),
        src('bible', 'v2', { canonical_ref: 'GEN 1:2' }), tgt('bible', 'v2', 'b', 1),
        src('bible', 'v3', { canonical_ref: 'GEN 1:3' }), tgt('bible', 'v3', 'c', 1),
        src('bible', 'v4', { canonical_ref: 'GEN 1:4' }), tgt('bible', 'v4', 'd', 1),
      ],
      cell_audio: [
        take('bible', 'v1', { validator_count: 1 }), // signed off
        take('bible', 'v2', { deleted: 1 }),    // a deleted take is no take
        take('bible', 'v3'),                    // recorded, not signed off
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'unrecorded', '')).toBe('v2')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'unsigned', '')).toBe('v3')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'untranslated', '')).toBeNull()
  })

  it('walks a document by its anchor chain, not by id', async () => {
    // Ids chosen to sort the WRONG way lexically; the chain says head → mid → tail.
    const { db } = await makeTestDb({
      files: [file('memo')],
      project_settings: settings(),
      cells: [
        src('memo', 'z-head'), tgt('memo', 'z-head', 'x', 1),
        src('memo', 'a-tail', { anchor_cell_id: 'm-mid' }),
        src('memo', 'm-mid', { anchor_cell_id: 'z-head' }),
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'memo', '', 'untranslated', '')).toBe('m-mid')
  })

  it('walks a timed file by start time', async () => {
    const { db } = await makeTestDb({
      files: [file('ep')],
      project_settings: settings(),
      cells: [
        src('ep', 'late', { start_ms: 9000 }),
        src('ep', 'early', { start_ms: 1000 }),
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'ep', '', 'untranslated', '')).toBe('early')
  })

  it("follows a dubbing project's links to the subtitle cell whose cue has no take", async () => {
    // Takes live on the cue sheet; the link has to land on a cell the editor
    // can open, which is the subtitle cell linked to the unrecorded cue.
    const { db } = await makeTestDb({
      files: [
        file('ep', { kind: 'vtt' }),
        file('ep-cues', { kind: 'vtt', role: 'audio-cues', anchor_file_id: 'ep' }),
      ],
      project_settings: settings(),
      cells: [
        src('ep', 's1', { start_ms: 1000 }), tgt('ep', 's1', 'a', 1),
        src('ep', 's2', { start_ms: 2000 }), tgt('ep', 's2', 'b', 1),
        src('ep', 's3', { start_ms: 3000 }), tgt('ep', 's3', 'c', 1),
        src('ep', 's4', { start_ms: 4000 }), tgt('ep', 's4', 'd', 1),  // linked to nothing
        src('ep-cues', 'q1', { type: 'cue', start_ms: 1000 }),
        src('ep-cues', 'q2', { type: 'cue', start_ms: 2000 }),
        src('ep-cues', 'q3', { type: 'cue', start_ms: 3000 }),
      ],
      cell_links: ['s1|q1', 's2|q2', 's3|q3'].map((pair) => {
        const [from, to] = pair.split('|')
        return {
          project_id: PROJECT, kind: 'text-audio', from_file_id: 'ep', from_cell_id: from,
          to_file_id: 'ep-cues', to_cell_id: to, linked: 1, origin: 'auto',
          event_id: `lev-${from}`, created_ts: 4,
        }
      }),
      cell_audio: [
        take('ep-cues', 'q1'),                  // recorded, not signed off
        take('ep-cues', 'q3', { validator_count: 1 }), // signed off
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'ep', '', 'unrecorded', '')).toBe('s2')
    expect(await readFirstOpenCell(db, PROJECT, 'ep', '', 'unsigned', '')).toBe('s1')
    // The sheet's own cells are never the answer for the subtitle file.
    expect(await readFirstOpenCell(db, PROJECT, 'ep', '', 'untranslated', '')).toBeNull()
  })

  it("ignores a tombstoned cue sheet and falls back to the file's own takes", async () => {
    const { db } = await makeTestDb({
      files: [
        file('ep', { kind: 'vtt' }),
        file('ep-cues', { kind: 'vtt', role: 'audio-cues', anchor_file_id: 'ep', deleted_at: 5 }),
      ],
      project_settings: settings(),
      cells: [src('ep', 's1', { start_ms: 1000 }), tgt('ep', 's1', 'a', 1), src('ep-cues', 'q1', { type: 'cue' })],
      cell_links: [{
        project_id: PROJECT, kind: 'text-audio', from_file_id: 'ep', from_cell_id: 's1',
        to_file_id: 'ep-cues', to_cell_id: 'q1', linked: 1, origin: 'auto', event_id: 'l', created_ts: 4,
      }],
    })
    // No sheet, no take on s1 itself → s1 is the first unrecorded cell.
    expect(await readFirstOpenCell(db, PROJECT, 'ep', '', 'unrecorded', '')).toBe('s1')
  })

  it('never sends a reader to a heading the project does not count', async () => {
    // The policy is read FROM `projects` (its own value, else the org's), so
    // the project has to exist for its opt-out to be seen at all.
    const { db } = await makeTestDb({
      organizations: [{ id: 1, name: 'Org', owner_user_id: 1 }],
      projects: [{ id: PROJECT, name: 'Plan', org_id: 1 }],
      org_settings: [{ org_id: 1, settings: '{}', version: 1 }],
      files: [file('bible')],
      project_settings: settings({ countStructuralCells: false }),
      cells: [
        src('bible', 'h', { canonical_ref: 'GEN 1:0', type: 'heading' }),
        src('bible', 'v1', { canonical_ref: 'GEN 1:1' }),
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'untranslated', '')).toBe('v1')
    // The policy holds for `first` too: a book opens on its first COUNTED cell.
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'first', '')).toBe('v1')
  })

  it('lands on a book\'s front matter and a chapter\'s pre-verse text, which sit FIRST', async () => {
    // A real USFM import shapes front matter as "GEN:h:1" / "GEN:mt1:1" and
    // puts it at the head of the file; text a chapter carries before its
    // first verse is keyed "GEN 2". Neither parses as book-chapter-verse, and
    // both used to sort to the END of the book — behind the last chapter, or
    // behind every known book once the whole value was taken as a book name.
    // So the link walked straight past an untranslated title and landed on
    // 1:1. The editor draws them first; so must this.
    const { db } = await makeTestDb({
      files: [file('bible')],
      project_settings: settings(),
      cells: [
        src('bible', 'h', { canonical_ref: 'GEN:h:1', type: 'paratext' }),
        src('bible', 'mt', { canonical_ref: 'GEN:mt1:1', type: 'paratext' }),
        src('bible', 'v1', { canonical_ref: 'GEN 1:1' }), tgt('bible', 'v1', 'done', 1),
        src('bible', 'v2', { canonical_ref: 'GEN 1:2' }), tgt('bible', 'v2', 'done', 1),
        src('bible', 'c2pre', { canonical_ref: 'GEN 2', type: 'text' }),
        src('bible', 'v3', { canonical_ref: 'GEN 2:1' }),
      ],
    })
    // The untranslated title comes before every verse.
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'untranslated', '')).toBe('h')
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'first', '')).toBe('h')

    // With the front matter done, chapter 2's pre-verse text precedes 2:1.
    await db.prepare(`INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_editor, last_edit_at, validated, endorsement_count, word_count)
                      VALUES (?, ?, 'h', 'target', '', 'Titel', 'tev-h', 'alice', 2, 1, 1, 1),
                             (?, ?, 'mt', 'target', '', 'Titel', 'tev-mt', 'alice', 2, 1, 1, 1)`)
      .bind(PROJECT, 'bible', PROJECT, 'bible').run()
    expect(await readFirstOpenCell(db, PROJECT, 'bible', 'GEN', 'untranslated', '')).toBe('c2pre')
  })

  it('reads a one-chapter book\'s "TIT:4" as verse 4, in order', async () => {
    const { db } = await makeTestDb({
      files: [file('titus')],
      project_settings: settings(),
      cells: [
        src('titus', 't10', { canonical_ref: 'TIT:10' }),
        src('titus', 't2', { canonical_ref: 'TIT:2' }),
        src('titus', 't0', { canonical_ref: 'TIT:0', type: 'heading' }), tgt('titus', 't0', 'x', 1),
      ],
    })
    expect(await readFirstOpenCell(db, PROJECT, 'titus', 'TIT', 'untranslated', '')).toBe('t2')
  })

  it('serves the answer over HTTP and refuses a queue it does not know', async () => {
    const { db } = await makeTestDb({
      files: [file('bible')],
      project_settings: settings(),
      cells: [src('bible', 'v1', { canonical_ref: 'GEN 1:1' })],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: 'bible' })
    const base = `https://worker/api/v1/projects/${PROJECT}/files/bible/progress/first-open`
    const ok = (await handleProgressReadRequest(new Request(`${base}?unit=GEN&kind=untranslated`, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ fileId: 'bible', unit: 'GEN', kind: 'untranslated', cellId: 'v1' })

    const first = (await handleProgressReadRequest(new Request(`${base}?unit=GEN&kind=first`, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ fileId: 'bible', unit: 'GEN', kind: 'first', cellId: 'v1' })

    const bad = (await handleProgressReadRequest(new Request(`${base}?unit=GEN&kind=unfinished`, {
      headers: { Authorization: `Bearer ${token}` },
    }), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }))!
    expect(bad.status).toBe(400)
  })
})
