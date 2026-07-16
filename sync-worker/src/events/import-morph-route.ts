// POST /import-morph — bulk cell_word_morph upload for Macula Hebrew + Greek (AQU-178).
//
// Accepts per-word morphology rows alongside a Macula source import and upserts them
// into the `cell_word_morph` table. Called by the client AFTER bulkUploadSource has
// seeded the cells, so cell_ids are already known.
//
// Auth mirrors /import: a valid `aud=sync` token scoped to (projectId, fileId),
// role >= PROJECT_LEAD (source-side importer authority).
//
// Idempotent: INSERT ... ON CONFLICT DO UPDATE upserts each row so re-running the
// same import safely overwrites rather than duplicating.

import { verifyTokenForDoc } from '../auth'
import { ROLE } from './role-policy'
import { withCors } from '../cors'

const BATCH_LIMIT = 100

export interface ImportMorphRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface MorphRow {
  cell_id: string
  word_seq: number
  surface: string
  lemma?: string
  morph_code?: string
  strongs_h?: string
  strongs_g?: string
}

interface ImportMorphBody {
  projectId: string
  fileId: string
  rows: MorphRow[]
}

function isImportMorphBody(x: unknown): x is ImportMorphBody {
  if (typeof x !== 'object' || x === null) return false
  const b = x as Record<string, unknown>
  return (
    typeof b.projectId === 'string' &&
    typeof b.fileId === 'string' &&
    Array.isArray(b.rows)
  )
}

function isMorphRow(x: unknown): x is MorphRow {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r.cell_id === 'string' && typeof r.word_seq === 'number' && typeof r.surface === 'string'
}

/**
 * POST /import-morph
 *
 * Body: { projectId, fileId, rows: MorphRow[] }
 * Returns: { accepted: number } | error
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 */
export async function handleBulkMorphImportRequest(
  request: Request,
  env: ImportMorphRouteEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/import-morph') return null
  if (request.method !== 'POST') {
    return withCors(new Response('method not allowed', { status: 405 }), request)
  }
  if (!env.SYNC_SECRET_KEY) {
    return withCors(new Response('SYNC_SECRET_KEY not configured', { status: 500 }), request)
  }
  if (!env.AQUILLA_PG) {
    return withCors(new Response('AQUILLA_PG binding not configured', { status: 500 }), request)
  }
  const db = env.AQUILLA_PG

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return withCors(new Response('invalid JSON body', { status: 400 }), request)
  }
  if (!isImportMorphBody(body)) {
    return withCors(
      new Response('body must be { projectId, fileId, rows[] }', { status: 400 }),
      request,
    )
  }

  // Auth: token must be scoped to (project, file) with PROJECT_LEAD+ role.
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const auth = await verifyTokenForDoc(
    token,
    { projectId: body.projectId, fileId: body.fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(new Response('role too low for morph import', { status: 403 }), request)
  }

  // Validate and build upsert statements.
  const stmts: AquillaStatement[] = []
  let rejected = 0

  for (const row of body.rows) {
    if (!isMorphRow(row)) {
      rejected++
      continue
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO cell_word_morph (project_id, file_id, cell_id, word_seq, surface, lemma, morph_code, strongs_h, strongs_g)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, file_id, cell_id, word_seq) DO UPDATE SET
             surface    = excluded.surface,
             lemma      = excluded.lemma,
             morph_code = excluded.morph_code,
             strongs_h  = excluded.strongs_h,
             strongs_g  = excluded.strongs_g`,
        )
        .bind(
          body.projectId,
          body.fileId,
          row.cell_id,
          row.word_seq,
          row.surface,
          row.lemma ?? null,
          row.morph_code ?? null,
          row.strongs_h ?? null,
          row.strongs_g ?? null,
        ),
    )
  }

  // Batch commit in chunks.
  try {
    for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
      await db.batch(stmts.slice(i, i + BATCH_LIMIT))
    }
  } catch (err) {
    return withCors(
      Response.json({ error: `DB batch failed: ${String(err)}` }, { status: 500 }),
      request,
    )
  }

  return withCors(
    Response.json({ accepted: stmts.length, rejected }),
    request,
  )
}
