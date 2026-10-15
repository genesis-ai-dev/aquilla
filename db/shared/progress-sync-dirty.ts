/**
 * AQU-1771: settings that change the numbers Aquilla pushes to a progress-sync
 * integration (a Monday board, an Airtable table — AQU-804).
 *
 * A push used to be triggered only by project activity (an applied event or a
 * progress update), so turning "headings count" off, or asking for a second
 * validator, left every linked board showing the old percentages until the
 * next edit in that project. Changing one of these settings now marks the
 * affected links dirty. The identity worker's settings routes then push them
 * straight after the response (auth-worker lib/integrations/push.ts
 * `pushDirtyLinksAfterResponse`); the cron flush (every 5 minutes, AQU-1828
 * backoff, per-run cap) picks up anything left, including changes made through
 * the agent API. A settings save never waits on the provider.
 *
 * Written once in db/shared because project settings are written from both
 * workers (the settings route and the agent's UpdateProjectSettings command
 * both go through updateProjectSettingsShared).
 */
import type { AquillaDb } from "../shim/postgres"

/**
 * The `integration_links.provider` values that push project progress. Every
 * one of them reads the same metrics (auth-worker lib/monday/metrics.ts), so a
 * change that moves those numbers concerns all of them.
 */
export const PROGRESS_SYNC_PROVIDERS = ["monday"] as const
export type ProgressSyncProvider = (typeof PROGRESS_SYNC_PROVIDERS)[number]

/** `<column> IN (?, ?)` over PROGRESS_SYNC_PROVIDERS; bind `PROGRESS_SYNC_PROVIDERS` after it. */
export function progressSyncProviderSql(column: string): string {
  return `${column} IN (${PROGRESS_SYNC_PROVIDERS.map(() => "?").join(", ")})`
}

/** Project-settings keys that feed `computeProjectMetrics` (auth-worker lib/monday/metrics.ts). */
export const SYNC_METRIC_SETTING_KEYS = [
  "countStructuralCells",
  "validationCount",
  "validationCountAudio",
] as const

export function syncMetricSettingsChanged(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  return SYNC_METRIC_SETTING_KEYS.some(
    (key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null),
  )
}

/** Mark these projects' enabled progress-sync links dirty. Best-effort: never fails the caller. */
export async function markProjectSyncLinksDirty(
  db: AquillaDb,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return
  try {
    await db
      .prepare(
        `UPDATE integration_links SET dirty_at = COALESCE(dirty_at, now())
          WHERE ${progressSyncProviderSql("provider")} AND enabled = TRUE
            AND project_id IN (${projectIds.map(() => "?").join(", ")})`,
      )
      .bind(...PROGRESS_SYNC_PROVIDERS, ...projectIds)
      .run()
  } catch (err) {
    console.error("[integrations] marking links dirty after a settings change failed:", err)
  }
}

/**
 * An org setting that projects inherit changed: mark every enabled
 * progress-sync link of the org's live projects dirty. A project that
 * overrides the setting gets one push it didn't strictly need, which is
 * harmless and keeps this correct for any org default added later.
 */
export async function markOrgSyncLinksDirty(db: AquillaDb, orgId: number): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE integration_links il SET dirty_at = COALESCE(il.dirty_at, now())
           FROM projects p
          WHERE p.id = il.project_id AND p.org_id = ? AND p.archived_at IS NULL
            AND ${progressSyncProviderSql("il.provider")} AND il.enabled = TRUE`,
      )
      .bind(orgId, ...PROGRESS_SYNC_PROVIDERS)
      .run()
  } catch (err) {
    console.error("[integrations] marking org links dirty after a settings change failed:", err)
  }
}
