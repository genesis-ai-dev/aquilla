// AQU-1240 slice 7: dual-read hot paths prefer opaque lane_id when populated,
// and fall back to target_lang while backfill is in flight. PK lookups stay
// on target_lang until slice 8.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SyncTokenClaims } from '../auth'
import { handleCellsReadRequest } from '../events/cells-read-route'
import { handleProgressReadRequest } from '../events/progress-read-route'
import { handleValidatorsReadRequest } from '../events/validators-read-route'
import { makeVerifiedProjectId, queryFileSourceNeighbors } from '../events/scoped-search'
import { buildUsfmExportPlan } from '../events/usfm-export-plan'
import { buildPromptPreview } from '../external/prompt-preview'
import { loadCorpus } from '../lib/branching-search/corpus'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'

const SECRET = 'lane-dual-read-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const ES_LANE = 'lane-tgt-es'
const FR_LANE = 'lane-tgt-fr'

const EVENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../events')
const EXTERNAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../external')
const CORPUS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/branching-search/corpus.ts')

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function cell(over: {
  cell_id: string
  side: 'source' | 'target'
  event_id: string
  value: string
  target_lang?: string
  lane_id?: string | null
  validated?: number
  sequence_index?: number
  canonical_ref?: string | null
}) {
  return {
    project_id: PROJECT,
    file_id: FILE,
    last_editor: 'alice',
    last_edit_at: 1,
    validated: 0,
    word_count: 1,
    ...over,
  }
}

const esLane = {
  id: ES_LANE,
  project_id: PROJECT,
  role: 'target' as const,
  name: 'Spanish',
  lang_code: 'es',
  legacy_tag: 'es',
}

describe('AQU-1240 slice 7 — dual-read completeness', () => {
  it('hot read routes use the shared dual-read helper, not a raw target_lang filter', () => {
    const cells = readFileSync(path.join(EVENTS_DIR, 'cells-read-route.ts'), 'utf8')
    const validators = readFileSync(path.join(EVENTS_DIR, 'validators-read-route.ts'), 'utf8')
    const progress = readFileSync(path.join(EVENTS_DIR, 'progress-read-route.ts'), 'utf8')
    const usfm = readFileSync(path.join(EVENTS_DIR, 'usfm-export-plan.ts'), 'utf8')
    const scoped = readFileSync(path.join(EVENTS_DIR, 'scoped-search.ts'), 'utf8')
    const promptPreview = readFileSync(path.join(EXTERNAL_DIR, 'prompt-preview.ts'), 'utf8')
    const quality = readFileSync(path.join(EXTERNAL_DIR, 'quality-routes.ts'), 'utf8')
    const corpus = readFileSync(CORPUS_PATH, 'utf8')

    expect(cells).toContain('sourceOrTargetLaneSql')
    expect(cells).not.toContain("OR target_lang = ?)")
    expect(validators).toContain('targetLaneDualReadSql')
    expect(validators).not.toContain('AND target_lang = ?')
    expect(progress).toContain('targetLaneDualReadSql')
    expect(progress).not.toContain('t.target_lang = ?')
    expect(progress).not.toContain('AND target_lang = ?')

    expect(usfm).toContain('targetLaneDualReadSql')
    expect(usfm).not.toContain('t.target_lang = ?')
    expect(promptPreview).toContain('targetLaneDualReadSql')
    expect(promptPreview).not.toContain('t.target_lang = ?')
    expect(quality).toContain('targetLaneDualReadSql')
    expect(quality).not.toContain('t.target_lang = ?')
    expect(scoped).toContain('targetLaneDualReadSql')
    expect(scoped).not.toContain('t.target_lang = ?')
    expect(scoped).not.toContain('tc.target_lang = ?')
    expect(corpus).toContain('targetLaneDualReadSql')
    expect(corpus).not.toContain('t.target_lang = ?')
  })
})

describe('GET cells dual-read', () => {
  it('falls back to target_lang while lane_id is NULL', async () => {
    const { db } = await makeTestDb({
      cells: [
        cell({ cell_id: 's1', side: 'source', event_id: 'es1', value: 'src' }),
        cell({ cell_id: 't1', side: 'target', event_id: 'et-es', value: 'es-tag', target_lang: 'es' }),
        cell({ cell_id: 't1', side: 'target', event_id: 'et-fr', value: 'fr-tag', target_lang: 'fr' }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const res = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells?lane=es`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cells: Array<{ value: string; laneId: string | null }> }
    expect(body.cells.map((c) => c.value).sort()).toEqual(['es-tag', 'src'])
    expect(body.cells.find((c) => c.value === 'es-tag')!.laneId).toBeNull()
  })

  it('matches by lane_id even when target_lang disagrees, and serializes laneId', async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: ES_LANE, project_id: PROJECT, role: 'target', name: 'Spanish', lang_code: 'es', legacy_tag: 'es' },
        { id: FR_LANE, project_id: PROJECT, role: 'target', name: 'French', lang_code: 'fr', legacy_tag: 'fr' },
      ],
      cells: [
        cell({ cell_id: 's1', side: 'source', event_id: 'es1', value: 'src' }),
        cell({
          cell_id: 't1', side: 'target', event_id: 'et-id', value: 'by-id',
          target_lang: 'xx', lane_id: ES_LANE,
        }),
        cell({
          cell_id: 't1', side: 'target', event_id: 'et-fr', value: 'fr-row',
          target_lang: 'fr', lane_id: FR_LANE,
        }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const res = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells?lane=es`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: Array<{ value: string; laneId: string | null; targetLang: string }>
    }
    expect(body.cells.map((c) => c.value).sort()).toEqual(['by-id', 'src'])
    const target = body.cells.find((c) => c.value === 'by-id')!
    expect(target.laneId).toBe(ES_LANE)
    expect(target.targetLang).toBe('xx')
  })
})

describe('GET cell-validators dual-read', () => {
  it('filters by lane_id when populated and by target_lang when NULL', async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: ES_LANE, project_id: PROJECT, role: 'target', name: 'Spanish', lang_code: 'es', legacy_tag: 'es' },
      ],
      cell_validators: [
        {
          project_id: PROJECT, file_id: FILE, cell_id: 'c1',
          event_id: 'ev-id', username: 'alice', decided_ts: 20,
          target_lang: 'xx', lane_id: ES_LANE,
        },
        {
          project_id: PROJECT, file_id: FILE, cell_id: 'c1',
          event_id: 'ev-tag', username: 'bob', decided_ts: 10,
          target_lang: 'es', lane_id: null,
        },
        {
          project_id: PROJECT, file_id: FILE, cell_id: 'c1',
          event_id: 'ev-fr', username: 'carol', decided_ts: 5,
          target_lang: 'fr', lane_id: FR_LANE,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const res = (await handleValidatorsReadRequest(
      new Request('https://w/cell-validators?fileId=file-x&cellId=c1&lane=es', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      validators: Array<{ username: string; laneId: string | null }>
    }
    expect(body.validators.map((v) => v.username).sort()).toEqual(['alice', 'bob'])
    expect(body.validators.find((v) => v.username === 'alice')!.laneId).toBe(ES_LANE)
    expect(body.validators.find((v) => v.username === 'bob')!.laneId).toBeNull()
  })
})

describe('GET progress dual-read', () => {
  it('returns the progress row matched by lane_id or by target_lang fallback', async () => {
    const { db } = await makeTestDb({
      files: [{ id: FILE, project_id: PROJECT, name: 'Genesis', event_id: 'file-event' }],
      lanes: [
        { id: ES_LANE, project_id: PROJECT, role: 'target', name: 'Spanish', lang_code: 'es', legacy_tag: 'es' },
      ],
      file_section_progress: [
        {
          project_id: PROJECT, file_id: FILE, scope: 'file', section_key: '',
          target_lang: 'xx', lane_id: ES_LANE,
          total_count: 3, filled_count: 1, validator_histogram: {},
          revision: 1, updated_at: 1, audio_count: 0, audio_validated_count: 0,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const res = (await handleProgressReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/progress?lane=es`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { file: { totalCount: number; filledCount: number } }
    expect(body.file.totalCount).toBe(3)
    expect(body.file.filledCount).toBe(1)
  })
})

describe('buildUsfmExportPlan dual-read', () => {
  it('translations prefer lane_id and fall back to target_lang', async () => {
    const { db } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({ cell_id: 'c1', side: 'source', event_id: 'es1', value: 'src1', canonical_ref: 'GEN 1:1' }),
        cell({
          cell_id: 'c1', side: 'target', event_id: 'et1', value: 'by-id',
          target_lang: 'xx', lane_id: ES_LANE,
        }),
        cell({ cell_id: 'c2', side: 'source', event_id: 'es2', value: 'src2', canonical_ref: 'GEN 1:2' }),
        cell({ cell_id: 'c2', side: 'target', event_id: 'et2', value: 'by-tag', target_lang: 'es' }),
        cell({ cell_id: 'c3', side: 'source', event_id: 'es3', value: 'src3', canonical_ref: 'GEN 1:3' }),
        cell({ cell_id: 'c3', side: 'target', event_id: 'et3', value: 'french', target_lang: 'fr' }),
      ],
    })
    const { overrides } = await buildUsfmExportPlan(db, PROJECT, FILE, 'es')
    expect([...overrides.entries()].sort()).toEqual([
      ['GEN 1:1', 'by-id'],
      ['GEN 1:2', 'by-tag'],
    ])
  })

  it('additions prefer lane_id and fall back to target_lang', async () => {
    const { db, pg } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({ cell_id: 'c4', side: 'source', event_id: 'es4', value: 'src4', canonical_ref: 'GEN 1:4' }),
      ],
    })
    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, anchor_cell_id, metadata, event_id, last_edit_at)
       VALUES ($1, $2, 'a1', 'source', '', '', NULL, 'c4', $3, 'head-a1', 1),
              ($1, $2, 'a2', 'source', '', '', NULL, 'c4', $3, 'head-a2', 1)`,
      [PROJECT, FILE, JSON.stringify({ aquillaOrigin: { version: 1, kind: 'user-insert' } })],
    )
    await pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, lane_id, value, event_id, last_edit_at)
       VALUES ($1, $2, 'a1', 'target', 'xx', $3, 'added-by-id', 'tgt-a1', 1),
              ($1, $2, 'a2', 'target', 'es', NULL, 'added-by-tag', 'tgt-a2', 1),
              ($1, $2, 'a1', 'target', 'fr', NULL, 'added-french', 'tgt-a1-fr', 1)`,
      [PROJECT, FILE, ES_LANE],
    )
    const { edits } = await buildUsfmExportPlan(db, PROJECT, FILE, 'es')
    expect(edits.appendAfter?.get('GEN 1:4')).toEqual(['added-by-id', 'added-by-tag'])
  })
})

describe('prompt-preview dual-read', () => {
  it('preceding context matches by lane_id or target_lang fallback', async () => {
    const { db } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({
          cell_id: 'p-id', side: 'source', event_id: 'es-pid', value: 'In the beginning',
          sequence_index: 1,
        }),
        cell({
          cell_id: 'p-id', side: 'target', event_id: 'et-pid', value: 'by-id',
          target_lang: 'xx', lane_id: ES_LANE, validated: 1,
        }),
        cell({
          cell_id: 'p-tag', side: 'source', event_id: 'es-ptag', value: 'God created',
          sequence_index: 2,
        }),
        cell({
          cell_id: 'p-tag', side: 'target', event_id: 'et-ptag', value: 'by-tag',
          target_lang: 'es', validated: 1,
        }),
        cell({
          cell_id: 'p-fr', side: 'source', event_id: 'es-pfr', value: 'the heavens',
          sequence_index: 3,
        }),
        cell({
          cell_id: 'p-fr', side: 'target', event_id: 'et-pfr', value: 'french',
          target_lang: 'fr', validated: 1,
        }),
        cell({
          cell_id: 'live', side: 'source', event_id: 'es-live', value: 'and it was good',
          sequence_index: 4,
        }),
      ],
    })
    const result = await buildPromptPreview(db, { projectId: PROJECT, cellId: 'live', targetLang: 'es' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.parts.precedingContext.map((c) => c.target)).toEqual(['by-id', 'by-tag'])
  })

  it('validated-pair fallback matches by lane_id or target_lang (empty live source skips retrieval)', async () => {
    const { db } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({
          cell_id: 'live', side: 'source', event_id: 'es-live', value: '',
          sequence_index: 1,
        }),
        cell({
          cell_id: 'ex-id', side: 'source', event_id: 'es-exid', value: 'God created the light',
          sequence_index: 2,
        }),
        cell({
          cell_id: 'ex-id', side: 'target', event_id: 'et-exid', value: 'by-id-ex',
          target_lang: 'xx', lane_id: ES_LANE, validated: 1,
        }),
        cell({
          cell_id: 'ex-tag', side: 'source', event_id: 'es-extag', value: 'God created the dark',
          sequence_index: 3,
        }),
        cell({
          cell_id: 'ex-tag', side: 'target', event_id: 'et-extag', value: 'by-tag-ex',
          target_lang: 'es', validated: 1,
        }),
        cell({
          cell_id: 'ex-fr', side: 'source', event_id: 'es-exfr', value: 'God created the sea',
          sequence_index: 4,
        }),
        cell({
          cell_id: 'ex-fr', side: 'target', event_id: 'et-exfr', value: 'french-ex',
          target_lang: 'fr', validated: 1,
        }),
      ],
    })
    const result = await buildPromptPreview(db, { projectId: PROJECT, cellId: 'live', targetLang: 'es' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.parts.examples.map((e) => e.target).sort()).toEqual(['by-id-ex', 'by-tag-ex'])
  })
})

describe('queryFileSourceNeighbors dual-read', () => {
  it('scopes askers and neighbors by lane_id or target_lang fallback', async () => {
    const { db } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({
          cell_id: 'asker', side: 'source', event_id: 'es-asker',
          value: 'In the beginning God created the heavens',
        }),
        cell({
          cell_id: 'asker', side: 'target', event_id: 'et-asker', value: 'asker-xx',
          target_lang: 'xx', lane_id: ES_LANE,
        }),
        cell({
          cell_id: 'nbr', side: 'source', event_id: 'es-nbr',
          value: 'In the beginning was the Word',
        }),
        cell({
          cell_id: 'nbr', side: 'target', event_id: 'et-nbr', value: 'neighbor-es',
          target_lang: 'es', validated: 1,
        }),
        cell({
          cell_id: 'fr', side: 'source', event_id: 'es-fr',
          value: 'In the beginning God created the earth',
        }),
        cell({
          cell_id: 'fr', side: 'target', event_id: 'et-fr', value: 'french',
          target_lang: 'fr',
        }),
      ],
    })
    const verified = makeVerifiedProjectId({ projectId: PROJECT } as SyncTokenClaims)
    const byFile = await queryFileSourceNeighbors(db, verified, FILE, { topK: 10, targetLang: 'es' })
    expect([...byFile.keys()]).toEqual(['asker'])
    expect((byFile.get('asker') ?? []).map((n) => n.cellId)).toEqual(['nbr'])
    expect((byFile.get('asker') ?? []).map((n) => n.targetValue)).toEqual(['neighbor-es'])
  })
})

describe('loadCorpus dual-read', () => {
  it('joins the target by lane_id or target_lang fallback', async () => {
    const { db } = await makeTestDb({
      lanes: [esLane],
      cells: [
        cell({ cell_id: 'c1', side: 'source', event_id: 'es1', value: 'src-id' }),
        cell({
          cell_id: 'c1', side: 'target', event_id: 'et1', value: 'by-id',
          target_lang: 'xx', lane_id: ES_LANE,
        }),
        cell({ cell_id: 'c2', side: 'source', event_id: 'es2', value: 'src-tag' }),
        cell({ cell_id: 'c2', side: 'target', event_id: 'et2', value: 'by-tag', target_lang: 'es' }),
        cell({ cell_id: 'c3', side: 'source', event_id: 'es3', value: 'src-fr' }),
        cell({ cell_id: 'c3', side: 'target', event_id: 'et3', value: 'french', target_lang: 'fr' }),
      ],
    })
    const { cells } = await loadCorpus({ AQUILLA_PG: db }, { projectId: PROJECT, targetLang: 'es' })
    const byId = Object.fromEntries(cells.map((c) => [c.cellId, c.targetText]))
    expect(byId.c1).toBe('by-id')
    expect(byId.c2).toBe('by-tag')
    expect(byId.c3).toBe('')
  })
})
