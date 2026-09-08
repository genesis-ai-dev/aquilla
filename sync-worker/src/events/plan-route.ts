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
import { checkProjectMembership } from './membership'
import { counts, readValidationCount, BOOK_INDEX } from './progress-read-route'
import { readCountStructuralCells } from './structural-cells'
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
  /** '' for a file-grain unit; a Bible book code for a sub-file one. */
  sectionKey: string
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
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

function toUnit(row: PlanUnitRow, validationCount: number, countStructural: boolean): PlanUnit {
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
    },
    validationCount,
    countStructural,
  )
  return {
    fileId: row.file_id,
    fileName: row.file_name,
    fileRole: row.file_role ?? null,
    fileKind: row.file_kind ?? null,
    sectionKey: row.section_key,
    totalCount: c.totalCount,
    filledCount: c.filledCount,
    validatedCount: c.validatedCount,
    audioCount: Number(row.audio_count) || 0,
    audioValidatedCount: Number(row.audio_validated_count) || 0,
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
): Promise<{ units: PlanUnit[]; revision: number; validationCount: number; countStructural: boolean; planUpdatedAt: number; progressUpdatedAt: number }> {
  const [validationCount, countStructural] = await Promise.all([
    readValidationCount(db, projectId),
    // AQU-1083: the board reads the same policy every other progress surface
    // does, so a book that opted out of counting headings is Done here too.
    readCountStructuralCells(db, projectId),
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
    return {
      unit: toUnit(row, validationCount, countStructural),
      book: row.section_key || row.file_book_code || null,
    }
  })
  withBook.sort((x, y) => compareUnits(x.unit, y.unit, x.book, y.book))
  return { units: withBook.map((x) => x.unit), revision, validationCount, countStructural, planUpdatedAt, progressUpdatedAt }
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
  const projectId = decodeURIComponent(match[1]!)

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return new Response('missing Authorization header', { status: 401 })
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const lane = (url.searchParams.get('lane') ?? '').trim()

  if (request.method === 'GET') {
    const { units, revision, validationCount, countStructural, planUpdatedAt, progressUpdatedAt } =
      await readPlan(db, projectId, lane)
    // THREE CLOCKS, because none of them alone moves for every change worth
    // re-reading. `revision` tracks the event sequence; plan writes never
    // advance it, so a date change needs the newest plan_units.updated_at; and
    // a progress BACKFILL advances neither, so filling in audio counts and
    // activity needs the newest projection updated_at or a client caches an
    // audio-less board forever.
    // …and a fourth for the structural policy, which moves none of the three.
    const structuralTag = countStructural ? '' : ':nostruct'
    const etag = `"plan:${projectId}:${lane}:${revision}:${planUpdatedAt}:${progressUpdatedAt}:${units.length}:v${validationCount}${structuralTag}"`
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
    const membership = await checkProjectMembership(db, projectId, auth.claims.userId)
    if (membership === 'revoked') {
      return new Response('project membership revoked', { status: 403 })
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
  const [validationCount, countStructural] = await Promise.all([
    readValidationCount(db, projectId),
    readCountStructuralCells(db, projectId),
  ])
  return Response.json({ unit: toUnit(row, validationCount, countStructural) })
}
