// Internal-token bridge (AQU-533 architecture decision, fixed).
//
// External writes NEVER construct AuthorizedEvent directly. The changeset engine
// compiles commands into RawEvent[] and routes them through the EXISTING /events
// perimeter (authorize.ts, role-policy, membership re-check, chain claims,
// idempotency, DO broadcast) by minting a short-lived internal sync JWT and
// invoking handleEventsWriteRequest with a synthetic Request. This module mints
// that token and enforces the credential's scope ceiling first.

import { sign } from 'hono/jwt'
import { ExternalError } from './errors'
// SWARM-TODO: after W1-A merges, switch these to `db/shared/*`.
import type { ApiCredentialContext } from './__stubs__/api-credentials'
import { resolveProjectRoleShared } from './__stubs__/project-roles'
import type { SyncTokenClaims } from '../auth'

/** Internal sync token lifetime — deliberately short (§ token never exposed). */
const INTERNAL_TOKEN_TTL_SECONDS = 300

export interface TokenBridgeEnv {
  SYNC_SECRET_KEY?: string
}

/**
 * Verify the credential's scope covers `projectId`:
 *   - cred.projectId is null (any project) OR equals the target project.
 *   - cred.orgId is null (any org) OR equals the project's org_id.
 * Throws ExternalError('scope_denied') on mismatch, ('not_found') when the
 * project row is absent. Returns the project's org_id for callers that need it.
 */
export async function assertCredentialScope(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
): Promise<{ orgId: string | null }> {
  if (cred.projectId != null && cred.projectId !== projectId) {
    throw new ExternalError(
      'scope_denied',
      'credential is not scoped to this project',
    )
  }

  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | string | null }>()
  if (!project) {
    throw new ExternalError('not_found', `project ${projectId} not found`)
  }

  const projectOrgId = project.org_id == null ? null : String(project.org_id)
  if (cred.orgId != null && cred.orgId !== projectOrgId) {
    throw new ExternalError(
      'scope_denied',
      'credential org scope does not match this project',
    )
  }

  return { orgId: projectOrgId }
}

/**
 * Mint a 300s internal sync JWT for one (project, file), stamped with the
 * credential owner's LIVE-resolved role. The token carries `src: 'external'`
 * so the perimeter's live membership re-check applies (external tokens are NOT
 * exempt like platform tokens). Scope is enforced before minting.
 */
export async function mintInternalSyncToken(
  env: TokenBridgeEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  fileId?: string,
): Promise<string> {
  if (!env.SYNC_SECRET_KEY) {
    throw new ExternalError('job_failed', 'SYNC_SECRET_KEY not configured')
  }

  await assertCredentialScope(db, cred, projectId)

  const resolved = await resolveProjectRoleShared(db, projectId, cred.userId)
  if (!resolved) {
    // No live grant path — the credential owner is not (or no longer) a member.
    throw new ExternalError('permission_denied', 'no access to project')
  }

  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: cred.userId,
    username: cred.username,
    projectId,
    // The perimeter's verifyTokenForDoc requires an exact fileId match, so a
    // token is minted per file. Empty string when unused (project-level).
    fileId: fileId ?? '',
    role: resolved.level,
    src: 'external',
    aud: 'sync',
    iat: now,
    exp: now + INTERNAL_TOKEN_TTL_SECONDS,
  }
  return sign(claims as unknown as Record<string, unknown>, env.SYNC_SECRET_KEY, 'HS256')
}
