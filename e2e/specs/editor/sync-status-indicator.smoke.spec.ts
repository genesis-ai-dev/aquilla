import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `SyncStat ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // The SyncStatusIndicator renders a span with aria-label matching the tooltip.
  // With a file open we expect one of: Live, Connecting, or Offline (not "No file open").
  const indicator = alice.locator('[aria-label*="changes are syncing"]')
    .or(alice.locator('[aria-label*="Connecting to the sync server"]'))
    .or(alice.locator('[aria-label*="changes are saved locally"]'))
    .or(alice.locator('[aria-label*="Sync paused"]'))

  await expect(indicator.first()).toBeVisible({ timeout: 10_000 })
})
