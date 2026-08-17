// Session-token changeset routes (AQU-926, command registry §3). The in-app
// agent harness (auth-worker) and the SPA review card drive the SAME changeset
// engine the external Agent API uses, authenticated with the browser session's
// sync token instead of a PAT:
//
//   POST /api/v1/changesets/:projectId                    → prepare
//   GET  /api/v1/changesets/:projectId?status=&limit=     → list (creator's, newest-first)
//   GET  /api/v1/changesets/:projectId/:changesetId       → status
//   POST /api/v1/changesets/:projectId/:changesetId/commit  → commit
//   POST /api/v1/changesets/:projectId/:changesetId/discard → discard
//
// Principal: an ApiCredentialContext-shaped sentinel with credentialId
// 'session' (precedent: agent-artifacts' SESSION_UPLOAD_SENTINEL) and mode
// 'ask' — the shared prepare core's effective-autonomy formula therefore
// FORCES ask on every session changeset, and the null org/project scopes make
// assertCredentialScope a pure project-existence check. Only the changeset's
// CREATOR (created_by_user_id === the token's user) may read or act on it.
// Confirmations are minted by auth-worker's approve route (which stamps the
// changeset's own credential_id — 'session' here), so ask-mode consumption in
// the shared commit core works unchanged.

import { errorResponse, externalError } from './errors'
import { prepareChangesetCore } from './prepare'
import { approvalUrlFor } from './stage'
import { commitChangesetCore } from './commit'
import { discardChangesetCore } from './changesets-route'
import {
  CHANGESET_STATUSES,
  changesetToResponse,
  listChangesetsForCreator,
  loadChangeset,
} from './store'
import type { ExternalEnv } from './types'
import { verifyTokenForProject, type SyncTokenClaims } from '../auth'
import { ROLE } from '../events/role-policy'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'

/** Fixed credential_id sentinel for session-staged changesets (precedent:
 *  auth-worker agent-artifacts' SESSION_UPLOAD_SENTINEL — plain TEXT columns,
 *  no migration needed). */
export const SESSION_CREDENTIAL_ID = 'session'

const ROUTE_RE = /^\/api\/v1\/changesets\/([^/]+)(?:\/([^/]+)(?:\/(commit|discard))?)?$/

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

/** Session principal in the ApiCredentialContext shape the shared cores take. */
export function sessionPrincipal(claims: SyncTokenClaims): ApiCredentialContext {
  const username =
    typeof claims.username === 'string' && claims.username.trim() !== ''
      ? claims.username
      : `user:${claims.userId}`
  return {
    credentialId: SESSION_CREDENTIAL_ID,
    userId: String(claims.userId),
    username,
    mode: 'ask',
    orgId: null,
    projectId: null,
  }
}

/** Verify the session sync token for this project; external error envelope on
 *  failure (401/403 preserved via the status override) so callers branch on
 *  the same stable codes as the PAT surface. */
async function sessionAuth(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<{ cred: ApiCredentialContext } | Response> {
  const auth = await verifyTokenForProject(bearer(request), projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    if (auth.status === 500) return errorResponse('job_failed', auth.reason)
    return externalError('permission_denied', auth.reason, auth.status)
  }
  return { cred: sessionPrincipal(auth.claims) }
}

/** Creator-only rule (§3): created_by_user_id must equal the token's user. */
function creatorDenied(csCreatedByUserId: string, cred: ApiCredentialContext): Response | null {
  if (String(csCreatedByUserId) === cred.userId) return null
  return errorResponse('permission_denied', 'only the changeset creator may access it')
}

async function handleList(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  url: URL,
): Promise<Response> {
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !(CHANGESET_STATUSES as readonly string[]).includes(status)) {
    return errorResponse('validation_failed', `unknown status filter "${status}"`, {
      statuses: CHANGESET_STATUSES,
    })
  }
  let limit: number | undefined
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null) {
    limit = Number(rawLimit)
    if (!Number.isFinite(limit) || limit < 1) {
      return errorResponse('validation_failed', 'limit must be a positive integer')
    }
  }
  const rows = await listChangesetsForCreator(db, projectId, cred.userId, { status, limit })
  return Response.json({
    changesets: rows.map((cs) => ({
      ...changesetToResponse(cs),
      approvalUrl: approvalUrlFor(env, cs.id),
    })),
  })
}

async function handleGet(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  changesetId: string,
): Promise<Response> {
  const cs = await loadChangeset(db, projectId, changesetId)
  if (!cs) return errorResponse('not_found', `changeset ${changesetId} not found`)
  const denied = creatorDenied(cs.createdByUserId, cred)
  if (denied) return denied
  // Live-role re-check (PAT-surface parity): a member removed after the token
  // was minted can no longer read the plan within the token's lifetime.
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return errorResponse('permission_denied', 'no project membership')
  }
  return Response.json({ changeset: changesetToResponse(cs), approvalUrl: approvalUrlFor(env, cs.id) })
}

async function handleDiscard(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  changesetId: string,
): Promise<Response> {
  const cs = await loadChangeset(db, projectId, changesetId)
  if (!cs) return errorResponse('not_found', `changeset ${changesetId} not found`)
  const denied = creatorDenied(cs.createdByUserId, cred)
  if (denied) return denied
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role) {
    return errorResponse('permission_denied', 'no project membership')
  }
  return discardChangesetCore(db, projectId, cs)
}

export async function handleSessionChangesetsRequest(
  request: Request,
  env: ExternalEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = ROUTE_RE.exec(url.pathname)
  if (!m) return null

  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG

  const projectId = decodeURIComponent(m[1])
  const changesetId = m[2] ? decodeURIComponent(m[2]) : undefined
  const action = m[3] as 'commit' | 'discard' | undefined

  const auth = await sessionAuth(request, env, projectId)
  if (auth instanceof Response) return auth
  const { cred } = auth

  // Collection: POST → prepare (autonomy forced 'ask' by the session
  // principal's mode); GET → the creator's changesets, newest-first.
  if (!changesetId) {
    if (request.method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('validation_failed', 'invalid JSON body')
      }
      const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      return prepareChangesetCore(db, env, cred, projectId, raw)
    }
    if (request.method === 'GET') return handleList(db, env, cred, projectId, url)
    return errorResponse('validation_failed', 'method not allowed')
  }

  if (action === 'commit') {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return commitChangesetCore(
      request,
      env,
      projectId,
      changesetId,
      { cred, ownership: 'creator', channel: 'app' },
      ctx,
    )
  }
  if (action === 'discard') {
    if (request.method !== 'POST') return errorResponse('validation_failed', 'method not allowed')
    return handleDiscard(db, cred, projectId, changesetId)
  }

  if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
  return handleGet(db, env, cred, projectId, changesetId)
}
