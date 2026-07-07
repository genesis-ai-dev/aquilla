// AuthorizedEvent perimeter — CQRS Phase 0.
// This is the ONLY file that may construct AuthorizedEvent directly.
// ESLint's no-restricted-syntax rule in eslint.config.js enforces this at the
// module boundary so the type system AND lint together form a two-layer guard.

import type { EventKind, EventClaims, RawEvent } from './types'
import { requiredRoleFor } from './role-policy'
import { verifyTokenForDoc, verifyTokenForProject, type SyncTokenClaims } from '../auth'

/** Sentinel fileId used by project-scoped comment.* events in the outbox. */
export const PROJECT_SENTINEL_FILE_ID = '__project__'

/** Event kinds that are permitted to use the project-scoped sentinel path. */
function isCommentKind(kind: string): boolean {
  return kind === 'comment.create' || kind === 'comment.edit' ||
    kind === 'comment.delete' || kind === 'comment.resolve'
}

// Private symbol — NOT exported. Code outside this file cannot reproduce
// the brand on a fake AuthorizedEvent, even via Object.assign or JSON.parse/
// JSON.serialize, because the symbol is unreachable without importing the
// module's internal scope.
const AUTHORIZED = Symbol('authorized')

export class AuthorizedEvent<K extends EventKind = EventKind> {
  readonly [AUTHORIZED] = true
  constructor(
    readonly claims: EventClaims,
    readonly event: RawEvent<K>,
  ) {}
}

export type AuthorizeResult<K extends EventKind> =
  | { ok: true; event: AuthorizedEvent<K> }
  | { ok: false; status: 400 | 401 | 403 | 500; reason: string }

/**
 * Type guard that handlers MUST use to validate input. Checking
 * `instanceof AuthorizedEvent` alone is insufficient — `Object.create(
 * AuthorizedEvent.prototype)` produces an instanceof-passing object that
 * lacks the [AUTHORIZED] brand. The symbol check is the load-bearing test.
 */
export function isAuthorizedEvent<K extends EventKind = EventKind>(
  x: unknown,
): x is AuthorizedEvent<K> {
  return x instanceof AuthorizedEvent && (x as { [AUTHORIZED]?: true })[AUTHORIZED] === true
}

/**
 * The ONLY function that mints AuthorizedEvent instances. Every event handler
 * accepts AuthorizedEvent and TypeScript prevents bypass (the symbol-branded
 * class can't be constructed externally without hitting the ESLint guard or
 * losing the runtime brand check).
 *
 * Steps:
 *   1. Check secret is configured (returns 500 if undefined).
 *   2. Check token is present (returns 401 if missing).
 *   3. Validate that the event has a fileId (Phase 0: all events are file-scoped, returns 400).
 *   4. Verify JWT signature, audience, expiry, project/file scope (delegates to verifyTokenForDoc).
 *   5. Map SyncTokenClaims to EventClaims (renames `role` -> `roleLevel`, etc.).
 *   6. Check role level meets requiredRoleFor(event.kind) (returns 403 if too low).
 *   7. Return AuthorizedEvent on success; structured rejection on failure.
 *
 * Authorship is bound to the verified token, not `raw.author`. New Frontier
 * sync tokens carry `username`; older tokens fall back to a stable user-id
 * label so a client cannot spoof another user's audit identity.
 */
export async function authorize<K extends EventKind>(
  token: string | null | undefined,
  raw: RawEvent<K>,
  secret: string | undefined,
): Promise<AuthorizeResult<K>> {
  // 1. Secret must be configured — misconfigured deployment, not a client error.
  if (!secret) {
    return { ok: false, status: 500, reason: 'SYNC_SECRET_KEY not configured' }
  }
  // 2. Token must be present — unauthenticated client.
  if (!token) {
    return { ok: false, status: 401, reason: 'missing token' }
  }
  // 3a. Project-scoped comment.* events use the sentinel '__project__' fileId.
  //     For these, we verify via verifyTokenForProject (checks projectId only)
  //     instead of verifyTokenForDoc (which requires exact fileId match).
  //     All other events must carry a real fileId (Phase 0).
  if (raw.fileId === PROJECT_SENTINEL_FILE_ID && isCommentKind(raw.kind)) {
    // Project-scoped comment path: token must match the event's projectId.
    const authResult = await verifyTokenForProject(token, raw.projectId, secret)
    if (!authResult.ok) {
      return authResult
    }
    const tokenClaims: SyncTokenClaims = authResult.claims
    const tokenUsername =
      typeof tokenClaims.username === 'string' && tokenClaims.username.trim() !== ''
        ? tokenClaims.username
        : `user:${tokenClaims.userId}`

    if (tokenClaims.role < requiredRoleFor(raw.kind)) {
      return { ok: false, status: 403, reason: `role too low for ${raw.kind}` }
    }

    const claims: EventClaims = {
      userId: tokenClaims.userId,
      username: tokenUsername,
      projectId: tokenClaims.projectId,
      fileId: PROJECT_SENTINEL_FILE_ID,
      roleLevel: tokenClaims.role,
      ...(tokenClaims.src ? { src: tokenClaims.src } : {}),
    }
    return { ok: true, event: new AuthorizedEvent(claims, raw) }
  }

  // 3b. Phase 0: every non-sentinel event must be file-scoped.
  if (!raw.fileId) {
    return { ok: false, status: 400, reason: 'event missing fileId' }
  }

  // 4. Verify JWT — fileId is now guaranteed to be a real string.
  const authResult = await verifyTokenForDoc(
    token,
    { projectId: raw.projectId, fileId: raw.fileId },
    secret,
  )

  if (!authResult.ok) {
    // AuthResult.status is 401 | 403 | 500, which is a subset of our 400 | 401 | 403 | 500.
    return authResult
  }

  const tokenClaims: SyncTokenClaims = authResult.claims
  const tokenUsername =
    typeof tokenClaims.username === 'string' && tokenClaims.username.trim() !== ''
      ? tokenClaims.username
      : `user:${tokenClaims.userId}`

  // Role gate: check that the token's role is sufficient for this event kind.
  if (tokenClaims.role < requiredRoleFor(raw.kind)) {
    return { ok: false, status: 403, reason: `role too low for ${raw.kind}` }
  }

  const claims: EventClaims = {
    userId: tokenClaims.userId,
    username: tokenUsername,
    projectId: tokenClaims.projectId,
    fileId: tokenClaims.fileId,
    roleLevel: tokenClaims.role,
    ...(tokenClaims.src ? { src: tokenClaims.src } : {}),
  }

  return { ok: true, event: new AuthorizedEvent(claims, raw) }
}
