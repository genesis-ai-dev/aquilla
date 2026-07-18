// Shared export-floor resolver for sync-worker routes (AQU-253).
//
// Both export-route.ts (single-file USFM) and export-bundle-route.ts (project
// zip) need the same org-level floor lookup. Extracting it here ensures:
//   1. The default (MAINTAINER=600) can't drift between the two routes.
//   2. The resolver uses ROLE.MAINTAINER (typed constant) rather than a
//      hardcoded literal — see export-bundle-route.ts which previously
//      used `const MAINTAINER = 600` inline.
//
// NOTE: this floor gates DELIVERABLE / server-rendered formats (USFM, zip).
// Client-side formats (txt/md/tsv/csv/xlf/tmx/vtt) run over already-fetched
// cells and cannot be enforced server-side here. True per-cell read-API gating
// is explicitly out of scope for AQU-253; the floor is an affordance gate only.
// Document this wherever callers enforce it.

import { ROLE } from "./role-policy"

/**
 * Look up the org's exportMinRole setting for the project's org.
 *
 * Returns ROLE.MAINTAINER (600) as the safe default when:
 *   - the project has no org, OR
 *   - the org has no settings row, OR
 *   - exportMinRole is missing, non-numeric, or outside the valid ladder (100–700).
 *
 * Valid range mirrors the role ladder: VIEWER(100)…OWNER(700).
 * Values outside the range are rejected and fall back to the default — this
 * prevents a mis-configured floor (e.g. 9999) from silently blocking everyone
 * or silently opening to everyone.
 *
 * The lookup costs one JOIN-equivalent (two serial DB reads) which is negligible
 * compared to the file + cells queries that follow it.
 */
export async function resolveExportFloor(db: AquillaDb, projectId: string): Promise<number> {
  // Find the project's org.
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | null }>()

  if (!project?.org_id) return ROLE.MAINTAINER

  const settings = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string }>()

  if (!settings) return ROLE.MAINTAINER

  try {
    const parsed = JSON.parse(settings.settings)
    const raw = parsed?.exportMinRole
    if (typeof raw !== "number" || !Number.isFinite(raw)) return ROLE.MAINTAINER
    // Reject values outside the valid role ladder. Org owners can raise the
    // floor (up to OWNER=700) or lower it (down to VIEWER=100). Garbage values
    // (e.g. -1, 9999) fall back to the default so misconfiguration is visible
    // as a no-op rather than silently blocking or opening export.
    if (raw < ROLE.VIEWER || raw > ROLE.OWNER) return ROLE.MAINTAINER
    return raw
  } catch {
    return ROLE.MAINTAINER
  }
}
