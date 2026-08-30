// AQU-1068: who may add and remove cells in a project.
//
// `cellEditingFloor` (project settings; the write route is maintainer-gated)
// names a role FLOOR — "maintainer", "project_lead" or "contributor" — and
// `source.cell.create` / `source.cell.delete` / `source.cell.reorder` pass
// only for somebody at or above it. All three travel together on purpose:
// every add and every remove BATCHES a reorder in to keep the anchor chain
// intact, and a gate that refused the companion would kill the whole batch.
//
// THE DEFAULT IS "none", AND IT REFUSES EVERYONE — an owner included. This is
// a "whether", not a "who": a project that has not opted in does not
// restructure its files at all, so there is no clearance that skips the
// question. That is why the static floors in role-policy.ts stay CONTRIBUTOR
// and the real decision lives here — imports and the agent ride the same event
// kinds through their own routes, and a raised static floor would break them.
//
// Supersedes AQU-646's `allowLineCreation` boolean, which asked the same
// question of one surface and could only answer yes-or-no. Sam, 2026-08-29:
// the tier is the setting, and a project that had the old boolean on is NOT
// migrated — it lands on "none" with everyone else.
//
// REMOVING AN IMPORTED CELL NEEDS MAINTAINER ON TOP OF THIS FLOOR. Below that
// rank a person only ever takes back a line somebody added by hand here
// (`isUserInsertedCell`, shared with the timing lock); an imported line is the
// client's own work. That second half lives in authorize.ts beside this
// module's, because it needs the event's cell id and this does not.

import { ROLE } from './role-policy'

/** The stored vocabulary. Mirrors ProjectWideSettings.cellEditingFloor. */
const FLOOR_MAP: Record<string, number> = {
  maintainer: ROLE.MAINTAINER,
  project_lead: ROLE.PROJECT_LEAD,
  contributor: ROLE.CONTRIBUTOR,
}

/**
 * The role level this project admits to cell editing, or `null` for nobody.
 *
 * `null` — the refusing answer — covers every way of not saying yes: no
 * settings row, a blob that will not parse, the explicit "none", and any tier
 * this build does not recognise. A value a newer client invents must never
 * read as permission on an older worker.
 *
 * Keep in lock-step with the client's `resolveCellEditingFloor`
 * (src/lib/sync/project-settings.ts), which gates the affordance.
 */
export async function resolveCellEditingFloor(
  db: AquillaDb,
  projectId: string,
): Promise<number | null> {
  // THE QUERY IS INSIDE THE TRY — same perimeter discipline as
  // resolveTimingLocked: an exception here does not degrade to a 403, it
  // escapes `authorize` and 500s the whole batch, which can wedge a durable
  // outbox on a poisoned event. An unreachable settings row refuses.
  try {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: string | null }>()

    if (!row?.settings) return null

    const parsed = JSON.parse(row.settings) as { cellEditingFloor?: unknown }
    const floor = parsed?.cellEditingFloor
    if (typeof floor !== 'string') return null
    return FLOOR_MAP[floor] ?? null
  } catch {
    return null
  }
}
