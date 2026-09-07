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
import { AUTH_HINT } from './discovery-route'
import { approvalUrlFor, handlePrepare } from './prepare'
import { handleCommit } from './commit'
import { loadChangeset, changesetToResponse } from './store'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv, StoredChangeset } from './types'
import { validateApiCredential } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { countRecentRateLimitEvents, recordRateLimitEvent } from '../../../db/shared/rate-limit'

// [Pen test] API security & data exposure (2026-08-27): fetching and
// discarding a changeset had no throttle — only prepare and commit did.
// Narrower blast radius than the other read gaps (scoped to changesets the
// same credential created), but closing it completes the lifecycle: every
// external mutation/lookup on a changeset now shares one throttle regime.
const CHANGESET_LIFECYCLE_MAX_PER_CREDENTIAL = 300

async function checkChangesetLifecycleRateLimit(
  db: AquillaDb,
  credentialId: string,
): Promise<Response | null> {
  const identifier = `credential:${credentialId}`
  const recent = await countRecentRateLimitEvents(db, 'external_changeset_lifecycle', identifier)
  if (recent >= CHANGESET_LIFECYCLE_MAX_PER_CREDENTIAL) {
    return errorResponse('rate_limited', 'changeset lifecycle rate limit exceeded, slow down')
  }
  await recordRateLimitEvent(db, 'external_changeset_lifecycle', identifier)
  return null
}

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
  const cred = await validateApiCredential(db, bearer(request) ?? "", request.headers.get('CF-Connecting-IP'))
  if (!cred) return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)
  const limited = await checkChangesetLifecycleRateLimit(db, cred.credentialId)
  if (limited) return limited

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }
  // Live-role resolution on every call (§2): a viewer floor to read the plan,
  // so a user removed from the project after prepare can no longer see it.
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return errorResponse('permission_denied', 'no project membership')
  }
  const approvalUrl = approvalUrlFor(env, cs.id)
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
  const cred = await validateApiCredential(db, bearer(request) ?? "", request.headers.get('CF-Connecting-IP'))
  if (!cred) return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)
  const limited = await checkChangesetLifecycleRateLimit(db, cred.credentialId)
  if (limited) return limited

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }
  // Live-role resolution on every call (§2): the credential owner must still
  // resolve SOME role on the project — a user removed after prepare cannot
  // discard, matching every other lifecycle op.
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role) {
    return errorResponse('permission_denied', 'no project membership')
  }
  return discardChangesetCore(db, projectId, cs)
}

/** Post-auth discard state machine, shared with the session routes (AQU-926):
 *  staged/stale/expired → discarded; committed and mid-commit are refused (a
 *  discard during apply would strand a partially-applied plan). */
export async function discardChangesetCore(
  db: AquillaDb,
  projectId: string,
  cs: StoredChangeset,
): Promise<Response> {
  if (cs.status === 'committed') {
    return errorResponse('validation_failed', 'cannot discard a committed changeset')
  }
  // W2-A: a changeset mid-apply must not be discarded — doing so would strand a
  // partially-applied plan and let a concurrent commit finish onto a row the
  // caller believes is gone. Previously this fell through as a silent no-op.
  if (cs.status === 'committing') {
    return errorResponse('validation_failed', 'cannot discard a changeset that is currently committing')
  }
  // `superseded` (P1 §1) is deliberately absent: it is a terminal, HEALTHY
  // outcome, and flipping it to `discarded` would erase the fact that the work
  // exists — the count it feeds is not one to launder.
  if (cs.status === 'staged' || cs.status === 'stale' || cs.status === 'expired') {
    await db.prepare(`UPDATE changesets SET status = 'discarded' WHERE id = ?`).bind(cs.id).run()
  }
  const updated = await loadChangeset(db, projectId, cs.id)
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
