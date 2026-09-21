// AQU-1006 follow-up: who may write terminology, and at what strength.
//
// Terminology has TWO authority levels, not one, and the split is the whole
// point of the surface:
//
//   SUGGESTING a term is contributor work. A translator who meets an important
//   word mid-verse should be able to propose it without asking anyone. The
//   proposal lands as `status: 'draft'`, which compiles to NO rules
//   (src/lib/terminology/compile.ts skips non-active concepts), so a
//   suggestion can never change what anyone else's editor enforces. Nothing a
//   contributor can do here is binding, so nothing here needs a manager.
//
//   APPROVING one is management work, because an active concept IS enforced —
//   it compiles into the rule set every translator on the project sees, and a
//   careless entry lights up thousands of cells with violations. That is
//   gated by the org's configured `termbaseEditMinRole` (AQU-822), the same
//   floor auth-worker applies to the settings-blob carve-out today.
//
// The floor is an ORG setting, so it cannot live in role-policy.ts's static
// map — hence this module, in the shape of its sibling
// track-editing-authority.ts. This one is a conditional floor RAISE: the
// static table floors every `term.*` kind at CONTRIBUTOR, and the binding
// kinds get the org floor put back here.
// (It named `line-creation-authority.ts` before AQU-1068 retired that module,
// then cell-editing-authority.ts until 2026-09-09, when the cell tier stopped
// being enforced at this perimeter at all — see authorize.ts.)

import type { AquillaDb } from '../../../db/shim/postgres'
import { makeRequestCache, type RequestCache } from './request-cache'

/**
 * Mirrors DEFAULT_TERMBASE_EDIT_MIN_ROLE in
 * auth-worker/src/services/org-permissions.ts and
 * src/lib/terminology/glossary-view.ts. All three must agree.
 */
export const DEFAULT_TERMBASE_EDIT_MIN_ROLE = 500

/**
 * Clamp an org-configured floor to the role ladder, else the default.
 *
 * HAND-MIRRORED with `resolveTermbaseEditFloor` in
 * src/lib/terminology/glossary-view.ts. A misconfigured floor falls back to
 * the default rather than opening the door — the same direction the client
 * helper fails.
 */
export function resolveTermbaseEditFloor(minRole?: number | null): number {
  if (typeof minRole !== 'number' || !Number.isFinite(minRole)) {
    return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  }
  if (minRole < 100 || minRole > 700) return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  return minRole
}

/**
 * Does this write BIND — i.e. does it change what the rule engine enforces
 * for everyone, rather than merely proposing something?
 *
 * Exported and pure so the policy is testable without a JWT or a database,
 * the same seam `isGatedTrackPatch` provides for its setting.
 *
 * Gated:
 *   - `term.create` whose status is anything but 'draft' (creating an
 *      already-active term is approving it in one step)
 *   - `term.update`  — editing an ACTIVE concept changes live enforcement.
 *   - `term.delete`, `term.approve`, `term.reject` — all management verbs.
 *
 * Ungated:
 *   - `term.create` with `status: 'draft'` — a suggestion, enforced nowhere.
 *
 * `term.update` is gated unconditionally rather than "gated only when the
 * concept is active". Deciding per-concept would mean reading the projection
 * inside the authorizer to answer a question whose wrong answer is permissive:
 * a draft can be approved a second later, so an ungated edit path on drafts is
 * an ungated edit path on the term that results. The cost is that a
 * contributor cannot revise their own suggestion — they delete and re-suggest.
 * Revisit if that friction bites; do NOT fix it by reading status here.
 */
export function isBindingTermWrite(kind: string, payload: unknown): boolean {
  if (kind !== 'term.create') return true
  if (typeof payload !== 'object' || payload === null) return true
  const status = (payload as { status?: unknown }).status
  return status !== 'draft'
}

/**
 * The org-configured termbase floor for the project's org.
 *
 * Fails CLOSED to the default (500) when the org can't be resolved or the
 * settings blob won't parse — an unreachable setting must not silently drop
 * the bar to contributor. Note this differs from
 * `resolveAllowTrackEditing`'s `false`: there the restrictive answer is "no",
 * here it is "the default floor", because terminology management is a
 * capability projects have by default rather than one they opt into.
 */
export async function resolveTermbaseFloor(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache = makeRequestCache(db),
): Promise<number> {
  // The query is inside the try for the same perimeter reason the siblings
  // give: an exception here must not degrade into a 403 that wedges a durable
  // outbox on one poisoned event.
  try {
    const orgId = await cache.projectOrgId(projectId)
    if (orgId == null) return DEFAULT_TERMBASE_EDIT_MIN_ROLE
    const parsed = await cache.orgSettings(orgId)
    return resolveTermbaseEditFloor(
      parsed?.termbaseEditMinRole as number | null | undefined,
    )
  } catch {
    return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  }
}
