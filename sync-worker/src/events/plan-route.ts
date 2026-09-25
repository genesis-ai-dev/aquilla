// AQU-1092…1098: the project's PLAN — one row per planning unit, carrying the
// progress the board draws and the target date / Done mark a manager sets.
//
//   GET  /api/v1/projects/:projectId/plan[?lane=<tag>]
//   POST /api/v1/projects/:projectId/plan
//
// Read is viewer+, like every other progress read: a valid project-scoped sync
// token proves membership. Write is MAINTAINER+, matching the project deadline
// it is the per-unit analogue of, and re-checks live membership because the
// role stamped in a token can be up to 15 minutes stale.
//
// What a unit IS lives in db/shared/plan-units.ts, so the org table's counts
// and this board can never disagree about the total.

import type { AquillaDb } from '../../../db/shim/postgres'
import { verifyTokenForProject } from '../auth'
import { ROLE } from './role-policy'
import { checkProjectMembershipDetailed } from './membership'
import { counts, readValidationCount, readValidationCountAudio, BOOK_INDEX } from './progress-read-route'
import { readCountStructuralCells } from './structural-cells'
import { resolveCorpusMarker } from './corpus-marker'
import {
  readPlanUnitsSql,
  planUnitExistsStmt,
  upsertPlanUnitStmt,
  isValidTargetDate,
  type PlanUnitRow,
} from '../../../db/shared/plan-units'

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/plan$/

/** Setting a target date or marking a unit done is maintainer work, exactly as
 *  the project-level deadline is. */
const PLAN_WRITE_MIN_ROLE = ROLE.MAINTAINER

export interface PlanUnit {
  fileId: string
  fileName: string
  fileRole: string | null
  fileKind: string | null
  /**
   * AQU-1278: the file's sidebar folder — its corpus marker, resolved the way
   * the sidebar resolves it — so the board's in-order arrangement can group
   * by the same folders the editor shows. Null where the file has none.
   */
  corpusMarker: string | null
  /** The file's own book code, for a one-book file; lets a file-grain unit find its testament. */
  fileBookCode: string | null
  /** '' for a file-grain unit; a Bible book code for a sub-file one. */
  sectionKey: string
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
  /**
   * What the two audio counts are OUT OF, when that is not `totalCount`.
   *
   * A dubbing project records against a hidden cue sheet whose cell count is
   * its own — see the cue-sheet note in `db/shared/plan-units.ts`. Null means
   * the unit has no cue sheet and audio shares the text denominator, which is
   * every unit that existed before AQU-1278.
   */
  audioTotalCount: number | null
  lastEditAt: number | null
  targetDate: string | null
  doneAt: number | null
  doneBy: string | null
  updatedAt: number | null
  updatedBy: string | null
}

export interface PlanResponse {
  projectId: string
  lane: string
  validationCount: number
  revision: number
  units: PlanUnit[]
}

export interface PlanRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

/** The folder a file's meta names, or null; a blob that will not parse names none. */
function corpusMarkerOf(meta: string | null): string | null {
  if (!meta) return null
  try {
    const parsed: unknown = JSON.parse(meta)
    if (!parsed || typeof parsed !== 'object') return null
    return resolveCorpusMarker(parsed as { corpusMarker?: unknown; parserVersion?: unknown }) ?? null
  } catch {
    return null
  }
}

function toUnit(
  row: PlanUnitRow,
  validationCount: number,
  countStructural: boolean,
  validationCountAudio: number,
): PlanUnit {
  const c = counts(
    {
      scope: row.section_key ? 'book' : 'file',
      section_key: row.section_key,
      total_count: row.total_count,
      filled_count: row.filled_count,
      validator_histogram: row.validator_histogram ?? null,
      structural_count: row.structural_count,
      structural_filled_count: row.structural_filled_count,
      structural_validator_histogram: row.structural_validator_histogram ?? null,
      revision: row.revision,
      // AQU-1278: audio goes THROUGH `counts()` now rather than around it.
      // These four used to be copied straight off the row below, which meant
      // the headings policy reached the cells and not the recordings — and a
      // book whose headings were voiced read over 100% audio on this board.
      audio_count: row.audio_count,
      audio_validated_count: row.audio_validated_count,
      structural_audio_count: row.structural_audio_count,
      structural_audio_validated_count: row.structural_audio_validated_count,
      // AQU-490: the board's audio number is now measured at the project's
      // required validator count, so the histograms have to come with the row.
      audio_validator_histogram: row.audio_validator_histogram ?? null,
      structural_audio_validator_histogram: row.structural_audio_validator_histogram ?? null,
    },
    validationCount,
    countStructural,
    validationCountAudio,
  )
  return {
    fileId: row.file_id,
    fileName: row.file_name,
    fileRole: row.file_role ?? null,
    fileKind: row.file_kind ?? null,
    corpusMarker: corpusMarkerOf(row.file_meta),
    fileBookCode: row.file_book_code ?? null,
    sectionKey: row.section_key,
    totalCount: c.totalCount,
    filledCount: c.filledCount,
    validatedCount: c.validatedCount,
    audioCount: c.audioCount,
    audioValidatedCount: c.audioValidatedCount,
    // Not through `counts()`: a cue sheet holds cues, and a cue is never a
    // heading or a paratext line, so the structural policy has nothing to
    // subtract from this denominator. The pair above still goes through it,
    // which costs nothing on a sheet whose structural share is zero and keeps
    // one path for both shapes.
    audioTotalCount: row.audio_total_count == null ? null : Number(row.audio_total_count),
    lastEditAt: row.last_edit_at == null ? null : Number(row.last_edit_at),
    targetDate: row.target_date ?? null,
    doneAt: row.done_at == null ? null : Number(row.done_at),
    doneBy: row.done_by ?? null,
    updatedAt: row.plan_updated_at == null ? null : Number(row.plan_updated_at),
    updatedBy: row.plan_updated_by ?? null,
  }
}

/**
 * Reading order: canonical Scripture order where the unit is a book, then by
 * file name. A book unit sorts by its own code; a file-grain unit borrows the
 * file's book_code when it has one, so a project of one-book files still reads
 * Genesis → Exodus rather than alphabetically. Anything unrecognised sorts
 * after the canon, in name order, rather than being silently interleaved.
 */
function compareUnits(a: PlanUnit, b: PlanUnit, aBook: string | null, bBook: string | null): number {
  const ai = aBook ? BOOK_INDEX.get(aBook) : undefined
  const bi = bBook ? BOOK_INDEX.get(bBook) : undefined
  if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi
  if (ai !== undefined && bi === undefined) return -1
  if (ai === undefined && bi !== undefined) return 1
  return a.fileName.localeCompare(b.fileName) || a.sectionKey.localeCompare(b.sectionKey)
}

async function readPlan(
  db: AquillaDb,
  projectId: string,
  lane: string,
): Promise<{ units: PlanUnit[]; revision: number; validationCount: number; validationCountAudio: number; countStructural: boolean; planUpdatedAt: number; progressUpdatedAt: number }> {
  const [validationCount, countStructural, validationCountAudio] = await Promise.all([
    readValidationCount(db, projectId),
    // AQU-1083: the board reads the same policy every other progress surface
    // does, so a book that opted out of counting headings is Done here too.
    readCountStructuralCells(db, projectId),
    readValidationCountAudio(db, projectId),
  ])
  const { results } = await db
    .prepare(readPlanUnitsSql())
    .bind(projectId, lane)
    .all<PlanUnitRow>()
  const rows = results ?? []
  let revision = 0
  let planUpdatedAt = 0
  let progressUpdatedAt = 0
  const withBook = rows.map((row) => {
    revision = Math.max(revision, Number(row.revision) || 0)
    planUpdatedAt = Math.max(planUpdatedAt, Number(row.plan_updated_at) || 0)
    progressUpdatedAt = Math.max(progressUpdatedAt, Number(row.progress_updated_at) || 0)
    // A folder rename touches the file row and nothing the other clocks
    // watch; without this the board keeps the old folder until an edit lands.
    progressUpdatedAt = Math.max(progressUpdatedAt, Number(row.file_updated_at) || 0)
    return {
      unit: toUnit(row, validationCount, countStructural, validationCountAudio),
      book: row.section_key || row.file_book_code || null,
    }
  })
  withBook.sort((x, y) => compareUnits(x.unit, y.unit, x.book, y.book))
  return { units: withBook.map((x) => x.unit), revision, validationCount, validationCountAudio, countStructural, planUpdatedAt, progressUpdatedAt }
}

export async function handlePlanRequest(
  request: Request,
  env: PlanRouteEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'GET' && request.method !== 'POST') return null

  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })
  const db = env.AQUILLA_PG
  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return new Response('missing Authorization header', { status: 401 })
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const lane = (url.searchParams.get('lane') ?? '').trim()

  if (request.method === 'GET') {
    const { units, revision, validationCount, validationCountAudio, countStructural, planUpdatedAt, progressUpdatedAt } =
      await readPlan(db, projectId, lane)
    // THREE CLOCKS, because none of them alone moves for every change worth
    // re-reading. `revision` tracks the event sequence; plan writes never
    // advance it, so a date change needs the newest plan_units.updated_at; and
    // a progress BACKFILL advances neither, so filling in audio counts and
    // activity needs the newest projection updated_at or a client caches an
    // audio-less board forever.
    // …and a fourth for the structural policy, which moves none of the three.
    //
    // `s2` MARKS THE RESPONSE SHAPE, the way both progress ETags do. Every
    // other part of this key is a property of the DATA, so when only the
    // SHAPE moves — AQU-1278 adding audioTotalCount, corpusMarker and
    // fileBookCode to every unit — nothing in the key moves with it. A
    // browser holding a body cached before the deploy would then revalidate
    // (Cache-Control is no-cache, so it always does), be told 304, and keep
    // serving the old body to the new client: a dubbing project measured
    // against its subtitle count instead of its cue sheet, and every file in
    // one "All files" folder, for as long as nothing in the project changes.
    // s1 = the shape before AQU-1278; s2 = these three fields.
    //
    // AQU-490 needs both halves again. `va` joins the key because every
    // unit's audioValidatedCount is now measured against the AUDIO threshold,
    // so raising it changes the body with no data write to move any of the
    // three timestamps. And s3 because that field kept its name and its type
    // and changed its question — the one kind of change none of the DATA
    // parts of this key can ever express.
    const structuralTag = countStructural ? '' : ':nostruct'
    const etag = `"plan:${projectId}:${lane}:${revision}:${planUpdatedAt}:${progressUpdatedAt}:${units.length}:v${validationCount}:va${validationCountAudio}:s3${structuralTag}"`
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
    }
    const body: PlanResponse = { projectId, lane, validationCount, revision, units }
    return Response.json(body, { headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  // ── POST: patch one unit's plan ──────────────────────────────────────────
  if (auth.claims.role < PLAN_WRITE_MIN_ROLE) {
    return new Response('role >= maintainer (600) required', { status: 403 })
  }
  // A token carries the role it was minted with, for up to 15 minutes. Someone
  // demoted in that window still holds a maintainer token, so re-check the
  // live membership before letting them write. Platform operators are the
  // documented exemption — they have no membership rows to check.
  if (auth.claims.src !== 'platform') {
    const membership = await checkProjectMembershipDetailed(db, projectId, auth.claims.userId)
    if (membership.status === 'revoked') {
      return new Response('project membership revoked', { status: 403 })
    }
    // [Pen test 2026-09-21] The check above only catches full removal. A
    // direct membership row DOWNGRADED below maintainer (not deleted) still
    // has_grant, so it reports "ok" too, letting a stale still-maintainer
    // token keep writing plan units for the rest of its window. The floor
    // required here is a fixed constant, so re-check the live role against
    // it directly rather than only against the token's stale claim.
    if (membership.roleLevel !== null && membership.roleLevel < PLAN_WRITE_MIN_ROLE) {
      return new Response('role >= maintainer (600) required', { status: 403 })
    }
  }

  let body: { fileId?: unknown; sectionKey?: unknown; targetDate?: unknown; done?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }

  const fileId = typeof body.fileId === 'string' ? body.fileId.trim() : ''
  if (!fileId) return new Response('fileId required', { status: 400 })
  const sectionKey = typeof body.sectionKey === 'string' ? body.sectionKey.trim() : ''
  if (sectionKey.length > 64) return new Response('sectionKey too long', { status: 400 })

  const hasTarget = 'targetDate' in body && body.targetDate !== undefined
  const hasDone = 'done' in body && body.done !== undefined
  if (!hasTarget && !hasDone) return new Response('nothing to update', { status: 400 })

  let targetDate: string | null | undefined
  if (hasTarget) {
    if (body.targetDate === null) {
      targetDate = null
    } else if (typeof body.targetDate === 'string' && isValidTargetDate(body.targetDate)) {
      targetDate = body.targetDate
    } else {
      return new Response('targetDate must be YYYY-MM-DD or null', { status: 400 })
    }
  }

  let done: boolean | undefined
  if (hasDone) {
    if (typeof body.done !== 'boolean') return new Response('done must be a boolean', { status: 400 })
    done = body.done
  }

  // The unit has to be real. This is where a tombstoned file, an audio-cue
  // sibling, a book that is not in this file, and a file-grain write against a
  // Scripture file all get refused — one check, because they are all the same
  // mistake: planning something that is not a unit.
  const exists = await planUnitExistsStmt(db, projectId, fileId, sectionKey).first<{ ok: number }>()
  if (!exists) return new Response('unknown plan unit', { status: 404 })

  const author = auth.claims.username?.trim() || `user:${auth.claims.userId}`
  await upsertPlanUnitStmt(db, {
    projectId,
    fileId,
    sectionKey,
    targetDate,
    done,
    author,
    now: Date.now(),
  }).run()

  const { results } = await db
    .prepare(readPlanUnitsSql('AND u.file_id = ? AND u.section_key = ?'))
    .bind(projectId, lane, fileId, sectionKey)
    .all<PlanUnitRow>()
  const row = (results ?? [])[0]
  if (!row) return new Response('unknown plan unit', { status: 404 })
  const [validationCount, countStructural, validationCountAudio] = await Promise.all([
    readValidationCount(db, projectId),
    readCountStructuralCells(db, projectId),
    readValidationCountAudio(db, projectId),
  ])
  return Response.json({ unit: toUnit(row, validationCount, countStructural, validationCountAudio) })
}
