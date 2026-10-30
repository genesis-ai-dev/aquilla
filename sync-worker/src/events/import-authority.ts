// AQU-2304: who may bring a NEW source file into a project — the org's
// configurable import floor.
//
// `file.create`'s static floor (role-policy.ts REQUIRED_ROLE) is PROJECT_LEAD
// (500): a project manager sets up their own file inventory. Partners want
// leads who coordinate translators and manage members WITHOUT being able to
// reshape that inventory, and the only way to get there before this key was to
// demote the lead, which took member management away too.
//
// So the org may RAISE the floor to Maintainer with `importMinRole`. This is a
// conditional floor raise in the shape of termbase-authority.ts: the static
// table still floors `file.create` at PROJECT_LEAD, and the org's value is put
// back on top in authorize(). It never LOWERS the bar — an org storing 400
// would resolve to 400 here, and the static gate below it still refuses a
// contributor, so a misconfigured floor cannot hand imports to translators.
//
// SCOPE IS `file.create` ONLY, deliberately:
//   - importing a TRANSLATION into an existing file commits target cells
//     (`target.cell.commit`, CONTRIBUTOR) and creates nothing, so it is
//     untouched — a lead under a Maintainer floor still fills a lane;
//   - creating a project from files is unaffected (the creator is the
//     project's owner);
//   - the Door43 upstream panel is hard-wired to Maintainer whichever way the
//     org sets this.
//
// Fail-safe, matching every other floor on this plumbing: an org-less project,
// a missing settings row, a blob that will not parse, a non-numeric or
// out-of-ladder value, or a database failure all resolve to PROJECT_LEAD — the
// behaviour of every org that never touches the key. A misconfigured floor is
// a no-op, never a lockout.

import type { AquillaDb } from '../../../db/shim/postgres'
import { makeRequestCache, type RequestCache } from './request-cache'

/**
 * Mirrors DEFAULT_IMPORT_MIN_ROLE in
 * auth-worker/src/services/org-permissions.ts and
 * src/lib/sync/role-policy.ts. All three must agree.
 */
export const DEFAULT_IMPORT_MIN_ROLE = 500

/**
 * Clamp an org-configured import floor to the role ladder, else the default.
 *
 * HAND-MIRRORED with `resolveImportFloor` in src/lib/sync/role-policy.ts. Out
 * of ladder falls back to the default rather than opening the door, the same
 * direction the client helper fails.
 */
export function resolveImportMinRole(minRole?: unknown): number {
  if (typeof minRole !== 'number' || !Number.isFinite(minRole)) {
    return DEFAULT_IMPORT_MIN_ROLE
  }
  if (minRole < 100 || minRole > 700) return DEFAULT_IMPORT_MIN_ROLE
  return minRole
}

/**
 * The org-configured import floor for the project's org.
 *
 * Reads go through the per-request cache (request-cache.ts), so an outbox
 * flush carrying several `file.create` events — a multi-book scripture import
 * emits one per book (AQU-1187) — pays one org-settings lookup for the whole
 * batch rather than one per file.
 *
 * Fails CLOSED to the default (500) on any error, for the reason
 * resolveTermbaseFloor gives: an exception at this perimeter must not degrade
 * into a 403 that wedges a durable outbox on one poisoned event.
 */
export async function resolveImportFloor(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache = makeRequestCache(db),
): Promise<number> {
  try {
    const orgId = await cache.projectOrgId(projectId)
    if (orgId == null) return DEFAULT_IMPORT_MIN_ROLE
    const parsed = await cache.orgSettings(orgId)
    return resolveImportMinRole(parsed?.importMinRole)
  } catch {
    return DEFAULT_IMPORT_MIN_ROLE
  }
}
