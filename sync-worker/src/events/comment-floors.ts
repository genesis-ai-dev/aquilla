// AQU-1002: org-configurable authority floors for comment threads.
//
// Mirrors resolveExportFloor's shape exactly (export-floor.ts): the same
// project -> org_id -> org_settings lookup, the same role-ladder validation,
// and the same fail-safe fallback to the hard-coded default whenever the data
// is missing or malformed. Two floors are resolved together because every
// caller that needs one is one DB round-trip away from needing the other.
//
//   commentCreateMinRole  — the bar to open a thread or post a reply.
//     Defaults to COMMENTER (200), which is REQUIRED_ROLE['comment.create'],
//     so an org that never sets it behaves exactly as it did before.
//
//   commentResolveMinRole — the bar to resolve/reopen a thread somebody ELSE
//     authored. Defaults to CONTRIBUTOR (400), which is
//     FOREIGN_COMMENT_ROLE['comment.resolve'] — AQU-999's hardened default,
//     unchanged.
//
// WHY THE RESOLVE FLOOR IS THE *FOREIGN* FLOOR, NOT A FLAT ONE. The policy
// orgs actually disagreed about (the AQU-999 thread, and Catherine's question
// behind this ticket) is authority over OTHER people's threads — whether a
// contributor may close a discussion they did not open. A thread's author can
// still always resolve their own thread at the static COMMENTER floor, however
// high the org sets this. Letting the floor lock someone out of closing a
// thread they opened themselves would be a different, unrequested behaviour,
// and would silently strip an affordance every role has today.

import { ROLE } from './role-policy'

/** The two configurable comment floors, already validated and defaulted. */
export interface CommentFloors {
  /** Minimum role to emit `comment.create`. */
  createMinRole: number
  /** Minimum role to resolve/reopen a thread authored by someone else. */
  resolveMinRole: number
}

/** Floors in force when an org has expressed no preference. */
export const DEFAULT_COMMENT_FLOORS: CommentFloors = {
  createMinRole: ROLE.COMMENTER,
  resolveMinRole: ROLE.CONTRIBUTOR,
}

/**
 * Coerce one raw settings value into a role level, or fall back to `fallback`.
 *
 * Values outside the role ladder (VIEWER 100 … OWNER 700) are rejected rather
 * than clamped — exactly as resolveExportFloor does — so a misconfigured floor
 * (`-1`, `9999`, `"maintainer"`) shows up as a no-op instead of silently
 * locking everyone out of commenting or silently opening it to anonymous
 * viewers.
 */
function coerceFloor(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  if (raw < ROLE.VIEWER || raw > ROLE.OWNER) return fallback
  return raw
}

/**
 * Look up the org's comment floors for the project's org.
 *
 * Returns DEFAULT_COMMENT_FLOORS when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - the settings blob is unparseable.
 *
 * Each floor falls back independently, so an org that has set only one of the
 * two keeps the stock default for the other.
 */
export async function resolveCommentFloors(
  db: AquillaDb,
  projectId: string,
): Promise<CommentFloors> {
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return DEFAULT_COMMENT_FLOORS

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return DEFAULT_COMMENT_FLOORS

  try {
    const parsed = JSON.parse(settings.settings)
    return {
      createMinRole: coerceFloor(
        parsed?.commentCreateMinRole,
        DEFAULT_COMMENT_FLOORS.createMinRole,
      ),
      resolveMinRole: coerceFloor(
        parsed?.commentResolveMinRole,
        DEFAULT_COMMENT_FLOORS.resolveMinRole,
      ),
    }
  } catch {
    return DEFAULT_COMMENT_FLOORS
  }
}

/**
 * Per-request memo around `resolveCommentFloors`.
 *
 * The /events perimeter walks a batch event-by-event, and a batch of comment
 * mutations would otherwise repeat the same two reads for every entry. Callers
 * build one of these per request and share it across the loop; it caches the
 * in-flight promise, so N concurrent lookups for a project still cost one pair
 * of reads.
 */
export function createCommentFloorsCache(db: AquillaDb) {
  const byProject = new Map<string, Promise<CommentFloors>>()
  return (projectId: string): Promise<CommentFloors> => {
    let pending = byProject.get(projectId)
    if (!pending) {
      pending = resolveCommentFloors(db, projectId)
      byProject.set(projectId, pending)
    }
    return pending
  }
}
