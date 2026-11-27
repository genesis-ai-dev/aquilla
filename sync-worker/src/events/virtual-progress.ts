// AQU-2459 Phase B: Pure-JS counters & progress projection for virtual source files.
//
// Legacy (materialized) files compute `files.*_count` and `file_section_progress`
// by scanning `FROM cells s WHERE s.side = 'source'`. A virtual source file
// (`files.source_virtual = TRUE`) has ZERO `side = 'source'` rows in Postgres,
// so running the SQL scans on one would zero out its counts.
//
// Instead, this module computes the exact same file counters and
// `file_section_progress` rows (file, section, book × lane, with text/audio/joint
// validator histograms and structural shares) in JS from:
//   1. The virtual source rows (from the in-memory/cached R2 manifest + any
//      sparse Postgres source overlays),
//   2. The file's sparse Postgres target rows (`side = 'target'`),
//   3. The file's live dub audio rollup (`AUDIO_CTE_SQL`), and
//   4. The project's lanes.
//
// On a fresh import there are 0 targets and 0 audio rows, so computing counters
// and progress for a 1,500-verse book takes <2 ms and writes only the summary
// rows (~1–150 rows) — eliminating the ~3 s full-file SQL scan.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import { AUDIO_CTE_SQL } from '../../../db/shared/audio-progress'
import type { StoredRevisionManifest } from '../../../db/shared/file-revision'
import { INTRODUCING_CELL_TYPES, TIMELINE_SECTION_MS } from '../../../db/shared/plan-keys'
import {
  loadVirtualSourceFile,
  type ManifestR2Bucket,
  type VirtualFileHead,
  type VirtualSourceRow,
} from '../../../db/shared/virtual-source-store'
import { MAX_VALIDATOR_HISTOGRAM_BUCKET } from './progress-projection'
import { STRUCTURAL_CELL_TYPES } from './structural-cells'

const STRUCTURAL_SET = new Set<string>(STRUCTURAL_CELL_TYPES)
const INTRODUCING_SET = new Set<string>(INTRODUCING_CELL_TYPES)
const VERSE_REF_RE = /^\S+ \d+:\d+/

/** Matches `db/shared/plan-keys.ts::sectionKeyExpr` for a single source row. */
export function ownSectionKeyOf(row: Pick<VirtualSourceRow, 'canonical_ref' | 'start_ms'>): string {
  const ref = row.canonical_ref ?? ''
  const colonIdx = ref.indexOf(':')
  const canonical = (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
  if (canonical) return canonical
  if (row.start_ms != null) {
    const bucket = Math.floor(row.start_ms / TIMELINE_SECTION_MS) * TIMELINE_SECTION_MS
    return `t:${String(bucket).padStart(12, '0')}`
  }
  return ''
}

/** Matches `db/shared/plan-keys.ts::bookKeyExpr` given a section key. */
export function bookKeyFromSection(sectionKey: string): string {
  if (!sectionKey || sectionKey.startsWith('t:')) return ''
  const spaceIdx = sectionKey.indexOf(' ')
  return spaceIdx >= 0 ? sectionKey.slice(0, spaceIdx) : sectionKey
}

/**
 * Resolve effective `(sectionKey, bookKey)` for every live, visible source row,
 * matching `db/shared/plan-keys.ts::inheritedKeysSql` (AQU-1493):
 *   - Introducing cells (`heading`, `paratext`) without their own reference
 *     inherit from the next referenced row below them.
 *   - Other unreferenced cells inherit from the previous referenced row above
 *     them (or the front matter book code of the file's first referenced verse).
 */
export function resolveVirtualPlanKeys(
  rows: readonly VirtualSourceRow[],
): { hasBooks: boolean; keys: Map<string, { sectionKey: string; bookKey: string }> } {
  const hasBooks = rows.some((r) => VERSE_REF_RE.test(r.canonical_ref ?? ''))
  const ownSections = rows.map((r) => ownSectionKeyOf(r))

  // Precompute nearest referenced row above and below when the file is Scripture.
  let firstBook = ''
  if (hasBooks) {
    for (let i = 0; i < ownSections.length; i++) {
      const bk = bookKeyFromSection(ownSections[i])
      if (bk) {
        firstBook = bk
        break
      }
    }
  }

  const nextRefSection: string[] = new Array(rows.length).fill('')
  if (hasBooks) {
    let next = ''
    for (let i = rows.length - 1; i >= 0; i--) {
      if (ownSections[i]) next = ownSections[i]
      nextRefSection[i] = next
    }
  }

  const keys = new Map<string, { sectionKey: string; bookKey: string }>()
  let prevRef = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let sectionKey = ownSections[i]
    if (sectionKey) {
      prevRef = sectionKey
    } else if (hasBooks) {
      const isIntroducing = INTRODUCING_SET.has(row.type ?? '')
      if (isIntroducing) {
        sectionKey = nextRefSection[i] || prevRef || firstBook
      } else {
        sectionKey = prevRef || firstBook
      }
    }
    const bookKey = hasBooks ? bookKeyFromSection(sectionKey) : ''
    keys.set(row.cell_id, { sectionKey, bookKey })
  }

  return { hasBooks, keys }
}

interface LaneRow {
  lane_id: string
  lane: string
  join_tag: string | null
}

interface TargetRow {
  cell_id: string
  lane_id: string
  value: string
  word_count: number | string
  validated: number | string
  endorsement_count: number | string
  ai_drafted: number | string
  last_edit_at: number | string
}

interface AudioRollupRow {
  cell_id: string
  lane: string
  has_dub: number | string
  dub_votes: number | string | null
}

interface BucketAgg {
  totalCount: number
  filledCount: number
  structuralCount: number
  structuralFilledCount: number
  audioCount: number
  audioValidatedCount: number
  structuralAudioCount: number
  structuralAudioValidatedCount: number
  lastEditAt: number
  validatorHistogram: Record<string, number>
  structuralValidatorHistogram: Record<string, number>
  audioValidatorHistogram: Record<string, number>
  structuralAudioValidatorHistogram: Record<string, number>
  textAudioValidatorHistogram: Record<string, number>
  structuralTextAudioValidatorHistogram: Record<string, number>
}

function emptyAgg(): BucketAgg {
  return {
    totalCount: 0,
    filledCount: 0,
    structuralCount: 0,
    structuralFilledCount: 0,
    audioCount: 0,
    audioValidatedCount: 0,
    structuralAudioCount: 0,
    structuralAudioValidatedCount: 0,
    lastEditAt: 0,
    validatorHistogram: {},
    structuralValidatorHistogram: {},
    audioValidatorHistogram: {},
    structuralAudioValidatorHistogram: {},
    textAudioValidatorHistogram: {},
    structuralTextAudioValidatorHistogram: {},
  }
}

function incHist(h: Record<string, number>, key: string): void {
  h[key] = (h[key] ?? 0) + 1
}

function addCellToAgg(
  agg: BucketAgg,
  opts: {
    filled: boolean
    structural: boolean
    textBucket: number
    hasDub: boolean
    audioVotes: number | null
    lastEditAt: number
  },
): void {
  agg.totalCount += 1
  if (opts.filled) agg.filledCount += 1
  if (opts.structural) {
    agg.structuralCount += 1
    if (opts.filled) agg.structuralFilledCount += 1
  }
  const tbKey = String(opts.textBucket)
  incHist(agg.validatorHistogram, tbKey)
  if (opts.structural) incHist(agg.structuralValidatorHistogram, tbKey)

  if (opts.hasDub) {
    agg.audioCount += 1
    if (opts.structural) agg.structuralAudioCount += 1
  }
  if (opts.audioVotes !== null) {
    const av = Math.min(opts.audioVotes, MAX_VALIDATOR_HISTOGRAM_BUCKET)
    if (opts.audioVotes >= 1) {
      agg.audioValidatedCount += 1
      if (opts.structural) agg.structuralAudioValidatedCount += 1
    }
    const abKey = String(av)
    incHist(agg.audioValidatorHistogram, abKey)
    if (opts.structural) incHist(agg.structuralAudioValidatorHistogram, abKey)

    const jointKey = `${opts.textBucket}:${av}`
    incHist(agg.textAudioValidatorHistogram, jointKey)
    if (opts.structural) incHist(agg.structuralTextAudioValidatorHistogram, jointKey)
  }
  if (opts.lastEditAt > agg.lastEditAt) agg.lastEditAt = opts.lastEditAt
}

const PROGRESS_UPSERT_BATCH = 200

const PROGRESS_COLUMNS = `
  project_id, file_id, scope, section_key, lane_id,
  total_count, filled_count, validator_histogram,
  structural_count, structural_filled_count, structural_validator_histogram,
  revision, updated_at,
  audio_count, audio_validated_count, last_edit_at,
  structural_audio_count, structural_audio_validated_count,
  audio_validator_histogram, structural_audio_validator_histogram,
  text_audio_validator_histogram, structural_text_audio_validator_histogram
`

const PROGRESS_UPSERT_SET = `
  total_count                               = excluded.total_count,
  filled_count                              = excluded.filled_count,
  validator_histogram                       = excluded.validator_histogram,
  structural_count                          = excluded.structural_count,
  structural_filled_count                   = excluded.structural_filled_count,
  structural_validator_histogram            = excluded.structural_validator_histogram,
  revision                                  = excluded.revision,
  updated_at                                = excluded.updated_at,
  audio_count                               = excluded.audio_count,
  audio_validated_count                     = excluded.audio_validated_count,
  last_edit_at                              = excluded.last_edit_at,
  structural_audio_count                    = excluded.structural_audio_count,
  structural_audio_validated_count          = excluded.structural_audio_validated_count,
  audio_validator_histogram                 = excluded.audio_validator_histogram,
  structural_audio_validator_histogram      = excluded.structural_audio_validator_histogram,
  text_audio_validator_histogram            = excluded.text_audio_validator_histogram,
  structural_text_audio_validator_histogram = excluded.structural_text_audio_validator_histogram
`

export interface VirtualProgressArgs {
  projectId: string
  fileId: string
  updatedAt: number
  /** Preloaded head + manifest (used right inside revisions-route to skip re-reading R2). */
  preloaded?: {
    head: VirtualFileHead
    manifest: StoredRevisionManifest
    /** True on brand-new revision 1 fresh import: skip querying sparse targets/audio/overlays. */
    freshEmptyTargets?: boolean
    /** Watermark revision seq if already known (e.g. just allocated). */
    revisionSeq?: number
  }
}

/**
 * Build the SQL statements that update `files` counters and `file_section_progress`
 * for a virtual source file, reading source structure from the R2 manifest
 * instead of Postgres `cells`.
 *
 * Returns null if the file is NOT virtual (caller falls back to SQL recompute).
 */
export async function buildVirtualFileProgressStmts(
  db: AquillaDb,
  r2: ManifestR2Bucket | undefined,
  args: VirtualProgressArgs,
): Promise<AquillaStatement[] | null> {
  if (!r2) return null
  const loaded = await loadVirtualSourceFile(db, r2, args.projectId, args.fileId, {
    head: args.preloaded?.head,
    manifest: args.preloaded?.manifest,
    skipSparseOverlays: args.preloaded?.freshEmptyTargets,
  })
  if (!loaded) return null

  const { projectId, fileId, updatedAt } = args
  const visibleRows = loaded.rows.filter((r) => r.hidden_at == null && r.tombstoned_at == null)
  const visibleCellIds = new Set(visibleRows.map((r) => r.cell_id))

  // Fetch lanes + sparse target rows + audio rollup + watermark in parallel.
  const [lanesRes, targetsRes, audioRes, watermarkRow] = await Promise.all([
    db
      .prepare(
        `SELECT l.id AS lane_id,
                COALESCE(l.legacy_tag, '') AS lane,
                CASE WHEN l.role = 'source' THEN NULL ELSE COALESCE(l.legacy_tag, '') END AS join_tag
           FROM public.lanes l
          WHERE l.project_id = ?`,
      )
      .bind(projectId)
      .all<LaneRow>(),
    args.preloaded?.freshEmptyTargets
      ? Promise.resolve({ results: [] as TargetRow[] })
      : db
          .prepare(
            `SELECT cell_id, lane_id, value, word_count, validated, endorsement_count, ai_drafted, last_edit_at
               FROM cells
              WHERE project_id = ? AND file_id = ? AND side = 'target'`,
          )
          .bind(projectId, fileId)
          .all<TargetRow>(),
    args.preloaded?.freshEmptyTargets
      ? Promise.resolve({ results: [] as AudioRollupRow[] })
      : db
          .prepare(`WITH audio AS (${AUDIO_CTE_SQL}) SELECT cell_id, lane, has_dub, dub_votes FROM audio`)
          .bind(projectId, fileId)
          .all<AudioRollupRow>(),
    args.preloaded?.revisionSeq !== undefined
      ? Promise.resolve({ revision: args.preloaded.revisionSeq })
      : db
          .prepare(
            `SELECT GREATEST(
               COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = ? AND file_id = ?), 0),
               COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?), 0)
             )::bigint AS revision`,
          )
          .bind(projectId, fileId, projectId)
          .first<{ revision: number | string }>(),
  ])

  const lanes = lanesRes.results ?? []
  const targets = targetsRes.results ?? []
  const audioRows = audioRes.results ?? []
  const revision = Number(watermarkRow?.revision ?? 0)

  // Index target rows by (lane_id, cell_id) and track source-less target cell ids.
  const targetByLaneCell = new Map<string, TargetRow>()
  const visibleTargetCellIds = new Set<string>()
  const structuralByCellId = new Map<string, boolean>()
  for (const r of visibleRows) {
    structuralByCellId.set(r.cell_id, STRUCTURAL_SET.has(r.type ?? ''))
  }

  let approvedCount = 0
  let filledCount = 0
  let wordCount = 0
  let lastEditAt: number | null = null
  let aiDraftedCount = 0
  let structuralFilledCount = 0
  let structuralApprovedCount = 0
  let structuralAiDraftedCount = 0

  for (const s of visibleRows) {
    if (lastEditAt === null || s.last_edit_at > lastEditAt) lastEditAt = s.last_edit_at
  }

  // Hidden/tombstoned source ids must filter out their target rows from file counters too.
  const hiddenOrTombstonedIds = new Set<string>()
  for (const r of loaded.rows) {
    if (r.hidden_at != null || r.tombstoned_at != null) hiddenOrTombstonedIds.add(r.cell_id)
  }
  for (const r of loaded.tombstonedRows) hiddenOrTombstonedIds.add(r.cell_id)

  for (const t of targets) {
    if (hiddenOrTombstonedIds.has(t.cell_id)) continue
    targetByLaneCell.set(`${t.lane_id}\0${t.cell_id}`, t)
    if (!visibleCellIds.has(t.cell_id)) visibleTargetCellIds.add(t.cell_id)

    const isStructural = structuralByCellId.get(t.cell_id) === true
    const isFilled = t.value.trim() !== ''
    const isValidated = Number(t.validated) === 1
    const isAiDrafted = Number(t.ai_drafted) === 1
    const tEdit = Number(t.last_edit_at)

    if (isFilled) {
      filledCount += 1
      if (isStructural) structuralFilledCount += 1
    }
    if (isValidated) {
      approvedCount += 1
      if (isStructural) structuralApprovedCount += 1
    }
    if (isAiDrafted) {
      aiDraftedCount += 1
      if (isStructural) structuralAiDraftedCount += 1
    }
    wordCount += Number(t.word_count ?? 0)
    if (lastEditAt === null || tEdit > lastEditAt) lastEditAt = tEdit
  }

  const cellCount = visibleRows.length + visibleTargetCellIds.size
  let structuralCellCount = 0
  for (const r of visibleRows) {
    if (STRUCTURAL_SET.has(r.type ?? '')) structuralCellCount += 1
  }

  // Index audio rows by (laneTag, cell_id).
  const audioByLaneCell = new Map<string, { hasDub: boolean; dubVotes: number | null }>()
  for (const a of audioRows) {
    audioByLaneCell.set(`${a.lane}\0${a.cell_id}`, {
      hasDub: Number(a.has_dub) === 1,
      dubVotes: a.dub_votes == null ? null : Number(a.dub_votes),
    })
  }

  const { hasBooks, keys } = resolveVirtualPlanKeys(visibleRows)
  const activeSections = new Set<string>()
  const activeBooks = new Set<string>()

  // Aggregate per (lane_id, scope, section_key).
  type RowKey = string
  interface ProgressOut {
    laneId: string
    scope: 'file' | 'section' | 'book'
    sectionKey: string
    agg: BucketAgg
  }
  const buckets = new Map<RowKey, ProgressOut>()
  const getBucket = (laneId: string, scope: 'file' | 'section' | 'book', sectionKey: string): BucketAgg => {
    const k = `${laneId}\0${scope}\0${sectionKey}`
    let entry = buckets.get(k)
    if (!entry) {
      entry = { laneId, scope, sectionKey, agg: emptyAgg() }
      buckets.set(k, entry)
    }
    return entry.agg
  }

  for (const lane of lanes) {
    for (const s of visibleRows) {
      const t = targetByLaneCell.get(`${lane.lane_id}\0${s.cell_id}`)
      const a = lane.join_tag !== null ? audioByLaneCell.get(`${lane.join_tag}\0${s.cell_id}`) : undefined
      const structural = STRUCTURAL_SET.has(s.type ?? '')
      const filled = t ? t.value.trim() !== '' : false
      const textBucket = Math.min(t ? Number(t.endorsement_count ?? 0) : 0, MAX_VALIDATOR_HISTOGRAM_BUCKET)
      const cellLastEdit = Math.max(s.last_edit_at, t ? Number(t.last_edit_at) : 0)
      const cellOpts = {
        filled,
        structural,
        textBucket,
        hasDub: a?.hasDub ?? false,
        audioVotes: a?.dubVotes ?? null,
        lastEditAt: cellLastEdit,
      }

      addCellToAgg(getBucket(lane.lane_id, 'file', ''), cellOpts)

      const planKey = keys.get(s.cell_id)
      if (planKey?.sectionKey) {
        activeSections.add(planKey.sectionKey)
        addCellToAgg(getBucket(lane.lane_id, 'section', planKey.sectionKey), cellOpts)
      }
      if (hasBooks && planKey?.bookKey) {
        activeBooks.add(planKey.bookKey)
        addCellToAgg(getBucket(lane.lane_id, 'book', planKey.bookKey), cellOpts)
      }
    }
  }

  const stmts: AquillaStatement[] = []

  // 1. Update `files` counters directly (no `cells` scan).
  stmts.push(
    db
      .prepare(
        `UPDATE files SET
           cell_count = ?,
           approved_count = ?,
           filled_count = ?,
           word_count = ?,
           last_edit_at = ?,
           ai_drafted_count = ?,
           structural_cell_count = ?,
           structural_filled_count = ?,
           structural_approved_count = ?,
           structural_ai_drafted_count = ?,
           updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .bind(
        cellCount,
        approvedCount,
        filledCount,
        wordCount,
        lastEditAt,
        aiDraftedCount,
        structuralCellCount,
        structuralFilledCount,
        structuralApprovedCount,
        structuralAiDraftedCount,
        updatedAt,
        fileId,
        projectId,
      ),
  )

  // 2. Upsert `file_section_progress` rows in bounded multi-row batches.
  const outRows = [...buckets.values()]
  for (let i = 0; i < outRows.length; i += PROGRESS_UPSERT_BATCH) {
    const chunk = outRows.slice(i, i + PROGRESS_UPSERT_BATCH)
    const placeholders = chunk
      .map(
        () =>
          `(?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?, ?, ?::text::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::text::jsonb, ?::text::jsonb, ?::text::jsonb, ?::text::jsonb)`,
      )
      .join(',\n')
    const binds: unknown[] = []
    for (const row of chunk) {
      const a = row.agg
      binds.push(
        projectId,
        fileId,
        row.scope,
        row.sectionKey,
        row.laneId,
        a.totalCount,
        a.filledCount,
        JSON.stringify(a.validatorHistogram),
        a.structuralCount,
        a.structuralFilledCount,
        JSON.stringify(a.structuralValidatorHistogram),
        revision,
        updatedAt,
        a.audioCount,
        a.audioValidatedCount,
        a.lastEditAt > 0 ? a.lastEditAt : null,
        a.structuralAudioCount,
        a.structuralAudioValidatedCount,
        JSON.stringify(a.audioValidatorHistogram),
        JSON.stringify(a.structuralAudioValidatorHistogram),
        JSON.stringify(a.textAudioValidatorHistogram),
        JSON.stringify(a.structuralTextAudioValidatorHistogram),
      )
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO file_section_progress (${PROGRESS_COLUMNS})
           VALUES ${placeholders}
           ON CONFLICT (project_id, file_id, scope, section_key, lane_id) DO UPDATE SET
             ${PROGRESS_UPSERT_SET}`,
        )
        .bind(...binds),
    )
  }

  // 3. Prune any stale section/book rows (or empty file rows) when not a fresh insert.
  if (!args.preloaded?.freshEmptyTargets) {
    if (visibleRows.length === 0) {
      stmts.push(
        db
          .prepare(`DELETE FROM file_section_progress WHERE project_id = ? AND file_id = ?`)
          .bind(projectId, fileId),
      )
    } else {
      const sectionList = [...activeSections]
      const bookList = hasBooks ? [...activeBooks] : []
      if (sectionList.length === 0) {
        stmts.push(
          db
            .prepare(`DELETE FROM file_section_progress WHERE project_id = ? AND file_id = ? AND scope = 'section'`)
            .bind(projectId, fileId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `DELETE FROM file_section_progress
                WHERE project_id = ? AND file_id = ? AND scope = 'section'
                  AND section_key NOT IN (${sectionList.map(() => '?').join(', ')})`,
            )
            .bind(projectId, fileId, ...sectionList),
        )
      }
      if (bookList.length === 0) {
        stmts.push(
          db
            .prepare(`DELETE FROM file_section_progress WHERE project_id = ? AND file_id = ? AND scope = 'book'`)
            .bind(projectId, fileId),
        )
      } else {
        stmts.push(
          db
            .prepare(
              `DELETE FROM file_section_progress
                WHERE project_id = ? AND file_id = ? AND scope = 'book'
                  AND section_key NOT IN (${bookList.map(() => '?').join(', ')})`,
            )
            .bind(projectId, fileId, ...bookList),
        )
      }
    }
  }

  return stmts
}
