// Agent API changeset routes (AQU-533). Mounted under
//   /api/v1/external/projects/:projectId/changesets
//     POST                 → prepare (stage a plan)
//     GET  /:id            → fetch a changeset (summary + digest)
//     POST /:id/commit     → commit (ask/act)
//     POST /:id/discard    → discard a staged plan
//
// Returns null when the URL doesn't match so it chains in index.ts's ordered
// handler dispatch. Every response is JSON with a stable error contract
// (errors.ts).

import { errorResponse } from './errors'
import { handlePrepare } from './prepare'
import { handleCommit } from './commit'
import { loadChangeset, changesetToResponse } from './store'
import type { ExternalEnv } from './types'
// SWARM-TODO: after W1-A merges, switch to `db/shared/api-credentials`.
import { validateApiCredential } from './__stubs__/api-credentials'

const ROUTE_RE =
  /^\/api\/v1\/external\/projects\/([^/]+)\/changesets(?:\/([^/]+)(?:\/(commit|discard))?)?$/

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

async function handleGet(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  const cred = await validateApiCredential(db, bearer(request))
  if (!cred) return errorResponse('permission_denied', 'invalid or missing API credential')

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }
  const approvalUrl = `${env.BASE_URL ?? ''}/approve/${cs.id}`
  return Response.json({ changeset: changesetToResponse(cs), approvalUrl })
}

async function handleDiscard(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  const cred = await validateApiCredential(db, bearer(request))
  if (!cred) return errorResponse('permission_denied', 'invalid or missing API credential')

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }
  if (cs.status === 'committed') {
    return errorResponse('validation_failed', 'cannot discard a committed changeset')
  }
  if (cs.status === 'staged' || cs.status === 'stale' || cs.status === 'expired') {
    await db.prepare(`UPDATE changesets SET status = 'discarded' WHERE id = ?`).bind(id).run()
  }
  const updated = await loadChangeset(db, projectId, id)
  return Response.json({ changeset: updated ? changesetToResponse(updated) : null })
}

export async function handleExternalChangesetsRequest(
  request: Request,
  env: ExternalEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = ROUTE_RE.exec(url.pathname)
  if (!m) return null

  const projectId = decodeURIComponent(m[1])
  const id = m[2] ? decodeURIComponent(m[2]) : undefined
  const action = m[3] as 'commit' | 'discard' | undefined

  // Collection: POST → prepare.
  if (!id) {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return handlePrepare(request, env, projectId)
  }

  // Item sub-actions.
  if (action === 'commit') {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return handleCommit(request, env, projectId, id, ctx)
  }
  if (action === 'discard') {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return handleDiscard(request, env, projectId, id)
  }

  // Item: GET → fetch.
  if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
  return handleGet(request, env, projectId, id)
}
