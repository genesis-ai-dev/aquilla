// Who may remove an IMPORTED cell: the project's own "who can add and remove
// cells" setting decides.
//
// Until the Pattani Malay report (Biblica ETT, 2026-11-16) removing an imported
// line needed MAINTAINER whatever that setting said, so a project that set it
// to "Project lead" still told its leads "Only a maintainer can remove an
// imported line" on every line of an imported Scripture file. The setting and
// the rule disagreed, and the rule was invisible in settings. Now they are one
// rule: the effective tier (the project's own, else its org's default) admits a
// role to remove any line, imported or not. A project that sets "No one" or
// never opts in keeps the old answer, because nobody below maintainer is
// admitted — and a maintainer, who passes without a lookup, always was.
//
// Fail-closed discipline, like `isUserInsertedCell` and `resolveTimingLocked`:
// this runs on the event perimeter, so a read failure must not escape as a
// 500. An unreadable setting reads as "nobody" and the maintainer requirement
// stays.
//
// Keep in lock-step with `resolveCellEditingFloor` in
// src/lib/sync/project-settings.ts, which the editor reads from the same blob.

import {
  cellEditingFloorFromSettings,
} from '../../../db/shared/cell-editing-floor'
import { withOrgMediaDefaults } from '../../../db/shared/media-setting-defaults'
import { makeRequestCache, type RequestCache } from './request-cache'

/**
 * The role level the project's effective cell-editing tier admits, or `null`
 * for nobody (the tier is "none", unset, unrecognised, or unreadable).
 *
 * Reads the project's `cell_editing_floor` generated column (migration 0176)
 * rather than the multi-MB settings blob, falling back to the blob on a
 * database that has not had 0176 applied. The org's default fills a project
 * that sets none, exactly as the editor does.
 */
export async function effectiveCellEditingFloorLevel(
  db: AquillaDb,
  projectId: string,
  cache: RequestCache = makeRequestCache(db),
): Promise<number | null> {
  try {
    const projectTier = await readProjectTier(db, projectId)
    const orgId = await cache.projectOrgId(projectId)
    const org = orgId == null ? null : await cache.orgSettings(orgId)
    const effective = withOrgMediaDefaults(
      projectTier == null ? null : { cellEditingFloor: projectTier },
      org,
    )
    return cellEditingFloorFromSettings(effective)
  } catch {
    return null
  }
}

async function readProjectTier(db: AquillaDb, projectId: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(`SELECT cell_editing_floor FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ cell_editing_floor: string | null }>()
    return row?.cell_editing_floor ?? null
  } catch {
    // Most likely 0176 is not applied, so the column does not exist.
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: unknown }>()
    const raw = row?.settings
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    const tier = (parsed as { cellEditingFloor?: unknown } | null)?.cellEditingFloor
    return typeof tier === 'string' ? tier : null
  }
}
