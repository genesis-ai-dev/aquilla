// Sam, 2026-08-21: "Only managers can change the settings, but once they've
// changed the settings, then even contributors can make the changes."
//
// `allowLineCreation` (project settings; the write route is maintainer-gated)
// decides who may ADD lines to a timed file. While it is on,
// `source.cell.create` keeps its static CONTRIBUTOR floor (role-policy.ts);
// while it is off — the default — authorize re-imposes the PROJECT_LEAD floor
// the static table used to carry. The sibling of timing-authority.ts, with the
// sign the other way: that one fails safe to LOCKED because absent means the
// safeguard is on; this one fails safe to OFF, because the affordance is the
// liability the setting exists to contain (see
// ProjectWideSettings.allowLineCreation in src/lib/sync/project-settings.ts).
//
// REMOVAL IS DELIBERATELY NOT KEYED TO THE SETTING. Taking a line back is
// never gated on policy — switching the setting off must not strand a line
// somebody already made — so a contributor's `source.cell.delete` is admitted
// by a different question entirely: is this a line a person added by hand?
// (`isUserInsertedCell`, shared with the timing lock.) Imported cells keep the
// PROJECT_LEAD floor either way. That check lives in authorize.ts beside this
// module's.

import { makeRequestCache, type RequestCache } from './request-cache'

/**
 * Has this project opted into people adding lines?
 *
 * Returns `false` (the restrictive answer) when the project has no settings
 * row, the blob will not parse, or `allowLineCreation` is anything other than
 * exactly `true`. Keep in lock-step with the client's read of the same key
 * (`project?.allowLineCreation ?? false`).
 */
export async function resolveAllowLineCreation(
  db: AquillaDb,
  projectId: string,
  // Per-request memo (request-cache.ts) — one project_settings read per
  // request, not per created line. Absent → a throwaway cache, old behaviour.
  cache: RequestCache = makeRequestCache(db),
): Promise<boolean> {
  // THE QUERY IS INSIDE THE TRY — same perimeter discipline as
  // resolveTimingLocked: an exception here does not degrade to a 403, it
  // escapes `authorize` and 500s the whole batch, which can wedge a durable
  // outbox on a poisoned event. An unreachable settings row reads as OFF.
  try {
    const parsed = await cache.projectSettings(projectId)
    return parsed?.allowLineCreation === true
  } catch {
    return false
  }
}
