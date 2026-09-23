import { verifyTokenForProject } from '../auth'
import { canReadRequestedLane, visibleLanesForRead } from './lane-read-wall'
import { targetLaneDualReadBinds, targetLaneDualReadSql } from './lane-id-sql'
import { readCountStructuralCells, structuralPredicateSql } from './structural-cells'
import { walkAnchorChain } from './cells-read-route'

export interface ProgressReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** AQU-730: "1" enforces lane grants on this read. Unset = every lane (today). */
  LANE_READ_WALL?: string
}

interface ProgressRow {
  scope: 'file' | 'section' | 'book'
  section_key: string
  total_count: number | string
  filled_count: number | string
  validator_histogram: Record<string, number> | string | null
  // AQU-1083: the structural subset of the three above, recorded by the
  // projection whatever the policy says, so excluding headings is a
  // subtraction here rather than a reprojection over there. Optional because
  // plan-route builds rows by hand; absent reads as nothing to subtract.
  structural_count?: number | string | null
  structural_filled_count?: number | string | null
  structural_validator_histogram?: Record<string, number> | string | null
  revision: number | string | bigint
  // AQU-1098: written by the projection since 0088. Optional for the same
  // reason the structural trio is — a caller may build a row by hand.
  audio_count?: number | string | null
  audio_validated_count?: number | string | null
  // AQU-1278: the structural share of the audio pair (0094), subtracted by the
  // same policy that subtracts the text one. Absent on a row the backfill has
  // not reached yet, which reads as nothing to subtract — today's behaviour.
  structural_audio_count?: number | string | null
  structural_audio_validated_count?: number | string | null
}

export interface ProgressCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  validationLevels: number[]
  /**
   * AQU-1098: source cells carrying a live take, and those whose take is
   * selected AND approved. Same rule the org portfolio counts by, so a
   * chapter's audio and the project's audio can never disagree.
   */
  audioCount: number
  audioValidatedCount: number
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
    /**
     * AQU-1278: the SOURCE cell's id, so the plan board can deep-link the
     * editor (?cellId=<id>) at the first outstanding cell of a unit. It has to
     * come from the source row: the target join is a LEFT JOIN, so `t.cell_id`
     * is NULL for exactly the untranslated verses the link exists to reach.
     */
    cellId: string
    ref: string
    filled: boolean
    validated: boolean
    /**
     * AQU-1278, round 5: the verse's own takes, so the chapter card can list the
     * unrecorded verses the way it lists the unvalidated ones. Own cells only —
     * a dubbing project's takes live on its cue sheet, and a subtitle file has
     * no chapter card to draw them on.
     */
    recorded: boolean
    audioValidated: boolean
  }>
}

/**
 * The four queues a plan link can point at, in the order the board names them:
 * text before audio, and within each, the job that unblocks the other first.
 * Mirrors `planOpenKind` on the client.
 */
export const PLAN_OPEN_KINDS = ['untranslated', 'unvalidated', 'unrecorded', 'unsigned'] as const
export type PlanOpenKind = (typeof PLAN_OPEN_KINDS)[number]
/**
 * Everywhere a plan link can land: the four queues, plus `first` — the unit's
 * first cell in document order, outstanding or not. That one exists for a
 * BOOK inside a Scripture file (Sam, 2026-09-17): the editor deep-links to a
 * cell and nothing else, so "open Revelation" can only mean "open the Bible
 * file at Revelation's first verse", and only the server knows which cell
 * that is.
 */
export const PLAN_LANDING_KINDS = [...PLAN_OPEN_KINDS, 'first'] as const
export type PlanLandingKind = (typeof PLAN_LANDING_KINDS)[number]

export interface PlanFirstOpenResponse {
  fileId: string
  /** The unit's section key: a book code, or '' for a whole file. */
  unit: string
  kind: PlanLandingKind
  /** The SOURCE cell to land on, or null when nothing in the unit is outstanding in that queue. */
  cellId: string | null
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/progress$/
const SECTION_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/progress\/sections\/([^/]+)$/
const FIRST_OPEN_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/progress\/first-open$/
const MAX_VALIDATION_LEVELS = 15
const BOOK_ORDER = [
  'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL',
  'MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV',
]
export const BOOK_INDEX = new Map(BOOK_ORDER.map((book, index) => [book, index]))

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

/**
 * The numbers a row reports, with the policy applied. `countStructural`
 * defaults to counting — the behaviour every caller had before the setting
 * existed — so a caller that has not resolved the policy gets today's numbers.
 */
export function counts(
  row: ProgressRow,
  validationCount: number,
  countStructural = true,
): ProgressCounts {
  const histogram = parseHistogram(row.validator_histogram)
  if (!countStructural) {
    // Bucket-wise, because the levels are cumulative on read: a validated
    // chapter title would otherwise still be counted at every level below it.
    for (const [bucket, amount] of parseHistogram(row.structural_validator_histogram ?? null)) {
      const remaining = (histogram.get(bucket) ?? 0) - amount
      if (remaining > 0) histogram.set(bucket, remaining)
      else histogram.delete(bucket)
    }
  }
  const levelCap = Math.min(MAX_VALIDATION_LEVELS, Math.max(1, validationCount))
  const validationLevels = Array.from({ length: levelCap }, (_, index) => {
    const threshold = index + 1
    let count = 0
    for (const [bucket, amount] of histogram) if (bucket >= threshold) count += amount
    return count
  })
  const structuralTotal = countStructural ? 0 : Number(row.structural_count) || 0
  const structuralFilled = countStructural ? 0 : Number(row.structural_filled_count) || 0
  // AQU-1278: recorded headings leave the audio numbers with the headings
  // themselves. Before this the policy shrank the denominator and left the
  // numerator alone, so a book whose chapter headings were voiced reported
  // more audio than it had cells.
  const structuralAudio = countStructural ? 0 : Number(row.structural_audio_count) || 0
  const structuralAudioValidated =
    countStructural ? 0 : Number(row.structural_audio_validated_count) || 0
  return {
    // Clamped at zero: an un-backfilled row has structural counts of 0, but a
    // partially backfilled one must never report a negative denominator.
    totalCount: Math.max(0, (Number(row.total_count) || 0) - structuralTotal),
    filledCount: Math.max(0, (Number(row.filled_count) || 0) - structuralFilled),
    validatedCount: validationLevels[Math.min(levelCap, validationCount) - 1] ?? 0,
    validationLevels,
    audioCount: Math.max(0, (Number(row.audio_count) || 0) - structuralAudio),
    audioValidatedCount: Math.max(
      0,
      (Number(row.audio_validated_count) || 0) - structuralAudioValidated,
    ),
  }
}

/**
 * Book order, then chapter order. A key with no chapter number — a book's
 * front matter section ("GEN"), or a cell reference the importer shaped as
 * "GEN:h:1" — belongs to its BOOK and sorts BEFORE chapter 1, which is where
 * the editor shows it and where the file put it. It used to sort after the
 * last chapter, and with the whole value taken as the book name, after every
 * known book: "Go to first untranslated" walked past an untranslated title to
 * land on 1:1, or found nothing at all.
 */
function compareSections(a: string, b: string): number {
  const parse = (value: string) => {
    const trimmed = value.trim()
    const match = /^(\S+)\s+(\d+)/.exec(trimmed)
    return match
      ? { book: match[1].toUpperCase(), chapter: Number(match[2]) }
      : { book: (trimmed.split(/[\s:]/)[0] ?? trimmed).toUpperCase(), chapter: -1 }
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

/**
 * Document order for cells, as their references describe it. Verses sort by
 * number inside their chapter. Anything a chapter carries that is NOT a verse
 * — a heading ("GEN 1:0"), text before the first verse ("GEN 2"), a book's
 * front matter ("GEN:h:1") — sorts to the FRONT of its chapter or book, not
 * the back: that is where the file has it and where the editor draws it.
 * A one-chapter book's "TIT:4" is verse 4 of its only chapter.
 */
function compareCanonicalRefs(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^([^\s:]+)(?:\s+(\d+))?:(\d+)(?:-(\d+))?/.exec(value.trim())
    return match
      ? {
          section: match[2] != null ? `${match[1]} ${match[2]}` : match[1],
          verse: Number(match[3]),
          end: Number(match[4] ?? match[3]),
        }
      : { section: value, verse: -1, end: -1 }
  }
  const left = parse(a)
  const right = parse(b)
  return compareSections(left.section, right.section)
    || left.verse - right.verse
    || left.end - right.end
    || a.localeCompare(b)
}

export async function readValidationCount(db: AquillaDb, projectId: string): Promise<number> {
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

/**
 * A cell's chapter key, as the projection derives it: everything before the
 * ':' of `canonical_ref` ("GEN 12" from "GEN 12:4"), or the whole ref where
 * there is no ':' (a bare "GEN"), or '' where there is no ref at all.
 */
function chapterKeySql(alias: string): string {
  return `BTRIM(CASE
                  WHEN POSITION(':' IN COALESCE(${alias}.canonical_ref, '')) > 0
                    THEN SPLIT_PART(${alias}.canonical_ref, ':', 1)
                  ELSE COALESCE(${alias}.canonical_ref, '')
                END)`
}

/**
 * Does the cell at (`fileExpr`, `cellExpr`) carry a live take — or, with
 * `signed`, one that is selected AND approved? The definitions are the
 * projection's (`AUDIO_CTE_SQL`): a cell HAS audio when any take is live, and
 * is validated when its selected take is approved. Correlated on `s`, the
 * source-cell alias every query here uses, for the project id.
 */
function liveTakeSql(fileExpr: string, cellExpr: string, signed: boolean): string {
  return `EXISTS (SELECT 1 FROM cell_audio a
                   WHERE a.project_id = s.project_id AND a.file_id = ${fileExpr}
                     AND a.cell_id = ${cellExpr} AND a.deleted = 0${
                       signed ? ' AND a.selected = 1 AND a.approved = 1' : ''
                     })`
}

interface FirstOpenRow {
  cell_id: string
  canonical_ref: string | null
  anchor_cell_id: string | null
  event_id: string
  start_ms: number | string | null
  // The queue-specific columns are selected ONLY for the queue that reads
  // them — see readFirstOpenCell. Absent means "this kind never asks".
  target_value?: string
  endorsement_count?: number | string
  has_take?: boolean
  take_signed?: boolean
  cues_unrecorded?: number | string
  cues_unsigned?: number | string
}

/**
 * The cells of one unit in DOCUMENT ORDER, decided the way the editor decides
 * it: Scripture by canonical reference, a timed file by its start times, and
 * anything else by walking the anchor chain. One rule per shape, and the
 * shape is read off the rows rather than off `files.kind`, which falls back
 * through `role` to 'codex' and cannot be trusted to say what a file is.
 */
function inDocumentOrder<T extends FirstOpenRow>(rows: T[]): T[] {
  if (rows.some((r) => r.canonical_ref)) {
    const withRef = rows
      .filter((r) => r.canonical_ref)
      .sort((a, b) => compareCanonicalRefs(a.canonical_ref!, b.canonical_ref!))
    return [...withRef, ...rows.filter((r) => !r.canonical_ref)]
  }
  if (rows.some((r) => r.start_ms != null)) {
    const at = (r: T) => (r.start_ms == null ? Number.POSITIVE_INFINITY : Number(r.start_ms))
    return [...rows].sort((a, b) => at(a) - at(b))
  }
  return walkAnchorChain(rows)
}

/**
 * AQU-1278, round 5: the first cell of a unit that is outstanding in one
 * queue — where "Go to first untranslated / unvalidated / unrecorded /
 * take to sign off" lands.
 *
 * Server-side because only the server can answer it for every shape at once.
 * The client used to walk a book's chapters and read one chapter's verses,
 * which worked for Scripture and for nothing else: a Word document has no
 * chapters to walk and a subtitle file's sections are time buckets nobody
 * plans by, so on both the link opened the file and stopped. And audio could
 * never be asked at all — the verse detail carried no take state, and on a
 * dubbing project the takes are not even on this file.
 *
 * `unit` is the unit's section key: '' for a whole file, a book code for a
 * book inside a Scripture file (its scope is every chapter of that book plus
 * its bare front-matter key). THE CUE SHEET: where the file has an anchored
 * `audio-cues` sibling, a subtitle cell is "unrecorded" when a cue it links
 * to has no live take, and "unsigned" when a linked cue's take is not yet
 * selected and approved — the link lands on the subtitle cell, which is the
 * one the editor can open, and the cue is a click away from it. Newest sheet
 * wins, as everywhere. A subtitle cell with no linked cue has nothing to
 * record and is never a target.
 *
 * The structural policy applies: a heading the project does not count is not
 * a cell to be sent to.
 */
export async function readFirstOpenCell(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  unit: string,
  kind: PlanLandingKind,
  lane: string,
): Promise<string | null> {
  // EACH QUEUE PAYS ONLY FOR ITS OWN QUESTION. This query walks every source
  // cell of the unit, so anything computed per row is multiplied by the file:
  // on a whole Bible that is tens of thousands of rows, and this runs on a
  // click. The text queues never read the audio columns, the audio queues
  // never read the target join, and `first` reads neither — so each column
  // and join below is included only for the queue that asks it. Measured on
  // the fixture Bible this took the common text-queue click from ~12ms to a
  // fraction of it; production files are twenty times that size.
  const wantsText = kind === 'untranslated' || kind === 'unvalidated'
  const wantsAudio = kind === 'unrecorded' || kind === 'unsigned'
  const [countStructural, validationCount, sheet] = await Promise.all([
    readCountStructuralCells(db, projectId),
    // Only the unvalidated queue compares endorsements against the threshold.
    kind === 'unvalidated' ? readValidationCount(db, projectId) : Promise.resolve(1),
    // The cue sheet can only matter to the audio queues, and looking it up IS
    // the direct test for whether this unit records against one — no need to
    // guess from the file's kind.
    wantsAudio
      ? db.prepare(
          `SELECT id FROM files
            WHERE project_id = ? AND anchor_file_id = ? AND role = 'audio-cues' AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 1`,
        ).bind(projectId, fileId).first<{ id: string }>()
      : Promise.resolve(null),
  ])
  const sheetId = sheet?.id ?? ''
  const onSheet = sheetId !== ''
  const key = chapterKeySql('s')
  const linkedCues = (predicate: string) =>
    `(SELECT COUNT(*) FROM cell_links l
       WHERE l.project_id = s.project_id AND l.kind = 'text-audio' AND l.linked = 1
         AND l.from_file_id = s.file_id AND l.from_cell_id = s.cell_id AND l.to_file_id = ?
         AND ${predicate})`
  const cueTake = liveTakeSql('l.to_file_id', 'l.to_cell_id', false)
  const cueSigned = liveTakeSql('l.to_file_id', 'l.to_cell_id', true)

  const columns = [`s.cell_id, s.canonical_ref, s.anchor_cell_id, s.event_id, s.start_ms`]
  const binds: unknown[] = []
  if (wantsText) {
    columns.push(`COALESCE(t.value, '') AS target_value`,
      `COALESCE(t.endorsement_count, 0) AS endorsement_count`)
  }
  if (wantsAudio) {
    if (onSheet) {
      // On a cue-linked unit the takes live on the SHEET's cells; the unit's
      // own take state is meaningless and is not asked for.
      columns.push(`${linkedCues(`NOT ${cueTake}`)} AS cues_unrecorded`,
        `${linkedCues(`${cueTake} AND NOT ${cueSigned}`)} AS cues_unsigned`)
      binds.push(sheetId, sheetId)
    } else {
      columns.push(`${liveTakeSql('s.file_id', 's.cell_id', false)} AS has_take`,
        `${liveTakeSql('s.file_id', 's.cell_id', true)} AS take_signed`)
    }
  }
  // AQU-1240 slice 7: the lane join dual-reads (lane_id once backfilled,
  // target_lang while it is still NULL) like every other hot read here.
  const targetJoin = wantsText
    ? `LEFT JOIN cells t
         ON t.project_id = s.project_id AND t.file_id = s.file_id
        AND t.cell_id = s.cell_id AND t.side = 'target' AND ${targetLaneDualReadSql('t')}`
    : ''
  if (wantsText) binds.push(...targetLaneDualReadBinds(projectId, lane))
  binds.push(projectId, fileId)
  if (unit) binds.push(unit, `${unit} %`)

  const { results } = await db.prepare(
    `SELECT ${columns.join(`,
            `)}
       FROM cells s
       ${targetJoin}
      WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
        ${unit ? `AND (${key} = ? OR ${key} LIKE ?)` : ''}
        ${countStructural ? '' : `AND NOT (${structuralPredicateSql('s')})`}`,
  ).bind(...binds).all<FirstOpenRow>()

  const outstanding = (r: FirstOpenRow): boolean => {
    const filled = (r.target_value ?? '').trim().length > 0
    switch (kind) {
      case 'untranslated': return !filled
      case 'unvalidated': return filled && Number(r.endorsement_count ?? 0) < validationCount
      case 'unrecorded': return onSheet ? Number(r.cues_unrecorded ?? 0) > 0 : !r.has_take
      case 'unsigned': return onSheet ? Number(r.cues_unsigned ?? 0) > 0 : r.has_take === true && !r.take_signed
      // The unit's first cell, whatever its state — still in document order,
      // still under the structural policy, so a book opens at its first
      // COUNTED cell and not on a heading the project does not count.
      case 'first': return true
    }
  }
  return inDocumentOrder(results ?? []).find(outstanding)?.cell_id ?? null
}

export async function handleProgressReadRequest(
  request: Request,
  env: ProgressReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname
  const match = pathname.match(PATH_RE)
  const sectionMatch = pathname.match(SECTION_PATH_RE)
  const firstOpenMatch = pathname.match(FIRST_OPEN_PATH_RE)
  if ((!match && !sectionMatch && !firstOpenMatch) || request.method !== 'GET') return null
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  // AQU-538: progress is materialized per target-language lane. Default to the
  // legacy/default lane ('') so N=1 projects are byte-identical; an explicit
  // ?lane=<tag> selects a non-default lane's rows.
  const lane = url.searchParams.get('lane') ?? ''

  const routeMatch = firstOpenMatch ?? sectionMatch ?? match!
  const projectId = decodeURIComponent(routeMatch[1])
  const fileId = decodeURIComponent(routeMatch[2])
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return new Response('missing Authorization header', { status: 401 })
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // AQU-730: a restricted caller may read only a lane they were granted.
  // The unscoped `files` counter fallback below is not per-lane, so once the
  // wall is on it must not run for a restricted caller — it would report
  // another lane's totals. 600+ stays unrestricted (visible === null).
  const visibleLanes = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  const laneAllowed = await canReadRequestedLane(env.AQUILLA_PG, projectId, visibleLanes, lane)
  if (!laneAllowed) {
    const hiddenHeaders = { 'Cache-Control': 'private, no-store' }
    if (firstOpenMatch) {
      const kindParam = url.searchParams.get('kind') ?? ''
      const kind = (PLAN_LANDING_KINDS as readonly string[]).includes(kindParam)
        ? kindParam as PlanLandingKind
        : 'first'
      const body: PlanFirstOpenResponse = {
        fileId,
        unit: (url.searchParams.get('unit') ?? '').trim(),
        kind,
        cellId: null,
      }
      return Response.json(body, { headers: hiddenHeaders })
    }
    if (sectionMatch) {
      const body: SectionProgressDetailResponse = {
        fileId,
        sectionKey: decodeURIComponent(sectionMatch[3]).trim(),
        revision: 0,
        validationCount: 1,
        verses: [],
      }
      return Response.json(body, { headers: hiddenHeaders })
    }
    const body: FileProgressResponse = {
      fileId,
      revision: 0,
      validationCount: 1,
      file: {
        totalCount: 0, filledCount: 0, validatedCount: 0, validationLevels: [0],
        audioCount: 0, audioValidatedCount: 0,
      },
      sections: [],
      source: 'projection',
    }
    return Response.json(body, { headers: hiddenHeaders })
  }

  if (firstOpenMatch) {
    const unit = (url.searchParams.get('unit') ?? '').trim()
    const kindParam = url.searchParams.get('kind') ?? ''
    if (!(PLAN_LANDING_KINDS as readonly string[]).includes(kindParam)) {
      return new Response(`unknown kind: ${kindParam}`, { status: 400 })
    }
    const kind = kindParam as PlanLandingKind
    const cellId = await readFirstOpenCell(env.AQUILLA_PG, projectId, fileId, unit, kind, lane)
    const body: PlanFirstOpenResponse = { fileId, unit, kind, cellId }
    // A click, not a poll: no ETag, and nothing to keep — the answer moves
    // with every edit and the reader is about to be taken to it.
    return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  if (sectionMatch) {
    const sectionKey = decodeURIComponent(sectionMatch[3]).trim()
    const countStructural = await readCountStructuralCells(env.AQUILLA_PG, projectId)
    const [rowsResult, validationCount, revisionRow] = await Promise.all([
      env.AQUILLA_PG.prepare(
        `SELECT s.cell_id,
                s.canonical_ref,
                COALESCE(t.value, '') AS target_value,
                COALESCE(t.endorsement_count, 0) AS endorsement_count,
                ${liveTakeSql('s.file_id', 's.cell_id', false)} AS has_take,
                ${liveTakeSql('s.file_id', 's.cell_id', true)} AS take_signed
           FROM cells s
           LEFT JOIN cells t
             ON t.project_id = s.project_id
            AND t.file_id = s.file_id
            AND t.cell_id = s.cell_id
            AND t.side = 'target'
            AND ${targetLaneDualReadSql('t')}
          WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
            AND ${chapterKeySql('s')} = ?
            ${countStructural ? '' : `AND NOT (${structuralPredicateSql('s')})`}`,
      ).bind(...targetLaneDualReadBinds(projectId, lane), projectId, fileId, sectionKey).all<{
        cell_id: string
        canonical_ref: string | null
        target_value: string
        endorsement_count: number | string
        has_take: boolean
        take_signed: boolean
      }>(),
      readValidationCount(env.AQUILLA_PG, projectId),
      env.AQUILLA_PG.prepare(
        `SELECT revision FROM file_section_progress
          WHERE project_id = ? AND file_id = ? AND scope = 'section' AND section_key = ?
            AND ${targetLaneDualReadSql()}`,
      ).bind(projectId, fileId, sectionKey, ...targetLaneDualReadBinds(projectId, lane)).first<{ revision: number | string | bigint }>(),
    ])
    const revision = Number(revisionRow?.revision) || 0
    // Default lane ('') keeps the legacy etag byte-for-byte; non-default lanes
    // append a lane segment so caches never cross lanes.
    const laneTag = lane ? `:lane:${encodeURIComponent(lane)}` : ''
    // The policy is part of the cache key. Without it a reader who flips the
    // switch keeps being served the arrangement they just changed away from.
    const structuralTag = countStructural ? '' : ':nostruct'
    // `s2` marks the response SHAPE, the way the file-level ETag below has since
    // AQU-1098. This key went without a shape marker for as long as the shape
    // never changed; the day it did — AQU-1278 adding `cellId` to every verse —
    // it needed one, because nothing else in the key moves when only the shape
    // moves. Revision, validationCount, the policy and the lane are all
    // properties of the DATA, so a client holding a pre-cellId body would have
    // been handed a 304 forever and the plan board's "go to the first
    // outstanding cell" link would have silently done nothing, on exactly the
    // chapters a user had already looked at. `s3` is the same lesson applied
    // again, for the two audio flags each verse carries now.
    const etag = `"progress:${fileId}:${encodeURIComponent(sectionKey)}:${revision}:v${validationCount}:s3${structuralTag}${laneTag}"`
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
          cellId: row.cell_id,
          ref: row.canonical_ref,
          filled: row.target_value.trim().length > 0,
          validated: Number(row.endorsement_count) >= validationCount,
          recorded: row.has_take,
          audioValidated: row.take_signed,
        }))
        .sort((a, b) => compareCanonicalRefs(a.ref, b.ref)),
    }
    return Response.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  const countStructural = await readCountStructuralCells(env.AQUILLA_PG, projectId)
  const [rowsResult, validationCount] = await Promise.all([
    env.AQUILLA_PG
      .prepare(
        `SELECT scope, section_key, total_count, filled_count, validator_histogram,
                structural_count, structural_filled_count, structural_validator_histogram,
                revision, audio_count, audio_validated_count,
                structural_audio_count, structural_audio_validated_count
           FROM file_section_progress
          WHERE project_id = ? AND file_id = ? AND ${targetLaneDualReadSql()}`,
      )
      .bind(projectId, fileId, ...targetLaneDualReadBinds(projectId, lane))
      .all<ProgressRow>(),
    readValidationCount(env.AQUILLA_PG, projectId),
  ])

  let rows = rowsResult.results
  let source: FileProgressResponse['source'] = 'projection'
  if (rows.length === 0) {
    const fallback = await env.AQUILLA_PG
      .prepare(
        `SELECT f.cell_count AS total_count, f.filled_count, f.approved_count,
                f.structural_cell_count, f.structural_filled_count, f.structural_approved_count,
                GREATEST(
                  COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = f.project_id AND file_id = f.id), 0),
                  COALESCE((SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = f.project_id), 0)
                ) AS revision
           FROM files f WHERE f.project_id = ? AND f.id = ?`,
      )
      .bind(projectId, fileId)
      .first<{
        total_count: number; filled_count: number; approved_count: number
        structural_cell_count: number; structural_filled_count: number
        structural_approved_count: number; revision: number
      }>()
    if (!fallback) return new Response('file not found', { status: 404 })
    const histogram = fallback.approved_count > 0 ? { [String(validationCount)]: fallback.approved_count } : {}
    // The fallback fakes a histogram by parking every approved cell at the
    // threshold, so the structural one has to be faked the same way or the
    // subtraction would not line up on a bucket.
    const structuralHistogram = fallback.structural_approved_count > 0
      ? { [String(validationCount)]: fallback.structural_approved_count }
      : {}
    rows = [{
      scope: 'file', section_key: '', total_count: fallback.total_count,
      filled_count: fallback.filled_count, validator_histogram: histogram,
      structural_count: fallback.structural_cell_count,
      structural_filled_count: fallback.structural_filled_count,
      structural_validator_histogram: structuralHistogram,
      revision: fallback.revision,
      // `files` carries no audio rollup — the projection is the only source,
      // and this branch runs only before it has been backfilled.
      audio_count: 0, audio_validated_count: 0,
      structural_audio_count: 0, structural_audio_validated_count: 0,
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
  // `s3` marks the response SHAPE. Without it a client holding a cached body
  // from an older shape would 304 and keep it forever: the shape changed
  // without the revision moving. The structural policy is part of the key for
  // the same reason — flipping it changes every number without moving the
  // revision either. s2 = audio counts added (AQU-1098); s3 = recorded
  // headings left those counts (AQU-1278), which the 0094 backfill applies to
  // existing rows without touching a single event sequence.
  const structuralTag = countStructural ? '' : ':nostruct'
  const etag = `"progress:${fileId}:${revision}:v${validationCount}:${source === 'projection' ? 'p' : 'f'}:s3${structuralTag}${laneTag}"`
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  const sectionRows = rows.filter((row) => row.scope === 'section')
  const body: FileProgressResponse = {
    fileId,
    revision,
    validationCount,
    file: counts(fileRow, validationCount, countStructural),
    sections: sectionRows
      .sort((a, b) => compareSections(a.section_key, b.section_key))
      .map((row) => ({
        key: row.section_key,
        rawTotal: Number(row.total_count) || 0,
        ...counts(row, validationCount, countStructural),
      }))
      // A section made ENTIRELY of structural cells — USFM front matter is one,
      // its \h/\toc/\mt lines all sitting before chapter 1 — has nothing left
      // in it once the policy excludes them. Without this the sidebar keeps a
      // tile for that section reading 0%, which is a section that no longer
      // exists reporting that no work has been done on it. Only the ones the
      // subtraction emptied are dropped; a section that is empty under both
      // policies is left exactly as it is today.
      .filter((section) => section.totalCount > 0 || section.rawTotal === 0)
      .map(({ rawTotal: _rawTotal, ...section }) => section),
    source,
  }
  return Response.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
}
