// AQU-1832 — the pushed progress frame and the /progress GET are the same answer.
//
// The push exists to delete a read, which only works if nobody can tell the
// difference. Two ways that can rot, and a test for each:
//
//   1. DIFFERENTIAL. The frame is built from the same rows and the same
//      `counts()` derivation the read route uses, so every assertion here is
//      against `handleProgressReadRequest`'s own body rather than against
//      numbers typed into this file. A policy or threshold the push forgets to
//      apply shows up as a mismatch, not as a second plausible percentage.
//   2. SCOPE. A frame per TARGET lane, the source lane's row excluded, the
//      `book` scope excluded, and nothing at all when the pass rewrote more
//      rows than the cap allows.

import { describe, expect, it } from 'vitest'
import {
  PROGRESS_PUSH_MAX_ROWS,
  buildFileProgressPushFrames,
} from '../events/progress-push'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
} from '../events/progress-projection'
import { handleProgressReadRequest } from '../events/progress-read-route'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'

const SECRET = 'progress-push-secret'
const PROJECT = 'proj-push'
const FILE = 'file-push'
const RECOMPUTE_TS = 1_700_000_000_000

function source(cellId: string, canonicalRef: string, sequence: number) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'source',
    value: `source ${cellId}`, canonical_ref: canonicalRef, event_id: `source-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0,
    word_count: 2, target_lang: '', sequence_index: sequence,
  }
}

function target(cellId: string, lane: string, value: string, endorsements = 0, sequence = 1) {
  return {
    project_id: PROJECT, file_id: FILE, cell_id: cellId, side: 'target',
    value, canonical_ref: null, event_id: `target-${lane}-${cellId}`,
    last_editor: 'alice', last_edit_at: 2, validated: 0,
    endorsement_count: endorsements, word_count: value ? 1 : 0,
    target_lang: lane, sequence_index: sequence,
  }
}

/** Two target lanes ('' and 'fr') over four cells in two chapters. */
async function fixture() {
  return makeTestDb({
    files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
    cells: [
      source('c1', 'GEN 1:1', 1), target('c1', '', 'uno', 2, 1), target('c1', 'fr', 'un', 0, 1),
      source('c2', 'GEN 1:2', 2), target('c2', '', '', 0, 2), target('c2', 'fr', 'deux', 1, 2),
      source('c3', 'GEN 2:1', 3), target('c3', '', 'tres', 1, 3),
      source('c4', 'GEN 2:2', 4),
    ],
  })
}

/** The body the client would have fetched for one lane. */
async function readProgress(db: AquillaDb, lane: string) {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
  const query = lane ? `?lane=${encodeURIComponent(lane)}` : ''
  const res = (await handleProgressReadRequest(
    new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/progress${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  ))!
  expect(res.status).toBe(200)
  return (await res.json()) as {
    revision: number
    validationCount: number
    file: Record<string, unknown>
    sections: Array<{ key: string } & Record<string, unknown>>
  }
}

describe('AQU-1832 — pushed progress frames', () => {
  it('carries, per target lane, exactly what GET /progress would answer', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, RECOMPUTE_TS))

    const frames = await buildFileProgressPushFrames(
      db, { projectId: PROJECT, fileId: FILE, fullSections: true }, RECOMPUTE_TS,
    )

    expect(frames.map((f) => f.lane).sort()).toEqual(['', 'fr'])
    for (const frame of frames) {
      const read = await readProgress(db, frame.lane)
      expect(frame.counts).toEqual(read.file)
      expect(frame.sections).toEqual(read.sections)
      expect(frame.revision).toBe(read.revision)
      expect(frame.validationCount).toBe(read.validationCount)
      expect(frame.project).toBe(PROJECT)
      expect(frame.file).toBe(FILE)
      expect(frame.complete).toBe(true)
    }
    // Not a tautology against an empty body: the fixture really is partly
    // translated, and the two lanes really do disagree.
    const def = frames.find((f) => f.lane === '')!
    const fr = frames.find((f) => f.lane === 'fr')!
    expect(def.counts.totalCount).toBe(4)
    expect(def.counts.filledCount).toBe(2)
    expect(fr.counts.filledCount).toBe(2)
    expect(def.sections.map((s) => s.key)).toEqual(['GEN 1', 'GEN 2'])
  })

  it('agrees with the read after a single-cell commit recompute, sections included', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, RECOMPUTE_TS))

    // One cell translated in the default lane — the per-commit pass shape.
    await db.prepare(
      `UPDATE cells SET value = 'cuatro', word_count = 1
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
    ).bind(PROJECT, FILE, 'c2').run()
    const nextTs = RECOMPUTE_TS + 1_000
    await db.batch([
      fileProgressRecomputeStmt(db, PROJECT, FILE, nextTs),
      sectionsProgressRecomputeStmt(db, PROJECT, FILE, nextTs, ['c2']),
    ])

    const frames = await buildFileProgressPushFrames(
      db, { projectId: PROJECT, fileId: FILE, fullSections: false }, nextTs,
    )
    const def = frames.find((frame) => frame.lane === '')!
    const read = await readProgress(db, '')
    expect(def.complete).toBe(false)
    expect(def.counts).toEqual(read.file)
    expect(def.counts.filledCount).toBe(3)
    // A partial pass names only the chapter it touched — the client upserts
    // it rather than replacing a list it was never sent.
    expect(def.sections.map((s) => s.key)).toEqual(['GEN 1'])
    expect(def.sections[0]).toEqual(read.sections.find((s) => s.key === 'GEN 1'))
  })

  it('omits rows no /progress reader can address: the source lane and the book scope', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, RECOMPUTE_TS))

    // The projection really does write both, so the exclusions are load-bearing.
    const written = await db.prepare(
      `SELECT DISTINCT scope FROM file_section_progress WHERE project_id = ? AND file_id = ?`,
    ).bind(PROJECT, FILE).all<{ scope: string }>()
    expect(written.results.map((r) => r.scope).sort()).toContain('book')
    const sourceLaneRows = await db.prepare(
      `SELECT COUNT(*) AS n FROM file_section_progress p
         JOIN lanes l ON l.id = p.lane_id
        WHERE p.project_id = ? AND p.file_id = ? AND l.role = 'source'`,
    ).bind(PROJECT, FILE).first<{ n: number | string }>()
    expect(Number(sourceLaneRows?.n)).toBeGreaterThan(0)

    const frames = await buildFileProgressPushFrames(
      db, { projectId: PROJECT, fileId: FILE, fullSections: true }, RECOMPUTE_TS,
    )
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(frame.sections.every((s) => s.key.includes(':') || /\s\d+$/.test(s.key))).toBe(true)
      // 'GEN' alone would be the book row leaking in as a section.
      expect(frame.sections.map((s) => s.key)).not.toContain('GEN')
    }
  })

  it('says nothing about rows an older pass wrote', async () => {
    const { db } = await fixture()
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, RECOMPUTE_TS))

    // A pass that rewrote nothing at this timestamp has nothing to publish:
    // broadcasting the previous pass's numbers as this commit's answer is the
    // one way a push can be worse than the read it replaces.
    const frames = await buildFileProgressPushFrames(
      db, { projectId: PROJECT, fileId: FILE, fullSections: false }, RECOMPUTE_TS + 1,
    )
    expect(frames).toEqual([])
  })

  it('omits the push entirely rather than truncate a large file', async () => {
    const cells = [
      { id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' },
    ]
    const manyChapters = []
    for (let chapter = 1; chapter <= PROGRESS_PUSH_MAX_ROWS; chapter++) {
      manyChapters.push(source(`c${chapter}`, `GEN ${chapter}:1`, chapter))
      manyChapters.push(target(`c${chapter}`, '', 'x', 0, chapter))
    }
    const { db } = await makeTestDb({ files: cells, cells: manyChapters })
    await db.batch(fullProgressRecomputeStmts(db, PROJECT, FILE, RECOMPUTE_TS))

    const frames = await buildFileProgressPushFrames(
      db, { projectId: PROJECT, fileId: FILE, fullSections: true }, RECOMPUTE_TS,
    )
    expect(frames).toEqual([])
    // And the read still answers, which is what the client falls back to.
    const read = await readProgress(db, '')
    expect(read.sections.length).toBe(PROGRESS_PUSH_MAX_ROWS)
  })
})
