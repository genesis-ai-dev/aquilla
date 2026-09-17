// AQU-1240 slice 7: dual-read hot paths prefer opaque lane_id when populated,
// and fall back to target_lang while backfill is in flight. PK lookups stay
// on target_lang until slice 8.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { handleCellsReadRequest } from '../events/cells-read-route'
import { handleProgressReadRequest } from '../events/progress-read-route'
import { handleValidatorsReadRequest } from '../events/validators-read-route'
import { makeTestToken } from './helpers/auth'
import { makeTestDb } from './helpers/pg-test-db'

const SECRET = 'lane-dual-read-secret'
const PROJECT = 'proj-a'
const FILE = 'file-x'
const ES_LANE = 'lane-tgt-es'
const FR_LANE = 'lane-tgt-fr'

const EVENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../events')

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

describe('AQU-1240 slice 7 — dual-read completeness', () => {
  it('hot read routes use the shared dual-read helper, not a raw target_lang filter', () => {
    const cells = readFileSync(path.join(EVENTS_DIR, 'cells-read-route.ts'), 'utf8')
    const validators = readFileSync(path.join(EVENTS_DIR, 'validators-read-route.ts'), 'utf8')
    const progress = readFileSync(path.join(EVENTS_DIR, 'progress-read-route.ts'), 'utf8')

    expect(cells).toContain('sourceOrTargetLaneSql')
    expect(cells).not.toContain("OR target_lang = ?)")
    expect(validators).toContain('targetLaneDualReadSql')
    expect(validators).not.toContain('AND target_lang = ?')
    expect(progress).toContain('targetLaneDualReadSql')
    expect(progress).not.toContain('t.target_lang = ?')
    expect(progress).not.toContain('AND target_lang = ?')
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
