import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SyncStatusIndicator — visible in the workspace status bar when a file is open.
 *
 * ProjectWorkspace.tsx renders <SyncStatusIndicator status={fileSyncStatus} />
 * in the left status bar. The component renders a span with:
 *   - aria-label matching the current status tooltip, e.g.:
 *     "Live — changes are syncing to Cloudflare and across devices"
 *     "Connecting to the sync server…"
 *     "Offline — changes are saved locally and will sync when reconnected"
 *
 * When no file is open, the status is "disabled" → "No file open".
 * When a file is open, the status is at least "connecting" or "live".
 *
 * This spec: open a project file → verify a SyncStatusIndicator span is
 * present with an aria-label that contains one of the known status strings.
 */
test("sync status indicator is visible with a known status when a file is open", async ({
  alice,
}) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `SyncStat ${Date.now()}` })
  await openSeededProject(alice, seeded)

  // The SyncStatusIndicator renders a span with aria-label matching the tooltip.
  // With a file open we expect one of: Live, Connecting, or Offline (not "No file open").
  const indicator = alice.locator('[aria-label*="changes are syncing"]')
    .or(alice.locator('[aria-label*="Connecting to the sync server"]'))
    .or(alice.locator('[aria-label*="changes are saved locally"]'))
    .or(alice.locator('[aria-label*="Sync paused"]'))

  await expect(indicator.first()).toBeVisible({ timeout: 10_000 })
})
