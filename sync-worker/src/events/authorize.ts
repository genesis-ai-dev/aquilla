// AuthorizedEvent perimeter — CQRS Phase 0.
// This is the ONLY file that may construct AuthorizedEvent directly.
// ESLint's no-restricted-syntax rule in eslint.config.js enforces this at the
// module boundary so the type system AND lint together form a two-layer guard.

import type { EventKind, EventClaims, RawEvent } from './types'
import { requiredRoleFor, ROLE } from './role-policy'
import { verifyTokenForDoc, verifyTokenForProject, type SyncTokenClaims } from '../auth'
import { resolveAllowSelfAssignment } from './assignment-authority'
import { isLockedTimingEvent, isUserInsertedCell, resolveTimingLocked } from './timing-authority'
import { resolveCellEditingFloor } from './cell-editing-authority'
import { isGatedTrackPatch, resolveAllowTrackEditing } from './track-editing-authority'
import { laneOfEvent } from './event-projection'

/** Sentinel fileId used by project-scoped comment.* events in the outbox. */
export const PROJECT_SENTINEL_FILE_ID = '__project__'

/** Event kinds that are permitted to use the project-scoped sentinel path. */
function isCommentKind(kind: string): boolean {
  return kind === 'comment.create' || kind === 'comment.edit' ||
    kind === 'comment.delete' || kind === 'comment.resolve'
}

/**
 * AQU-553: event kinds subject to lane/file scope gating — chain-mutating
 * target-side cell writes plus text-side validation. These are the ONLY kinds
 * a scoped contributor/reviewer is restricted on. Everything else (source-side
 * cell events, comments, audio, waivers, back-translations, assignments,
 * file-level lifecycle) is NEVER scope-gated: source rows are shared across
 * lanes, and the other surfaces aren't lane-addressable.
 */
const SCOPE_GATED_KINDS = new Set<string>([
  'target.cell.create',
  'target.cell.commit',
  'target.cell.delete',
  'target.cell.reorder',
  'cell.validate',
  'cell.unvalidate',
])

/**
 * AQU-553: the target-language lane a scope-gated event addresses. For
 * `target.cell.*` this is `laneOfEvent` (reads `payload.targetLang`, '' for the
 * default lane). For `cell.validate` / `cell.unvalidate` the lane rides on the
 * payload the same way but the kind isn't `target.cell.*`, so read it directly.
 */
function scopeLaneOf(kind: string, payload: unknown): string {
  if (kind === 'cell.validate' || kind === 'cell.unvalidate') {
    const lang = (payload as { targetLang?: unknown } | null | undefined)?.targetLang
    return typeof lang === 'string' ? lang : ''
  }
  return laneOfEvent(kind, payload)
}

/**
 * AQU-553: enforce a token's lane/file scopes against one event. Returns a
 * structured 403 rejection when the event violates a scope, or null when it
 * passes (or isn't a scope-gated kind). `scopes` is the verified token claim;
 * an ABSENT claim means unscoped and this function is never called.
 *
 * Composition is AND: if any 'lane' scopes exist the event's lane must be among
 * them, AND if any 'file' scopes exist the event's fileId must be among them.
 */
function enforceScopes(
  scopes: ReadonlyArray<{ kind: 'lane' | 'file'; value: string }>,
  raw: RawEvent<EventKind>,
): { ok: false; status: 403; reason: string } | null {
  if (!SCOPE_GATED_KINDS.has(raw.kind)) return null

  const laneScopes = scopes.filter((s) => s.kind === 'lane').map((s) => s.value)
  if (laneScopes.length > 0) {
    const lane = scopeLaneOf(raw.kind, raw.payload)
    if (!laneScopes.includes(lane)) {
      return { ok: false, status: 403, reason: `lane '${lane}' not in scope for ${raw.kind}` }
    }
  }

  const fileScopes = scopes.filter((s) => s.kind === 'file').map((s) => s.value)
  if (fileScopes.length > 0) {
    if (!raw.fileId || !fileScopes.includes(raw.fileId)) {
      return { ok: false, status: 403, reason: `file '${raw.fileId ?? ''}' not in scope for ${raw.kind}` }
    }
  }

  return null
}

/**
 * AQU-496: true when `raw` is an `assignment.create` event whose payload
 * assigns the scope to the CALLER themselves (never to anyone else). This is
 * the only shape the self-assign carve-out below ever permits.
 */
function isSelfAssignCreate(raw: RawEvent<EventKind>, callerUserId: number): boolean {
  if (raw.kind !== 'assignment.create') return false
  const payload = raw.payload as { assigneeUserId?: unknown } | undefined
  return typeof payload?.assigneeUserId === 'number' && payload.assigneeUserId === callerUserId
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
  /**
   * AQU-496: optional DB handle for the self-assign carve-out below. Only
   * `assignment.create` ever reads it (one org_settings lookup, memoized
   * nowhere — callers batching many events should expect one query per
   * below-floor assignment.create). Omitting `db` simply disables the
   * carve-out (falls back to the static PROJECT_LEAD floor) rather than
   * erroring — every existing caller/test that doesn't pass it keeps working.
   */
  db?: AquillaDb,
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
    // AQU-496: assignment.create self-assign carve-out. A below-lead member
    // (CONTRIBUTOR=400+) may still pass here if (a) a DB handle was supplied,
    // (b) the payload assigns the scope to THEMSELVES (never another user —
    // isSelfAssignCreate checks this), and (c) the project's org has opted
    // into allowSelfAssignment. Leads/maintainers never reach this branch —
    // their role already clears requiredRoleFor above.
    const selfAssignOk =
      db != null &&
      tokenClaims.role >= ROLE.CONTRIBUTOR &&
      isSelfAssignCreate(raw as RawEvent<EventKind>, tokenClaims.userId) &&
      (await resolveAllowSelfAssignment(db, raw.projectId))
    if (!selfAssignOk) {
      return { ok: false, status: 403, reason: `role too low for ${raw.kind}` }
    }
  }

  // AQU-646: the project-wide timing lock raises cell.retime / cell.lane.retime
  // from their static CONTRIBUTOR floor to MAINTAINER while a project is
  // locked. See timing-authority.ts for why it is a raised floor rather than a
  // flat refusal (short version: an import's retimes are indistinguishable from
  // a drag, and re-import is maintainer-gated anyway).
  //
  // ORDERED SO THE COMMON PATH IS FREE. Retimes arrive in bursts while someone
  // drags, so a maintainer never reads settings at all, and the per-cell
  // exemption lookup runs only on an event that was otherwise about to be
  // rejected. An absent `db` disables the lock rather than erroring, matching
  // the self-assign carve-out above — every existing caller and test that does
  // not pass one keeps working.
  if (db != null && tokenClaims.role < ROLE.MAINTAINER && isLockedTimingEvent(raw.kind, raw.payload)) {
    if (await resolveTimingLocked(db, raw.projectId)) {
      // Sam's exemption: a line someone added here never came from the client's
      // file, so it has no imported timing to corrupt and stays movable.
      const exempt =
        raw.fileId != null &&
        raw.cellId != null &&
        (await isUserInsertedCell(db, raw.projectId, raw.fileId, raw.cellId))
      if (!exempt) {
        return {
          ok: false,
          status: 403,
          reason: `timing is locked for this project (${raw.kind})`,
        }
      }
    }
  }

  // AQU-1068: `source.cell.create` / `source.cell.delete` /
  // `source.cell.reorder` are gated on the project's `cellEditingFloor`.
  // Reorder is in the list because every add and remove BATCHES one in to keep
  // the anchor chain intact, and a gate that refused the companion killed the
  // whole batch (which is exactly how this went wrong on 2026-08-21).
  //
  // NO `tokenClaims.role < X` TERM, AND ITS ABSENCE IS DELIBERATE. The
  // predecessor block carried one because it was a conditional floor RAISE for
  // whoever fell below a static floor; this is not that. "none" — the default,
  // and what an absent or unreadable setting means — refuses EVERYONE,
  // including an owner, because the setting answers *whether* a project
  // restructures its files, not merely *who* may. A clearance term here would
  // open the back door the gate exists to close.
  //
  // The static floors in role-policy.ts stay CONTRIBUTOR on purpose: imports
  // (`POST /import`, lead-gated in its own route) and the in-app agent emit
  // these same kinds, and a raised static floor would break them.
  //
  // THE EXTERNAL API SURFACE IS EXEMPT, and that is not a hole — it is the
  // behaviour this path already had. The predecessor block skipped everyone at
  // PROJECT_LEAD and above, and `emitEventsFloor` holds external callers at
  // exactly that floor, so no integration gains anything here it did not have
  // before AQU-1068. It also has to be exempt to work at all: an external
  // PlanImport POPULATES A NEW FILE through this perimeter (commit.ts chunks
  // `file.create` + N × `source.cell.create` through it), which is a
  // file-creation act gated by `file.create`'s own floor, not the
  // restructuring of an existing file that `cellEditingFloor` governs.
  //
  // The in-app agent is deliberately NOT exempt: it applies through the user's
  // own outbox with the user's own token, so it may do exactly what that
  // person may do and no more.
  //
  // An absent `db` skips the check, matching the carve-outs above.
  if (
    db != null &&
    tokenClaims.src !== 'external' &&
    (raw.kind === 'source.cell.create' ||
      raw.kind === 'source.cell.delete' ||
      raw.kind === 'source.cell.reorder')
  ) {
    const floor = await resolveCellEditingFloor(db, raw.projectId)
    if (floor == null) {
      return {
        ok: false,
        status: 403,
        reason: 'adding or removing cells is not enabled for this project',
      }
    }
    if (tokenClaims.role < floor) {
      return {
        ok: false,
        status: 403,
        reason: `role too low to add or remove cells (${raw.kind})`,
      }
    }
    // ...and the second gate on removal: an IMPORTED cell is the client's own
    // work, so taking one back needs MAINTAINER whatever tier is configured.
    // Below that rank a person only ever removes a line somebody added by hand
    // here. `isUserInsertedCell` fails closed, so an unreadable cell row keeps
    // the maintainer requirement rather than waiving it.
    if (raw.kind === 'source.cell.delete' && tokenClaims.role < ROLE.MAINTAINER) {
      const userInserted =
        raw.fileId != null &&
        raw.cellId != null &&
        (await isUserInsertedCell(db, raw.projectId, raw.fileId, raw.cellId))
      if (!userInserted) {
        return {
          ok: false,
          status: 403,
          reason: 'removing an imported cell requires maintainer',
        }
      }
    }
  }

  // AQU-646 stage 2: RESTRUCTURING a timeline needs the project to have opted
  // in, on top of the maintainer floor `file.track.set` already carries.
  //
  // NO `tokenClaims.role < X` TERM, AND ITS ABSENCE IS DELIBERATE. The
  // self-assign and timing-lock blocks above carry one because both are
  // conditional floor RAISES on kinds whose static floor was lowered. This
  // kind's floor was never lowered — it is MAINTAINER in role-policy.ts and
  // has been since it shipped — so there is nothing to raise and no clearance
  // that should skip the question. The setting answers *whether* a project
  // restructures its timelines, not *who* may do it, which is why an OWNER is
  // refused here too. Two gates means two gates. Adding a role term to make
  // this resemble its neighbours would open exactly the back door the second
  // gate exists to close.
  //
  // A rename or a reorder is NOT restructuring, and both already ship — see
  // isGatedTrackPatch for the three clauses that separate them, and why
  // `patch: null` needs a clause of its own.
  if (db != null && raw.kind === 'file.track.set' && isGatedTrackPatch(raw.payload)) {
    if (!(await resolveAllowTrackEditing(db, raw.projectId))) {
      return { ok: false, status: 403, reason: 'timeline track editing is not enabled for this project' }
    }
  }

  // AQU-553: after the role floor passes, apply ADDITIVE lane/file scopes. An
  // absent `scopes` claim is unscoped (skip). Present scopes gate chain-mutating
  // target.* writes + validate/unvalidate; every other kind falls through.
  if (Array.isArray(tokenClaims.scopes) && tokenClaims.scopes.length > 0) {
    const scopeRejection = enforceScopes(
      tokenClaims.scopes,
      raw as RawEvent<EventKind>,
    )
    if (scopeRejection) return scopeRejection
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
