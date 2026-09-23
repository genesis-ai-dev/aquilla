// POST /migrate/finalize — recompute file rollup counters for a project
// in ONE set-based UPDATE, after a deferFileCounters ingest.
//
// The inline projection recomputes a file's counters on EVERY cell event (an
// O(N²)-per-file scan that the profiler showed was ~67% of all migration query
// time). With deferFileCounters the ingest skips that; this endpoint runs the
// same aggregates once — correlated subqueries scan each file's cells a single
// time, so total cost is O(total cells), one statement. Result is identical to
// the incremental path (the counters are pure aggregates over the final cells).
// Gated on ADMIN_SECRET, with SYNC_SECRET_KEY still accepted — see
// lib/admin-auth.ts.
//
// AQU-557: the migrate daemon calls this once per push, and a push usually
// touches a handful of files in a project that holds dozens. Recomputing every
// file made finalize the third-largest source of ≥5 s sync-worker requests in
// production (209 calls/24h on 2026-09-16, median 14.7 s, p90 32.4 s, max
// 50.9 s). Two fixes, both here:
//   1. An optional `fileIds` scope — the caller passes the files its push
//      actually touched and only those are recomputed. Omitting it keeps the
//      whole-project behavior, so `scripts/migrate-all.ts` is unaffected.
//   2. The per-file progress recompute is pipelined instead of one awaited
//      round trip per file, so a wide project costs a handful of round trips
//      rather than one per file.
//
// Idempotent: pure recompute from current cells, safe to call any number of times.

import { projectFileCountersRecomputeStmt } from './event-projection'
import { fullProgressRecomputeStmts } from './progress-projection'
import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const PATH = '/migrate/finalize'

/** Above this an `IN (…)` list costs more to plan and bind than the scan it
 *  saves, so a request naming that many files falls back to the whole-project
 *  recompute — same rows, one statement. */
const MAX_SCOPED_FILE_IDS = 500

/** Statements per pipelined batch. `fullProgressRecomputeStmts` emits 2 per
 *  file, and postgres.js keeps up to 100 statements in flight (see PgRunOpts
 *  in db/shim/postgres.ts), so this fills the pipeline without building an
 *  unbounded batch for a project with hundreds of files. */
const PROGRESS_BATCH_STMTS = 100

/** Prefer the pipelined executor; test doubles and non-postgres.js shims only
 *  implement `batch()`. Same atomicity and ordering either way. */
async function runFinalizeBatch(db: AquillaDb, stmts: AquillaStatement[]): Promise<void> {
  if (stmts.length === 0) return
  if (db.batchPipelined) {
    await db.batchPipelined(stmts)
    return
  }
  await db.batch(stmts)
}

/**
 * Read the optional `fileIds` scope.
 *
 * Returns `null` for "no scope — recompute the whole project", which is both
 * the legacy shape (no field at all) and the safe fallback for an empty list
 * or one past `MAX_SCOPED_FILE_IDS`. Falling back never skips work: the
 * unscoped recompute is a superset of any scope. Returns `'invalid'` for a
 * malformed field so a caller bug surfaces as a 400 rather than silently
 * widening into the expensive path.
 */
function parseFileIdScope(raw: unknown): string[] | null | 'invalid' {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) return 'invalid'
  if (raw.some((id) => typeof id !== 'string' || id === '')) return 'invalid'
  const unique = [...new Set(raw as string[])]
  if (unique.length === 0 || unique.length > MAX_SCOPED_FILE_IDS) return null
  return unique
}

export interface MigrateFinalizeEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

export async function handleMigrateFinalizeRequest(
  request: Request,
  env: MigrateFinalizeEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  const projectId = (body as { projectId?: unknown })?.projectId
  if (typeof projectId !== 'string') return new Response('body must be { projectId }', { status: 400 })

  const fileIds = parseFileIdScope((body as { fileIds?: unknown })?.fileIds)
  if (fileIds === 'invalid') {
    return new Response('fileIds must be an array of non-empty strings', { status: 400 })
  }

  const db = env.AQUILLA_PG
  // One instant for the whole finalize, so every row it touches carries the
  // same `updated_at` rather than drifting across a multi-second loop.
  const finalizedAt = Date.now()
  // Scoping is applied by re-reading `files`, never by trusting the request's
  // list: an id for a file outside this project (or one that no longer exists)
  // matches nothing, exactly as the unscoped form would.
  const scopeClause = fileIds ? ` AND id IN (${fileIds.map(() => '?').join(', ')})` : ''
  const scopeBinds = fileIds ?? []

  try {
    // One shared builder with the live projection and the rebuild — see
    // projectFileCountersRecomputeStmt for why three copies was a hazard. The
    // scope rides through it, so a scoped finalize lands the same counters
    // (structural_*, ai_drafted_count) as the unscoped form.
    const res = await projectFileCountersRecomputeStmt(db, projectId, finalizedAt, fileIds).run()
    const { results: files } = await db
      .prepare(`SELECT id FROM files WHERE project_id = ?${scopeClause}`)
      .bind(projectId, ...scopeBinds)
      .all<{ id: string }>()
    const progressStmts = files.flatMap((file) =>
      fullProgressRecomputeStmts(db, projectId, file.id, finalizedAt),
    )
    for (let i = 0; i < progressStmts.length; i += PROGRESS_BATCH_STMTS) {
      await runFinalizeBatch(db, progressStmts.slice(i, i + PROGRESS_BATCH_STMTS))
    }
    return Response.json({
      ok: true,
      filesUpdated: res.meta?.changes ?? null,
      progressUpdated: files.length,
      scoped: fileIds !== null,
    })
  } catch (err) {
    console.error("[migrate-finalize] failed:", err)
    return Response.json({ error: "finalize failed" }, { status: 500 })
  }
}
