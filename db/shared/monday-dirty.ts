/**
 * AQU-1771: settings that change the numbers Aquilla pushes to a Monday board.
 *
 * A push used to be triggered only by project activity (an applied event or a
 * progress update), so turning "headings count" off, or asking for a second
 * validator, left every linked board showing the old percentages until the
 * next edit in that project. Changing one of these settings now marks the
 * affected links dirty; the identity worker's cron flush (every 5 minutes,
 * with the AQU-1828 retry backoff and per-run cap) pushes them. Nothing is
 * pushed inline, so a settings save never waits on Monday.
 *
 * Written once in db/shared because project settings are written from both
 * workers (the settings route and the agent's UpdateProjectSettings command
 * both go through updateProjectSettingsShared).
 */
import type { AquillaDb } from "../shim/postgres"

/** Project-settings keys that feed `computeProjectMetrics` (auth-worker lib/monday/metrics.ts). */
export const MONDAY_METRIC_SETTING_KEYS = [
  "countStructuralCells",
  "validationCount",
  "validationCountAudio",
] as const

export function mondayMetricSettingsChanged(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  return MONDAY_METRIC_SETTING_KEYS.some(
    (key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null),
  )
}

/** Mark these projects' enabled Monday links dirty. Best-effort: never fails the caller. */
export async function markProjectMondayLinksDirty(
  db: AquillaDb,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return
  try {
    await db
      .prepare(
        `UPDATE integration_links SET dirty_at = COALESCE(dirty_at, now())
          WHERE provider = 'monday' AND enabled = TRUE
            AND project_id IN (${projectIds.map(() => "?").join(", ")})`,
      )
      .bind(...projectIds)
      .run()
  } catch (err) {
    console.error("[monday] marking links dirty after a settings change failed:", err)
  }
}

/**
 * An org setting that projects inherit changed: mark every enabled Monday link
 * of the org's live projects dirty. A project that overrides the setting gets
 * one push it didn't strictly need, which is harmless and keeps this correct
 * for any org default added later.
 */
export async function markOrgMondayLinksDirty(db: AquillaDb, orgId: number): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE integration_links il SET dirty_at = COALESCE(il.dirty_at, now())
           FROM projects p
          WHERE p.id = il.project_id AND p.org_id = ? AND p.archived_at IS NULL
            AND il.provider = 'monday' AND il.enabled = TRUE`,
      )
      .bind(orgId)
      .run()
  } catch (err) {
    console.error("[monday] marking org links dirty after a settings change failed:", err)
  }
}
