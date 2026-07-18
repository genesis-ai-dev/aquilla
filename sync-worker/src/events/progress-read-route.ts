import { verifyTokenForProject } from '../auth'

export interface ProgressReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface ProgressRow {
  scope: 'file' | 'section'
  section_key: string
  total_count: number | string
  filled_count: number | string
  validator_histogram: Record<string, number> | string | null
  revision: number | string | bigint
}

export interface ProgressCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  validationLevels: number[]
}

export interface FileProgressResponse {
  fileId: string
  revision: number
  validationCount: number
  file: ProgressCounts
  sections: Array<{ key: string } & ProgressCounts>
  /** Present only while an additive migration has not yet been backfilled. */
  source?: 'projection' | 'file-counter-fallback'
}

export interface SectionProgressDetailResponse {
  fileId: string
  sectionKey: string
  revision: number
  validationCount: number
  verses: Array<{
    ref: string
    filled: boolean
    validated: boolean
  }>
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/progress$/
const SECTION_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/progress\/sections\/([^/]+)$/
const MAX_VALIDATION_LEVELS = 15
const BOOK_ORDER = [
  'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL',
  'MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV',
]
const BOOK_INDEX = new Map(BOOK_ORDER.map((book, index) => [book, index]))

function parseHistogram(raw: ProgressRow['validator_histogram']): Map<number, number> {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { value = null }
  }
  const out = new Map<number, number>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const bucket = Number(key)
    const amount = Number(count)
    if (Number.isInteger(bucket) && bucket >= 0 && Number.isFinite(amount) && amount > 0) {
      out.set(bucket, amount)
    }
  }
  return out
}

function counts(row: ProgressRow, validationCount: number): ProgressCounts {
  const histogram = parseHistogram(row.validator_histogram)
  const levelCap = Math.min(MAX_VALIDATION_LEVELS, Math.max(1, validationCount))
  const validationLevels = Array.from({ length: levelCap }, (_, index) => {
    const threshold = index + 1
    let count = 0
    for (const [bucket, amount] of histogram) if (bucket >= threshold) count += amount
    return count
  })
  return {
    totalCount: Number(row.total_count) || 0,
    filledCount: Number(row.filled_count) || 0,
    validatedCount: validationLevels[Math.min(levelCap, validationCount) - 1] ?? 0,
    validationLevels,
  }
}

function compareSections(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(\S+)\s+(\d+)/.exec(value.trim())
    return match
      ? { book: match[1].toUpperCase(), chapter: Number(match[2]) }
      : { book: value.toUpperCase(), chapter: Number.POSITIVE_INFINITY }
  }
  const left = parse(a)
  const right = parse(b)
  const leftBook = BOOK_INDEX.get(left.book)
  const rightBook = BOOK_INDEX.get(right.book)
  if (leftBook != null || rightBook != null) {
    if (leftBook == null) return 1
    if (rightBook == null) return -1
    if (leftBook !== rightBook) return leftBook - rightBook
  } else {
    const bookOrder = left.book.localeCompare(right.book)
    if (bookOrder !== 0) return bookOrder
  }
  return left.chapter - right.chapter || a.localeCompare(b)
}

function compareCanonicalRefs(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^(\S+)\s+(\d+):(\d+)(?:-(\d+))?/.exec(value.trim())
    return match
      ? { section: `${match[1]} ${match[2]}`, verse: Number(match[3]), end: Number(match[4] ?? match[3]) }
      : { section: value, verse: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY }
  }
  const left = parse(a)
  const right = parse(b)
  return compareSections(left.section, right.section)
    || left.verse - right.verse
    || left.end - right.end
    || a.localeCompare(b)
}

async function readValidationCount(db: AquillaDb, projectId: string): Promise<number> {
  const row = await db
    .prepare('SELECT settings FROM project_settings WHERE project_id = ?')
    .bind(projectId)
    .first<{ settings: string | null }>()
  try {
    const parsed = row?.settings ? JSON.parse(row.settings) as { validationCount?: unknown } : null
    const value = Math.floor(Number(parsed?.validationCount))
    return Number.isFinite(value) ? Math.min(MAX_VALIDATION_LEVELS, Math.max(1, value)) : 1
  } catch {
    return 1
  }
}

export async function handleProgressReadRequest(
  request: Request,
  env: ProgressReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname
  const match = pathname.match(PATH_RE)
  const sectionMatch = pathname.match(SECTION_PATH_RE)
  if ((!match && !sectionMatch) || request.method !== 'GET') return null
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  // AQU-538: progress is materialized per target-language lane. Default to the
  // legacy/default lane ('') so N=1 projects are byte-identical; an explicit
  // ?lane=<tag> selects a non-default lane's rows.
  const lane = url.searchParams.get('lane') ?? ''

  const routeMatch = sectionMatch ?? match!
  const projectId = decodeURIComponent(routeMatch[1])
  const fileId = decodeURIComponent(routeMatch[2])
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return new Response('missing Authorization header', { status: 401 })
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  if (sectionMatch) {
    const sectionKey = decodeURIComponent(sectionMatch[3]).trim()
    const [rowsResult, validationCount, revisionRow] = await Promise.all([
      env.AQUILLA_PG.prepare(
        `SELECT s.canonical_ref,
                COALESCE(t.value, '') AS target_value,
                COALESCE(t.endorsement_count, 0) AS endorsement_count
           FROM cells s
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
            AND t.target_lang = ?
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
            AND BTRIM(CASE
                  WHEN POSITION(':' IN COALESCE(s.canonical_ref, '')) > 0
                    THEN SPLIT_PART(s.canonical_ref, ':', 1)
                  ELSE COALESCE(s.canonical_ref, '')
                END) = ?`,
      ).bind(lane, projectId, fileId, sectionKey).all<{
        canonical_ref: string | null
        target_value: string
        endorsement_count: number | string
      }>(),
      readValidationCount(env.AQUILLA_PG, projectId),
      env.AQUILLA_PG.prepare(
        `SELECT revision FROM file_section_progress
          WHERE project_id = ? AND file_id = ? AND scope = 'section' AND section_key = ? AND target_lang = ?`,
      ).bind(projectId, fileId, sectionKey, lane).first<{ revision: number | string | bigint }>(),
    ])
    const revision = Number(revisionRow?.revision) || 0
    // Default lane ('') keeps the legacy etag byte-for-byte; non-default lanes
    // append a lane segment so caches never cross lanes.
    const laneTag = lane ? `:lane:${encodeURIComponent(lane)}` : ''
    const etag = `"progress:${fileId}:${encodeURIComponent(sectionKey)}:${revision}:v${validationCount}${laneTag}"`
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
    }
    const body: SectionProgressDetailResponse = {
      fileId,
      sectionKey,
      revision,
      validationCount,
      verses: rowsResult.results
        .filter((row): row is typeof row & { canonical_ref: string } => Boolean(row.canonical_ref))
        .map((row) => ({
          ref: row.canonical_ref,
          filled: row.target_value.trim().length > 0,
          validated: Number(row.endorsement_count) >= validationCount,
        }))
        .sort((a, b) => compareCanonicalRefs(a.ref, b.ref)),
    }
    return Response.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  const [rowsResult, validationCount] = await Promise.all([
    env.AQUILLA_PG
      .prepare(
        `SELECT scope, section_key, total_count, filled_count, validator_histogram, revision
           FROM file_section_progress
          WHERE project_id = ? AND file_id = ? AND target_lang = ?`,
      )
      .bind(projectId, fileId, lane)
      .all<ProgressRow>(),
    readValidationCount(env.AQUILLA_PG, projectId),
  ])

  let rows = rowsResult.results
  let source: FileProgressResponse['source'] = 'projection'
  if (rows.length === 0) {
    const fallback = await env.AQUILLA_PG
      .prepare(
        `SELECT f.cell_count AS total_count, f.filled_count, f.approved_count,
                GREATEST(
                  COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = f.project_id AND file_id = f.id), 0),
                  COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = f.project_id), 0)
                ) AS revision
           FROM files f WHERE f.project_id = ? AND f.id = ?`,
      )
      .bind(projectId, fileId)
      .first<{ total_count: number; filled_count: number; approved_count: number; revision: number }>()
    if (!fallback) return new Response('file not found', { status: 404 })
    const histogram = fallback.approved_count > 0 ? { [String(validationCount)]: fallback.approved_count } : {}
    rows = [{
      scope: 'file', section_key: '', total_count: fallback.total_count,
      filled_count: fallback.filled_count, validator_histogram: histogram,
      revision: fallback.revision,
    }]
    source = 'file-counter-fallback'
  }

  const fileRow = rows.find((row) => row.scope === 'file')
  if (!fileRow) return new Response('progress backfill pending', { status: 503 })
  const revision = Math.max(0, ...rows.map((row) => Number(row.revision) || 0))
  // A backfill can replace the rollout fallback without advancing the event
  // sequence. Include the source so clients cannot retain an empty fallback
  // through a false 304 after projection rows appear.
  const laneTag = lane ? `:lane:${encodeURIComponent(lane)}` : ''
  const etag = `"progress:${fileId}:${revision}:v${validationCount}:${source === 'projection' ? 'p' : 'f'}${laneTag}"`
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  const body: FileProgressResponse = {
    fileId,
    revision,
    validationCount,
    file: counts(fileRow, validationCount),
    sections: rows
      .filter((row) => row.scope === 'section')
      .sort((a, b) => compareSections(a.section_key, b.section_key))
      .map((row) => ({ key: row.section_key, ...counts(row, validationCount) })),
    source,
  }
  return Response.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
}
