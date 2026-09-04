// Terminology concept read API. (AQU-1006 follow-up)
//
//   GET /api/v1/projects/:projectId/concepts
//   Query params (all optional):
//     includeDeleted — '1' to include tombstoned rows (audit views only)
//
// Returns { concepts: ConceptRowOut[] } ordered by created_at ASC.
//
// Auth: sync-token JWT scoped to projectId; minimum role VIEWER — reading the
// termbase is not privileged. WRITING is where the two-tier authority lives
// (see termbase-authority.ts); a viewer who can see the enforced terms in
// their editor can necessarily see them here.
//
// Every query is scoped by the verified projectId from the JWT, so a token for
// project A cannot read project B's termbase.

import { verifyTokenForProject } from '../auth'

export interface ConceptsReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface ConceptRowRaw {
  concept_id: string
  project_id: string
  source_term: string
  // JSONB comes back as a parsed array through the shim, but a legacy/hand
  // -written row can still surface a string. `toOut` normalizes both.
  renderings: unknown
  notes: string | null
  status: string
  case_sensitive: number
  created_by: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface ConceptRenderingOut {
  rendering: string
  status: 'preferred' | 'admitted' | 'forbidden'
}

export interface ConceptRowOut {
  conceptId: string
  projectId: string
  sourceTerm: string
  renderings: ConceptRenderingOut[]
  notes: string | null
  status: 'active' | 'draft' | 'deprecated'
  caseSensitive: boolean
  createdBy: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/**
 * Normalize `renderings` to an array.
 *
 * Defensive on purpose: this column feeds rule compilation, and
 * `compileConceptsToRules` calls `.filter` on it unguarded. A row whose
 * renderings arrived as a JSON string (or as null from a partial write) would
 * throw inside the client's rule pass and take the whole editor's QA surface
 * down with it — a far worse failure than one concept silently having no
 * renderings.
 */
function parseRenderings(raw: unknown): ConceptRenderingOut[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is ConceptRenderingOut =>
      typeof r === 'object' && r !== null &&
      typeof (r as { rendering?: unknown }).rendering === 'string' &&
      ((r as { status?: unknown }).status === 'preferred' ||
        (r as { status?: unknown }).status === 'admitted' ||
        (r as { status?: unknown }).status === 'forbidden'),
  )
}

function toOut(row: ConceptRowRaw): ConceptRowOut {
  const status = row.status === 'active' || row.status === 'deprecated' ? row.status : 'draft'
  return {
    conceptId: row.concept_id,
    projectId: row.project_id,
    sourceTerm: row.source_term,
    renderings: parseRenderings(row.renderings),
    notes: row.notes,
    status,
    caseSensitive: row.case_sensitive === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/concepts$/

export async function handleConceptsReadRequest(
  request: Request,
  env: ConceptsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== 'GET') return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) {
    return new Response('missing Authorization header', { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const includeDeleted = url.searchParams.get('includeDeleted') === '1'

  const parts: string[] = [
    'SELECT',
    '  concept_id, project_id, source_term, renderings, notes,',
    '  status, case_sensitive, created_by, created_at, updated_at, deleted_at',
    'FROM concepts',
    'WHERE project_id = ?',
  ]
  const binds: unknown[] = [projectId]
  // Matches concepts_project_live_idx, the partial index this read exists for.
  if (!includeDeleted) parts.push('AND deleted_at IS NULL')
  parts.push('ORDER BY created_at ASC')

  const sql = parts.join(' ')

  try {
    const result = await env.AQUILLA_PG.prepare(sql)
      .bind(...binds)
      .all<ConceptRowRaw>()
    const concepts: ConceptRowOut[] = result.results.map(toOut)
    return Response.json({ concepts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('concepts read failed:', message)
    return new Response('concepts read failed', { status: 500 })
  }
}
