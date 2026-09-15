// Agent API changeset routes (AQU-533). Mounted under
//   /api/v1/external/projects/:projectId/changesets
//     POST                 → prepare (stage a plan)
//     GET                  → list this credential's changesets (AQU-1177 §1)
//     GET  /:id            → fetch a changeset (summary + digest)
//     GET  /:id/wait       → long-poll until approved / no longer staged (§2)
//     POST /:id/commit     → commit (ask/act)
//     POST /:id/discard    → discard a staged plan
//
// Returns null when the URL doesn't match so it chains in index.ts's ordered
// handler dispatch. Every response is JSON with a stable error contract
// (errors.ts).

import { errorResponse, toErrorResponse } from './errors'
import { AUTH_HINT } from './discovery-route'
import { approvalUrlFor, handlePrepare } from './prepare'
import { handleCommit } from './commit'
import {
  CHANGESET_STATUSES,
  changesetToResponse,
  EXTERNAL_LIST_DEFAULT_LIMIT,
  EXTERNAL_LIST_MAX_LIMIT,
  listChangesetsPage,
  loadChangeset,
} from './store'
import { clampWaitTimeout, waitForChangesetSettled, WAIT_MAX_TIMEOUT_MS } from './changeset-wait'
import { encodeCursor, parsePageParams } from './pagination'
import { assertCredentialScope } from './token-bridge'
import { ROLE } from '../events/role-policy'
import type { ExternalEnv, StoredChangeset } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
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
  /^\/api\/v1\/external\/projects\/([^/]+)\/changesets(?:\/([^/]+)(?:\/(commit|discard|wait))?)?$/

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
  const cred = await validateApiCredential(db, bearer(request) ?? "")
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

/**
 * Shared preamble for the routes added in AQU-1177: validate the PAT, spend one
 * lifecycle throttle slot, confirm the credential's org/project SCOPE covers
 * this project (a wrong-project PAT gets `scope_denied` → 403 here rather than
 * a misleading empty list), and require a live VIEWER floor — the same read
 * floor `handleGet` enforces, resolved fresh so a member removed after prepare
 * loses access immediately.
 */
async function authorizeChangesetRead(
  request: Request,
  db: AquillaDb,
  projectId: string,
): Promise<{ cred: ApiCredentialContext } | Response> {
  const cred = await validateApiCredential(db, bearer(request) ?? '')
  if (!cred) {
    return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)
  }
  const limited = await checkChangesetLifecycleRateLimit(db, cred.credentialId)
  if (limited) return limited
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return errorResponse('permission_denied', 'no project membership')
  }
  return { cred }
}

/**
 * GET /changesets — this credential's staged/settled plans, newest-first
 * (AQU-1177 §1). Scoped to the calling credential, matching the per-item rule
 * in `handleGet`: a PAT sees the plans it staged, never a sibling agent's.
 * `status` filters exactly against the schema's own status list; `limit` +
 * opaque `cursor` page it.
 */
async function handleList(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  url: URL,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  const auth = await authorizeChangesetRead(request, db, projectId)
  if (auth instanceof Response) return auth

  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !(CHANGESET_STATUSES as readonly string[]).includes(status)) {
    return errorResponse('validation_failed', `unknown status filter "${status}"`, {
      statuses: CHANGESET_STATUSES,
    })
  }
  const { limit, offset } = parsePageParams(url, {
    defaultLimit: EXTERNAL_LIST_DEFAULT_LIMIT,
    maxLimit: EXTERNAL_LIST_MAX_LIMIT,
  })

  const { rows, hasMore } = await listChangesetsPage(db, projectId, {
    status,
    credentialId: auth.cred.credentialId,
    offset,
    limit,
  })
  return Response.json({
    changesets: rows.map((cs) => ({
      ...changesetToResponse(cs),
      approvalUrl: approvalUrlFor(env, cs.id),
    })),
    nextCursor: hasMore ? encodeCursor(offset + rows.length) : null,
  })
}

/**
 * GET /changesets/:id/wait — long-poll for the approval signal (AQU-1177 §2).
 * Resolves as soon as a human approval lands or the plan leaves `staged`;
 * otherwise returns the current row with `timedOut: true` once the (clamped)
 * budget is spent, so the caller can simply call again. One throttle slot is
 * spent per CALL, not per internal poll — that is the whole point of moving the
 * wait server-side.
 */
async function handleWait(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
  url: URL,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  const auth = await authorizeChangesetRead(request, db, projectId)
  if (auth instanceof Response) return auth

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (auth.cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }

  const rawTimeout = url.searchParams.get('timeoutMs')
  if (rawTimeout !== null && !Number.isFinite(Number(rawTimeout))) {
    return errorResponse('validation_failed', 'timeoutMs must be a number of milliseconds')
  }
  const timeoutMs = clampWaitTimeout(rawTimeout === null ? NaN : Number(rawTimeout))

  const outcome = await waitForChangesetSettled(db, projectId, id, cs, timeoutMs)
  return Response.json({
    changeset: changesetToResponse(outcome.changeset),
    approvalUrl: approvalUrlFor(env, outcome.changeset.id),
    approved: outcome.approved,
    timedOut: outcome.timedOut,
    waitedMs: outcome.waitedMs,
    maxTimeoutMs: WAIT_MAX_TIMEOUT_MS,
  })
}

async function handleDiscard(
  request: Request,
  env: ExternalEnv,
  projectId: string,
  id: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG
  const cred = await validateApiCredential(db, bearer(request) ?? "")
  if (!cred) return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)
  const limited = await checkChangesetLifecycleRateLimit(db, cred.credentialId)
  if (limited) return limited

  const cs = await loadChangeset(db, projectId, id)
  if (!cs) return errorResponse('not_found', `changeset ${id} not found`)
  if (cred.credentialId !== cs.credentialId) {
    return errorResponse('permission_denied', 'credential did not create this changeset')
  }
  // AQU-1225: a pre-creation changeset (a receipt-only CreateProject, W2-A) is
  // staged under a project id that does not exist yet, so the membership check
  // below can NEVER pass — the staging credential could not clean up its own
  // junk and the row sat in the approval queue until it expired an hour later.
  // Schema probing mass-produces exactly these. When the target project does
  // not exist, credential ownership (asserted above) IS the authorization:
  // no membership can exist to resolve, so this widens nothing — it only turns
  // an unconditional denial into "the staging credential may discard its own
  // changeset". Once the project exists, the live-role check applies unchanged.
  if (!(await projectExists(db, projectId))) {
    return discardChangesetCore(db, projectId, cs)
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

/** AQU-1225: does the changeset's target project row exist yet? A
 *  not-yet-created project is the pre-creation (CreateProject) case, where the
 *  membership gate is unresolvable by construction. */
async function projectExists(db: AquillaDb, projectId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ id: string }>()
  return row != null
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
  const action = m[3] as 'commit' | 'discard' | 'wait' | undefined

  // Collection: POST → prepare, GET → this credential's changesets.
  if (!id) {
    if (request.method === 'POST') return handlePrepare(request, env, projectId)
    if (request.method === 'GET') return handleList(request, env, projectId, url)
    return errorResponse('validation_failed', 'method not allowed')
  }

  // Item sub-actions.
  if (action === 'wait') {
    if (request.method !== 'GET') return errorResponse('validation_failed', 'method not allowed')
    return handleWait(request, env, projectId, id, url)
  }
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
